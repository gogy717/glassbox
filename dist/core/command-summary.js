/**
 * A shell command as a short summary, never the command line: the program and its subcommand
 * (`git commit`, `docker compose`), a script runner and its script's name (`python build.py`),
 * a fetch and its host (`curl api.x.io`), or an interpreter's inline-code flag (`python -c`).
 * Further commands in a chain or pipeline count as "+N" (`git add +1`). Flag values and free
 * text never show: a command line can carry anything, and the summary goes to every client.
 * A name that shows must read as a name: a slot whose word is shaped like a key is left out,
 * and a command whose program is shaped like one has no summary at all.
 *
 * Pure, and free of Node built-ins: the web bundle imports the activity module too.
 */
import { secretShaped } from './redact.js';
/** Past this, a command line or an argv is not read further; the summary counts what was read. */
const SCAN_MAX = 8000;
/** How deep `bash -lc "…"` and the like are unwrapped, and `$(…)` inside quotes is followed. */
const DEPTH_MAX = 3;
const NEST_MAX = 32;
/** The longest summary, "+N" included; slots are left out whole to fit, never cut. */
const SUMMARY_MAX = 60;
/** The longest program, script or package name that shows. */
const NAME_MAX = 48;
/**
 * The summary of a command line or an argv; null when it runs nothing that can be named, or
 * when an argv's words read so far are not all strings.
 */
export function summarizeCommand(command, options = {}) {
    const ps = options.powershell ?? false;
    if (typeof command === 'string')
        return render(summarize(command, 0, ps));
    const argv = capped(command);
    if (argv === null || argv.length === 0)
        return null;
    const [bin = ''] = argv;
    // ["git status && npm test"]: one word that is a whole command line.
    if (argv.length === 1 && /\s/.test(bin))
        return render(summarize(bin, 0, ps));
    return render(combine([describe(argv, 0, true)]));
}
/**
 * Each simple command of a line, in order, as its words (quotes removed) and its own summary:
 * `cd web && npm test | tail -5` is three, summed up as `cd`, `npm test` and `tail`. For telling
 * what a line runs (a test runner, a commit) wherever in it, which its one summary does not say.
 */
export function simpleCommands(line, options = {}) {
    const ps = options.powershell ?? false;
    return segments(line, ps).map((words) => ({ words, summary: render(describe(words, 0)) }));
}
/**
 * An argv's leading words, whole, up to SCAN_MAX characters in all: the rest is never looked
 * at, however long the array. Null when a word read is not a string.
 */
