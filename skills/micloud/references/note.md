# 笔记：`micloud note`

以下命令都要加 `--json`；`micloud` 指 `npx -y micloud-cli`。

## 读

```bash
micloud note list --json [--folder <id>] [--limit <n>]   # 按修改时间倒序
micloud note get <id> --json                              # 转成 Markdown，data.content
micloud note get <id> --raw                               # 原始 XML
micloud note search <关键词> --json [--limit <n>]          # 匹配标题与摘要
micloud note folders --json
```

## 写

```bash
micloud note create --title "标题" --content "# 正文" --json   # 内容也可用 --file 或管道
micloud note update <id> --content "新正文" --json              # 只传要改的字段；不传内容就只改元数据
micloud note delete <id> -y --json                              # 移到回收站；--purge 永久删除
micloud note move <id> <folderId> --json
micloud note pin <id> --json / unpin <id> --json
micloud note folder create "名称" --json [--parent <id>]
micloud note folder rename <id> "新名称" --json
micloud note folder delete <id> -y --json [--purge]
```

内容是 Markdown：标题、列表、复选框、引用、分割线、加粗 / 斜体 / 删除线、链接、行内代码、图片。

图片：`upload-image <路径> --json` 返回 `data.markdown`（`![图片](minote://image/<fileId>)`），放进内容即可；也可以直接写本地路径 `![](./photo.jpg)`，写入时自动上传（相对路径基于 Markdown 文件所在目录）。`get` / `sync` 输出里的图片引用可以原样交给 `update`。图片需独占一行；有无法回写的附件（找不到的图片、音频 / 视频）时命令会报错，不会把附件写成纯文本。

## 导出与同步

```bash
micloud note export -o <目录> --json             # 单向导出为 Markdown，永不修改云端；-f 全量重来
micloud note sync -o <目录> --dry-run --json     # 先预览
micloud note sync -o <目录> --mode two-way --json
micloud note sync status --json                  # 配置与同步状态
```

- `export` 不建状态文件、不删本地文件，适合备份快照；要持续同步用 `sync`。
- 同步模式：`cloud-first` 只下行、`local-first` 只上行、`two-way` 双向自动、`manual`（默认）逐条询问。非交互下真冲突跳过并列在 `data.conflicts`，失败项在 `data.errors`，每次同步后都要检查并报告。
- 同步删除云端笔记只移到回收站。本地新建文件的云端标题取文件名，子目录对应同名云端文件夹。
- 同名笔记落盘时，除一条外其余文件名带 `_<id>` 后缀；按 id 定位笔记以 `get` 为准，不要凭文件名推断。

## 删除前

1. 用 `get <id> --json` 取云端内容，确认是要删的笔记；本地文件名与记录不一致时尤其不能跳过。
2. 向用户展示 id、标题、内容摘要，得到明确同意后再加 `-y`。`--purge` 需要再确认一次。

## 配置

`.micloud/config.json` 的 `note` 节：`output`（默认同步 / 导出目录，`-o` 优先，缺省 `.micloud/note/`）、`syncMode`（默认同步模式）、`fileNameTemplate`（文件名模板，不含 `.md`；占位符 `${YYYY}` `${MM}` `${DD}` `${HH}` `${mm}` `${ss}`（创建时间）、`${title}`（未起标题时为空）、`${subject}`（永远非空）、`${id}`；`[...]` 条件段，段内变量都非空才输出）。

## 限制

- 不支持回收站列表 / 恢复：删除后只能在 i.mi.com 网页端恢复（30 天内）。
- 私密笔记、思维导图等特殊类型只能尽力导出，不支持编辑；没有用户标签。
