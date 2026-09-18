简体中文 | [English](README.en.md)

# @dsh-external/dsh-session-recap

**DeepSeek Harness（DSH）会话回顾插件**。你把 Web 窗口切到后台，或者转到另一个会话，它就在后台生成一份简短回顾。等你回来，一张卡片会概括那个会话的当前任务、已完成进展和下一步。

当前插件版本为 **0.1.7**，peer 兼容范围为 DSH `>=0.1.6-alpha.1 <0.2.0-0`。构建直接使用 Node，可在 Windows 与 Linux 下执行 `pnpm build && pnpm test`。

## 为什么需要它

人离开屏幕的理由很多，可能是一场会，也可能是一顿饭。回来时会话还停在原处，思路却断了。往上翻很久的消息记录，才接得上刚才做到哪里。这个插件让用户回来时先读一段短回顾，再决定从哪里继续。回顾由一次独立的辅助 LLM 请求生成，写好的正文不会追加进会话消息历史。

## 能力

- 离开 Web 页面或切换会话后，满足 `idleMs` 和 `minTurns` 才会自动生成；前台停留不会因单纯空闲调用模型。
- `/recap` 可随时手动触发。Web 菜单保留官方图标、中英文标题和说明；无浏览器 profile 可开启 `hostCommand`，直接得到正文。
- 回顾显示在输入框上方，可关闭；新消息或切换会话后会隐藏，每个会话只保留当前回顾。
- 输入会过滤工具输出，保留压缩摘要，并以最近一条真实用户消息定位任务。回顾跟随用户语言，旧模型内联的 think 标签也会被清理。
- 多标签页按客户端聚合 presence，带心跳和租约；会话发生变化时，旧的生成结果会被丢弃。
- 结果只写入插件 sidecar，不修改 DSH 会话日志。provider、model、输出长度和超时可配置。

## 工作方式

1. Web client 报告页面和会话的 `active` / `away` 状态。只有所有有效页面都离开后，Host 才会把会话视为 away。
2. Host 检查 `idleMs`、`minTurns` 和最新完成轮次，构造有界输入后调用辅助模型。
3. 会话开始新轮次、前进或销毁时，旧结果不会提交。有效结果写入 sidecar，再由 Web 卡片或 `CommandResult.text` 展示。

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

GitHub 安装会触发 `prepare` 脚本重新构建 `lib/`。pnpm ≥10 首次 `add` 会拒绝运行该构建脚本。把 pnpm 打印的包键复制进 profile 的 `pnpm-workspace.yaml` 后重新 `add` 即可。下面是一份示例。

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
    hostCommand: false   # Web 保持 false；无浏览器 profile 可设为 true
    idleMs: 180000       # 最后一个完成 turn 到自动回顾的最短时间（毫秒）
    minTurns: 3          # 自动回顾所需的最少完成轮数
    recentMessages: 80   # 进入回顾窗口的最近会话消息数（工具结果不计入）
    maxChars: 1200       # 回顾文本上限
    maxInputChars: 24000 # 回顾输入上限（字节）
    maxOutputTokens: 2048 # 回顾模型的输出 token 预算（思考型模型把思考 token 也算进该预算）
    timeoutMs: 30000
    provider: ''         # 留空：复用会话最近实际使用的 provider
    model: ''            # 留空：复用会话最近实际使用的 model；固定路由时与 provider 一起填写
    reasoningEffort: ''  # 留空：插件不传思考等级；也可填写目标适配器支持的 id
    # temperature: 0.2   # 可选；省略时使用目标模型/适配器默认值
    stopSequences: []    # 可选停止词列表
```

`provider` 与 `model` 必须成对填写；同时留空时，自动回顾和 `/recap` 都复用会话最新 `request/context` 中的实际路由，回顾默认跟着会话真正在用的模型走，不需要单独为它指定路由。默认不会继承或传递会话的 `reasoningEffort`，目标模型适配器仍可应用自己的默认值。回顾路由若跟着思考型会话模型走，思考 token 会占用 `maxOutputTokens` 预算。预算耗尽时，只要已有至少一个完整句子就直接交付；完全没有完整正文才按 4 倍预算（上限 4096）重试一次。上述覆盖项与输入/输出边界、超时设置同时适用于自动和手动回顾。

`hostCommand` 决定 `/recap` 的唯一所有者。Web profile 保持默认值，由客户端贡献完整菜单样式；只有不加载 Web 客户端的 profile 才设为 `true`，由宿主命令在终端或其他命令面直接返回正文。同一 profile 不要同时启用两种所有者。

## 存储布局

```text
<home>/.dsh/plugin-data/dsh-session-recap/
└── <encoded-session-id>.json
```

sidecar 只保存当前会话的回顾文本、生成时间和完成轮次锚点。DSH 的 session log 是 append-only 的，插件不改它的事件词汇，也不往里写自定义事件。旧回顾会被清理。会话前进后，每个会话留下的始终是当前那一份回顾。

## 兼容性

| 项目 | 版本或范围 |
| --- | --- |
| dsh-session-recap | `0.1.7`（`package.json`） |
| DeepSeek Harness packages | 兼容范围 `>=0.1.6-alpha.1 <0.2.0-0`（peerDependencies）；构建与测试钉在 `0.1.6-alpha.1`（devDependencies/overrides，保证可复现构建与 git 安装解析），`0.1.6-alpha.2` 宿主实测运行 |
| Node.js | `^22.19.0 \|\| >=24.0.0`（与 DSH 当前运行时范围一致） |
| 使用面 | 所有提供 LLM 与 session projection 服务的 DSH profile。宿主命令另需 commands；Web 卡片另需 locale、conversation、slots 和 web-server 服务 |

## 开发与验证

```bash
npm install
npm run typecheck
npm run build
npm test
npm run test:upstream # 需设置 DSH_UPSTREAM_ROOT；默认核对 dsh-v0.1.6-alpha.1
npm run build:client
npm pack
```

构建脚本优先使用本地依赖。针对 DSH checkout 开发时可以设置 `DSH_CHECKOUT`，也可以设置 `DSH_GLOBAL_NODE_MODULES` 指向兼容的全局 `node_modules`。脚本只补建缺失的链接，不替换已有的包。上游结构测试默认使用发布标签 `dsh-v0.1.6-alpha.1`；需要检查更新的源码时可通过 `DSH_UPSTREAM_REF` 指定分支、标签或提交，不在文档中把会移动的 `master` 写成固定事实。

插件不调用宿主的 `deepFreeze`。请求选项的冻结由插件内本地实现完成，避免依赖这个内部导出的迁移位置。

## 相关

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [pi-recap](https://github.com/DDDFXYqiming/pi-recap)，同一行为在 Pi Coding Agent TUI 上的实现
- [GitHub Releases](https://github.com/DDDFXYqiming/dsh-session-recap/releases)

## 授权

MIT
