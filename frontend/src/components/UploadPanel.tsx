import { Icon } from '../icons';
import { fmtEta, fmtSpeed } from '../lib/format';
import { overallProgress, useUploads, type UploadJob } from '../store/uploads';

function statusLabel(j: UploadJob): string {
  switch (j.status) {
    case 'queued':
      return 'Queued';
    case 'uploading':
      return 'Uploading';
    case 'paused':
      return 'Paused';
    case 'error':
      return `Error — ${j.error || 'failed'}`;
    case 'cancelled':
      return 'Cancelled';
    case 'done':
      return 'Done';
  }
}

/** Subscribes per job id: one row re-renders per progress tick, nothing else. */
function UploadRow({ id }: { id: string }) {
  const job = useUploads((s) => s.jobs[id]);
  const pause = useUploads((s) => s.pause);
  const resume = useUploads((s) => s.resume);
  const cancel = useUploads((s) => s.cancel);
  const retry = useUploads((s) => s.retry);
  const dismiss = useUploads((s) => s.dismiss);
  if (!job) return null;
  const pct = job.total ? Math.round((Math.min(job.loaded, job.total) / job.total) * 100) : 100;
  const meta =
    job.status === 'uploading' && job.loaded > 0
      ? ` · ${fmtSpeed(job.speed)} · ${fmtEta(job)}`
      : '';
  const small = (label: string, fn: () => void) => (
    <button key={label} className="btn sm ghost" style={{ padding: '2px 8px' }} onClick={fn}>
      {label}
    </button>
  );
  return (
    <div className="up-item" id={`up-${id}`}>
      <div className="t">
        <span className="n" title={job.relPath}>
          {job.relPath}
        </span>
        <span>{pct}%</span>
      </div>
      <div className="bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="meta">
        {statusLabel(job)}
        {meta}{' '}
        <span>
          {job.status === 'uploading' && (
            <>
              {small('Pause', () => pause(id))} {small('Cancel', () => cancel(id))}
            </>
          )}
          {job.status === 'paused' && (
            <>
              {small('Resume', () => resume(id))} {small('Cancel', () => cancel(id))}
            </>
          )}
          {(job.status === 'error' || job.status === 'cancelled') && (
            <>
              {small('Retry', () => retry(id))} {small('Dismiss', () => dismiss(id))}
            </>
          )}
          {job.status === 'done' && small('Dismiss', () => dismiss(id))}
          {job.status === 'queued' && small('Cancel', () => cancel(id))}
        </span>
      </div>
    </div>
  );
}

export function UploadPanel() {
  const jobs = useUploads((s) => s.jobs);
  const panelOpen = useUploads((s) => s.panelOpen);
  const setPanelOpen = useUploads((s) => s.setPanelOpen);
  if (!panelOpen) return null;
  const ids = Object.keys(jobs);
  const overall = overallProgress(jobs);
  const done = ids.filter((id) => jobs[id].status === 'done').length;
  return (
    <div id="upPanel" className="open">
      <div className="hd">
        <span style={{ flex: 1 }} id="upTitle">
          {ids.length ? `Uploads · ${overall.pct}% overall` : 'Uploads'}
        </span>
        <span className="small muted" id="upTotal">
          {ids.length ? `${done}/${ids.length}` : ''}
        </span>
        <button className="iconbtn" id="upClose" onClick={() => setPanelOpen(false)} aria-label="Close uploads">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div id="upList">
        {ids.length === 0 && <div className="muted small" style={{ padding: 12 }}>No uploads yet.</div>}
        {ids.map((id) => (
          <UploadRow key={id} id={id} />
        ))}
      </div>
    </div>
  );
}
