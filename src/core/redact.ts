/**
 * Defence in depth for the text an activity target still carries (a pattern, a task, a file
 * name, a command's summary): credentials masked whole, and the home directory shown as "~" so
 * the user name stays off the list. Targets go to every client on the session list.
 *
 * Pure, and free of Node built-ins: the web bundle imports the activity module too.
 */

export const MASK = '•••';

/** Words that make a variable, flag, header or key name a secret. "author" is not "auth". */
const WORD =
  '(?:token|secret|key|pass|pwd|auth(?!or(?:s|ed|ing|ship)?(?![a-z]))|credential|cookie|session)';
const NAME = String.raw`[\w-]*${WORD}[\w-]*`;
/** Names that mark a `name: value` pair without quotes, where prose would match the weak words. */
const STRONG = String.raw`[\w-]*(?:password|passwd|passphrase|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credentials?)[\w-]*`;
/**
 * A value as shells and code write it: escaped-quoted (JSON in a string), ANSI-C, double or
 * single quoted, or bare up to a separator. A quote left open runs to the end, so a value the
 * cut split is still masked whole.
 */
const VALUE = String.raw`\\"(?:[^"\\]|\\[^"])*(?:\\"|$)|\$'(?:[^'\\]|\\.)*'?|"[^"]*"?|'[^']*'?|[^\s"'&;|]+`;

