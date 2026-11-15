import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveAuth, refreshAuth } from "../../core/auth.js";
import { readStdin } from "../../core/output.js";
import { MiNoteClient } from "../client.js";

/** 已登录的笔记客户端；请求遇 401 时自动静默续期并重试 */
export async function getClient(): Promise<MiNoteClient> {
  return new MiNoteClient(await resolveAuth(), refreshAuth);
}

/**
 * 解析笔记内容来源：优先级 --content > --file > stdin。
 * 返回内容字符串；若都没有则返回 null。
 */
export async function resolveContent(opts: {
  content?: string;
  file?: string;
}): Promise<string | null> {
  if (opts.content !== undefined) return opts.content;
  if (opts.file) {
    return await readFile(opts.file, "utf-8");
  }
  return await readStdin();
}

/** 内容里本地图片相对路径的基准目录：--file 时为文件所在目录，否则为当前目录 */
export function contentBaseDir(opts: { file?: string; content?: string }): string {
  return opts.content === undefined && opts.file
    ? dirname(resolve(opts.file))
    : process.cwd();
}

/** 解析 --limit：必须是正整数；未提供时返回 fallback */
export function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--limit 必须是正整数，收到：${raw}`);
  }
  return n;
}
