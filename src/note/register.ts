import type { Command } from "commander";
import { listCommand } from "./commands/list.js";
import { getCommand } from "./commands/get.js";
import { searchCommand } from "./commands/search.js";
import { createCommand } from "./commands/create.js";
import { updateCommand } from "./commands/update.js";
import { deleteCommand } from "./commands/delete.js";
import { moveCommand } from "./commands/move.js";
import { pinCommand } from "./commands/pin.js";
import {
  foldersCommand,
  folderCreateCommand,
  folderRenameCommand,
  folderDeleteCommand,
} from "./commands/folder.js";
import { uploadImageCommand } from "./commands/upload-image.js";
import { exportCommand } from "./commands/export.js";
import { syncCommand, syncInitCommand, syncStatusCommand } from "./commands/sync.js";

/** 注册 `micloud note` 命令组 */
export function registerNoteCommands(program: Command): void {
  const note = program
    .command("note")
    .description("小米云笔记：读写、文件夹、图片、导出与双向同步")
    .addHelpText(
      "after",
      `
笔记内容格式:
  读取(get)默认把小米笔记转成 Markdown；写入(create/update)接受 Markdown，自动转回小米格式。
  支持的 Markdown: 标题(# ## ###)、有序/无序列表、复选框(- [ ] / - [x])、引用(>)、
  分割线(---)、加粗(**)、斜体(*)、删除线(~~)、图片(![](minote://image/<fileId>))。

典型流程:
  1) micloud note list --json                       # 列出笔记，拿到 <id>
  2) micloud note get <id> --json                   # 读取某条笔记
  3) micloud note create --title T --content "..."  # 创建
  4) micloud note sync -o ./notes --mode two-way    # 与本地目录双向同步

破坏性操作(delete / sync 删除类)在非交互下需 -y 或由 --mode 决定，真冲突一律跳过不擅自删数据。
`,
    );

  // ============ 读 ============
  note
    .command("list")
    .description("列出笔记")
    .option("-f, --folder <id>", "仅列出指定文件夹下的笔记（id 来自 folders 命令）")
    .option("-n, --limit <n>", "限制返回数量")
    .action((opts) => listCommand(opts));

  note
    .command("get <id>")
    .description("获取单条笔记内容（默认转 Markdown）")
    .option("--raw", "输出原始 XML 内容")
    .action((id, opts) => getCommand(id, opts))
    .addHelpText("after", "\n  <id> 来自 list / search 命令的输出。--json 时 data 含 id/title/content/files 等字段。\n");

  note
    .command("search <keyword>")
    .description("按关键词搜索笔记标题与摘要")
    .option("-n, --limit <n>", "限制返回数量（默认 20）")
    .action((keyword, opts) => searchCommand(keyword, opts));

  // ============ 写 ============
  note
    .command("create")
    .description("创建笔记（内容来源：--content / --file / 标准输入）")
    .option("-t, --title <title>", "笔记标题")
    .option("-f, --folder <id>", "目标文件夹 ID（默认 0）")
    .option("-c, --content <md>", "笔记内容（Markdown）")
    .option("--file <path>", "从文件读取内容")
    .option("--color <id>", "笔记颜色 ID")
    .action((opts) => createCommand(opts))
    .addHelpText(
      "after",
      `
示例:
  micloud note create --title "标题" --content "# 正文\\n\\n- 列表项"
  echo "# 来自管道" | micloud note create --title 管道笔记
  micloud note create --file ./note.md --folder 123 --json
  插图：upload-image 后把 ![](minote://image/<fileId>) 放进内容；或直接写本地路径 ![](path.jpg) 自动上传。
  --file 里的相对图片路径基于该文件所在目录；--content / 管道时基于当前目录。
`,
    );

  note
    .command("update <id>")
    .description("更新笔记（不提供内容则仅改元数据）")
    .option("-t, --title <title>", "新标题")
    .option("-f, --folder <id>", "移动到的文件夹 ID")
    .option("-c, --content <md>", "新内容（Markdown）")
    .option("--file <path>", "从文件读取新内容")
    .option("--color <id>", "笔记颜色 ID")
    .action((id, opts) => updateCommand(id, opts));

  note
    .command("delete <id>")
    .description("删除笔记（默认移回收站，--purge 永久删除）")
    .option("--purge", "永久删除（不可恢复）")
    .option("-y, --yes", "跳过确认")
    .action((id, opts) => deleteCommand(id, opts));

  note
    .command("move <id> <folderId>")
    .description("将笔记移动到指定文件夹")
    .action((id, folderId) => moveCommand(id, folderId));

  note
    .command("pin <id>")
    .description("置顶笔记")
    .action((id) => pinCommand(id, true));

  note
    .command("unpin <id>")
    .description("取消置顶笔记")
    .action((id) => pinCommand(id, false));

  // ============ 文件夹 ============
  note
    .command("folders")
    .description("列出所有文件夹")
    .action(() => foldersCommand());

  const folder = note.command("folder").description("文件夹管理（create / rename / delete）");

  folder
    .command("create <name>")
    .description("创建文件夹")
    .option("-p, --parent <id>", "父文件夹 ID（默认 0）")
    .action((name, opts) => folderCreateCommand(name, opts));

  folder
    .command("rename <id> <name>")
    .description("重命名文件夹")
    .action((id, name) => folderRenameCommand(id, name));

  folder
    .command("delete <id>")
    .description("删除文件夹")
    .option("--purge", "永久删除")
    .option("-y, --yes", "跳过确认")
    .action((id, opts) => folderDeleteCommand(id, opts));

  // ============ 图片 ============
  note
    .command("upload-image <path>")
    .description("上传图片，返回可嵌入笔记的 fileId 与 Markdown 引用")
    .option("--mime <type>", "图片 MIME 类型（默认自动推断）")
    .option("--filename <name>", "上传时使用的文件名")
    .action((path, opts) => uploadImageCommand(path, opts));

  // ============ 导出/同步 ============
  note
    .command("export")
    .description("导出全部笔记为本地 Markdown（单向云→本地，永不修改云端）")
    .option("-o, --output <dir>", "输出目录（缺省时取配置的 output；再缺省为 .micloud/note/，旧版默认目录 .mi-note-cli/output/ 存在时沿用它）")
    .option("-f, --force", "强制重新导出（忽略本地已有同名文件）")
    .addHelpText(
      "after",
      `
与 sync --mode cloud-first 的区别：
  export 无状态文件、不删本地文件（云端删了本地保留）、支持 --force 全量重下。
  适合一次性备份/快照；需要持续同步用 sync。
`,
    )
    .action((opts) => exportCommand(opts));

  const sync = note
    .command("sync")
    .description("双向同步本地与云端（3-way 差异 + 模式策略）")
    .option("-o, --output <dir>", "同步目录（缺省时取配置的 output；再缺省为 .micloud/note/，旧版默认目录 .mi-note-cli/output/ 存在时沿用它）")
    .option("-m, --mode <mode>", "同步模式：cloud-first/local-first/two-way/manual")
    .option("--dry-run", "只列出同步计划，不实际执行")
    .option("-y, --yes", "跳过交互询问（非交互按模式处理，真冲突跳过）")
    .action((opts) => syncCommand(opts))
    .addHelpText(
      "after",
      `
同步模式 (--mode，未指定时取 sync init 设的默认值，再缺省为 manual):
  cloud-first  云端优先：仅下行，冲突以云端为准
  local-first   本地优先：仅上行，冲突以本地为准
  two-way       双向自动：单边改自动同步，真冲突才停下询问
  manual        交互（默认）：任何不一致都列出并逐条询问

冲突处理:
  cloud-first/local-first 已声明优先方，冲突按优先方自动解决；
  two-way/manual 遇到「双改」「一端删另一端改」等真冲突会停下：交互式询问，
  非交互(--json/无 TTY)则跳过该条并在结果里报告，绝不擅自删数据。
  交互询问时可按 d 查看云端与本地的差异。同步删除云端笔记只移到回收站。

示例:
  micloud note sync -o ./notes --dry-run        # 预览将发生什么
  micloud note sync -o ./notes --mode two-way    # 双向同步
  micloud note sync init                          # 引导设置默认模式
  micloud note sync status                        # 查看配置与状态
`,
    );

  sync
    .command("init")
    .description("交互式引导设置默认同步模式")
    .action(() => syncInitCommand());

  sync
    .command("status")
    .description("查看配置与当前 output 的同步状态")
    .option("-o, --output <dir>", "查看指定目录的状态（缺省同 sync）")
    // `-o` 写在 status 后面时会先被上层 sync 命令解析走，合并上层选项才能拿到
    .action((_opts, cmd: Command) => syncStatusCommand(cmd.optsWithGlobals()));
}
