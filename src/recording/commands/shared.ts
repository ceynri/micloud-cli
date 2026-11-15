import { ensureAuth, peekOrRefreshAuth, refreshAuth } from "../auth.js";
import { MiRecordingClient } from "../client.js";
import { DEFAULT_CONCURRENCY, loadUserConfig, parseConcurrency } from "../config.js";
import { parseTimeInput } from "../dates.js";
import { isJsonMode } from "../output.js";
import { parseTypes, type RecordingFilter } from "../recording.js";
import { DEFAULT_FILE_NAME_TEMPLATE } from "../template.js";

/**
 * 获取已认证的 API 客户端。
 *
 * - 交互式终端：无有效登录态时先静默续期，仍失败才打开浏览器登录。
 * - JSON 模式或非交互式（无 TTY，如被 AI/脚本调用）：不弹浏览器，
 *   续期失败直接抛出「请先登录」错误，避免进程挂起等待人工登录。
 *
 * 客户端注入 refreshAuth 作为续期回调：请求遇 401 时静默换发新 serviceToken 并重试。
 */
export async function getClient(forceLogin = false): Promise<MiRecordingClient> {
  const nonInteractive = isJsonMode() || !process.stdout.isTTY;
  if (nonInteractive && !forceLogin) {
    const auth = await peekOrRefreshAuth();
    if (!auth) {
      throw new Error(
        "未登录或登录态已过期。请先在交互式终端运行 `mi-recording-cli login` 完成登录。",
      );
    }
    return new MiRecordingClient(auth, refreshAuth);
  }
  return new MiRecordingClient(await ensureAuth(forceLogin), refreshAuth);
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

/** 文件名模板与并发数：CLI 参数 > 用户配置 > 默认 */
export async function resolveTransferSettings(opts: {
  template?: string;
  concurrency?: string;
}): Promise<{ template: string; concurrency: number }> {
  const cfg = await loadUserConfig();
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
export const DEVICE_SYNC_WARNING =
  "注意：小米云会同步删除已登录该账号的设备（如手机）上的这些录音。";
