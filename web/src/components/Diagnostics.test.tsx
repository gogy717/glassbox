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
    // Three gaps, unparsable lines, one unknown record type; re-sends are not a gap.
    const button = screen.getByRole('button', { name: 'Data diagnostics · 5 gaps' });
    expect(button).toHaveAttribute('data-alert');
    expect(button).toHaveTextContent('5 gaps');
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
          'live-state',
          'other-branches',
          'broken-tree',
          'live-state-unfinished-reply',
        ],
        parseErrors: 0,
        unknownRecordTypes: {},
      },
      'zh',
    );
    fireEvent.click(screen.getByRole('button', { name: '数据诊断 · 11 项缺失' }));
    const items = within(screen.getByRole('dialog')).getAllByRole('listitem');
    expect(items).toHaveLength(11);
    expect(items[3]).toHaveTextContent('最近 30 秒内有写入');
    expect(items[5]).toHaveTextContent('此 agent 的子代理数据未接入');
    expect(items[6]).toHaveTextContent('需要 Node 的 zstd 支持');
    expect(items[7]).toHaveTextContent('总是显示为已关闭');
    expect(items[8]).toHaveTextContent('编辑后重发的提示');
    expect(items[9]).toHaveTextContent('指向缺失的父条目');
    expect(items[10]).toHaveTextContent('未完成的回复在最近一小时内');
    for (const li of items) expect(li.textContent).toMatch(/[一-鿿]/);
  });

  it('stays quiet when there is nothing wrong; filtered re-sends alone are not a problem', () => {
    renderDiag({
      unavailable: [],
      parseErrors: 0,
      unknownRecordTypes: { 'superseded-request': 4 },
    });
    const button = screen.getByRole('button', { name: 'Data diagnostics · No gaps' });
    expect(button).not.toHaveAttribute('data-alert');
    expect(button).toHaveTextContent('No gaps');
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
    fireEvent.click(screen.getByRole('button', { name: /^Data diagnostics/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent('not recorded by this Grok version');
  });

  it('explains what an oh-my-pi session cannot show', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionAgentContext.Provider value="oh-my-pi">
          <Diagnostics
            diagnostics={{
              unavailable: ['live-state', 'other-branches', 'broken-tree'],
              parseErrors: 0,
              unknownRecordTypes: {},
            }}
          />
        </SessionAgentContext.Provider>
      </I18nContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Data diagnostics/ }));
    const items = within(screen.getByRole('dialog')).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('cannot see whether oh-my-pi has the session open'),
      expect.stringContaining('only the branch oh-my-pi would resume'),
      expect.stringContaining('points at a missing parent'),
    ]);
    // Translated, not shown as raw keys.
    expect(within(screen.getByRole('dialog')).queryByText('broken-tree')).toBeNull();
  });

  it('explains how an OpenCode session’s live state is guessed, not with Codex’s rule', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SessionAgentContext.Provider value="opencode">
          <Diagnostics
            diagnostics={{
              unavailable: ['request-detail', 'live-state-unfinished-reply'],
              parseErrors: 0,
              unknownRecordTypes: {},
            }}
          />
        </SessionAgentContext.Provider>
      </I18nContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Data diagnostics/ }));
    const panel = screen.getByRole('dialog');
    expect(panel).toHaveTextContent('“running” means OpenCode is running and a reply');
    expect(panel).not.toHaveTextContent('30 seconds');
    expect(within(panel).queryByText('live-state-unfinished-reply')).toBeNull();
  });
});
