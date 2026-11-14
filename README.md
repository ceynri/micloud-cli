[English](./README.en.md) | 简体中文

# mi-recording-cli

小米云服务录音（i.mi.com/record）的命令行工具——列出、搜索、统计、在线播放、下载、**增量拉取**到本地、删除，以及回收站的恢复与永久删除。覆盖网页端录音页的全部能力，**专为 AI / 脚本调用设计**（统一 `--json` 输出、非交互模式快速失败）。

典型用法：把手机同步到云端的录音定期拉到本地，交给转写等流程处理，再清理云端释放空间。

> ⚠️ **实验阶段**：minor 版本（`x.Y.z`）的更新可能包含破坏性变更，追求稳定请锁定 minor 版本（如 `~0.1.0`）。

## 功能

- **认证**：浏览器交互式登录，登录态缓存并自动静默续期；本机已登录过 [mi-note-cli](https://github.com/ceynri/mi-note-cli) 时首次使用自动只读导入，无需再登录
- **查看**：列表（按类型 / 时间 / 关键词筛选、排序）、搜索、单条详情、按类型 / 月 / 年统计
- **下载**：增量拉取 `pull`（断点续传、SHA-1 校验、并发、自定义文件名模板）、按 id 下载 `download`（可输出到管道）、临时直链 `url`、在线播放 `play`
- **清理**：删除到回收站（按 id、按筛选条件、或「已拉取且校验一致」的录音）、`pull --delete-cloud` 拉完即清
- **回收站**：列出、恢复、永久删除
- **AI 友好**：全局 `--json` 结构化输出；非交互环境不弹浏览器、破坏性操作必须显式 `-y`

## 安装

```bash
npm install -g mi-recording-cli
```

> 环境要求：Node.js >= 18。Playwright 仅用于登录 / 续期时打开浏览器，优先使用系统已安装的 Chrome；都没有时运行 `npx playwright install chromium`。

作为 AI Skill 安装（让 Agent 了解本工具的用法）：

```bash
npx -y skills add ceynri/mi-recording-cli --all
```

## 快速开始

```bash
mi-recording-cli login                          # 1. 登录（打开浏览器）
mi-recording-cli list --limit 20                # 2. 最近的 20 条录音
mi-recording-cli pull -o ./recordings           # 3. 增量拉取到本地
mi-recording-cli delete --pulled -o ./recordings  # 4. 清理已拉取的云端录音（移到回收站）
```

## 命令一览

| 命令 | 说明 |
|---|---|
| `login` / `logout` / `whoami` | 登录 / 清除登录态 / 查看账号与云空间用量 |
| `list`（`ls`） | 列出录音，支持筛选、`--sort time\|size\|duration`、`--asc`、`--limit` |
| `search <关键词...>` | 搜索标题、联系人、号码、来源应用 |
| `info <id>` | 单条录音详情（也会查找回收站） |
| `stats [--by type\|month\|year]` | 条数、时长、占用空间统计 |
| `pull` | 增量拉取到本地目录 |
| `download <id...>`（`dl`） | 按 id 下载到当前目录或 `-o`；`--stdout` 输出到管道 |
| `url <id...>` | 获取临时直链（无需登录即可访问，有效期约数小时） |
| `play <id>` | 用系统默认播放器 / 浏览器播放 |
| `delete [id...]`（`rm`） | 移到回收站：按 id、`--pulled`（可加 `--allow-moved`）、筛选条件或 `--all` |
| `trash [list]` / `trash restore` / `trash purge` | 回收站：列出 / 恢复 / 永久删除 |
| `config [show]` / `config set` / `config unset` | 项目配置 |

筛选参数（`list` / `search` / `stats` / `pull` / `delete` 通用）：

| 参数 | 说明 |
|---|---|
| `-t, --type` | `recorder` 录音机 / `phonecall` 通话录音 / `fm` FM 录音 / `app` 应用录音（微信、企业微信等），逗号分隔 |
| `--since` / `--until` | 录音时间范围：`2026-07-01`、`2026-07-01 18:30`、`7d` / `12h` / `2w`（距今）、`today`、`yesterday`；`--until` 只写日期时包含当天 |
| `-q, --query` | 关键词，空格分隔、全部命中才算匹配 |

## 增量拉取 `pull`

```bash
mi-recording-cli pull -o ./recordings                    # 拉取所有未拉取过的录音
mi-recording-cli pull --since 7d --type recorder --dry-run  # 预览最近 7 天的录音机录音
mi-recording-cli pull --delete-cloud -y                  # 拉取并校验后清理云端
```

- **增量**：拉取目录里的 `.mi-recording-cli.state.json` 记录已拉取的录音，之后的 `pull` 一律跳过——**即使你已把本地文件移走或删除**（例如流转到转写项目）。要重新下载用 `--force`，或 `download <id>`。
- **完整性**：每个文件先写 `.part`，大小与 SHA-1 都和云端一致才放到正式位置；中断后重跑会**断点续传**。直链过期、网络抖动会自动重试。
- **不覆盖**：目标位置已有内容相同的文件直接认领；内容不同的同名文件不会被覆盖，新文件改用 `<文件名>_<id>` 落盘。
- **独占**：同一拉取目录同时只能运行一个 `pull` / `delete --pulled`，避免互相覆盖状态。
- **文件时间**：下载的文件修改时间设为手机上的录音时间，方便按时间排序。
- `--limit n` 只拉最新的 n 条；`-c, --concurrency` 设并发（1–8，默认 3）。

### 拉取后清理云端

两种方式，都只把录音**移到回收站**，不会永久删除：

- `pull --delete-cloud`：本次新拉取并校验成功的录音、以及之前已拉取且仍可校验的录音，移到回收站。
- `delete --pulled`：单独执行清理，可叠加筛选条件。

「仍可校验」指：云端大小与 SHA-1 与拉取时一致，**且拉取目录里的文件仍在、内容未变**。如果你已经把文件转移到别处（例如交给转写项目后移走），默认不会删云端——以免云端和本地都没有这条录音；确认文件已妥善保存时加 `--allow-moved`，改以拉取记录为准：

```bash
mi-recording-cli pull -o ./recordings                                  # 1. 拉取
# 2. 把文件转移 / 转写……
mi-recording-cli delete --pulled -o ./recordings --allow-moved --dry-run  # 3. 预览
mi-recording-cli delete --pulled -o ./recordings --allow-moved -y         # 4. 清理云端
```

被本工具删除后又被你从回收站恢复的录音，视为有意保留，之后的 `--delete-cloud` / `--pulled` 不会再自动删除它（仍可按 id 显式删除）。没删的录音及原因会列出（`--json` 时在 `data.deleteSkipped` / `data.skipped`）。

> ⚠️ 小米云的删除会**同步到已登录该账号的设备**：云端删除后，手机上的这条录音也会被删除（网页端同样如此提示）。回收站保留期按会员等级为 30 / 60 / 90 / 180 天，过期自动清除。

### 文件名模板

默认文件名沿用手机上的录音名（如 `2026年07月02日 16点04分.mp3`、`微信录音 小王_20260711131118.aac`）。可通过 `--template` 或配置 `fileNameTemplate` 自定义（不含扩展名，`/` 表示子目录）：

| 占位符 | 含义 |
|---|---|
| `${title}` | 手机上的录音文件名（默认模板） |
| `${YYYY}` `${YY}` `${MM}` `${DD}` `${HH}` `${mm}` `${ss}` | 录音开始时间（本地时区） |
| `${type}` / `${typeName}` | `recorder` 等 / `录音机录音` 等 |
| `${contact}` | 通话或应用录音的对方（名称或号码） |
| `${phone}` | 通话号码 |
| `${app}` | 来源应用（微信 / 企业微信） |
| `${duration}` | 时长（秒） |
| `${id}` | 录音 id |

条件段 `[...]`：段内变量都非空才输出，否则整段（连同分隔符）消失。例如：

```bash
mi-recording-cli config set fileNameTemplate '${typeName}/${YYYY}-${MM}/${YYYY}${MM}${DD}_${HH}${mm}[_${contact}]'
# → 录音机录音/2026-07/20260702_1604.mp3
# → 应用录音/2026-07/20260711_1311_小王.aac
```

## 交给其他程序处理

`--json` 输出包含每条录音的完整信息与本地路径，可直接驱动后续流程：

```bash
# 拉取新录音，逐个交给转写脚本
mi-recording-cli pull --json | jq -r '.data.pulled[].file' | while read -r f; do
  ./transcribe.sh "$f"
done

# 不落盘，直接转成 16kHz 单声道 wav（先完整下载并校验，再输出）
mi-recording-cli download <id> --stdout | ffmpeg -i - -ar 16000 -ac 1 out.wav
```

`pull --json` 的 `data.pulled[]` 每项含 `id`、`title`、`type`、`recordedAt`（毫秒）、`duration`（秒）、`size`、`sha1`、`contactName`、`appName`、`file`（绝对路径）、`relativePath` 等字段。

## 配置与数据目录

- **项目配置**：`<当前目录>/.mi-recording-cli/config.json`，可用 `config set` 写入：
  - `output`：默认拉取目录（相对配置所在项目根），缺省为 `.mi-recording-cli/output/`
  - `fileNameTemplate`：文件名模板，缺省 `${title}`
  - `concurrency`：并发下载数，缺省 3
- **拉取状态**：`<拉取目录>/.mi-recording-cli.state.json`，跟着拉取目录走；删除后已拉取的录音会按同名文件重新认领（内容一致时不重新下载）。
- **登录态**（macOS）：`~/Library/Caches/mi-recording-cli/`（`cookie` + `browser-data/`），清掉后重新 `login` 即可。

> `.mi-recording-cli/` 里可能有你的录音，若在 git 仓库中使用，记得把它加入 `.gitignore`。

## 已知限制

- **上传 / 重命名 / 编辑**：网页端没有这些能力，录音只能由手机同步上传。
- **高级数据保护（端到端加密）**：开启后录音内容需在已登录的设备上解密，本工具暂不支持下载（会给出明确提示）；列表、删除、回收站不受影响。
- **海外区域账号**：目前只支持 i.mi.com（中国大陆区）。
- **时长**：取自手机写入的元数据；极少数没有时长信息的录音按码率估算（`durationEstimated: true`）。

## AI 调用建议

1. 始终加 `--json`，输出可直接解析。
2. 非交互环境未登录会立即返回错误而非弹浏览器，需先人工 `login` 一次；之后登录态会自动续期。
3. 删除类操作必须显式 `-y`；先用 `--dry-run` 预览。
4. 批量操作部分失败时仍输出 `ok: true`，失败项在 `data.failed`（`pull` 另有 `data.deleteFailed`、`data.warnings`），退出码为 2；整体失败才是 `ok: false`、退出码 1。

## 开发

```bash
pnpm install
pnpm build              # 编译
pnpm typecheck          # 类型检查（含测试）
pnpm test               # 单元测试（无需网络）
pnpm test:integration   # 真实 API 集成测试（需登录；只读）
MI_RECORDING_CLI_TEST_ID=<录音id> pnpm test:integration  # 额外跑一次可逆的「删除→恢复」往返
```

接口来自 i.mi.com 录音网页端（`/sfs/ns/recorder/*`），说明见 [docs/api.md](./docs/api.md)。

## License

MIT
