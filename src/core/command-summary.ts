/**
 * A shell command as a short summary, never the command line: the program and its subcommand
 * (`git commit`, `docker compose`), a script runner and its script's name (`python build.py`),
 * a fetch and its host (`curl api.x.io`), or an interpreter's inline-code flag (`python -c`).
 * Further commands in a chain or pipeline count as "+N" (`git add +1`). Flag values and free
 * text never show: a command line can carry anything, and the summary goes to every client.
 *
 * Pure, and free of Node built-ins: the web bundle imports the activity module too.
 */

/** Past this, a command line is not read further; the summary counts what was read. */
const SCAN_MAX = 8000;
/** How deep `bash -lc "…"` and the like are unwrapped. */
const DEPTH_MAX = 3;

export interface SummaryOptions {
  /** PowerShell: a backslash is a path separator, and the backquote escapes. */
  powershell?: boolean;
}

/** The summary of a command line or an argv; null when it runs nothing that can be named. */
export function summarizeCommand(
  command: string | readonly string[],
  options: SummaryOptions = {},
): string | null {
  const ps = options.powershell ?? false;
  if (typeof command === 'string') return render(summarize(command, 0, ps));
  const [bin = ''] = command;
  // ["git status && npm test"]: one word that is a whole command line.
  if (command.length === 1 && /\s/.test(bin)) return render(summarize(bin, 0, ps));
  return render(combine([describe([...command], 0)]));
}

