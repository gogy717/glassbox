import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nContext, makeI18n } from '../../../i18n';
import { ArgsView } from './ArgsView';

function renderArgs(input: unknown) {
  return render(
    <I18nContext.Provider value={makeI18n('en')}>
      <ArgsView input={input} label="tool" />
    </I18nContext.Provider>,
  );
}

const pres = (c: HTMLElement) => [...c.querySelectorAll('pre')].map((p) => p.textContent);

describe('ArgsView', () => {
  it('shows each field under its name, strings with their real line breaks', () => {
    const { container } = renderArgs({
      file_path: '/src/app.ts',
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 3;',
      replace_all: false,
    });
    expect(screen.getByText('file_path')).toBeInTheDocument();
    expect(screen.getByText('/src/app.ts')).toBeInTheDocument();
    expect(pres(container)).toEqual(['const a = 1;\nconst b = 2;']);
    expect(screen.getByText('const a = 3;')).toBeInTheDocument();
    expect(screen.getByText('false')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Copy code' })).toHaveLength(1);
  });

  it('gives a long command a copyable block, and other values compact JSON', () => {
    const command = `git log --oneline ${'--decorate '.repeat(10)}`;
    const { container } = renderArgs({ command, timeout: 120000, cmd: ['bash', '-lc', 'ls'] });
    expect(pres(container)).toEqual([command]);
    expect(screen.getByText('120000')).toBeInTheDocument();
    expect(screen.getByText('["bash","-lc","ls"]')).toBeInTheDocument();
  });

  it('pretty-prints a nested value too long for one line', () => {
    const todos = Array.from({ length: 6 }, (_, i) => ({
      content: `task ${i}`,
      status: 'pending',
    }));
    const { container } = renderArgs({ todos });
    expect(pres(container)[0]).toContain('\n  {\n    "content": "task 0"');
  });

  it('reads arguments sent as JSON text, and a bare patch string as a block', () => {
    const { unmount } = renderArgs('{"command":"ls -la"}');
    expect(screen.getByText('command')).toBeInTheDocument();
    expect(screen.getByText('ls -la')).toBeInTheDocument();
    unmount();
    const patch = '*** Begin Patch\n*** Update File: a.ts\n-old\n+new\n*** End Patch';
    expect(pres(renderArgs(patch).container)).toEqual([patch]);
  });

  it('says when the arguments were not recorded', () => {
    renderArgs(undefined);
    expect(screen.getByText('Arguments not recorded')).toBeInTheDocument();
  });
});
