[English](./README.en.md) | 简体中文

# micloud

小米云服务（i.mi.com）的命令行工具，为 AI / 脚本调用设计。一次登录，同时管理：

- **笔记**：读写，转成 Markdown；导出，或与本地目录双向同步
- **录音**：把手机同步上云的录音增量拉到本地，再清理云端

```bash
npm install -g micloud-cli
micloud login                               # 打开浏览器登录小米账号，之后自动续期
micloud note sync -o ./notes --mode two-way # 笔记与本地目录双向同步
micloud rec pull -o ./recordings            # 录音增量拉取到本地
```

> 需要 Node.js >= 18 和 Chrome（登录时打开浏览器用）。没有 Chrome 时运行 `npx playwright install chromium`。

给 AI Agent 用：

```bash
npx -y skills add ceynri/micloud-cli --all
```

> ⚠️ 实验阶段：minor 版本（`0.Y.z`）可能含破坏性变更，要稳定请锁定 minor 版本（如 `~0.5.0`）。

## 给 AI / 脚本调用

- **加 `--json`**：成功输出 `{"ok":true,"data":...}`，失败输出 `{"ok":false,"error":"..."}`；日志和进度走 stderr，不影响解析。
- **退出码**：`0` 成功；`2` 部分失败（仍是 `ok:true`，失败项列在 `data` 里）；`1` 失败。
- **不会卡住**：非交互环境（`--json` 或没有终端）不弹浏览器。登录失效时直接报错，需要用户在终端运行一次 `micloud login`。
- **删除要显式确认**：删除类操作在非交互环境下必须带 `-y`，否则直接报错。先用 `--dry-run` 预览。

## 笔记 `micloud note`

| 命令 | 说明 |
|---|---|
| `list` / `get <id>` / `search <关键词>` | 列出、查看（转 Markdown，`--raw` 看原始格式）、搜索 |
| `create` / `update <id>` | 用 Markdown 写入，内容来自 `--content`、`--file` 或管道 |
| `delete <id>` / `move <id> <文件夹>` / `pin` / `unpin` | 删除（默认进回收站）、移动、置顶 |
| `folders` / `folder create\|rename\|delete` | 文件夹管理 |
| `upload-image <路径>` | 上传图片，得到可放进笔记的引用 |
| `export -o <目录>` | 单向导出为 Markdown，永不修改云端 |
| `sync -o <目录> --mode <模式>` | 双向同步，`--dry-run` 预览 |

同步模式：`cloud-first` 只下行、`local-first` 只上行、`two-way` 双向自动、`manual`（默认）逐条询问。真冲突（两边都改、一边删一边改）在非交互环境下跳过并报告，不会擅自删数据。云端删除只进回收站。

Markdown 支持标题、列表、复选框、引用、分割线、加粗 / 斜体 / 删除线、链接、行内代码和图片。表格、代码块语言标识等不在支持范围内，重要笔记先小范围试一下。

## 录音 `micloud rec`

`rec` 是 `recording` 的简写。

| 命令 | 说明 |
|---|---|
| `list` / `search` / `info <id>` / `stats` | 列出、搜索、详情、统计 |
| `pull -o <目录>` | 增量拉取：拉过的自动跳过，即使你已把文件移走 |
| `download <id...>` | 按 id 下载；`--stdout` 写到管道 |
| `url <id>` / `play <id>` | 临时直链（免登录、约 4 小时有效）、在线播放 |
| `delete` | 移到回收站：按 id、筛选条件，或 `--pulled`（已拉到本地且校验一致的） |
| `trash` / `trash restore` / `trash purge` | 回收站：列出、恢复、永久删除 |

筛选参数（list / stats / pull / delete 通用）：`--type recorder,phonecall,fm,app`、`--since 7d`、`--until 2026-07-31`、`-q 关键词`。

拉到本地、交给转写，再清理云端：

```bash
micloud rec pull -o ./recordings --json | jq -r '.data.pulled[].file'      # 新拉到的文件路径
micloud rec delete --pulled -o ./recordings --dry-run                       # 预览要清理的
micloud rec delete --pulled -o ./recordings -y                              # 移到回收站
```

- **下载安全**：每个文件先写 `.part`，大小和 SHA-1 都与云端一致才落盘；中断后重跑会断点续传；不会覆盖已有的同名文件。
- **清理安全**：`--pulled` 只删云端内容没变、且拉取目录里的文件仍完好的录音。文件已转移到别处时加 `--allow-moved`。
- **会同步到手机**：小米云会把删除同步到已登录的设备，手机上的录音也会被删除。回收站按会员等级保留 30~180 天。

文件名默认沿用手机上的录音名，可用 `--template` 自定义，如 `'${YYYY}-${MM}-${DD}_${HH}${mm}[_${contact}]'`，占位符见 `micloud rec pull --help`。

## 配置

项目配置放在当前目录的 `.micloud/config.json`，笔记和录音各一节，都可省略：

```json
{
  "note": { "output": "notes", "syncMode": "two-way", "fileNameTemplate": "${YYYY}-${MM}-${DD}[_${title}]" },
  "recording": { "output": "recordings", "fileNameTemplate": "${title}", "concurrency": 3 }
}
```

- 命令行的 `-o` 优先于配置里的 `output`。都没有时用 `.micloud/note/`、`.micloud/recording/`。
- 同步 / 拉取状态记在输出目录里（`.micloud-note.state.json`、`.micloud-recording.json`），目录整体搬走也能继续用。
- 登录状态在系统缓存目录（macOS 是 `~/Library/Caches/micloud/`），删掉后重新 `login` 即可。
- 默认输出目录 `.micloud/note/`、`.micloud/recording/` 里是你的笔记和录音，在 git 仓库里使用时把它们加进 `.gitignore`；`config.json` 可以提交。

## 限制

- 只支持中国大陆区账号（i.mi.com）。
- 开启「高级数据保护」（端到端加密）后无法下载录音，会给出明确提示；列表、删除不受影响。
- 笔记的私密笔记、思维导图等特殊类型只能尽力导出，不支持编辑。
- 录音不能上传、改名（网页端也没有这些能力）。

## 从 mi-note-cli 升级

命令前加 `note` 即可，如 `mi-note-cli sync` 改为 `micloud note sync`。登录状态、配置和同步目录都会自动沿用，不需要重新登录或重新同步。详见 [MIGRATION.md](./MIGRATION.md)。

## 开发

```bash
pnpm install
pnpm typecheck && pnpm test        # 类型检查与单元测试（无需网络）
MICLOUD_INTEGRATION=1 pnpm test:integration   # 真实账号的集成测试（需先登录）
```

接口说明：[docs/recording-api.md](./docs/recording-api.md)。问题与建议欢迎提 [issue](https://github.com/ceynri/micloud-cli/issues)。

## License

[AGPL-3.0](./LICENSE)
