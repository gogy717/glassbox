/**
 * What a receipt prints of the session's own words, made safe to post: the text well formed (a
 * lone surrogate, U+FFFE, U+FFFF or a control character breaks an SVG), a title's absolute paths
 * cut to their last segment, and the project printed only as a name, never as a home directory.
 */
import type { SessionSummary } from '../../../../src/core/model.js';
import { redact } from '../../../../src/core/redact.js';
import { groupNames } from '../../lib/sessions';

/** Control characters (a terminal's colour codes) and the two noncharacters XML forbids. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are what it removes
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g;
const SURROGATES = /([\ud800-\udbff][\udc00-\udfff])|[\ud800-\udfff]/g;

/** `s` with each lone surrogate as U+FFFD: `String#toWellFormed`, where the browser has it. */
export function wellFormed(s: string): string {
  const native = (s as { toWellFormed?: () => string }).toWellFormed;
  return native ? native.call(s) : s.replace(SURROGATES, (_m, pair?: string) => pair ?? '\ufffd');
}

/** `s` as an SVG can hold it: well formed, the forbidden characters dropped. */
export const clean = (s: string) => wellFormed(s).replace(FORBIDDEN, '');

/** A path segment without spaces; it ends at quotes, brackets and punctuation, CJK's included. */
const SEG = String.raw`[^\s\\/"'\`()<>\[\]{},;:|*?，。；：、（）「」【】《》！？]+`;
/** A Windows segment that ends in a separator: it may hold spaces (C:\Users\John Smith\…). */
const WIN = String.raw`[^\s\\/:*?"<>|\`](?:[^\\/:*?"<>|\`\n]*[^\s\\/:*?"<>|\`])?`;

/**
 * URLs, kept whole (a file:// one is a path), and absolute paths that do not follow a word or a
 * path character (so `src/a.ts`, `and/or` and `./a/b` stay): a drive or WSL mount path, a UNC
 * path, `~user/…`, and `/a/b`, `~/a/b` or `\a\b` of two segments or more.
 */
const PATHS = new RegExp(
  [
    String.raw`(file:\/\/[^\s"'\`<>]*)`,
    String.raw`([A-Za-z][\w+.-]*:\/\/[^\s"'\`<>]*)`,
    String.raw`(^|[^\w./\\~-])(${[
      String.raw`(?:[A-Za-z]:|\/mnt\/[A-Za-z])(?:[\\/]${WIN})*[\\/]${SEG}`,
      String.raw`\\\\${SEG}(?:\\${WIN})*\\${SEG}`,
      String.raw`~[\w.-]+(?:\/${SEG})+`,
      String.raw`~?(?:[\\/]${SEG}){2,}`,
    ].join('|')})`,
  ].join('|'),
  'g',
);

/** A home directory itself, whose last segment is its owner's name. */
const HOME =
  /^(?:(?:\/var)?\/home|\/Users|\/mnt\/[A-Za-z]\/Users|[A-Za-z]:[\\/]Users)[\\/][^\\/]+[\\/]?$/i;

/** A path as printed: its last segment, or "~" for a home directory. */
const shorten = (path: string) =>
  HOME.test(path) ? '~' : (path.split(/[\\/]/).filter(Boolean).at(-1) ?? path);

/** The title as printed: masked, cleaned, its absolute paths cut to their ends. */
export const printedTitle = (title: string) =>
  clean(redact(title)).replace(
    PATHS,
    (m, file?: string, url?: string, before?: string, path?: string) => {
      if (url) return url;
      if (file) return file.length > 'file://'.length ? shorten(file.slice('file://'.length)) : m;
      return `${before ?? ''}${shorten(path ?? '')}`;
    },
  );

/**
 * The project as printed: the working directory's last segment, unless it is a home directory
 * or a drive's root; with no working directory, the agent's project name if it is a plain name
 * (not a path, and not encoded from one: Claude Code's `-home-<user>-…`, Windows' `C--Users-…`).
 */
export function printedProject(cwd: string | null, project: string): string | null {
  if (cwd) {
    if (HOME.test(cwd)) return null;
    const last =
      cwd
        .split(/[\\/]+/)
        .filter(Boolean)
        .at(-1) ?? '';
    return /^[A-Za-z]:$/.test(last) ? null : clean(last) || null;
  }
  if (!project || /[\\/]/.test(project) || project.startsWith('-') || /^[A-Za-z]--/.test(project))
    return null;
  return clean(project) || null;
}

/**
 * The name each session's project reads as on Stats and the weekly receipt, as the session
 * list groups it: its repository's name when the server read one (a repository's worktrees are
 * one project, two repositories of one name read with their parents, `groupNames`), else the
 * directory as `printedProject` prints it.
 */
export function projectNames(sessions: readonly Named[]): (s: Named) => string | null {
  const byRepo = groupNames(sessions.filter((s) => s.repo));
  return (s) => (s.repo ? byRepo(s) : printedProject(s.cwd, s.project));
}

type Named = Pick<SessionSummary, 'cwd' | 'project' | 'repo'>;
