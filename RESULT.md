# dsh-session-recap 真正卸载 + 探针默认关闭（lag7 收尾）

jobId: bob-dev-dsh-recap-lag7-20261014
时间: 2026-10-14 15:00 - 15:08
范围: 只动 recap。禁 PowerShell、禁 GUI 端到端、禁查其他插件（`dsh-layered-memory` 一个字没碰）。
承接: bob-dev-dsh-recap-lag6-20261014（那份报告在 `AgentJobs/bob-dev-dsh-recap-lag6-20261014/RESULT.md`，仓库旧版被本次覆盖）

一句话：lag6 只把插件"禁了"，没"卸了"。这次把安装面全部拆干净，GUI 应该显示「未安装」；顺带把最可能的卡顿源（路由探针默认关）提交并推送。

---

## 一、真正卸载（desktop profile）

| 文件 | 动作 |
|---|---|
| `~/.dsh/profiles/desktop/package.json` | `dsh.profile.bundles` 去掉 `@dsh-external/dsh-session-recap`；`dependencies` 去掉 `link:C:/Users/39795/Desktop/AI_project/dsh-session-recap` |
| `~/.dsh/profiles/desktop/pnpm-lock.yaml` | importer `.` 下那三行 link 记录删除，全文再 grep 0 命中 |
| `~/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-session-recap` | junction **本身**删除 |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | 正式条目 `- id: dsh-session-recap / disabled: true` 删除，换成一段说明注释 |
| `~/.dsh/profiles/desktop/cordis.yml` | 同名条目删除（这文件是 loader 回写的合成树，下次启动会被重写成空根） |
| `~/.dsh/profiles/desktop/node_modules/.package-map.json` | pnpm 生成的包映射里两处 recap 键清掉，免得再被读成"已安装" |

删链接的做法：node 脚本 `AgentJobs/bob-dev-dsh-recap-lag7-20261014/unlink-recap.cjs`。先 `lstat` 断言是链接、再断言 `realpath` 就是本仓库，才 `unlinkSync`；删完复查仓库 `package.json` 仍在才返回 `REPO INTACT`。**没有用 Git Bash 的 `rm`，更没有 `ln -s`**（那玩意在这台机器上会复制目录）。

备份：`~/.pi/agent/backups/recap-uninstall-20261014-150002/`（package.json、pnpm-lock.yaml、cordis.patch.yml、cordis.yml、.package-map.json 五份原件）

自检：`AgentJobs/bob-dev-dsh-recap-lag7-20261014/verify-uninstall.cjs`，11 项全 OK —— package.json 全文无 recap、bundles 剩 8 项、dependencies 剩 8 项且不含 recap、cordis.patch.yml 21 条里 0 条 recap、pnpm-lock 全文 0 命中、链接与 live 目录都不存在、**其他插件链接未被动**（`dsh-annotation-patched` 仍在）、仓库本体完好。

`~/.dsh/plugin-data/dsh-session-recap/` 里的会话快照和 route-probe.log 保留没删：那是用户数据，插件卸载后不会再被写，要清空自行删目录。

---

## 二、为什么 lag6 写了 disabled，UI 还显示「已安装且开启」

三条互相独立的原因，任何一条都够解释一半，合起来就是"禁了跟没禁一样"：

1. **「已安装」判的是 package.json 的 dependencies / bundles，跟 patch 层条目无关。** lag6 只把 patch 条目改成 `disabled: true`，包还挂在依赖里 → 插件管理器照旧显示已安装。这也是这次要清到"与 GUI 未安装一致"的那部分。
2. **「开启」判的是运行中宿主的 loader 树。** patch 层是**启动时**合成的，宿主不重启，内存里还是旧树，`disabled` 根本还没被读到 → 显示开启，并且继续加载、继续卡。
3. **当时真正在跑的不是这条被禁的正式条目。** 同一个 `cordis.patch.yml` 里还手搓挂了一条 `insert: dsh-session-recap-live`（`enabled: true`）加真实目录 `node_modules/@dsh-external/dsh-session-recap-live/`。loader 只对 `disabled` 的正式条目提前 return，insert 出来的是另一条，拦不住。所以"禁了还在卡"完全说得通。

外加一条背景：pnpm-lock 的 importer 记录和 junction 都留着，包随时可解析 —— 只要合成层里还有任何一条引用，它就能被重新拉起来。lag6 的"禁"没有触及这层。

---

## 三、最小修复（卡顿源）

- **live 已彻底不在**：patch 层无该条目、`dsh-session-recap-live/` 目录不存在、`node_modules/.pnpm` 无、`.package-map.json` 无、`super-injector/` 三个文件 0 命中。
- **routeProbe 默认关已提交并推送**：`d1da091 perf(config): 路由判定探针默认关闭（routeProbe=false）` → `origin/main`（`678e264..d1da091`）。探针原本在 `/recap` 路由热路径上同步 `appendFileSync`，且拒绝请求永远留档，桌面壳轮询客户端下等于持续打盘；现在默认 `false`，关闭时挂空实现，判定逻辑一行都不进。
- **生效条件（重要）**：必须**完全退出 `DeepSeek Harness.exe` 再开**。关窗口、关标签页、最小化都不算 —— 插件树只在进程启动时合成一次，patch 层改动和卸载结果都在那一刻才落地。
- **本机现状**：进程树显示新的 `DeepSeek Harness.exe`（PID 32036）起于 **15:04:44**，晚于本次清理（15:00:28 - 15:00:53）；`cordis.yml` 在 **15:04:46** 被 loader 重写成空根，说明这次启动就是按清理后的配置重新合成的。`plugin-data/dsh-session-recap/route-probe.log` 最后写入仍是 14:14:42，新进程起来后没再增长。15:07 再跑一遍自检，11 项仍全 OK。

也就是说：如果你现在在 GUI 里还看到 recap 显示已安装，那是 UI 缓存在骗你，重开一次管理器窗口或再完全重启一次宿主即可；卡顿如果还在，那就不是 recap 这条线了。

---

## 四、没做的 / 需要你知道的

- 没杀、没重启任何 dsh 进程（红线）。15:04:44 那次重启是宿主自己发生的，不是我干的。
- 没动 `dsh-layered-memory` 和任何其他插件。
- **仓库里有并发编辑**：14:59:25 的 `src/client.js` / `lib/client.js`、15:01:04 的 `test/client-banner.test.mjs`（客户端轮询成本重构那套改动）不是本 job 写的，本机有 `codex.exe`（PID 6760）在跑。这 3 个文件**没提交、没还原、没碰**，本次 commit 只带 `src/index.ts`、`lib/index.js`、`lib/index.d.ts` 三个文件。
- 恢复办法：package.json 依赖里加回 `link:` 重新安装，**别在 patch 层补条目**（补丁层加条目 ≠ 安装，管理器还是看不见）。

## 五、脚本

- `AgentJobs/bob-dev-dsh-recap-lag7-20261014/unlink-recap.cjs` —— 带断言的解链脚本
- `AgentJobs/bob-dev-dsh-recap-lag7-20261014/verify-uninstall.cjs` —— 卸载后 11 项自检，可重复跑
