/** Choosing a working directory for a new session from the ones sessions have used. */

const MAX_SHOWN = 8;

/** Throwaway places tools run in; rarely where someone wants to start real work. */
const TEMPORARY = [
  /^\/(private\/)?tmp\//,
  /^\/(private\/)?var\/folders\//,
  /\/Library\/Application Support\/Claude\/scratch-workspaces\//,
  /\\AppData\\Local\\Temp\\/i,
];

const isTemporary = (dir: string) => TEMPORARY.some((re) => re.test(dir));

/** The last two folders, e.g. "Dev/glassbox"; enough to recognise a project. */
export function shortPath(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return dir;
  return parts.slice(-2).join('/');
}

/**
 * An example folder for the new-session dialog, in the shape of the folders this machine's
 * sessions use (the server's, which on WSL is not the browser's platform): the parent of the
 * most recent one, else a neutral path.
 */
export function dirPlaceholder(dirs: string[]): string {
  const recent = dirs.find((d) => !isTemporary(d)) ?? dirs[0];
  const sep = recent?.includes('\\') && !recent.includes('/') ? '\\' : '/';
  const cut = recent ? recent.replace(/[\\/]+$/, '').lastIndexOf(sep) : -1;
  if (!recent || cut <= 0) return '/path/to/project';
  return `${recent.slice(0, cut + 1)}…`;
}

/** Recent directories to offer (at most 8), with temporary ones set aside, both in given order. */
export function recentDirChoices(dirs: string[]): { shown: string[]; temporary: string[] } {
  return {
    shown: dirs.filter((d) => !isTemporary(d)).slice(0, MAX_SHOWN),
    temporary: dirs.filter(isTemporary),
  };
}
