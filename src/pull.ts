import { stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { isFatalError } from "./client.js";
import { getStatePath, loadState, lockOutputDir, saveState } from "./config.js";
import { fetchRecording, matchesLocalFile, sha1File, type DownloadSource } from "./download.js";
import { TransferProgress } from "./progress.js";
import {
  matchesFilter,
  parseRecording,
  sortByRecordedAt,
  type RecordingFilter,
} from "./recording.js";
import { pathKey, recordingRelPath, withIdSuffix } from "./template.js";
import { logInfo } from "./output.js";
import { fileExists, formatBytes } from "./utils.js";
import type { PullState, PulledRecord, RawRecording, Recording } from "./types.js";

/** pull / download 需要的客户端能力（便于测试替身） */
export interface TransferClient extends DownloadSource {
  listRecordings(onProgress?: (count: number) => void): Promise<RawRecording[]>;
  listTrash?(): Promise<RawRecording[]>;
  deleteRecording(id: string): Promise<void>;
}

/** 一条落盘结果：录音完整信息 + 本地文件位置 */
export interface TransferredItem extends Recording {
  /** 本地文件绝对路径 */
  file: string;
  /** 相对拉取目录的路径（`/` 分隔） */
  relativePath: string;
  /** 目标位置已有内容相同的文件，未重复下载 */
  existing: boolean;
}

export interface FailedItem {
  id: string;
  title: string;
  error: string;
}

/** 出于安全规则没有删除云端副本的原因 */
export type SkipCode = "kept" | "cloud-changed" | "unverifiable" | "local-missing";

export interface SkippedItem {
  id: string;
  title: string;
  code: SkipCode;
  reason: string;
}

export const SKIP_REASONS: Record<SkipCode, string> = {
  kept: "曾被本工具删除、后被恢复，视为有意保留（需要时按 id 删除）",
  "cloud-changed": "云端内容与拉取时不一致（可 pull --force 重新拉取后再删）",
  unverifiable: "云端缺少 SHA-1，无法校验，未删除",
  "local-missing": "拉取目录里的文件已不在或已被修改（已转移到别处时加 --allow-moved）",
};

export interface PullOptions {
  outputDir: string;
  template: string;
  concurrency: number;
  filter: RecordingFilter;
  /** 只拉取最新的 N 条待拉取录音 */
  limit?: number;
  /** 忽略拉取记录，重新拉取所有匹配的录音（本地已有相同内容时直接认领） */
  force?: boolean;
  dryRun?: boolean;
  /** 校验通过后把云端副本移到回收站（含之前已拉取、仍可校验的录音） */
  deleteCloud?: boolean;
  /** 删除之前已拉取的录音时，不要求拉取目录里的文件仍在（用户已把文件转移到别处） */
  allowMoved?: boolean;
  /** 删除云端前的确认；返回 false 则整个命令取消 */
  confirmDelete?: (count: number) => Promise<boolean>;
  /** 不输出任何日志（--json） */
  quiet?: boolean;
  /** 显示动态进度行 */
  showProgress?: boolean;
}

export interface PullResult {
  outputDir: string;
  dryRun: boolean;
  cancelled: boolean;
  /** 符合筛选条件的云端录音数 */
  matched: number;
  /** 之前已拉取过、本次跳过的条数 */
  alreadyPulled: number;
  /** 本次拉取（dryRun 时为计划拉取）的录音 */
  pulled: TransferredItem[];
  failed: FailedItem[];
  /** 已移到回收站（dryRun 时为计划删除）的云端录音 */
  deletedFromCloud: { id: string; title: string }[];
  /** 出于安全规则未删除云端的录音 */
  deleteSkipped: SkippedItem[];
  deleteFailed: FailedItem[];
  /** 不影响已完成操作、但需要用户知道的问题（如拉取状态写入失败） */
  warnings: string[];
  downloadedBytes: number;
}

export interface PlannedTarget {
  recording: Recording;
  relPath: string;
  absPath: string;
  /** 目标位置已有内容相同的文件，无需下载 */
  existing: boolean;
}

/**
 * 为一批录音分配落盘路径。
 *
 * 按录音时间从早到晚分配，先到先得：模板路径被占用（本批其他录音，或磁盘上内容不同的文件）时改用 `_<id>` 后缀；
 * 磁盘上已有大小与 SHA-1 都一致的文件则直接认领，不再下载。两个位置都被占用时报错，绝不覆盖已有文件。
 */
export async function planTargets(
  recordings: Recording[],
  outputDir: string,
  template: string,
): Promise<{ targets: PlannedTarget[]; failures: FailedItem[] }> {
  const claimed = new Set<string>();
  const targets: PlannedTarget[] = [];
  const failures: FailedItem[] = [];

  for (const recording of sortByRecordedAt(recordings, "asc")) {
    const base = recordingRelPath(template, recording);
    let placed = false;
    for (const relPath of [base, withIdSuffix(base, recording.id)]) {
      const key = pathKey(relPath);
      if (claimed.has(key)) continue;
      const absPath = join(outputDir, relPath);
      const st = await stat(absPath).catch(() => null);
      const existing =
        !!st &&
        st.isFile() &&
        st.size === recording.size &&
        !!recording.sha1 &&
        (await sha1File(absPath)) === recording.sha1;
      if (!st || existing) {
        claimed.add(key);
        targets.push({ recording, relPath, absPath, existing });
        placed = true;
        break;
      }
    }
    if (!placed) {
      failures.push({
        id: recording.id,
        title: recording.title,
        error: `目标位置已有内容不同的同名文件，未覆盖：${base}`,
      });
    }
  }
  return { targets, failures };
}

/**
 * 判断一条已拉取的录音能否删除云端副本，返回不能删除的原因（可以删除时返回 null）：
 * 未被本工具删过（删过又恢复视为有意保留）、云端大小与 SHA-1 与拉取时一致，
 * 且拉取目录里的文件仍完好——allowMoved 时跳过最后一项，以拉取记录为准。
 */
export async function checkCloudDeletable(
  r: Recording,
  record: PulledRecord,
  outputDir: string,
  allowMoved: boolean,
): Promise<SkipCode | null> {
  if (record.cloudDeletedAt) return "kept";
  if (!r.sha1 || !record.sha1) return "unverifiable";
  if (record.sha1 !== r.sha1 || record.size !== r.size) return "cloud-changed";
  if (!allowMoved && !(await matchesLocalFile(join(outputDir, record.file), { size: r.size, sha1: r.sha1 }))) {
    return "local-missing";
  }
  return null;
}

/** 从拉取记录里挑出可以删除云端副本的录音（规则见 checkCloudDeletable） */
export async function selectPulled(
  cloud: Recording[],
  state: PullState,
  outputDir: string,
  opts: { allowMoved?: boolean; predicate?: (r: Recording) => boolean } = {},
): Promise<{ targets: Recording[]; skipped: SkippedItem[] }> {
  const targets: Recording[] = [];
  const skipped: SkippedItem[] = [];
  for (const r of cloud) {
    const record = state.recordings[r.id];
    if (!record || (opts.predicate && !opts.predicate(r))) continue;
    const code = await checkCloudDeletable(r, record, outputDir, !!opts.allowMoved);
    if (code) skipped.push(skippedItem(r, code));
    else targets.push(r);
  }
  return { targets, skipped };
}

export function skippedItem(r: { id: string; title: string }, code: SkipCode): SkippedItem {
  return { id: r.id, title: r.title, code, reason: SKIP_REASONS[code] };
}

/**
 * 增量拉取：把云端录音下载到 outputDir，按拉取状态跳过之前拉取过的录音（即使本地文件已被移走）。
 *
 * 每条录音写 `.part` → 校验大小与 SHA-1 → 放到正式位置，成功后立即写入拉取状态，中断后重跑即可继续（`.part` 断点续传）。
 * 运行期间独占拉取目录（dryRun 除外）。deleteCloud 时，本次校验通过的录音与之前已拉取、仍可校验的录音会被移到云端回收站。
 */
export async function pullRecordings(client: TransferClient, opts: PullOptions): Promise<PullResult> {
  const release = opts.dryRun ? null : await lockOutputDir(opts.outputDir);
  try {
    return await runPull(client, opts);
  } finally {
    await release?.();
  }
}

async function runPull(client: TransferClient, opts: PullOptions): Promise<PullResult> {
  const log = (message: string): void => {
    if (!opts.quiet) logInfo(message);
  };

  const recordings = await listCloud(client, opts.quiet);
  const matched = recordings.filter((r) => matchesFilter(r, opts.filter));
  const state = await loadState(opts.outputDir);

  const pending: Recording[] = [];
  const previously: Recording[] = [];
  for (const r of matched) {
    if (state.recordings[r.id] && !opts.force) previously.push(r);
    else pending.push(r);
  }

  let selected = sortByRecordedAt(pending, "desc");
  if (opts.limit !== undefined) selected = selected.slice(0, opts.limit);
  const { targets, failures } = await planTargets(selected, opts.outputDir, opts.template);

  const result: PullResult = {
    outputDir: opts.outputDir,
    dryRun: !!opts.dryRun,
    cancelled: false,
    matched: matched.length,
    alreadyPulled: previously.length,
    pulled: [],
    failed: [...failures],
    deletedFromCloud: [],
    deleteSkipped: [],
    deleteFailed: [],
    warnings: [],
    downloadedBytes: 0,
  };

  // 本次拉取的录音在校验通过后删除云端；--force 重新拉取到的「删除后又被恢复」的录音仍视为保留
  const deleteAfterPull = new Set<string>();
  const previouslyDeletable: Recording[] = [];
  if (opts.deleteCloud) {
    for (const t of targets) {
      const r = t.recording;
      if (state.recordings[r.id]?.cloudDeletedAt) result.deleteSkipped.push(skippedItem(r, "kept"));
      else if (!r.sha1) result.deleteSkipped.push(skippedItem(r, "unverifiable"));
      else deleteAfterPull.add(r.id);
    }
    const selection = await selectPulled(previously, state, opts.outputDir, { allowMoved: opts.allowMoved });
    previouslyDeletable.push(...selection.targets);
    result.deleteSkipped.push(...selection.skipped);
  }

  if (opts.dryRun) {
    result.pulled = targets.map(toItem);
    result.deletedFromCloud = [
      ...targets.filter((t) => deleteAfterPull.has(t.recording.id)).map((t) => t.recording),
      ...previouslyDeletable,
    ].map(brief);
    return sortResult(result);
  }

  const deleteCount = deleteAfterPull.size + previouslyDeletable.length;
  if (deleteCount > 0 && opts.confirmDelete && !(await opts.confirmDelete(deleteCount))) {
    result.cancelled = true;
    return result;
  }

  if (targets.length === 0 && previouslyDeletable.length === 0) {
    log(failures.length ? "没有可拉取的录音" : `✨ 没有新录音（已拉取过 ${previously.length} 条）`);
    for (const f of failures) log(`❌ ${f.title}：${f.error}`);
    return sortResult(result);
  }

  const downloadBytes = targets.filter((t) => !t.existing).reduce((sum, t) => sum + t.recording.size, 0);
  if (targets.length > 0) {
    log(`📥 待拉取 ${targets.length} 条（${formatBytes(downloadBytes)}），已拉取过 ${previously.length} 条 → ${opts.outputDir}`);
  }
  for (const f of failures) log(`❌ ${f.title}：${f.error}`);

  const progress = new TransferProgress(downloadBytes, targets.length, !!opts.showProgress, !!opts.quiet);
  const serial = new SerialQueue();
  let fatal: string | null = null;

  const deleteOne = async (r: Recording): Promise<void> => {
    if (fatal) {
      result.deleteFailed.push({ id: r.id, title: r.title, error: fatal });
      return;
    }
    try {
      await client.deleteRecording(r.id);
    } catch (err) {
      if (isFatalError(err)) fatal ??= errorMessage(err);
      result.deleteFailed.push({ id: r.id, title: r.title, error: errorMessage(err) });
      progress.log(`⚠️  云端删除失败：${r.title}：${errorMessage(err)}`);
      return;
    }
    result.deletedFromCloud.push(brief(r));
    progress.log(`🗑️  已将云端录音移到回收站：${r.title}`);
    const record = state.recordings[r.id];
    if (!record) return;
    record.cloudDeletedAt = Date.now();
    try {
      await serial.run(() => saveState(opts.outputDir, state));
    } catch (err) {
      // 记不下删除标记时停止：后续操作同样无法记录
      fatal ??= `无法写入拉取状态：${errorMessage(err)}`;
      result.warnings.push(`已删除云端录音「${r.title}」，但${fatal}`);
      progress.log(`⚠️  ${fatal}`);
    }
  };

  progress.start();
  try {
    await runPool(targets, opts.concurrency, async (target) => {
      const r = target.recording;
      if (fatal) {
        result.failed.push({ id: r.id, title: r.title, error: fatal });
        return;
      }
      try {
        if (!target.existing) {
          await fetchRecording(client, r, target.absPath, (bytes) => progress.update(r.id, bytes));
          await setFileTime(target.absPath, r);
          result.downloadedBytes += r.size;
        }
      } catch (err) {
        if (isFatalError(err)) fatal ??= errorMessage(err);
        result.failed.push({ id: r.id, title: r.title, error: errorMessage(err) });
        progress.complete(`❌ ${target.relPath}：${errorMessage(err)}`);
        return;
      }

      const previous = state.recordings[r.id];
      state.recordings[r.id] = {
        sha1: r.sha1,
        size: r.size,
        file: target.relPath,
        title: r.title,
        pulledAt: Date.now(),
        ...(previous?.cloudDeletedAt ? { cloudDeletedAt: previous.cloudDeletedAt } : {}),
      };
      try {
        await serial.run(() => saveState(opts.outputDir, state));
      } catch (err) {
        // 状态写不进去（磁盘满等）时停止：后续拉取同样无法记录，也不再删除云端
        fatal ??= `无法写入拉取状态：${errorMessage(err)}`;
        result.failed.push({ id: r.id, title: r.title, error: fatal });
        progress.complete(`❌ ${target.relPath}：${fatal}`);
        return;
      }
      result.pulled.push(toItem(target));
      progress.complete(`${target.existing ? "☑️  已存在（内容一致）" : "✅ 已下载"} ${target.relPath}  ${formatBytes(r.size)}`);
      if (deleteAfterPull.has(r.id)) await deleteOne(r);
    });
    for (const r of previouslyDeletable) await deleteOne(r);
  } finally {
    progress.stop();
  }
  return sortResult(result);
}

/** 读取拉取目录的状态；状态文件不存在时返回 null */
export async function loadExistingState(outputDir: string): Promise<PullState | null> {
  return (await fileExists(getStatePath(outputDir))) ? await loadState(outputDir) : null;
}

export interface DownloadOptions {
  outputDir: string;
  template: string;
  concurrency: number;
  quiet?: boolean;
  showProgress?: boolean;
}

export interface DownloadResult {
  outputDir: string;
  downloaded: TransferredItem[];
  failed: FailedItem[];
  downloadedBytes: number;
}

/** 按 id 下载指定录音到 outputDir（不读写拉取状态）；本地已有相同内容的文件时直接跳过 */
export async function downloadRecordings(
  client: TransferClient,
  ids: string[],
  opts: DownloadOptions,
): Promise<DownloadResult> {
  const recordings = await listCloud(client, true);
  const { found, failures } = await resolveIds(client, recordings, ids);
  const { targets, failures: planFailures } = await planTargets(found, opts.outputDir, opts.template);

  const result: DownloadResult = {
    outputDir: opts.outputDir,
    downloaded: [],
    failed: [...failures, ...planFailures],
    downloadedBytes: 0,
  };

  const downloadBytes = targets.filter((t) => !t.existing).reduce((sum, t) => sum + t.recording.size, 0);
  const progress = new TransferProgress(downloadBytes, targets.length, !!opts.showProgress, !!opts.quiet);
  for (const f of result.failed) progress.log(`❌ ${f.title || f.id}：${f.error}`);
  let fatal: string | null = null;
  progress.start();
  try {
    await runPool(targets, opts.concurrency, async (target) => {
      const r = target.recording;
      if (fatal) {
        result.failed.push({ id: r.id, title: r.title, error: fatal });
        return;
      }
      try {
        if (!target.existing) {
          await fetchRecording(client, r, target.absPath, (bytes) => progress.update(r.id, bytes));
          await setFileTime(target.absPath, r);
          result.downloadedBytes += r.size;
        }
        result.downloaded.push(toItem(target));
        progress.complete(`${target.existing ? "☑️  已存在（内容一致）" : "✅ 已下载"} ${target.absPath}`);
      } catch (err) {
        if (isFatalError(err)) fatal ??= errorMessage(err);
        result.failed.push({ id: r.id, title: r.title, error: errorMessage(err) });
        progress.complete(`❌ ${target.relPath}：${errorMessage(err)}`);
      }
    });
  } finally {
    progress.stop();
  }
  result.downloaded = sortByRecordedAt(result.downloaded, "desc");
  return result;
}

/**
 * 在云端列表里按 id 查找录音。找不到的 id 会再查回收站，给出「在回收站里」的明确提示。
 * 重复的 id 只保留一次。
 */
export async function resolveIds(
  client: Pick<TransferClient, "listTrash">,
  recordings: Recording[],
  ids: string[],
): Promise<{ found: Recording[]; failures: FailedItem[] }> {
  const byId = new Map(recordings.map((r) => [r.id, r]));
  const found: Recording[] = [];
  const missing: string[] = [];
  for (const id of new Set(ids.map((s) => s.trim()).filter(Boolean))) {
    const r = byId.get(id);
    if (r) found.push(r);
    else missing.push(id);
  }
  if (missing.length === 0) return { found, failures: [] };

  let trashIds = new Set<string>();
  if (client.listTrash) {
    try {
      trashIds = new Set((await client.listTrash()).map((r) => String(r.id)));
    } catch {
      // 查回收站只为给出更好的提示，失败不影响主流程
    }
  }
  const failures = missing.map((id) => ({
    id,
    title: "",
    error: trashIds.has(id)
      ? "该录音在回收站中，可先用 trash restore 恢复"
      : "云端没有这条录音（id 有误或已被永久删除）",
  }));
  return { found, failures };
}

/** 拉取云端全部录音并解析 */
export async function listCloud(
  client: Pick<TransferClient, "listRecordings">,
  quiet = false,
): Promise<Recording[]> {
  const raws = await client.listRecordings((count) => {
    if (!quiet && process.stderr.isTTY) process.stderr.write(`\r📋 已获取 ${count} 条录音...`);
  });
  if (!quiet && process.stderr.isTTY) process.stderr.write("\r\x1b[2K");
  return raws.map(parseRecording);
}

/** 以有限并发处理一批任务（worker 自行处理错误） */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============ 内部 ============

/** 把文件修改时间设为手机上的录音文件时间，便于按时间排序 */
async function setFileTime(path: string, r: Recording): Promise<void> {
  const time = r.endedAt || r.recordedAt;
  if (!time) return;
  try {
    await utimes(path, time / 1000, time / 1000);
  } catch {
    // 设置失败不影响结果
  }
}

function toItem(target: PlannedTarget): TransferredItem {
  return {
    ...target.recording,
    file: target.absPath,
    relativePath: target.relPath,
    existing: target.existing,
  };
}

function brief(r: Recording): { id: string; title: string } {
  return { id: r.id, title: r.title };
}

function sortResult(result: PullResult): PullResult {
  result.pulled = sortByRecordedAt(result.pulled, "desc");
  return result;
}

/** 串行执行异步任务（保证状态文件写入不交错） */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
