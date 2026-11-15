# 录音：`micloud rec`

`rec` 是 `recording` 的简写。以下命令都要加 `--json`；`micloud` 指 `npx -y micloud-cli`。

## 读

```bash
micloud rec list --json [--type recorder,phonecall,fm,app] [--since 7d] [--until 2026-07-31] [-q 关键词] [--limit n] [--sort time|size|duration] [--asc]
micloud rec search <关键词> --json      # 匹配标题、联系人、号码、来源应用
micloud rec info <id> --json            # 也会查回收站（data.inTrash）
micloud rec stats --json [--by type|month|year]
```

录音字段：`id`、`title`（手机上的文件名）、`type`（recorder 录音机 / phonecall 通话 / fm / app 微信等应用录音）、`recordedAt`（录音开始时间，毫秒）、`duration`（秒）、`size`、`sha1`、`contactName` / `phoneNumber` / `appName`（能解析时）。时间参数支持 `2026-07-01`、`2026-07-01 18:30`、`7d` / `12h` / `2w`、`today`、`yesterday`。

## 下载

```bash
micloud rec pull -o <目录> --json [筛选参数] [--limit n] [--dry-run]   # 增量拉取
micloud rec download <id...> -o <目录> --json                         # 按 id 下载，不记录拉取状态
micloud rec download <id> --stdout > a.mp3                            # 写到管道
micloud rec url <id...> --json                                        # 临时直链（免登录、约 4 小时有效，勿外传）
```

- `--limit n` 是「本次只拉最新的 n 条**待拉取**的」：拉过的不计入，同一命令重复执行会继续往更早的录音走。只想要最新 n 条时只跑一次；`data.matched` 是符合筛选条件的总数，不是本次处理数，本次拉到的看 `data.pulled`。
- `pull` 在拉取目录里记录拉过的录音，之后跳过，即使本地文件已被移走；要重新下载用 `--force` 或 `download <id>`。
- 下载经大小与 SHA-1 校验、断点续传，绝不覆盖内容不同的已有文件（改存为 `<文件名>_<id>`）。同一目录同时只能运行一个 pull / download / delete --pulled。
- `data.pulled[]` 每项含完整录音字段与 `file`（本地绝对路径），可直接交给转写等后续处理。
- 文件名模板：`--template` 或 `rec config set fileNameTemplate`；占位符 `${title}` `${YYYY}`…`${ss}` `${type}` `${typeName}` `${contact}` `${phone}` `${app}` `${duration}` `${id}`，`/` 分子目录，`[...]` 条件段。

## 删除与回收站

```bash
micloud rec delete <id...> -y --json                                  # 移到回收站
micloud rec delete --pulled -o <目录> --dry-run --json                # 预览：已拉取、本地文件完好、云端未变的录音
micloud rec delete --pulled -o <目录> --allow-moved --dry-run --json  # 本地文件已转移走时
micloud rec delete --type app --until 2026-03-31 -y --json            # 按筛选条件
micloud rec pull -o <目录> --delete-cloud -y --json                   # 拉取校验后把云端移到回收站
micloud rec trash --json                                               # 回收站（含 deletedAt、expiresAt）
micloud rec trash restore <id...> --json                               # 恢复，或 --all
micloud rec trash purge <id...> -y --json                              # 永久删除，或 --all，不可恢复
```

- `--dry-run` 的候选清单在 `data.wouldDelete`（`data.deleted` 恒为空，真正执行后才填充）。
- **删除会同步到手机**：云端删除的录音会从已登录该账号的设备上一并删除，删除前必须让用户知情。删除只进回收站，按会员等级保留 30~180 天。
- 「删除已经拉到本地的录音」优先用 `delete --pulled` 或 `pull --delete-cloud`：只删拉取时校验过、云端未变、拉取目录里的文件仍完好的录音，每条删除前还会再核对一次。文件已被转移走的默认不删（`data.skipped` / `data.deleteSkipped` 里 `code: "local-missing"`），只有用户确认文件已妥善保存时才加 `--allow-moved`。
- 被本工具删过又被恢复的录音视为有意保留（`code: "kept"`），不会再被自动删除。
- `pull --delete-cloud` 带 `--limit` 时只清理本次拉取的录音。

## 删除前

先用 `--dry-run`（purge 用 `trash --json`）拿到受影响的清单，向用户展示条数、标题、录音时间与总时长，并提醒「手机上的录音也会被删除」，用户明确同意后再加 `-y`。

## 配置

`.micloud/config.json` 的 `recording` 节（`micloud rec config set <key> <value>`）：`output`（默认拉取目录，缺省 `.micloud/recording/`）、`fileNameTemplate`、`concurrency`（1–8，默认 3）。

## 限制

- 不支持上传、重命名录音（网页端也没有）。
- 账号开启「高级数据保护」（端到端加密）时无法下载，会返回明确错误；列表与删除不受影响。
- 只支持中国大陆区账号（i.mi.com）。
