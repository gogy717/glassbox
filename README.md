[中文](README.zh-CN.md)

# glassbox

**Turn Claude Code into a glass box.** While it works, see exactly what it is doing, which tools it calls, and where the tokens and the time go, including max effort and ultracode (Workflow multi-agent) runs. You can also message it straight from glassbox.

> A local, live viewer for Claude Code sessions: the execution chain, a step-by-step breakdown of how the agent worked, where the tokens and the time went, plan quota, and multi-agent workflow runs.

![Execution chain: each model call's request, response and tools; Agent / Workflow cards show their sub-agents' status and tokens](docs/images/flow.png)

**Execution chain**: every model call of a turn, laid out as request → response → tools. Agent / Workflow cards show the progress of their sub-agents and phases; click through to see that agent's own chain.

|                                                          How it worked                                                           |                                                  Where tokens went                                                  |
| :------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------: |
|                                             ![How it worked](docs/images/steps.png)                                              |                                    ![Where tokens went](docs/images/tokens.png)                                     |
|            What each step thought, said and did, grouped into phases such as explore / edit / run; failures stand out            | A one-line takeaway, the mix of cache reads, cache writes and output, a per-agent tree and the context growth curve |
|                                                           **Timeline**                                                           |                                                 **Request details**                                                 |
|                                              ![Timeline](docs/images/timeline.png)                                               |                                     ![Request details](docs/images/detail.png)                                      |
| Whether the time went to thinking, generating, tools or idling; one lane per agent, so parallel workflow agents are easy to read |      The system prompt, messages and tools each request actually sent, as JSON trees you can copy and enlarge       |
|                                                       **Sending messages**                                                       |                                                  **Live overlay**                                                   |
|                                           ![Sending messages](docs/images/compose.png)                                           |                                        ![Live overlay](docs/images/live.png)                                        |
|      Continue a session, or continue in a copy, from glassbox; replies stream in and permission prompts pop up in the page       |          No more black box while the model thinks: live thinking time, thinking tokens and streamed output          |

## Run it

Requires Node.js ≥ 22.19 and Claude Code already in use on this machine.

```sh
npx --yes github:gogy717/glassbox
```

The first run downloads and builds (about a minute), then opens `http://127.0.0.1:7788` in your browser.

Pin a version (recommended, so the contents do not change with the branch):

```sh
npx --yes github:gogy717/glassbox#v0.1.1
```

Common options:

