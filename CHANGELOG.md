# Changelog

## [0.1.13] - 2026-10-17

### 变更（按 DSH 官方插件规范补齐元数据与文档）
- package.json 增加 `engines.dsh` 兼容范围与 `dsh.manifestVersion` 格式标识，补齐 `author` 与 `homepage`。
- 新增 `locale/en.json` 与 `locale/zh.json` 提供插件管理页的展示标题与描述，`exports` 与 `files` 同步登记。
- 新增 `icon.svg`，36×36 画布、自包含几何。
- `README.md` 改为英文、`README.zh.md` 改为中文，按官方结构补齐概述、目录、实现机制、模型体验、已知限制与开发者备注；删除内容重复的 `README.en.md`。
