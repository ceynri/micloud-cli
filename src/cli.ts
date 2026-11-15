#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { setJsonMode } from "./output.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.js";
import { listCommand, searchCommand, infoCommand, statsCommand } from "./commands/list.js";
import { pullCommand, downloadCommand, urlCommand, playCommand } from "./commands/transfer.js";
import { deleteCommand } from "./commands/delete.js";
import { trashListCommand, trashRestoreCommand, trashPurgeCommand } from "./commands/trash.js";
import { configShowCommand, configSetCommand, configUnsetCommand } from "./commands/config.js";

const require = createRequire(import.meta.url);
const { version, description } = require("../package.json") as {
  version: string;
  description: string;
};

// 下游管道提前关闭（如 `| head`）时安静退出，而不是抛出 EPIPE 堆栈
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw err;
});

// Ctrl+C / kill 时走正常退出流程，让拉取目录锁等 exit 清理逻辑得以执行；
// 已下载的部分保留在 .part 中，下次运行断点续传
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    process.stderr.write("\n已中断（下次运行会从断点继续）\n");
    process.exit(130);
  });
}

const program = new Command();

program
  .name("mi-recording-cli")
  .description(description)
  .version(version, "-v, --version", "显示版本号")
  .option("--json", "以 JSON 格式输出（便于 AI / 脚本解析）")
  .hook("preAction", (thisCommand) => {
    if (thisCommand.opts().json) setJsonMode(true);
  });

program.addHelpText(
  "after",
  `
输出约定:
  全局 --json 下，所有命令统一输出 JSON：成功 {"ok":true,"data":...}，失败 {"ok":false,"error":"..."}。
  日志/进度走 stderr，结构化结果走 stdout，可安全用管道解析。
  批量操作部分失败时仍输出 ok:true（失败项在 data.failed），退出码为 2；整体失败退出码为 1。

录音类型（--type，逗号分隔）:
  recorder 录音机 / phonecall 通话录音 / fm FM 录音 / app 应用录音（微信、企业微信等）

时间参数（--since / --until）:
  2026-07-01、2026-07-01 18:30、20260701、7d / 12h / 2w（距今）、today、yesterday。
  --until 只写日期时包含当天。时间均指「录音时间」，本地时区。

典型流程:
  1) mi-recording-cli login                        # 首次登录（浏览器）
  2) mi-recording-cli list --json                  # 列出录音，拿到 <id>
  3) mi-recording-cli pull -o ./recordings         # 增量拉取到本地（已拉取过的自动跳过）
  4) mi-recording-cli delete --pulled -o ./recordings  # 清理已拉取的云端录音（移到回收站）

非交互/AI 调用:
  无 TTY 或带 --json 时不会弹浏览器；登录态失效且无法静默续期时直接报错，需先人工 login。
  删除类操作在非交互模式下必须带 -y，否则直接报错，绝不擅自删除。
`,
);

// ============ 认证 ============
program.command("login").description("登录小米账号（打开浏览器完成登录）").action(() => loginCommand());
program.command("logout").description("清除本工具的登录态").action(() => logoutCommand());
program
  .command("whoami")
  .description("查看登录状态、账号与云空间用量")
  .action(() => whoamiCommand());

// ============ 读 ============
const filterHelp = `
筛选（可组合）:
  -t, --type recorder,phonecall   按类型
  --since 2026-07-01 / 7d         录音时间下限
  --until 2026-07-31              录音时间上限（只写日期时包含当天）
  -q, --query "关键词"            匹配标题、联系人、号码、来源应用（空格分隔、全部命中）
`;

program
  .command("list")
  .alias("ls")
  .description("列出云端录音（默认按录音时间倒序）")
  .option("-t, --type <types>", "按类型筛选：recorder / phonecall / fm / app，逗号分隔")
  .option("--since <time>", "录音时间不早于")
  .option("--until <time>", "录音时间不晚于")
  .option("-q, --query <keywords>", "关键词筛选")
  .option("-n, --limit <n>", "最多返回条数")
  .option("-s, --sort <key>", "排序字段：time（默认）/ size / duration")
  .option("--asc", "升序")
  .addHelpText(
    "after",
    `${filterHelp}
  --json 时每项含 id / title / type / recordedAt（毫秒）/ duration（秒）/ size（字节）/ sha1 / extension 等字段。
`,
  )
  .action((opts) => listCommand(opts));

