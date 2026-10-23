---
description: "离开整个 WebUI 一段时间后生成会话回顾，返回时显示在输入框上方。"
kind: "package-bundle"
---

# @dsh-external/dsh-session-recap

[English](README.md) | 中文

## 概述

`@dsh-external/dsh-session-recap` 给 DeepSeek Harness 会话加上离开回顾。同一宿主的所有 Web 客户端都明确离开并持续达到 `idleMs`，会话最后一个完成的回合也超过 `idleMs`，且完成回合数与真实对话正文字符数分别达到 `minTurns` 和 `minConversationChars` 时，宿主调用一次辅助模型生成一段纯文本回顾，写入插件自己的数据文件。切回页面时，输入框上方显示这份回顾，内容包括当前任务、关键进展和下一步。`/recap` 可以随时手动生成；没有 Web 客户端的 profile 把 `hostCommand` 设为 `true` 后，同一个命令会直接返回正文。

## 目录

- [安装](#install)
- [使用本包](#use-this-package)
- [配置](#configure)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="install"></a>
## 安装

从 GitHub 安装到 profile。

```bash
dsh plugin --profile web add github:DDDFXYqiming/dsh-session-recap
```

git 安装会运行包的 `prepare` 脚本重新构建 `lib/`。pnpm 10 及更新版本默认拒绝这类构建，因此第一次 `add` 可能失败。把 pnpm 打印的包键原样复制进 profile 的 `pnpm-workspace.yaml`，再执行一次 `add`。

```yaml
allowBuilds:
  '@dsh-external/dsh-session-recap': true
```

这项授权允许包在安装时于你的机器上执行代码。仓库内容可能变化时，锁定提交（`github:DDDFXYqiming/dsh-session-recap#<sha>`）。用 `pnpm pack` 打出的 tarball 可以直接安装，不触发构建。

从本地源码安装时先构建，再把 `add` 指向目录。

```bash
git clone https://github.com/DDDFXYqiming/dsh-session-recap.git
cd dsh-session-recap
npm install && npm run build
dsh plugin --profile web add .
```

通过插件管理器应用更新，再刷新页面；宿主提示需要重启时按提示处理。运行需要 Node.js `^22.19.0 || >=24.0.0`。

-----

<a id="use-this-package"></a>
## 使用本包

回到会话时，输入框上方的回顾卡片显示当前任务、最重要的进展和下一步。点 × 关闭。会话推进后卡片消失，每个会话只保留当前一份回顾。

自动回顾面向访问过的交互会话。所有 WebUI 页面都明确离开并持续至少 `idleMs`，最后一个完成的回合距今也至少 `idleMs`，且会话累计完成过 `minTurns` 个回合、真实用户与助手正文累计至少 `minConversationChars` 个非空白字符后，才会生成回顾。工具结果与注入内容不计入正文字符数。任一 WebUI 页面重新聚焦都会取消等待中和生成中的自动回顾；在应用内切换会话时，整个应用仍视为活跃。开始新回合会取消该会话的生成并清掉上一份回顾。

客户端每 20 秒发送心跳。活动心跳超过 45 秒未续上时，状态记为未知，自动回顾暂停，直到该客户端重新明确上报状态。

随时生成回顾，用斜杠菜单里的 `/recap`。没有 Web 客户端的 profile 把 `hostCommand` 设为 `true`，由宿主命令直接返回回顾正文，不经过卡片。

回顾使用你自己写句子的语言，粘贴的日志和引用材料不算你的语言。

-----

<a id="configure"></a>
## 配置

组合包的默认条目不需要配置。要改值，在 profile 的 `cordis.patch.yml` 里给 `dsh-session-recap` 加一条覆盖条目。没有设置的键取下面的 schema 默认值。

```yaml
- id: dsh-session-recap
  config:
    enabled: true           # 自动回顾开关。/recap 在关闭后仍可用。
    hostCommand: false      # 注册宿主 /recap 命令。没有 Web 客户端时才设为 true。
    idleMs: 180000          # 连续离开 WebUI 与最后回合结束均需达到的时长（毫秒）。
    minTurns: 5             # 自动回顾所需的最少完成回合数。
    minConversationChars: 1000  # 真实用户与助手正文的最少非空白字符数，不含工具结果。
    recentMessages: 80      # 进入回顾窗口的最近消息条数。
    maxChars: 400           # 回顾正文的字符上限。
    maxInputChars: 24000    # 发给模型的输入字节上限。
    maxOutputTokens: 2048   # 单次回顾请求的输出 token 预算。
    timeoutMs: 30000        # 单次回顾请求的超时时间（毫秒）。
    manualRequestTimeoutMs: 70000  # 浏览器等待手动 /recap 结果的时限（毫秒）。
    provider: ''            # 固定 provider，与 model 一起填写。
    model: ''               # 固定 model，与 provider 一起填写。
    reasoningEffort: ''     # 适配器的思考等级 id，留空表示不传。
    # temperature: 0.2      # 可选采样温度，省略时用适配器默认值。
    stopSequences: []       # 可选停止词。
    routeProbe: false       # 把路由判定写入 route-probe.log。
```

`provider` 与 `model` 成对生效。两者都留空时，复用会话最近一次请求记录里的 provider 与 model。回顾路由使用思考型模型时，思考 token 也占用 `maxOutputTokens`；第一次尝试没有完整句子时，插件按 `min(4096, max(2048, maxOutputTokens × 4))` 的预算再试一次。`manualRequestTimeoutMs` 只限制浏览器等待手动请求的时间，生成在宿主继续，后续轮询会把卡片更新出来。

profile 的 patch 会替换该行的整个 `config`。没有设置的键取 schema 默认值，只写要改的键就够了。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>机制说明，点击展开</summary>

宿主用会话投影跟踪回合边界，统一维护整个 WebUI 的客户端状态与连续离开时间。任一客户端活跃或状态未知都会暂停自动生成。自动任务在启动和发布前检查同一次离开状态；手动任务独立于焦点变化。实现细节见 [开发说明](docs/development.md)。

输入构造保留对话内容，丢掉工具输出。帧取最近 `recentMessages` 条助手消息与真实用户输入，排除工具结果与注入上下文，把最新的压缩检查点当作可信历史，并在最新用户请求落到窗口之外时把它补进 `goal`。JSON 帧超过 `maxInputChars` 字节预算时，依次缩短最长的字符串。

生成过程只有一次辅助模型调用，包含一段固定系统提示词和一条 user 消息。系统提示词要求两到四句纯文本，写明 `maxChars` 硬上限，禁止 Markdown，内容依次是当前任务、一个关键进展或决定、一个下一步动作。user 消息带 JSON 帧和 `[recap-language]` 指令，指令里最多附三条最近的用户消息，让模型用用户自己写句子的语言输出。回复会清掉思考标签与 Markdown，按 `maxChars` 截断，截断落在句子中间时退回到最后一个完整句子。

宿主保存正文并提供读取。数据文件写在 `$DSH_HOME/plugin-data/dsh-session-recap/<encoded-session-id>.json`，保存 `text`、`at` 和 `turnSeq`，先写临时文件再改名。内存里的副本由 `GET /api/dsh-session-recap?sessionId=...` 提供，Web 客户端轮询它，在 `conversation.input.dock` 槽位渲染卡片，并按会话、回合和生成时间在 `sessionStorage` 里记住关闭状态。路由接受 `GET`、`HEAD` 和用于在线状态上报或手动生成的 `POST`。

路由只应答本机调用。远端地址必须是回环地址，`Host` 头必须匹配锚定的回环形式，`Sec-Fetch-Site: cross-site` 一律拒绝；`Origin` 缺席放行，存在时必须能解析且 host 与 `Host` 一致。`routeProbe` 设为 `true` 时，放行与拒绝的判定写入插件数据目录的 `route-probe.log`，用于排查。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，本插件接入的宿主项目。
- [打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)，组合包 manifest、profile 配置层与 git 安装。
- [pi-recap](https://github.com/DDDFXYqiming/pi-recap)，同样的离开回顾在 Pi Coding Agent 上的实现。
- [版本发布](https://github.com/DDDFXYqiming/dsh-session-recap/releases)，已发布版本与说明。

-----

<a id="model-experience"></a>
## 模型体验

### 回顾请求

#### 模型看到什么

一次回顾调用发送一段固定系统提示词和一条 user 消息。系统提示词要求用用户的语言写两到四句纯文本，重申 `maxChars` 硬上限，禁止 Markdown 与标签式冒号分栏，内容依次是当前任务、一个关键进展或决定、一个下一步动作。user 消息带 JSON 转录帧 `{ historySummary, goal, recent }` 和 `[recap-language]` 指令，指令由最多三条最近的用户消息组成。`historySummary` 是最新的压缩检查点，`goal` 是最新真实用户请求（落在窗口之外时才有），`recent` 是带角色标注的对话条目。

#### Token 影响

插件在每次自动触发或手动 `/recap` 时增加一次独立请求。转录帧按 `maxInputChars` 字节上限（默认 24000）截断，`recentMessages`（默认 80）决定进入帧的消息条数。输出按 `maxOutputTokens`（默认 2048）限制，第一次尝试没有完整句子时，按 `min(4096, max(2048, maxOutputTokens × 4))` 重试一次。回顾正文按 `maxChars`（默认 400）字符截断，只落在数据文件与内存副本里，会话的模型输入与消息历史保持原样。

#### KV Cache 影响

每次回顾都是一次独立的单轮请求。转录内容随会话变化，多次回顾之间没有可复用的稳定前缀。插件只读写自己的数据文件与内存副本，会话消息与系统提示词保持原样，会话已有的请求前缀仍可复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **自动回顾需要 Web 客户端。** 离开判定依赖客户端上报。没有 Web 客户端的 profile 只有在 `hostCommand: true` 时才能用 `/recap`，不会自行生成回顾。
- **需要可用的模型路由。** 宿主使用显式的 `provider` 与 `model`，或会话最近一次请求记录里的路由。两者都没有时生成失败，宿主写一条警告日志。
- **思考型路由会占用输出预算。** 思考 token 计入 `maxOutputTokens`。预算偏小时可能拿不到完整句子，唯一一次提额重试也可能失败，`/recap` 会返回错误。
- **Teammate 与 subagent 会话保持手动。** 带父会话的会话不会自动触发回顾，只能通过 `/recap` 生成。
- **路由只应答回环客户端。** 远端或局域网调用方即使拿到正确的会话 id，也读不到宿主路由上的回顾。
- **关闭状态只存在当前标签页。** Web 客户端把关闭记录写进 `sessionStorage`，另一个标签页不会继承。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文，点击展开</summary>

`routeProbe` 除排查外保持关闭。它在路由上同步追加日志，轮询的客户端会让每次请求都落到磁盘。`generateRecap` 里的提额系数、2048 下限和 4096 上限是固定的策略常量，不是配置项。发布前执行 `npm run build` 和 `npm test`。

</details>
