/**
 * The session's receipt as one SVG, drawn the same for the preview and for export: the head, who
 * and when, how long, what it was about, WORK, TIME with the barcode, TOKENS and the foot, with
 * the pen and frame every receipt shares (`slip.ts`).
 */
import { agentName } from '../../lib/agent-names';
import { BAR_HEIGHT, type BarKind, barcode } from './barcode';
import type { ReceiptData } from './data';
import { clock, day, durationParts, modelName, serial } from './format';
import { categoryLine, clip, timed, timeRows } from './rows';
import {
  EDGE,
  frame,
  INNER,
  LEFT,
  num,
  Pen,
  partsBody,
  type ReceiptOptions,
  type ReceiptSize,
  RIGHT,
  runs,
  text,
  textWidth,
  WIDTH,
  wrap,
} from './slip';
import type { ReceiptKey } from './strings';

export {
  type Paper,
  type ReceiptOptions,
  type ReceiptSize,
  SCALE,
  SIZES,
  textWidth,
  WIDTH,
  wrap,
} from './slip';

/** The receipt's drawing (without its outline) and its height, in slip units. */
export function drawReceipt(d: ReceiptData, o: ReceiptOptions): { body: string; height: number } {
  const p = new Pen(o);
  const { c, L } = p;
  const w = (key: ReceiptKey, params?: Record<string, string | number>) => p.w(key, params);

  // Head: the mark and name, RECEIPT at the right, a rule.
  p.head('heading');
  // Who, when.
  p.y = 78;
  const who = [
    agentName(d.agent),
    d.model ? modelName(d.model) : null,
    d.effort ? w('effort', { e: d.effort }) : null,
  ];
  const fits11 = (s: string) => textWidth(s, 11);
  p.push(
    text(LEFT, p.y, runs(clip(who.filter(Boolean).join(' · '), INNER, fits11)), {
      size: 11,
      fill: c.soft,
    }),
  );
  p.y += 17;
  const span = d.running
    ? `${d.start !== null ? clock(d.start) : ''} → ${w('now')} · ${w('stillRunning')}`
    : d.start !== null
      ? `${clock(d.start)} – ${clock(d.end)}`
      : clock(d.end);
  p.push(
    text(LEFT, p.y, runs(`${day(d.start ?? d.end, L)} · ${span.trim()}`), {
      size: 11,
      fill: c.soft,
    }),
  );
  // The hero: how long it worked.
  p.y += 37;
  p.label('duration');
  p.push(
    text(
      RIGHT,
      p.y + 5,
      d.durationMs === null ? runs('—') : partsBody(durationParts(d.durationMs, L)),
      {
        size: 24,
        weight: 500,
        fill: c.ink,
        anchor: 'end',
      },
    ),
  );
  p.y += 20;
  p.rule();
  // What it was about, unless the names are withheld.
  p.y += 18;
  if (!o.hideNames && d.project) {
    const project = clip(d.project, INNER - textWidth(' /', 11), fits11);
    p.push(text(LEFT, p.y, runs(`${project} /`), { size: 11, fill: c.soft }));
    p.y += 20;
  }
  const title = o.hideNames || !d.title ? w('untitled') : d.title;
  for (const line of wrap(title, 13, INNER, 3)) {
    p.push(text(LEFT, p.y, runs(line), { size: 13, weight: 600, fill: c.ink }));
    p.y += 19.5;
  }
  p.y += 3;
  p.rule();

  // WORK: counts, right-aligned in a column as wide as the longest; a line at zero is left out.
  p.y += 18;
  p.label('work');
  const counts: [number, ReceiptKey][] = [
    [d.work.requests, 'modelCalls'],
    [d.work.toolCalls, 'toolCalls'],
  ];
  const digits = Math.max(
    ...[d.work.requests, d.work.toolCalls, d.work.subAgents, d.work.turns].map(
      (n) => String(n).length,
    ),
  );
  const numRight = LEFT + Math.max(30, textWidth('0'.repeat(digits), 12));
  const workRow = (n: number, key: ReceiptKey, fail = false) => {
    p.y += 19;
    const fill = fail ? c.fail : c.ink;
    p.push(text(numRight, p.y, runs(String(n)), { fill, anchor: 'end' }));
    p.push(text(numRight + 8, p.y, runs(w(key, { n })), { fill }));
  };
  for (const [n, key] of counts) {
    if (n <= 0) continue;
    workRow(n, key);
    if (key === 'toolCalls' && d.work.categories.length > 0) {
      p.y += 17;
      const room = RIGHT - (numRight + 8);
      const cats = categoryLine(d.work.categories, L, (line) => textWidth(line, 11) <= room);
      p.push(text(numRight + 8, p.y, runs(cats), { size: 11, fill: c.soft }));
    }
  }
  if (d.work.subAgents > 0) workRow(d.work.subAgents, 'subAgents');
  if (d.work.turns > 0) workRow(d.work.turns, 'conversations');
  if (d.work.failures > 0) workRow(d.work.failures, 'failures', true);
  if (d.work.compactions > 0) workRow(d.work.compactions, 'compactions');
  p.y += 22;
  p.rule();

  // TIME: where it went, each line's share of what is printed, then the barcode; left out when
  // nothing was timed (a session read without its timings).
  const code = barcode(d.segments, d.subAgents, d.failedTools, INNER, d.subSegments);
  const drawn = code.bars.length > 0 || code.tracks.length > 0;
  const hasTime = timed(d) || drawn;
  if (hasTime) {
    p.y += 18;
    p.label('time');
  }
  for (const r of timeRows(d)) {
    p.y += 19;
    p.row(w(r.key), durationParts(r.ms, L), { valueRight: RIGHT - 42, share: `${r.share}%` });
  }
  if (d.time.longestThink >= 1000) {
    p.y += 17;
    p.row(w('longestThink'), durationParts(d.time.longestThink, L), {
      size: 11,
      fill: c.soft,
      valueRight: RIGHT - 42,
    });
  }

  // The barcode: the session's own timeline.
  if (drawn) {
    const bottom = p.y + 12 + 42;
    const ink = (k: BarKind) => (k === 'fail' ? c.fail : k === 'approval' ? c.soft : c.ink);
    for (const b of code.bars) {
      const h = BAR_HEIGHT[b.kind];
      p.push(
        `<rect x="${num(LEFT + b.x)}" y="${num(bottom - h)}" width="${num(b.w)}" height="${h}" fill="${ink(b.kind)}"/>`,
      );
    }
    for (const x of code.breaks)
      p.push(
        `<path d="M${num(LEFT + x - 3)} ${num(bottom + 3)} l2 -6 M${num(LEFT + x + 1)} ${num(bottom + 3)} l2 -6" stroke="${c.soft}" stroke-width="1"/>`,
      );
    let ty = bottom + 6;
    code.tracks.forEach((t, i) => {
      p.push(
        `<rect x="${num(LEFT + t.x)}" y="${num(ty)}" width="${num(t.w)}" height="2" fill="${c.soft}"/>`,
      );
      // "+N" just before the merged track's start (in the margin if need be), else after its
      // end, else under its start: never past the paper's edge.
      if (i === code.tracks.length - 1 && code.more > 0) {
        const label = `+${code.more}`;
        const lw = textWidth(label, 9);
        const before = LEFT + t.x - 4;
        const after = LEFT + t.x + t.w + 4;
        const style = { size: 9, fill: c.soft };
        if (before - lw >= EDGE)
          p.push(text(before, ty + 3, runs(label), { ...style, anchor: 'end' }));
        else if (after + lw <= WIDTH - EDGE) p.push(text(after, ty + 3, runs(label), style));
        else {
          ty += 10;
          p.push(text(Math.min(LEFT + t.x, WIDTH - EDGE - lw), ty + 3, runs(label), style));
        }
      }
      ty += 4;
    });
    p.y = ty + 14;
    p.push(
      text(LEFT, p.y, runs(d.start !== null ? clock(d.start) : ''), { size: 10.5, fill: c.soft }),
    );
    p.push(
      text(RIGHT, p.y, runs(d.running ? w('now') : clock(d.end)), {
        size: 10.5,
        fill: c.soft,
        anchor: 'end',
      }),
    );
    p.y += 17;
    p.push(
      text(WIDTH / 2, p.y, runs(serial(d.nativeId, d.start, d.end)), {
        size: 10.5,
        fill: c.soft,
        anchor: 'middle',
        spacing: 1,
      }),
    );
  }
  if (hasTime) {
    p.y += 18;
    p.rule();
  }

  // TOKENS: what the session read and wrote, unless no call reported usage.
  p.tokens(d.tokens);
  const height = p.foot(d.tokens.measured);
  return { body: p.out.join(''), height };
}

/** The session's receipt as an image at `size`, in slip units. */
export function receiptSvg(
  d: ReceiptData,
  o: ReceiptOptions,
  size: ReceiptSize,
): { svg: string; width: number; height: number } {
  return frame(drawReceipt(d, o), o, size);
}
