简体中文 | [English](README.en.md)

# @dsh-external/dsh-session-recap

**DeepSeek Harness（DSH）会话回顾插件**。你把 Web 窗口切到后台，或者转到另一个会话，它就在后台生成一份简短回顾。等你回来，一张卡片会概括那个会话的当前任务、已完成进展和下一步。

当前版本：**0.1.5**（适配 DSH `0.1.2-rc.1`）。事件读取改用 `Session.snapshotEvents()`；构建直接使用 Node，可在 Windows 与 Linux 下执行 `pnpm build && pnpm test`。

## 为什么需要它

人离开屏幕的理由很多，可能是一场会，也可能是一顿饭。回来时会话还停在原处，思路却断了。往上翻很久的消息记录，才接得上刚才做到哪里。离开一段时间后回来，先读一段短回顾，再决定从哪里继续——这个插件把这段行为带进 DSH Web。回顾由一次独立的辅助 LLM 请求生成，写好的正文不会追加进会话消息历史。

## 能力

- 仅在 Web 窗口失焦或切走当前会话时后台生成；窗口保持聚焦时，单纯空闲不会调用模型。
- 默认要求最后一个完成 turn 已过去 3 分钟，且会话至少有 3 个完成 turn，同一 turn 不会连续生成两次。这两道门槛挡住了短暂分心带来的无意义回顾。
- `/recap` 随时按需生成，并在同一张回顾卡片中显示；关闭自动回顾不影响手动命令。
- 回顾正文跟随会话里用户消息的语言，英文提示词不会强制英文输出。
- 兼容旧模型服务：思考过程以 think / thinking / thought 标签块内联在正文里时（无独立 reasoning 通道），这些块在进入回顾输入和回顾卡片前都会被剥掉。
- 自动回顾以带“回顾 / Recap”标题和关闭按钮的卡片显示在 Web 对话输入框上方，最长 400 字符。
- 横幅按会话与回顾对应的完成轮次隔离；关闭后切换会话再切回，横幅不会重新出现。
- 发送新消息、切换会话或关闭横幅后，当前回顾会隐藏；后台标签页在重新可见时显示。
- 中英文界面标签；默认复用当前会话最近实际使用的 provider/model，也可覆盖模型、思考等级、temperature、输出预算、停止词和超时等参数。
- 回顾状态写入插件 sidecar，不向 DSH append-only session log 添加插件自定义事件。

## 工作方式

1. Web client 把窗口 focus/blur、页面可见性和会话切换映射为当前会话的 `active` / `away` 状态。
2. Host 只在会话处于 `away`、最后一个完成 `turn/end` 已超过 `idleMs`、完成轮数达到 `minTurns` 时启动自动回顾。三个条件同时满足才发起请求，短暂分心不会触发。
3. 插件构造有界输入时先剔除工具结果消息（原始命令输出不算意图），再以最近一条用户请求锚定当前任务（不再复述早已完成的开场请求），通过一次独立辅助 LLM 请求生成不超过 40 词、一到两句的纯文本回顾，内容是当前任务、已完成进展和下一步。
4. 如果会话在请求期间开始新 turn、完成了更新的 turn，或被销毁，旧请求的结果不会提交。你回来后看到的结果始终和当前进度对得上。
5. 自动回顾和手动 `/recap` 都把当前结果保存在本地 sidecar，由仅限 loopback 的同源 Web route 提供给卡片；不会向会话消息历史追加摘要正文。

## 安装

```bash
# GitHub 安装（推荐）
dsh plugin --profile web add github:DDDFXYqiming/dsh-session-recap
```

从本地源码安装的方式如下。

```bash
git clone https://github.com/DDDFXYqiming/dsh-session-recap.git
cd dsh-session-recap
npm install && npm run build
dsh plugin --profile web add <本目录绝对路径>
```

GitHub 安装会触发 `prepare` 脚本重新构建 `lib/`。pnpm ≥10 首次 `add` 会拒绝运行该构建脚本：把 pnpm 打印的包键复制进 profile 的 `pnpm-workspace.yaml` 后重新 `add` 即可，例如：

```yaml
allowBuilds:
  '@dsh-external/dsh-session-recap': true
```

