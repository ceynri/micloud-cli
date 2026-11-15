# 从 mi-note-cli 升级到 micloud

mi-note-cli 已并入 micloud：同一套命令放在 `micloud note` 下，另外多了录音（`micloud rec`）。笔记功能不变，只有一处行为变化：`--json` 或无终端时删除笔记 / 文件夹必须带 `-y`，否则直接报错（以前会不经确认直接删除）。脚本里的删除调用记得加 `-y`。

## 安装

```bash
npm install -g micloud-cli
npm uninstall -g mi-note-cli   # 可选，旧工具不会再更新
```

## 命令对照

所有笔记命令前加 `note`，选项不变：

| mi-note-cli | micloud |
|---|---|
| `mi-note-cli login` / `logout` / `whoami` | `micloud login` / `logout` / `whoami`（不加 `note`，笔记和录音共用） |
| `mi-note-cli list` | `micloud note list` |
| `mi-note-cli sync -o ./notes --mode two-way` | `micloud note sync -o ./notes --mode two-way` |
| `mi-note-cli export` / `get` / `create` / … | `micloud note export` / `get` / `create` / … |

AI Skill 换成新的：`npx skills remove mi-note-cli`，再 `npx -y skills add ceynri/micloud-cli --all`。

## 自动沿用，无需操作

- **登录**：第一次运行时沿用 mi-note-cli 的登录状态（只读复制，不改动旧文件），不用重新登录。
- **配置**：`.micloud/config.json` 里还没有笔记配置时，继续读旧的 `.mi-note-cli/config.json`。下次修改配置（如 `sync init`）时写到新位置，旧文件可以删掉。
- **同步目录**：继续读目录里的 `.mi-note-cli.state.json`，下次同步时改存为 `.micloud-note.state.json`，不需要重新建立同步基线。没配 `output` 时，已存在的默认目录 `.mi-note-cli/output/` 继续使用。

升级后的第一次同步会把状态文件换成新名字，之后旧版 mi-note-cli 就读不到这个目录的同步记录了，请不要再混用。

## 环境变量

| mi-note-cli | micloud |
|---|---|
| `MI_NOTE_CLI_CONFIG_DIR` | `MICLOUD_CONFIG_DIR` |
| `MI_NOTE_CLI_INTEGRATION` | `MICLOUD_INTEGRATION` |
