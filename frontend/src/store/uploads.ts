/* Upload engine: chunked resumable uploads with pause/resume/reload-resume,
 * automatic retry, and name-conflict handling.
 *
 * No-lag rules enforced here:
 * - at most 2 files upload concurrently, 1 chunk in flight per file
 * - progress state commits at most ~7Hz per job (rows subscribe per-id,
 *   so a progress tick re-renders exactly one row)
 * - chunks are sliced 4MB at a time and released after send (no RAM bloat)
 * - unfinished chunked sessions persist to localStorage, so re-dropping the
 *   same file after a page reload resumes from the server offset
 *
 * Reliability rules:
 * - every chunk is retried (1s/2s/4s backoff); a 409 offset reply resyncs
 *   instead of failing (the previous attempt actually landed server-side)
 * - small uploads retry once; pause/cancel never retry
 * - a file that already exists on the server parks in `conflict` state and
 *   waits for an explicit Keep both / Replace decision — never silent loss
 */
import { create } from 'zustand';
import { api, getCsrf } from '../lib/api';
import { useFiles } from './files';

export type UploadState = 'queued' | 'uploading' | 'paused' | 'conflict' | 'error' | 'cancelled' | 'done';
export type ConflictDecision = 'keep' | 'replace';

export interface UploadJob {
  id: string;
  file: File;
  relPath: string;
  vdir: string;
  destDir?: string;
  decision?: ConflictDecision;
  total: number;
  loaded: number;
  status: UploadState;
  error?: string;
  uploadId?: string;
  speed: number;
  t0: number;
  xhr?: XMLHttpRequest | null;
  abort?: AbortController | null;
  lastPush: number;
}

interface PersistedSession {
  uploadId: string;
  filename: string;
  total: number;
  vdir: string;
}

const CHUNK = 4 * 1024 * 1024;
const SIMPLE_LIMIT = 8 * 1024 * 1024;
const MAX_CONCURRENT = 2;
const PUSH_MS = 150;
const CHUNK_TRIES = 4;
const SIMPLE_TRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function loadSessions(): PersistedSession[] {
  try {
    return JSON.parse(localStorage.getItem('v_uploads') || '[]') as PersistedSession[];
  } catch {
    return [];
  }
}
function saveSessions(list: PersistedSession[]): void {
  try {
    localStorage.setItem('v_uploads', JSON.stringify(list.slice(-20)));
  } catch {
    /* ignore */
  }
}
function rememberSession(s: PersistedSession): void {
  const list = loadSessions().filter((x) => x.uploadId !== s.uploadId);
  list.push(s);
  saveSessions(list);
}
function forgetSession(uploadId: string): void {
  saveSessions(loadSessions().filter((x) => x.uploadId !== uploadId));
}

function dirOf(relPath: string): string {
  return relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
}

let seq = 1;

interface UploadStore {
  jobs: Record<string, UploadJob>;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  queue: (files: File[], vdir: string) => void;
  pause: (id: string) => void;
  resume: (id: string) => void;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
  decide: (id: string, decision: ConflictDecision) => void;
}

async function ensureRemoteFolders(base: string, relDir: string): Promise<string> {
  if (!relDir) return base;
  let cur = base;
  for (const seg of relDir.split('/').filter(Boolean)) {
    try {
      await api('/api/files/mkdir', { method: 'POST', body: { path: cur, name: seg } });
    } catch {
      /* exists or forbidden — probe continues */
    }
    cur = `${cur}/${seg}`;
  }
  return cur;
}

async function destExists(destVdir: string, filename: string): Promise<boolean> {
  try {
    await api(`/api/files/stat`, { query: { path: `${destVdir}/${filename}` } });
    return true;
  } catch {
    return false;
  }
}

