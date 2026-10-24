/**
 * No credential leaves the server in an activity target. Commands show as summaries; the masker
 * guards what text still shows. The hostile inputs are the W6a fix-round-1 review's, with
 * synthetic secrets: random, seeded, and shaped like the real thing where it has a shape.
 */
import { describe, expect, it } from 'vitest';
import { activityTarget, sessionActivity } from './activity.js';
import type { ToolCall } from './model.js';
import { homeMatcher, tildeHome } from './redact.js';

let seed = 1234567;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed;
};
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGITS = '0123456789';
const gen = (n: number, al = ALNUM) =>
  Array.from({ length: n }, () => al[rnd() % al.length]).join('');
const upper = (n: number) => gen(n, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');

const at = '2026-01-01T00:00:00.000Z';
/** The target as the store lists it: a running tool's activity, from `sessionActivity`. */
function listed(name: string, input: unknown): string | null {
  const tool: ToolCall = {
    id: 't1',
    agentId: 'main',
    requestId: 'r',
    name,
    input,
    status: 'running',
    startedAt: at,
    endedAt: null,
    durationMs: null,
    resultPreview: null,
    hasFullResult: false,
    spawned: null,
  };
  const activity = sessionActivity({
    live: 'busy',
    toolCalls: [tool],
    requests: [],
    lastTurn: null,
    updatedAt: at,
  });
  const target = activity?.target ?? null;
  expect(target).toBe(activityTarget(name, input));
  return target;
}

/**
 * Every secret with a 6-character piece in the target, in any case: a host is lower-cased, so
 * an upper-case key in it would still show.
 */
function leaks(target: string | null, secrets: string[]): string[] {
  const out = (target ?? '').toLowerCase();
  const found: string[] = [];
  for (const s of secrets)
    for (let i = 0; i + 6 <= s.length; i++)
      if (out.includes(s.slice(i, i + 6).toLowerCase())) found.push(s);
  return [...new Set(found)];
}

/** [label, the command, its secrets]. Secrets are made once, when the table is built. */
type Hostile = [string, string, string[]];
const hostile = (label: string, make: (s: string[]) => string, ...secrets: string[]): Hostile => [
  label,
  make(secrets),
  secrets,
];

const HOSTILE: Hostile[] = [
  // Names and their case.
  hostile('lowercase api_key=', (s) => `api_key=${s[0]} node run.js`, gen(24)),
  hostile('Api-Key header', (s) => `curl -H 'Api-Key: ${s[0]}' https://x.io`, gen(24)),
  hostile('x-api-key header, no space', (s) => `curl -H "x-api-key:${s[0]}" https://x.io`, gen(24)),
  hostile('Api-Key= mixed case', (s) => `Api-Key=${s[0]} ./run`, gen(24)),
  // Prefixes.
  hostile('export NAME=', (s) => `export MY_API_KEY=${s[0]} && run`, gen(24)),
  hostile('cmd set NAME=', (s) => `set MY_API_KEY=${s[0]} && run.cmd`, gen(24)),
  hostile('env NAME=', (s) => `env SERVICE_TOKEN=${s[0]} node x.js`, gen(24)),
  hostile(
    'quoted value with spaces',
    (s) => `export API_SECRET="${s[0]} ${s[1]}" && run`,
    gen(12),
    gen(12),
  ),
  hostile('quoted value, leading space', (s) => `export API_SECRET=" ${s[0]}" && run`, gen(24)),
  hostile('PowerShell $env:X="…"', (s) => `$env:OPENAI_API_KEY="${s[0]}"; codex`, gen(24)),
  hostile('PowerShell $env:X = "…"', (s) => `$env:OPENAI_API_KEY = "${s[0]}"; codex`, gen(24)),
  hostile(
    'PowerShell SetEnvironmentVariable',
    (s) => `[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "${s[0]}", "User")`,
    gen(24),
  ),
  // Flags.
  hostile('--token=x', (s) => `tool --token=${s[0]} run`, gen(24)),
  hostile('--token x', (s) => `tool --token ${s[0]} run`, gen(24)),
  hostile('-t x', (s) => `tool -t ${s[0]} run`, gen(24)),
  hostile('--api-token x', (s) => `tool --api-token ${s[0]} run`, gen(24)),
  hostile(
    '--http-password x',
    (s) => `wget --http-user=me --http-password ${s[0]} https://x.io/f`,
    gen(24),
  ),
  hostile('--db-password x', (s) => `app migrate --db-password ${s[0]}`, gen(24)),
  hostile('--password "x"', (s) => `vault login --password "${s[0]}"`, gen(24)),
  hostile('docker login -p x', (s) => `docker login -u me -p ${s[0]} reg.io`, gen(24)),
  hostile('sshpass -p x', (s) => `sshpass -p ${s[0]} ssh me@host`, gen(24)),
  hostile(
    'openssl -pass pass:x',
    (s) => `openssl enc -aes-256-cbc -pass pass:${s[0]} -in a -out b`,
    gen(24),
  ),
  hostile('mysql -px', (s) => `mysql -u root -p${s[0]} shop`, gen(24)),
  // Headers and auth schemes.
  hostile(
    'Authorization: token x',
    (s) => `curl -H "Authorization: token ${s[0]}" https://api.github.com`,
    gen(24),
  ),
  hostile(
    'code Authorization: token x',
    (s) => `node -e "fetch(u,{headers:{Authorization:'token ${s[0]}'}})"`,
    gen(24),
  ),
  hostile(
    'extraheader basic, lowercase',
    (s) => `git -c http.extraheader="AUTHORIZATION: basic ${s[0]}" fetch`,
    gen(24),
  ),
  hostile('code bearer, lowercase', (s) => `node -e "h={authorization:'bearer ${s[0]}'}"`, gen(24)),
  hostile('-H Cookie: sid=', (s) => `curl -H "Cookie: sid=${s[0]}" https://x.io`, gen(24)),
  hostile('--cookie "sid=…"', (s) => `curl --cookie "sid=${s[0]}" https://x.io`, gen(24)),
  hostile('-b sid=…', (s) => `curl -b sid=${s[0]} https://x.io`, gen(24)),
  // JSON, dicts, config text.
  hostile('JSON body password', (s) => `curl -d '{"password":"${s[0]}"}' https://x.io`, gen(24)),
  hostile('escaped JSON', (s) => `curl -d "{\\"password\\":\\"${s[0]}\\"}" https://x.io`, gen(24)),
  hostile(
    'python dict',
    (s) => `python -c "requests.post(u, json={'password': '${s[0]}'})"`,
    gen(24),
  ),
  hostile(
    'python attribute = …',
    (s) => `python -c "import openai; openai.api_key = '${s[0]}'"`,
    gen(24),
  ),
  hostile(
    'js const apiKey = "…"',
    (s) => `node -e 'const apiKey = "${s[0]}"; go(apiKey)'`,
    gen(24),
  ),
  hostile('YAML heredoc', (s) => `cat > cfg.yml <<EOF\nanthropic_api_key: ${s[0]}\nEOF`, gen(24)),
  hostile(
    '.netrc line',
    (s) => `printf 'machine api.x.io login me password ${s[0]}\\n' >> ~/.netrc`,
    gen(24),
  ),
  hostile(
    '.netrc heredoc',
    (s) => `cat > ~/.netrc <<EOF\nmachine x.io\nlogin me\npassword ${s[0]}\nEOF`,
    gen(24),
  ),
  hostile(
    '.npmrc _authToken=',
    (s) => `echo "//registry.npmjs.org/:_authToken=${s[0]}" > .npmrc`,
    gen(24),
  ),
  hostile(
    'kubectl --from-literal',
    (s) => `kubectl create secret generic x --from-literal=password=${s[0]}`,
    gen(24),
  ),
  hostile('vault kv put value=', (s) => `vault kv put secret/app value=${s[0]}`, gen(24)),
  hostile('gh secret set --body', (s) => `gh secret set FOO --body ${s[0]}`, gen(24)),
  hostile(
    'echo | docker login',
    (s) => `echo ${s[0]} | docker login -u me --password-stdin`,
    gen(24),
  ),
  // AWS.
  hostile(
    'aws configure set',
    (s) => `aws configure set aws_secret_access_key ${s[0]}`,
    gen(40, B64),
  ),
  hostile('AWS_SECRET_ACCESS_KEY=', (s) => `AWS_SECRET_ACCESS_KEY=${s[0]} aws s3 ls`, gen(40, B64)),
  hostile('AKIA id and secret, bare', (s) => `deploy AKIA${s[0]} ${s[1]}`, upper(16), gen(40, B64)),
  hostile('ASIA id, bare', (s) => `deploy ASIA${s[0]}`, upper(16)),
  // Known token shapes, bare.
  hostile('Anthropic sk-ant-api03', (s) => `run sk-ant-api03-${s[0]}`, gen(60)),
  hostile('Anthropic sk-ant-oat01', (s) => `run sk-ant-oat01-${s[0]}`, gen(60)),
  hostile('OpenAI sk-proj-', (s) => `run sk-proj-${s[0]}`, gen(60)),
  hostile('OpenAI legacy sk-', (s) => `run sk-${s[0]}`, gen(48)),
  hostile('xAI', (s) => `run xai-${s[0]}`, gen(80)),
  hostile(
    'Slack xoxb-',
    (s) => `slack xoxb-${s[0]}`,
    `${gen(11, DIGITS)}-${gen(13, DIGITS)}-${gen(24)}`,
  ),
  hostile(
    'Slack xapp-',
    (s) => `slack xapp-1-${s[0]}`,
    `A${upper(10)}-${gen(13, DIGITS)}-${gen(64, 'abcdef0123456789')}`,
  ),
  hostile(
    'Slack webhook URL',
    (s) => `curl -X POST https://hooks.slack.com/services/T0AAAA/B0BBBB/${s[0]}`,
    gen(24),
  ),
  hostile('Stripe sk_live_', (s) => `stripe sk_live_${s[0]}`, gen(24)),
  hostile('Stripe rk_test_', (s) => `stripe rk_test_${s[0]}`, gen(24)),
  hostile('Stripe whsec_', (s) => `stripe listen whsec_${s[0]}`, gen(32)),
  hostile('GitHub ghs_ and ghr_', (s) => `x ghs_${s[0]} ghr_${s[1]}`, gen(36), gen(36)),
  hostile('GitHub github_pat_', (s) => `x github_pat_${s[0]}`, `${gen(22)}_${gen(59)}`),
  hostile('Google AIza', (s) => `x AIza${s[0]}`, gen(35)),
  hostile('Google ya29.', (s) => `x ya29.${s[0]}`, gen(100)),
  hostile('Hugging Face hf_', (s) => `x hf_${s[0]}`, gen(34)),
  hostile('npm npm_', (s) => `x npm_${s[0]}`, gen(36)),
  hostile('JWT', (s) => `x eyJ${s[0]}.${s[1]}.${s[2]}`, gen(30), gen(40), gen(43)),
  // URLs.
  hostile('https://user:pass@host', (s) => `git clone https://bob:${s[0]}@git.x.io/r.git`, gen(24)),
  hostile('redis://:pass@host', (s) => `redis-cli -u redis://:${s[0]}@cache:6379`, gen(24)),
  hostile('https://token@host', (s) => `git clone https://${s[0]}@github.com/o/r`, gen(24)),
  hostile('postgres URL in quotes', (s) => `psql "postgresql://app:${s[0]}@db:5432/shop"`, gen(24)),
  hostile(
    'password holding @',
    (s) => `git clone https://bob:${s[0]}@${s[1]}@git.x.io/r.git`,
    gen(8),
    gen(8),
  ),
  hostile('node arg redis://:pass@', (s) => `node worker.js redis://:${s[0]}@cache:6379`, gen(20)),
  hostile(
    'REDIS_URL=redis://:pass@',
    (s) => `REDIS_URL=redis://:${s[0]}@cache:6379 node w.js`,
    gen(20),
  ),
  // curl -u.
  hostile("curl -u 'user:pass'", (s) => `curl -u 'admin:${s[0]}' https://x.io`, gen(24)),
  hostile('curl -u "user:pass"', (s) => `curl -u "admin:${s[0]}" https://x.io`, gen(24)),
  hostile('curl -u key:', (s) => `curl -u ${s[0]}: https://api.x.io`, gen(24)),
  // The cuts: 480 read, 120 shown.
  hostile('ghp_ across the 480 read', (s) => `echo${' '.repeat(462)} ghp_${s[0]} done`, gen(36)),
  hostile(
    'sk-ant across the 480 read',
    (s) => `run${' '.repeat(453)} sk-ant-api03-${s[0]}`,
    gen(60),
  ),
  hostile('NAME= across the 480 read', (s) => `run${' '.repeat(460)} MY_TOKEN=${s[0]} x`, gen(30)),
  hostile('ghp_ at the 120 shown', (s) => `${'x'.repeat(112)} ghp_${s[0]}`, gen(36)),
  // Repeats, paths, code, generic randoms.
  hostile(
    'the same secret twice',
    (s) => `A_TOKEN=${s[0]} B_TOKEN=${s[0]} run; echo ghp_${s[1]} ghp_${s[1]}`,
    gen(20),
    gen(36),
  ),
  hostile('a secret in a path', (s) => `cat /run/creds/ghp_${s[0]}/token.txt`, gen(36)),
  hostile(
    '.env heredoc',
    (s) => `cat > .env <<'EOF'\nOPENAI_API_KEY=${s[0]}\nDB_PASSWORD=${s[1]}\nEOF`,
    gen(30),
    gen(16),
  ),
  hostile('long base64, no name', (s) => `echo ${s[0]} | base64 -d > key.bin`, gen(64, B64)),
  hostile(
    'long hex, no name',
    (s) => `curl https://x.io/hook/${s[0]}`,
    gen(64, 'abcdef0123456789'),
  ),
  hostile("ANSI-C quoted SECRET=$'…'", (s) => `SECRET=$'${s[0]}' run`, gen(20)),
  hostile('a variable on its own line', (s) => `PASSWORD=${s[0]}\nnext`, gen(20)),
  hostile('mysql --password x', (s) => `mysql --user=root --password ${s[0]} db`, gen(20)),
  hostile(
    'client_secret in a form',
    (s) => `curl --data-urlencode "client_secret=${s[0]}" https://x.io/token`,
    gen(20),
  ),
  hostile(
    'password grant',
    (s) => `curl -d "grant_type=password&username=u&password=${s[0]}" https://x.io`,
    gen(20),
  ),
  hostile('bearer, no space', (s) => `curl -H "Authorization:Bearer ${s[0]}" x`, gen(20)),
  hostile('the secret as the program', (s) => `${s[0]} --help`, gen(24)),
  hostile('the secret as a subcommand', (s) => `git --password ${s[0]} status`, gen(24)),
  hostile('the secret as a script', (s) => `python ${s[0]}.py`, gen(24)),
  hostile('user:pass@host as the program', (s) => `admin:${s[0]}@db status`, gen(24)),
  hostile(
    'a lowercase secret as the program',
    (s) => `${s[0]} --help`,
    gen(24, 'abcdef0123456789'),
  ),
  hostile(
    'a capability host',
    (s) => `curl https://${s[0]}.ngrok-free.app/hook`,
    gen(16, 'abcdefghjkmnpqrstuvwxyz23456789'),
  ),
];

/**
 * The fix-round-2 review's attacks on the summary itself, with its own secrets: shaped to slip
 * past a "random" test (short, lowercase, word-like, split by `_` or `-`), or to land in a
 * subcommand, script, module, package or host slot, or to reach the program slot through a
 * mis-read line. One AWS-shaped host moves from example.com to x.io: its key ends in EXAMPLE.
 */
const R = {
  short: 'Kx9mQ2pLvR7',
  pw: 'Summer_2024_Pass',
  dice: 'correct-horse-battery-staple',
  grouped: 'K7QPM-9XRT2-HVB4W-3JDNY',
  awsSecret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  sym: 'Tr0ub4dor!xq9Zk2Lm',
  otp: '493817',
  b32: 'jbswy3dpehpk3pxp',
  mixedHost: 'Ab1cDe2fGh3iJkLm',
  akid: 'AKIAIOSFODNN7EXAMPLE',
  ghp: 'ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3h',
  ant: 'sk-ant-api03-Zq8Xw2Lk9Pm4Nv7Rt1Ys6Ub3Hc5Jd0Fg',
  zw: 'aB3dE6gH9j​K2mN5pQ8sT​1vW4yZ7bC0',
  rand24: 'Qz7RkW2mXp9LvT4nHc8JbF5d',
};
const REVIEW: Hostile[] = [
  ['npm --otp <otp> publish', `npm --otp ${R.otp} publish`, [R.otp]],
  ['pnpm --otp <otp> publish', `pnpm --otp ${R.otp} publish`, [R.otp]],
  ['git <short> status', `git ${R.short} status`, [R.short]],
  ['vault <pw>', `vault ${R.pw}`, [R.pw]],
  ['claude -p <short> (a prompt)', `claude -p ${R.short}`, [R.short]],
  ['npm exec -- <pw>', `npm exec -- ${R.pw}`, [R.pw]],
  ['npx <grouped key>', `npx ${R.grouped}`, [R.grouped]],
  ['npx pkg@<rand24>', `npx left-pad@${R.rand24}`, [R.rand24]],
  ['npx @scope/pkg@<ghp>', `npx @acme/cli@${R.ghp} run`, [R.ghp]],
  ['./sk-ant-….sh', `./${R.ant}.sh --go`, [R.ant.slice(13)]],
  ['python <pw>.py', `python ${R.pw}.py`, [R.pw]],
  ['bash /tmp/<aws secret>.sh', `bash /tmp/${R.awsSecret}.sh`, ['bPxRfiCYEXAMPLEKEY']],
  ['an AWS secret as the program', `${R.awsSecret} --help`, ['bPxRfiCYEXAMPLEKEY']],
  ['java -jar <short>.jar', `java -jar ${R.short}.jar`, [R.short]],
  ['curl https://<AKIA>@host', `curl https://${R.akid}@api.x.io/v1`, [R.akid]],
  ['curl ghp_….example.com', `curl ${R.ghp}.example.com`, [R.ghp.slice(4)]],
  ['curl https://<AKIA>.x.io (lower-cased)', `curl https://${R.akid}.x.io/x`, [R.akid]],
  ['curl https://<mixed>.x.io (lower-cased)', `curl https://${R.mixedHost}.x.io/`, [R.mixedHost]],
  ['curl https://<base32>.example.com', `curl https://${R.b32}.example.com`, [R.b32]],
  ['wget ftp://u:<rand24>@host', `wget ftp://u:${R.rand24}@files.x.io/f`, [R.rand24]],
  ['curl --url=https://<rand24>@host', `curl --url=https://${R.rand24}@h.io`, [R.rand24]],
  ['curl h.io:<otp>@evil.io', `curl h.io:${R.otp}@evil.io`, [R.otp]],
  ['curl http://admin:<rand24>@[::1]', `curl "http://admin:${R.rand24}@[::1]:8080/"`, [R.rand24]],
  ['python -m <pw>', `python -m ${R.pw}`, [R.pw]],
  ['python3 -m <short>', `python3 -m ${R.short}`, [R.short]],
  ['<short> | docker login', `${R.short} | docker login --password-stdin`, [R.short]],
  ['export X=1; <pw>', `export X=1; ${R.pw}`, [R.pw]],
  ["export DB_PASS=$'it\\'s; <pw>'", `export DB_PASS=$'it\\'s; ${R.pw}'`, [R.pw]],
  ["PGPASSWORD=$'x\\'; <short>' psql", `PGPASSWORD=$'x\\'; ${R.short}' psql`, [R.short]],
  ['<sym> as the program', `${R.sym} --version`, [R.sym.slice(0, 9)]],
  [
    'sudo -E env … time nohup node',
    `sudo -E env API_KEY=${R.rand24} PASS=${R.pw} time nohup node srv.js`,
    [R.rand24, R.pw],
  ],
  ['sudo -r <pw> make', `sudo -r ${R.pw} make`, [R.pw]],
  ['watch -n 1 "<short> --x"', `watch -n 1 "${R.short} --x"`, [R.short]],
  ['timeout --preserve-status 10 <pw>', `timeout --preserve-status 10 ${R.pw}`, [R.pw]],
  ['ls | xargs -J % <pw> %', `ls | xargs -J % ${R.pw} %`, [R.pw]],
  ['docker run image:<rand24>', `docker run --rm registry.x.io/app:${R.rand24}`, [R.rand24]],
  ['docker -H tcp://u:<rand24>@h', `docker -H tcp://u:${R.rand24}@h:2376 ps`, [R.rand24]],
  ['git push https://<ghp>@github.com', `git push https://${R.ghp}@github.com/o/r main`, [R.ghp]],
  ['git -c remote url with <pw>', `git -c remote.origin.url=https://x:${R.pw}@h/r fetch`, [R.pw]],
  ['gh auth login <<< <ghp>', `gh auth login --with-token <<< ${R.ghp}`, [R.ghp]],
  ['<<<<pw> first', `<<<${R.pw} gh auth login --with-token`, [R.pw]],
  ['a zero-width split secret as the program', `${R.zw} --help`, ['aB3dE6gH9j', 'K2mN5pQ8sT']],
  [
    'a zero-width split ghp_ as a subcommand',
    `gh ${R.ghp.slice(0, 14)}​${R.ghp.slice(14)}`,
    [R.ghp.slice(4, 14)],
  ],
  ['a homoglyph pаssword= (Cyrillic а)', `pаssword=${R.short} run`, [R.short]],
  ['backquotes', `\`echo ${R.pw}\` --x`, [R.pw]],
  ['$(…) as the program', `$(printf ${R.pw}) run`, [R.pw]],
  ['$(…) with an escaped quote', `X="$(echo "a\\"b)" ; ${R.pw} )"`, [R.pw]],
  ['a quoted program', `"${R.short}" --x`, [R.short]],
  ['a CRLF continuation, then a secret line', `export A=1 \\\r\n${R.pw} --go`, [R.pw]],
  ['heredoc delimiter <<"E"OF', `cat <<"E"OF\n${R.pw} x\nEOF\n`, [R.pw]],
  ['a heredoc in $( ) with ) in its body', `X=$(cat <<EOF\n)\n${R.pw} run\nEOF\n)`, [R.pw]],
  ['a PowerShell here-string', `$b = @"\n{"note": "5' 11""}\n${R.pw} --x\n"@`, [R.pw]],
  ['a PowerShell & { … } block', `& { ${R.short} --x }`, [R.short]],
  ['cmd /c "set X=…&& run.cmd"', `cmd /c "set PASSWORD=${R.pw}&& run.cmd"`, [R.pw]],
  ['a secret across the 8000 read', `${'true; '.repeat(1333)}x${R.pw}${R.short}`, [R.pw]],
  ['a program longer than a name', `${R.dice}-and-more-words-here-too --x`, ['words-here']],
  ['a passphrase as the program', R.dice, [R.dice]],
  [
    'PowerShell: ConvertTo-SecureString after a CRLF backquote',
    `$pw = ConvertTo-SecureString \`\r\n  "${R.pw}" -AsPlainText -Force`,
    [R.pw],
  ],
];

/** Each shell tool's input shape for a command line. */
const FORMS: [string, (c: string) => [string, unknown]][] = [
  ['Claude Code Bash', (c) => ['Bash', { command: c }]],
  ['Codex argv bash -lc', (c) => ['shell', { command: ['bash', '-lc', c] }]],
  ['Codex argv, split on spaces', (c) => ['shell', { command: c.split(/\s+/).filter(Boolean) }]],
  ['Codex exec_command', (c) => ['exec_command', { cmd: c }]],
  ['Codex exec code', (c) => ['exec', `await tools.exec_command({ cmd: ${JSON.stringify(c)} });`]],
  ['Grok run_terminal_command', (c) => ['run_terminal_command', { command: c }]],
  ['OpenCode pending raw input', (c) => ['bash', JSON.stringify({ command: c })]],
  ['PowerShell', (c) => ['PowerShell', { command: c }]],
  ['argv pwsh -Command', (c) => ['shell', { command: ['pwsh', '-Command', c] }]],
];

describe('no secret survives in a command target', () => {
  for (const [form, shape] of FORMS)
    it.each([...HOSTILE, ...REVIEW])(`${form}: %s`, (_label, command, secrets) => {
      const [name, input] = shape(command);
      expect(leaks(listed(name, input), secrets)).toEqual([]);
    });
});

describe('a key-shaped program leaves the command unnamed; other slots drop out', () => {
  it.each([
    [`${R.short} | docker login --password-stdin`, null],
    [`export X=1; ${R.pw}`, null],
    [`npm test; ${R.short}`, 'npm test +1'],
    [`bash -c "${R.short} --x"`, null],
    [`git ${R.short} status`, 'git'],
    [`npx ${R.grouped}`, 'npx'],
    [`python ${R.pw}.py`, 'python'],
    [`python3 -m ${R.short}`, 'python3 -m'],
    [`java -jar ${R.short}.jar`, 'java'],
    [`npm exec -- ${R.pw}`, 'npm exec'],
    [`curl https://${R.b32}.example.com`, 'curl ….example.com'],
  ])('%j → %j', (command, expected) => {
    expect(listed('Bash', { command })).toBe(expected);
  });
});

describe('no secret survives in the other inputs', () => {
  const [ant, a, b, c, d, e, f] = [gen(50), gen(30), gen(30), gen(30), gen(30), gen(30), gen(30)];
  const cases: [string, string, unknown, string[]][] = [
    ['a key in a file name', 'Read', { file_path: `/x/keys/sk-ant-api03-${ant}.txt` }, [ant]],
    ['a URL with ?api_key=', 'WebFetch', { url: `https://api.x.io/v1?api_key=${a}` }, [a]],
    ['a URL without a scheme', 'WebFetch', { url: `api.x.io/v1?token=${b}` }, [b]],
    ['Codex argv curl -u', 'shell', { command: ['curl', '-u', `admin:${c}`, 'https://x.io'] }, [c]],
    ['Codex argv env', 'shell', { command: ['env', `OPENAI_API_KEY=${d}`, 'codex'] }, [d]],
    ['Codex argv --password', 'shell', { command: ['psql', '--password', e] }, [e]],
    ['Codex exec code with a key', 'exec', `const apiKey = "${f}";\nawait run(apiKey)`, [f]],
  ];
  it.each(cases)('%s', (_label, name, input, secrets) => {
    expect(leaks(listed(name, input), secrets)).toEqual([]);
  });
});

/**
 * Text that still shows (a pattern, a task, a question) is masked in place. Each case reaches
 * the target as a Grep pattern and as a task, through the store's path.
 */
const IN_TEXT: Hostile[] = [
  hostile('spaces round =', (s) => `api_key = ${s[0]}`, gen(24)),
  hostile('$env:X = "…"', (s) => `$env:OPENAI_API_KEY = "${s[0]}"`, gen(24)),
  hostile('const apiKey = "…"', (s) => `const apiKey = "${s[0]}"; go(apiKey)`, gen(24)),
  hostile("openai.api_key = '…'", (s) => `openai.api_key = '${s[0]}'`, gen(24)),
  hostile('--password "…"', (s) => `vault login --password "${s[0]}"`, gen(24)),
  hostile('a quoted value with spaces', (s) => `PASSWORD="${s[0]} ${s[1]}"`, gen(12), gen(12)),
  hostile('--api-token', (s) => `tool --api-token ${s[0]}`, gen(24)),
  hostile('--db-password', (s) => `app --db-password ${s[0]}`, gen(24)),
  hostile('--http-password', (s) => `wget --http-password ${s[0]} https://x.io`, gen(24)),
  hostile('--client-secret=', (s) => `tool --client-secret=${s[0]}`, gen(24)),
  hostile('authorization: bearer', (s) => `authorization: bearer ${s[0]}`, gen(24)),
  hostile('AUTHORIZATION: basic', (s) => `AUTHORIZATION: basic ${s[0]}`, gen(24)),
  hostile('Authorization: token', (s) => `Authorization: token ${s[0]}`, gen(24)),
  hostile('redis://:pass@', (s) => `redis://:${s[0]}@cache:6379`, gen(24)),
  hostile('a password holding @', (s) => `https://bob:${s[0]}@${s[1]}@git.x.io/r`, gen(8), gen(8)),
  hostile('https://token@', (s) => `https://${s[0]}@github.com/o/r`, gen(24)),
  hostile('escaped JSON', (s) => `{\\"password\\":\\"${s[0]}\\"}`, gen(24)),
  hostile('JSON', (s) => `{"client_secret": "${s[0]}"}`, gen(24)),
  hostile('a python dict', (s) => `{'password': '${s[0]}'}`, gen(24)),
  hostile(
    'aws configure set',
    (s) => `aws configure set aws_secret_access_key ${s[0]}`,
    gen(40, B64),
  ),
  hostile('YAML', (s) => `x_api_key: ${s[0]}`, gen(24)),
  hostile('.netrc', (s) => `machine api.x.io login me password ${s[0]}`, gen(24)),
  hostile('--cookie "sid=…"', (s) => `curl --cookie "sid=${s[0]}" https://x.io`, gen(24)),
  hostile('curl -b', (s) => `curl -b sid=${s[0]} https://x.io`, gen(24)),
  hostile('Cookie header', (s) => `curl -H "Cookie: sid=${s[0]}" https://x.io`, gen(24)),
  hostile("curl -u 'user:pass'", (s) => `curl -u 'admin:${s[0]}' https://x.io`, gen(24)),
  hostile('curl -u key:', (s) => `curl -u ${s[0]}: https://x.io`, gen(24)),
  hostile('docker login -p', (s) => `docker login -u me -p ${s[0]} reg.io`, gen(24)),
  hostile('sshpass -p', (s) => `sshpass -p ${s[0]} ssh host`, gen(24)),
  hostile('openssl pass:', (s) => `openssl enc -pass pass:${s[0]}`, gen(24)),
  hostile('redis-cli -a', (s) => `redis-cli -a ${s[0]} ping`, gen(24)),
  hostile("SECRET=$'…'", (s) => `SECRET=$'${s[0]}' run`, gen(20)),
  hostile('a password in a task', (s) => `use password ${s[0]} for staging`, gen(30)),
  hostile(
    'a private key',
    (s) => `-----BEGIN OPENSSH PRIVATE KEY-----\n${s[0]}\n${s[1]}`,
    gen(64, B64),
    gen(64, B64),
  ),
  hostile('sk-ant in a pattern', (s) => `sk-ant-api03-${s[0]}`, gen(60)),
  hostile('a DeepSeek key', (s) => `sk-${s[0]}`, gen(32, 'abcdef0123456789')),
  hostile('ghp_ across the 480 read', (s) => `find${' '.repeat(462)} ghp_${s[0]} done`, gen(36)),
  hostile(
    'sk-ant across the 480 read',
    (s) => `run${' '.repeat(453)} sk-ant-api03-${s[0]}`,
    gen(60),
  ),
  hostile('NAME= across the 480 read', (s) => `run${' '.repeat(460)} MY_TOKEN=${s[0]} x`, gen(30)),
  hostile(
    'a quoted value across the 480 read',
    (s) => `run${' '.repeat(460)} PASSWORD="${s[0]} ${s[1]}"`,
    gen(12),
    gen(12),
  ),
  hostile('ghp_ at the 120 shown', (s) => `${'x'.repeat(112)} ghp_${s[0]}`, gen(36)),
  // Round 3: quoted values after a bare keyword, SQL, more flags, bare randoms, invisibles.
  hostile("password '…'", (s) => `password '${s[0]}'`, gen(16)),
  hostile('password "…"', (s) => `password "${s[0]}"`, gen(16)),
  hostile("CREATE ROLE … PASSWORD '…'", (s) => `CREATE ROLE app LOGIN PASSWORD '${s[0]}'`, gen(16)),
  hostile(
    "with encrypted password '…'",
    (s) => `create user app with encrypted password '${s[0]}'`,
    gen(16),
  ),
  hostile("IDENTIFIED BY '…'", (s) => `ALTER USER root IDENTIFIED BY '${s[0]}'`, gen(16)),
  hostile(
    "IDENTIFIED WITH plugin BY '…'",
    (s) => `CREATE USER u IDENTIFIED WITH mysql_native_password BY '${s[0]}'`,
    gen(16),
  ),
  hostile("SET PASSWORD FOR … = '…'", (s) => `SET PASSWORD FOR 'u'@'%' = '${s[0]}'`, gen(16)),
  hostile("PASSWORD('…')", (s) => `SET PASSWORD = PASSWORD('${s[0]}')`, gen(16)),
  hostile("mysql -p'…'", (s) => `mysql -u root -p'${s[0]}' shop`, gen(16)),
  hostile('mysql -p"…"', (s) => `mysql -u root -p"${s[0]}" shop`, gen(16)),
  hostile("openssl -pass 'pass:…'", (s) => `openssl enc -pass 'pass:${s[0]}'`, gen(16)),
  hostile(
    'keytool -storepass',
    (s) => `keytool -storepass ${s[0]} -keypass ${s[1]}`,
    gen(16),
    gen(16),
  ),
  hostile(
    "UPDATE … SET api_key='…'",
    (s) => `UPDATE users SET api_key='${s[0]}' WHERE id=1`,
    gen(16),
  ),
  hostile('a bare random token', () => R.rand24, R.rand24),
  hostile('a zero-width split ghp_', () => `gh​p_${R.ghp.slice(4)}`, R.ghp.slice(4)),
  hostile('a bare AWS key pair', () => `is ${R.akid} ${R.awsSecret} valid`, R.akid, R.awsSecret),
  hostile("ANSI-C SECRET=$'…\\'…'", (s) => `SECRET=$'a\\'${s[0]}' run`, gen(16)),
];

describe('the masker guards the text that still shows', () => {
  it.each(IN_TEXT)('%s', (_label, text, secrets) => {
    expect(leaks(listed('Grep', { pattern: text }), secrets)).toEqual([]);
    expect(leaks(listed('Agent', { description: text }), secrets)).toEqual([]);
  });
});

describe('ordinary text stays as it is', () => {
  it.each([
    '--author=alice',
    'GIT_AUTHOR_NAME=bob',
    'author_name=x',
    'git log --author alice',
    'sort --key=2',
    'SESSION_TIMEOUT=30',
    'KEY_COUNT=5',
    '--passWithNoTests=true',
    '--keyframes=on',
    'primary_key=True',
    'Basic auth support for the proxy',
    'Basic authentication',
    'Bearer token',
    'the token parser',
    'docker run --rm -u 1000:1000 node',
    'docker exec -u root:root app sh',
    'echo sk-learn is not a key',
    'pip install sk-video-tools-for-demo-use',
    'feature/sk-improve-session-handling',
    'sk-fix-issue-1234-session-handling',
    'GITHUB_TOKEN=$GH_TOKEN',
    `API_KEY=\${OPENAI_API_KEY}`,
    'key={item.id}',
    'key=\\|meters.map',
    '^export DEEPSEEK_API_KEY=',
    "sed 's/token=.*/token=REDACTED/'",
    'curl -H "Authorization: Bearer $TOKEN"',
    'apiKey = process.env.OPENAI_API_KEY',
    'mysql -u root -p shop',
    'psql -h localhost -p 5432 -U app shop',
    'ssh -p 2222 me@host',
    'grep -n "password" config.example',
    'secret_notes.md',
    'password reset flow',
    'key == value',
    'export PATH=$HOME/bin:$PATH',
    'SELECT * FROM users WHERE password IS NULL',
    'IDENTIFIED BY',
    'npx @biomejs/biome@2.0 check',
    'getUserById2 and parseV2Config',
    'src/components/Header2/HeaderViewTestXYZ.tsx',
    '0123456789abcdef0123456789abcdef01234567',
    'W6a-2-auto-continuation-turn-en-light-1440.png',
    'IMG_20240101_123456_HDR2.jpg',
  ])('%s', (text) => {
    expect(listed('Grep', { pattern: text })).toBe(text);
  });

  it.each([
    ['alice.smith@example.com', '•••@example.com'],
    [
      'git config --global user.email me@example.com',
      'git config --global user.email •••@example.com',
    ],
    ["WHERE email = 'bob+tag@corp.example.org'", "WHERE email = '•••@corp.example.org'"],
    ['Email bob.jones@corp.example about it', 'Email •••@corp.example about it'],
    // An ssh user reads the same way, and is identity too.
    ['ssh git@github.com', 'ssh •••@github.com'],
  ])('an e-mail keeps its domain, not its person: %j', (text, expected) => {
    expect(listed('Grep', { pattern: text })).toBe(expected);
    expect(listed('Agent', { description: text })).toBe(expected);
  });

  it.each([
    ['git log --author=alice --since=2.weeks', 'git log'],
    ['gh api "search/issues?q=repo:o/r+author:me&per_page=5"', 'gh api'],
    [
      'curl "https://api.github.com/repos/o/r/commits?author=alice&per_page=5"',
      'curl api.github.com',
    ],
    ['sort --key=2 data.txt', 'sort'],
    ['docker run -e SESSION_TIMEOUT=30 app', 'docker run'],
    ['make test KEY_COUNT=5', 'make test'],
    ['npx vitest run --passWithNoTests=true', 'npx vitest'],
    ['mysql -u root -p shop', 'mysql'],
    ['pip install sk-video-tools-for-demo-use', 'pip install'],
    ['git checkout -b feature/sk-improve-session-handling', 'git checkout'],
    ['echo sk-learn is not a key; pip install scikit-learn', 'echo +1'],
    ['docker run --rm -u 1000:1000 node npm test', 'docker run'],
  ])('the command %j shows as %j', (command, summary) => {
    expect(listed('Bash', { command })).toBe(summary);
  });
});

describe('the home directory shows as ~', () => {
  const posix = homeMatcher({ HOME: '/home/u' });
  it.each([
    ['cd /home/u/dev && x', 'cd ~/dev && x'],
    ['ls /home/u', 'ls ~'],
    ['cat "/home/u/.config/x"', 'cat "~/.config/x"'],
    ["cat '/home/u'", "cat '~'"],
    ['cd /home/u; ls', 'cd ~; ls'],
    ['ls /home/u:/x', 'ls ~:/x'],
    ['(cd /home/u)', '(cd ~)'],
    ['cd /home/u&& ls', 'cd ~&& ls'],
    ['PATH=/home/u/bin:/home/u/.local/bin', 'PATH=~/bin:~/.local/bin'],
    ['ls /home/u2/x', 'ls /home/u2/x'],
    ['ls /home/u.bak', 'ls /home/u.bak'],
    ['ls /x/home/u/y', 'ls /x/home/u/y'],
  ])('POSIX %j → %j', (text, expected) => {
    expect(tildeHome(text, posix)).toBe(expected);
  });

  const windows = homeMatcher({ USERPROFILE: 'C:\\Users\\Gogy' });
  it.each([
    ['type C:\\Users\\Gogy\\notes.txt', 'type ~\\notes.txt'],
    ['cd c:/users/gogy/dev', 'cd ~/dev'],
    ['{"path":"C:\\\\Users\\\\Gogy\\\\x"}', '{"path":"~\\\\x"}'],
    ['ls /c/Users/Gogy/dev', 'ls ~/dev'],
    ['ls /mnt/c/Users/Gogy', 'ls ~'],
    ['dir "C:\\Users\\Gogy";', 'dir "~";'],
    ['dir C:\\Users\\Gogy2', 'dir C:\\Users\\Gogy2'],
    ['dir D:\\Users\\Gogy', 'dir D:\\Users\\Gogy'],
  ])('Windows %j → %j', (text, expected) => {
    expect(tildeHome(text, windows)).toBe(expected);
  });

  it('maps no home when none is set', () => {
    expect(homeMatcher({})).toBeNull();
    expect(homeMatcher({ HOME: '/' })).toBeNull();
  });

  it('maps the server’s own home in targets, even a path that is the home itself', () => {
    const home = process.env.HOME ?? '';
    expect(listed('Grep', { pattern: `${home}/notes` })).toBe('~/notes');
    expect(listed('Grep', { pattern: `cat ${home}; ls ${home}:x (${home})` })).toBe(
      'cat ~; ls ~:x (~)',
    );
    expect(listed('list_dir', { target_directory: home })).toBe('~');
    expect(listed('list_dir', { target_directory: `${home}/` })).toBe('~');
    expect(listed('Read', { file_path: `${home}/dev/x.ts` })).toBe('x.ts');
  });
});
