import { useEffect, useRef, useState } from 'react';
import { fmtBytes } from '../lib/format';
import { initTheme } from '../store/ui';

interface ShareMeta {
  name: string;
  is_dir: boolean;
  size: number;
  mtime: string;
  kind: string;
  mime: string | null;
  children: { name: string; is_dir: boolean; size: number; mtime: string }[];
  has_password: boolean;
  allow_upload: boolean;
}

export function SharePage({ token }: { token: string }) {  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [error, setError] = useState('');
  const [needPw, setNeedPw] = useState(false);
  const [pw, setPw] = useState('');

  useEffect(() => {
    initTheme();
  }, []);

  async function load(password: string): Promise<void> {
    setError('');
    const q = password ? `?password=${encodeURIComponent(password)}` : '';
    try {
      const r = await fetch(`/api/public/${encodeURIComponent(token)}${q}`, {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'fetch' },
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; need_password?: boolean } & ShareMeta;
      if (r.status === 401 && d.need_password) {
        setNeedPw(true);
        return;
      }
      if (!r.ok) {
        setError(d.error || 'Link unavailable');
        return;
      }
      setNeedPw(false);
      setMeta(d as ShareMeta);
    } catch {
      setError('Link unavailable');
    }
  }

  useEffect(() => {
    void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const dl = (f?: string) => {
    const base = `/api/public/${encodeURIComponent(token)}/download`;
    const params = new URLSearchParams();
    if (f) params.set('file', f);
    if (pw) params.set('password', pw);
    const s = params.toString();
    return s ? `${base}?${s}` : base;
  };
  const previewUrl = () => {
    const base = `/api/public/${encodeURIComponent(token)}/preview`;
    return pw ? `${base}?password=${encodeURIComponent(pw)}` : base;
  };

  return (
    <div className="login-wrap">
      <div className="login-card" style={{ width: 'min(640px,100%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <div className="logo">V</div>
          <h1 style={{ fontSize: 20 }}>Shared file</h1>
        </div>
        <div id="box">
          {!meta && !error && !needPw && <p className="muted">Loading…</p>}
          {error && <p>Link unavailable: {error}</p>}
          {needPw && !meta && (
            <>
              <p>This link is password-protected.</p>
              <input
                id="pw"
                type="password"
                className="field"
                placeholder="Password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void load(pw);
                }}
              />
              <div style={{ marginTop: 10 }}>
                <button className="btn primary" id="go" onClick={() => void load(pw)}>
                  Unlock
                </button>
              </div>
            </>
          )}
          {meta && !meta.is_dir && (
            <>
              <h3 style={{ margin: '0 0 6px' }}>{meta.name}</h3>
              <p className="muted small">
                {fmtBytes(meta.size)} · {meta.mime || ''}
              </p>
              <div id="pv">
                {(meta.mime || '').startsWith('image/') && (
                  <img src={previewUrl()} style={{ maxWidth: '100%', borderRadius: 10 }} alt={meta.name} />
                )}
                {(meta.mime || '').startsWith('video/') && <video src={previewUrl()} controls style={{ width: '100%' }} />}
                {(meta.mime || '').startsWith('audio/') && <audio src={previewUrl()} controls style={{ width: '100%' }} />}
                {meta.mime === 'application/pdf' && (
                  <iframe src={previewUrl()} style={{ width: '100%', height: '60vh', border: 0 }} title={meta.name} />
                )}
              </div>
              <p>
                <a className="btn primary" href={dl()}>
                  Download
                </a>
              </p>
            </>
          )}
          {meta && meta.is_dir && (
            <>
              <h3 style={{ margin: '0 0 6px' }}>{meta.name}</h3>              <table className="admin-table">
                <tbody>
                  {meta.children.map((c) => (
                    <tr key={c.name}>
                      <td>{c.name}</td>
                      <td className="muted">{c.is_dir ? 'folder' : fmtBytes(c.size)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {!c.is_dir && (
                          <a className="btn sm" href={dl(c.name)}>
                            Download
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {meta.children.length === 0 && <p className="muted">Empty folder.</p>}
              {meta.allow_upload && <DropZone token={token} pw={pw} onDone={() => void load(pw)} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Anonymous file drop into an upload-enabled folder share. */
function DropZone({ token, pw, onDone }: { token: string; pw: string; onDone: () => void }) {
  const pick = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [msg, setMsg] = useState('');

  function send(files: FileList | null): void {
    if (!files || !files.length || busy) return;
    setBusy(true);
    setPct(0);
    setMsg('');
    const fd = new FormData();
    Array.from(files)
      .slice(0, 5)
      .forEach((f) => fd.append('file', f, f.name));
    const x = new XMLHttpRequest();
    const params = pw ? `?password=${encodeURIComponent(pw)}` : '';
    x.open('POST', `/api/public/${encodeURIComponent(token)}/upload${params}`);
    x.upload.onprogress = (e) => {
      if (e.lengthComputable) setPct(Math.round((e.loaded / e.total) * 100));
    };
    x.onload = () => {
      setBusy(false);
      if (x.status >= 200 && x.status < 300) {
        try {
          const d = JSON.parse(x.responseText) as { results: { ok: boolean; error?: string }[] };
          const ok = d.results.filter((r) => r.ok).length;
          const bad = d.results.filter((r) => !r.ok);
          setMsg(bad.length ? `Uploaded ${ok}, failed: ${bad[0].error}` : `Uploaded ${ok} file(s). Thank you!`);
          onDone();
        } catch {
          setMsg('Upload finished.');
          onDone();
        }
      } else {
        try {
          setMsg((JSON.parse(x.responseText) as { error: string }).error || 'Upload failed');
        } catch {
          setMsg(`Upload failed (${x.status})`);
        }
      }
    };
    x.onerror = () => {
      setBusy(false);
      setMsg('Network error');
    };
    x.send(fd);
    if (pick.current) pick.current.value = '';
  }

  return (
    <div style={{ marginTop: 14, border: '2px dashed var(--line)', borderRadius: 12, padding: 16, textAlign: 'center' }}>
      <p style={{ margin: '0 0 8px' }}>
        <strong>File drop</strong> — send files to the owner here.
      </p>
      <button className="btn primary sm" disabled={busy} onClick={() => pick.current?.click()}>
        {busy ? `Uploading… ${pct}%` : 'Choose files'}
      </button>
      {busy && (
        <div className="bar" style={{ height: 6, background: 'var(--bg3)', borderRadius: 99, overflow: 'hidden', marginTop: 8 }}>
          <i style={{ display: 'block', height: '100%', width: `${pct}%`, background: 'var(--acc)' }} />
        </div>
      )}
      {msg && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          {msg}
        </p>
      )}
      <input ref={pick} type="file" multiple hidden onChange={(e) => send(e.target.files)} />
    </div>
  );
}
