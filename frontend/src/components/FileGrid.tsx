import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { fmtBytes } from '../lib/format';
import type { FileItem } from '../lib/types';
import { useFiles } from '../store/files';
import { openItem, downloadItem, askRename, askMove, askCopy, askDelete, askShare, showDetails } from './fileActions';
import { useUi } from '../store/ui';

const PAGE = 120;

function CardMenu({ it, onClose }: { it: FileItem; onClose: () => void }) {
  const toggleStar = useFiles((s) => s.toggleStar);
  const toast = useUi((s) => s.toast);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  const b = (label: string, fn: () => void, danger = false) => (
    <button
      key={label}
      className={danger ? 'danger' : ''}
      onClick={() => {
        onClose();
        fn();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      {b('Open', () => openItem(it))}
      {b('Download', () => downloadItem(it))}
      {b(it.starred ? 'Unstar' : 'Star', () => toggleStar(it.vpath, !it.starred).catch((e: Error) => toast(e.message)))}
      {b('Rename', () => askRename(it))}
      {b('Move', () => askMove([it.vpath]))}
      {b('Copy', () => askCopy([it.vpath]))}
      {b('Share', () => askShare(it.vpath))}
      {b('Details', () => void showDetails(it.vpath))}
      {b('Delete', () => askDelete([it.vpath]), true)}
    </div>
  );
}

/** Grid renders incrementally (120 cards at a time via sentinel) so huge
 *  folders don't mount thousands of nodes at once. */
export function FileGrid() {
  const items = useFiles((s) => s.items);
  const selection = useFiles((s) => s.selection);
  const toggleSelect = useFiles((s) => s.toggleSelect);
  const loading = useFiles((s) => s.loading);
  const [limit, setLimit] = useState(PAGE);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => setLimit(PAGE), [items]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((l) => Math.min(items.length, l + PAGE));
      },
      { rootMargin: '600px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [items.length]);

  if (!loading && items.length === 0) {
    return (
      <div className="empty-state">
        This folder is empty.
        <br />
        Drag files here, or use <b>Upload</b>.
      </div>
    );
  }
  return (
    <>
      <div className="grid">
        {items.slice(0, limit).map((it) => {
          const sel = selection.has(it.vpath);
          return (
            <div
              key={it.vpath}
              className={sel ? 'card sel' : 'card'}
              style={{ position: 'relative' }}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey) toggleSelect(it.vpath);
                else openItem(it);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuFor(it.vpath);
              }}
            >
              <div className="th">
                {it.kind === 'image' ? (
                  <img
                    loading="lazy"
                    alt=""
                    src={`/api/files/preview?path=${encodeURIComponent(it.vpath)}`}
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <Icon name={it.is_dir ? 'folder' : 'file'} size={34} />
                )}
              </div>
              <div className="nm" title={it.name}>
                {it.name}
              </div>
              <div className="mt">{it.is_dir ? 'Folder' : `${fmtBytes(it.size)} · ${it.kind}`}</div>
              <button
                className="iconbtn"
                style={{ position: 'absolute', top: 16, right: 16, padding: '4px 7px' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor(menuFor === it.vpath ? null : it.vpath);
                }}
                aria-label="Actions"
              >
                <Icon name="more" size={14} />
              </button>
              {menuFor === it.vpath && <CardMenu it={it} onClose={() => setMenuFor(null)} />}
            </div>
          );
        })}
      </div>
      <div ref={sentinel} />
      {loading && <div className="muted small" style={{ padding: 8 }}>Loading…</div>}
    </>
  );
}
