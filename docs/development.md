# 开发与验证

## 环境

Node.js `^22.19.0 || >=24.0.0`。构建与测试直接使用 Node，可在 Windows 与 Linux 下执行。

## 命令

```bash
npm install
npm run typecheck
npm run build
npm test
npm run test:upstream # 未设置 DSH_UPSTREAM_ROOT 时自动跳过
npm run build:client
npm pack
```

## 构建脚本

构建脚本优先使用本地依赖。针对 DSH checkout 开发时可以设置 `DSH_CHECKOUT`，也可以设置 `DSH_GLOBAL_NODE_MODULES` 指向兼容的全局 `node_modules`。脚本只补建缺失的链接，不替换已有的包。

`zod` 精确固定为 `4.4.3`，与 DSH `0.2.1-alpha.3` 的会话投影契约保持一致。若使用范围版本升级到另一份 Zod，投影注册时会比较两份递归 schema 类型，导致 TypeScript 编译耗尽堆内存。升级 DSH 时应一起核对 Zod 版本，并使用锁文件安装。

上游结构测试默认使用发布标签 `dsh-v0.1.6-alpha.1`。需要核对更新的源码时，用 `DSH_UPSTREAM_REF` 指定分支、标签或提交，不要依赖会移动的引用。

## 实现约束

请求选项的冻结在插件内本地实现。

## 信任栅栏与桌面壳（0.1.11）

DSH 桌面壳把应用挂在自定义协议 `dsh-app://app/` 下，页面 fetch 经壳转发到宿主 webserver 时**不携带 `Origin` 头**（2026-10-14 实测：探针日志 `origin=` 为空）。因此路由信任栅栏必须与 DSH 自己的 `/api` 栅栏同口径：回环远端 + 锚定 `Host` 栅栏，`Sec-Fetch-Site: cross-site` 与字面 `null` 来源拒绝，`Origin` 缺席放行、存在则比对 host。任何要求“逐字节同源 Origin”的判定在桌面壳下会把全部请求误杀成 `403 forbidden origin`。诊断同类问题直接读 sidecar 目录的 `route-probe.log`。

## 客户端调度

回顾卡片仅通过 HTTP 读取宿主的 sidecar 结果，不订阅会话时间线。宿主在新回合开始后清除旧回顾；响应中的 `recap: null` 会隐藏卡片。若响应包含可选的 `turnSeq`、`turnOpen`，客户端也会据此识别过期结果。

有卡片、失败提示或手动生成请求时，每 1.5 秒拉取；其余时间每 10 秒拉取。页面隐藏时暂停拉取，重新可见或获得焦点时立即补取。单次请求超时为 4 秒，卸载组件时中止在途请求并清除定时器。关闭记录包含会话、回合序号和生成时间，并在当前页内缓存。

在线心跳由插件的页面级 effect 管理，每 20 秒发送一次；会话组件只登记当前访问的会话，切换或卸载组件保留应用焦点状态。POST 带 `scope=app`、`clientId`、递增 `seq` 和 `presence=active|away`，`sessionId` 可选。`pagehide` 上报离开，`pageshow` 重新同步。

宿主按客户端聚合整个 WebUI 的状态。活动租约超过 45 秒后记为 `unknown`；所有已知客户端都明确 `away` 才开始记录连续离开时间，重复心跳保留计时起点。自动回顾要求完成回合数达到 `minTurns`，真实用户与助手正文的非空白字符数达到 `minConversationChars`，工具结果与注入内容不计入。到期时间为 `max(lastTurnEnd.time, awaySince) + idleMs`。重新聚焦或状态转为未知时，清除所有自动定时器并取消在途自动任务；发布前再次核对离开 epoch、取消信号、回合锚点与正文字符数。手动任务与自动任务共用每会话调用槽，通过 `mode` 区分取消范围。

升级后刷新 WebUI，让页面使用应用级心跳协议。旧协议请求返回更新提示，待新页面上报后启用自动调度。

## 安装与更新

使用插件管理器维护正式包的安装记录。本地源码安装指向仓库根目录，构建后的 `lib` 与源码保持同步。支持 HMR 的宿主通过插件管理器替换已加载模块并应用更新；更新后刷新 WebUI，同时加载新的页面脚本。是否需要重启以插件管理器返回的应用结果为准。

路由探针 `routeProbe` 默认关闭，排查来源判定时可临时开启。诊断完成后恢复关闭，避免在请求路径执行同步文件写入。
