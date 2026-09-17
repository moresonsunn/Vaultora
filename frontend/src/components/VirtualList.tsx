import React, { useEffect, useRef, useState } from 'react';

/* Fixed-height windowing list: renders only visible rows + overscan.
 * Handles 10k+ file folders without lag (no per-row work off-screen). */
interface Props<T> {
  items: T[];
  rowHeight: number;
  overscan?: number;
  resetKey?: string;
  className?: string;
  style?: React.CSSProperties;
  keyOf: (item: T, index: number) => string;
  renderRow: (item: T, index: number) => React.ReactNode;
}

export function VirtualList<T>({
  items,
  rowHeight,
  overscan = 8,
  resetKey,
  className,
  style,
  keyOf,
  renderRow,
}: Props<T>): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 40 });
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const compute = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = Math.max(0, Math.floor(el.scrollTop / rowHeight) - overscan);
    const end = Math.min(items.length, Math.ceil((el.scrollTop + el.clientHeight) / rowHeight) + overscan);
    const cur = rangeRef.current;
    if (cur.start !== start || cur.end !== end) setRange({ start, end });
  }, [items.length, rowHeight, overscan]);

  useEffect(() => {
    compute();
  }, [compute, items]);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = 0;
    compute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(compute);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [compute]);

  const rows = [];
  for (let i = range.start; i < range.end; i++) {
    const item = items[i];
    rows.push(
      <div key={keyOf(item, i)} className="vrow" style={{ top: i * rowHeight, height: rowHeight }}>
        {renderRow(item, i)}
      </div>
    );
  }
  return (
    <div ref={ref} className={className || 'vlist'} style={{ maxHeight: 560, ...style }}>
      <div className="vlist-inner" style={{ height: items.length * rowHeight }}>
        {rows}
      </div>
    </div>
  );
}
