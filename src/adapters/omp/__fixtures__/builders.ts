/** Synthetic oh-my-pi session lines. Nothing here is copied from a real transcript. */

export const SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const CHILD_ID = '22222222-2222-4222-8222-222222222222';
export const CWD = '/work/garden';
export const VERSION = '18.12.6';

/** ISO time `sec` seconds after 2026-01-01T00:00:00Z. */
export function at(sec: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();
}

export function ms(sec: number): number {
  return Date.parse(at(sec));
}

/** The fixed-width first line omp rewrites in place (padded with spaces to 256 bytes). */
export function titleSlot(title: string, sec = 0): string {
  return JSON.stringify({ type: 'title', v: 1, title, updatedAt: at(sec), pad: ' '.repeat(96) });
}

export function header(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: SESSION_ID,
    timestamp: at(0),
    cwd: CWD,
    ...over,
  });
}

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export function usage(u: Usage = {}): Record<string, unknown> {
  const input = u.input ?? 0;
  const output = u.output ?? 0;
  const cacheRead = u.cacheRead ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    ...(u.reasoning !== undefined ? { reasoningTokens: u.reasoning } : {}),
    // Not modelled: glassbox has no cost field.
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  };
}

export interface ToolUse {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface Answer {
  sec: number;
  /** Seconds the call took; it was sent `took` seconds before `sec`. */
  took?: number;
  thinking?: string;
  text?: string;
  tools?: ToolUse[];
  usage?: Usage;
  stopReason?: string;
  provider?: string;
  model?: string;
  error?: { message: string; status?: number };
}

/**
 * Writes entries the way omp appends them: each one is the child of the one before, unless
 * `parentId` says otherwise. Ids are `<prefix>1`, `<prefix>2`, …
 */
export class Transcript {
  readonly lines: string[] = [];
  /** The entry the next one hangs off. */
  leaf: string | null = null;
  private n = 0;

  constructor(private readonly prefix = 'e') {}

  entry(
    type: string,
    sec: number,
    fields: Record<string, unknown> = {},
    opts: { parentId?: string | null; activeLeafId?: string | null; id?: string } = {},
  ): string {
    this.n += 1;
    const id = opts.id ?? `${this.prefix}${this.n}`;
    const parentId = opts.parentId !== undefined ? opts.parentId : this.leaf;
    this.lines.push(
      JSON.stringify({
        type,
        id,
        parentId,
        timestamp: at(sec),
        runtime: { version: VERSION },
        ...(opts.activeLeafId !== undefined ? { activeLeafId: opts.activeLeafId } : {}),
        ...fields,
      }),
    );
    if (opts.activeLeafId === undefined) this.leaf = id;
    return id;
  }

  modelChange(model: string, sec: number): string {
    return this.entry('model_change', sec, { model, role: 'default' });
  }

  thinkingLevel(level: string | null, sec: number): string {
    return this.entry('thinking_level_change', sec, { thinkingLevel: level, configured: level });
  }

  user(text: string, sec: number, over: Record<string, unknown> = {}): string {
    return this.entry('message', sec, {
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
        attribution: 'user',
        timestamp: ms(sec),
        ...over,
      },
    });
  }

  answer(a: Answer, opts: { parentId?: string | null } = {}): string {
    const content: unknown[] = [];
    if (a.thinking !== undefined)
      content.push({ type: 'thinking', thinking: a.thinking, summary: a.thinking !== '' });
    if (a.text) content.push({ type: 'text', text: a.text });
    for (const tool of a.tools ?? [])
      content.push({ type: 'toolCall', id: tool.id, name: tool.name, arguments: tool.args ?? {} });
    const took = a.took ?? 1;
    return this.entry(
      'message',
      a.sec,
      {
        message: {
          role: 'assistant',
          content,
          api: 'openai-responses',
          provider: a.provider ?? 'xai-oauth',
          model: a.model ?? 'grok-4.7',
          usage: usage(a.usage),
          stopReason: a.stopReason ?? (a.tools?.length ? 'toolUse' : 'stop'),
          timestamp: ms(a.sec - took),
          ...(a.error ? { errorMessage: a.error.message, errorStatus: a.error.status } : {}),
          duration: took * 1000,
          ttft: (took * 1000) / 2,
          // Which of the account's credentials served the call: never shown.
          credentialId: 3,
          completedAt: ms(a.sec),
        },
      },
      opts,
    );
  }

  toolStart(toolCallId: string, toolName: string, sec: number): string {
    return this.entry('custom', sec, {
      customType: 'tool_execution_start',
      data: { toolCallId, toolName, startedAt: at(sec) },
    });
  }

  toolResult(
    toolCallId: string,
    toolName: string,
    text: string,
    sec: number,
    over: Record<string, unknown> = {},
  ): string {
    return this.entry('message', sec, {
      message: {
        role: 'toolResult',
        toolCallId,
        toolName,
        content: [{ type: 'text', text }],
        isError: false,
        timestamp: ms(sec),
        ...over,
      },
    });
  }

  injected(customType: string, text: string, sec: number, attribution = 'agent'): string {
    return this.entry('custom_message', sec, {
      customType,
      content: text,
      display: true,
      attribution,
    });
  }

  sideCall(
    purpose: string,
    u: Usage,
    sec: number,
    opts: { parentId?: string | null; activeLeafId?: string | null } = {},
  ): string {
    return this.entry(
      'model_usage',
      sec,
      {
        purpose,
        role: 'judge',
        api: 'openai-responses',
        provider: 'xai-oauth',
        model: 'grok-4.7',
        usage: usage(u),
        stopReason: 'stop',
      },
      opts,
    );
  }
}

/** Two turns: a tool round trip with thinking, then a call the provider refused. Plus noise. */
export function gardenSession(): string[] {
  const t = new Transcript();
  t.thinkingLevel('high', 1);
  t.modelChange('xai-oauth/grok-4.7', 1);
  t.user('Draw a garden plan', 2);
  t.entry('custom', 3, { customType: 'system-prompt-digest', data: 'feedfacecafebeef' });
  t.answer({
    sec: 4,
    took: 2,
    thinking: 'sketch the beds',
    text: "I'll look around.",
    tools: [{ id: 'call-ls|fc_1', name: 'bash', args: { command: 'ls beds' } }],
    usage: { input: 100, cacheRead: 40, output: 10, reasoning: 4 },
  });
  t.toolStart('call-ls|fc_1', 'bash', 4);
  t.entry('credential_pin', 4, { provider: 'xai-oauth', hash: 'pin-hash-sentinel' });
  t.toolResult('call-ls|fc_1', 'bash', 'herb.txt\nmint.txt', 5, { details: { wallTimeMs: 40 } });
  t.answer({
    sec: 7,
    thinking: '',
    text: 'Plant mint along the path.',
    usage: { input: 20, cacheRead: 150, output: 6, reasoning: 2 },
  });
  t.entry('title_change', 8, { title: '🌱 GARDEN: Plan the garden', source: 'auto' });
  t.modelChange('github-copilot/claude-sonnet-5.5', 9);
  t.user('Now water it', 10);
  t.answer({
    sec: 11,
    provider: 'github-copilot',
    model: 'claude-sonnet-5.5',
    stopReason: 'error',
    error: { message: '400 The requested model is not supported.', status: 400 },
  });
  // A record type from a later omp: it still sits in the tree.
  t.entry('snack_time', 12);
  return [titleSlot('🌱 GARDEN: Plan the garden', 8), header(), ...t.lines, '{'];
}
