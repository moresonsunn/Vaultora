/* Formatting helpers. */

export function fmtBytes(n: number | null | undefined): string {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

export function fmtSpeed(bps: number): string {
  if (!bps || bps <= 0) return '';
  return `${fmtBytes(bps)}/s`;
}

export function fmtEta(u: { total: number; loaded: number; speed: number }): string {
  if (!u.speed || u.speed < 1 || u.loaded >= u.total) return '';
  const s = Math.max(0, (u.total - u.loaded) / u.speed);
  if (s < 1) return '';
  if (s < 60) return `${Math.ceil(s)}s left`;
  return `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s left`;
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function baseName(vpath: string): string {
  const i = vpath.lastIndexOf('/');
  return i >= 0 ? vpath.slice(i + 1) : vpath;
}

export function dirName(vpath: string): string {
  const i = vpath.lastIndexOf('/');
  return i > 0 ? vpath.slice(0, i) : '/My Files';
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