program
  .command("search <keywords...>")
  .description("按关键词搜索录音（标题、联系人、号码、来源应用）")
  .option("-t, --type <types>", "按类型筛选")
  .option("--since <time>", "录音时间不早于")
  .option("--until <time>", "录音时间不晚于")
  .option("-n, --limit <n>", "最多返回条数")
  .action((keywords: string[], opts) => searchCommand(keywords, opts));

program
  .command("info <id>")
  .description("查看单条录音的详细信息（也会查找回收站）")
  .action((id: string) => infoCommand(id));

program
  .command("stats")
  .description("统计录音条数、时长与占用空间")
  .option("--by <key>", "分组：type（默认）/ month / year")
  .option("-t, --type <types>", "按类型筛选")
  .option("--since <time>", "录音时间不早于")
  .option("--until <time>", "录音时间不晚于")
  .option("-q, --query <keywords>", "关键词筛选")
  .action((opts) => statsCommand(opts));

// ============ 下载 ============
program
  .command("pull")
  .description("增量拉取云端录音到本地目录（已拉取过的自动跳过，支持断点续传与校验）")
  .option("-o, --output <dir>", "拉取目录（缺省取配置 output；再缺省为 .mi-recording-cli/output/）")
  .option("-t, --type <types>", "只拉取指定类型")
  .option("--since <time>", "录音时间不早于")
  .option("--until <time>", "录音时间不晚于")
  .option("-q, --query <keywords>", "关键词筛选")
  .option("-n, --limit <n>", "只拉取最新的 n 条待拉取录音")
  .option("--template <tpl>", "文件名模板（覆盖配置），见下方说明")
  .option("-c, --concurrency <n>", "并发下载数（1-8，默认 3）")
  .option("-f, --force", "忽略拉取记录，重新拉取所有匹配的录音")
  .option("--dry-run", "只预览将拉取的录音，不下载")
  .option("--delete-cloud", "拉取并校验成功后，把云端录音移到回收站（未加 --limit 时也包括之前已拉取、本地文件仍完好的）")
  .option("--allow-moved", "配合 --delete-cloud：之前已拉取的录音即使本地文件已转移走也删除云端")
  .option("-y, --yes", "跳过 --delete-cloud 的确认")
  .addHelpText(
    "after",
    `${filterHelp}
增量规则:
  拉取目录里的 .mi-recording-cli.state.json 记录已拉取的录音，之后的 pull 一律跳过——即使你已把本地文件
  移走或删除（例如流转到转写项目）。要重新下载用 --force，或用 download <id>。
  每个文件先写 .part，大小与 SHA-1 都校验通过才放到正式位置；中断后重跑会断点续传。
  目标位置已有内容不同的同名文件时，改用 <文件名>_<id> 落盘，绝不覆盖。
  同一拉取目录同时只能运行一个 pull / delete --pulled。

清理云端（--delete-cloud，只移到回收站）:
  本次拉取并校验成功的录音，以及之前已拉取、拉取目录里的文件仍完好的录音，会被移到回收站；
  带 --limit 时只清理本次拉取的录音。每条删除前都会再核对一次本地文件。
  之前已拉取但文件已被你转移走的录音默认不删（以免云端和本地都没有）；确认已妥善保存时加 --allow-moved。
  云端内容变化、缺少 SHA-1、或曾被本工具删除后又恢复的录音一律不删，列在 data.deleteSkipped。

文件名模板（--template 或 config set fileNameTemplate，不含扩展名，可用 / 分子目录）:
  \${title}      手机上的录音文件名（默认模板）     \${id}        录音 id
  \${YYYY} \${YY} \${MM} \${DD} \${HH} \${mm} \${ss}  录音开始时间（本地时区）
  \${type}       recorder / phonecall / fm / app    \${typeName}  录音机录音 / 通话录音 / ...
  \${contact}    通话或应用录音的对方（名称或号码）   \${phone}     通话号码
  \${app}        来源应用（微信 / 企业微信）          \${duration}  时长（秒）
  [...]          条件段：段内变量都非空才输出，如 \${YYYY}-\${MM}-\${DD}_\${HH}\${mm}[_\${contact}]

示例:
  mi-recording-cli pull -o ./recordings
  mi-recording-cli pull --since 7d --type recorder --dry-run
  mi-recording-cli pull --template '\${typeName}/\${YYYY}-\${MM}/\${title}'
  mi-recording-cli pull --delete-cloud -y --json      # 拉取后清空云端（移到回收站）
`,
  )
  .action((opts) => pullCommand(opts));