const unquote = (v: string) => v.replace(/^\\?\$?["']|\\?["']$/g, '').trim();
const quoted = (v: string) => /^\\?\$?["']/.test(v);

// ── Shapes ────────────────────────────────────────────────────────────────────────────────

/** bPxRfiCYEXAMPLEKEY: a run whose case flips back and forth, unlike CamelCase. */
const flips = (p: string) =>
  p.length >= 10 &&
  (p.match(/[a-z][A-Z]/g)?.length ?? 0) >= 3 &&
  (p.match(/[A-Z]{2}/g)?.length ?? 0) >= 2;

/**
 * 40 base64 characters that read as an AWS secret key: digits in three runs, or case flipping
 * in two of its parts. A 40-character path such as `src/components/Header2/HeaderViewTestXYZ`
 * is neither.
 */
const awsSecret = (v: string) =>
  /[A-Z]/.test(v) &&
  /[a-z]/.test(v) &&
  /\d/.test(v) &&
  ((v.match(/\d+/g)?.length ?? 0) >= 3 || v.split(/[/+]/).filter(flips).length >= 2);

/**
 * Whether a word is shaped like a key, a token or a password rather than a name: what a summary
 * must not show in a slot meant for a program, a subcommand, a script or a host label. Names are
 * lowercase-ish words, or CamelCase without digits (`SetEnvironmentVariable`).
 */
export function secretShaped(word: string): boolean {
  const parts = word.split(/[-_.:@/+\\]+/).filter(Boolean);
  // Kx9mQ2pLvR7: capitals, small letters and digits in one part.
  if (parts.some((p) => p.length >= 6 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p)))
    return true;
  // Summer_2024_Pass, K7QPM-9XRT2-HVB4W: capitals and digits in a word of 8 or more.
  if (word.length >= 8 && /[A-Z]/.test(word) && /\d/.test(word)) return true;
  for (const p of parts) {
    // jbswy3dpehpk3pxp (base32), akiaiosfodnn7example: a long part with a digit; long hex.
    if (p.length >= 12 && /\d/.test(p)) return true;
    if (p.length >= 16 && /^[a-f]+$/i.test(p)) return true;
    // a1b2c3d4: digits in two runs or more.
    if (p.length >= 8 && (p.match(/\d+/g)?.length ?? 0) >= 2) return true;
    if (flips(p)) return true;
  }
  // k7qpm-9xrt2-hvb4w: three groups or more that mix letters and digits.
  if (parts.filter((p) => /\d/.test(p) && /\D/.test(p)).length >= 3) return true;
  // correct-horse-battery-staple: four long words or more.
  return parts.length >= 4 && parts.every((p) => /^\p{L}{5,}$/u.test(p));
}

/** Whether a value can be a credential: not a reference, a pattern, a number or a switch. */
export function secretish(raw: string): boolean {
  const v = unquote(raw);
  if (v === '' || v.startsWith(MASK)) return false;
  // $GH_TOKEN, ${…}, $(…), JSX key={…}, a regex escape or pattern, <placeholder>, %VAR%, env reads.
  if (/^(?:\$[{(\w]|[{\\<%.*^[(]|process\.env|os\.(?:environ|getenv)|getenv\b|ENV\[)/i.test(v))
    return false;
  if (/^[+-]?\d+(?:\.\d+)?[a-z]{0,2}$/i.test(v)) return false;
  return !/^(?:true|false|yes|no|on|off|null|nil|none|undefined)$/i.test(v);
}

/**
 * A word that reads as a token, not prose: eight characters or more with a digit, a capital
 * inside it or a symbol. "Bearer token" and "Basic authentication" stay.
 */
export function tokenLike(v: string): boolean {
  return (
    v.length >= 8 &&
    secretish(v) &&
    (/\d/.test(v) || /.[A-Z]/.test(v) || /[_+/=~.-]/.test(v.slice(1, -1)))
  );
}

type Replacer = (match: string, pre: string, value: string) => string;
const maskIf =
  (ok: (value: string) => boolean): Replacer =>
  (match, pre, value) =>
    ok(value) ? `${pre}${MASK}` : match;

/** `curl -u user:pass` hides the password; `curl -u key:` hides the key. */
const maskUser: Replacer = (match, pre, value) => {
  const at = value.indexOf(':');
  if (at < 0) return match;
  const pass = value.slice(at + 1);
  return pass ? `${pre}${value.slice(0, at)}:${MASK}` : `${pre}${MASK}:`;
};

/** Tokens known by their shape. `sk-` also starts branch and package names: see `knownToken`. */
const KNOWN =
  /\b(?:sk-[\w-]+|gh[pousr]_\w{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abprs]-[\w-]{10,}|xapp-\d-[\w-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[\w-]{35}|ya29\.[\w-]{20,}|xai-\w{20,}|hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{36}|pypi-[\w-]{50,}|whsec_[A-Za-z0-9+/=]{24,}|[sr]k_(?:live|test)_\w{16,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g;

/**
 * An `sk-` word is a key (Anthropic, OpenAI, DeepSeek, OpenRouter) when one of its dash-parts is
 * random: 16 characters or more with a digit. `sk-improve-session-handling` is a branch.
 */
const knownToken = (t: string) =>
  !t.startsWith('sk-') || t.split('-').some((p) => p.length >= 16 && /\d/.test(p)) ? MASK : t;

/**
 * Credentials a pattern, a task, code or a command can carry, masked in place. Each rule is
 * linear in its input, and runs on at most a few hundred characters.
 */
const RULES: [RegExp, Replacer][] = [
  // A private key: everything from its header on.
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*)/g, (_m, pre) => `${pre}${MASK}`],
  // SQL, before `NAME = value` reads `PASSWORD(` as a value: IDENTIFIED BY '…',
  // SET PASSWORD … = '…', PASSWORD('…').
  [
    new RegExp(
      String.raw`(\bidentified\s+(?:with\s+[\w$]+\s+)?(?:by|as)\s+(?:password\s*)?)(${VALUE})`,
      'gi',
    ),
    maskIf(secretish),
  ],
  [
    new RegExp(
      String.raw`(\bset\s+password\b[^=;\n]{0,80}=\s*(?:password\s*\(\s*)?)(${VALUE})`,
      'gi',
    ),
    maskIf(secretish),
  ],
  [new RegExp(String.raw`(\bpassword\s*\(\s*)(${VALUE})`, 'gi'), maskIf(secretish)],
  // GITHUB_TOKEN=…, --db-password=…, ?api_key=…, const apiKey = "…", $env:API_KEY = "…".
  [new RegExp(String.raw`(\b${NAME}\s*=\s*)(?!=)(${VALUE})`, 'gi'), maskIf(secretish)],
  // "password": "…", {\"token\":\"…\"}, {'key': '…'}, 'password' => '…'.
  [
    new RegExp(String.raw`(\\?["']${NAME}\\?["']\s*(?::|=>?)\s*)(${VALUE})`, 'gi'),
    maskIf(secretish),
  ],
  // password: …, apiKey: '…', anthropic_api_key: … (YAML, object literals).
  [new RegExp(String.raw`(\b${STRONG}\s*:\s*)(${VALUE})`, 'gi'), maskIf(secretish)],
  // -H "X-Api-Key: …", --header 'Cookie: …': the rest of the header.
  [
    new RegExp(String.raw`((?:-H|--header)[\s=]*["']?${NAME}\s*:\s*)([^"'\n]+)`, 'gi'),
    maskIf((v) => secretish(v.replace(/^(?:bearer|basic|token)\s+/i, ''))),
  ],
  // Bearer …, basic …, Authorization: token …, in any case.
  [/(\b(?:bearer|basic|token|digest)\s+)([\w.~+/=-]{8,})/gi, maskIf(tokenLike)],
  // --api-token …, --db-password "…", --cookie …: the next word.
  [
    new RegExp(
      String.raw`(--[\w-]*?(?:password|passwd|passphrase|token|secret|api-?key|apikey|access-?key|secret-?key|private-?key|credentials?|client-?secret|auth|cookie)(?:\s+|=\s*))(${VALUE})`,
      'gi',
    ),
    maskIf((v) => secretish(v) && !v.startsWith('-')),
  ],
  // curl -u user:pass, curl -u 'key:'. Only curl's: docker's -u is a user id.
  [/(\bcurl\b[^|;&\n]*?\s(?:-u|--user)[\s=]+["']?)([^\s"']+)/g, maskUser],
  // curl -b "sid=…".
  [new RegExp(String.raw`(\bcurl\b[^|;&\n]*?\s-b[\s=]*)(${VALUE})`, 'g'), maskIf(secretish)],
  // mysql -p…, -p'…', -p"…" (psql's -p is the port).
  [
    new RegExp(
      String.raw`(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^|;&\n]*?\s-p)(${VALUE})`,
      'g',
    ),
    maskIf(secretish),
  ],
  // docker login -p …, sshpass -p …, redis-cli -a …, openssl -pass pass:….
  [
    new RegExp(
      String.raw`(\b(?:docker|podman|nerdctl|helm|oras|skopeo)\b[^|;&\n]*?\blogin\b[^|;&\n]*?\s-p\s+)(${VALUE})`,
      'g',
    ),
    maskIf(secretish),
  ],
  [new RegExp(String.raw`(\bsshpass\s+-p\s*)(${VALUE})`, 'g'), maskIf(secretish)],
  [new RegExp(String.raw`(\bredis-cli\b[^|;&\n]*?\s-a\s+)(${VALUE})`, 'g'), maskIf(secretish)],
  [/(\s-pass(?:in|out)?\s+["']?pass:)([^\s"']+)/g, maskIf(secretish)],
  // keytool -storepass …, -keypass ….
  [
    new RegExp(String.raw`(\s-(?:src|dest)?(?:store|key)pass\s+)(${VALUE})`, 'g'),
    maskIf(secretish),
  ],
  // https://user:pass@host and redis://:pass@host, up to the last @ before the path.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"']*:)([^/\s"']+)(?=@)/gi, maskIf(secretish)],
  // https://<token>@host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@"']{16,})(?=@)/gi, maskIf(tokenLike)],
  // aws configure set aws_secret_access_key …
  [
    /(\b(?:aws_secret_access_key|aws_session_token|secret_access_key|secretaccesskey)["']?(?:\s*[=:]\s*|\s+)["']?)([A-Za-z0-9/+=]{16,})/gi,
    maskIf(() => true),
  ],
  // .netrc's "password …", SQL's PASSWORD '…', and prose that hands one over: a quoted value,
  // or a bare word that reads as a token ("password reset flow" stays).
  [
    new RegExp(String.raw`(\b(?:password|passwd|passphrase)\s+)(${VALUE})`, 'gi'),
    maskIf((v) => (quoted(v) ? secretish(v) : tokenLike(v))),
  ],
  // A bare random token: 20 letters and digits or more in one run (no - or _: file names have
  // them), with capitals, small letters and digits in 3 runs.
  [
    /(^|[^A-Za-z0-9])([A-Za-z0-9]{20,})(?![A-Za-z0-9])/g,
    maskIf((v) => /[A-Z]/.test(v) && /[a-z]/.test(v) && (v.match(/\d+/g)?.length ?? 0) >= 3),
  ],
  // A bare AWS secret key: 40 base64 characters that read as random.
  [/(^|[^A-Za-z0-9/+=])([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/g, maskIf(awsSecret)],
  // E-mail addresses: the domain stays, the person does not (G3).
  [
    /(^|[^\w.%+-])([\w.%+-]+)(?=@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![\w-]))/g,
    (_m, pre) => `${pre}${MASK}`,
  ],
];

/** Invisible characters that would split a token past the rules: zero-width and soft hyphen. */
const INVISIBLE = /[​-‍⁠﻿­]/g;

/** `s` with every credential the rules know masked whole, as "•••", and e-mails' persons. */
export function redact(s: string): string {
  let out = s.replace(INVISIBLE, '').replace(KNOWN, knownToken);
  for (const [re, to] of RULES) out = out.replace(re, to as (m: string, ...g: string[]) => string);
  return out;
}

// ── Home ──────────────────────────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The home directories in `env`, matched on a path boundary: HOME, and a Windows profile
 * (USERPROFILE, or a HOME like it) with either slash, doubled backslashes as JSON has them, and
 * its Git Bash (/c/Users/x) and WSL (/mnt/c/Users/x) spellings.
 */
export function homeMatcher(env: Env): RegExp | null {
  const alts: string[] = [];
  for (const home of [env.HOME, env.USERPROFILE]) {
    if (!home) continue;
    const win = /^([A-Za-z]):[\\/]+(.*)$/.exec(home);
    if (win) {
      const [, drive = '', rest = ''] = win;
      const parts = rest
        .split(/[\\/]+/)
        .filter(Boolean)
        .map(esc);
      if (parts.length === 0) continue;
      alts.push(`${drive}:${parts.map((p) => String.raw`[\\/]+${p}`).join('')}`);
      alts.push(`(?:/mnt)?/${drive}${parts.map((p) => `/${p}`).join('')}`);
    } else {
      const posix = home.replace(/\/+$/, '');
      if (posix.length > 1) alts.push(esc(posix));
    }
  }
  if (alts.length === 0) return null;
  return new RegExp(String.raw`(^|[^\w.~/\\-])(?:${alts.join('|')})(?=[/\\\s"'\`;:,)&|>]|$)`, 'gi');
}

const env = (globalThis as { process?: { env?: Env } }).process?.env ?? {};
const HOME_AT = homeMatcher(env);

/** The home directory as "~", as a shell prompt shows it. */
export function tildeHome(s: string, at: RegExp | null = HOME_AT): string {
  return at ? s.replace(at, '$1~') : s;
}
