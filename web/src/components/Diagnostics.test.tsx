import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Diagnostics as Diag } from '../../../src/core/model.js';
import { SessionAgentContext } from '../data/session-agent';
import { I18nContext, makeI18n } from '../i18n';
import { Diagnostics } from './Diagnostics';

const renderDiag = (d: Diag, locale: 'en' | 'zh' = 'en') =>
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <Diagnostics diagnostics={d} />
    </I18nContext.Provider>,
  );

describe('Diagnostics', () => {
  it('explains what this session lacks, parse errors and unknown records', () => {
    renderDiag({
      unavailable: ['request-detail', 'compaction-markers', 'mystery-key'],
      parseErrors: 2,
      unknownRecordTypes: { 'superseded-request': 3, 'foo-bar': 1 },
    });
    const button = screen.getByRole('button', { name: 'Data diagnostics' });
    expect(button).toHaveAttribute('data-alert');
    fireEvent.click(button);
    const panel = screen.getByRole('dialog', { name: 'Data diagnostics' });
    expect(panel).toHaveTextContent('Request contents (system, tools, messages)');
    expect(panel).toHaveTextContent('Compaction points are inferred');
    expect(within(panel).getByText('mystery-key')).toBeInTheDocument();
    expect(panel).toHaveTextContent('Unparsable lines: 2');
    expect(panel).toHaveTextContent('Silently re-sent requests filtered out: 3');
    expect(within(panel).getByText('foo-bar')).toBeInTheDocument();
  });

  it('describes every known gap in Chinese', () => {
    renderDiag(
      {
        unavailable: [
          'request-detail',
          'in-flight',
          'per-request-usage',
          'live-state-heuristic',
          'compaction-markers',
          'subagents',
          'archived-sessions',
        ],
        parseErrors: 0,
        unknownRecordTypes: {},
      },
      'zh',
    );
    fireEvent.click(screen.getByRole('button', { name: '数据诊断' }));
    const items = within(screen.getByRole('dialog')).getAllByRole('listitem');
    expect(items).toHaveLength(7);
    expect(items[3]).toHaveTextContent('最近 30 秒内有写入');
    expect(items[5]).toHaveTextContent('此 agent 的子代理数据未接入');
    expect(items[6]).toHaveTextContent('需要 Node 的 zstd 支持');
    for (const li of items) expect(li.textContent).toMatch(/[一-鿿]/);
  });

  it('stays quiet when there is nothing wrong; filtered re-sends alone are not a problem', () => {
    renderDiag({
      unavailable: [],
      parseErrors: 0,
      unknownRecordTypes: { 'superseded-request': 4 },
    });
    const button = screen.getByRole('button', { name: 'Data diagnostics' });
    expect(button).not.toHaveAttribute('data-alert');
    fireEvent.click(button);
    const panel = screen.getByRole('dialog', { name: 'Data diagnostics' });
    expect(panel).toHaveTextContent('No problems found');
    expect(panel).toHaveTextContent('Silently re-sent requests filtered out: 4');
  });

  it('names the session’s own agent', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionAgentContext.Provider value="grok">
          <Diagnostics
            diagnostics={{
              unavailable: ['request-detail'],
              parseErrors: 0,
              unknownRecordTypes: {},
            }}
          />
        </SessionAgentContext.Provider>
      </I18nContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Data diagnostics' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('not recorded by this Grok version');
  });
});
