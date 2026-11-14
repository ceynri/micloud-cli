/**
 * 统一输出层：支持人类可读输出与 --json 机器可读输出。
 *
 * 设计约定：
 * - 所有结构化结果走 stdout（JSON 模式输出纯 JSON，便于 AI/管道解析）。
 * - 所有日志、进度、提示走 stderr（不污染 stdout 结果）。
 */

let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** 输出一条日志/进度到 stderr */
export function logInfo(message: string): void {
  process.stderr.write(message + "\n");
}

/**
 * 输出成功结果。
 * - JSON 模式：输出 { ok: true, data }
 * - 普通模式：调用 humanRender 渲染
 */
export function success(data: unknown, humanRender: () => void): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + "\n");
  } else {
    humanRender();
  }
}

/** 输出错误并以非零码退出 */
export function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
  } else {
    process.stderr.write(`❌ ${message}\n`);
  }
  process.exit(1);
}

/**
 * 部分条目失败时的退出码：结果仍按 ok:true 输出（data.failed 列出失败项），
 * 但以非零码退出，便于脚本用 `&&` / `$?` 感知。整体失败走 fail()，退出码为 1。
 */
export const EXIT_PARTIAL_FAILURE = 2;

/** 是否可以向用户提问（非 JSON 模式且 stdin 是终端） */
export function canPrompt(): boolean {
  return !jsonMode && !!process.stdin.isTTY;
}

/** 读取一行用户输入（问题走 stderr，不污染 stdout） */
export function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const stdin = process.stdin;
    stdin.setEncoding("utf-8");
    const onData = (data: string): void => {
      stdin.pause();
      stdin.off("data", onData);
      resolve(data.trim());
    };
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** 命令行 y/N 确认提示 */
export async function confirm(question: string): Promise<boolean> {
  return (await prompt(question)).toLowerCase() === "y";
}

/**
 * 破坏性操作的确认：带 -y 直接通过；能交互时 y/N 询问；
 * 非交互（--json / 无终端）且未带 -y 时直接报错，绝不擅自执行。
 */
export async function confirmDestructive(question: string, yes: boolean | undefined): Promise<boolean> {
  if (yes) return true;
  if (!canPrompt()) {
    throw new Error("这是破坏性操作，非交互模式（--json / 无终端）下需加 -y 明确确认");
  }
  return await confirm(`${question} (y/N) `);
}
