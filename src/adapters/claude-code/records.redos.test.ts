/**
 * Prompt cleaning runs on untrusted text (pastes, peer messages, sub-agent output) on the
 * server's event loop. It must stay linear: a 1.5 MB adversarial prompt is cleaned within
 * LINEAR_BUDGET_MS on every path (turn prompt, session title, peer and task-notification input). The rewrite is
 * also checked against the regexes it replaced, on random small inputs.
 */
import { describe, expect, it } from 'vitest';
import { userPrompt } from './__fixtures__/builders.js';
import {
  cleanPrompt,
  cleanTurnPrompt,
  parseRecord,
  turnInput,
  type UserRecord,
} from './records.js';

const SIZE = 1_500_000;
/**
 * Linear cleaning takes ~10-60 ms here; the quadratic regexes it replaced took 56,700 ms on one of
 * these inputs. A 1 s budget still catches any super-linear regression by a wide margin while
 * tolerating a loaded machine running the whole suite in parallel (100 ms flaked at 104 ms).
 */
const LINEAR_BUDGET_MS = 1000;
const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length));

const ADVERSARIAL: Record<string, string> = {
  'unclosed noise tags': fill('<system-reminder>'),
  'noise tags with attributes and no >': fill('<system-reminder a="1" '),
  'one unclosed tag before a long body': `<system-reminder>${fill('x<')}`,
  'deep nesting': `${fill('<command-message>').slice(0, SIZE / 2)}x${fill('</command-message>').slice(0, SIZE / 2)}`,
  'unclosed wrappers': fill('<cross-session-message from="a" '),
  'unclosed pasted content': fill('<pasted_content id="p"'),
  'unclosed command tags': fill('<command-name>'),
  'unclosed bash input': fill('<bash-input>'),
  'task notification with unclosed summaries': `<task-notification>${fill('<summary><task-id>')}`,
  'peer opening tags with no >': fill('<cross-session-message '),
  'peer opening tags with no close': fill('<cross-session-message from="x">'),
  'one element with a huge name': `<a${'b'.repeat(SIZE)}>`,
  'closing-tag lookalikes': `<a>${fill('</a</a')}`,
  'attribute quotes': `<cross-session-message${fill(' from="')}>`,
};

function user(text: string): UserRecord {
  const rec = parseRecord(userPrompt({ text }));
  if (rec.kind !== 'user') throw new Error('not a user record');
  return { ...rec, originBody: null, originName: null, originFrom: null };
}

function within(ms: number, run: () => unknown): number {
  const t0 = performance.now();
  run();
  const took = performance.now() - t0;
  expect(took).toBeLessThan(ms);
  return took;
}

describe('prompt cleaning is linear on adversarial input', () => {
  it.each(Object.entries(ADVERSARIAL))('%s', (_name, text) => {
    expect(text.length).toBeGreaterThanOrEqual(SIZE / 2);
    within(LINEAR_BUDGET_MS, () => cleanTurnPrompt(text));
    within(LINEAR_BUDGET_MS, () => cleanPrompt(text));
    const rec = user(text);
    // Discovery's title path and the parser's turn path.
    within(LINEAR_BUDGET_MS, () => cleanPrompt(turnInput(rec, 'peer').prompt));
    within(LINEAR_BUDGET_MS, () => cleanTurnPrompt(turnInput(rec, 'task-notification').prompt));
  });

  it('a cleaned prompt is capped; the raw text stays in the request detail', () => {
    expect(cleanTurnPrompt(`${'y'.repeat(200_000)}`).length).toBe(64 * 1024);
    // A cut never leaves half of a surrogate pair.
    const cut = cleanTurnPrompt(`${'y'.repeat(64 * 1024 - 1)}😀`);
    expect(cut.length).toBe(64 * 1024 - 1);
  });
});

// ── The regexes this replaced, kept as the reference for behaviour ──────────────────────
const LEGACY_NOISE =
  /<(local-command-stdout|local-command-stderr|local-command-caveat|command-message|system-reminder|bash-stdout|bash-stderr|fork-boilerplate|artifact-view-context)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
const LEGACY_WRAPPERS = /<\/?(cross-session-message|pasted_content)(\s[^>]*)?>/g;
const LEGACY_SINGLE = /^<([A-Za-z][\w-]*)(\s[^>]*)?(\/>|>[\s\S]*<\/\1>)$/;
function legacyCleanTurnPrompt(text: string): string {
  const tag = (name: string) =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
  const command = tag('command-name');
  if (command) return `${command} ${tag('command-args') ?? ''}`.trim();
  const bash = tag('bash-input');
  if (bash !== undefined) return `!${bash}`;
  const summary = text.includes('<task-notification>') ? tag('summary') : undefined;
  if (summary) return summary;
  const out = text.replace(LEGACY_NOISE, '').replace(LEGACY_WRAPPERS, '').trim();
  const single = LEGACY_SINGLE.exec(out);
  if (single) return `[${single[1]}]`;
  if (out) return out;
  const first = /^\s*<([A-Za-z][\w-]*)/.exec(text)?.[1];
  return first ? `[${first}]` : '';
}
function legacyTurnInput(text: string, origin: 'peer' | 'task-notification') {
  const tagText = (name: string) =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() || null;
  if (origin === 'peer') {
    const m = /<cross-session-message([^>]*)>([\s\S]*?)<\/cross-session-message>/.exec(text);
    const attr = (name: string) =>
      m ? (new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(m[1] ?? '')?.[1] ?? null) : null;
    return { prompt: m?.[2]?.trim() ?? text, sender: attr('from-name') ?? attr('from') };
  }
  return { prompt: tagText('summary') ?? text, sender: tagText('task-id') };
}

const TOKENS = [
  '<system-reminder>',
  '</system-reminder>',
  '<system-reminder x="1">',
  '<system-reminder\n>',
  '<command-message>',
  '</command-message>',
  '<command-messages>',
  '<bash-stdout>',
  '</bash-stdout>',
  '<cross-session-message from="a" from-name="b">',
  '<cross-session-message>',
  '</cross-session-message>',
  '<cross-session-message ',
  '<pasted_content id="p">',
  '</pasted_content>',
  '</pasted_content id="p">',
  '<command-name>',
  '</command-name>',
  '<command-args>',
  '</command-args>',
  '<bash-input>',
  '</bash-input>',
  '<task-notification>',
  '<summary>',
  '</summary>',
  '<task-id>',
  '</task-id>',
  '<a>',
  '</a>',
  '<a/>',
  '<a x/>',
  '<a x="1">',
  '<ab>',
  '</ab>',
  '<a-b_1 >',
  '</a-b_1>',
  '<',
  '>',
  '/',
  '"',
  ' ',
  '\n',
  '\t',
  'x',
  'y z',
  ' from="q"',
  '😀',
];

function* randomInputs(count: number): Generator<string> {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    for (let k = rand(14); k >= 0; k--) parts.push(TOKENS[rand(TOKENS.length)] ?? '');
    yield parts.join('');
  }
}

describe('the linear rewrite behaves like the regexes it replaced', () => {
  it('on 20,000 random tag soups', () => {
    for (const text of randomInputs(20_000)) {
      expect(cleanTurnPrompt(text), text).toBe(legacyCleanTurnPrompt(text));
      const rec = user(text);
      for (const origin of ['peer', 'task-notification'] as const)
        expect(turnInput(rec, origin), `${origin}: ${text}`).toEqual(legacyTurnInput(text, origin));
    }
  });
});
