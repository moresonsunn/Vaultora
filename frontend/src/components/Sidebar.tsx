import { Icon, type IconName } from '../icons';
import { useSession } from '../store/session';
import { useFiles } from '../store/files';
import { useUi } from '../store/ui';
import { fmtBytes } from '../lib/format';
import type { ViewKind } from '../lib/types';

const NAV: { view: ViewKind; label: string; icon: IconName; admin?: boolean }[] = [
  { view: 'home', label: 'Home', icon: 'home' },
  { view: 'files', label: 'My Files', icon: 'folder' },
  { view: 'shared', label: 'Shared', icon: 'shared' },
  { view: 'recent', label: 'Recent', icon: 'clock' },
  { view: 'starred', label: 'Starred', icon: 'star' },
  { view: 'trash', label: 'Trash', icon: 'trash' },
  { view: 'admin', label: 'Admin', icon: 'shield', admin: true },
];

export function Sidebar() {
  const user = useSession((s) => s.user);
  const version = useSession((s) => s.version);
  const commit = useSession((s) => s.commit);
  const logout = useSession((s) => s.logout);
  const view = useFiles((s) => s.view);
  const go = useFiles((s) => s.go);
  const usage = useFiles((s) => s.usage);
  const breakdown = useFiles((s) => s.breakdown);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const theme = useUi((s) => s.theme);

  if (!user) return null;
  const pct =
    usage && !usage.unlimited && usage.quota_bytes
      ? Math.min(100, (usage.used_bytes / usage.quota_bytes) * 100)
      : 4;
  const usageLabel = !usage
    ? '…'
    : usage.unlimited
      ? `${fmtBytes(usage.used_bytes)} used (unlimited)`
      : `${fmtBytes(usage.used_bytes)} / ${fmtBytes(usage.quota_bytes ?? 0)}`;

  return (
    <aside className="sidebar" id="sidebar">
      <div className="brand">
        <span className="logo">V</span> Vaultora
      </div>
      <nav className="nav" id="nav">
        {NAV.filter((n) => !n.admin || user.role === 'admin').map((n) => (
          <button
            key={n.view}
            data-view={n.view}
            className={view === n.view ? 'active' : ''}
            onClick={() => {
              document.body.classList.remove('nav-open');
              go(n.view);
            }}
          >
            <span className="ico">
              <Icon name={n.icon} size={18} />
            </span>
            <span>{n.label}</span>
          </button>
        ))}
      </nav>
      <div className="storage-card" id="storageCard">
        <div className="small muted">Storage used</div>
        <div style={{ fontWeight: 700 }} id="storageText">
          {usageLabel}
        </div>
        <div className="bar">
          <i id="storageBar" style={{ width: `${pct}%` }} />
        </div>
        <div className="small muted" id="storageBreak">
          {breakdown
            ? `${fmtBytes(breakdown.videos)} video · ${fmtBytes(breakdown.documents)} docs · ${fmtBytes(
                breakdown.images
              )} images · ${fmtBytes(breakdown.other)} other`
            : ''}
        </div>
        <div className="small muted" id="appVer" title="Build version — check here after pressing Update">
          v{version}
          {commit ? ` · ${commit}` : ''}
        </div>
      </div>
      <div className="userbox">
        <div className="avatar" id="avatar">
          {user.username.slice(0, 1).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div id="uname" style={{ fontWeight: 700 }}>
            {user.username}
          </div>
          <div className="small muted" id="urole">
            {user.role}
          </div>
        </div>
        <button
          className="iconbtn"
          id="themeBtn"
          title="Toggle theme"
          onClick={toggleTheme}
          aria-label="Toggle theme"
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>
        <button
          className="iconbtn"
          id="logoutBtn"
          title="Sign out"
          onClick={() => void logout()}
          aria-label="Sign out"
        >
          <Icon name="logout" size={16} />
        </button>
      </div>
    </aside>
  );
}
