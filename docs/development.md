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
