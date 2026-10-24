import { describe, expect, it } from 'vitest';
import { activityTarget } from './activity.js';
import { summarizeCode, summarizeCommand } from './command-summary.js';

describe('summarizeCommand', () => {
  it.each([
    // Programs with subcommands.
    ['git status', 'git status'],
    ['git -C ~/repo commit -m "Fix the parser"', 'git commit'],
    ['git -c http.extraheader="AUTHORIZATION: basic abc" fetch', 'git fetch'],
    ['gh pr create --title "W6a" --body "…"', 'gh pr'],
    ['npm test -- --run', 'npm test'],
    ['npm run build -- --watch', 'npm run build'],
    ['pnpm --filter web test', 'pnpm test'],
    ['yarn test:unit', 'yarn test:unit'],
    ['bun ./scripts/gen.ts', 'bun gen.ts'],
    ['npx -y @biomejs/biome@2.0.0 check .', 'npx @biomejs/biome'],
    ['npx vitest run src/core', 'npx vitest'],
    ['cargo +nightly test --all', 'cargo test'],
    ['go test ./...', 'go test'],
    ['docker compose -f deploy/x.yml up -d', 'docker compose'],
    ['docker run --rm -e API_KEY=abc123 -v "$PWD":/w img', 'docker run'],
    ['kubectl -n prod get pods', 'kubectl get'],
    ['aws --profile dev s3 ls s3://bucket', 'aws s3'],
    ['gcloud --project p compute instances list', 'gcloud compute'],
    ['az vm list -o table', 'az vm'],
    ['terraform -chdir=infra plan -var token=abc', 'terraform plan'],
    ['make -C web -j 4 build', 'make build'],
    ['make', 'make'],
    ['uv run --with rich pytest -q', 'uv run pytest'],
    ['poetry run python manage.py migrate', 'poetry run python'],
    ['pip install -r requirements.txt', 'pip install'],
    // Fetches: the host only.
    [
      'curl -sSL -H "Accept: application/json" https://api.github.com/repos/o/r',
      'curl api.github.com',
    ],
    ['curl -u admin:hunter2 http://localhost:8080/health', 'curl localhost:8080'],
    ['curl -O https://example.org/f.tgz', 'curl example.org'],
    ['wget -O out.tgz https://example.org/f.tgz', 'wget example.org'],
    ['http POST :3000/api name=x', 'http localhost:3000'],
    ['curl "$API_URL/items"', 'curl'],
    ['curl -X POST https://a1b2c3d4e5f6g7h8.ngrok-free.app/hook', 'curl ….ngrok-free.app'],
    // Interpreters: the inline-code flag, the module or the script's name.
    ['python3 -c "import sys; print(sys.version)"', 'python3 -c'],
    ['python -m pytest -k session -q', 'python -m pytest'],
    ['python scripts/build.py --release', 'python build.py'],
    ["python3 - <<'EOF'\nprint(1)\nEOF", 'python3 -'],
    ['node -e "console.log(1)"', 'node -e'],
    ['node --import tsx scripts/x.mjs', 'node x.mjs'],
    ['perl -pi -e "s/a/b/" f', 'perl -e'],
    ['ruby -e "puts 1"', 'ruby -e'],
    ['bash scripts/deploy.sh prod', 'bash deploy.sh'],
    ['bash -c "echo hi && ls"', 'echo +1'],
    ['./scripts/check.sh --fast', 'check.sh'],
    // Other programs: the name alone.
    ['ls -la', 'ls'],
    ['rm -rf dist', 'rm'],
    ['cat > notes.md <<EOF\npassword: hunter2\nEOF', 'cat'],
    // Chains and pipelines: the first command, and how many follow.
    ['git add . && git commit -m "x" && git push', 'git add +2'],
    ['rg -n "sessionActivity" src | head -20', 'rg +1'],
    ['(cd web && npm test) && npm run lint', 'npm test +1'],
    ['cat > f <<EOF\nline; one\nEOF\nnpm test', 'cat +1'],
    ['git commit -m "$(cat <<\'EOF\'\nFix it; again\n\nCo-Authored-By: x\nEOF\n)"', 'git commit'],
    // Set-up, wrappers and environment never show.
    ['cd ~/dev/app && npm test', 'npm test'],
    ['OPENAI_API_KEY=abc node run.js', 'node run.js'],
    ['env -i PATH=/usr/bin FOO=bar make test', 'make test'],
    ['export A=1 && export B=2 && npm start', 'npm start'],
    ['sudo -u postgres psql -c "select 1"', 'psql'],
    ['sudo -E apt-get install -y jq', 'apt-get install'],
    ['time npm test', 'npm test'],
    ['nohup node server.js > log 2>&1 &', 'node server.js'],
    ['timeout 30 npm test', 'npm test'],
    ['if [ -f package.json ]; then npm ci; fi', 'npm ci'],
    ['for f in *.ts; do npx tsc --noEmit $f; done', 'npx tsc'],
    // A function is defined, then run twice.
    ['S=/tmp/x; shoot() { node "$S/shoot.mjs" "$1"; }; shoot a; shoot b', 'shoot +1'],
    ['cd /tmp', 'cd'],
    ['export A=1', 'export'],
    ['A=1', null],
    ['# just a comment', null],
  ])('%j → %j', (command, expected) => {
    expect(summarizeCommand(command)).toBe(expected);
  });

  it.each([
    ['Set-Location C:\\proj; npm test', 'npm test'],
    ['Get-ChildItem -Path C:\\Users\\x\\dev -Recurse', 'Get-ChildItem'],
    ['$env:OPENAI_API_KEY = "abc"; codex exec "fix it"', 'codex exec'],
    ['& "C:\\Program Files\\nodejs\\node.exe" .\\build.js', 'node build.js'],
    [
      'Invoke-WebRequest -Uri https://api.x.io/v1 -Headers @{Authorization="Bearer abc"; X=1}',
      'Invoke-WebRequest api.x.io',
    ],
    [
      '[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "abc", "User")',
      '[Environment]::SetEnvironmentVariable',
    ],
    ['.\\scripts\\build.ps1 -Release', 'build.ps1'],
    ['python -c "print(1)"', 'python -c'],
  ])('PowerShell %j → %j', (command, expected) => {
    expect(summarizeCommand(command, { powershell: true })).toBe(expected);
  });

  it.each([
    [['bash', '-lc', 'cd x && cargo test'], 'cargo test'],
    [['/bin/zsh', '-c', 'git add -A; git commit -m "x"'], 'git add +1'],
    [['powershell.exe', '-NoProfile', '-Command', 'Set-Location C:\\x; npm test'], 'npm test'],
    [['cmd', '/c', 'npm test'], 'npm test'],
    [['curl', '-u', 'admin:pw', 'https://x.io/a'], 'curl x.io'],
    [['env', 'OPENAI_API_KEY=abc', 'codex'], 'codex'],
    [['git', 'status'], 'git status'],
    [['bash', '-lc'], 'bash -lc'],
    [['git status && npm test'], 'git status +1'],
  ])('argv %j → %j', (argv, expected) => {
    expect(summarizeCommand(argv)).toBe(expected);
  });

  it('never runs past 60 characters, and leaves slots out whole rather than cut them', () => {
    const long = `node ${'a'.repeat(30)}/${'b'.repeat(40)}.mjs && ${'x '.repeat(10)}`;
    const target = activityTarget('Bash', { command: long }) ?? '';
    expect(target.length).toBeLessThanOrEqual(60);
    expect(target).toBe('node +1');
    expect(summarizeCommand(`npm run ${'build-'.repeat(5)}x`)).toBe(
      'npm run build-build-build-build-build-x',
    );
  });

  it.each([
    // +N: the review's chains, pipelines, loops, cases and heredocs.
    ['a && b || c', 'a +2'],
    ['a | b | c', 'a +2'],
    ['a & b', 'a +1'],
    ['npm test 2>&1 | tail -20', 'npm test +1'],
    ['a |& b', 'a +1'],
    ['a &>/dev/null; b', 'a +1'],
    ['if x; then y; else z; fi', 'x +2'],
    ['for f in *.ts; do a "$f"; b; done', 'a +1'],
    ['while read l; do echo "$l"; done < f.txt', 'echo'],
    ['(cd x && make) && git status', 'make +1'],
    ['echo "a && b; c | d"', 'echo'],
    ["echo 'a;b' ; c", 'echo +1'],
    ['x=$(git rev-parse HEAD) && echo "$x"', 'echo'],
    ['cat <<EOF > f && npm test\nline; one\nEOF', 'cat +1'],
    ['git commit -m "$(cat <<\'EOF\'\nFix the 5" display\nand more\nEOF\n)"', 'git commit'],
    [
      'git commit -m "$(cat <<\'EOF\'\nFix (a) and b)\nmore; stuff\nEOF\n)" && git push',
      'git commit +1',
    ],
    ['X=$(cat <<EOF\n1) first\n2) second\nEOF\n)\ngh pr create --body "$X"', 'gh pr'],
    ["git commit -m $'Don\\'t break; fix x'", 'git commit'],
    ['case "$1" in a) run_a;; b) run_b;; esac', 'run_a +1'],
    ['case "$1" in\n  a) run_a ;;\n  b) (cd y && make) ;;\nesac', 'run_a +1'],
    ['case $x in a) (cd y && make) ;; esac', 'make'],
    // `in` on a line of its own is still the head.
    ['case $x\nin\n  a) run_a;;\nesac', 'run_a'],
    ['case $x\n\nin\n  a) run_a;;\nesac', 'run_a'],
    ['for f\nin *.ts; do a "$f"; done', 'a'],
    ['a \\\n  --flag && b', 'a +1'],
    ['a \\\r\n  --flag && b', 'a +1'],
    ['a # comment; b\nc', 'a +1'],
    ['echo a#b; c', 'echo +1'],
    ['{ a; b; } > log', 'a +1'],
    ['! grep -q x f && echo missing', 'grep +1'],
    ['cat <<"E"OF\nnot a command\nEOF\nnpm test', 'cat +1'],
    ['gh auth login --with-token <<< "$T"', 'gh auth'],
    ['<<<"$T" gh auth login --with-token', 'gh auth'],
    // Option values never pass for a subcommand or a script.
    ['node --stack-size 2000 scripts/build.mjs', 'node build.mjs'],
    ['node --some-flag 2000 scripts/build.mjs', 'node build.mjs'],
    ['node --inspect app.js', 'node app.js'],
    ['aws --cli-binary-format raw-in-base64-out lambda invoke', 'aws lambda'],
    ['kubectl --username alice get pods', 'kubectl get'],
    ['npm --otp 493817 publish', 'npm publish'],
    ['sudo -r role make', 'make'],
    ['sudo --unknown value make', 'sudo'],
    ['git --exec-path /x status', 'git'],
    ['git --no-pager diff HEAD', 'git diff'],
    ['docker --tlscacert ca.pem --tlsverify ps', 'docker ps'],
    ['az --only-show-errors vm list', 'az vm'],
    ['cargo --locked build', 'cargo build'],
    ['npm --unlisted 493817 publish', 'npm'],
    ['git --frobnicate value status', 'git'],
    ['kubectl --unlisted alice get pods', 'kubectl'],
    ['make -j8 test', 'make test'],
    // Only the program's own list makes a short option a switch: -t, -i or -gs may take a value.
    ['vercel -t vercelpat deploy --prod', 'vercel'],
    ['kubectl -i alice get pods', 'kubectl'],
    ['helm -a alice list', 'helm'],
    ['mvn -gs settings deploy', 'mvn'],
    ['git -Xfoo value status', 'git'],
    ['npm -g install pkg', 'npm install'],
    ['git -P log --oneline', 'git log'],
    ['docker -D run x', 'docker run'],
    ['gsutil -m cp -r gs://b/x .', 'gsutil cp'],
    ['pip -q install rich', 'pip install'],
    ['gcc -O2 main.c', 'gcc'],
    ['claude -p hello', 'claude'],
    ['claude mcp list', 'claude mcp'],
    ['codex "fix the bug"', 'codex'],
    ['codex exec "fix the bug"', 'codex exec'],
    // Names stay whole, in any script, or do not show.
    ['./构建.sh --fast', '构建.sh'],
    ['python 脚本.py', 'python 脚本.py'],
    ['npm run 构建', 'npm run 构建'],
    ['café --version', 'café'],
    ['node ./scripts/ビルド.mjs', 'node ビルド.mjs'],
    [`${'a'.repeat(49)} --x`, null],
    ['./gradlew :app:assembleDebug', 'gradlew :app:assembleDebug'],
    ['sha256sum f', 'sha256sum'],
    ['x86_64-linux-gnu-gcc -c x.c', 'x86_64-linux-gnu-gcc'],
    // A toolchain named by a target triplet of known words shows; any other word hides it.
    ['x86_64-w64-mingw32-gcc -O2 main.c', 'x86_64-w64-mingw32-gcc'],
    ['i686-w64-mingw32-g++ -o a.exe a.cpp', 'i686-w64-mingw32-g++'],
    ['aarch64-linux-gnu-gcc-12 -c x.c', 'aarch64-linux-gnu-gcc-12'],
    ['x86_64-w64-hunter2-gcc -c x.c', null],
    ['x86_64-linux-gnu-gcc-483920174659 -c x.c', null],
    ['x86_64-linux-gnu-gcc-4839201746.5928374655 -c x.c', null],
    ['x86_64-linux-gnu-gcc-12.2.0 -c x.c', 'x86_64-linux-gnu-gcc-12.2.0'],
    ['./backup-20240101.sh', 'backup-20240101.sh'],
    ['x86_64-abc123def456ghi-linux --help', null],
    // CamelCase with digits cannot be told from a key by its shape (Hunter2), so it is hidden.
    ['python Exercise1.py', 'python'],
    ['python train_ResNet50.py --epochs 3', 'python'],
    ['make UE4Editor', 'make'],
    ['vault Hunter2', 'vault'],
    ['python3.12 -m venv .venv', 'python3.12 -m venv'],
    ['docker-credential-desktop list', 'docker-credential-desktop'],
    ['watch -n 2 "kubectl get pods"', 'kubectl get'],
    ['timeout --preserve-status 10 npm test', 'npm test'],
    ['command -v git', 'git'],
  ])('%j → %j', (command, expected) => {
    expect(summarizeCommand(command)).toBe(expected);
  });

  it.each([
    ['$pw = ConvertTo-SecureString `\r\n  "abc" -AsPlainText -Force', null],
    ['$pw = ConvertTo-SecureString `\n  "abc" -AsPlainText -Force', null],
    ['$b = @"\nline\nnot a command\n"@\nnpm test', 'npm test'],
    [
      '[System.Environment]::SetEnvironmentVariable("TOKEN","abc","User")',
      '[System.Environment]::SetEnvironmentVariable',
    ],
    [
      'powershell -NoProfile -ExecutionPolicy Bypass -File .\\deploy.ps1 -Token abc',
      'powershell deploy.ps1',
    ],
    // Block comments, over lines or inside one, and inside $(…).
    ['<# hunter2 rotated by alice #>\nnpm test', 'npm test'],
    ['<#\n.SYNOPSIS\nhunter2 is the db password\n#>\nnpm test', 'npm test'],
    ['$x = 1 <# hunter2 #>; npm test', 'npm test'],
    ['$d = $(Get-Date <# ) hunter2 #>); npm test', 'npm test'],
  ])('PowerShell %j → %j', (command, expected) => {
    expect(summarizeCommand(command, { powershell: true })).toBe(expected);
  });

  it('reads at most 8000 characters of an argv, whole words only', () => {
    expect(summarizeCommand(['a'.repeat(1_000_000)])).toBeNull();
    expect(summarizeCommand(['git', 'a'.repeat(1_000_000)])).toBe('git');
    expect(summarizeCommand(['curl', ...Array(100_000).fill('a://b:c')])).toBe('curl');
    // The script crosses the limit, so it is not read: the shell and its flag only.
    expect(summarizeCommand(['bash', '-lc', `npm test; ${'x'.repeat(9000)}`])).toBe('bash -lc');
  });
});

describe('summarizeCode (Codex exec)', () => {
  it.each([
    [
      '// @exec: {"yield_time_ms": 10000}\nconst r = await tools.exec_command({ cmd: "npm test" });',
      'npm test',
    ],
    [
      'await tools.exec_command({cmd: \'ls -la\'});\nawait tools.exec_command({ cmd: "git diff" })',
      'ls +1',
    ],
    ['await tools.shell({ command: ["bash", "-lc", "git status"] })', 'git status'],
    ['await tools.exec_command({ workdir: "/r", cmd: `rg -n "x" src` })', 'rg'],
    ['const x = 1;\nreturn x * 2;', null],
  ])('%j → %j', (code, expected) => {
    expect(summarizeCode(code)).toBe(expected);
  });
});
