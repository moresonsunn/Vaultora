import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtBytes, fmtDate } from '../lib/format';
import type { AuditItem, SessionInfo, ShareInfo, StorageRoot, User } from '../lib/types';
import { useUi } from '../store/ui';
import { useSession } from '../store/session';
import { Icon } from '../icons';
import { ConfirmDialog, DialogButtons, PromptDialog } from './Modal';

type Tab = 'users' | 'storage' | 'shares' | 'activity' | 'settings' | 'security';

/* ---------------- users ---------------- */
function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');
  const openModal = useUi((s) => s.openModal);
  const toast = useUi((s) => s.toast);
  const me = useSession((s) => s.user);

  const load = useCallback(() => {
    api<{ users: User[] }>('/api/users')
      .then((d) => setUsers(d.users))
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function act(p: Promise<unknown>, ok?: string): Promise<void> {
    try {
      await p;
      if (ok) toast(ok);
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  if (error) return <p style={{ color: 'var(--danger)' }}>{error}</p>;
  return (
    <>
      <div style={{ margin: '8px 0' }}>
        <button
          className="btn primary sm"
          id="addUser"
          onClick={() =>
            openModal(
              <NewUserDialog
                onDone={() => {
                  load();
                }}
              />
            )
          }
        >
          <Icon name="plus" size={14} /> New user
        </button>
      </div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>Quota</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                <strong>{u.username}</strong>
              </td>
              <td>{u.role}</td>
              <td className="muted">{u.quota_bytes == null ? 'unlimited' : fmtBytes(u.quota_bytes)}</td>
              <td>
                {u.disabled ? 'Disabled' : 'Active'}
                {u.totp_enabled ? ' · 2FA' : ''}
              </td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <button
                  className="btn sm"
                  onClick={() =>
                    openModal(
                      <PromptDialog
                        title="Storage quota"
                        label="Bytes (empty = unlimited)"
                        initial={u.quota_bytes == null ? '' : String(u.quota_bytes)}
                        onOk={(q) =>
                          void act(
                            api(`/api/users/${u.id}`, {
                              method: 'PUT',
                              body: { quota_bytes: q === '' ? null : Number(q) },
                            })
                          )
                        }
                      />
                    )
                  }
                >
                  Quota
                </button>{' '}
                <button
                  className="btn sm"
                  onClick={() =>
                    void act(api(`/api/users/${u.id}`, { method: 'PUT', body: { role: u.role === 'admin' ? 'user' : 'admin' } }))
                  }
                >
                  {u.role === 'admin' ? 'Make user' : 'Make admin'}
                </button>{' '}
                <button
                  className="btn sm"
                  onClick={() =>
                    openModal(
                      <PromptDialog
                        title="Reset password"
                        label={`New password for ${u.username}`}
                        initial=""
                        onOk={(pw) =>
                          void act(
                            api(`/api/users/${u.id}/password`, { method: 'POST', body: { password: pw } }),
                            'Password reset; sessions revoked'
                          )
                        }
                      />
                    )
                  }
                >
                  Reset PW
                </button>{' '}
                <button
                  className="btn sm"
                  disabled={me?.username === u.username}
                  onClick={() => void act(api(`/api/users/${u.id}/${u.disabled ? 'enable' : 'disable'}`, { method: 'POST' }))}
                >
                  {u.disabled ? 'Enable' : 'Disable'}
                </button>{' '}
                <button
                  className="btn sm danger"
                  disabled={me?.username === u.username}
                  onClick={() =>
                    openModal(
                      <ConfirmDialog
                        title="Delete user"
                        message={`Delete user ${u.username}? Files on disk are kept.`}
                        onOk={() => void act(api(`/api/users/${u.id}`, { method: 'DELETE' }))}
                      />
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
    </>
  );
}

function NewUserDialog({ onDone }: { onDone: () => void }) {
  const closeModal = useUi((s) => s.closeModal);
  const toast = useUi((s) => s.toast);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        api('/api/users', { method: 'POST', body: { username: username.trim(), password, role } }).then(
          () => {
            closeModal();
            onDone();
          },
          (err: Error) => toast(err.message)
        );
      }}
    >
      <h3>New user</h3>
      <label>Username</label>
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="jane" required />
      <label>Password</label>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <label>Role</label>
      <select value={role} onChange={(e) => setRole(e.target.value)}>
        <option value="user">user</option>
        <option value="admin">admin</option>
      </select>
      <DialogButtons>
        <button type="button" className="btn ghost" onClick={closeModal}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          Create
        </button>
      </DialogButtons>
    </form>
  );
}

/* ---------------- storage ---------------- */
function StorageTab() {
  const [roots, setRoots] = useState<{ name: string; rel_path: string; bytes: number; files: number }[]>([]);
  const [meta, setMeta] = useState<(StorageRoot & { users: { user_id: string; username: string; permission: string }[] })[]>([]);
  const [storageRoot, setStorageRoot] = useState('');
  const [error, setError] = useState('');
  const openModal = useUi((s) => s.openModal);
  const toast = useUi((s) => s.toast);

  const load = useCallback(() => {
    Promise.all([
      api<{ roots: { name: string; rel_path: string; bytes: number; files: number }[]; storage_root: string }>('/api/admin/storage'),
      api<{ roots: (StorageRoot & { users: { user_id: string; username: string; permission: string }[] })[] }>('/api/admin/roots'),
    ])
      .then(([s, r]) => {
        setRoots(s.roots);
        setMeta(r.roots);
        setStorageRoot(s.storage_root);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  if (error) return <p style={{ color: 'var(--danger)' }}>{error}</p>;
  return (
    <>
      <p className="muted small">
        Storage root (server path): <span className="mono">{storageRoot}</span>
      </p>
      <div style={{ margin: '8px 0' }}>
        <button
          className="btn primary sm"
          id="addRoot"
          onClick={() =>
            openModal(
              <PromptDialog
                title="New shared folder"
                label="Name (becomes a folder under the storage root)"
                initial=""
                okLabel="Create"
                onOk={(name) =>
                  api('/api/admin/roots', { method: 'POST', body: { name } }).then(load, (e: Error) => toast(e.message))
                }
              />
            )
          }
        >
          <Icon name="plus" size={14} /> New shared folder
        </button>
      </div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Server path</th>
            <th>Size</th>
            <th>Access</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {roots.map((r) => {
            const m = meta.find((x) => x.name === r.name);
            return (
              <tr key={r.name}>
                <td>
                  <strong>{r.name}</strong>
                </td>
                <td className="mono small">{r.rel_path}</td>
                <td className="muted">
                  {fmtBytes(r.bytes)} · {r.files} files
                </td>
                <td className="small muted">
                  {m ? m.users.map((u) => `${u.username}(${u.permission})`).join(', ') || '—' : ''}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {m && (
                    <>
                      <button
                        className="btn sm"
                        onClick={() =>
                          openModal(
                            <AccessDialog
                              rootId={m.id}
                              rootName={m.name}
                              current={m.users.map((u) => u.username)}
                              onDone={load}
                            />
                          )
                        }
                      >
                        Access
                      </button>{' '}
                      <button
                        className="btn sm danger"
                        onClick={() =>
                          openModal(
                            <ConfirmDialog
                              title="Remove shared folder"
                              message={`Remove "${r.name}" from Vaultora? Files stay on disk.`}
                              confirmLabel="Remove"
                              onOk={() =>
                                api(`/api/admin/roots/${m.id}`, { method: 'DELETE' }).then(load, (e: Error) =>
                                  toast(e.message)
                                )
                              }
                            />
                          )
                        }
                      >
                        Remove
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function AccessDialog({ rootId, rootName, current, onDone }: { rootId: string; rootName: string; current: string[]; onDone: () => void }) {
  const closeModal = useUi((s) => s.closeModal);
  const toast = useUi((s) => s.toast);
  const [value, setValue] = useState(current.join(', '));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        api<{ users: User[] }>('/api/users').then(
          (d) => {
            const names = value.split(',').map((x) => x.trim()).filter(Boolean);
            const uids = d.users.filter((u) => names.includes(u.username)).map((u) => u.id);
            api(`/api/admin/roots/${rootId}/access`, {
              method: 'PUT',
              body: { user_ids: uids, permission: 'write' },
            }).then(
              () => {
                closeModal();
                onDone();
              },
              (err: Error) => toast(err.message)
            );
          },
          (err: Error) => toast(err.message)
        );
      }}
    >
      <h3>Access — {rootName}</h3>
      <label>Comma-separated usernames (empty = nobody)</label>
      <input value={value} onChange={(e) => setValue(e.target.value)} />
      <DialogButtons>
        <button type="button" className="btn ghost" onClick={closeModal}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          Save
        </button>
      </DialogButtons>
    </form>
  );
}

/* ---------------- shares ---------------- */
function SharesTab() {
  const [shares, setShares] = useState<(ShareInfo & { owner?: string })[]>([]);
  const toast = useUi((s) => s.toast);
  const load = useCallback(() => {
    api<{ shares: (ShareInfo & { owner?: string })[] }>('/api/shares')
      .then((d) => setShares(d.shares))
      .catch((e: Error) => toast(e.message));
  }, [toast]);
  useEffect(load, [load]);
  const act = async (p: Promise<unknown>): Promise<void> => {
    try {
      await p;
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  if (shares.length === 0) return <p className="muted">No share links yet.</p>;
  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th>Link</th>
          <th>Target</th>
          <th>Owner</th>
          <th>Expires</th>
          <th>DL</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {shares.map((sh) => (
          <tr key={sh.id}>
            <td className="mono small">
              <a href={sh.url} target="_blank" rel="noreferrer">
                {sh.token}
              </a>
              {sh.disabled ? ' (disabled)' : ''}
            </td>
            <td className="small mono">{sh.vpath}</td>
            <td>{sh.owner || ''}</td>
            <td className="small muted">{sh.expires_at ? fmtDate(sh.expires_at) : 'never'}</td>
            <td className="small muted">
              {sh.download_count}
              {sh.max_downloads ? `/${sh.max_downloads}` : ''}
            </td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <button className="btn sm" onClick={() => void act(api(`/api/shares/${sh.id}`, { method: 'PATCH', body: { disabled: !sh.disabled } }))}>
                {sh.disabled ? 'Enable' : 'Disable'}
              </button>{' '}
              <button className="btn sm" onClick={() => void act(api(`/api/shares/${sh.id}/regenerate`, { method: 'POST' }))}>
                Regenerate
              </button>{' '}
              <button className="btn sm danger" onClick={() => void act(api(`/api/shares/${sh.id}`, { method: 'DELETE' }))}>
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------------- activity ---------------- */
function ActivityTab() {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    api<{ items: AuditItem[]; total: number }>('/api/admin/activity', { query: { limit: 200 } })
      .then((d) => {
        setItems(d.items);
        setTotal(d.total);
      })
      .catch(() => undefined);
  }, []);
  return (
    <>
      <p className="muted small">Audit log: login, upload, delete, rename, move, share creation… ({total} total)</p>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Action</th>
            <th>Detail</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td className="small muted">{fmtDate(a.at)}</td>
              <td>{a.username || ''}</td>
              <td>
                <strong>{a.action}</strong>
              </td>
              <td className="small mono">{a.detail || ''}</td>
              <td className="small muted">{a.ip || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/* ---------------- settings ---------------- */
function SettingsTab() {
  const toast = useUi((s) => s.toast);
  const [s, setS] = useState<Record<string, string>>({});
  const [info, setInfo] = useState({ storage_root: '', port: '', uid: '', gid: '', tz: '', version: '', commit: null as string | null });
  useEffect(() => {
    api<{ settings: Record<string, string>; storage_root: string; port: string; uid: string; gid: string; tz: string; version: string; commit: string | null }>(
      '/api/admin/settings'
    )
      .then((d) => {
        setS(d.settings);
        setInfo(d);
      })
      .catch((e: Error) => toast(e.message));
  }, [toast]);
  const num = (k: string, label: string, help: string) => (
    <>
      <label>{label}</label>
      <input value={s[k] ?? ''} placeholder={help} onChange={(e) => setS({ ...s, [k]: e.target.value })} />
    </>
  );
  const chk = (k: string, label: string) => (
    <label style={{ marginTop: 8 }}>
      <input
        type="checkbox"
        checked={s[k] === '1'}
        onChange={(e) => setS({ ...s, [k]: e.target.checked ? '1' : '0' })}
        style={{ width: 'auto' }}
      />{' '}
      {label}
    </label>
  );
  return (
    <div className="form-grid">
      {num('app_url', 'Application URL (used in share links)', 'https://files.example.com')}
      {num('max_file_size_bytes', 'Max file size (bytes)', '21474836480')}
      {num('default_quota_bytes', 'Default user quota (bytes, empty = unlimited)', '')}
      {num('session_ttl_hours', 'Session expiration (hours)', '72')}
      {num('trash_retention_days', 'Trash auto-cleanup (days)', '30')}
      {chk('trash_enabled', 'Trash enabled')}
      {num('share_default_expiry_days', 'Default share expiry (days, empty = never)', '')}
      {chk('share_require_password', 'Require password on shares')}
      {num('password_min_length', 'Minimum password length', '8')}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div>{num('login_max_attempts', 'Login attempts', '10')}</div>
        <div>{num('login_window_minutes', '…per minutes', '15')}</div>
      </div>
      {chk('clamav_enabled', 'ClamAV antivirus scan (optional daemon)')}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div>{num('clamav_host', 'ClamAV host', 'clamav')}</div>
        <div>{num('clamav_port', 'ClamAV port', '3310')}</div>
      </div>
      <p className="muted small">
        Running Vaultora <strong>{info.version || 'dev'}</strong>
        {info.commit ? ` · ${info.commit}` : ''}. Environment-managed: storage root{' '}
        <span className="mono">{info.storage_root}</span> · port {info.port} · PUID {info.uid || '—'} PGID{' '}
        {info.gid || '—'} · TZ {info.tz || '—'}. Change these in CasaOS / docker-compose, not here.
      </p>
      <div>
        <button
          className="btn primary"
          id="saveSet"
          onClick={() =>
            api('/api/admin/settings', { method: 'PUT', body: s }).then(
              () => toast('Settings saved'),
              (e: Error) => toast(e.message)
            )
          }
        >
          Save settings
        </button>{' '}
        <button
          className="btn"
          id="runTrash"
          onClick={() =>
            api<{ cleaned: number }>('/api/admin/maintenance/trash-cleanup', { method: 'POST' }).then(
              (r) => toast(`Trash cleanup: removed ${r.cleaned}`),
              (e: Error) => toast(e.message)
            )
          }
        >
          Run trash cleanup now
        </button>
      </div>
    </div>
  );
}

/* ---------------- security ---------------- */
function SecurityTab() {
  const toast = useUi((s) => s.toast);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauth, setOtpauth] = useState('');
  const [code, setCode] = useState('');
  const load = useCallback(() => {
    api<{ sessions: SessionInfo[] }>('/api/admin/sessions')
      .then((d) => setSessions(d.sessions))
      .catch((e: Error) => toast(e.message));
  }, [toast]);
  useEffect(load, [load]);
  return (
    <>
      <h4>Active sessions (all users)</h4>
      <table className="admin-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Created</th>
            <th>Expires</th>
            <th>IP</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sessions.map((sn) => (
            <tr key={sn.id}>
              <td>{sn.username}</td>
              <td className="small muted">{fmtDate(sn.created_at)}</td>
              <td className="small muted">{fmtDate(sn.expires_at)}</td>
              <td className="small muted">{sn.ip || ''}</td>
              <td style={{ textAlign: 'right' }}>
                <button
                  className="btn sm danger"
                  onClick={() =>
                    api(`/api/admin/sessions/${sn.id}`, { method: 'DELETE' }).then(load, (e: Error) => toast(e.message))
                  }
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4 style={{ marginTop: 16 }}>Two-factor authentication</h4>
      <p className="muted small">TOTP per user. Each user enables it from the account menu.</p>
      <div>
        <button
          className="btn sm"
          id="my2fa"
          onClick={() =>
            api<{ secret: string; otpauth_url: string }>('/api/auth/2fa/setup', { method: 'POST' }).then(
              (r) => {
                setSecret(r.secret);
                setOtpauth(r.otpauth_url);
              },
              (e: Error) => toast(e.message)
            )
          }
        >
          Set up 2FA for my account
        </button>
      </div>
      {secret && (
        <div id="tfaBox">
          <p>Add this secret to your authenticator app, then confirm:</p>
          <p className="mono" style={{ fontSize: 16 }}>
            {secret}
          </p>
          <p className="small muted mono">{otpauth}</p>
          <input id="tfaCode" placeholder="123456" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            <button
              className="btn primary sm"
              id="tfaOk"
              onClick={() =>
                api('/api/auth/2fa/enable', { method: 'POST', body: { code: code.trim() } }).then(
                  () => {
                    toast('2FA enabled');
                    setSecret(null);
                  },
                  (e: Error) => toast(e.message)
                )
              }
            >
              Confirm &amp; enable
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------- shell ---------------- */
const TABS: { id: Tab; label: string }[] = [
  { id: 'users', label: 'Users' },
  { id: 'storage', label: 'Storage' },
  { id: 'shares', label: 'Shares' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
  { id: 'security', label: 'Security' },
];

export function Admin() {
  const [tab, setTab] = useState<Tab>('users');
  return (
    <div id="adminWrap">
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div>
        {tab === 'users' && <UsersTab />}
        {tab === 'storage' && <StorageTab />}
        {tab === 'shares' && <SharesTab />}
        {tab === 'activity' && <ActivityTab />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'security' && <SecurityTab />}
      </div>
    </div>
  );
}
