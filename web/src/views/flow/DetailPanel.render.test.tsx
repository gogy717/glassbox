import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequest, RequestDetail, ToolCall } from '../../../../src/core/model.js';
import { I18nContext, makeI18n } from '../../i18n';
import { demoOpen } from '../../test/demo';
import { DetailPanel } from './DetailPanel';

// Count renders of the JSON tree: an open panel must not redo it for unrelated store events.
const renders = vi.hoisted(() => ({ n: 0 }));
vi.mock('react-json-view-lite', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-json-view-lite')>();
  return {
    ...real,
    JsonView: (props: Parameters<typeof real.JsonView>[0]) => {
      renders.n++;
      return real.JsonView(props);
    },
  };
});

const open = demoOpen();
const req = open.requests.get('req_m1') as ModelRequest;
const tools = req.toolCallIds.map((id) => open.toolCalls.get(id) as ToolCall);
const detail: RequestDetail = {
  requestId: 'req_m1',
  completeness: 'full',
  notes: [],
  params: { model: 'claude-opus-5-5' },
  system: [{ type: 'text', text: 'You are Claude Code…' }],
  tools: [{ name: 'Bash' }],
  messages: [{ role: 'user', content: 'hi' }],
};

// One i18n value, as in the app (App memoises it per locale).
const en = makeI18n('en');
const tree = (node: ReactNode) => <I18nContext.Provider value={en}>{node}</I18nContext.Provider>;

describe('DetailPanel re-rendering', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not rebuild its JSON trees when the parent re-renders with the same data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(detail))),
    );
    const onClose = () => {};
    const panel = (
      <DetailPanel sessionId={open.id} req={req} tools={tools} card="request" onClose={onClose} />
    );
    const { rerender } = render(tree(panel));
    await screen.findByText('Fully reconstructed');
    const settled = renders.n;
    rerender(
      tree(
        <DetailPanel
          sessionId={open.id}
          req={req}
          tools={[...tools]}
          card="request"
          onClose={() => {}}
        />,
      ),
    );
    rerender(
      tree(
        <DetailPanel
          sessionId={open.id}
          req={req}
          tools={[...tools]}
          card="request"
          onClose={() => {}}
        />,
      ),
    );
    expect(renders.n).toBe(settled);
  });

  it('does not rebuild the usage tree of a response for unrelated re-renders', () => {
    const before = renders.n;
    const { rerender } = render(
      tree(
        <DetailPanel
          sessionId={open.id}
          req={req}
          tools={tools}
          card="response"
          onClose={() => {}}
        />,
      ),
    );
    const settled = renders.n;
    expect(settled).toBeGreaterThan(before);
    rerender(
      tree(
        <DetailPanel
          sessionId={open.id}
          req={req}
          tools={[...tools]}
          card="response"
          onClose={() => {}}
        />,
      ),
    );
    expect(renders.n).toBe(settled);
  });
});
