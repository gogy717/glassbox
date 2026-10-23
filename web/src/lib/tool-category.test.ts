import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/core/model.js';
import { summarizeInput, toolCategory } from './tool-category';

describe('toolCategory', () => {
  it.each([
    ['Read', 'explore'],
    ['Grep', 'explore'],
    ['Glob', 'explore'],
    ['LS', 'explore'],
    ['NotebookRead', 'explore'],
    ['Edit', 'edit'],
    ['MultiEdit', 'edit'],
    ['Write', 'edit'],
    ['NotebookEdit', 'edit'],
    ['Bash', 'run'],
    ['BashOutput', 'run'],
    ['KillShell', 'run'],
    ['Agent', 'delegate'],
    ['Task', 'delegate'],
    ['Workflow', 'delegate'],
    ['SendMessage', 'delegate'],
    ['AskUserQuestion', 'ask'],
    ['TodoWrite', 'plan'],
    ['TaskCreate', 'plan'],
    ['TaskUpdate', 'plan'],
    ['EnterPlanMode', 'plan'],
    ['ExitPlanMode', 'plan'],
    ['WebFetch', 'web'],
    ['WebSearch', 'web'],
    ['Skill', 'plan'],
    ['mcp__claude-in-chrome__navigate', 'web'],
    ['mcp__playwright__browser_click', 'web'],
    ['mcp__github__create_issue', 'other'],
    ['SomethingNew', 'other'],
  ])('%s → %s', (name, want) => {
    expect(toolCategory(name)).toBe(want);
  });

  it.each([
    ['rg -n "sortSessions" src', 'explore'],
    ['cd web && git log --oneline -5 | head -3', 'explore'],
    ['ls -la; cat package.json', 'explore'],
    ['FOO=1 grep -r x .', 'explore'],
    ['npm test', 'run'],
    ['git commit -m "x"', 'run'],
    ["sed -i '' s/a/b/ f", 'run'],
    ['rg x > out.txt', 'run'],
    ['python3 -I survey.py', 'run'],
    ['find . -name "*.tmp" -delete', 'run'],
    ['find . -name x -exec rm {} \\;', 'run'],
    ['rg x &> out.txt', 'run'],
    ['ls >> files.txt', 'run'],
    ['cat $(git ls-files)', 'run'],
    ['cat `which node`', 'run'],
    ['git log | tee log.txt', 'run'],
    ['sed -i.bak s/a/b/ f', 'run'],
    ['rg x 2>/dev/null', 'explore'],
    ['rg x 2>&1 | head', 'explore'],
    ['find . -name "*.ts"', 'explore'],
  ])('Bash %j → %s', (command, want) => {
    expect(toolCategory('Bash', { command })).toBe(want);
  });
});

const tool = (name: string, input: unknown): ToolCall => ({
  id: 't',
  agentId: 'main',
  requestId: 'r',
  name,
  input,
  status: 'complete',
  startedAt: null,
  endedAt: null,
  durationMs: null,
  resultPreview: null,
  hasFullResult: false,
  spawned: null,
});

describe('summarizeInput', () => {
  it.each([
    [
      'Bash',
      { command: 'rg -n "sortSessions" src', description: 'Find' },
      'rg -n "sortSessions" src',
    ],
    ['Bash', { command: `echo ${'x'.repeat(100)}` }, `echo ${'x'.repeat(75)}…`],
    ['Bash', { command: 'a\n  && b' }, 'a && b'],
    ['Read', { file_path: '/repo/src/server/store.ts' }, 'store.ts'],
    ['Read', { file_path: '/repo/a.ts', offset: 10, limit: 50 }, 'a.ts:10-59'],
    [
      'Edit',
      { file_path: '/repo/src/server/store.ts', old_string: 'a', new_string: 'b' },
      'store.ts',
    ],
    ['Write', { file_path: 'C:\\repo\\notes.md', content: '…' }, 'notes.md'],
    ['Grep', { pattern: 'type: "assistant"', path: 'src' }, 'type: "assistant"'],
    ['Glob', { pattern: '**/*.tsx' }, '**/*.tsx'],
    ['WebFetch', { url: 'https://example.com/docs?a=1' }, 'example.com'],
    ['WebSearch', { query: 'claude code transcript' }, 'claude code transcript'],
    [
      'Agent',
      { description: 'Explore transcript format', prompt: 'Map…' },
      'Explore transcript format',
    ],
    ['Workflow', { script: "export const meta = { name: 'cc-recon', … }" }, 'cc-recon'],
    ['Workflow', { scriptPath: '/w/.claude/workflows/review-changes.js' }, 'review-changes'],
    ['mcp__x__y', { 0: 1, title: 'First string' }, 'First string'],
    ['Odd', null, ''],
    ['Odd', 'raw text input', 'raw text input'],
  ])('%s %j → %j', (name, input, want) => {
    expect(summarizeInput(tool(name, input))).toBe(want);
  });
});
