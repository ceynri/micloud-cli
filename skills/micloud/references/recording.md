---
name: mi-recording-cli
description: 小米云服务录音（i.mi.com/record）的命令行工具，可列出、搜索、统计、播放、下载、增量拉取录音到本地，删除录音以及恢复/永久删除回收站里的录音。当用户提到"小米录音"、"小米云录音"、"手机录音同步/下载/导出"、"通话录音/微信录音拉到本地"、"清理云端录音"、"mi-recording-cli"时触发此 skill。
---

# mi-recording-cli

操作小米云服务录音（i.mi.com/record）的 CLI，通过 `npx mi-recording-cli <command>` 执行，无需提前安装。

## 核心原则

- **始终加 `--json`**：输出 `{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": "..." }`；批量操作部分失败仍是 `ok: true`，失败项在 `data.failed`（`pull` 另有 `data.deleteFailed`），退出码 2——每次都检查并向用户报告。
- **登录**：报「未登录」时需由用户在终端执行 `npx mi-recording-cli login`（会打开浏览器）；之后登录态自动续期，不要反复让用户登录。
- **删除会同步到手机**：云端删除的录音会从已登录该账号的设备上一并删除，删除前务必让用户知情。

## 读

```bash
npx mi-recording-cli list --json [--type recorder,phonecall,fm,app] [--since 7d] [--until 2026-07-31] [-q 关键词] [--limit n] [--sort time|size|duration] [--asc]
npx mi-recording-cli search <关键词> --json      # 匹配标题、联系人、号码、来源应用
npx mi-recording-cli info <id> --json            # 单条详情，也会查回收站（data.inTrash）
npx mi-recording-cli stats --json [--by type|month|year]
npx mi-recording-cli whoami --json               # 账号、云空间用量、回收站保留天数
```

录音字段：`id`、`title`（手机上的文件名）、`type`（recorder 录音机 / phonecall 通话 / fm / app 微信等应用录音）、`recordedAt`（录音开始时间，毫秒）、`duration`（秒）、`size`（字节）、`sha1`、`extension`、`contactName` / `phoneNumber` / `appName`（能解析时）。时间参数支持 `2026-07-01`、`2026-07-01 18:30`、`7d`/`12h`/`2w`、`today`、`yesterday`。

## 下载

```bash
npx mi-recording-cli pull -o <dir> --json [筛选参数] [--limit n] [--dry-run]   # 增量拉取
npx mi-recording-cli download <id...> -o <dir> --json                         # 按 id 下载（不记录拉取状态）
npx mi-recording-cli download <id> --stdout > a.mp3                           # 输出音频到管道
npx mi-recording-cli url <id...> --json                                       # 临时直链（免登录、约数小时有效，勿外传）
```

- `pull` 用拉取目录里的 `.mi-recording-cli.state.json` 记录已拉取的录音，之后跳过——即使本地文件已被移走；重新下载用 `--force` 或 `download <id>`。
- 下载经大小与 SHA-1 校验、断点续传，绝不覆盖内容不同的已有文件（改存为 `<文件名>_<id>`）；同一拉取目录同时只能运行一个 pull。
- `data.pulled[]` 每项含完整录音字段与 `file`（本地绝对路径），可直接交给转写等后续处理。
- 文件名模板：`--template` 或 `config set fileNameTemplate`，占位符 `${title}` `${YYYY}`…`${ss}` `${type}` `${typeName}` `${contact}` `${phone}` `${app}` `${duration}` `${id}`，`/` 分子目录，`[...]` 条件段；详见 `npx mi-recording-cli pull --help`。

## 删除与回收站

```bash
npx mi-recording-cli delete <id...> -y --json                      # 移到回收站
npx mi-recording-cli delete --pulled -o <dir> --dry-run --json     # 预览：已拉取、本地文件完好、云端未变的录音
npx mi-recording-cli delete --pulled -o <dir> --allow-moved --dry-run --json  # 本地文件已转移走时
npx mi-recording-cli delete --type app --until 2026-03-31 -y --json
npx mi-recording-cli pull -o <dir> --delete-cloud -y --json        # 拉取校验后把云端移到回收站
npx mi-recording-cli trash --json                                   # 回收站列表（含 deletedAt、expiresAt）
npx mi-recording-cli trash restore <id...> --json                   # 恢复（或 --all）
npx mi-recording-cli trash purge <id...> -y --json                  # 永久删除（或 --all），不可恢复
```

删除类命令在 `--json` / 非交互下不带 `-y` 会直接报错。删除只进回收站（按会员等级保留 30–180 天）。`--pulled` / `--delete-cloud` 只删拉取时校验过、云端未变、且拉取目录里的文件仍完好的录音；文件已被转移走的默认不删（`data.skipped` / `data.deleteSkipped` 里 `code: "local-missing"`），只有用户确认文件已妥善保存时才加 `--allow-moved`。被本工具删过又被恢复的录音视为有意保留（`code: "kept"`），不会再被自动删除。

## Agent 执行删除的约束

执行 `delete`、`pull --delete-cloud`、`trash purge` 前：

1. 先用 `--dry-run`（`trash purge` 用 `trash --json`）拿到将受影响的录音清单，向用户展示条数、标题、录音时间与总时长，并提醒「手机上的录音也会被删除」；用户明确同意后再加 `-y` 执行。
2. 「删除已经拉到本地的录音」优先用 `delete --pulled` 或 `pull --delete-cloud`：它们只删拉取时校验过、云端内容未变的录音。
3. `trash purge` 不可恢复，即使用户已同意删除，也要单独再确认一次。

**绝对禁止**：凭标题相似或时间接近推断是同一条录音就删除；未经用户确认使用 `--all`。

## 用户配置与数据

- 项目配置 `.mi-recording-cli/config.json`（`npx mi-recording-cli config set <key> <value>`）：`output` 默认拉取目录（缺省 `.mi-recording-cli/output/`）、`fileNameTemplate`、`concurrency`（1–8，默认 3）。
- 登录态缓存：`~/Library/Caches/mi-recording-cli/`。

## 限制

- 不支持上传、重命名、编辑录音（网页端也没有）。
- 账号开启「高级数据保护」（端到端加密）时无法下载，会返回明确错误；列表与删除不受影响。
- 只支持 i.mi.com（中国大陆区）账号。

---

> ⚠️ 如果 CLI 实际行为与本文档有明显差异，先用 `npx mi-recording-cli <command> --help` 确认当前行为，或执行 `npx skills update mi-recording-cli` 更新 skill。
