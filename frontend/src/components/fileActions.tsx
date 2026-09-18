import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtBytes, fmtDate } from '../lib/format';
import type { FileItem, VersionInfo } from '../lib/types';
import { useFiles } from '../store/files';
import { useUi } from '../store/ui';
import { ConfirmDialog, DialogButtons, PromptDialog } from './Modal';

export function openItem(it: FileItem): void {
  if (it.is_dir) {
    useFiles.getState().go('files', it.vpath);
  } else {
    useUi.getState().openPreview({ vpath: it.vpath, name: it.name });
  }
}

export function downloadItem(it: FileItem): void {
  useFiles.getState().download(it.vpath);
}

export function askRename(it: FileItem): void {
  const { openModal } = useUi.getState();
  openModal(
    <PromptDialog
      title="Rename"
      label="New name"
      initial={it.name}
      onOk={(name) => {
        if (name === it.name) return;
        useFiles
          .getState()
          .rename(it.vpath, name)
          .catch((e: Error) => useUi.getState().toast(e.message));
      }}
    />
  );
}

export function MoveCopyDialog({ paths, mode }: { paths: string[]; mode: 'move' | 'copy' }) {
  const closeModal = useUi((s) => s.closeModal);
  const toast = useUi((s) => s.toast);
  const path = useFiles((s) => s.path);
  const move = useFiles((s) => s.move);
  const copy = useFiles((s) => s.copy);
  const [dest, setDest] = useState(path);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!dest.trim() || busy) return;
        setBusy(true);
        const op = mode === 'move' ? move : copy;
        op(paths, dest.trim())
          .then((results) => {
            const bad = results.filter((r) => !r.ok);
            toast(bad.length ? `${mode === 'move' ? 'Moved' : 'Copied'} with ${bad.length} error(s): ${bad[0].error}` : mode === 'move' ? 'Moved' : 'Copied');
            closeModal();
          })
          .catch((err: Error) => toast(err.message))
          .finally(() => setBusy(false));
      }}
    >
      <h3>{mode === 'move' ? 'Move to' : 'Copy to'}</h3>
      <label>Destination folder (e.g. /My Files/Docs)</label>
      <input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="/My Files" />
      <DialogButtons>
        <button type="button" className="btn ghost" onClick={closeModal}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {mode === 'move' ? 'Move' : 'Copy'}
        </button>
      </DialogButtons>
    </form>
  );
}

export function askMove(paths: string[]): void {
  useUi.getState().openModal(<MoveCopyDialog paths={paths} mode="move" />);
}
export function askCopy(paths: string[]): void {
  useUi.getState().openModal(<MoveCopyDialog paths={paths} mode="copy" />);
}

export function askDelete(paths: string[]): void {
  const { openModal, toast } = useUi.getState();
  openModal(
    <ConfirmDialog
      title="Delete"
      message={`Delete ${paths.length} item(s)? They move to Trash (if enabled).`}
      onOk={() => {
        useFiles
          .getState()
          .remove(paths)
          .then((results) => {
            const bad = results.filter((r) => !r.ok);
            if (bad.length) toast(`Failed: ${bad[0].error}`);
          })
          .catch((e: Error) => toast(e.message));
      }}
    />
  );
}

export function ShareDialog({ vpath, isDir }: { vpath: string; isDir: boolean }) {
  const closeModal = useUi((s) => s.closeModal);
  const toast = useUi((s) => s.toast);
  const [pw, setPw] = useState('');
  const [exp, setExp] = useState('');
  const [max, setMax] = useState('');
  const [drop, setDrop] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(): Promise<void> {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { path: vpath };
      if (pw) body.password = pw;
      if (exp) body.expires_at = new Date(`${exp}T23:59:59`).toISOString();
      if (max) body.max_downloads = Number(max);
      if (isDir && drop) body.allow_upload = true;
      const r = await api<{ share: { url: string } }>('/api/shares', { method: 'POST', body });
      setUrl(r.share.url);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (url) {
    return (
      <>
        <h3>Share link ready</h3>
        <input readOnly value={url} onFocus={(e) => e.target.select()} />
        <DialogButtons>
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(
                () => toast('Copied'),
                () => toast('Copy manually')
              );
            }}
          >
            Copy
          </button>
          <button className="btn primary" onClick={closeModal}>
            Done
          </button>
        </DialogButtons>
      </>
    );
  }
  return (
    <>
      <h3>Share</h3>
      <div className="small muted mono">{vpath}</div>
      <label>Password (optional)</label>
      <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="leave empty for open link" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div>
          <label>Expires</label>
          <input type="date" value={exp} onChange={(e) => setExp(e.target.value)} />
        </div>
        <div>
          <label>Max downloads</label>
          <input type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} placeholder="unlimited" />
        </div>
      </div>
      {isDir && (
        <label style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={drop}
            onChange={(e) => setDrop(e.target.checked)}
            style={{ width: 'auto' }}
          />
          <span>
            Allow upload <span className="muted small">(file drop — anyone with the link can add files here)</span>
          </span>
        </label>
      )}
      <DialogButtons>
        <button className="btn ghost" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void create()} disabled={busy}>
          Create link
        </button>
      </DialogButtons>
    </>
  );
}

