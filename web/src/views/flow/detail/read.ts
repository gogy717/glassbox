/**
 * Turns what an adapter put into `RequestDetail` (system prompt, messages, tools, params) into a
 * shape the readable view can show. Pure and cheap: nothing here walks a string's content, so a
 * request with thousands of messages and megabytes of text is read in one pass over its items.
 *
 * Formats: Anthropic Messages (Claude Code), Grok's `{ role, content, toolCalls }` /
 * `{ role: 'tool', toolCallId }`, OpenAI chat (`tool_calls`) and Responses items
 * (`function_call`, `function_call_output`, `reasoning`), plain strings and string lists (Codex,
 * oh-my-pi). A section that is none of these reads as null, and the view shows its JSON instead.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export type Block =
  | { kind: 'text'; text: string }
  /** `text` null: not recorded (the agent keeps none, or the provider withheld it). */
  | { kind: 'thinking'; text: string | null }
  | { kind: 'tool-use'; name: string; id: string | null; input: unknown }
  /** `content` null: the result is not part of the record (only its id is). */
  | { kind: 'tool-result'; toolUseId: string | null; content: Block[] | null; isError: boolean }
  | { kind: 'media'; what: 'image' | 'document'; mediaType: string | null; bytes: number | null }
  /** A tool made available mid-conversation, or a reference to one. */
  | { kind: 'tool-ref'; name: string; added: boolean }
  /** Anything else, shown as JSON. */
  | { kind: 'raw'; type: string; value: unknown };

export interface Message {
  /** As recorded: 'user', 'assistant', 'system', 'tool', … */
  role: string;
  time: string | null;
  blocks: Block[];
}

/**
 * Messages the agent could not reconstruct, standing in their place. Claude Code writes
 * `{ unresolved: <hash> }` for one message and `{ unresolved: 'base:<id>', messages: <n> }` for
 * the n earlier messages of a request it does not have.
 */
export interface Gap {
  gap: number;
}

export type Entry = Message | Gap;

export const isGap = (e: Entry): e is Gap => 'gap' in e;

/** How many conversation positions an entry takes. */
export const span = (e: Entry): number => (isGap(e) ? e.gap : 1);

/** Bytes behind a base64 string, without decoding it. */
export function base64Bytes(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad);
}

function media(b: Obj, what: 'image' | 'document'): Block {
  const source = isObj(b.source) ? b.source : {};
  const data = str(source.data);
  return {
    kind: 'media',
    what,
    mediaType: str(source.media_type) ?? str(b.media_type) ?? null,
    bytes: data !== null && source.type === 'base64' ? base64Bytes(data) : null,
  };
}

/** Function arguments arrive as JSON text in OpenAI formats. */
function args(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function resultContent(v: unknown): Block[] | null {
  if (v === undefined) return null;
  if (typeof v === 'string') return [{ kind: 'text', text: v }];
  if (Array.isArray(v)) return v.map(readBlock);
  return [readBlock(v)];
}

/** One content block. Never throws; what it does not know becomes `raw`. */
export function readBlock(b: unknown): Block {
  if (typeof b === 'string') return { kind: 'text', text: b };
  if (!isObj(b)) return { kind: 'raw', type: typeof b, value: b };
  const type = str(b.type) ?? '';
  switch (type) {
    case 'text':
    case 'input_text':
    case 'output_text':
      if (typeof b.text === 'string') return { kind: 'text', text: b.text };
      break;
    case 'thinking':
      // Claude Code keeps thinking blocks with their signature but empty text.
      return { kind: 'thinking', text: str(b.thinking) || str(b.text) || null };
    case 'redacted_thinking':
      return { kind: 'thinking', text: null };
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
      return { kind: 'tool-use', name: str(b.name) ?? '?', id: str(b.id), input: b.input };
    case 'image':
      return media(b, 'image');
    case 'document':
      return media(b, 'document');
    case 'tool_addition': {
      const tool = isObj(b.tool) ? b.tool : {};
      const def = isObj(tool.definition) ? tool.definition : tool;
      return { kind: 'tool-ref', name: str(def.name) ?? '?', added: true };
    }
    case 'tool_reference':
      return { kind: 'tool-ref', name: str(b.tool_name) ?? str(b.name) ?? '?', added: false };
  }
  if (type === 'tool_result' || type.endsWith('_tool_result')) {
    return {
      kind: 'tool-result',
      toolUseId: str(b.tool_use_id),
      content: resultContent(b.content),
      isError: b.is_error === true,
    };
  }
  return { kind: 'raw', type: type || 'object', value: b };
}

const timeOf = (m: Obj) => str(m.timestamp) ?? str(m.time) ?? str(m.created_at) ?? null;

/** An OpenAI Responses item, or null when `item` is not one. */
function responsesItem(item: Obj): Message | null {
  switch (item.type) {
    case 'function_call':
    case 'custom_tool_call':
      return {
        role: 'assistant',
        time: null,
        blocks: [
          {
            kind: 'tool-use',
            name: str(item.name) ?? '?',
            id: str(item.call_id),
            input: args(item.arguments ?? item.input),
          },
        ],
      };
    case 'function_call_output':
    case 'custom_tool_call_output':
      return {
        role: 'tool',
        time: null,
        blocks: [
          {
            kind: 'tool-result',
            toolUseId: str(item.call_id),
            content: resultContent(item.output),
            isError: false,
          },
        ],
      };
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const text = summary.map((s) => (isObj(s) ? str(s.text) : null)).filter(Boolean);
      return {
        role: 'assistant',
        time: null,
        blocks: [{ kind: 'thinking', text: text.length ? text.join('\n\n') : null }],
      };
    }
  }
  return null;
}

