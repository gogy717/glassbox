import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoSnapshot } from '../../../../src/core/fixtures/demo.js';
import { demoRequestDetail } from '../../../../src/core/fixtures/demo-detail.js';
import type { ModelRequest } from '../../../../src/core/model.js';
import { type SessionContextBill, sessionBill } from '../../../../src/shared/context-bill.js';
import type { OpenSession } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import { cjkInMono } from '../../test/cjk';
import { DEMO_NOW, demoOpen } from '../../test/demo';
import { UiContext } from '../../ui';
import { ContextBill } from './ContextBill';
import css from './ContextBill.module.css';

const snapshot = createDemoSnapshot(DEMO_NOW);

/** What the server answers for an agent of the demo (demo-store.ts does the same). */
function demoBill(agentId = 'main'): SessionContextBill {
  const finished = snapshot.requests
    .filter((r) => r.agentId === agentId && r.status !== 'in-flight')
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  return sessionBill(
    agentId,
    finished.map((request) => ({ request, detail: demoRequestDetail(snapshot, request.id) })),
    snapshot.session.cwd,
  );
}

function answer(bill: SessionContextBill) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(bill)));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function renderBill(open: OpenSession = demoOpen(), agentId = 'main', locale: 'en' | 'zh' = 'en') {
  const navigate = vi.fn();
  const setFollow = vi.fn();
  const tree = (o: OpenSession) => (
    <I18nContext.Provider value={makeI18n(locale)}>
      <UiContext.Provider value={{ follow: true, setFollow }}>
        <ContextBill open={o} agentId={agentId} navigate={navigate} />
      </UiContext.Provider>
    </I18nContext.Provider>
  );
  const { rerender } = render(tree(open));
  return { navigate, setFollow, rerender: (o: OpenSession) => rerender(tree(o)) };
}

const section = () => screen.getByRole('region', { name: /What the context held/ });
const items = () => within(section()).getAllByRole('listitem');

