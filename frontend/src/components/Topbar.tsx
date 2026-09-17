import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { useFiles } from '../store/files';

function crumbs(path: string): { label: string; target: string }[] {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return [{ label: 'My Files', target: '/My Files' }];
  return parts.map((part, i) => ({
    label: part,
    target: `/${parts.slice(0, i + 1).join('/')}`,
  }));
}

export function Topbar() {
  const view = useFiles((s) => s.view);
  const path = useFiles((s) => s.path);
  const go = useFiles((s) => s.go);
  const searchNow = useFiles((s) => s.searchNow);
  const grid = useFiles((s) => s.grid);
  const toggleGrid = useFiles((s) => s.toggleGrid);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (view !== 'search') setQ('');
  }, [view, path]);

  const title =
    view === 'files' || view === 'home'
      ? null
      : view === 'shared'
        ? '/Shared'
        : view === 'recent'
          ? '/Recent'
          : view === 'starred'
            ? '/Starred'
            : view === 'trash'
              ? '/Trash'
              : view === 'admin'
                ? '/Admin'
                : '/Search';

  return (
    <div className="topbar">
      <button className="iconbtn" id="menuBtn" onClick={() => document.body.classList.toggle('nav-open')} aria-label="Menu">
        <Icon name="menu" size={16} />
      </button>
      <div className="crumbs" id="crumbs">
        {title ? (
          <button>
            <strong>{title.slice(1)}</strong>
          </button>
        ) : (
          crumbs(path).map((c, i, arr) => (
            <span key={c.target} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {i > 0 && <span className="muted">›</span>}
              <button onClick={() => go('files', c.target)} aria-current={i === arr.length - 1}>
                <strong>{c.label}</strong>
              </button>
            </span>
          ))
        )}
      </div>
      <div className="search">
        <input
          id="searchInput"
          placeholder="Search files…  ( / )"
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            searchNow(e.target.value);
          }}
        />
      </div>
      <button className="iconbtn" id="viewBtn" title="Toggle grid/list" onClick={toggleGrid}>
        <Icon name={grid ? 'list' : 'grid'} size={16} />
      </button>
    </div>
  );
}