function capped(argv) {
    const out = [];
    let total = 0;
    for (const w of argv) {
        if (typeof w !== 'string')
            return null;
        total += w.length + 1;
        if (total > SCAN_MAX)
            break;
        out.push(w);
    }
    return out;
}
/** A JavaScript call to a tool with a command (`tools.exec_command({ cmd: "…" })`). */
const TOOL_CALL = /\btools\.\w+\s*\(\s*\{[^}]*?\b(?:cmd|command)\s*:\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`|(\[[^\]]*\]))/g;
/**
 * Codex's `exec` code, by the commands it hands to tools: their summary, counted as one chain.
 * Null when it spells out none; the code itself never shows.
 */
export function summarizeCode(code) {
    const parts = [];
    for (const m of code.slice(0, SCAN_MAX).matchAll(TOOL_CALL)) {
        const literal = m[1] ?? m[2] ?? m[3];
        if (literal !== undefined) {
            const line = literal.replace(/\\(.)/gs, (_e, c) => (c === 'n' ? '\n' : c));
            parts.push(summarize(line, 0, false));
            continue;
        }
        try {
            const parsed = JSON.parse(m[4] ?? '');
            const argv = Array.isArray(parsed) ? capped(parsed) : null;
            if (argv && argv.length > 0)
                parts.push(describe(argv, 0, true));
        }
        catch {
            // Not a literal argv: nothing to name.
        }
    }
    return render(combine(parts));
}
const part = (...slots) => ({
    slots: slots.filter((s) => typeof s === 'string' && s !== ''),
    more: 0,
});
const SECRET = { slots: [], more: 0, secret: true };
function summarize(line, depth, ps) {
    return combine(segments(line, ps).map((words) => describe(words, depth)));
}
/** A chain as one part: its first command that runs something, and how many follow it. */
function combine(parts) {
    let first = null;
    let setup = null;
    let more = 0;
    for (const p of parts) {
        if (p === null)
            continue;
        if (p.setup)
            setup ??= p;
        else if (first === null) {
            if (p.secret)
                return SECRET;
            first = p;
            more += p.more;
        }
        else
            more += 1 + p.more;
    }
    return first === null ? setup : { ...first, more };
}
function render(p) {
    if (p === null || p.secret || p.slots.length === 0)
        return null;
    const suffix = p.more > 0 ? ` +${p.more}` : '';
    const slots = [...p.slots];
    while (slots.length > 1 && slots.join(' ').length + suffix.length > SUMMARY_MAX)
        slots.pop();
    const text = `${slots.join(' ')}${suffix}`;
    return text.length > SUMMARY_MAX ? null : text;
}
// ── Reading a command line ───────────────────────────────────────────────────────────────────
/** Characters a backslash escapes in a POSIX shell; before others it is kept (`C:\Users`). */
const ESCAPABLE = new Set([...' \t"\'\\$`;&|()<>*?[]#~=%!{}\n']);
/**
 * The simple commands of a line, split at `;`, `&&`, `||`, `|`, `&`, newlines and subshell
 * parentheses, each as its words with quotes removed. Comments (PowerShell's `<# … #>` too),
 * heredoc bodies and a `case`'s patterns are skipped. `$(…)`, backquotes, `${…}` and `@{…}`
 * stay inside their word, heredocs inside them included. Reads at most SCAN_MAX characters, plus
 * heredoc bodies.
 */
function segments(line, ps) {
    const n = Math.min(line.length, SCAN_MAX);
    const segs = [];
    let heredocs = [];
    let words = [];
    let word = null;
    /** After `case … in` or `;;`: the words up to `)` are a pattern, not a command. */
    let pattern = false;
    /** After `case x` or `for x` ends its line: an `in` line next is still the head. */
    let headless = false;
    const endWord = () => {
        if (word !== null)
            words.push(word);
        word = null;
    };
    /** Ends the command; `case x in a)` has its first pattern in it already. */
    const endSegment = (closer = '') => {
        endWord();
        const first = words[0];
        if (first === undefined)
            return;
        if (headless && first === 'in') {
            // case $x, then `in` on a line of its own; for f, then `in *.ts`: not a command.
            words = [];
            headless = false;
            return;
        }
        headless = /^(?:case|for|select)$/.test(first) && !words.includes('in') && closer !== ')';
        segs.push(words);
        words = [];
        if (first === 'case')
            pattern = closer !== ')';
        else if (first === 'esac')
            pattern = false;
    };
    const add = (s) => {
        word = (word ?? '') + s;
    };
    /** A heredoc's delimiter after `<<` or `<<-` at `j`: the word with quotes removed, and its end. */
    const delimiterAt = (from) => {
        let j = from;
        if (line[j] === '-')
            j++;
        while (line[j] === ' ' || line[j] === '\t')
            j++;
        let d = '';
        while (j < n && !/[\s;&|<>()]/.test(line[j])) {
            const c = line[j];
            if (c === "'" || c === '"') {
                const e = line.indexOf(c, j + 1);
                if (e === -1 || e >= n)
                    return { word: '', end: n };
                d += line.slice(j + 1, e);
                j = e + 1;
            }
            else if (c === '\\') {
                d += line[j + 1] ?? '';
                j += 2;
            }
            else {
                d += c;
                j++;
            }
        }
        return { word: d, end: j };
    };
    /** The index after the heredoc bodies that start at `from`, one per delimiter, in order. */
    const afterBodies = (from, delimiters) => {
        let j = from;
        for (const d of delimiters) {
            while (j < line.length) {
                const e = line.indexOf('\n', j);
                const stop = e === -1 ? line.length : e;
                const body = line.slice(j, stop);
                j = stop + 1;
                if (body.trim() === d)
                    break;
            }
        }
        return j;
    };
    /** The index after the double-quoted string that opens at `i`, `$(…)` inside it followed. */
    const doubleEnd = (i, nest) => {
        let j = i + 1;
        while (j < n && line[j] !== '"') {
            const x = line[j];
            if ((x === '\\' && !ps) || (x === '`' && ps))
                j += 2;
            else if (x === '$' && line[j + 1] === '(' && nest < NEST_MAX)
                j = closing(j + 1, '(', ')', nest + 1);
            else if (x === '`' && !ps) {
                const e = line.indexOf('`', j + 1);
                j = e === -1 ? n : e + 1;
            }
            else
                j++;
        }
        return j + 1;
    };
    /** The index just past the bracket that closes the one at `i`: quotes, heredocs, comments. */
    const closing = (i, open, close, nest = 0) => {
        let depth = 0;
        let j = i;
        const pending = [];
        while (j < n) {
            const c = line[j];
            if (c === '\n') {
                j = pending.length > 0 ? afterBodies(j + 1, pending.splice(0)) : j + 1;
            }
            else if ((c === '\\' && !ps) || (c === '`' && ps))
                j += 2;
            else if (c === "'") {
                const e = line.indexOf("'", j + 1);
                j = e === -1 ? n : e + 1;
            }
            else if (c === '"')
                j = nest < NEST_MAX ? doubleEnd(j, nest + 1) : j + 1;
            else if (c === '<' && line[j + 1] === '<' && line[j + 2] === '<')
                j += 3;
            else if (ps && c === '<' && line[j + 1] === '#') {
                const e = line.indexOf('#>', j + 2);
                j = e === -1 ? n : e + 2;
            }
            else if (c === '<' && line[j + 1] === '<') {
                const d = delimiterAt(j + 2);
                if (d.word)
                    pending.push(d.word);
                j = Math.max(d.end, j + 2);
            }
            else if (c === '#' && /[\s;&|(]/.test(line[j - 1] ?? ' ')) {
                const e = line.indexOf('\n', j);
                j = e === -1 ? n : e;
            }
            else {
                if (c === open)
                    depth++;
                else if (c === close && --depth === 0)
                    return j + 1;
                j++;
            }
        }
        return n;
    };
    let i = 0;
    while (i < n) {
        const c = line[i];
        const next = line[i + 1];
        if (c === '\n') {
            endSegment();
            i = heredocs.length > 0 ? afterBodies(i + 1, heredocs) : i + 1;
            heredocs = [];
        }
        else if (c === ' ' || c === '\t' || c === '\r') {
            endWord();
            i++;
        }
        else if ((c === '\\' && !ps) || (c === '`' && ps)) {
            // A line continuation, LF or CRLF, joins the next line.
            if (next === '\n')
                i += 2;
            else if (next === '\r' && line[i + 2] === '\n')
                i += 3;
            else if (ps || (next !== undefined && ESCAPABLE.has(next))) {
                add(next ?? '');
                i += 2;
            }
            else {
                add(c);
                i++;
            }
        }
        else if (c === "'") {
            const e = line.indexOf("'", i + 1);
            const stop = e === -1 || e > n ? n : e;
            add(line.slice(i + 1, stop));
            i = stop + 1;
        }
        else if (c === '"') {
            const end = doubleEnd(i, 0);
            const body = line.slice(i + 1, Math.min(end - 1, n));
            add(ps ? body.replace(/`(.)/g, '$1') : body.replace(/\\(["\\$`\n])/g, '$1'));
            i = end;
        }
        else if (c === '`') {
            const e = line.indexOf('`', i + 1);
            const stop = e === -1 || e >= n ? n : e + 1;
            add(line.slice(i, stop));
            i = stop;
        }
        else if (c === '$' && next === "'" && !ps) {
            // $'…', where \' does not close it.
            let j = i + 2;
            let s = '';
            while (j < n && line[j] !== "'") {
                s += line[j] === '\\' ? (line[j + 1] ?? '') : line[j];
                j += line[j] === '\\' ? 2 : 1;
            }
            add(s);
            i = j + 1;
        }
        else if (ps &&
            c === '@' &&
            (next === '"' || next === "'") &&
            /^\r?\n/.test(line.slice(i + 2, i + 4))) {
            // A PowerShell here-string, @"…"@, to its closing line.
            const end = line.indexOf(`\n${next}@`, i + 2);
            const stop = end === -1 || end >= n ? n : end + 3;
            add('@…');
            i = stop;
        }
        else if ((c === '$' || c === '@') && (next === '(' || next === '{')) {
            const stop = closing(i + 1, next, next === '(' ? ')' : '}');
            add(line.slice(i, stop));
            i = stop;
        }
        else if (ps && c === '<' && next === '#') {
            // A PowerShell block comment, <# … #>, over lines or inside one.
            endWord();
            const e = line.indexOf('#>', i + 2);
            i = e === -1 || e >= n ? n : e + 2;
        }
        else if (c === '#' && word === null) {
            const e = line.indexOf('\n', i);
            i = e === -1 ? n : e;
        }
        else if (c === ';') {
            endSegment();
            if (next === ';' || next === '&') {
                // ;; ;& ;;& end a case branch: a pattern comes next.
                i += line[i + 2] === '&' ? 3 : 2;
                pattern = true;
            }
            else
                i++;
        }
        else if (c === ')') {
            if (pattern) {
                // A case pattern: not a command.
                words = [];
                word = null;
                pattern = false;
            }
            else
                endSegment(')');
            i++;
        }
        else if (c === '|') {
            endSegment();
            i++;
        }
        else if (c === '&') {
            if (word !== null && /[<>]$/.test(word))
                add(c); // 2>&1
            else if (next === '>') {
                endWord();
                add(c); // &>file
            }
            else
                endSegment();
            i++;
        }
        else if (c === '(') {
            if (word === null) {
                endSegment(); // a subshell
                i++;
            }
            else {
                const stop = closing(i, '(', ')'); // f(…), [Env]::Set(…)
                add(line.slice(i, stop));
                i = stop;
            }
        }
        else if (c === '<' && next === '<' && line[i + 2] === '<') {
            add('<<<'); // a here-string: a redirection, dropped with its word
            i += 3;
        }
        else if (c === '<' && next === '<') {
            // <<EOF, <<-'EOF', <<"E"OF: the body is skipped at the next newline.
            endWord();
            const d = delimiterAt(i + 2);
            if (d.word)
                heredocs.push(d.word);
            i = Math.max(d.end, i + 2);
        }
        else {
            add(c);
            i++;
        }
    }
    // A word the scan limit cut could be anything: drop it.
    if (n < line.length)
        word = null;
    endSegment();
    return segs;
}
// ── Describing one command ───────────────────────────────────────────────────────────────────
/** Words that open or close a compound command, or prefix one, and say nothing themselves. */
const KEYWORDS = new Set([
    '!',
    '{',
    '}',
    'if',
    'then',
    'else',
    'elif',
    'fi',
    'do',
    'done',
    'while',
    'until',
    'esac',
    'nohup',
    'exec',
    'builtin',
    'noglob',
    '&',
]);
/** Set-up and tests, shown only when nothing else runs. */
const SETUP = new Set([
    'cd',
    'pushd',
    'popd',
    'chdir',
    'set',
    'export',
    'unset',
    'source',
    '.',
    'declare',
    'local',
    'typeset',
    'readonly',
    'shopt',
    'setopt',
    'trap',
    'ulimit',
    'umask',
    'alias',
    'true',
    ':',
    '[',
    '[[',
    'test',
    'set-location',
    'sl',
    'push-location',
    'pop-location',
    'set-strictmode',
    // A loop's or a case's head; `while read line` reads.
    'for',
    'select',
    'case',
    'function',
    'read',
]);
/** Programs that run another. Their options' values never show. */
const WRAPPERS = {
    env: {
        values: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
        switches: ['-i', '--ignore-environment', '-0', '--null', '-v', '--debug'],
    },
    sudo: {
        values: [
            '-u',
            '--user',
            '-g',
            '--group',
            '-C',
            '--close-from',
            '-D',
            '--chdir',
            '-h',
            '--host',
            '-p',
            '--prompt',
            '-r',
            '--role',
            '-t',
            '--type',
            '-T',
            '--command-timeout',
            '-U',
            '--other-user',
            '-R',
            '--chroot',
        ],
        switches: [
            '-A',
            '--askpass',
            '-b',
            '--background',
            '-E',
            '--preserve-env',
            '-e',
            '--edit',
            '-H',
            '--set-home',
            '-i',
            '--login',
            '-K',
            '-k',
            '--reset-timestamp',
            '-l',
            '--list',
            '-n',
            '--non-interactive',
            '-P',
            '--preserve-groups',
            '-S',
            '--stdin',
            '-s',
            '--shell',
            '-V',
            '-v',
            '--validate',
            '-B',
            '--bell',
            '-N',
            '--no-update',
        ],
    },
    doas: { values: ['-u', '-C'], switches: ['-n', '-s', '-L'] },
    command: { switches: ['-v', '-V', '-p'] },
    time: {
        values: ['-f', '--format', '-o', '--output'],
        switches: ['-p', '--portability', '-v', '--verbose', '-a', '--append', '-q', '--quiet'],
    },
    nice: { values: ['-n', '--adjustment'] },
    ionice: { values: ['-c', '--class', '-n', '--classdata', '-p', '-P', '-u'], switches: ['-t'] },
    timeout: {
        values: ['-s', '--signal', '-k', '--kill-after'],
        switches: ['--preserve-status', '--foreground', '-v', '--verbose'],
        positional: 1,
    },
    stdbuf: { values: ['-i', '-o', '-e'] },
    watch: {
        values: ['-n', '--interval'],
        switches: [
            '-d',
            '--differences',
            '-t',
            '--no-title',
            '-b',
            '--beep',
            '-e',
            '--errexit',
            '-g',
            '--chgexit',
            '-c',
            '--color',
            '-x',
            '--exec',
            '-p',
            '--precise',
        ],
    },
    xargs: {
        values: [
            '-I',
            '-J',
            '-n',
            '--max-args',
            '-P',
            '--max-procs',
            '-L',
            '-s',
            '-d',
            '--delimiter',
            '-E',
            '-a',
            '--arg-file',
        ],
        switches: ['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-p', '-x', '-o'],
    },
};
/**
 * Long switches that take no value for any program. Short ones are not trusted this way: `-t`,
 * `-a` or `-i` takes a value for many programs (`vercel -t <token>`), so only a program's own
 * list says it is a switch there.
 */