/** A JavaScript call to a tool with a command (`tools.exec_command({ cmd: "…" })`). */
const TOOL_CALL =
  /\btools\.\w+\s*\(\s*\{[^}]*?\b(?:cmd|command)\s*:\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`|(\[[^\]]*\]))/g;

/**
 * Codex's `exec` code, by the commands it hands to tools: their summary, counted as one chain.
 * Null when it spells out none; the code itself never shows.
 */
export function summarizeCode(code: string): string | null {
  const parts: (Part | null)[] = [];
  for (const m of code.slice(0, SCAN_MAX).matchAll(TOOL_CALL)) {
    const literal = m[1] ?? m[2] ?? m[3];
    if (literal !== undefined) {
      const line = literal.replace(/\\(.)/gs, (_e, c: string) => (c === 'n' ? '\n' : c));
      parts.push(summarize(line, 0, false));
      continue;
    }
    try {
      const argv: unknown = JSON.parse(m[4] ?? '');
      if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string'))
        parts.push(describe(argv, 0));
    } catch {
      // Not a literal argv: nothing to name.
    }
  }
  return render(combine(parts));
}

/**
 * One command, or a chain as one: what it shows, how many commands follow it (an unwrapped
 * `bash -c "a && b"` is `a` and one more), and whether it is set-up (`cd`, `export`) that shows
 * only when nothing else runs.
 */
interface Part {
  text: string;
  more: number;
  setup?: boolean;
}

const part = (text: string): Part => ({ text, more: 0 });

function summarize(line: string, depth: number, ps: boolean): Part | null {
  return combine(segments(line, ps).map((words) => describe(words, depth)));
}

/** A chain as one part: its first command that runs something, and how many follow it. */
function combine(parts: (Part | null)[]): Part | null {
  let first: Part | null = null;
  let setup: Part | null = null;
  let more = 0;
  for (const p of parts) {
    if (p === null) continue;
    if (p.setup) setup ??= p;
    else if (first === null) {
      first = p;
      more += p.more;
    } else more += 1 + p.more;
  }
  return first === null ? setup : { text: first.text, more };
}

const render = (p: Part | null) =>
  p === null ? null : p.more > 0 ? `${p.text} +${p.more}` : p.text;

// ── Reading a command line ───────────────────────────────────────────────────────────────────

/** Characters a backslash escapes in a POSIX shell; before others it is kept (`C:\Users`). */
const ESCAPABLE = new Set([...' \t"\'\\$`;&|()<>*?[]#~=%!{}\n']);

/**
 * The simple commands of a line, split at `;`, `&&`, `||`, `|`, `&`, newlines and subshell
 * parentheses, each as its words with quotes removed. Comments and heredoc bodies are skipped.
 * `$(…)`, backquotes, `${…}` and `@{…}` stay inside their word. Linear in the line.
 */
function segments(line: string, ps: boolean): string[][] {
  const n = Math.min(line.length, SCAN_MAX);
  const segs: string[][] = [];
  const heredocs: string[] = [];
  let words: string[] = [];
  let word: string | null = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segs.push(words);
    words = [];
  };
  const add = (s: string) => {
    word = (word ?? '') + s;
  };
  /** The index just past the bracket that closes the one at `i`, quotes skipped. */
  const closing = (i: number, open: string, close: string) => {
    let depth = 0;
    let j = i;
    while (j < n) {
      const c = line[j];
      if (c === "'" || c === '"') {
        const e = line.indexOf(c, j + 1);
        j = e === -1 ? n : e + 1;
        continue;
      }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return j + 1;
      j++;
    }
    return n;
  };

  let i = 0;
  while (i < n) {
    const c = line[i] as string;
    const next = line[i + 1];
    if (c === '\n') {
      endSegment();
      i++;
      // Heredoc bodies start on the next line and end at their delimiter's line.
      for (const delimiter of heredocs.splice(0)) {
        while (i < line.length) {
          const e = line.indexOf('\n', i);
          const stop = e === -1 ? line.length : e;
          const body = line.slice(i, stop);
          i = stop + 1;
          if (body.trim() === delimiter) break;
        }
      }
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (c === '\\' && !ps) {
      if (next === '\n') i += 2;
      else if (next !== undefined && ESCAPABLE.has(next)) {
        add(next);
        i += 2;
      } else {
        add(c);
        i++;
      }
    } else if (c === '`' && ps) {
      if (next !== '\n') add(next ?? '');
      i += 2;
    } else if (c === "'") {
      const e = line.indexOf("'", i + 1);
      const stop = e === -1 || e > n ? n : e;
      add(line.slice(i + 1, stop));
      i = stop + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < n && line[j] !== '"') {
        const x = line[j] as string;
        if (((x === '\\' && !ps) || (x === '`' && ps)) && j + 1 < n) {
          const y = line[j + 1] as string;
          s += ps || '"\\$`\n'.includes(y) ? y : `\\${y}`;
          j += 2;
        } else {
          s += x;
          j++;
        }
      }
      add(s);
      i = j + 1;
    } else if (c === '`') {
      const e = line.indexOf('`', i + 1);
      const stop = e === -1 || e >= n ? n : e + 1;
      add(line.slice(i, stop));
      i = stop;
    } else if (c === '$' && next === "'" && !ps) {
      const e = line.indexOf("'", i + 2);
      const stop = e === -1 || e > n ? n : e;
      add(line.slice(i + 2, stop));
      i = stop + 1;
    } else if ((c === '$' || c === '@') && (next === '(' || next === '{')) {
      const stop = closing(i + 1, next, next === '(' ? ')' : '}');
      add(line.slice(i, stop));
      i = stop;
    } else if (c === '#' && word === null) {
      const e = line.indexOf('\n', i);
      i = e === -1 ? n : e;
    } else if (c === ';' || c === '|' || c === ')') {
      endSegment();
      i++;
    } else if (c === '&') {
      if (word !== null && /[<>]$/.test(word))
        add(c); // 2>&1
      else if (next === '>') {
        endWord();
        add(c); // &>file
      } else endSegment();
      i++;
    } else if (c === '(') {
      if (word === null) {
        endSegment(); // a subshell
        i++;
      } else {
        const stop = closing(i, '(', ')'); // f(…), [Env]::Set(…)
        add(line.slice(i, stop));
        i = stop;
      }
    } else if (c === '<' && next === '<' && line[i + 2] !== '<') {
      // <<EOF, <<-'EOF': the body is skipped at the next newline.
      endWord();
      let j = i + 2;
      if (line[j] === '-') j++;
      while (line[j] === ' ' || line[j] === '\t') j++;
      const m = /^(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|<>()]+))/.exec(line.slice(j, j + 256));
      if (m) {
        heredocs.push(m[1] ?? m[2] ?? m[3] ?? '');
        j += m[0].length;
      }
      i = j;
    } else {
      add(c);
      i++;
    }
  }
  // A word the scan limit cut could be anything: drop it.
  if (n < line.length) word = null;
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
  'command',
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

