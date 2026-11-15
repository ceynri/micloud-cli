#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { setJsonMode } from "./core/output.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/account.js";
import { registerNoteCommands } from "./note/register.js";
import { registerRecordingCommands } from "./recording/register.js";

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

// Ctrl+C / kill 时走正常退出流程，让目录锁等 exit 清理逻辑得以执行
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    process.stderr.write("\n已中断\n");
    process.exit(130);
  });
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("micloud")
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
  批量操作部分失败时仍输出 ok:true（失败项列在 data 里），退出码为 2；整体失败退出码为 1。

典型流程:
  1) micloud login                            # 首次登录（浏览器），笔记与录音通用
  2) micloud note list --json                 # 笔记
  3) micloud rec pull -o ./recordings         # 录音：增量拉取到本地

非交互/AI 调用:
  无 TTY 或带 --json 时不会弹浏览器；登录态失效且无法静默续期时直接报错，需先人工 login。
  删除类操作在非交互模式下必须带 -y，否则直接报错，绝不擅自删除。
`,
  );

  program.command("login").description("登录小米账号（打开浏览器完成登录）").action(() => loginCommand());
  program.command("logout").description("清除登录态").action(() => logoutCommand());
  program
    .command("whoami")
    .description("查看登录状态、账号与云空间用量")
    .action(() => whoamiCommand());

  registerNoteCommands(program);
  registerRecordingCommands(program);
  return program;
}

buildProgram().parseAsync(process.argv);