/** One message in any known format; anything else is a message of one raw block. */
export function readMessage(m: unknown): Entry {
  if (!isObj(m)) return { role: '?', time: null, blocks: [readBlock(m)] };
  if (typeof m.unresolved === 'string' && m.role === undefined) {
    const n = m.messages;
    return { gap: typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 1 };
  }
  const fromItem = responsesItem(m);
  if (fromItem) return fromItem;
  const role = str(m.role);
  if (role === null) return { role: '?', time: null, blocks: [readBlock(m)] };
  const blocks: Block[] = [];
  const content = m.content;
  if (typeof content === 'string') {
    if (content !== '') blocks.push({ kind: 'text', text: content });
  } else if (Array.isArray(content)) {
    blocks.push(...content.map(readBlock));
  } else if (content != null) {
    blocks.push(readBlock(content));
  }
  // Grok: the calls an answer made, by id and name only.
  if (Array.isArray(m.toolCalls)) {
    for (const call of m.toolCalls) {
      const c = isObj(call) ? call : {};
      blocks.push({ kind: 'tool-use', name: str(c.name) ?? '?', id: str(c.id), input: undefined });
    }
  }
  // OpenAI chat.
  if (Array.isArray(m.tool_calls)) {
    for (const call of m.tool_calls) {
      const c = isObj(call) ? call : {};
      const fn = isObj(c.function) ? c.function : {};
      blocks.push({
        kind: 'tool-use',
        name: str(fn.name) ?? '?',
        id: str(c.id),
        input: args(fn.arguments),
      });
    }
  }
  // A tool message: OpenAI chat carries the result as content, Grok only the call's id.
  const callId = str(m.toolCallId) ?? str(m.tool_call_id);
  if (role === 'tool' && callId !== null && !blocks.some((b) => b.kind === 'tool-result')) {
    const content = blocks.length ? blocks.splice(0) : null;
    blocks.push({ kind: 'tool-result', toolUseId: callId, content, isError: false });
  }
  return { role, time: timeOf(m), blocks };
}

/** The messages, or null when the section is not a list (shown as JSON). */
export function readMessages(v: unknown): Entry[] | null {
  return Array.isArray(v) ? v.map(readMessage) : null;
}

/**
 * The role a message is shown under: Anthropic sends tool results as user messages, but a user
 * message that holds nothing else is the tool speaking.
 */
export function shownRole(m: Message): string {
  return m.role === 'user' && m.blocks.length > 0 && m.blocks.every((b) => b.kind === 'tool-result')
    ? 'tool'
    : m.role;
}

/** The system prompt's text blocks, or null when it is not text (shown as JSON). */
export function readSystem(v: unknown): string[] | null {
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const b of v) {
    if (typeof b === 'string') out.push(b);
    else if (isObj(b) && typeof b.text === 'string') out.push(b.text);
    else return null;
  }
  return out;
}

