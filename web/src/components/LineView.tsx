import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef } from 'react';
import css from './LineView.module.css';

const LINE_PX = 18;
/** Long lines (a JSON-escaped multi-MB string is one line) are cut into rows of this many chars. */
const WRAP = 240;

interface Row {
  text: string;
  /** A continuation of the previous row's line. */
  continued: boolean;
}

function toRows(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= WRAP) {
      rows.push({ text: line, continued: false });
      continue;
    }
    for (let i = 0; i < line.length; i += WRAP)
      rows.push({ text: line.slice(i, i + WRAP), continued: i > 0 });
  }
  return rows;
}

/** Megabytes of text, one virtualised row per line, so the page stays responsive. */
export function LineView({ text }: { text: string }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => toRows(text), [text]);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_PX,
    overscan: 20,
  });
  return (
    <div ref={parentRef} className={css.view} data-scroll-region>
      <div style={{ height: v.getTotalSize(), position: 'relative', minWidth: 'max-content' }}>
        {v.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-line
            data-continued={rows[item.index]?.continued || undefined}
            className={css.line}
            style={{ transform: `translateY(${item.start}px)`, height: LINE_PX }}
          >
            {rows[item.index]?.text || ' '}
          </div>
        ))}
      </div>
    </div>
  );
}
