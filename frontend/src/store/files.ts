/* File-manager store: navigation, listing, selection, all mutations.
 * One in-flight list request at a time (AbortController) so fast navigation
 * and typing in search can never stack stale responses. */
import { create } from 'zustand';
import { api, apiBlob } from '../lib/api';
import type { FileItem, SearchItem, SortKey, SortOrder, TrashItem, ViewKind } from '../lib/types';
import { useUi } from './ui';

interface Usage {
  used_bytes: number;
  quota_bytes: number | null;
  unlimited: boolean;
}

interface Breakdown {
  videos: number;
  documents: number;
  images: number;
  other: number;
  used_bytes: number;
}

interface OpResult {
  path?: string;
  id?: string;
  ok: boolean;
  error?: string;
}

let listAbort: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

interface FilesState {
  view: ViewKind;
  path: string;
  items: FileItem[];
  trash: TrashItem[];
  sharedRoots: string[];
  writable: boolean;
  loading: boolean;
  sort: SortKey;
  order: SortOrder;
  grid: boolean;
  selection: Set<string>;
  usage: Usage | null;
  breakdown: Breakdown | null;

  go: (view: ViewKind, path?: string) => void;
  reload: () => void;
  setSort: (s: SortKey) => void;
  toggleGrid: () => void;
  toggleSelect: (vpath: string) => void;
  selectAll: (on: boolean) => void;
  clearSelection: () => void;

  mkdir: (name: string) => Promise<void>;
  rename: (vpath: string, name: string) => Promise<void>;
  move: (paths: string[], dest: string) => Promise<OpResult[]>;
  copy: (paths: string[], dest: string) => Promise<OpResult[]>;
  remove: (paths: string[], permanent?: boolean) => Promise<OpResult[]>;
  toggleStar: (vpath: string, starred: boolean) => Promise<void>;
  searchNow: (q: string) => void;
  trashRestore: (ids: string[]) => Promise<void>;
  trashDelete: (ids: string[]) => Promise<void>;
  trashEmpty: () => Promise<void>;
  refreshStorage: () => Promise<void>;
  download: (vpath: string) => void;
  bulkDownload: (paths: string[]) => Promise<void>;
}

function loadPrefs(): { sort: SortKey; order: SortOrder; grid: boolean } {
  try {
    return {
      sort: (localStorage.getItem('v_sort') as SortKey) || 'name',
      order: (localStorage.getItem('v_order') as SortOrder) || 'asc',
      grid: localStorage.getItem('v_grid') === '1',
    };
  } catch {
    return { sort: 'name', order: 'asc', grid: false };
  }
}

