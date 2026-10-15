# 回顾插件维护记录

## 2026-10-15：CI 内存与 Linux 正式安装验证

任务：`bob-dev-recap-ci-oom-20261015`。验证代码为 main 的 `9c83014e54a428341ccf659a50b72f090e53cc3b`。

### 结论与阻塞

已完成同版 DSH 安装、插件正式打包安装、真实 Web 宿主启动、插件路由检查、本地 Node 22 / 24 的现有 CI 检查。未发现这些已验证范围内的退化。

按用户续接要求，停在第 3 步模型接入：本机未发现可用模型 API key，原先也没有 DSH home 或已配置的 DSH 凭据。候选为 OpenRouter 免费模型，但免费模型仍需 Bearer API key。本次没有接入模型、没有发出模型 API 请求；多轮真实对话、手动 `/recap`、离开页面后的自动回顾、生成期间 CPU/内存和页面卡顿均**尚未验证**，不能宣称完整端到端通过或完全没有功能退化。

继续条件：在这台云电脑安全配置有效的 `OPENROUTER_API_KEY`（可用免费模型额度），或提供另一套已授权的免费兼容服务地址、模型 ID 和必要凭据。无需把明文密钥写入本报告或提交到仓库。凭据就绪后再通过 DSH 正常配置模型并完成多轮会话、手动及自动回顾验证。

### 根因及代码范围

- 原故障提交 `133fe1f5fdf2c632020cbe4f8cc754d15dba6b06` 的 CI 在 TypeScript 阶段约 50 秒后耗尽约 4 GiB 堆。
- 拉取时 main 已有 `9c83014`：插件原有 `zod: ^4.4.3` 在锁文件中解析成 `4.5.4`，而 DSH alpha.3 的投影契约使用 `4.4.3`。注册投影时比较两份递归 schema 类型造成类型检查膨胀。该提交把插件 Zod 精确固定为 `4.4.3` 并更新锁文件，已有 CI 通过。
- 对当前 TypeScript Program 实测：共 324 个文件，非声明源文件只有 `src/index.ts`、`src/types.ts`；宿主包通过已发布 `.d.ts` 参与类型解析，没有把宿主实现源码带进编译。因此本次保留已有根因修复，未进一步改动构建方式，也未提高 Node 堆上限。
- `133fe1f..9c83014` 的 `src/`、`lib/`、`scripts/`、`tsconfig.json` 均无差异。修复涉及 `package.json`、`pnpm-lock.yaml`、`docs/development.md`；本次续接仅更新 `RESULT.md`，未改插件功能、未碰其他插件、未添加单元测试。

### 安装版本与方式

- Linux；构建及宿主运行使用 Node `22.23.3`，另用 Node `24.22.0` 执行现有离线检查；pnpm `10.34.6`。
- 从官方 npm 安装：`npm install --prefix /home/box/.local/opt/dsh-recap-e2e @deepseek-ai/dsh@0.2.1-alpha.3`。`dsh --version` 返回 `0.2.1-alpha.3`。
- 来源核对：npm 的 `@deepseek-ai/dsh@0.2.1-alpha.3` 存在，且官方 README 使用该 scoped 包；顺带查询的非官方包名 `deepseek-harness@0.2.1-alpha.3` 返回 404。
- 插件为 `@dsh-external/dsh-session-recap@0.1.12`。先按 README 试用 `dsh plugin --profile web add <仓库绝对路径>`，pnpm 会生成源码 `link:`；为确保最终是独立正式包，随后在 Node 22 下执行 `npm pack`，再用同一官方管理器安装生成的 `.tgz`，替换该源码链接。
- 最终 profile：`/home/box/.dsh/profiles/web`，依赖记录为 `file:/workspace/jobs-src/artifacts/bob-dev-recap-ci-oom-20261015/dsh-external-dsh-session-recap-0.1.12.tgz`。已安装目录不是软链接，五个 `lib/` 文件与 main 产物逐字节一致。
- 管理器自动登记 bundle；profile 的 `cordis.patch.yml` 保持默认空数组，未手写加载 patch，未使用 live 载体。

### 已执行验证