const COMMON_SWITCHES = new Set([
    '--verbose',
    '--quiet',
    '--silent',
    '--debug',
    '--version',
    '--help',
    '--yes',
    '--no-color',
    '--json',
    '--dry-run',
    '--force',
    '--all',
    '--recursive',
    '--global',
    '--locked',
    '--frozen',
    '--offline',
    '--no-pager',
    '--paginate',
    '--insecure',
    '--no-cache',
    '--watch',
]);
/**
 * Option names that carry a credential: their value is skipped even when not listed, so it
 * cannot pass for a subcommand or a script.
 */
const SECRET_OPTION = /token|secret|key|pass|pwd|auth(?!or)|credential|cookie|session|otp/i;
/**
 * Whether an option takes the next word as its value. `--x=y` and `-j8` hold their own; unknown
 * is an option no list names, whose next word could be either and so never shows.
 */
function optionKind(w, spec) {
    if (w.includes('='))
        return 'switch';
    if (spec.values?.includes(w) || SECRET_OPTION.test(w))
        return 'value';
    if (spec.switches?.includes(w) || COMMON_SWITCHES.has(w))
        return 'switch';
    // A short option with its value attached: -j8, -O2, -p5432.
    if (/^-[A-Za-z]\d+$/.test(w))
        return 'switch';
    // Anything else the program does not list (a common letter such as -t, or a single-dash option
    // of more letters such as -gs or -Xfoo) may take the next word as its value.
    return 'unknown';
}
/**
 * The first word at or after `i` that is not an option or an option's value. Ambiguous when an
 * unknown option comes right before it: that word may be the option's value, so it never
 * passes for a subcommand.
 */
