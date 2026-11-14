# Changelog

本文件由 AI 从 git 历史归纳生成，发版时更新。

格式遵循 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased] [[compare]](https://github.com/ceynri/mi-recording-cli/compare/v0.1.0...HEAD)

## [0.1.0] - 2026-11-15 [[release]](https://github.com/ceynri/mi-recording-cli/releases/tag/v0.1.0)

初始发布，覆盖小米云服务录音网页端的全部能力：

- 登录、静默续期，首次使用时只读导入 mi-note-cli 的登录态
- 录音列表、搜索、详情、按类型 / 月 / 年统计，支持类型、录音时间、关键词筛选
- 增量拉取 `pull`：拉取记录、断点续传、SHA-1 校验、并发下载、文件名模板、目录独占、`--delete-cloud` 拉完即清
- 按 id 下载（支持先校验再输出到管道）、临时直链、在线播放
- 删除到回收站（按 id、筛选条件或已拉取的录音；本地文件已转移走时需显式 `--allow-moved`），回收站列出、恢复、永久删除
- `--json` 统一输出，非交互模式下破坏性操作必须显式 `-y`