describe('ContextBill', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the server for the agent’s bill', async () => {
    const fetch = answer(demoBill());
    renderBill();
    await screen.findByText(/One item held/);
    expect(fetch).toHaveBeenCalledWith(
      `/api/sessions/${encodeURIComponent(snapshot.session.id)}/context?agent=main`,
      expect.anything(),
    );
  });

  it('lists what was carried most: the file, its reads, the requests it rode in', async () => {
    answer(demoBill());
    renderBill();
    await screen.findByText(/One item held/);
    const [first] = items();
    expect(first).toHaveTextContent('Read src/server/store.ts');
    expect(first).toHaveTextContent('carried in 3 requests · read 2 times · mostly cache reads');
    expect(first).toHaveTextContent('≈34.5K');
    expect(items()).toHaveLength(12);
  });

  it('says since when a message rode along, so a reply of thinking alone is told apart', async () => {
    answer(demoBill());
    renderBill();
    await screen.findByText(/One item held/);
    const thinking = items().find((li) => li.textContent?.startsWith('Reply · Thinking'));
    expect(thinking).toHaveTextContent('since Prompt 1 · call #3 · carried in 3 requests');
  });

  it('names a message without text by its kind, and a role by its word', async () => {
    const bill = demoBill();
    const item = bill.items.find((i) => i.kind === 'user') as SessionContextBill['items'][number];
    answer({
      ...bill,
      items: [
        { ...item, key: 'user:a', text: null },
        { ...item, key: 'other:a', kind: 'other', role: 'system', text: 'hook context' },
      ],
    });
    renderBill(demoOpen(), 'main', 'zh');
    await screen.findByText(/^系统提示和/);
    const held = within(screen.getByRole('region', { name: /上下文里有什么/ }));
    const names = held.getAllByRole('listitem').map((li) => li.querySelector(`.${css.name}`));
    expect(names.map((n) => n?.textContent)).toEqual(['用户消息', '系统消息 · hook context']);
  });

  it('says what the system prompt and tools cost every request', async () => {
    answer(demoBill());
    renderBill();
    await screen.findByText(/One item held/);
    expect(within(section()).getByText(/^System prompt and/).parentElement).toHaveTextContent(
      'System prompt and 10 tools≈19.2K every request · 5 requests',
    );
  });

  it('gives one line of advice from the numbers, in the note style', async () => {
    answer(demoBill());
    renderBill();
    expect(await screen.findByText(/One item held/)).toHaveTextContent(
      'One item held 16.2% of all the context: Read src/server/store.ts.',
    );
  });

  it('opens an item’s call, or the first request that carried a message', async () => {
    answer(demoBill());
    const { navigate, setFollow } = renderBill();
    await screen.findByText(/One item held/);
    fireEvent.click(within(items()[0] as HTMLElement).getByRole('button'));
    expect(setFollow).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenLastCalledWith({
      tab: 'flow',
      agentId: 'main',
      turnId: 'turn_m1',
      requestId: 'req_m2',
      card: 'tool:tu_m2c',
    });
    const reply = items().find((li) => li.textContent?.includes('Let me look')) as HTMLElement;
    fireEvent.click(within(reply).getByRole('button'));
    expect(navigate).toHaveBeenLastCalledWith({
      tab: 'flow',
      agentId: 'main',
      turnId: 'turn_m1',
      requestId: 'req_m2',
      card: 'request',
    });
  });

  it('says what each compaction dropped: how much, and the three largest', async () => {
    const bill = demoBill();
    answer({
      ...bill,
      compactions: [
        {
          requestId: 'req_m4',
          beforeId: 'req_m3',
          at: null,
          dropped: 14,
          tokens: 31_400,
          largest: [
            {
              key: 'result:tu_m2a',
              kind: 'result',
              tool: 'Read',
              target: 'store.ts',
              path: '/Users/demo/Dev/glassbox/src/server/store.ts',
              text: null,
              role: 'user',
              callId: 'tu_m2a',
              tokens: 8_650,
            },
          ],
        },
      ],
    });
    const { navigate } = renderBill();
    const drop = await screen.findByText(/dropped/);
    expect(drop.closest('li')).toHaveTextContent(
      'Compaction before Prompt 2 · call #1 dropped 14 parts, ≈31.4K: Read store.ts ≈8.65K',
    );
    fireEvent.click(
      within(drop.closest('li') as HTMLElement).getByRole('button', { name: /Prompt 2/ }),
    );
    expect(navigate).toHaveBeenLastCalledWith({
      tab: 'flow',
      agentId: 'main',
      turnId: 'turn_m2',
      requestId: 'req_m4',
      card: 'request',
    });
  });

  it('says how it was estimated, from how many of the requests', async () => {
    answer(demoBill());
    renderBill();
    expect(
      await screen.findByText(/^Estimated from 5 of 5 finished requests:/),
    ).toBeInTheDocument();
  });

  it('says why there is none, when no request’s context could be read', async () => {
    answer({
      ...demoBill(),
      read: 0,
      unavailable: 'no-messages',
      items: [],
      fixed: null,
      advice: null,
    });
    renderBill();
    expect(
      await screen.findByText(
        'Not available: Claude Code records the system prompt and tools, not the messages of each request.',
      ),
    ).toBeInTheDocument();
  });

  it('asks again when one of the agent’s requests finishes, keeping the last bill meanwhile', async () => {
    const fetch = answer(demoBill());
    const open = demoOpen();
    const { rerender } = renderBill(open);
    await screen.findByText(/One item held/);
    expect(fetch).toHaveBeenCalledTimes(1);
    const live = open.requests.get('req_m6') as ModelRequest;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    rerender({
      ...open,
      requests: new Map(open.requests).set('req_m6', { ...live, status: 'complete' }),
    });
    await act(async () => {});
    expect(screen.getByText(/One item held/)).toBeInTheDocument();
  });

  it('speaks Chinese, its CJK out of the mono face', async () => {
    answer(demoBill());
    renderBill(demoOpen(), 'main', 'zh');
    await screen.findByRole('region', { name: /上下文里有什么/ });
    await screen.findByText(/占了全部上下文/);
    expect(cjkInMono(document.body)).toEqual([]);
  });
});
