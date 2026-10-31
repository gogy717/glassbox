/// <reference types="node" />
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoSessions } from '../../../src/core/fixtures/demo.js';
import type { SessionSummary } from '../../../src/core/model.js';
import { I18nContext, makeI18n } from '../i18n';
import { DEMO_NOW } from '../test/demo';
import { moduleCssValue } from '../test/module-css';
import css from './ActivityLine.module.css';
import { SessionRow } from './SessionRow';

const [running] = createDemoSessions(DEMO_NOW) as [SessionSummary];

/** A running session whose main context is 92% of its window: the sign the server sends. */
const full: SessionSummary = {
  ...running,
  trouble: {
    kind: 'context-full',
    params: { pct: 92, tokens: 184_000, window: 200_000 },
    at: { kind: 'request', agentId: 'main', requestId: 'q1' },
    since: DEMO_NOW.toISOString(),
  },
};

function renderRow(session: SessionSummary, locale: 'en' | 'zh', density: 'compact' | 'card') {
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <SessionRow
        session={session}
        selected={false}
        now={DEMO_NOW.getTime()}
        onSelect={vi.fn()}
        density={density}
      />
    </I18nContext.Provider>,
  );
  return screen.getByRole('button');
}

afterEach(cleanup);

describe('SessionRow of a session whose context is nearly full', () => {
  it('says its share on the sidebar’s row and on Home’s card, in English and Chinese', () => {
    for (const density of ['compact', 'card'] as const) {
      expect(renderRow(full, 'en', density)).toHaveTextContent('Context 92%');
      cleanup();
      expect(renderRow(full, 'zh', density)).toHaveTextContent('上下文 92%');
      cleanup();
    }
  });

  it('says it in the warning’s amber, not the red of a session stuck', () => {
    const line = renderRow(full, 'en', 'compact').querySelector('[data-trouble]') as HTMLElement;
    expect(line).toHaveAttribute('data-trouble', 'context-full');
    const sheet = join(import.meta.dirname, 'ActivityLine.module.css');
    expect(moduleCssValue(sheet, css, line, 'color')).toBe('var(--warning)');
  });

  it('says nothing of it once the session no longer runs', () => {
    expect(renderRow({ ...full, live: 'idle' }, 'en', 'compact')).not.toHaveTextContent('Context');
  });
});
