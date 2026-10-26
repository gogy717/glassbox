/**
 * The session receipt as a short slip (`short.ts`): what a phone's screen can read of a session
 * at a glance. Post: the head, who and when, the title, ACTIVE TIME · TOTAL · API EQUIV. large,
 * one line of work, the barcode. Story: the same, then TIME and TOKENS. The title and the work
 * line give way first (two lines to one), then a story's tokens, then its time.
 */
import { agentName } from '../../lib/agent-names';
import type { ReceiptData } from './data';
import { clock, day, durationParts, modelName } from './format';
import { clip, testRunWords, timed, timeRows } from './rows';
import {
  costFigure,
  drawBarcode,
  type Figure,
  figures,
  finish,
  shortHeight,
  tokensBrief,
  totalFigure,
} from './short';
import {
  INNER,
  LEFT,
  Pen,
  type ReceiptOptions,
  type ReceiptSize,
  runs,
  text,
  textWidth,
  wrap,
} from './slip';
import type { ReceiptKey } from './strings';

interface Plan {
  title: number;
  work: number;
  time: boolean;
  tokens: boolean;
}

const POST: Plan[] = [
  { title: 2, work: 2, time: false, tokens: false },
  { title: 2, work: 1, time: false, tokens: false },
  { title: 1, work: 1, time: false, tokens: false },
];
const STORY: Plan[] = [
  { title: 2, work: 2, time: true, tokens: true },
  { title: 2, work: 1, time: true, tokens: true },
  { title: 1, work: 1, time: true, tokens: true },
  { title: 1, work: 1, time: true, tokens: false },
  { title: 1, work: 1, time: false, tokens: false },
];

/** The work in one line: calls, tools, test runs, commits, failures; a part at zero left out. */
export function workLine(d: ReceiptData, w: Pen['w'], L: ReceiptOptions['locale']): string {
  const parts: string[] = [];
  const say = (n: number, key: ReceiptKey) => {
    if (n > 0) parts.push(`${n} ${w(key, { n })}`);
  };
  say(d.work.requests, 'modelCalls');
  say(d.work.toolCalls, 'toolCalls');
  if (d.work.tests) parts.push(`${d.work.tests.runs} ${testRunWords(d.work.tests, L)}`);
  say(d.work.commits, 'commits');
  say(d.work.subAgents, 'subAgents');
  say(d.work.failures, 'failures');
  return parts.join(' · ');
}

function draw(d: ReceiptData, o: ReceiptOptions, plan: Plan, height: number) {
  const p = new Pen(o);
  const { c, L } = p;
  const w = (key: ReceiptKey, params?: Record<string, string | number>) => p.w(key, params);
  const fits11 = (s: string) => textWidth(s, 11);

  p.head('heading');
  p.y = 78;
  const who = [
    agentName(d.agent),
    d.model ? modelName(d.model) : null,
    d.effort ? w('effort', { e: d.effort }) : null,
  ];
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

  // What it was about, unless the names are withheld.
  p.y += 20;
  if (!o.hideNames && d.project) {
    const project = clip(d.project, INNER - textWidth(' /', 11), fits11);
    p.push(text(LEFT, p.y, runs(`${project} /`), { size: 11, fill: c.soft }));
    p.y += 18;
  }
  const title = o.hideNames || !d.title ? w('untitled') : d.title;
  for (const line of wrap(title, 13.5, INNER, plan.title)) {
    p.push(text(LEFT, p.y, runs(line), { size: 13.5, weight: 600, fill: c.ink }));
    p.y += 20;
  }
  p.y += 2;
  p.rule();

  // The headline figures: how long it worked, the tokens, what they would cost on the API (or
  // the model calls when nothing is priced).
  const items: Figure[] = [
    {
      key: 'activeTime',
      value: d.durationMs === null ? '—' : durationParts(d.durationMs, L),
    },
    totalFigure(p, d.tokens),
    costFigure(d.tokens) ?? { key: 'modelCalls', value: String(d.work.requests) },
  ];
  figures(p, items);
  p.y += 14;
  p.rule();

  // WORK in a line or two.
  const line = workLine(d, w, L);
  if (line) {
    p.y += 18;
    for (const l of wrap(line, 11.5, INNER, plan.work)) {
      p.push(text(LEFT, p.y, runs(l), { size: 11.5, fill: c.ink }));
      p.y += 16;
    }
    p.y -= 16;
  }

  // The barcode.
  p.y += 8;
  const drawn = drawBarcode(p, d);
  if (!drawn) p.y -= 8;

  // A story's room: TIME and TOKENS.
  if (plan.time && timed(d)) {
    p.y += 16;
    p.rule();
    p.y += 16;
    p.label('time');
    for (const r of timeRows(d)) {
      p.y += 18;
      p.row(w(r.key), durationParts(r.ms, L), { valueRight: 360 - 22 - 42, share: `${r.share}%` });
    }
  }
  if (plan.tokens) {
    p.y += 16;
    p.rule();
    tokensBrief(p, d.tokens);
  }

  const fits = finish(p, height, d.tokens.measured);
  return { body: p.out.join(''), fits };
}

/** The session receipt drawn short for `size`, in slip units; the first plan that fits. */
export function drawShortSession(
  d: ReceiptData,
  o: ReceiptOptions,
  size: Exclude<ReceiptSize, 'tall'>,
): { body: string; height: number } {
  const height = shortHeight(size);
  let body = '';
  for (const plan of size === 'post' ? POST : STORY) {
    const r = draw(d, o, plan, height);
    body = r.body;
    if (r.fits) break;
  }
  return { body, height };
}
