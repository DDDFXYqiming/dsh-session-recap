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

上游结构测试默认使用发布标签 `dsh-v0.1.6-alpha.1`。需要核对更新的源码时，用 `DSH_UPSTREAM_REF` 指定分支、标签或提交，不要依赖会移动的引用。

## 实现约束

请求选项的冻结在插件内本地实现。

## 信任栅栏与桌面壳（0.1.11）

DSH 桌面壳把应用挂在自定义协议 `dsh-app://app/` 下，页面 fetch 经壳转发到宿主 webserver 时**不携带 `Origin` 头**（2026-10-14 实测：探针日志 `origin=` 为空）。因此路由信任栅栏必须与 DSH 自己的 `/api` 栅栏同口径：回环远端 + 锚定 `Host` 栅栏，`Sec-Fetch-Site: cross-site` 与字面 `null` 来源拒绝，`Origin` 缺席放行、存在则比对 host。任何要求“逐字节同源 Origin”的判定在桌面壳下会把全部请求误杀成 `403 forbidden origin`。诊断同类问题直接读 sidecar 目录的 `route-probe.log`。

## 客户端调度

回顾卡片仅通过 HTTP 读取宿主的 sidecar 结果，不订阅会话时间线。宿主在新回合开始后清除旧回顾；响应中的 `recap: null` 会隐藏卡片。若响应包含可选的 `turnSeq`、`turnOpen`，客户端也会据此识别过期结果。

有卡片、失败提示或手动生成请求时，每 1.5 秒拉取；其余时间每 10 秒拉取。页面隐藏时暂停拉取，重新可见或获得焦点时立即补取。单次请求超时为 4 秒，卸载组件时中止在途请求并清除定时器。关闭记录包含会话、回合序号和生成时间，并在当前页内缓存。

在线心跳每 20 秒发送一次，小于宿主的 45 秒租约；同一会话的重复焦点通知在 2 秒内合并。

## 安装与更新

使用插件管理器维护正式包的安装记录。本地源码安装指向仓库根目录，构建后的 `lib` 与源码保持同步。宿主会缓存服务端模块导入，因此服务端更新完成后需完全退出并重新打开宿主。

路由探针 `routeProbe` 默认关闭，排查来源判定时可临时开启。诊断完成后恢复关闭，避免在请求路径执行同步文件写入。
