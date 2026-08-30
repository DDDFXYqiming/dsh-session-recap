简体中文 | [English](README.en.md)

# @dsh-external/dsh-session-recap

**DeepSeek Harness（DSH）会话回顾插件** —— 当你切走会话或让 Web 窗口失焦后，在后台生成 Claude Code 风格的 Away Summary，返回时用简短回顾概括整体目标、当前任务和下一步。

## 能力

- 仅在 Web 窗口失焦或切走当前会话时后台生成；窗口保持聚焦时不会因单纯空闲而调用模型。
- 默认要求最后一个完成 turn 已过去 3 分钟且会话至少有 3 个完成 turn，同一 turn 不会连续生成两次。
- `/recap` 随时按需生成，并在同一张回顾卡片中显示；关闭自动回顾不影响手动命令。
- 自动回顾以带“回顾 / Recap”标题和关闭按钮的卡片显示在 Web 对话输入框上方，最长 400 字符。
- 横幅按会话与回顾对应的完成轮次隔离；关闭后切换会话再切回不会重新出现。
- 发送新消息、切换会话或关闭横幅后，当前回顾会隐藏；后台标签页在重新可见时显示。
- 中英文界面标签；默认复用当前会话最近实际使用的 provider/model，也可覆盖模型、思考等级、temperature、输出预算、停止词和超时等参数。
- 回顾状态写入插件 sidecar，不向 DSH append-only session log 添加插件自定义事件。

## 工作方式

1. Web client 把窗口 focus/blur、页面可见性和会话切换映射为当前会话的 `active` / `away` 状态。
2. Host 只在会话处于 `away`、最后一个完成 `turn/end` 已超过 `idleMs`、完成轮数达到 `minTurns` 时启动自动回顾。
3. 插件从最近的派生会话消息构造有界输入，通过一次独立辅助 LLM 请求生成不超过 40 词、1–2 个纯文本句子的目标 / 进展 / 下一步回顾。
4. 如果会话在请求期间开始新 turn、完成了更新的 turn，或被销毁，旧请求结果不会提交。
5. 自动回顾和手动 `/recap` 都把当前结果保存在本地 sidecar，由仅限 loopback 的同源 Web route 提供给卡片；不会向会话消息历史追加摘要正文。

## 安装

```bash
# GitHub 安装（推荐）
dsh plugin --profile web add github:DDDFXYqiming/dsh-session-recap
```

本地开发：

```bash
git clone https://github.com/DDDFXYqiming/dsh-session-recap.git
cd dsh-session-recap
npm install && npm run build
dsh plugin --profile web add <本目录绝对路径>
```

插件自带 `cordis.patch.yml`，安装后会自动加入 `dsh-session-recap` bundle 条目。首次安装后重启 Web profile，再刷新页面。

## 配置

bundle 安装提供默认条目；需要覆盖配置时，在 profile 的 `cordis.patch.yml` 中使用下面的裸条目：

```yaml
- id: dsh-session-recap
  config:
    enabled: true        # 只控制自动回顾；/recap 始终可用
    idleMs: 180000       # 最后一个完成 turn 到自动回顾的最短时间（毫秒）
    minTurns: 3          # 自动回顾所需的最少完成轮数
    recentMessages: 30   # 发送给回顾请求的最近派生消息数
    maxChars: 400        # 回顾文本上限
    maxInputChars: 24000 # 回顾输入上限（字节）
    maxOutputTokens: 512 # 回顾模型的输出 token 预算
    timeoutMs: 30000
    provider: ''         # 留空：复用会话最近实际使用的 provider
    model: ''            # 留空：复用会话最近实际使用的 model；固定路由时与 provider 一起填写
    reasoningEffort: ''  # 留空：插件不传思考等级；也可填写目标适配器支持的 id
    # temperature: 0.2   # 可选；省略时使用目标模型/适配器默认值
    stopSequences: []    # 可选停止词列表
```

`provider` 与 `model` 必须成对填写；同时留空时，自动回顾和 `/recap` 都复用会话最新 `request/context` 中的实际路由。默认不会继承或传递会话的 `reasoningEffort`；目标模型适配器仍可应用自己的默认值。上述覆盖项与输入/输出边界、超时设置同时适用于自动和手动回顾。

## 存储布局

```text
<home>/.dsh/plugin-data/dsh-session-recap/
└── <encoded-session-id>.json
```

sidecar 只保存当前会话的回顾文本、生成时间和完成轮次锚点。它不改变 DSH session log 的事件词汇，旧回顾在会话前进后会被清理。

## 兼容性

- DeepSeek Harness packages：`>=0.1.1-rc.2 <1`
- Node.js：`^22.19.0 || >=24.0.0`（与 DSH 当前运行时范围一致）
- 使用面：DSH Web profile；需要 LLM、session、commands、locale、conversation、slots 和 web-server 服务

## 开发与验证

```bash
npm install
npm run typecheck
npm run build
npm run build:client
npm pack
```

构建脚本优先使用本地依赖；针对 DSH checkout 开发时可设置 `DSH_CHECKOUT`，或设置 `DSH_GLOBAL_NODE_MODULES` 指向兼容的全局 `node_modules`。只补建缺失链接，不替换已有包。

## 相关

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Claude Code：Session recap](https://code.claude.com/docs/en/interactive-mode#session-recap)
- [Claude Code：`/recap` 与 prompt cache](https://code.claude.com/docs/en/prompt-caching#running-%2Frecap)
- [GitHub Releases](https://github.com/DDDFXYqiming/dsh-session-recap/releases)

## 授权

MIT
