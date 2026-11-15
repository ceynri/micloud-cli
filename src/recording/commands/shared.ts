import { resolveAuth, refreshAuth } from "../../core/auth.js";
import { isJsonMode } from "../../core/output.js";
import { MiRecordingClient } from "../client.js";
import { DEFAULT_CONCURRENCY, loadRecordingConfig, parseConcurrency } from "../config.js";
import { parseTimeInput } from "../dates.js";
import { parseTypes, type RecordingFilter } from "../recording.js";
import { DEFAULT_FILE_NAME_TEMPLATE } from "../template.js";

/** 已登录的录音客户端；请求遇 401 时自动静默续期并重试 */
export async function getClient(): Promise<MiRecordingClient> {
  return new MiRecordingClient(await resolveAuth(), refreshAuth);
}

export interface FilterOptions {
  type?: string;
  since?: string;
  until?: string;
  query?: string;
}

export function hasFilter(opts: FilterOptions): boolean {
  return Boolean(opts.type || opts.since || opts.until || opts.query);
}

/** 由 --type / --since / --until / --query 构造过滤条件 */
export function buildFilter(opts: FilterOptions): RecordingFilter {
  const filter: RecordingFilter = {};
  if (opts.type) filter.types = parseTypes(opts.type);
  if (opts.since) filter.since = parseTimeInput(opts.since);
  if (opts.until) filter.until = parseTimeInput(opts.until, { endOfDay: true });
  if (opts.query?.trim()) filter.match = opts.query.trim();
  if (filter.since !== undefined && filter.until !== undefined && filter.since > filter.until) {
    throw new Error("--since 晚于 --until，没有录音能同时满足");
  }
  return filter;
}

/** 文件名模板与并发数：命令行参数 > 配置 > 默认 */
export async function resolveTransferSettings(opts: {
  template?: string;
  concurrency?: string;
}): Promise<{ template: string; concurrency: number }> {
  const cfg = await loadRecordingConfig();
  const template = opts.template?.trim() ? opts.template : cfg.fileNameTemplate ?? DEFAULT_FILE_NAME_TEMPLATE;
  const concurrency =
    opts.concurrency !== undefined
      ? parseConcurrency(opts.concurrency)
      : cfg.concurrency !== undefined
        ? parseConcurrency(cfg.concurrency)
        : DEFAULT_CONCURRENCY;
  return { template, concurrency };
}

/** 是否显示动态进度行 */
export function showProgress(): boolean {
  return !isJsonMode() && !!process.stderr.isTTY;
}

/** 删除类操作的统一提醒：云端删除会同步到已登录的设备 */
export const DEVICE_SYNC_WARNING = "注意：小米云会同步删除已登录该账号的设备（如手机）上的这些录音。";
