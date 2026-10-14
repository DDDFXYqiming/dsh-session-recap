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

## 运行中宿主的免重启换代

DSH 的 Loader 对插件模块的 import 按（specifier，解析基址）缓存：同名重导入永远命中旧模块，改配置只走 `internal/update` 不重新 import。`link:` 源码安装的插件要让运行中的宿主吃到新构建，唯一免重启路径是**换一个全新的 specifier 触发全新 import**：

1. 构建产物拷到全新路径（如 `.install/<版本>/`，`.install/` 已在 .gitignore）。
2. 在 `profiles/<p>/node_modules/@dsh-external/` 下建真实包目录（如 `dsh-session-recap-live`），`package.json` 的 `name` 必须等于包名本身（client 图按 name 字段归属行），`lib/` 拷自新产物，`node_modules` 建链接指向源码仓库的 `node_modules` 供运行期依赖解析。
3. 改该副本 `lib/client.js` 里烘焙的 `__ModuleLoader__.load({ id: ... })` 为新包名——client 图的行 id 是包名，与烘焙 id 不一致时 bundle 加载即抛“loaded without registering”。
4. 在 profile 的 `cordis.patch.yml` 用裸条目停用旧 entry、用 `insert` 增加指向新包名的新 entry（id 不可与旧条目重复），patch watcher 触发换代。
5. 强刷 GUI 页面装载新 client bundle。

注意：该载体包不在 profile 的 `package.json` 依赖里，profile 上跑 pnpm 安装可能清掉它，需要按本节重建；正常的版本更新与安装走受管通道即可，无需此流程。
