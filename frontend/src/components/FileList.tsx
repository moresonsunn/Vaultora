import React, { useEffect, useRef, useState } from 'react';
import { Icon, iconForKind } from '../icons';
import { fmtBytes, fmtDate } from '../lib/format';
import type { FileItem } from '../lib/types';
import { useFiles } from '../store/files';
import { useUi } from '../store/ui';
import { VirtualList } from './VirtualList';
import { askCopy, askDelete, askMove, askRename, askShare, showDetails, downloadItem, openItem } from './fileActions';

export function FileThumb({ it, size = 30 }: { it: FileItem; size?: number }) {
  const [imgOk, setImgOk] = useState(true);
  if (it.kind === 'image' && imgOk) {
    return (
      <span className="fi" style={{ width: size, height: size, flexBasis: size }}>
        <img
          loading="lazy"
          alt=""
          src={`/api/files/preview?path=${encodeURIComponent(it.vpath)}`}
          onError={() => setImgOk(false)}
        />
      </span>
    );
  }
  return (
    <span className="fi" style={{ width: size, height: size, flexBasis: size }}>
      <Icon name={iconForKind(it.kind, it.is_dir)} size={17} />
    </span>
  );
}

function RowMenu({ it, onClose }: { it: FileItem; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const toggleStar = useFiles((s) => s.toggleStar);
  const toast = useUi((s) => s.toast);
  const item = (label: string, icon: React.ReactNode, fn: () => void, danger = false) => (
    <button
      key={label}
      className={danger ? 'danger' : ''}
      onClick={() => {
        onClose();
        fn();
      }}
    >
      {icon}
      {label}
    </button>
  );
  const mi = (n: 'eye' | 'download' | 'star' | 'more' | 'link' | 'info' | 'trash' | 'check', s = 15) => (
    <Icon name={n} size={s} />
  );
  return (
    <div className="menu" ref={ref}>
      {item('Open', mi('eye'), () => openItem(it))}
      {item('Download', mi('download'), () => downloadItem(it))}
      {item(it.starred ? 'Unstar' : 'Star', mi('star'), () =>
        toggleStar(it.vpath, !it.starred).catch((e: Error) => toast(e.message))
      )}
      {item('Rename', mi('more'), () => askRename(it))}
      {item('Move', mi('check'), () => askMove([it.vpath]))}
      {item('Copy', mi('check'), () => askCopy([it.vpath]))}
      {item('Share', mi('link'), () => askShare(it.vpath))}
      {item('Details', mi('info'), () => void showDetails(it.vpath))}
      {item('Delete', mi('trash'), () => askDelete([it.vpath]), true)}
    </div>
  );
}

const ROW_H = 52;

export function FileList({ variant = 'files' }: { variant?: 'files' | 'results' }) {
  const items = useFiles((s) => s.items);
  const loading = useFiles((s) => s.loading);
  const selection = useFiles((s) => s.selection);
  const toggleSelect = useFiles((s) => s.toggleSelect);
  const selectAll = useFiles((s) => s.selectAll);
  const setSort = useFiles((s) => s.setSort);
  const sort = useFiles((s) => s.sort);
  const order = useFiles((s) => s.order);
  const path = useFiles((s) => s.path);
  const view = useFiles((s) => s.view);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const allChecked = items.length > 0 && selection.size === items.length;
  const arrow = (s: string) => (sort === s ? (order === 'asc' ? ' ▲' : ' ▼') : '');

  if (!loading && items.length === 0) {
    return (
      <div className="empty-state">
        {variant === 'files' ? (
          <>
            This folder is empty.
            <br />
            Drag files here, or use <b>Upload</b>.
          </>
        ) : (
          'No matches.'
        )}
      </div>
    );
  }

  return (
    <div>
      <table className="files" style={{ marginBottom: 0, borderBottom: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
        <thead>
          <tr>
            <th style={{ width: 34 }}>
              <input
                type="checkbox"
                checked={allChecked}
                onChange={(e) => selectAll(e.target.checked)}
                aria-label="Select all"
              />
            </th>
            <th onClick={() => setSort('name')}>Name{arrow('name')}</th>
            <th style={{ width: 90 }} onClick={() => setSort('size')}>
              Size{arrow('size')}
            </th>
            <th style={{ width: 170 }} onClick={() => setSort('date')}>
              Modified{arrow('date')}
            </th>
            <th style={{ width: 90 }} className="fcol-type" onClick={() => setSort('type')}>
              Type{arrow('type')}
            </th>
            <th style={{ width: 46 }} />
          </tr>
        </thead>
      </table>
      <VirtualList
        items={items}
        rowHeight={ROW_H}
        resetKey={`${view}:${path}`}
        style={{ borderTop: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0, maxHeight: 'calc(100vh - 340px)', minHeight: 200 }}
        keyOf={(it) => it.vpath}
        renderRow={(it) => {
          const sel = selection.has(it.vpath);
          return (
            <>
              <input
                type="checkbox"
                checked={sel}
                onChange={() => toggleSelect(it.vpath)}
                aria-label={`Select ${it.name}`}
              />
              <div className="fname">
                <FileThumb it={it} />
                <span
                  className="nm"
                  title={variant === 'results' ? it.vpath : it.name}
                  onClick={() => openItem(it)}
                  onDoubleClick={() => openItem(it)}
                >
                  {it.name}
                </span>
                {it.starred ? (
                  <span title="Starred" style={{ color: 'var(--warn)', display: 'inline-grid' }}>
                    <Icon name="starFill" size={12} />
                  </span>
                ) : null}
              </div>
              <span className="muted fcol-size">{it.is_dir ? '—' : fmtBytes(it.size)}</span>
              <span className="muted small fcol-date">{fmtDate(it.mtime)}</span>
              <span className="muted small fcol-type">{it.is_dir ? 'Folder' : it.kind}</span>
              <span className="rowactions" style={{ width: 46, textAlign: 'right' }}>
                <button className="iconbtn" onClick={() => setMenuFor(menuFor === it.vpath ? null : it.vpath)} aria-label="Actions">
                  <Icon name="more" size={15} />
                </button>
                {menuFor === it.vpath && <RowMenu it={it} onClose={() => setMenuFor(null)} />}
              </span>
            </>
          );
        }}
      />
      {loading && <div className="muted small" style={{ padding: 8 }}>Loading…</div>}
    </div>
  );
}
