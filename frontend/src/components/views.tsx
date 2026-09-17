import { Icon } from '../icons';
import { fmtBytes, fmtDate } from '../lib/format';
import { useFiles } from '../store/files';
import { useUi } from '../store/ui';
import { ConfirmDialog } from './Modal';
import { FileList } from './FileList';
import { FileGrid } from './FileGrid';

export function FilesView() {
  const grid = useFiles((s) => s.grid);
  return grid ? <FileGrid /> : <FileList variant="files" />;
}

export function ResultsView({ emptyText }: { emptyText: string }) {
  const items = useFiles((s) => s.items);
  const grid = useFiles((s) => s.grid);
  if (items.length === 0) return <div className="empty-state">{emptyText}</div>;
  return (
    <>
      <div className="small muted" style={{ margin: '4px 0 8px' }}>
        {items.length} result{items.length === 1 ? '' : 's'}
      </div>
      {grid ? <FileGrid /> : <FileList variant="results" />}
    </>
  );
}

export function SharedView() {
  const roots = useFiles((s) => s.sharedRoots);
  const loading = useFiles((s) => s.loading);
  const go = useFiles((s) => s.go);
  if (loading) return <div className="muted small">Loading…</div>;
  if (roots.length === 0) {
    return (
      <div className="empty-state">
        No shared folders. Your admin can share storage roots with you.
      </div>
    );
  }
  return (
    <>
      <div className="small muted" style={{ margin: '4px 0 8px' }}>
        {roots.length} shared folder{roots.length === 1 ? '' : 's'}
      </div>
      <div className="grid">
        {roots.map((rp) => (
          <div key={rp} className="card" onClick={() => go('files', rp)}>
            <div className="th">
              <Icon name="shared" size={34} />
            </div>
            <div className="nm">{rp.slice(1)}</div>
            <div className="mt">Shared folder</div>
          </div>
        ))}
      </div>
    </>
  );
}

export function TrashView() {
  const trash = useFiles((s) => s.trash);
  const trashRestore = useFiles((s) => s.trashRestore);
  const trashDelete = useFiles((s) => s.trashDelete);
  const trashEmpty = useFiles((s) => s.trashEmpty);
  const openModal = useUi((s) => s.openModal);
  const toast = useUi((s) => s.toast);
  return (
    <>
      <div style={{ margin: '8px 0' }}>
        <button
          className="btn sm danger"
          id="emptyTrash"
          onClick={() =>
            openModal(
              <ConfirmDialog
                title="Empty trash"
                message="Permanently delete everything in Trash?"
                onOk={() => trashEmpty().catch((e: Error) => toast(e.message))}
              />
            )
          }
        >
          <Icon name="trash" size={14} /> Empty trash
        </button>{' '}
        <span className="small muted">
          {trash.length} item{trash.length === 1 ? '' : 's'}
        </span>
      </div>
      {trash.length === 0 ? (
        <div className="empty-state">Trash is empty.</div>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Origin</th>
              <th>Deleted</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {trash.map((it) => (
              <tr key={it.trash_id}>
                <td>{it.name}</td>
                <td className="muted small mono">{it.origin || ''}</td>
                <td className="muted small">{fmtDate(it.deleted_at)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button
                    className="btn sm"
                    onClick={() => trashRestore([it.trash_id]).catch((e: Error) => toast(e.message))}
                  >
                    Restore
                  </button>{' '}
                  <button
                    className="btn sm danger"
                    onClick={() => trashDelete([it.trash_id]).catch((e: Error) => toast(e.message))}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {trash.length > 0 && (
        <p className="small muted">
          Total trashed size:{' '}
          {fmtBytes(trash.reduce((a, t) => a + (t.is_dir ? 0 : t.size), 0))}
        </p>
      )}
    </>
  );
}