/** Programs that run another, with their options that take a value. Their values never show. */
const WRAPPERS: Record<string, { values: string[]; positional?: number }> = {
  env: { values: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'] },
  sudo: {
    values: ['-u', '--user', '-g', '--group', '-C', '-D', '--chdir', '-h', '--host', '-p'],
  },
  doas: { values: ['-u', '-C'] },
  time: { values: ['-f', '--format', '-o', '--output'] },
  nice: { values: ['-n', '--adjustment'] },
  ionice: { values: ['-c', '-n', '-p'] },
  timeout: { values: ['-s', '--signal', '-k', '--kill-after'], positional: 1 },
  stdbuf: { values: ['-i', '-o', '-e'] },
  watch: { values: ['-n', '--interval', '-d'] },
  xargs: { values: ['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a'] },
};

const SHELLS = /^(?:(?:ba|z|da|k|a|fi)?sh|pwsh|powershell|cmd)$/;

interface Interpreter {
  /** Flags whose next word is code: shown as the flag alone. */
  code: RegExp;
  /** Options whose next word is a value, not the script. */
  values?: string[];
  /** A flag that names a module to run (`python -m pytest`). */
  module?: string;
}
const PYTHON: Interpreter = { code: /^-c$/, values: ['-W', '-X', '-Q'], module: '-m' };
const NODE: Interpreter = {
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
  ],
};
const INTERPRETERS: Record<string, Interpreter> = {
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
const isPython = (key: string) => /^(?:python[\d.]*|py|pypy\d?|ipython)$/.test(key);

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
const SUBCOMMANDS: Record<string, string[]> = {
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
    '--as',
    '--as-group',
    '--certificate-authority',
    '--client-certificate',
    '--client-key',
    '-v',
    '--request-timeout',
  ],
  oc: ['-n', '--namespace', '--context', '--server', '--kubeconfig', '--user'],
  helm: ['-n', '--namespace', '--kube-context', '--kubeconfig', '--registry-config'],
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
  ],
  gcloud: ['--project', '--account', '--configuration', '--verbosity', '--format'],
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
  claude: ['--model', '--agents', '--settings'],
  opencode: [],
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

/** Subcommands that run something named next: `npm run build`, `uv run pytest`. */
const RUNNERS: Record<string, string[]> = {
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

/**
 * Option names that carry a credential: their value is skipped even when not listed, so it
 * cannot pass for a subcommand or a script.
 */
const SECRET_OPTION = /token|secret|key|pass|pwd|auth(?!or)|credential|cookie|session/i;

const isAssignment = (w: string) => /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(w);
/** PowerShell's `$x = …` or `$env:X="…"`, in either shell's command line. */
const isVariableSet = (w: string, next: string | undefined) =>
  /^\$[\w:]+(?:\.\w+)*[+\-*/]?=/.test(w) ||
  (/^\$[\w:]+$/.test(w) && /^[+\-*/]?=$/.test(next ?? ''));
const isRedirect = (w: string) => /^(?:\d*|&)(?:>>?|<)/.test(w);
/** A redirection with its target in the next word. */
const isBareRedirect = (w: string) => /^(?:\d*|&)(?:>>?|<)&?$|^<<<$/.test(w);

/**
 * A run of 12 letters and digits or more that mixes in digits, with capitals or many digits:
 * a key, a hash or a password, not a name. `x86_64-linux-gcc` and `python3.12` are names.
 * A name (`strict`) has no run of 16 or more with any digit, or of hex, either:
 * `deadbeefcafebabe` is a key, `SetEnvironmentVariable` a name.
 */
const RANDOM = /[A-Za-z0-9]{12,}/g;
function looksRandom(word: string, strict = true): boolean {
  for (const [run] of word.matchAll(RANDOM)) {
    if (strict && run.length >= 16 && /\d|^[a-f]+$/i.test(run)) return true;
    if (/\d/.test(run) && (/[A-Z]/.test(run) || /(?:\D*\d){4}/.test(run))) return true;
  }
  return false;
}

function describe(all: string[], depth: number): Part | null {
  // Redirections and their targets say nothing about what runs.
  const words: string[] = [];
  for (let j = 0; j < all.length; j++) {
    const w = all[j] as string;
    if (isRedirect(w) || w === '<<<') {
      if (isBareRedirect(w)) j++;
      continue;
    }
    words.push(w);
  }

  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return null;
    if (KEYWORDS.has(w.toLowerCase()) || isAssignment(w)) {
      i++;
      continue;
    }
    if (isVariableSet(w, words[i + 1])) return null;
    const wrapper = WRAPPERS[basename(w)];
    if (!wrapper) break;
    i = skipOptions(words, i + 1, wrapper.values) + (wrapper.positional ?? 0);
    // `env` alone lists the environment; `sudo -v` refreshes a ticket.
    if (i >= words.length) return part(basename(w));
  }

  const prog = programName(words[i] as string);
  if (prog === null) return null;
  const key = prog.toLowerCase();
  const rest = words.slice(i + 1);
  // A function's definition (`shoot() {`) runs nothing yet.
  if (SETUP.has(key) || /^[\w.:-]+\(\)$/.test(words[i] as string))
    return { text: prog, more: 0, setup: true };
  if (SHELLS.test(key)) return shell(prog, key, rest, depth);
  if (isPython(key) || INTERPRETERS[key]) return interpreter(prog, key, rest);
  if (FETCHERS.has(key)) return fetch(prog, key, rest);
  if (Object.hasOwn(SUBCOMMANDS, key)) return subcommand(prog, key, rest);
  return part(prog);
}