请把这项授权视为「允许该包代码在安装时于你的机器上执行」；担心后续推送改变构建内容时，锁定 commit（`github:DDDFXYqiming/dsh-session-recap#<sha>`）。

插件自带 `cordis.patch.yml`，安装后会自动加入 `dsh-session-recap` bundle 条目。首次安装后重启 Web profile，再刷新页面。

## 配置

bundle 安装提供默认条目；需要覆盖配置时，在 profile 的 `cordis.patch.yml` 中使用下面的裸条目。

```yaml
- id: dsh-session-recap
  config:
    enabled: true        # 只控制自动回顾；/recap 始终可用
    idleMs: 180000       # 最后一个完成 turn 到自动回顾的最短时间（毫秒）
    minTurns: 3          # 自动回顾所需的最少完成轮数
    recentMessages: 80   # 进入回顾窗口的最近会话消息数（工具结果不计入）
    maxChars: 400        # 回顾文本上限
    maxInputChars: 24000 # 回顾输入上限（字节）
    maxOutputTokens: 1024 # 回顾模型的输出 token 预算（思考型模型把思考 token 也算进该预算）
    timeoutMs: 30000
    provider: ''         # 留空：复用会话最近实际使用的 provider
    model: ''            # 留空：复用会话最近实际使用的 model；固定路由时与 provider 一起填写
    reasoningEffort: ''  # 留空：插件不传思考等级；也可填写目标适配器支持的 id
    # temperature: 0.2   # 可选；省略时使用目标模型/适配器默认值
    stopSequences: []    # 可选停止词列表
```

`provider` 与 `model` 必须成对填写；同时留空时，自动回顾和 `/recap` 都复用会话最新 `request/context` 中的实际路由，回顾默认跟着会话真正在用的模型走，不需要单独为它指定路由。默认不会继承或传递会话的 `reasoningEffort`，目标模型适配器仍可应用自己的默认值。回顾路由若跟着思考型会话模型走，思考 token 会占用 `maxOutputTokens` 预算：预算耗尽但已有文本时直接使用截断结果；没有文本时自动按 4 倍（上限 4096）预算重试一次，仍失败才报错——此时可继续调大 `maxOutputTokens`，或用 `provider`+`model` 为回顾固定一个非思考模型。上述覆盖项与输入/输出边界、超时设置同时适用于自动和手动回顾。

## 存储布局

```text
<home>/.dsh/plugin-data/dsh-session-recap/
└── <encoded-session-id>.json
```

sidecar 只保存当前会话的回顾文本、生成时间和完成轮次锚点。DSH 的 session log 是 append-only 的，插件不改它的事件词汇，也不往里写自定义事件。旧回顾会被清理。会话前进后，每个会话留下的始终是当前那一份回顾。

## 兼容性

| 项目 | 版本或范围 |
| --- | --- |
| dsh-session-recap | `0.1.5`（`package.json`） |
| DeepSeek Harness packages | `0.1.2-rc.1` |
| Node.js | `^22.19.0 \|\| >=24.0.0`（与 DSH 当前运行时范围一致） |
| 使用面 | DSH Web profile；需要 LLM、session、commands、locale、conversation、slots 和 web-server 服务 |

## 开发与验证

```bash
npm install
npm run typecheck
npm run build
npm test
npm run build:client
npm pack
```

构建脚本优先使用本地依赖。针对 DSH checkout 开发时可以设置 `DSH_CHECKOUT`，也可以设置 `DSH_GLOBAL_NODE_MODULES` 指向兼容的全局 `node_modules`。脚本只补建缺失的链接，不替换已有的包。

插件不调用宿主的 `deepFreeze`（该导出在旧版宿主属于 `dsh-llm`、新版迁移到了 `dsh-util-values`，静态 import 任意一侧都会打死另一侧的宿主），请求冻结由插件内本地实现完成，因此同一份产物同时兼容新旧 DSH。

## 相关

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [pi-recap](https://github.com/DDDFXYqiming/pi-recap)：同一行为在 Pi Coding Agent TUI 上的实现
- [GitHub Releases](https://github.com/DDDFXYqiming/dsh-session-recap/releases)

## 授权

MIT