function scanOptions(words, i, spec) {
    let j = i;
    while (j < words.length) {
        const w = words[j];
        if (w === '--')
            return { index: j + 1, ambiguous: false };
        if (!w.startsWith('-') || w === '-')
            return { index: j, ambiguous: false };
        const kind = optionKind(w, spec);
        if (kind === 'value')
            j += 2;
        else if (kind === 'unknown' && words[j + 1] !== undefined && !words[j + 1]?.startsWith('-'))
            return { index: j + 1, ambiguous: true };
        else
            j++;
    }
    return { index: j, ambiguous: false };
}
const SHELLS = /^(?:(?:ba|z|da|k|a|fi)?sh|pwsh|powershell|cmd)$/;
const PYTHON = {
    code: /^-c$/,
    module: '-m',
    values: ['-W', '-X', '-Q'],
    switches: ['-u', '-O', '-OO', '-B', '-E', '-s', '-S', '-I', '-q', '-v', '-b', '-bb', '-d'],
};
const NODE = {
    code: /^(?:-e|--eval|-p|--print|-pe)$/,
    values: [
        '-r',
        '--require',
        '--import',
        '--loader',
        '--experimental-loader',
        '-C',
        '--conditions',
        '--env-file',
        '--title',
        '--inspect-port',
        '--stack-size',
        '--max-old-space-size',
        '--stack-trace-limit',
        '--redirect-warnings',
        '--diagnostic-dir',
        '--report-dir',
    ],
    switches: [
        '--inspect',
        '--inspect-brk',
        '--test',
        '--trace-warnings',
        '--trace-deprecation',
        '--trace-uncaught',
        '--enable-source-maps',
        '--no-warnings',
        '--no-deprecation',
        '--expose-gc',
        '--preserve-symlinks',
        '--abort-on-uncaught-exception',
        '--harmony',
        '-c',
        '--check',
        '--interactive',
    ],
};
const INTERPRETERS = {
    node: NODE,
    nodejs: NODE,
    tsx: NODE,
    'ts-node': NODE,
    ruby: { code: /^-[a-zA-Z]*e$/, values: ['-r', '-I', '-C'] },
    perl: { code: /^-[a-zA-Z]*[eE]$/, values: ['-I', '-M', '-m'] },
    php: { code: /^-r$/, values: ['-c', '-d'] },
    lua: { code: /^-e$/, values: ['-l'] },
    luajit: { code: /^-e$/, values: ['-l'] },
    rscript: { code: /^-e$/ },
    julia: { code: /^(?:-e|--eval|-E|--print)$/, values: ['--project', '-t', '--threads'] },
    osascript: { code: /^-e$/ },
    java: { code: /^$/, values: ['-cp', '-classpath', '--class-path', '-p', '--module-path'] },
};
const isPython = (key) => /^(?:python[\d.]*|py|pypy\d?|ipython)$/.test(key);
/** Fetches: shown with the host they reach. */
const FETCHERS = new Set([
    'curl',
    'wget',
    'http',
    'https',
    'xh',
    'xhs',
    'curlie',
    'aria2c',
    'invoke-webrequest',
    'iwr',
    'invoke-restmethod',
    'irm',
]);
/** Options of a fetch whose value is not where it goes: a proxy, a referer, a header, a body… */
const FETCH_VALUES = new Set([
    ...'-a -A -b -c -d -D -e -E -F -H -K -m -o -P -r -T -u -U -w -x -X -y -Y -z -t'.split(' '),
    ...[
        'data',
        'data-raw',
        'data-binary',
        'data-urlencode',
        'json',
        'header',
        'user',
        'user-agent',
        'cookie',
        'cookie-jar',
        'output',
        'output-dir',
        'request',
        'proxy',
        'preproxy',
        'proxy-user',
        'referer',
        'form',
        'form-string',
        'config',
        'max-time',
        'connect-timeout',
        'retry',
        'cert',
        'key',
        'cacert',
        'resolve',
        'write-out',
        'upload-file',
        'oauth2-bearer',
        'unix-socket',
        'http-user',
        'http-password',
        'auth',
    ].map((o) => `--${o}`),
    // PowerShell's, lower-cased.
    ...['-headers', '-body', '-method', '-outfile', '-contenttype', '-useragent', '-credential'],
    ...['-token', '-proxy', '-websession', '-infile', '-timeoutsec', '-form'],
]);
/** Programs whose first word is a subcommand, with their options that take a value before it. */
const SUBCOMMANDS = {
    git: ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'],
    gh: ['-R', '--repo', '--hostname'],
    glab: ['-R', '--repo'],
    npm: ['--prefix', '-w', '--workspace', '--registry', '--userconfig', '--cache', '--loglevel'],
    pnpm: ['-C', '--dir', '-F', '--filter', '--loglevel', '--reporter'],
    yarn: ['--cwd'],
    bun: ['--cwd', '-c', '--config'],
    npx: ['-p', '--package'],
    pnpx: [],
    bunx: ['-p', '--package'],
    uvx: ['--from', '-p', '--python', '--with'],
    deno: [],
    cargo: ['-Z', '--config', '-C', '--color', '--manifest-path'],
    rustup: [],
    go: ['-C'],
    docker: [
        '-H',
        '--host',
        '-c',
        '--context',
        '--config',
        '-l',
        '--log-level',
        '--tlscacert',
        '--tlscert',
        '--tlskey',
    ],
    'docker-compose': ['-f', '--file', '-p', '--project-name', '--env-file', '--profile'],
    podman: ['-c', '--connection', '--url'],
    nerdctl: ['-n', '--namespace'],
    kubectl: [
        '-n',
        '--namespace',
        '--context',
        '--cluster',
        '--kubeconfig',
        '-s',
        '--server',
        '--user',
        '--username',
        '--as',
        '--as-group',
        '--certificate-authority',
        '--client-certificate',
        '--client-key',
        '-v',
        '--request-timeout',
    ],
    oc: ['-n', '--namespace', '--context', '--server', '--kubeconfig', '--user'],
    helm: [
        '-n',
        '--namespace',
        '--kube-context',
        '--kubeconfig',
        '--registry-config',
        '--kube-apiserver',
    ],
    minikube: ['-p', '--profile'],
    kind: [],
    aws: [
        '--profile',
        '--region',
        '--output',
        '--endpoint-url',
        '--query',
        '--ca-bundle',
        '--color',
        '--cli-read-timeout',
        '--cli-connect-timeout',
        '--cli-binary-format',
    ],
    gcloud: [
        '--project',
        '--account',
        '--configuration',
        '--verbosity',
        '--format',
        '--impersonate-service-account',
    ],
    gsutil: ['-o', '-h'],
    az: ['--subscription', '-o', '--output', '--query'],
    terraform: [],
    tofu: [],
    terragrunt: [],
    pulumi: ['-C', '--cwd', '-s', '--stack'],
    make: ['-C', '-f', '--file', '--directory', '--makefile', '-I', '-o', '-W', '-l', '-j'],
    gmake: ['-C', '-f', '--file', '--directory', '-I', '-o', '-W', '-l', '-j'],
    just: ['-f', '--justfile', '-d', '--working-directory'],
    task: ['-d', '--dir', '-t', '--taskfile'],
    uv: ['--directory', '--project', '-p', '--python', '--cache-dir', '--config-file'],
    pip: [],
    pip3: [],
    pipx: [],
    poetry: ['-C', '--directory', '-P', '--project'],
    pdm: ['-p', '--project'],
    pipenv: [],
    hatch: ['-e', '--env', '-p', '--project'],
    rye: [],
    pixi: ['--manifest-path'],
    conda: [],
    mamba: [],
    micromamba: [],
    brew: [],
    apt: ['-o', '-t', '-c'],
    'apt-get': ['-o', '-t', '-c'],
    dnf: [],
    yum: [],
    apk: [],
    pacman: [],
    snap: [],
    flatpak: [],
    systemctl: ['-H', '--host', '-M', '--machine'],
    dotnet: [],
    mvn: ['-f', '--file', '-s', '--settings', '-P', '-pl', '--projects'],
    gradle: ['-p', '--project-dir', '-c', '--settings-file'],
    gradlew: ['-p', '--project-dir'],
    flutter: [],
    dart: [],
    swift: [],
    gem: [],
    bundle: [],
    rake: ['-f', '--rakefile', '-C', '--directory'],
    rails: [],
    composer: ['-d', '--working-dir'],
    firebase: ['-P', '--project'],
    vercel: ['--scope', '--cwd'],
    netlify: [],
    wrangler: ['-c', '--config', '-e', '--env'],
    fly: ['-a', '--app', '-c', '--config'],
    flyctl: ['-a', '--app', '-c', '--config'],
    heroku: ['-a', '--app'],
    supabase: ['--workdir'],
    stripe: ['--project-name'],
    vault: [],
    nix: [],
    turbo: ['--cwd'],
    nx: [],
    lerna: [],
    vitest: [],
    biome: [],
    vite: [],
    next: [],
    expo: [],
    eas: [],
    ollama: [],
    pm2: [],
    tmux: ['-L', '-S', '-f'],
    codex: ['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd'],
    claude: ['--model', '--agents', '--settings', '--resume', '-r', '--session-id'],
    opencode: ['-m', '--model', '-s', '--session'],
    gemini: ['-m', '--model'],
    openssl: [],
    rclone: ['--config'],
    restic: ['-r', '--repo'],
    bazel: [],
    sbt: [],
    mix: [],
    cabal: [],
    stack: [],
    zig: [],
    'pre-commit': ['-c', '--config'],
    doppler: [],
    op: ['--account'],
    adb: ['-s', '-P', '-H'],
    xcrun: [],
    pod: [],
    sam: [],
    cdk: [],
    serverless: [],
    sls: [],
    railway: [],
    doctl: ['--context'],
    eksctl: [],
    skaffold: [],
    tailscale: [],
    cloudflared: [],
};
/** Switches of a program with subcommands, beyond the common ones. */
const SUBCOMMAND_SWITCHES = {
    git: ['-p', '-P', '--bare', '--no-replace-objects', '--literal-pathspecs', '--no-optional-locks'],
    npm: ['-ws', '--workspaces', '--if-present', '-w', '-g', '-s', '-q', '-y', '-d', '-D'],
    pnpm: ['-r', '-w', '--workspace-root', '--if-present', '--parallel', '-g', '-s'],
    yarn: ['--immutable', '--frozen-lockfile', '-s'],
    docker: ['--tls', '--tlsverify', '-D'],
    kubectl: ['--insecure-skip-tls-verify'],
    cargo: ['--frozen', '--offline', '-q', '-v', '-vv'],
    uv: ['-q', '-v', '-n'],
    pip: ['-q', '-qq', '-v', '-vv'],
    pip3: ['-q', '-qq', '-v', '-vv'],
    pipx: ['-q', '-v'],
    poetry: ['-q', '-v', '-vv', '-n'],
    conda: ['-y', '-q'],
    brew: ['-q', '-v', '-d'],
    apt: ['-y', '-q', '-qq'],
    'apt-get': ['-y', '-q', '-qq'],
    dnf: ['-y', '-q'],
    yum: ['-y', '-q'],
    az: ['--only-show-errors'],
    aws: ['--no-paginate', '--no-verify-ssl', '--no-sign-request', '--no-cli-pager'],
    make: ['-k', '-B', '-n', '-e', '-r', '-R'],
    npx: ['--yes', '--no', '-y', '-q'],
    gsutil: ['-m', '-q'],
    claude: ['-p', '--print', '-c', '--continue', '--dangerously-skip-permissions'],
};
/**
 * Agent CLIs whose first word may be a prompt rather than a subcommand: only these names count
 * as subcommands (`claude mcp`, `codex exec`); anything else is free text and never shows.
 */