program
  .command("download <ids...>")
  .alias("dl")
  .description("按 id 下载指定录音（默认存到当前目录，不记录拉取状态）")
  .option("-o, --output <dir>", "保存目录（默认当前目录）")
  .option("--template <tpl>", "文件名模板（覆盖配置）")
  .option("-c, --concurrency <n>", "并发下载数（1-8，默认 3）")
  .option("--stdout", "把单条录音的音频写到标准输出（用于管道）")
  .addHelpText(
    "after",
    `
示例:
  mi-recording-cli download 10000000000000001 10000000000000002 -o ./tmp
  mi-recording-cli download 10000000000000001 --stdout | ffmpeg -i - -ar 16000 -ac 1 out.wav
`,
  )
  .action((ids: string[], opts) => downloadCommand(ids, opts));

program
  .command("url <ids...>")
  .description("获取录音的临时直链（无需登录即可访问，有效期约数小时）")
  .action((ids: string[]) => urlCommand(ids));

program
  .command("play <id>")
  .description("用系统默认播放器 / 浏览器在线播放录音")
  .action((id: string) => playCommand(id));

// ============ 删除与回收站 ============
program
  .command("delete [ids...]")
  .alias("rm")
  .description("把云端录音移到回收站（可用 trash restore 恢复）")
  .option("--pulled", "删除已拉取到本地、且本地文件完好、云端内容未变的录音（读取拉取目录的状态）")
  .option("--allow-moved", "配合 --pulled：本地文件已转移走的录音也删除（以拉取记录为准）")
  .option("-o, --output <dir>", "配合 --pulled：拉取目录（缺省同 pull）")
  .option("-t, --type <types>", "按类型筛选")
  .option("--since <time>", "录音时间不早于")
  .option("--until <time>", "录音时间不晚于")
  .option("-q, --query <keywords>", "关键词筛选")
  .option("--all", "删除全部云端录音")
  .option("--dry-run", "只预览将删除的录音")
  .option("-y, --yes", "跳过确认（非交互模式下必须）")
  .addHelpText(
    "after",
    `
指定目标（三选一）: id 列表 / --pulled（可叠加筛选） / 筛选条件或 --all。
小米云会同步删除已登录该账号的设备（如手机）上的录音。删除后进入回收站，按会员等级保留 30~180 天。

--pulled 只删「拉取时校验过、云端大小与 SHA-1 未变、且拉取目录里的文件仍完好」的录音；
已把文件转移到别处（如转写项目）时加 --allow-moved，改以拉取记录为准。
曾被本工具删除后又从回收站恢复的录音视为有意保留，--pulled 不再删除（可按 id 删除）。

示例:
  mi-recording-cli delete 10000000000000001
  mi-recording-cli delete --pulled -o ./recordings --dry-run
  mi-recording-cli delete --pulled -o ./recordings --allow-moved -y
  mi-recording-cli delete --type app --until 2026-03-31 -y
`,
  )
  .action((ids: string[], opts) => deleteCommand(ids, opts));

const trash = program.command("trash").description("回收站（最近删除）：list / restore / purge");

trash
  .command("list", { isDefault: true })
  .alias("ls")
  .description("列出回收站里的录音")
  .action(() => trashListCommand());

trash
  .command("restore [ids...]")
  .description("从回收站恢复录音")
  .option("--all", "恢复回收站里的全部录音")
  .action((ids: string[], opts) => trashRestoreCommand(ids, opts));

trash
  .command("purge [ids...]")
  .description("从回收站永久删除录音（不可恢复）")
  .option("--all", "清空回收站")
  .option("-y, --yes", "跳过确认（非交互模式下必须）")
  .action((ids: string[], opts) => trashPurgeCommand(ids, opts));

// ============ 配置 ============
const config = program
  .command("config")
  .description("查看 / 修改项目配置（.mi-recording-cli/config.json）");

config
  .command("show", { isDefault: true })
  .description("查看生效配置与拉取状态")
  .option("-o, --output <dir>", "查看指定拉取目录的状态（缺省同 pull）")
  .action((opts) => configShowCommand(opts));

config
  .command("set <key> <value>")
  .description("设置配置项：output / fileNameTemplate / concurrency")
  .action((key: string, value: string) => configSetCommand(key, value));

config
  .command("unset <key>")
  .description("移除配置项，恢复默认值")
  .action((key: string) => configUnsetCommand(key));

program.parseAsync(process.argv);
