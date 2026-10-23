import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenSession } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import { DEMO_NOW, demoOpen } from '../../test/demo';
import { UiContext } from '../../ui';
import { TimeView } from './TimeView';

function renderTime(agentId = 'main', open: OpenSession = demoOpen()) {
  const navigate = vi.fn();
  const setFollow = vi.fn();
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <UiContext.Provider value={{ follow: true, setFollow }}>
        <TimeView open={open} agentId={agentId} navigate={navigate} />
      </UiContext.Provider>
    </I18nContext.Provider>,
  );
  return { navigate, setFollow };
}

const zoomIn = (times: number) => {
  for (let i = 0; i < times; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
};

/** recon:live-write doing 66 short requests back to back for 17 minutes. */
function denseOpen(): OpenSession {
  const open = demoOpen();
  const agentId = 'af00000000000001';
  const template = [...open.requests.values()].find((r) => r.agentId === agentId);
  if (!template) throw new Error('fixture');
  const requests = new Map([...open.requests].filter(([, r]) => r.agentId !== agentId));
  const toolCalls = new Map([...open.toolCalls].filter(([, t]) => t.agentId !== agentId));
  const t0 = DEMO_NOW.getTime() - 30 * 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  for (let i = 0; i < 66; i++) {
    const start = t0 + i * 15_450;
    requests.set(`dense_${i}`, {
      ...template,
      id: `dense_${i}`,
      index: i + 1,
      startedAt: iso(start),
      firstBlockAt: iso(start + 7_000),
      endedAt: iso(start + 11_650),
      blocks: [{ kind: 'thinking', text: null, durationMs: 7_000, at: iso(start + 7_000) }],
      toolCallIds: [],
    });
  }
  return { ...open, requests, toolCalls };
}

describe('TimeView', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(DEMO_NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('shows the timeline first, above the breakdown and the slowest steps', () => {
    renderTime();
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-labelledby'))).toEqual([
      'time-lanes',
      'time-breakdown',
      'time-slowest',
    ]);
  });

  it('breaks the selected agent’s time into model, tools and idle', () => {
    renderTime();
    const card = screen.getByRole('region', { name: 'Where the time went · Main' });
    expect(
      within(card)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Thinking2m21s',
      'Generating39s',
      'Tools · Explore550ms',
      'Tools · Edit50ms',
      'Tools · Delegate250ms',
      'Idle (between conversations)36m54s',
    ]);
  });

  it('lists the slowest steps and opens one in the execution chain', () => {
    const { navigate, setFollow } = renderTime();
    const card = screen.getByRole('region', { name: 'Slowest 10 steps' });
    const items = within(card).getAllByRole('button');
    expect(items).toHaveLength(10);
    expect(items[0]).toHaveTextContent('verify:live-write');
    expect(items[0]).toHaveTextContent('Conversation 1 · call #3');
    expect(items[0]).toHaveTextContent('26m28s');
    expect(items[1]).toHaveTextContent('recon:prior-art');
    expect(items[1]).toHaveTextContent('Bash · python3 -I survey.py');
    fireEvent.click(items[0] as HTMLElement);
    expect(setFollow).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenLastCalledWith({
      tab: 'flow',
      agentId: 'af00000000000003',
      turnId: 'turn_w3',
      requestId: 'req_w3_3',
    });
  });

  it('draws one lane per agent, grouped by workflow phase, with idle gaps collapsed', () => {
    renderTime();
    const lanes = screen.getByRole('region', { name: 'Timeline' });
    const labels = within(lanes).getByRole('list', { name: 'Agents' });
    expect(
      within(labels)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Main',
      'Explore transcript format',
      'cc-recon · Recon',
      'recon:live-write',
      'recon:prior-art',
      'cc-recon · Verify',
      'verify:live-write',
    ]);
    expect(within(lanes).getByRole('img', { name: 'Timeline per agent' })).toBeInTheDocument();
    expect(within(lanes).getByText('Idle 4m12s')).toBeInTheDocument();
  });

  it('opens the request behind a segment and explains it on hover', () => {
    const { navigate } = renderTime();
    zoomIn(3);
    const lanes = screen.getByRole('region', { name: 'Timeline' });
    const seg = lanes.querySelector('[data-ref="req_m1"][data-kind="thinking"]') as Element;
    fireEvent.mouseEnter(seg);
    const tip = within(lanes).getByRole('tooltip');
    expect(tip).toHaveTextContent('Thinking');
    expect(tip).toHaveTextContent('Main');
    expect(tip).toHaveTextContent('8.4s');
    fireEvent.click(seg);
    expect(navigate).toHaveBeenLastCalledWith({
      tab: 'flow',
      agentId: 'main',
      turnId: 'turn_m1',
      requestId: 'req_m1',
    });
  });

  it('names the tool and what it did when hovering a tool segment', () => {
    renderTime();
    zoomIn(9);
    const lanes = screen.getByRole('region', { name: 'Timeline' });
    fireEvent.mouseEnter(lanes.querySelector('[data-ref="tu_m1a"]') as Element);
    const tip = within(lanes).getByRole('tooltip');
    expect(tip).toHaveTextContent('Bash');
    expect(tip).toHaveTextContent('rg -n "sortSessions" src');
    expect(tip).toHaveTextContent('400ms');
  });

  it('says so instead of rendering nothing when there is no timing data', () => {
    const open = demoOpen();
    open.requests = new Map([...open.requests].map(([id, r]) => [id, { ...r, startedAt: null }]));
    open.toolCalls = new Map([...open.toolCalls].map(([id, t]) => [id, { ...t, startedAt: null }]));
    renderTime('main', open);
    expect(screen.getByText('No timing data yet')).toBeInTheDocument();
  });

  it('survives malformed timestamps without blanking the chart', () => {
    const open = demoOpen();
    const m1 = open.requests.get('req_m1');
    if (!m1) throw new Error('fixture');
    open.requests = new Map(open.requests).set('req_m1', {
      ...m1,
      startedAt: 'not a time',
      firstBlockAt: null,
    });
    const tool = open.toolCalls.get('tu_m2a');
    if (!tool) throw new Error('fixture');
    open.toolCalls = new Map(open.toolCalls).set('tu_m2a', { ...tool, startedAt: 'garbage' });
    renderTime('main', open);
    const svg = screen.getByRole('img', { name: 'Timeline per agent' });
    expect(Number(svg.getAttribute('width'))).toBeGreaterThan(0);
    for (const rect of svg.querySelectorAll('rect[data-ref]'))
      for (const attr of ['x', 'width']) expect(Number(rect.getAttribute(attr))).not.toBeNaN();
  });

  it('keeps a lane of dense short requests visible at the default zoom', () => {
    renderTime('main', denseOpen());
    const lane = screen
      .getByRole('img', { name: 'Timeline per agent' })
      .querySelector('[data-lane="af00000000000001"]') as SVGGElement;
    const rects = [...lane.querySelectorAll('rect')];
    expect(rects.length).toBeGreaterThan(0);
    expect(rects.length).toBeLessThan(66);
    const x0 = Math.min(...rects.map((r) => Number(r.getAttribute('x'))));
    const x1 = Math.max(
      ...rects.map((r) => Number(r.getAttribute('x')) + Number(r.getAttribute('width'))),
    );
    const drawn = rects.reduce((sum, r) => sum + Number(r.getAttribute('width')), 0);
    expect(drawn).toBeGreaterThan(0.9 * (x1 - x0));
  });

  it('explains a merged block and zooms into it on click', () => {
    renderTime('main', denseOpen());
    const svg = screen.getByRole('img', { name: 'Timeline per agent' });
    const block = svg.querySelector('[data-lane="af00000000000001"] [data-merged]') as Element;
    fireEvent.mouseEnter(block);
    expect(screen.getByRole('tooltip')).toHaveTextContent('66 requests · 0 tools · total 12m48s');
    const before = Number(svg.getAttribute('width'));
    fireEvent.click(block);
    expect(Number(svg.getAttribute('width'))).toBeGreaterThan(before);
  });

  it('zooms to an agent’s active time when its lane is clicked', () => {
    renderTime();
    const svg = screen.getByRole('img', { name: 'Timeline per agent' });
    const before = Number(svg.getAttribute('width'));
    fireEvent.click(screen.getByRole('button', { name: 'Explore transcript format' }));
    expect(Number(svg.getAttribute('width'))).toBeGreaterThan(before);
  });

  it('shows how long each agent was active', () => {
    renderTime();
    const totals = screen.getByRole('list', { name: 'Active time' });
    const items = within(totals)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items[0]).toBe('3m1s');
    expect(items[1]).toBe('1m12s');
  });

  it('only ticks every second while something is live', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const open = demoOpen();
    open.requests = new Map(
      [...open.requests].map(([id, r]) => [
        id,
        r.status === 'in-flight' ? { ...r, status: 'complete' as const, endedAt: r.startedAt } : r,
      ]),
    );
    open.toolCalls = new Map(
      [...open.toolCalls].map(([id, t]) => [
        id,
        t.status === 'running' ? { ...t, status: 'complete' as const, endedAt: t.startedAt } : t,
      ]),
    );
    renderTime('main', open);
    expect(spy.mock.calls.some(([, ms]) => ms === 1000)).toBe(false);
    spy.mockRestore();
  });

  it('draws only the segments in view when zoomed far in', () => {
    renderTime('main', denseOpen());
    const svg = screen.getByRole('img', { name: 'Timeline per agent' });
    const all = () => svg.querySelectorAll('rect[data-kind]').length;
    const atFit = all();
    zoomIn(14);
    const width = Number(svg.getAttribute('width'));
    const left = (svg.parentElement as HTMLElement).scrollLeft;
    const xs = [...svg.querySelectorAll('rect[data-kind]')].map((r) => Number(r.getAttribute('x')));
    expect(width).toBeGreaterThan(20_000);
    expect(atFit).toBeGreaterThan(0);
    expect(xs.length).toBeGreaterThan(0);
    // Fake layout: the view is 1200 px wide; one view of margin either side is allowed.
    for (const x of xs) {
      expect(x).toBeGreaterThan(left - 2 * 1200);
      expect(x).toBeLessThan(left + 3 * 1200);
    }
  });

  it('zooms in and out with the buttons', () => {
    renderTime();
    const svg = screen.getByRole('img', { name: 'Timeline per agent' });
    const width = () => Number(svg.getAttribute('width'));
    const before = width();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(width()).toBeGreaterThan(before);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(width()).toBeLessThan(before);
  });
});
