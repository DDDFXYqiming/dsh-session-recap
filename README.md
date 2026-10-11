简体中文 | [English](README.en.md)

# @dsh-external/dsh-session-recap

**面向 DeepSeek Harness (DSH) Web 的长程任务会话智能回顾扩展**。

在复杂的工程对话中，开发者频繁在多个会话或外部窗口间来回切换。`dsh-session-recap` 在后台无缝追踪页面可见性与空闲状态，当用户离开或切换会话达到设定阈值时，自动调用辅助模型提炼出当前任务的核心目标、已落地的关键改动与明确的下一步动作；当重新切回时，输入框上方即时呈现结构化卡片，快速召回思路。

---

## 核心特性

* **多端会话感知（Presence Tracking）**：通过客户端心跳与租约机制，精准聚合追踪浏览器的 `active` 与 `away` 状态。只有在当前会话真正失焦且空闲满阈值（默认 3 分钟且至少 3 个完成轮次）时触发，杜绝无效开销。
* **零侵入持久化（Sidecar Storage）**：回顾内容以独立 Sidecar 文件形式存储于 `~/.dsh/plugin-data/dsh-session-recap/`，严禁向 DSH 追加型会话事件日志中写入杂质数据，不占用主模型上下文 Token。
* **动态语言与内容契约**：自动剔除沉余的工具日志与底层执行细节，以最近的真实用户指令为锚点，提取压缩摘要。严格遵循用户语言输出 2~4 句纯文本硬核结论，杜绝模板客套话。
* **深厚安全边界**：内置专有 API 路由防护，严格校验 Loopback 本地回环、精确 Host 匹配与 Same-Origin 来源，杜绝 DNS Rebinding 与跨端口伪造风险。
* **双模支持**：Web 界面通过优雅卡片呈现并支持一键隐藏；无界面配置下（Headless）支持通过 `/recap` 终端指令直接回传纯文本。

---

## 架构与工作流程

```
[Web 窗口失焦 / 切换会话] ──> [Presence Lease 判定 Away]
                                      │
                                      ▼ (达到 idleMs + minTurns)
[Sidecar 文件存储] <── [提取意图 / 过滤工具] <── [独立辅助模型提炼]
         │
         ▼
[切回会话 ──> 输入框上方渲染结构化卡片]
```

---

## 安装与快速上手

### 通过 DSH 插件系统安装（推荐）

```bash
dsh plugin --profile web add github:DDDFXYqiming/dsh-session-recap
```

### 本地源码安装

```bash
git clone https://github.com/DDDFXYqiming/dsh-session-recap.git
cd dsh-session-recap
npm install && npm run build
dsh plugin --profile web add .
```

*若使用 pnpm 10+ 遇到构建权限拦截，请在 Profile 对应的 `pnpm-workspace.yaml` 中将 `@dsh-external/dsh-session-recap` 加入 `allowBuilds: true`。*

安装后重启 Web Profile 并刷新浏览器即可生效。

---

## 配置指南

插件已内嵌开箱即用的默认规则。如需自定义，可在对应 Profile 的 `cordis.patch.yml` 中配置：

```yaml
- id: dsh-session-recap
  config:
    enabled: true        # 是否开启自动回顾（关闭后仍支持手动 /recap）
    hostCommand: false   # Web 模式请保持 false；纯终端 Headless 模式可设为 true
    idleMs: 180000       # 触发前所需空闲时长（毫秒，默认 3 分钟）
    minTurns: 3          # 触发所需完成的最小轮次数
    recentMessages: 80   # 提取意图的最大最近对话条数
    maxChars: 400        # 回顾正文字符上限（纯文本输出）
    maxInputChars: 24000 # 输入上下文截取长度
    maxOutputTokens: 2048 # 模型最大输出 Token 预算
    timeoutMs: 30000     # 请求超时时限
    provider: ''         # 为空时自动沿用当前会话的模型服务商
    model: ''            # 为空时自动沿用当前会话的模型
```

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
