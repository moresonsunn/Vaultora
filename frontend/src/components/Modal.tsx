import React, { useEffect } from 'react';
import { useUi } from '../store/ui';
import { Icon } from '../icons';

export function ModalHost() {
  const modal = useUi((s) => s.modal);
  const closeModal = useUi((s) => s.closeModal);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    if (modal) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal, closeModal]);
  if (!modal) return null;
  return (
    <div
      className="overlay open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true">
        {modal}
      </div>
    </div>
  );
}

export function DialogButtons({ children }: { children: React.ReactNode }) {
  return <div className="row">{children}</div>;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  danger = true,
  onOk,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onOk: () => void;
}) {
  const closeModal = useUi((s) => s.closeModal);
  return (
    <>
      <h3>{title}</h3>
      <p className="muted">{message}</p>
      <DialogButtons>
        <button className="btn ghost" onClick={closeModal}>
          Cancel
        </button>
        <button
          className={danger ? 'btn danger' : 'btn primary'}
          onClick={() => {
            closeModal();
            onOk();
          }}
        >
          {confirmLabel}
        </button>
      </DialogButtons>
    </>
  );
}

export function PromptDialog({
  title,
  label,
  initial = '',
  okLabel = 'OK',
  onOk,
}: {
  title: string;
  label: string;
  initial?: string;
  okLabel?: string;
  onOk: (value: string) => void;
}) {
  const closeModal = useUi((s) => s.closeModal);
  const [value, setValue] = React.useState(initial);
  const inputRef = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const v = value.trim();
        if (!v) return;
        closeModal();
        onOk(v);
      }}
    >
      <h3>{title}</h3>
      <label>{label}</label>
      <input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} />
      <DialogButtons>
        <button type="button" className="btn ghost" onClick={closeModal}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          {okLabel}
        </button>
      </DialogButtons>
    </form>
  );
}

export function CloseButton() {
  const closeModal = useUi((s) => s.closeModal);
  return (
    <button className="iconbtn" onClick={closeModal} aria-label="Close">
      <Icon name="x" size={16} />
    </button>
  );
}