/** The index of the first word at or after `i` that is not an option or an option's value. */
function skipOptions(words: string[], i: number, values: string[] = []): number {
  let j = i;
  while (j < words.length) {
    const w = words[j] as string;
    if (w === '--') return j + 1;
    if (!w.startsWith('-') || w === '-') return j;
    const named = !w.includes('=') && (values.includes(w) || SECRET_OPTION.test(w));
    j += named ? 2 : 1;
  }
  return j;
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';

/**
 * A program as it shows: the name of what runs, not its path (`./scripts/x.sh` is `x.sh`,
 * `C:\Program Files\nodejs\node.exe` is `node`), cut before anything that is not part of a name
 * (`[IO.File]::Write(…)` is `[IO.File]::Write`). A command substitution shows as `$(…)`; a
 * word that looks like a key, or an option, shows as nothing.
 */
function programName(word: string): string | null {
  if (/^(?:\$\(|`)/.test(word)) return '$(…)';
  const windows = /^[A-Za-z]:[\\/]/.test(word);
  const path = (windows ? /^[\w.+@:%~\-[\] /\\()]+/ : /^[\w.+@:%~$\-[\]/\\]+/).exec(word)?.[0];
  const name = basename((path ?? '').trim())
    .replace(/\.exe$/i, '')
    .slice(0, 40);
  // `user:pass@host` is not a program; `[IO.File]::Write` is.
  if (name === '' || name.startsWith('-') || /@|(?:^|[^:]):(?:[^:]|$)/.test(name)) return null;
  if (looksRandom(name)) return null;
  return name;
}

/** A script's file name, when it reads as one: `scripts/build.py` is `build.py`. */
function scriptName(word: string | undefined): string | null {
  const name = basename(word ?? '');
  return /^[\w.@+][\w.@+-]{0,47}$/.test(name) && !looksRandom(name) ? name : null;
}

/** A word as a subcommand or script name: short and plain, not a value that slipped in. */
function subword(word: string | undefined): string | null {
  if (word === undefined || word.length > 32 || !/^[a-z0-9][\w.:-]*$/i.test(word)) return null;
  return looksRandom(word) ? null : word;
}

/** A package as npx and friends name it, without its version: `@biomejs/biome`, `vitest`. */
function packageName(word: string | undefined): string | null {
  const m = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+/i.exec(word ?? '');
  if (!m || m[0].length > 48 || looksRandom(m[0])) return null;
  return m[1] ? m[0] : subword(m[0]);
}

function withScript(prog: string, word: string | undefined): Part {
  const script = scriptName(word);
  return part(script ? `${prog} ${script}` : prog);
}

/** PowerShell switches that take no value. */
const NO_VALUE = /^-(?:nologo|noprofile|nop|noninteractive|noni|noexit|mta|sta|nol)$/i;

/** A shell: what its `-c` runs, unwrapped, or the script it runs. */
function shell(prog: string, key: string, rest: string[], depth: number): Part {
  const pwsh = key === 'pwsh' || key === 'powershell';
  const cmd = key === 'cmd';
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j] as string;
    const runs = cmd
      ? /^\/[ck]$/i.test(a)
      : pwsh
        ? /^-(?:c|command)$/i.test(a)
        : /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a);
    if (runs) {
      const code = cmd ? rest.slice(j + 1).join(' ') : rest[j + 1];
      const unwrapped =
        code === undefined || depth >= DEPTH_MAX ? null : summarize(code, depth + 1, pwsh || cmd);
      return unwrapped ?? part(`${prog} ${a}`);
    }
    if (pwsh && /^-(?:e|ec|enc|encodedcommand)$/i.test(a)) return part(`${prog} -EncodedCommand`);
    if (pwsh && /^-(?:f|file)$/i.test(a)) return withScript(prog, rest[j + 1]);
    if (cmd ? !a.startsWith('/') : !a.startsWith('-')) return withScript(prog, a);
    // bash -o pipefail, --rcfile f, pwsh -ExecutionPolicy Bypass: a value, not the script.
    if (/^(?:[-+]o|-O|--rcfile|--init-file)$/.test(a) || (pwsh && !NO_VALUE.test(a))) j++;
  }
  return part(prog);
}

/** An interpreter: its inline-code flag, its module, or its script's name. */
function interpreter(prog: string, key: string, rest: string[]): Part {
  const spec = INTERPRETERS[key] ?? PYTHON;
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j] as string;
    if (spec.code.test(a)) return part(`${prog} ${a}`);
    if (spec.module && a === spec.module) {
      const module = rest[j + 1];
      const name = module && /^[\w.]{1,40}$/.test(module) && !looksRandom(module) ? module : null;
      return part(name ? `${prog} -m ${name}` : `${prog} -m`);
    }
    if (a === '-') return part(`${prog} -`);
    if (a === '--' || (key === 'java' && a === '-jar')) return withScript(prog, rest[j + 1]);
    if (!a.startsWith('-')) return withScript(prog, a);
    if (!a.includes('=') && (spec.values?.includes(a) || SECRET_OPTION.test(a))) j++;
  }
  return part(prog);
}

/** A fetch: the host of its first URL that is not an option's value. */
function fetch(prog: string, key: string, rest: string[]): Part {
  let bare: string | null = null;
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j] as string;
    if (a.startsWith('-')) {
      const name = a.split('=')[0] ?? a;
      // Short options by case (curl's -O takes no value, wget's does); long ones and
      // PowerShell's in any case.
      const known = name.length > 2 ? FETCH_VALUES.has(name.toLowerCase()) : FETCH_VALUES.has(name);
      if (/^--?(?:url|uri)$/i.test(name)) {
        const host = hostOf(a.includes('=') ? a.slice(a.indexOf('=') + 1) : (rest[++j] ?? ''));
        if (host) return part(`${prog} ${host}`);
      } else if (
        !a.includes('=') &&
        (known || (name === '-O' && key === 'wget') || SECRET_OPTION.test(name))
      )
        j++;
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) {
      const host = hostOf(a);
      if (host) return part(`${prog} ${host}`);
    } else if (bare === null && HOST_LIKE.test(a)) bare = hostOf(`http://${a}`);
    else if (bare === null && /^:\d+(?:[/?#]|$)/.test(a))
      bare = `localhost${/^:\d+/.exec(a)?.[0] ?? ''}`; // httpie's :8080/x
  }
  return part(bare ? `${prog} ${bare}` : prog);
}
const HOST_LIKE =
  /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/;

/**
 * A URL's host and port, without its user or path; null when it has none. A label that looks
 * like a key (a tunnel's or a capability URL's random name) shows as "…".
 */
export function hostOf(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d+)?$/i.test(host)) return null;
  return host
    .split('.')
    .map((label) => (looksRandom(label, false) ? '…' : label))
    .join('.');
}

/** A program with subcommands: the subcommand, and what a runner subcommand runs. */
function subcommand(prog: string, key: string, rest: string[]): Part {
  const values = SUBCOMMANDS[key];
  // cargo +nightly test, make VAR=x test: neither is the subcommand.
  let j = skipOptions(rest, 0, values);
  while (j < rest.length && /^\+|^[A-Za-z_]\w*=/.test(rest[j] as string))
    j = skipOptions(rest, j + 1, values);
  const word = rest[j];
  const sub = PACKAGE_RUNNERS.has(key)
    ? packageName(word)
    : word && /[\\/]/.test(word) && /\.\w+$/.test(word)
      ? scriptName(word) // bun ./scripts/x.ts
      : subword(word);
  if (sub === null) return part(prog);
  const run = RUNNERS[key]?.includes(sub) ? runs(rest, j + 1) : null;
  return part(run ? `${prog} ${sub} ${run}` : `${prog} ${sub}`);
}

/** What a runner subcommand runs: a script, a package or a program, by name. */
function runs(rest: string[], from: number): string | null {
  const j = skipOptions(rest, from, RUNNER_VALUES);
  const word = rest[j];
  if (word === undefined) return null;
  if (word.startsWith('@')) return packageName(word);
  return /[\\/]/.test(word) ? scriptName(word) : subword(word);
}
