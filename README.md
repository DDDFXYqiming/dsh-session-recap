简体中文 | [English](README.en.md)

# @dsh-external/dsh-session-recap

**DeepSeek Harness（DSH）会话回顾插件** —— 在会话空闲后生成 Claude Code 风格的 Away Summary，概括当前会话已完成内容、当前状态和下一步。

## 能力

- 会话完成一段时间后自动生成回顾，并支持最少完成轮数配置。
- `/recap` 手动生成当前会话回顾。
- 回顾以短文本横幅显示在 Web 对话输入框上方。
- 横幅按会话与回顾对应的完成轮次隔离；关闭后切换会话再切回不会重新出现。
- 发送新消息、切换会话或关闭横幅后，当前回顾会隐藏；后台标签页在重新可见时显示。
- 中英文界面标签，支持固定 provider/model 或复用当前会话最近路由。
- 回顾状态写入插件 sidecar，不向 DSH append-only session log 添加插件自定义事件。

## 工作方式

1. 插件监听已完成的 `turn/end`，等待配置的空闲窗口，并只取最近的派生会话消息。
2. 通过一次有输入、输出和超时上限的辅助 LLM 请求，生成简短的目标 / 进展 / 下一步回顾。
3. 如果会话在请求期间开始新 turn、完成了更新的 turn，或被销毁，旧请求结果不会提交。
4. 结果保存在本地 sidecar，由 loopback、同源 Web route 提供给客户端；会话前进后旧 snapshot 自动失效。

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
    enabled: true
    idleMs: 180000       # 空闲窗口（毫秒）
    minTurns: 3          # 自动回顾所需的最少完成轮数
    recentMessages: 30   # 发送给回顾请求的最近派生消息数
    maxChars: 400        # 回顾文本上限
    maxInputChars: 24000 # 回顾输入上限（字节）
    maxOutputTokens: 512
    timeoutMs: 30000
    provider: ''         # 留空：复用会话最近 provider
    model: ''            # 留空：复用会话最近 model；固定路由时与 provider 一起填写
```

`provider` 与 `model` 必须成对填写；同时留空时复用会话最近一次请求的路由。

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
- [GitHub Releases](https://github.com/DDDFXYqiming/dsh-session-recap/releases)

## 授权

MIT