const CLOSED_SUBCOMMANDS = {
    claude: new Set([
        'mcp',
        'config',
        'update',
        'doctor',
        'install',
        'setup-token',
        'plugin',
        'agents',
    ]),
    codex: new Set([
        'exec',
        'e',
        'login',
        'logout',
        'mcp',
        'mcp-server',
        'app-server',
        'completion',
        'sandbox',
        'debug',
        'apply',
        'a',
        'resume',
        'cloud',
        'review',
        'features',
        'update',
        'upgrade',
        'doctor',
        'version',
        'help',
    ]),
    opencode: new Set([
        'run',
        'serve',
        'auth',
        'agent',
        'upgrade',
        'models',
        'export',
        'import',
        'github',
        'mcp',
        'web',
        'stats',
        'acp',
        'debug',
        'session',
    ]),
    gemini: new Set(['mcp', 'extensions']),
};
/** Subcommands that run something named next: `npm run build`, `uv run pytest`. */
const RUNNERS = {
    npm: ['run', 'run-script', 'exec', 'x'],
    pnpm: ['run', 'exec', 'dlx'],
    yarn: ['run', 'exec', 'dlx'],
    bun: ['run', 'x'],
    uv: ['run'],
    poetry: ['run'],
    pdm: ['run'],
    pipenv: ['run'],
    hatch: ['run'],
    rye: ['run'],
    pixi: ['run'],
    conda: ['run'],
    mamba: ['run'],
    micromamba: ['run'],
    bundle: ['exec'],
    pipx: ['run'],
    doppler: ['run'],
};
/** Options of a runner subcommand that take a value before what it runs. */
const RUNNER_VALUES = ['-n', '--name', '-p', '--prefix', '-e', '--env', '--with', '--from'];
/** Programs that take a package name where others take a subcommand. */
const PACKAGE_RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx']);
const isAssignment = (w) => /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(w);
/** PowerShell's `$x = …` or `$env:X="…"`, in either shell's command line. */
const isVariableSet = (w, next) => /^\$[\w:]+(?:\.\w+)*[+\-*/]?=/.test(w) ||
    (/^\$[\w:]+$/.test(w) && /^[+\-*/]?=$/.test(next ?? ''));
