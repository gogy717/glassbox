import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/core/model.js';
import { mcpTool, summarizeInput, type ToolCategory, toolCategory } from './tool-category';

describe('toolCategory', () => {
  // Names as each agent's sessions record them (read from the adapters, their fixtures and the
  // agents' own tool lists).
  describe.each<[string, [string, ToolCategory][]]>([
    [
      'Claude Code',
      [
        ['Read', 'explore'],
        ['Grep', 'explore'],
        ['Glob', 'explore'],
        ['LS', 'explore'],
        ['NotebookRead', 'explore'],
        ['LSP', 'explore'],
        ['Edit', 'edit'],
        ['MultiEdit', 'edit'],
        ['Write', 'edit'],
        ['NotebookEdit', 'edit'],
        ['Bash', 'run'],
        ['BashOutput', 'run'],
        ['KillShell', 'run'],
        ['TaskOutput', 'run'],
        ['TaskStop', 'run'],
        ['Monitor', 'run'],
        ['Agent', 'delegate'],
        ['Task', 'delegate'],
        ['Workflow', 'delegate'],
        ['SendMessage', 'delegate'],
        ['ListAgents', 'delegate'],
        ['AskUserQuestion', 'ask'],
        ['TodoWrite', 'plan'],
        ['TaskCreate', 'plan'],
        ['TaskUpdate', 'plan'],
        ['TaskList', 'plan'],
        ['TaskGet', 'plan'],
        ['EnterPlanMode', 'plan'],
        ['ExitPlanMode', 'plan'],
        ['Skill', 'plan'],
        ['WebFetch', 'web'],
        ['WebSearch', 'web'],
        ['EnterWorktree', 'git'],
        ['ExitWorktree', 'git'],
        ['ListMcpResourcesTool', 'mcp'],
        ['ReadMcpResourceTool', 'mcp'],
        ['ToolSearch', 'other'],
      ],
    ],
    [
      'Codex',
      [
        ['read_file', 'explore'],
        ['list_dir', 'explore'],
        ['grep_files', 'explore'],
        ['view_image', 'explore'],
        ['apply_patch', 'edit'],
        ['shell', 'run'],
        ['local_shell', 'run'],
        ['exec', 'run'],
        ['exec_command', 'run'],
        ['write_stdin', 'run'],
        ['spawn_agent', 'delegate'],
        ['send_input', 'delegate'],
        ['send_message', 'delegate'],
        ['followup_task', 'delegate'],
        ['wait_agent', 'delegate'],
        ['close_agent', 'delegate'],
        ['resume_agent', 'delegate'],
        ['interrupt_agent', 'delegate'],
        ['list_agents', 'delegate'],
        ['request_user_input', 'ask'],
        ['request_user_input_async', 'ask'],
        ['update_plan', 'plan'],
        ['web_search', 'web'],
        ['list_mcp_resources', 'mcp'],
        ['list_mcp_resource_templates', 'mcp'],
        ['read_mcp_resource', 'mcp'],
        ['sleep', 'other'],
      ],
    ],
    [
      'Grok',
      [
        ['read_file', 'explore'],
        ['list_dir', 'explore'],
        ['grep', 'explore'],
        ['search_replace', 'edit'],
        ['hashline_edit', 'edit'],
        ['write_file', 'edit'],
        ['run_terminal_command', 'run'],
        ['get_command_or_subagent_output', 'run'],
        ['kill_command_or_subagent', 'run'],
        ['wait_commands_or_subagents', 'run'],
        ['get_task_output', 'run'],
        ['kill_task', 'run'],
        ['wait_tasks', 'run'],
        ['spawn_subagent', 'delegate'],
        ['send_subagent_message', 'delegate'],
        ['ask_user_question', 'ask'],
        ['todo_write', 'plan'],
        ['enter_plan_mode', 'plan'],
        ['exit_plan_mode', 'plan'],
        ['update_goal', 'plan'],
        ['web_search', 'web'],
        ['web_fetch', 'web'],
        ['search_tool', 'mcp'],
        ['use_tool', 'mcp'],
        // Its Cursor preset.
        ['Shell', 'run'],
        ['AwaitShell', 'run'],
        ['StrReplace', 'edit'],
        ['EditNotebook', 'edit'],
        ['Delete', 'edit'],
        ['AskQuestion', 'ask'],
      ],
    ],
    [
      'oh-my-pi',
      [
        ['read', 'explore'],
        ['grep', 'explore'],
        ['search', 'explore'],
        ['glob', 'explore'],
        ['find', 'explore'],
        ['ast_grep', 'explore'],
        ['lsp', 'explore'],
        ['recall', 'explore'],
        ['edit', 'edit'],
        ['write', 'edit'],
        ['ast_edit', 'edit'],
        ['bash', 'run'],
        ['eval', 'run'],
        ['debug', 'run'],
        ['ssh', 'run'],
        ['task', 'delegate'],
        ['wait', 'delegate'],
        ['vibe_spawn', 'delegate'],
        ['vibe_send', 'delegate'],
        ['vibe_wait', 'delegate'],
        ['vibe_list', 'delegate'],
        ['vibe_kill', 'delegate'],
        ['ask', 'ask'],
        ['todo', 'plan'],
        ['goal', 'plan'],
        ['manage_skill', 'plan'],
        ['web_search', 'web'],
        ['browser', 'web'],
        ['github', 'git'],
        ['computer', 'other'],
      ],
    ],
    [
      'OpenCode',
      [
        ['read', 'explore'],
        ['grep', 'explore'],
        ['glob', 'explore'],
        ['list', 'explore'],
        ['lsp', 'explore'],
        ['edit', 'edit'],
        ['write', 'edit'],
        ['multiedit', 'edit'],
        ['patch', 'edit'],
        ['apply_patch', 'edit'],
        ['bash', 'run'],
        ['task', 'delegate'],
        ['question', 'ask'],
        ['todowrite', 'plan'],
        ['todoread', 'plan'],
        ['skill', 'plan'],
        ['webfetch', 'web'],
        ['websearch', 'web'],
        ['codesearch', 'web'],
        ['invalid', 'other'],
      ],
    ],
  ])('%s', (_agent, table) => {
    it.each(table)('%s → %s', (name, want) => {
      expect(toolCategory(name)).toBe(want);
    });
  });

  it.each([
    ['mcp__claude-in-chrome__navigate', 'web'],
    ['mcp__playwright__browser_click', 'web'],
    ['mcp__github__create_issue', 'mcp'],
    ['mcp__plugin_data_hex__authenticate', 'mcp'],
    // Grok (and older Codex) leave out the `mcp__`.
    ['github__search_repositories', 'mcp'],
    ['chrome-devtools__click', 'web'],
    ['SomethingNew', 'other'],
    ['__proto__', 'other'],
    ['constructor', 'other'],
  ])('%s → %s', (name, want) => {
    expect(toolCategory(name)).toBe(want);
  });

  it('tells a Codex wait on an exec cell from an oh-my-pi wait on agents', () => {
    expect(toolCategory('wait', { cell_id: '3', yield_time_ms: 1000 })).toBe('run');
    expect(toolCategory('wait', { i: 'Wait for probe agent' })).toBe('delegate');
  });

  it('counts an oh-my-pi read of a URL as web work', () => {
    expect(toolCategory('read', { path: 'https://example.com/docs/faq', i: 'Reading' })).toBe(
      'web',
    );
    expect(toolCategory('read', { path: '/repo/README.md' })).toBe('explore');
  });

  it.each([
    ['Bash', { command: 'rg -n x src' }, { command: 'npm test' }],
    ['Shell', { command: 'rg -n x src' }, { command: 'npm test' }],
    [
      'shell',
      { command: ['bash', '-lc', 'rg -n x src'] },
      { command: ['bash', '-lc', 'npm test'] },
    ],
    ['shell', { command: ['rg', '-n', 'x', 'src'] }, { command: ['npm', 'test'] }],
    ['local_shell', { command: ['zsh', '-c', 'rg x'] }, { command: ['zsh', '-c', 'npm test'] }],
    [
      'shell',
      { command: ['powershell.exe', '-NoProfile', '-Command', 'ls'] },
      { command: ['powershell.exe', '-NoProfile', '-Command', 'npm test'] },
    ],
    ['exec_command', { cmd: 'rg -n x src', workdir: '/repo' }, { cmd: 'npm test' }],
    ['run_terminal_command', { command: 'rg -n x src' }, { command: 'npm test' }],
    ['bash', { command: 'rg -n x src', i: 'Searching' }, { command: 'npm test', i: 'Testing' }],
  ])(
    '%s: a read-only command is exploring, whatever the agent calls its shell (%j)',
    (name, look, run) => {
      expect(toolCategory(name, look)).toBe('explore');
      expect(toolCategory(name, run)).toBe('run');
    },
  );

  it.each([
    ['rg -n "sortSessions" src', 'explore'],
    ['cd web && git log --oneline -5 | head -3', 'explore'],
    ['ls -la; cat package.json', 'explore'],
    ['FOO=1 grep -r x .', 'explore'],
    ['git -C web log --oneline', 'explore'],
    ['git --no-pager diff --stat', 'explore'],
    ['gh pr view 12', 'explore'],
    ['npm test', 'run'],
    ['git commit -m "x"', 'git'],
    ['git add -A && git commit -m "x"', 'git'],
    ['cd repo && git push origin ux-tool-icons', 'git'],
    [
      'git -c user.name=a -c user.email=b commit -m "$(cat <<\'EOF\'\nSubject\n\nBody\nEOF\n)"',
      'git',
    ],
    ['git switch -c ux-tool-icons 8302505', 'git'],
    ['gh pr create --fill', 'git'],
    ['npm test && git commit -m "x"', 'run'],
    ['gitk', 'run'],
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
    [
      'TodoWrite',
      {
        todos: [
          { content: 'Read the adapters', status: 'completed', activeForm: 'Reading' },
          { content: 'Write the tests', status: 'in_progress', activeForm: 'Writing' },
          { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
        ],
      },
      'Write the tests',
    ],
    [
      'TodoWrite',
      {
        todos: [
          { content: 'Read', status: 'completed' },
          { content: 'Test', status: 'pending' },
        ],
      },
      'Test',
    ],
    ['TodoWrite', { todos: [{ content: 'Done', status: 'completed' }] }, 'Done'],
    [
      'AskUserQuestion',
      { questions: [{ question: 'Which branch?', header: 'Branch', options: [] }] },
      'Which branch?',
    ],
    [
      'Skill',
      { skill: 'superpowers:test-driven-development' },
      'superpowers:test-driven-development',
    ],
    ['mcp__x__y', { 0: 1, title: 'First string' }, 'First string'],
    // Never JSON: the first plain value, else the field names.
    ['wait_agent', { timeout_ms: 30000 }, 'timeout_ms: 30000'],
    ['Odd', { flags: { a: 1 }, ids: [1, 2] }, 'flags, ids'],
    ['Odd', {}, ''],
    ['Odd', null, ''],
    ['Odd', 'raw text input', 'raw text input'],
  ])('%s %j → %j', (name, input, want) => {
    expect(summarizeInput(tool(name, input))).toBe(want);
  });

  const PATCH = [
    '*** Begin Patch',
    '*** Update File: src/server/store.ts',
    '@@',
    '-a',
    '+b',
    '*** Add File: docs/notes.md',
    '+hi',
    '*** Delete File: old.txt',
    '*** End Patch',
  ].join('\n');

  it.each([
    ['shell', { command: ['bash', '-lc', 'rg -n "x" src'], workdir: '/repo' }, 'rg -n "x" src'],
    ['shell', { command: ['ls', '-la'] }, 'ls -la'],
    ['exec_command', { cmd: 'npm test', workdir: '/repo', yield_time_ms: 1000 }, 'npm test'],
    ['write_stdin', { session_id: 3, chars: '' }, ''],
    ['apply_patch', PATCH, 'store.ts, notes.md, old.txt'],
    ['apply_patch', { input: PATCH }, 'store.ts, notes.md, old.txt'],
    [
      'exec',
      '// @exec: {"yield_time_ms": 10000}\nconst r = await tools.exec_command({ cmd: "ls" });',
      'const r = await tools.exec_command({ cmd: "ls" });',
    ],
    [
      'update_plan',
      {
        explanation: 'Plan',
        plan: [
          { step: 'Read', status: 'completed' },
          { step: 'Test', status: 'in_progress' },
        ],
      },
      'Test',
    ],
    ['web_search', { type: 'search', query: 'codex rollout format' }, 'codex rollout format'],
    [
      'web_search',
      { type: 'open_page', url: 'https://developers.openai.com/codex' },
      'developers.openai.com',
    ],
    [
      'spawn_agent',
      { model: 'gpt-5.5', task_name: 'review_diff', message: 'Look…' },
      'review_diff',
    ],
    ['view_image', { path: '/repo/shots/flow.png' }, 'flow.png'],
    ['request_user_input', { questions: [{ id: 'q', question: 'Ship it?' }] }, 'Ship it?'],
  ])('Codex %s %j → %j', (name, input, want) => {
    expect(summarizeInput(tool(name, input))).toBe(want);
  });

  it.each([
    ['read_file', { target_file: 'src/app.ts' }, 'app.ts'],
    ['list_dir', { path: 'src/adapters' }, 'adapters'],
    ['grep', { pattern: 'toolCategory', path: 'web' }, 'toolCategory'],
    ['run_terminal_command', { command: 'npm run check' }, 'npm run check'],
    ['search_replace', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }, 'a.ts'],
    ['spawn_subagent', { prompt: 'Read…', description: 'Review the diff' }, 'Review the diff'],
    ['web_fetch', { url: 'https://docs.x.ai/grok' }, 'docs.x.ai'],
  ])('Grok %s %j → %j', (name, input, want) => {
    expect(summarizeInput(tool(name, input))).toBe(want);
  });

  it.each([
    ['read', { path: '/repo/src/core/model.ts', i: 'Reading the model' }, 'model.ts'],
    ['read', { path: 'https://example.com/docs/faq', i: 'Reading the FAQ' }, 'example.com'],
    ['glob', { i: 'Finding docs', path: 'docs/**/*.md' }, 'docs/**/*.md'],
    ['bash', { i: 'Listing', command: 'ls -la' }, 'ls -la'],
    [
      'task',
      { context: 'Long shared context…', i: 'Spawn sleep probe', tasks: [] },
      'Spawn sleep probe',
    ],
    ['wait', { i: 'Wait for probe agent' }, 'Wait for probe agent'],
    ['web_search', { i: 'Checking', query: 'oh-my-pi usage cache' }, 'oh-my-pi usage cache'],
  ])('oh-my-pi %s %j → %j', (name, input, want) => {
    expect(summarizeInput(tool(name, input))).toBe(want);
  });

  it.each([
    ['read', { filePath: '/repo/notes/birds.txt' }, 'birds.txt'],
    ['read', { filePath: '/repo/a.ts', offset: 10, limit: 5 }, 'a.ts:10-14'],
    ['edit', { filePath: '/repo/a.ts', oldString: 'a', newString: 'b' }, 'a.ts'],
    ['write', { filePath: '/repo/b.md', content: '…' }, 'b.md'],
    ['grep', { pattern: 'kittiwake', path: '/repo/notes' }, 'kittiwake'],
    ['list', { path: '/repo/src' }, 'src'],
    ['bash', { command: 'sleep 3 && echo slept', description: 'Sleep' }, 'sleep 3 && echo slept'],
    [
      'task',
      { description: 'Find kittiwake', prompt: 'Search…', subagent_type: 'general' },
      'Find kittiwake',
    ],
    ['webfetch', { url: 'https://opencode.ai/docs', format: 'markdown' }, 'opencode.ai'],
    ['websearch', { query: 'opencode tools' }, 'opencode tools'],
    [
      'todowrite',
      { todos: [{ content: 'Port it', status: 'in_progress', priority: 'high' }] },
      'Port it',
    ],
    ['question', { questions: [{ question: 'Which file?', header: 'File' }] }, 'Which file?'],
    ['skill', { name: 'release' }, 'release'],
    ['apply_patch', { patchText: PATCH }, 'store.ts, notes.md, old.txt'],
  ])('OpenCode %s %j → %j', (name, input, want) => {
    expect(summarizeInput(tool(name, input))).toBe(want);
  });
});

describe('mcpTool', () => {
  it.each([
    ['mcp__github__create_issue', { server: 'github', tool: 'create_issue' }],
    ['mcp__claude-in-chrome__navigate', { server: 'claude-in-chrome', tool: 'navigate' }],
    ['mcp__plugin_data_hex__authenticate', { server: 'plugin_data_hex', tool: 'authenticate' }],
    ['github__search_repositories', { server: 'github', tool: 'search_repositories' }],
    ['Read', null],
    ['read_file', null],
    ['mcp__nameless', null],
  ])('%s → %j', (name, want) => {
    expect(mcpTool(name)).toEqual(want);
  });
});