export const useFiles = create<FilesState>((set, get) => {
  async function loadPath(path: string): Promise<void> {
    listAbort?.abort();
    const ctrl = new AbortController();
    listAbort = ctrl;
    set({ loading: true });
    const { sort, order } = get();
    try {
      const d = await api<{ path: string; items: FileItem[]; writable: boolean }>('/api/files', {
        signal: ctrl.signal,
        query: { path, sort, order },
      });
      if (listAbort !== ctrl) return; // superseded
      set({ path: d.path, items: d.items, writable: d.writable, loading: false, selection: new Set() });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      set({ loading: false });
      useUi.getState().toast((e as Error).message);
    }
  }

  async function loadShared(): Promise<void> {
    set({ loading: true });
    try {
      const d = await api<{ roots: string[] }>('/api/files/shared-roots');
      set({ sharedRoots: d.roots.map((r) => `/${r}`), loading: false, items: [], selection: new Set() });
    } catch (e) {
      set({ loading: false });
      useUi.getState().toast((e as Error).message);
    }
  }

  async function loadRecent(): Promise<void> {
    set({ loading: true });
    try {
      const d = await api<{ items: SearchItem[] }>('/api/files/recent', { query: { limit: 50 } });
      set({
        loading: false,
        items: d.items.map((i) => ({ ...i, mime: null as string | null, starred: false })),
        selection: new Set(),
      });
    } catch (e) {
      set({ loading: false });
      useUi.getState().toast((e as Error).message);
    }
  }

  async function loadStarred(): Promise<void> {
    set({ loading: true });
    try {
      const d = await api<{ items: { vpath: string; created_at: string }[] }>('/api/files/starred');
      set({
        loading: false,
        items: d.items.map((x) => ({
          vpath: x.vpath,
          name: x.vpath.split('/').pop() || x.vpath,
          is_dir: false,
          kind: 'file',
          size: 0,
          mtime: x.created_at,
          mime: null,
          starred: true,
        })),
        selection: new Set(),
      });
    } catch (e) {
      set({ loading: false });
      useUi.getState().toast((e as Error).message);
    }
  }

  async function loadTrash(): Promise<void> {
    set({ loading: true });
    try {
      const d = await api<{ items: TrashItem[] }>('/api/files/trash');
      set({ trash: d.items, loading: false, items: [], selection: new Set() });
    } catch (e) {
      set({ loading: false });
      useUi.getState().toast((e as Error).message);
    }
  }

  return {
    view: 'files',
    path: '/My Files',
    items: [],
    trash: [],
    sharedRoots: [],
    writable: true,
    loading: false,
    ...loadPrefs(),
    selection: new Set(),
    usage: null,
    breakdown: null,

    go: (view, path) => {
      set({ view, selection: new Set() });
      if (view === 'files' || view === 'home') void loadPath(path || get().path || '/My Files');
      else if (view === 'shared') void loadShared();
      else if (view === 'recent') void loadRecent();
      else if (view === 'starred') void loadStarred();
      else if (view === 'trash') void loadTrash();
    },

    reload: () => {
      const { view, path } = get();
      if (view === 'files' || view === 'home') void loadPath(path);
      else get().go(view);
    },

    setSort: (s) => {
      const { sort, order } = get();
      const nextOrder = sort === s ? (order === 'asc' ? 'desc' : 'asc') : 'asc';
      try {
        localStorage.setItem('v_sort', s);
        localStorage.setItem('v_order', nextOrder);
      } catch {
        /* ignore */
      }
      set({ sort: s, order: nextOrder });
      const { view, path } = get();
      if (view === 'files' || view === 'home') void loadPath(path);
    },

    toggleGrid: () => {
      const grid = !get().grid;
      try {
        localStorage.setItem('v_grid', grid ? '1' : '0');
      } catch {
        /* ignore */
      }
      set({ grid });
    },

    toggleSelect: (vpath) => {
      const s = new Set(get().selection);
      if (s.has(vpath)) s.delete(vpath);
      else s.add(vpath);
      set({ selection: s });
    },
    selectAll: (on) => {
      set({ selection: on ? new Set(get().items.map((i) => i.vpath)) : new Set() });
    },
    clearSelection: () => set({ selection: new Set() }),

    mkdir: async (name) => {
      await api('/api/files/mkdir', { method: 'POST', body: { path: get().path, name } });
      get().reload();
      void get().refreshStorage();
    },

    rename: async (vpath, name) => {
      await api('/api/files/rename', { method: 'POST', body: { path: vpath, name } });
      get().reload();
    },

    move: async (paths, dest) => {
      const r = await api<{ results: OpResult[] }>('/api/files/move', {
        method: 'POST',
        body: { paths, dest },
      });
      get().clearSelection();
      get().reload();
      void get().refreshStorage();
      return r.results;
    },

    copy: async (paths, dest) => {
      const r = await api<{ results: OpResult[] }>('/api/files/copy', {
        method: 'POST',
        body: { paths, dest },
      });
      get().clearSelection();
      get().reload();
      void get().refreshStorage();
      return r.results;
    },

    remove: async (paths, permanent) => {
      const r = await api<{ results: OpResult[] }>('/api/files/delete', {
        method: 'POST',
        body: { paths, permanent: !!permanent },
      });
      get().clearSelection();
      get().reload();
      void get().refreshStorage();
      return r.results;
    },

    toggleStar: async (vpath, starred) => {
      await api('/api/files/star', { method: 'POST', body: { path: vpath, starred } });
      const { view } = get();
      if (view === 'starred') get().reload();
      else {
        set({
          items: get().items.map((i) => (i.vpath === vpath ? { ...i, starred } : i)),
        });
      }
    },

    searchNow: (q) => {
      if (searchTimer) clearTimeout(searchTimer);
      if (!q || q.trim().length < 2) {
        if (get().view === 'search') get().go('files');
        return;
      }
      searchTimer = setTimeout(async () => {
        listAbort?.abort();
        const ctrl = new AbortController();
        listAbort = ctrl;
        set({ loading: true, view: 'search' });
        try {
          const d = await api<{ items: SearchItem[] }>('/api/files/search', {
            signal: ctrl.signal,
            query: { q: q.trim(), limit: 100 },
          });
          if (listAbort !== ctrl) return;
          set({
            loading: false,
            items: d.items.map((i) => ({ ...i, mime: null as string | null, starred: false })),
            selection: new Set(),
          });
        } catch (e) {
          if ((e as Error).name === 'AbortError') return;
          set({ loading: false });
          useUi.getState().toast((e as Error).message);
        }
      }, 250);
    },

    trashRestore: async (ids) => {
      await api('/api/files/trash/restore', { method: 'POST', body: { ids } });
      void loadTrash();
      void get().refreshStorage();
    },
    trashDelete: async (ids) => {
      await api('/api/files/trash/delete', { method: 'POST', body: { ids } });
      void loadTrash();
    },
    trashEmpty: async () => {
      await api('/api/files/trash/empty', { method: 'POST' });
      void loadTrash();
      void get().refreshStorage();
    },

    refreshStorage: async () => {
      try {
        const [u, b] = await Promise.all([
          api<Usage>('/api/files/usage'),
          api<Breakdown>('/api/files/breakdown').catch(() => null),
        ]);
        set({ usage: u, breakdown: b });
      } catch {
        /* non-fatal */
      }
    },

    download: (vpath) => {
      const a = document.createElement('a');
      a.href = `/api/files/download?path=${encodeURIComponent(vpath)}`;
      a.download = vpath.split('/').pop() || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },

    bulkDownload: async (paths) => {
      if (paths.length === 1) {
        get().download(paths[0]);
        return;
      }
      const blob = await apiBlob('/api/files/bulk-download', { method: 'POST', body: { paths } });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'vaultora-download.zip';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 4000);
    },
  };
});
