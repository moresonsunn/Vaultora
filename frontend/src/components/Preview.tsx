import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtBytes } from '../lib/format';
import { useUi } from '../store/ui';
import { Icon } from '../icons';

const IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const VID = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v']);
const AUD = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'opus']);

function extOf(name: string): string {
  const i = name.toLowerCase().lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function Preview() {
  const preview = useUi((s) => s.preview);
  const closePreview = useUi((s) => s.closePreview);
  const [text, setText] = useState<{ text: string; size: number; truncated: boolean } | null>(null);
  const [meta, setMeta] = useState<{ mime: string; size: number } | null>(null);
  const [error, setError] = useState('');

  const vpath = preview && 'vpath' in preview ? preview.vpath : null;
  const name = preview
    ? 'name' in preview && preview.name
      ? preview.name
      : (preview.vpath.split('/').pop() ?? preview.vpath)
    : '';

  useEffect(() => {
    setText(null);
    setMeta(null);
    setError('');
    if (!vpath) return;
    const ext = extOf(name);
    if (IMG.has(ext) || VID.has(ext) || AUD.has(ext) || ext === 'pdf') return; // streamed inline
    let cancelled = false;
    api<{ type: string; text: string; size: number; truncated: boolean }>(`/api/files/preview?path=${encodeURIComponent(vpath)}`)
      .then((d) => {
        if (cancelled) return;
        if (d && d.type === 'text') setText({ text: d.text, size: d.size, truncated: d.truncated });
        else setMeta({ mime: '', size: 0 });
      })
      .catch(() => {
        if (cancelled) return;
        api<{ mime: string; size: number }>(`/api/files/stat?path=${encodeURIComponent(vpath ?? '')}`)
          .then((st) => {
            if (!cancelled) setMeta({ mime: st.mime || 'unknown', size: st.size });
          })
          .catch((e: Error) => {
            if (!cancelled) setError(e.message);
          });
      });
    return () => {
      cancelled = true;
    };
  }, [vpath, name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePreview();
    };
    if (preview) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [preview, closePreview]);

  if (!preview || !vpath) return null;
  const url = `/api/files/preview?path=${encodeURIComponent(vpath)}`;
  const dl = `/api/files/download?path=${encodeURIComponent(vpath)}`;
  const ext = extOf(name);

  return (
    <div id="preview" className="open" onMouseDown={(e) => e.target === e.currentTarget && closePreview()}>
      <div className="box">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <strong id="pvName" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {name}
          </strong>
          <a className="btn sm" id="pvDl" href={dl} download={name}>
            <Icon name="download" size={14} /> Download
          </a>
          <button className="iconbtn" id="pvClose" onClick={closePreview} aria-label="Close preview">
            <Icon name="x" size={15} />
          </button>
        </div>
        <div id="pvBody">
          {IMG.has(ext) && <img src={url} alt={name} />}
          {VID.has(ext) && <video src={url} controls playsInline preload="metadata" />}
          {AUD.has(ext) && <audio src={url} controls style={{ width: '100%' }} />}
          {ext === 'pdf' && <iframe src={url} style={{ width: '100%', height: '70vh', border: 0 }} title={name} />}
          {!IMG.has(ext) && !VID.has(ext) && !AUD.has(ext) && ext !== 'pdf' && !text && !meta && !error && (
            <div className="muted">Loading…</div>
          )}
          {text && (
            <>
              <div className="small muted">
                {fmtBytes(text.size)}
                {text.truncated ? ' · showing first 512 KB' : ''}
              </div>
              <pre>{text.text}</pre>
            </>
          )}
          {meta && !text && (
            <>
              <dl className="kv">
                <dt>Type</dt>
                <dd>{meta.mime}</dd>
                <dt>Size</dt>
                <dd>{fmtBytes(meta.size)}</dd>
              </dl>
              <p className="muted">No browser preview for this type — use Download.</p>
            </>
          )}
          {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
        </div>
      </div>
    </div>
  );
}