export const useUploads = create<UploadStore>((set, get) => {
  function patch(id: string, p: Partial<UploadJob>, force = false): void {
    const jobs = get().jobs;
    const cur = jobs[id];
    if (!cur) return;
    const now = Date.now();
    if (!force && now - cur.lastPush < PUSH_MS) return;
    set({ jobs: { ...jobs, [id]: { ...cur, ...p, lastPush: now } } });
  }

  function stopped(id: string): boolean {
    const s = get().jobs[id]?.status;
    return s === 'paused' || s === 'cancelled';
  }

  /** Run fn with backoff retries. Pause/cancel/abort never retry. */
  async function withRetry<T>(id: string, tries: number, fn: () => Promise<T>): Promise<T> {
    let last: unknown = new Error('upload failed');
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (stopped(id)) throw new Error('stopped');
      try {
        return await fn();
      } catch (e) {
        if (stopped(id)) throw e;
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        last = e;
        if (attempt < tries) await sleep(1000 * 2 ** (attempt - 1));
      }
    }
    throw last;
  }

  function activeCount(): number {
    return Object.values(get().jobs).filter((j) => j.status === 'uploading').length;
  }

  function kick(): void {
    if (activeCount() >= MAX_CONCURRENT) return;
    const next = Object.values(get().jobs).find((j) => j.status === 'queued');
    if (next) void pump(next.id);
  }

  async function pump(id: string): Promise<void> {
    const job = get().jobs[id];
    if (!job || job.status !== 'queued') return;
    patch(id, { status: 'uploading', t0: Date.now(), error: undefined }, true);
    try {
      const destDir = await ensureRemoteFolders(job.vdir, dirOf(job.relPath));
      if (stopped(id)) throw new Error('stopped');
      patch(id, { destDir }, true);
      const decision = get().jobs[id]?.decision;
      if (!decision && (await destExists(destDir, job.file.name))) {
        if (stopped(id)) throw new Error('stopped');
        patch(id, { status: 'conflict' }, true);
        kick(); // let other files proceed while the user decides
        return;
      }
      if (job.total > SIMPLE_LIMIT) await chunked(job, destDir);
      else await simple(job, destDir);
      patch(id, { status: 'done', loaded: job.total, speed: 0 }, true);
      forgetIfDone(id);
    } catch (e) {
      const cur = get().jobs[id];
      if (!cur) return;
      if (cur.status === 'paused' || cur.status === 'cancelled' || cur.status === 'conflict') {
        patch(id, {}, true);
      } else {
        patch(id, { status: 'error', error: (e as Error).message }, true);
      }
    }
    set({ jobs: { ...get().jobs } }); // settle identities
    kick();
    const files = useFiles.getState();
    if (files.view === 'files' || files.view === 'home') files.reload();
    void files.refreshStorage();
  }

  function forgetIfDone(id: string): void {
    const j = get().jobs[id];
    if (j?.uploadId) forgetSession(j.uploadId);
  }

  function sendSimple(job: UploadJob, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const decision = get().jobs[job.id]?.decision;
      const fd = new FormData();
      fd.append('path', destDir);
      if (decision === 'replace') fd.append('overwrite', '1');
      fd.append('file', job.file, job.file.name);
      const x = new XMLHttpRequest();
      patch(job.id, { xhr: x }, true);
      const t0 = Date.now();
      x.open('POST', '/api/uploads/simple');
      x.withCredentials = true;
      x.setRequestHeader('X-Requested-With', 'fetch');
      const csrf = getCsrf();
      if (csrf) x.setRequestHeader('X-CSRF-Token', csrf);
      x.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          const el = Math.max(0.5, (Date.now() - t0) / 1000);
          patch(job.id, { loaded: ev.loaded, speed: ev.loaded / el });
        }
      };
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) {
          try {
            const d = JSON.parse(x.responseText) as {
              results: { ok: boolean; error?: string }[];
            };
            const bad = d.results.find((r) => !r.ok);
            if (bad) reject(new Error(bad.error || 'upload failed'));
            else resolve();
          } catch {
            reject(new Error('bad server response'));
          }
        } else {
          try {
            reject(new Error((JSON.parse(x.responseText) as { error: string }).error || 'upload failed'));
          } catch {
            reject(new Error(`upload failed (${x.status})`));
          }
        }
      };
      x.onerror = () => reject(new Error('network error'));
      x.onabort = () => reject(new Error('stopped'));
      x.send(fd);
    });
  }

  async function simple(job: UploadJob, destDir: string): Promise<void> {
    await withRetry(job.id, SIMPLE_TRIES, () => sendSimple(job, destDir));
  }

  async function sendChunk(jobId: string, uploadId: string, offset: number, buf: ArrayBuffer): Promise<number> {
    const csrf = getCsrf();
    const abort = new AbortController();
    patch(jobId, { abort }, true);
    try {
      const res = await fetch(`/api/uploads/${uploadId}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Requested-With': 'fetch',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          'X-Offset': String(offset),
        },
        body: buf,
        signal: abort.signal,
      });
      const d = (await res.json().catch(() => ({}))) as { received?: number; error?: string };
      if (!res.ok) {
        // 409 carries the true offset: the previous attempt landed after all.
        if (res.status === 409 && typeof d.received === 'number') return d.received;
        throw new Error(d.error || 'chunk failed');
      }
      return d.received ?? offset;
    } finally {
      patch(jobId, { abort: null }, true);
    }
  }

  async function chunked(job: UploadJob, destVdir: string): Promise<void> {
    let uploadId = get().jobs[job.id]?.uploadId;
    if (!uploadId) {
      // reload-resume: same name+size as a previous session?
      const match = loadSessions().find((s) => s.filename === job.file.name && s.total === job.total);
      if (match) {
        try {
          const st = await api<{ received: number; status: string }>(`/api/uploads/${match.uploadId}`);
          if (st.status === 'active') {
            uploadId = match.uploadId;
            patch(job.id, { uploadId, loaded: Math.min(st.received, job.total) }, true);
          } else {
            forgetSession(match.uploadId);
          }
        } catch {
          forgetSession(match.uploadId);
        }
      }
    }
    if (!uploadId) {
      const init = await api<{ upload_id: string }>(`/api/uploads/init`, {
        method: 'POST',
        body: { path: destVdir, filename: job.file.name, total_size: job.total },
      });
      uploadId = init.upload_id;
      patch(job.id, { uploadId }, true);
      rememberSession({ uploadId, filename: job.file.name, total: job.total, vdir: destVdir });
    }
    // refresh offset (covers pause/resume + reload-resume)
    try {
      const st = await api<{ received: number }>(`/api/uploads/${uploadId}`);
      if (Number.isFinite(st.received)) patch(job.id, { loaded: Math.min(st.received, job.total) }, true);
    } catch {
      /* start from cached offset */
    }

    const uid = uploadId;
    const decision = get().jobs[job.id]?.decision;
    let offset = get().jobs[job.id]?.loaded || 0;
    const t0 = Date.now();
    while (offset < job.total) {
      const cur = get().jobs[job.id];
      if (!cur) throw new Error('stopped');
      if (cur.status === 'cancelled' || cur.status === 'paused') throw new Error('stopped');
      // Re-sliced per attempt: a retried chunk must never reuse a consumed buffer.
      offset = await withRetry(job.id, CHUNK_TRIES, async () => {
        const b = await job.file.slice(offset, offset + CHUNK).arrayBuffer();
        return sendChunk(job.id, uid, offset, b);
      });
      const el = Math.max(0.5, (Date.now() - t0) / 1000);
      patch(job.id, { loaded: offset, speed: offset / el });
    }
    await api(`/api/uploads/${uid}/complete`, {
      method: 'POST',
      body: { overwrite: decision === 'replace' },
    });
    patch(job.id, { loaded: job.total }, true);
  }

  return {
    jobs: {},
    panelOpen: false,
    setPanelOpen: (open) => set({ panelOpen: open }),

    queue: (files, vdir) => {
      if (!files.length) return;
      const jobs = { ...get().jobs };
      for (const f of files) {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        const id = `u${seq++}_${Date.now().toString(36)}`;
        jobs[id] = {
          id,
          file: f,
          relPath: rel,
          vdir,
          total: f.size,
          loaded: 0,
          status: 'queued',
          speed: 0,
          t0: Date.now(),
          xhr: null,
          abort: null,
          lastPush: 0,
        };
      }
      set({ jobs, panelOpen: true });
      kick();
      kick();
    },

    pause: (id) => {
      const j = get().jobs[id];
      if (!j || j.status !== 'uploading') return;
      patch(id, { status: 'paused' }, true);
      try {
        j.abort?.abort();
      } catch {
        /* ignore */
      }
      try {
        j.xhr?.abort();
      } catch {
        /* ignore */
      }
    },

    resume: (id) => {
      const j = get().jobs[id];
      if (!j || (j.status !== 'paused' && j.status !== 'error')) return;
      patch(id, { status: 'queued', error: undefined }, true);
      kick();
    },

    cancel: (id) => {
      const j = get().jobs[id];
      if (!j) return;
      patch(id, { status: 'cancelled' }, true);
      try {
        j.abort?.abort();
      } catch {
        /* ignore */
      }
      try {
        j.xhr?.abort();
      } catch {
        /* ignore */
      }
      if (j.uploadId) {
        const uid = j.uploadId;
        forgetSession(uid);
        void api(`/api/uploads/${uid}`, { method: 'DELETE' }).catch(() => undefined);
      }
      kick();
    },

    retry: (id) => {
      const j = get().jobs[id];
      if (!j || (j.status !== 'error' && j.status !== 'cancelled')) return;
      const reset: Partial<UploadJob> = { status: 'queued', error: undefined };
      if (j.status === 'cancelled') {
        reset.uploadId = undefined;
        reset.loaded = 0; // server state was deleted on cancel; start over
      }
      patch(id, reset, true);
      kick();
    },

    decide: (id, decision) => {
      const j = get().jobs[id];
      if (!j || j.status !== 'conflict') return;
      patch(id, { decision, status: 'queued', error: undefined }, true);
      kick();
    },

    dismiss: (id) => {
      const jobs = { ...get().jobs };
      delete jobs[id];
      set({ jobs });
    },
  };
});

/** Overall progress across active jobs (for the panel header). */
export function overallProgress(jobs: Record<string, UploadJob>): { pct: number; done: number; total: number } {
  const list = Object.values(jobs);
  const total = list.reduce((a, j) => a + j.total, 0);
  const done = list.filter((j) => j.status === 'done').length;
  if (!total) return { pct: 100, done, total: list.length };
  const loaded = list.reduce((a, j) => a + Math.min(j.loaded, j.total), 0);
  return { pct: Math.round((loaded / total) * 100), done, total: list.length };
}
