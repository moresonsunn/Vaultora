/* Session store: user, CSRF token, login/logout/boot, version stamp. */
import { create } from 'zustand';
import { api, setCsrf, onUnauthorized } from '../lib/api';
import type { User } from '../lib/types';

interface SessionState {
  user: User | null;
  booted: boolean;
  version: string;
  commit: string | null;
  boot: () => Promise<void>;
  login: (username: string, password: string, totp?: string) => Promise<{ needTotp: boolean }>;
  logout: () => Promise<void>;
  logoutLocal: () => void;
  refreshVersion: () => Promise<void>;
}

onUnauthorized(() => {
  useSession.getState().logoutLocal();
});

export const useSession = create<SessionState>((set) => ({
  user: null,
  booted: false,
  version: 'dev',
  commit: null,

  boot: async () => {
    try {
      const me = await api<{ user: User; csrf: string | null }>('/api/auth/me', { timeoutMs: 4000 });
      setCsrf(me.csrf);
      if (!useSession.getState().user) {
        set({ user: me.user, booted: true });
      }
    } catch {
      if (!useSession.getState().user) {
        set({ user: null, booted: true });
      }
    }
    void useSession.getState().refreshVersion();
  },

  login: async (username, password, totp) => {
    try {
      const r = await api<{ user: User; csrf: string; expires_at: string }>('/api/auth/login', {
        method: 'POST',
        noAuthRedirect: true,
        timeoutMs: 20000,
        body: { username, password, totp: totp || undefined },
      });
      setCsrf(r.csrf);
      set({ user: r.user });
      void useSession.getState().refreshVersion();
      return { needTotp: false };
    } catch (e) {
      const err = e as { code?: string; message: string };
      if (err.code === 'need_totp' || err.message.includes('two-factor')) {
        return { needTotp: true };
      }
      throw e;
    }
  },

  logout: async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* already out */
    }
    setCsrf(null);
    set({ user: null });
  },

  logoutLocal: () => {
    setCsrf(null);
    set({ user: null });
  },

  refreshVersion: async () => {
    try {
      const v = await api<{ service: string; version: string; commit: string | null }>('/api/version');
      set({ version: v.version, commit: v.commit });
    } catch {
      /* non-fatal */
    }
  },
}));
