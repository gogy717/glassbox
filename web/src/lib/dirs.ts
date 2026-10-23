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

/** Recent directories to offer (at most 8), with temporary ones set aside, both in given order. */
export function recentDirChoices(dirs: string[]): { shown: string[]; temporary: string[] } {
  return {
    shown: dirs.filter((d) => !isTemporary(d)).slice(0, MAX_SHOWN),
    temporary: dirs.filter(isTemporary),
  };
}