export interface ToolDef {
  name: string;
  description: string | null;
  /** The input schema; null when the definition has none (a server tool, a bare name). */
  schema: unknown;
  /** A server tool's own type, e.g. "web_search_20250305". */
  type: string | null;
}

/** Tool definitions, or null when the section is not a list (shown as JSON). */
export function readTools(v: unknown): ToolDef[] | null {
  if (!Array.isArray(v)) return null;
  const out: ToolDef[] = [];
  for (const t of v) {
    if (typeof t === 'string') {
      out.push({ name: t, description: null, schema: null, type: null });
      continue;
    }
    // Anything that is not a named tool: the list is shown as JSON instead.
    if (!isObj(t)) return null;
    const fn = isObj(t.function) ? t.function : isObj(t.definition) ? t.definition : {};
    const type = str(t.type);
    const name = str(t.name) ?? str(fn.name) ?? type;
    if (name === null) return null;
    out.push({
      name,
      description: str(t.description) ?? str(fn.description),
      schema: t.input_schema ?? t.inputSchema ?? t.parameters ?? fn.parameters ?? null,
      type: type && type !== 'function' && type !== 'custom' ? type : null,
    });
  }
  return out;
}

/** Parameters as key/value pairs, or null when they are not an object (shown as JSON). */
export function readParams(v: unknown): [string, unknown][] | null {
  if (v == null) return [];
  return isObj(v) ? Object.entries(v) : null;
}

export interface Segment {
  kind: 'prose' | 'code';
  text: string;
  /** The info string after a code fence, e.g. "ts". */
  lang: string | null;
}

/** An opening fence: three or more backticks or tildes, then an info string (its first word). */
const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A closing fence: the same character, at least as many, nothing after. */
const CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * Markdown code fences cut out of text, so code reads as code. As in CommonMark, a backtick
 * fence's info string has no backticks ("```js```" is text) and a closing fence is at least as
 * long as its opening. A fence that never closes is text, not the rest of the message as code.
 * One pass over the lines; text without fences is one prose segment.
 */
export function splitFences(text: string): Segment[] {
  if (!text.includes('```') && !text.includes('~~~')) return [{ kind: 'prose', text, lang: null }];
  const out: Segment[] = [];
  let prose: string[] = [];
  let code: string[] = [];
  let fence: { marks: string; line: string; lang: string | null } | null = null;
  const pushProse = () => {
    if (prose.some((l) => l.trim() !== '')) {
      const last = out.at(-1);
      // Prose next to prose (an unclosed fence's lines) is one segment.
      if (last?.kind === 'prose') last.text += `\n${prose.join('\n')}`;
      else out.push({ kind: 'prose', text: prose.join('\n'), lang: null });
    }
    prose = [];
  };
  for (const line of text.split('\n')) {
    if (fence === null) {
      const m = OPEN.exec(line);
      const marks = m?.[1] ?? '';
      const info = (m?.[2] ?? '').trim();
      if (m && !(marks.startsWith('`') && info.includes('`'))) {
        pushProse();
        fence = { marks, line, lang: info.split(/\s+/)[0] || null };
      } else {
        prose.push(line);
      }
      continue;
    }
    const close = CLOSE.exec(line);
    const marks = close?.[1] ?? '';
    if (close && marks[0] === fence.marks[0] && marks.length >= fence.marks.length) {
      out.push({ kind: 'code', text: code.join('\n'), lang: fence.lang });
      fence = null;
      code = [];
    } else {
      code.push(line);
    }
  }
  if (fence !== null) prose = [fence.line, ...code, ...prose];
  pushProse();
  return out;
}

/** A message as plain text, for its copy button. */
export function messageText(m: Message): string {
  return m.blocks.map(blockText).join('\n\n');
}

function blockText(b: Block): string {
  switch (b.kind) {
    case 'text':
      return b.text;
    case 'thinking':
      return b.text ?? '';
    case 'tool-use':
      return b.input === undefined ? b.name : `${b.name} ${JSON.stringify(b.input, null, 2)}`;
    case 'tool-result':
      return (b.content ?? []).map(blockText).join('\n');
    case 'media':
      return `[${b.what}${b.mediaType ? ` ${b.mediaType}` : ''}]`;
    case 'tool-ref':
      return b.name;
    case 'raw':
      return JSON.stringify(b.value, null, 2);
  }
}