const isRedirect = (w) => /^(?:\d*|&)(?:>>?|<)/.test(w);
/** A redirection with its target in the next word. */
const isBareRedirect = (w) => /^(?:\d*|&)(?:>>?|<)&?$|^<<<$/.test(w);
const basename = (path) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
/** A name as programs, scripts and packages are named: letters in any script, digits, `._+-`. */
const isName = (w, max = NAME_MAX) => w.length > 0 &&
    w.length <= max &&
    /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}._+-]*$/u.test(w) &&
    !secretShaped(w);
/** One command, from a parsed line's words or (`argv`) words no shell has read. */
function describe(all, depth, argv = false) {
    // Redirections and their targets say nothing about what runs; an argv has none.
    const words = [];
    for (let j = 0; j < all.length; j++) {
        const w = all[j];
        if (!argv && (isRedirect(w) || w === '<<<')) {
            if (isBareRedirect(w))
                j++;
            continue;
        }
        words.push(w);
    }
    let i = 0;
    for (;;) {
        const w = words[i];
        if (w === undefined)
            return null;
        if (KEYWORDS.has(w.toLowerCase()) || isAssignment(w)) {
            i++;
            continue;
        }
        if (isVariableSet(w, words[i + 1]))
            return null;
        const name = basename(w);
        const wrapper = WRAPPERS[name];
        if (!wrapper)
            break;
        const scan = scanOptions(words, i + 1, wrapper);
        // sudo --unknown x make: x may be the option's value or the program; the wrapper alone.
        if (scan.ambiguous)
            return part(name);
        i = scan.index + (wrapper.positional ?? 0);
        if (i >= words.length)
            return part(name);
        // watch "make test": one word that is a whole command line.
        const only = words[i];
        if (i === words.length - 1 && /\s/.test(only))
            return depth < DEPTH_MAX ? summarize(only, depth + 1, false) : part(name);
    }
    const word = words[i];
    if (SETUP.has(word.toLowerCase()))
        return { ...part(word), setup: true };
    // An option where a program should be (`exec -a name …`): nothing to name.
    if (word.startsWith('-'))
        return null;
    const prog = programName(word);
    if (prog === null)
        return SECRET;
    const key = prog.toLowerCase();
    const rest = words.slice(i + 1);
    // A function's definition (`shoot() {`) runs nothing yet.
    if (SETUP.has(key) || /\(\)$/.test(word))
        return { ...part(prog), setup: true };
    if (SHELLS.test(key))
        return shell(prog, key, rest, depth);
    if (isPython(key) || INTERPRETERS[key])
        return interpreter(prog, key, rest);
    if (FETCHERS.has(key))
        return fetch(prog, key, rest);
    if (Object.hasOwn(SUBCOMMANDS, key))
        return subcommand(prog, key, rest);
    return part(prog);
}
/**
 * A program as it shows: the whole name of what runs, not its path (`./scripts/x.sh` is `x.sh`,
 * `C:\Program Files\nodejs\node.exe` is `node`, a name in any script stays whole), a PowerShell method
 * (`[IO.File]::WriteAllText`), `$VAR`, or `$(…)` for a substitution. Null for anything else,
 * a word shaped like a key included: never a part of a word.
 */
