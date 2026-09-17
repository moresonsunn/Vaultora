/* UI store: theme, toasts, modal dialog, preview overlay. */
import { create } from 'zustand';
import type { ReactNode } from 'react';
import type { SearchItem } from '../lib/types';

export interface Toast {
  id: number;
  text: string;
}

export type PreviewTarget = { vpath: string; name: string } | SearchItem | null;

interface UiState {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  toasts: Toast[];
  toast: (text: string) => void;
  dismissToast: (id: number) => void;
  modal: ReactNode | null;
  openModal: (node: ReactNode) => void;
  closeModal: () => void;
  preview: PreviewTarget;
  openPreview: (t: NonNullable<PreviewTarget>) => void;
  closePreview: () => void;
}

let toastId = 1;

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('v_theme', theme);
  } catch {
    /* ignore */
  }
}

function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('v_theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    /* ignore */
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const useUi = create<UiState>((set, get) => ({
  theme: initialTheme(),
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    set({ theme: next });
  },

  toasts: [],
  toast: (text) => {
    const id = toastId++;
    set({ toasts: [...get().toasts, { id, text }] });
    setTimeout(() => get().dismissToast(id), 3400);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  modal: null,
  openModal: (node) => set({ modal: node }),
  closeModal: () => set({ modal: null }),

  preview: null,
  openPreview: (t) => set({ preview: t }),
  closePreview: () => set({ preview: null }),
}));

export function initTheme(): void {
  applyTheme(initialTheme());
}
