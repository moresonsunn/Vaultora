import { useEffect } from 'react';
import { useSession } from './store/session';
import { useFiles } from './store/files';
import { useUi } from './store/ui';
import { useUploads } from './store/uploads';
import { initTheme } from './store/ui';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { BulkBar, Toolbar } from './components/Toolbar';
import { UploadPanel } from './components/UploadPanel';
import { Preview } from './components/Preview';
import { ModalHost, PromptDialog, ConfirmDialog } from './components/Modal';
import { Toasts } from './components/Toasts';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FilesView, ResultsView, SharedView, TrashView } from './components/views';
import { Admin } from './components/Admin';
import { SharePage } from './components/SharePage';

function Shell() {
  const user = useSession((s) => s.user);
  const view = useFiles((s) => s.view);
  const go = useFiles((s) => s.go);
  const reload = useFiles((s) => s.reload);
  const refreshStorage = useFiles((s) => s.refreshStorage);
  const remove = useFiles((s) => s.remove);
  const mkdir = useFiles((s) => s.mkdir);
  const toggleGrid = useFiles((s) => s.toggleGrid);
  const openModal = useUi((s) => s.openModal);
  const closeModal = useUi((s) => s.closeModal);
  const toast = useUi((s) => s.toast);
  const queue = useUploads((s) => s.queue);

  // initial load
  useEffect(() => {
    if (user) {
      go('files', '/My Files');
      void refreshStorage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // guard: non-admins never see the admin view
  useEffect(() => {
    if (view === 'admin' && user?.role !== 'admin') go('files');
  }, [view, user, go]);

  // drag & drop uploads
  useEffect(() => {
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        depth++;
        document.body.classList.add('dragging');
      }
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) document.body.classList.remove('dragging');
    };
    const onOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      if (e.dataTransfer?.files.length) {
        const vdir = view === 'trash' || view === 'admin' ? '/My Files' : useFiles.getState().path;
        queue(Array.from(e.dataTransfer.files), vdir);
      }
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [queue, view]);

  // keyboard shortcuts: / u n Del Ctrl+A g r Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
        if (e.key === 'Escape') (document.activeElement as HTMLElement).blur();
        return;
      }
      const st = useFiles.getState();
      if (e.key === '/') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('#searchInput')?.focus();
      } else if (e.key === 'u') {
        document.querySelector<HTMLInputElement>('#filePick')?.click();
      } else if (e.key === 'n') {
        openModal(
          <PromptDialog
            title="New folder"
            label="Folder name"
            initial=""
            okLabel="Create"
            onOk={(name) => mkdir(name).catch((err: Error) => toast(err.message))}
          />
        );
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (st.selection.size > 0) {
          const paths = [...st.selection];
          openModal(
            <ConfirmDialog
              title="Delete"
              message={`Delete ${paths.length} item(s)? They move to Trash (if enabled).`}
              onOk={() => remove(paths).catch((err: Error) => toast(err.message))}
            />
          );
        }
      } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        st.selectAll(true);
      } else if (e.key === 'Escape') {
        st.clearSelection();
        closeModal();
        useUi.getState().closePreview();
      } else if (e.key === 'g') {
        toggleGrid();
      } else if (e.key === 'r' && (st.view === 'files' || st.view === 'home')) {
        reload();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openModal, closeModal, toast, mkdir, remove, toggleGrid, reload]);

  if (!user) return null;

  return (
    <>
      <ErrorBoundary>
        <Sidebar />
      </ErrorBoundary>
      <div className="main">
        <ErrorBoundary>
          <Topbar />
        </ErrorBoundary>
        <ErrorBoundary>
          <Toolbar />
        </ErrorBoundary>
        <div style={{ padding: '0 16px' }}>
          <ErrorBoundary>
            <BulkBar />
          </ErrorBoundary>
        </div>
        <div className="content" id="content">
          <div className="drop-hint">Drop files here to upload — they go straight to this folder on your server.</div>
          <div id="listWrap">
            <ErrorBoundary>
              {view === 'admin' ? (
                user.role === 'admin' ? (
                  <Admin />
                ) : (
                  <div style={{ padding: 24, color: 'var(--muted)' }}>Admin access required.</div>
                )
              ) : view === 'trash' ? (
                <TrashView />
              ) : view === 'shared' ? (
                <SharedView />
              ) : view === 'recent' ? (
                <ResultsView emptyText="No recent files." />
              ) : view === 'starred' ? (
                <ResultsView emptyText="Nothing starred yet. Star files from their menu." />
              ) : view === 'search' ? (
                <ResultsView emptyText="No matches." />
              ) : (
                <FilesView />
              )}
            </ErrorBoundary>
          </div>
        </div>
      </div>
      <UploadPanel />
      <ModalHost />
      <Preview />
    </>
  );
}

export default function App() {
  const user = useSession((s) => s.user);
  const boot = useSession((s) => s.boot);

  useEffect(() => {
    initTheme();
    void boot();
  }, [boot]);

  const token = (() => {
    const m = window.location.pathname.match(/^\/s\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  })();
  // Public share links need no session.
  if (token) {
    return (
      <>
        <SharePage token={token} />
        <Toasts />
      </>
    );
  }

  return (
    <>
      <div id="loginView" className="login-wrap" hidden={!!user}>
        <Login />
      </div>
      <div id="app" hidden={!user}>
        <Shell />
      </div>
      <Toasts />
    </>
  );
}