function programName(word) {
    if (/^(?:\$\(|`)/.test(word))
        return '$(…)';
    if (/^\$\{?[A-Za-z_]\w*\}?$/.test(word))
        return word.length <= NAME_MAX ? word : null;
    const method = /^(\[[\w.]+\]::\w+)(?:\(|$)/.exec(word)?.[1];
    if (method)
        return method.length <= NAME_MAX && !secretShaped(method) ? method : null;
    const fn = /^([\w.:-]+)\(\)$/.exec(word)?.[1];
    if (fn)
        return isName(fn) ? fn : null;
    const name = basename(word).replace(/\.exe$/i, '');
    return isName(name) ? name : null;
}
/** A script's file name, when it reads as one: `scripts/build.py` is `build.py`. */
function scriptName(word) {
    const name = basename(word ?? '');
    return isName(name) ? name : null;
}
/** A word as a subcommand or a script's name in package.json: short and plain. */
function subword(word) {
    if (word === undefined || word.length > 32)
        return null;
    // :app:assembleDebug (Gradle), test:unit (npm).
    if (!/^[\p{L}\p{N}:][\p{L}\p{M}\p{N}._:-]*$/u.test(word) || secretShaped(word))
        return null;
    return word;
}
/** A package as npx and friends name it, without its version: `@biomejs/biome`, `vitest`. */
function packageName(word) {
    const m = /^(?:@([\p{L}\p{N}._-]+)\/)?([\p{L}\p{N}._-]+)/u.exec(word ?? '');
    if (!m || m[0].length > NAME_MAX)
        return null;
    const [, scope, name = ''] = m;
    if (scope !== undefined && (!isName(scope) || !isName(name)))
        return null;
    return scope === undefined ? subword(name) : m[0];
}
/** A Python module's dotted name. */
const moduleName = (word) => word !== undefined && /^[\p{L}_][\p{L}\p{N}_.]{0,39}$/u.test(word) && !secretShaped(word)
    ? word
    : null;
/** A word that reads as a file to run: a path or a name with an extension. */
const fileLike = (w) => /[\\/]/.test(w) || /\.[\p{L}\p{N}]{1,8}$/u.test(w);
/** PowerShell switches that take no value. */
const NO_VALUE = /^-(?:nologo|noprofile|nop|noninteractive|noni|noexit|mta|sta|nol)$/i;
/** A shell: what its `-c` runs, unwrapped, or the script it runs. */
function shell(prog, key, rest, depth) {
    const pwsh = key === 'pwsh' || key === 'powershell';
    const cmd = key === 'cmd';
    for (let j = 0; j < rest.length; j++) {
        const a = rest[j];
        const runs = cmd
            ? /^\/[ck]$/i.test(a)
            : pwsh
                ? /^-(?:c|command)$/i.test(a)
                : /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a);
        if (runs) {
            const code = cmd ? rest.slice(j + 1).join(' ') : rest[j + 1];
            const unwrapped = code === undefined || depth >= DEPTH_MAX ? null : summarize(code, depth + 1, pwsh || cmd);
            return unwrapped ?? part(prog, a);
        }
        if (pwsh && /^-(?:e|ec|enc|encodedcommand)$/i.test(a))
            return part(prog, '-EncodedCommand');
        if (pwsh && /^-(?:f|file)$/i.test(a))
            return part(prog, scriptName(rest[j + 1]));
        if (cmd ? !a.startsWith('/') : !a.startsWith('-'))
            return part(prog, scriptName(a));
        // bash -o pipefail, --rcfile f, pwsh -ExecutionPolicy Bypass: a value, not the script.
        if (/^(?:[-+]o|-O|--rcfile|--init-file)$/.test(a) || (pwsh && !NO_VALUE.test(a)))
            j++;
    }
    return part(prog);
}
/** An interpreter: its inline-code flag, its module, or its script's name. */
function interpreter(prog, key, rest) {
    const spec = INTERPRETERS[key] ?? PYTHON;
    for (let j = 0; j < rest.length; j++) {
        const a = rest[j];
        if (spec.code.test(a))
            return part(prog, a);
        if (spec.module && a === spec.module)
            return part(prog, '-m', moduleName(rest[j + 1]));
        if (a === '-')
            return part(prog, '-');
        if (a === '--' || (key === 'java' && a === '-jar'))
            return part(prog, scriptName(rest[j + 1]));
        if (!a.startsWith('-'))
            return part(prog, scriptName(a));
        const kind = optionKind(a, spec);
        const next = rest[j + 1];
        // An unknown option's next word: the script when it reads as a file, else its value.
        if (kind === 'value' ||
            (kind === 'unknown' && next !== undefined && !next.startsWith('-') && !fileLike(next)))
            j++;
    }
    return part(prog);
}
/** A fetch: the host of its first URL that is not an option's value. */
function fetch(prog, key, rest) {
    let bare = null;
    let afterUnknown = false;
    for (let j = 0; j < rest.length; j++) {
        const a = rest[j];
        if (a.startsWith('-')) {
            const name = a.split('=')[0] ?? a;
            // Short options by case (curl's -O takes no value, wget's does); long ones and
            // PowerShell's in any case.
            const known = name.length > 2 ? FETCH_VALUES.has(name.toLowerCase()) : FETCH_VALUES.has(name);
            afterUnknown = false;
            if (/^--?(?:url|uri)$/i.test(name)) {
                const host = hostOf(a.includes('=') ? a.slice(a.indexOf('=') + 1) : (rest[++j] ?? ''));
                if (host)
                    return part(prog, host);
            }
            else if (!a.includes('=') &&
                (known || (name === '-O' && key === 'wget') || SECRET_OPTION.test(name)))
                j++;
            else
                afterUnknown = /^--[^-]/.test(a) && !a.includes('=');
            continue;
        }
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) {
            const host = hostOf(a);
            if (host)
                return part(prog, host);
        }
        else if (bare === null && !afterUnknown) {
            if (HOST_LIKE.test(a))
                bare = hostOf(`http://${a}`);
            else if (/^:\d+(?:[/?#]|$)/.test(a))
                bare = `localhost${/^:\d+/.exec(a)?.[0] ?? ''}`; // httpie's :8080/x
        }
        afterUnknown = false;
    }
    return part(prog, bare);
}
const HOST_LIKE = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/;
/** A URL with a host in it, checked before it is parsed, so a bad one costs no exception. */
const AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#\s@]*@)?(?:\[[0-9a-f:.]+\]|[^\s:/?#@[\]]+)(?::\d*)?(?:[/?#]|$)/i;
/**
 * A URL's host and port, without its user or path; null when it has none. A label shaped like a
 * key (a tunnel's or a capability URL's random name) shows as "…".
 */
export function hostOf(url) {
    if (url.length > 2048 || !AUTHORITY.test(url))
        return null;
    let host;
    try {
        host = new URL(url).host;
    }
    catch {
        return null;
    }
    if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d+)?$/i.test(host))
        return null;
    return host
        .split('.')
        .map((label) => (secretShaped(label.replace(/:\d+$/, '')) ? '…' : label))
        .join('.');
}
/** A program with subcommands: the subcommand, and what a runner subcommand runs. */
function subcommand(prog, key, rest) {
    const spec = { values: SUBCOMMANDS[key], switches: SUBCOMMAND_SWITCHES[key] };
    let scan = scanOptions(rest, 0, spec);
    // cargo +nightly test, make VAR=x test: neither is the subcommand.
    while (!scan.ambiguous && /^\+|^[A-Za-z_]\w*=/.test(rest[scan.index] ?? ''))
        scan = scanOptions(rest, scan.index + 1, spec);
    // npm --otp 493817 publish: the word after an unknown option may be its value.
    if (scan.ambiguous)
        return part(prog);
    const word = rest[scan.index];
    const closed = CLOSED_SUBCOMMANDS[key];
    let sub;
    if (closed)
        sub = word !== undefined && closed.has(word) ? word : null;
    else if (PACKAGE_RUNNERS.has(key))
        sub = packageName(word);
    else if (word && /[\\/]/.test(word) && /\.\w+$/.test(word))
        sub = scriptName(word); // bun ./scripts/x.ts
    else
        sub = subword(word);
    if (sub === null)
        return part(prog);
    const run = RUNNERS[key]?.includes(sub) ? runs(rest, scan.index + 1) : null;
    return part(prog, sub, run);
}
/** What a runner subcommand runs: a script, a package or a program, by name. */
function runs(rest, from) {
    const scan = scanOptions(rest, from, { values: RUNNER_VALUES });
    const word = rest[scan.index];
    if (scan.ambiguous || word === undefined)
        return null;
    if (word.startsWith('@'))
        return packageName(word);
    return /[\\/]/.test(word) ? scriptName(word) : subword(word);
}
//# sourceMappingURL=command-summary.js.map