[English](README.md)

# glassbox

**把 Claude Code 变成玻璃盒子。** 在它干活的时候，实时看清它正在做什么、调用了哪些工具、token 和时间花在哪里——包括 max effort 和 ultracode（Workflow 多代理）运行；也可以直接在 glassbox 里给它发消息。

> A local, live viewer for Claude Code sessions: the execution chain, a step-by-step breakdown of how the agent worked, where the tokens and the time went, plan quota, and multi-agent workflow runs.

![执行链路：每次模型调用的请求、回复和工具，Agent / Workflow 卡片直接显示子代理的状态与 token](docs/images/zh-CN/flow.png)

**执行链路**：按轮次展开每次模型调用——请求 → 回复 → 工具；Agent / Workflow 卡片直接显示子代理和各阶段的进度，点进去就能看那个代理自己的链路。

|                                     思路拆解                                     |                              Token 去向                               |
| :------------------------------------------------------------------------------: | :-------------------------------------------------------------------: |
|                     ![思路拆解](docs/images/zh-CN/steps.png)                     |              ![Token 去向](docs/images/zh-CN/tokens.png)              |
| 每一步想了什么、说了什么、做了什么，按探索 / 修改 / 执行等阶段归组，失败一眼可见 |     一句话结论、缓存读写与输出的构成、按代理的树和上下文增长曲线      |
|                                    **时间线**                                    |                             **请求详情**                              |
|                    ![时间线](docs/images/zh-CN/timeline.png)                     |               ![请求详情](docs/images/zh-CN/detail.png)               |
| 时间花在思考、生成、工具还是空闲；每个代理一条泳道，并行的 workflow 代理一目了然 | 还原每次请求实际发出的 system、messages、tools，JSON 树可复制、可放大 |
|                                    **发消息**                                    |                             **实时浮层**                              |
|                     ![发消息](docs/images/zh-CN/compose.png)                     |                ![实时浮层](docs/images/zh-CN/live.png)                |
|     在 glassbox 里继续或复制一份会话继续，回复实时流出，权限确认在界面里弹出     |    模型思考时也不再是黑盒：实时显示思考用时、思考 token 和流式输出    |

## 一键运行

需要 Node.js ≥ 22.19 和本机已经在用的 Claude Code。

```sh
npx --yes github:gogy717/glassbox
```

第一次运行会下载并构建（约 1 分钟），然后自动在浏览器打开 `http://127.0.0.1:7788`。

固定版本（推荐，避免内容随分支变化）：

```sh
npx --yes github:gogy717/glassbox#v0.1.1
```

常用参数：

| 参数                                | 说明                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `--port <n>`                        | 端口，默认 `7788`                                                                     |
| `--no-open`                         | 不自动打开浏览器                                                                      |
| `--claude-dir <path>`               | Claude Code 数据目录，默认 `$CLAUDE_CONFIG_DIR` 或 `~/.claude`                        |
| `--grok-dir <path>` / `--no-grok`   | Grok 数据目录，默认 `$GROK_HOME` 或 `~/.grok`（目录存在就显示 Grok 会话）/ 不显示     |
| `--codex-dir <path>` / `--no-codex` | Codex 数据目录，默认 `$CODEX_HOME` 或 `~/.codex`（目录存在就显示 Codex 会话）/ 不显示 |
| `--claude-bin <path>`               | 发消息时使用的 `claude`，默认取 `PATH` 里的                                           |
| `--use-api-key`                     | 让发消息启动的 `claude` 使用 `ANTHROPIC_API_KEY`（默认用你在终端里登录的账号）        |
| `--fetch-quota`                     | 每 5 分钟用 Claude Code 的登录向 Anthropic 查询额度，保持额度最新（见「数据与隐私」） |
| `--demo`                            | 用内置演示数据运行，不读取本机会话，也不会启动 `claude`                               |
| `--help`                            | 查看全部参数                                                                          |

想常驻安装：`npm install -g github:gogy717/glassbox`，之后直接运行 `glassbox`；卸载用 `npm uninstall -g glassbox`。升级：把命令里的版本号换成新的 tag 再运行一次。

## 能看到什么

- **执行链路**：按用户轮次组织，每次模型调用一行：请求 → 回复 → 工具，失败标红；模型正在思考时显示"思考中 · 已 m:ss"，工具运行中实时计时。
- **思路拆解**：每一轮按"想了什么 → 说了什么 → 做了什么 → 结果"逐步展开，并归成探索 / 修改 / 执行 / 委派等阶段。
- **Token 去向**：缓存读、缓存写、未缓存输入、输出（含思考）；按代理、Workflow 阶段汇总；上下文增长曲线（标出压缩点）；最贵的请求。
- **时间线**：每个代理一条泳道，区分等待 / 思考 / 生成 / 工具；时间构成与最慢的 10 步。
- **多代理**：Agent 子代理和 Workflow（ultracode）运行的阶段、代理、状态、token，可以钻进任意一个代理看它自己的链路。
- **请求详情**：Claude Code ≥ 2.1.300 时，还原每次请求实际发给模型的 system prompt、tools 和 messages。
- **额度**：5 小时 / 每周 / 按模型的计划额度（读取 Claude Code 自己缓存的数据，参考 ClaudeBar）；数据旧了会变灰并标出是多久前的。
- **Grok 和 Codex 会话**：本机装了 Grok Build 或 Codex CLI 时，它们的会话也会出现在侧栏（只能查看），子代理、token 和时间同样可以拆开看。
- **诊断**：汇总条右侧的小图标列出这个会话缺了哪些数据、为什么缺。

