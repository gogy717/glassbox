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

  it('never runs past 60 characters as a target', () => {
    const long = `node ${'a'.repeat(30)}/${'b'.repeat(40)}.mjs && ${'x '.repeat(10)}`;
    const target = activityTarget('Bash', { command: long }) ?? '';
    expect(target.length).toBeLessThanOrEqual(61);
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