1. Node 22：`pnpm install --frozen-lockfile`，包括真实 `prepare` 构建钩子，成功。
2. 单独执行 `node scripts/build.mjs`：成功；记录的一次构建耗时 `1.14 s`，子进程峰值 RSS `250348 KiB`（约 `244.5 MiB`），未设置额外堆参数；`lib/` 与提交内容一致。
3. Node 22 / 24：均执行现有 `pnpm test`、`pnpm run typecheck`、`pnpm run build`、`git diff --exit-code -- lib`，全部成功。每个 Node 版本均为 23 项 self-check 和 10 项现有测试通过；这些是离线测试，不能替代真实模型验证。
4. 启动正式宿主：`dsh web --no-open --port 0`，成功监听 loopback；启动日志无错误。组合配置包含自动安装的 `dsh-session-recap` 条目。
5. 真实 HTTP 检查：`GET /api/dsh-session-recap` 返回 400 和 `sessionId is required`；对不存在的 session ID 返回 200 和 `{"recap":null,"manualRequestTimeoutMs":70000}`。证明插件成功加载、路由已挂载，不代表已生成回顾。
6. 宿主空闲采样 10 秒：RSS 稳定约 `255.93 MiB`，各采样区间 CPU 为 `0–0.5%`（单核百分比）；只覆盖无会话、无模型请求的空闲状态，不能据此判断对话或 UI 性能。取证后已停止本次启动的宿主进程。
7. 打包安装后一次额外构建检查发现开发目录缺少 node_modules，预检直接报缺依赖（不是 OOM）。已重新执行锁文件安装恢复开发环境，再成功完成上述内存测量；失败原始日志另存。

### CI

- 已修复代码提交：`9c83014e54a428341ccf659a50b72f090e53cc3b`。
- [修复提交 CI](https://github.com/DDDFXYqiming/dsh-session-recap/actions/runs/38694274166)：`success`，Node 22、Node 24 均绿；安装、离线测试、类型检查、提交产物一致性检查均成功。
- [原失败 CI](https://github.com/DDDFXYqiming/dsh-session-recap/actions/runs/38690209279)：两个 Node 版本均在 install/prepare 阶段 OOM。

### 本机证据

目录：`/workspace/jobs-src/artifacts/bob-dev-recap-ci-oom-20261015/`。日志保留在云电脑，未把原始运行日志提交到公开仓库。

- `dsh-install.log`、`dsh-cli-help.log`：DSH 安装和版本。
- `plugin-pack.log`、`plugin-install.log`、`plugin-install-package.log`：首次目录安装、最终正式包安装。
- `dsh-composed-config.log`、`installed-plugin-verification.log`：加载配置、产物哈希、真实路由响应。
- `dsh-web-startup.log`：宿主启动，启动 URL token 已脱敏。
- `dsh-idle-resources.json`：空闲 CPU/内存采样。
- `credential-presence.log`：仅记录凭据存在性，无密钥值。
- `build-memory-node22.log`、`frozen-install-node22.log`、`typescript-program-scope.log`：构建内存、安装钩子、编译范围。
- `local-ci-node22.log`、`local-ci-node24.log`、`ci-9c83014.json`：现有本地检查及远程两个 Node job 的结果。
- `build-missing-devdeps.log`：额外检查时开发依赖缺失的原始错误。

官方依据：[DSH 安装说明](https://github.com/deepseek-ai/deepseek-harness)、[OpenRouter 认证](https://openrouter.ai/docs/api_reference/authentication)、[免费模型说明](https://openrouter.ai/docs/guides/routing/model-variants/free)。

## 2026-10-14

- 桌面壳下的来源判定修复保留，路由探针默认关闭。
- 客户端取消会话时间线订阅，改为根据展示状态调整轮询频率。
- 页面隐藏时暂停拉取，恢复可见时补取；在线心跳按会话去重。
- 关闭记录在当前页内缓存，避免渲染时重复访问同步存储。
- 本机恢复正式包安装后，用户确认回顾功能正常。

此前观测到的整页持续卡顿，经 Chromium 性能记录定位到 GenUI 的 DOM 候选扫描调用链。本插件的客户端调度优化用于减少自身常驻开销。
