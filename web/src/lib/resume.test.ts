import { describe, expect, it } from 'vitest';
import { resumeCommand, shellQuote } from './resume';

const session = (agent: string, nativeId: string, cwd: string | null = '/w/garden') => ({
  agent,
  nativeId,
  cwd,
});

describe('resumeCommand', () => {
  it('says each CLI’s own command, run from the session’s directory', () => {
    expect(resumeCommand(session('claude-code', '4b1e-77'))).toBe(
      'cd /w/garden && claude --resume 4b1e-77',
    );
    expect(resumeCommand(session('codex', '0199a2'))).toBe('cd /w/garden && codex resume 0199a2');
    expect(resumeCommand(session('grok', 'g-12'))).toBe('cd /w/garden && grok --resume g-12');
    expect(resumeCommand(session('opencode', 'ses_9f'))).toBe('cd /w/garden && opencode -s ses_9f');
  });

  it('knows none for a CLI it cannot vouch for', () => {
    expect(resumeCommand(session('oh-my-pi', 'p-1'))).toBeNull();
    expect(resumeCommand(session('aider', 'a-1'))).toBeNull();
  });

  it('runs it where it is without a directory', () => {
    expect(resumeCommand(session('claude-code', '4b1e-77', null))).toBe('claude --resume 4b1e-77');
  });

  it('quotes a directory or an id the shell would split or expand', () => {
    expect(resumeCommand(session('claude-code', 'x', "/w/Bob's notes $HOME"))).toBe(
      `cd '/w/Bob'\\''s notes $HOME' && claude --resume x`,
    );
    expect(resumeCommand(session('grok', 'fix login; rm', '/w/a'))).toBe(
      `cd /w/a && grok --resume 'fix login; rm'`,
    );
  });
});

describe('shellQuote', () => {
  it('leaves a plain word as it is and quotes anything else whole', () => {
    expect(shellQuote('/w/garden-2/src_x.y@v1:2,3+=%')).toBe('/w/garden-2/src_x.y@v1:2,3+=%');
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('~/w')).toBe("'~/w'");
    expect(shellQuote('a"b`c')).toBe(`'a"b\`c'`);
  });
});