## 在 glassbox 里发消息

底部输入框直接给 Claude Code 发消息，回复、思考 token、工具调用实时出现，权限确认和 Claude 的提问在页面里弹出回答。
- **新会话**：选一个工作目录和第一条消息。
- **继续**：接着一个已经关闭的会话聊。
- **复制一份继续**：会话还开在终端里时用它——复制出一个新会话继续，不会和终端里的那个抢同一份记录。

glassbox 启动的是你本机安装的 `claude`，用你自己的登录，`CLAUDE.md`、hooks 和设置照常生效；只有你点"发送"时才会启动，关闭会话或退出 glassbox 时进程随之结束。

## 账号与条款

glassbox 自己没有登录功能，也不读取或保存任何凭据（除非加了 `--fetch-quota`，见下文）。发消息时，它启动的是你本机安装的官方 `claude`（以无界面的 stream-json 模式运行），用的是你在终端里登录的同一个账号。请自行确认这种用法符合你的账号所适用的 Anthropic 条款；不确定的话，可以加 `--use-api-key` 改用 API key。

glassbox 是独立项目，与 Anthropic 没有关联，也未获其认可。

## 数据与隐私

- 只读 `~/.claude`（会话转录）、`~/.claude.json` 里的 `cachedUsageUtilization` 一项、`~/.grok`，以及 `~/.codex` 里的会话记录（`sessions/`、`archived_sessions/`、`session_index.jsonl`，不碰 `auth.json` 之类的凭据文件）；不修改任何 Claude Code / Grok / Codex 文件（用 glassbox 发消息时，记录由 `claude` 自己写入，和在终端里一样）。
- 只接受本机连接：看的是连接的真实来源地址，`Host` / `Origin` 也会校验；所有写操作需要每次启动随机生成的令牌，其他网页无法借道读取会话或发消息。
- 默认不把 `ANTHROPIC_API_KEY` 传给启动的 `claude`（避免意外按 API 计费），除非加 `--use-api-key`。
- glassbox 自己不发起任何外部网络请求，没有遥测；除非加了 `--fetch-quota`：这时它每 5 分钟从 Claude Code 的登录信息（`~/.claude/.credentials.json`，macOS 上是钥匙串）读取 access token，只发给 `api.anthropic.com/api/oauth/usage`。token 不记日志、不保存、不刷新；过期了就等 Claude Code 自己续期。这个接口就是 Claude Code 的 `/usage` 用的那个，不是公开 API，以后可能会变。

## 已知限制

- Claude Code 在一次回复**完整生成后**才写盘，所以思考/生成过程中只能显示"进行中 + 已用时间"，内容要等回复完成才出现。
- Claude Code 只为少部分思考块保存了简短摘要，大部分思考内容不在本地记录里；glassbox 显示思考用时和思考 token。
- 请求详情、"进行中"信号依赖 Claude Code 2.1.300 起新增的记录；更早的会话会标注"此版本未记录"。
- 转录格式是 Claude Code 的内部格式，升级后可能变化；glassbox 遇到不认识的内容会跳过并计数，不会崩溃。
- 用 glassbox 发消息时能实时看到回复文字和思考 token 的增长，但 Claude Code 的流式输出里没有思考的文字本身。
- Grok 和 Codex 会话只能查看。Grok 只按轮次记录 token，所以一轮的用量记在这一轮的最后一次调用上；Codex 的思考内容是加密的，只能显示它自带的推理摘要和思考 token。
- 额度数据来自 Claude Code 的缓存，由 ClaudeBar 或 `/usage` 刷新；两者都没有运行时，数据会变旧（界面会标出）。重新登录或切换账号会清空这份缓存，额度会消失，直到下一次 `/usage`。加 `--fetch-quota` 可以让它自己保持最新。

## 本地开发

```sh
npm install
npm run dev        # 演示数据：服务端 7788 + Vite 5173
npm run dev:live   # 本机真实会话
npm run check      # 类型检查 + Biome + 测试
npm run build && npm start
```

## 致谢

- 界面思路参考 [dsh-plugin-agent-workflow](https://github.com/xuanyuanzhifeng/dsh-plugin-agent-workflow)（DeepSeek Harness 的工作流插件）。
- 额度数据的取法参考 [ClaudeBar](https://github.com/tddworks/ClaudeBar)。

## 许可证

[MIT](LICENSE)
