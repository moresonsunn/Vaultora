import { useRef } from 'react';
import { Icon } from '../icons';
import { useFiles } from '../store/files';
import { useUi } from '../store/ui';
import { useUploads } from '../store/uploads';
import { ConfirmDialog, PromptDialog } from './Modal';
import { askMove } from './fileActions';

export function Toolbar() {
  const path = useFiles((s) => s.path);
  const view = useFiles((s) => s.view);
  const items = useFiles((s) => s.items);
  const mkdir = useFiles((s) => s.mkdir);
  const writable = useFiles((s) => s.writable);
  const openModal = useUi((s) => s.openModal);
  const toast = useUi((s) => s.toast);
  const queue = useUploads((s) => s.queue);
  const filePick = useRef<HTMLInputElement>(null);
  const folderPick = useRef<HTMLInputElement>(null);

  if (view === 'admin' || view === 'trash') return null;
  const canWrite = view === 'files' || view === 'home' ? writable : false;

  return (
    <div className="toolbar" id="toolbar">
      <button className="btn primary" id="uploadBtn" disabled={!canWrite} onClick={() => filePick.current?.click()}>
        <Icon name="upload" size={15} /> Upload
      </button>
      <button
        className="btn"
        id="folderUpBtn"
        title="Upload a whole folder"
        disabled={!canWrite}
        onClick={() => folderPick.current?.click()}
      >
        <Icon name="folderPlus" size={15} /> Folder
      </button>
      <button
        className="btn"
        id="mkdirBtn"
        disabled={!canWrite}
        onClick={() =>
          openModal(
            <PromptDialog
              title="New folder"
              label="Folder name"
              initial=""
              okLabel="Create"
              onOk={(name) => mkdir(name).catch((e: Error) => toast(e.message))}
            />
          )
        }
      >
        <Icon name="plus" size={15} /> New folder
      </button>
      <span className="sp" />
      <span className="small muted" id="countLabel">
        {view === 'files' || view === 'home' ? `${items.length} item${items.length === 1 ? '' : 's'}` : ''}
      </span>
      <input
        ref={filePick}
        type="file"
        id="filePick"
        multiple
        hidden
        onChange={(e) => {
          queue(Array.from(e.target.files || []), path);
          e.target.value = '';
        }}
      />
      <input
        ref={folderPick}
        type="file"
        id="folderPick"
        hidden
        // @ts-expect-error webkitdirectory is non-standard but universal for folder upload
        webkitdirectory=""
        onChange={(e) => {
          queue(Array.from(e.target.files || []), path);
          e.target.value = '';
        }}
      />
    </div>
  );
}

export function BulkBar() {
  const selection = useFiles((s) => s.selection);
  const clearSelection = useFiles((s) => s.clearSelection);
  const bulkDownload = useFiles((s) => s.bulkDownload);
  const openModal = useUi((s) => s.openModal);
  const toast = useUi((s) => s.toast);
  const remove = useFiles((s) => s.remove);

  if (selection.size === 0) return null;
  const paths = [...selection];
  return (
    <div className="bulkbar open" id="bulkbar">
      <span id="selCount" style={{ fontWeight: 700 }}>
        {selection.size} selected
      </span>
      <button
        className="btn sm"
        id="bulkDl"
        onClick={() => bulkDownload(paths).catch((e: Error) => toast(e.message))}
      >
        <Icon name="download" size={14} /> Download
      </button>
      <button className="btn sm" id="bulkMove" onClick={() => askMove(paths)}>
        Move
      </button>
      <button
        className="btn sm"
        id="bulkDel"
        onClick={() =>
          openModal(
            <ConfirmDialog
              title="Delete"
              message={`Delete ${paths.length} item(s)? They move to Trash (if enabled).`}
              onOk={() =>
                remove(paths)
                  .then((r) => {
                    const bad = r.filter((x) => !x.ok);
                    if (bad.length) toast(`Failed: ${bad[0].error}`);
                  })
                  .catch((e: Error) => toast(e.message))
              }
            />
          )
        }
      >
        Delete
      </button>
      <button className="btn sm ghost" id="selClear" onClick={clearSelection}>
        Clear
      </button>
    </div>
  );
}