| Option                              | Description                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--port <n>`                        | Port, default `7788`                                                                                                    |
| `--no-open`                         | Don't open a browser                                                                                                    |
| `--claude-dir <path>`               | Claude Code data dir, default `$CLAUDE_CONFIG_DIR` or `~/.claude`                                                       |
| `--grok-dir <path>` / `--no-grok`   | Grok data dir, default `$GROK_HOME` or `~/.grok` (Grok sessions show whenever it exists) / don't show them              |
| `--codex-dir <path>` / `--no-codex` | Codex data dir, default `$CODEX_HOME` or `~/.codex` (Codex sessions show whenever it exists) / don't show them          |
| `--claude-bin <path>`               | The `claude` used to send messages, default the one on `PATH`                                                           |
| `--use-api-key`                     | Let the `claude` started for messages use `ANTHROPIC_API_KEY` (default: the account you signed in with in the terminal) |
| `--fetch-quota`                     | Keep the plan quota fresh by asking Anthropic for it every 5 minutes with Claude Code's sign-in (see Data and privacy)  |
| `--demo`                            | Run on built-in demo data: no local sessions are read and `claude` is never started                                     |
| `--help`                            | List every option                                                                                                       |

To install it for good: `npm install -g github:gogy717/glassbox`, then run `glassbox`; uninstall with `npm uninstall -g glassbox`. To upgrade, run the command again with the new tag.

## What you can see

- **Execution chain**: organised by user turn, one row per model call: request → response → tools, failures in red. While the model thinks it shows "Thinking · m:ss", and running tools count up live.
- **How it worked**: each turn told step by step as "thought → said → did → outcome", grouped into phases such as explore / edit / run / delegate.
- **Where tokens went**: cache reads, cache writes, uncached input and output (including thinking); totals per agent and per Workflow phase; the context growth curve (with compaction points); the most expensive requests.
- **Timeline**: one lane per agent, split into waiting / thinking / generating / tools; where the time went and the 10 slowest steps.
- **Multi-agent**: phases, agents, status and tokens of Agent sub-agents and Workflow (ultracode) runs; drill into any agent to see its own chain.
- **Request details**: with Claude Code ≥ 2.1.300, the system prompt, tools and messages each request actually sent to the model.
- **Quota**: 5-hour / weekly / per-model plan quota (read from Claude Code's own cache, as ClaudeBar does); stale data greys out and says how old it is.
- **Grok and Codex sessions**: when Grok Build or the Codex CLI is installed, their sessions appear in the sidebar too (view only), with sub-agents, tokens and time broken down the same way.
- **Diagnostics**: the small icon at the right of the summary bar lists what data this session lacks, and why.

## Sending messages from glassbox

The box at the bottom sends messages straight to Claude Code. Replies, thinking tokens and tool calls appear live, and permission prompts and Claude's questions pop up in the page for you to answer.
- **New session**: pick a working directory and a first message.
- **Continue**: carry on a session that has been closed.
- **Continue in a copy**: use this while the session is still open in a terminal. It continues in a new copy of the session, so it never fights the terminal over the same transcript.

glassbox starts the `claude` installed on your machine, with your own sign-in, so your `CLAUDE.md`, hooks and settings apply as usual. It only starts when you press Send, and the process ends when you close the session or quit glassbox.

## Accounts and terms

glassbox has no sign-in of its own and never reads or stores credentials (unless you add `--fetch-quota`, below). To send a message it starts the official `claude` installed on your machine (in its headless stream-json mode), with the account you are signed in to: the same one you use in a terminal. Make sure this use fits the Anthropic terms that apply to your account; if you are unsure, start glassbox with `--use-api-key` to use an API key instead.

glassbox is an independent project, not affiliated with or endorsed by Anthropic.

## Data and privacy

- Reads only `~/.claude` (session transcripts), the `cachedUsageUtilization` entry of `~/.claude.json`, `~/.grok`, and the session records in `~/.codex` (`sessions/`, `archived_sessions/`, `session_index.jsonl`; never credential files such as `auth.json`); never changes a Claude Code, Grok or Codex file (when you message from glassbox, `claude` writes its own records, just as in a terminal).
- Accepts connections from this machine only: it checks where a connection really comes from, and validates `Host` / `Origin` too. Every write needs a token generated at each start, so other web pages cannot read your sessions or send messages through it.
- Does not pass `ANTHROPIC_API_KEY` to the `claude` it starts (so you are not billed by the API by accident) unless you add `--use-api-key`.
- glassbox itself makes no outbound network requests and has no telemetry, unless you add `--fetch-quota`: then every 5 minutes it reads the access token from Claude Code's sign-in (`~/.claude/.credentials.json`, or the macOS Keychain) and sends it to `api.anthropic.com/api/oauth/usage`, and nowhere else. The token is never logged, stored or refreshed; when it has expired glassbox waits for Claude Code to renew it. The endpoint is the one Claude Code's `/usage` uses and is not a public API, so it may change.

## Known limitations

- Claude Code writes a reply to disk only **once it is complete**, so while it thinks or generates glassbox can only show "in progress + time so far"; the content appears when the reply finishes.
- Claude Code keeps a short summary for only a few thinking blocks; most thinking is not in the local records. glassbox shows thinking time and thinking tokens.
- Request details and the "in progress" signal rely on records Claude Code added in 2.1.300; older sessions are marked "not recorded by this version".
- The transcript format is Claude Code's internal format and may change with upgrades; glassbox skips and counts anything it does not recognise instead of crashing.
- When you message from glassbox you see the reply text and the thinking-token count grow live, but Claude Code's streaming output does not include the thinking text itself.
- Grok and Codex sessions are view only. Grok records tokens per turn, so a turn's usage is attributed to its last call; Codex encrypts its thinking, so glassbox shows only Codex's own reasoning summaries and thinking tokens.
- Quota comes from Claude Code's cache, refreshed by ClaudeBar or `/usage`; when neither runs, the data goes stale (the UI says so). Signing in again or switching accounts clears that cache, so the quota disappears until the next `/usage`. `--fetch-quota` keeps it fresh on its own.

## Local development

```sh
npm install
npm run dev        # demo data: server on 7788 + Vite on 5173
npm run dev:live   # real local sessions
npm run check      # typecheck + Biome + tests
npm run build && npm start
```

## Acknowledgements

- The UI ideas follow [dsh-plugin-agent-workflow](https://github.com/xuanyuanzhifeng/dsh-plugin-agent-workflow) (the workflow plugin of DeepSeek Harness).
- The way quota data is read follows [ClaudeBar](https://github.com/tddworks/ClaudeBar).

## License

[MIT](LICENSE)