export function askShare(vpath: string, isDir = false): void {
  useUi.getState().openModal(<ShareDialog vpath={vpath} isDir={isDir} />);
}

export function DetailsDialog({ vpath }: { vpath: string }) {
  const closeModal = useUi((s) => s.closeModal);
  const [stat, setStat] = useState<{
    name: string;
    kind: string;
    mime: string | null;
    size: number;
    mtime: string;
    vpath: string;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<typeof stat>('/api/files/stat', { query: { path: vpath } }).then(setStat, (e: Error) =>
      setError(e.message)
    );
  }, [vpath]);
  return (
    <>
      <h3>Details</h3>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {!stat && !error && <p className="muted">Loading…</p>}
      {stat && (
        <dl className="kv">
          <dt>Name</dt>
          <dd>{stat.name}</dd>
          <dt>Type</dt>
          <dd>
            {stat.kind} · {stat.mime || ''}
          </dd>
          <dt>Size</dt>
          <dd>{fmtBytes(stat.size)}</dd>
          <dt>Modified</dt>
          <dd>{fmtDate(stat.mtime)}</dd>
          <dt>Path</dt>
          <dd className="mono">{stat.vpath}</dd>
        </dl>
      )}
      <DialogButtons>
        <button className="btn" onClick={closeModal}>
          Close
        </button>
      </DialogButtons>
    </>
  );
}

export function showDetails(vpath: string): Promise<void> {
  useUi.getState().openModal(<DetailsDialog vpath={vpath} />);
  return Promise.resolve();
}

export function VersionsDialog({ vpath }: { vpath: string }) {
  const closeModal = useUi((s) => s.closeModal);
  const toast = useUi((s) => s.toast);
  const reload = useFiles((s) => s.reload);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [error, setError] = useState('');
  const load = () => {
    api<{ versions: VersionInfo[] }>('/api/files/versions', { query: { path: vpath } }).then(
      (d) => {
        setVersions(d.versions);
        setError('');
      },
      (e: Error) => setError(e.message)
    );
  };
  useEffect(load, [vpath]);
  return (
    <>
      <h3>Versions</h3>
      <div className="small muted mono">{vpath}</div>
      <p className="small muted">Older copies are kept automatically when a file is replaced (max 10).</p>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {versions === null && !error && <p className="muted">Loading…</p>}
      {versions !== null && versions.length === 0 && <p className="muted">No older versions.</p>}
      {versions !== null && versions.length > 0 && (
        <table className="admin-table">
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td className="muted">{fmtDate(v.mtime)}</td>
                <td className="muted">{fmtBytes(v.size)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button
                    className="btn sm"
                    onClick={() =>
                      api('/api/files/versions/restore', { method: 'POST', body: { path: vpath, version: v.id } }).then(
                        () => {
                          toast('Version restored');
                          load();
                          reload();
                        },
                        (e: Error) => toast(e.message)
                      )
                    }
                  >
                    Restore
                  </button>{' '}
                  <button
                    className="btn sm danger"
                    onClick={() =>
                      api('/api/files/versions/delete', { method: 'POST', body: { path: vpath, version: v.id } }).then(
                        () => load(),
                        (e: Error) => toast(e.message)
                      )
                    }
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <DialogButtons>
        <button className="btn" onClick={closeModal}>
          Close
        </button>
      </DialogButtons>
    </>
  );
}

export function askVersions(vpath: string): void {
  useUi.getState().openModal(<VersionsDialog vpath={vpath} />);
}
