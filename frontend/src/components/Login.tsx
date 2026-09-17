import { useEffect, useRef, useState } from 'react';
import { useSession } from '../store/session';
import { ApiError } from '../lib/types';

export function Login() {
  const login = useSession((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const submitLogin = async () => {
    setError('');
    setBusy(true);
    try {
      const form = formRef.current;
      const uInput = form?.querySelector<HTMLInputElement>('#liUser');
      const pInput = form?.querySelector<HTMLInputElement>('#liPass');
      const tInput = form?.querySelector<HTMLInputElement>('#liTotp');
      const u = (uInput ? uInput.value : username).trim();
      const p = pInput ? pInput.value : password;
      const t = (tInput ? tInput.value : totp).trim();
      const r = await login(u, p, t || undefined);
      if (r.needTotp) {
        setNeedTotp(true);
        setError('Enter your 2FA code and sign in again.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error)?.message || 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const handler = (e: Event) => {
      e.preventDefault();
      void submitLogin();
    };
    form.onsubmit = handler;
    return () => {
      if (form.onsubmit === handler) form.onsubmit = null;
    };
  });

  return (
    <form
      ref={formRef}
      id="loginForm"
      className="login-card"
      onSubmit={(e) => {
        e.preventDefault();
        void submitLogin();
      }}
      autoComplete="on"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div className="logo">V</div>
        <h1>Vaultora</h1>
      </div>
      <p>My server&apos;s storage. Sign in to continue.</p>
      <label className="muted small" htmlFor="liUser">
        Username
      </label>
      <input
        id="liUser"
        className="field"
        name="username"
        autoComplete="username"
        required
        defaultValue={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <label className="muted small" htmlFor="liPass">
        Password
      </label>
      <input
        id="liPass"
        className="field"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        defaultValue={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div id="totpWrap" hidden={!needTotp}>
        <label className="muted small" htmlFor="liTotp">
          Two-factor code
        </label>
        <input
          id="liTotp"
          className="field"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          defaultValue={totp}
          onChange={(e) => setTotp(e.target.value)}
        />
      </div>
      <div id="loginErr" className="login-err">
        {error}
      </div>
      <button id="loginBtn" className="btn primary" style={{ width: '100%' }} type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="small muted" style={{ marginTop: 12 }}>
        Self-hosted · no cloud · files stay on your server.
      </p>
    </form>
  );
}
