import { spawn } from 'node:child_process';

export function browserCommand(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  // `start` treats its first quoted argument as the window title.
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/** Best effort: a missing opener (e.g. a headless box) only costs a log line. */
export function openBrowser(url: string, log: (msg: string) => void): void {
  const { cmd, args } = browserCommand(process.platform, url);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => log(`could not open a browser (${err.message}); open ${url}`));
    child.unref();
  } catch (err) {
    log(`could not open a browser (${err instanceof Error ? err.message : err}); open ${url}`);
  }
}
