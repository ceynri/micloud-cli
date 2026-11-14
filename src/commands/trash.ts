import { getClient } from "./shared.js";
import { summarize } from "./list.js";
import { CODE_SPACE_FULL, MiApiError, isFatalError } from "../client.js";
import { errorMessage, type FailedItem } from "../pull.js";
import { TRASH_RETENTION_DAYS, parseTrashedRecording, shortTypeName } from "../recording.js";
import { success, logInfo, fail, isJsonMode, confirmDestructive, EXIT_PARTIAL_FAILURE } from "../output.js";
import {
  formatBytes,
  formatDuration,
  formatTime,
  padEndDisplay,
  padStartDisplay,
  randomDelay,
  truncateDisplay,
} from "../utils.js";
import type { MiRecordingClient } from "../client.js";
import type { TrashedRecording } from "../types.js";

/** 回收站列表（按删除时间倒序），附带按会员等级推算的自动清除时间 */
async function loadTrash(client: MiRecordingClient): Promise<TrashedRecording[]> {
  const [raws, quota] = await Promise.all([client.listTrash(), client.getQuota().catch(() => undefined)]);
  const retention = quota?.level ? TRASH_RETENTION_DAYS[quota.level] : undefined;
  return raws
    .map((raw) => parseTrashedRecording(raw, retention))
    .sort((a, b) => b.deletedAt - a.deletedAt || a.id.localeCompare(b.id));
}

/** trash list：查看回收站（最近删除） */
export async function trashListCommand(): Promise<void> {
  try {
    const client = await getClient();
    const items = await loadTrash(client);
    success(items, () => {
      if (items.length === 0) {
        logInfo("（回收站为空）");
        return;
      }
      for (const r of items) {
        const cells = [
          r.id.padEnd(17),
          `删除于 ${formatTime(r.deletedAt)}`,
          padStartDisplay(formatDuration(r.duration), 8),
          padStartDisplay(formatBytes(r.size), 9),
          padEndDisplay(shortTypeName(r), 8),
          truncateDisplay(r.title, 48),
        ];
        process.stdout.write(cells.join("  ") + "\n");
      }
      const total = summarize(items);
      const expiry = items[0].expiresAt ? `；删除超过保留期限的录音会被自动清除` : "";
      logInfo(`\n共 ${items.length} 条，${formatDuration(total.duration)}，${formatBytes(total.size)}${expiry}`);
    });
  } catch (err) {
    fail(err);
  }
}

interface TrashActionOptions {
  all?: boolean;
  yes?: boolean;
}

/** trash restore：从回收站恢复录音 */
export async function trashRestoreCommand(ids: string[], opts: TrashActionOptions): Promise<void> {
  await trashAction("restore", ids, opts);
}

/** trash purge：从回收站永久删除录音（不可恢复） */
export async function trashPurgeCommand(ids: string[], opts: TrashActionOptions): Promise<void> {
  await trashAction("purge", ids, opts);
}

async function trashAction(action: "restore" | "purge", ids: string[], opts: TrashActionOptions): Promise<void> {
  try {
    if (ids.length > 0 && opts.all) throw new Error("指定 id 时不能再加 --all");
    if (ids.length === 0 && !opts.all) throw new Error("请指定回收站里录音的 id，或用 --all 表示全部");

    const client = await getClient();
    const trash = await loadTrash(client);
    const { targets, missing } = selectTrashTargets(trash, ids, !!opts.all);
    const failed: FailedItem[] = missing.map((id) => ({ id, title: "", error: "回收站里没有这条录音" }));
    const verb = action === "restore" ? "恢复" : "永久删除";

    if (targets.length === 0) {
      success({ [action === "restore" ? "restored" : "purged"]: [], failed }, () => {
        logInfo(opts.all ? "（回收站为空）" : "（没有可操作的录音）");
        for (const f of failed) logInfo(`❌ ${f.id}：${f.error}`);
      });
      if (failed.length > 0) process.exitCode = 1;
      return;
    }

    if (action === "purge") {
      if (!isJsonMode()) {
        logInfo(`将永久删除以下 ${targets.length} 条录音，删除后无法恢复：`);
        for (const r of targets.slice(0, 20)) logInfo(`  [${r.id}] ${r.title}`);
        if (targets.length > 20) logInfo(`  ……其余 ${targets.length - 20} 条略`);
      }
      if (!(await confirmDestructive(`确认永久删除这 ${targets.length} 条录音吗？`, opts.yes))) {
        success({ cancelled: true }, () => logInfo("已取消"));
        return;
      }
    }

    const done: TrashedRecording[] = [];
    let fatal: string | null = null;
    for (const r of targets) {
      if (fatal) {
        failed.push({ id: r.id, title: r.title, error: fatal });
        continue;
      }
      try {
        if (action === "restore") await client.recoverRecording(r.id, r.ver);
        else await client.purgeRecording(r.id, r.ver);
        done.push(r);
        if (!isJsonMode()) logInfo(`${action === "restore" ? "♻️ " : "🔥"} ${r.title}`);
      } catch (err) {
        const message = errorMessage(err);
        failed.push({ id: r.id, title: r.title, error: message });
        if (!isJsonMode()) logInfo(`❌ ${r.title}：${message}`);
        // 空间已满时后续恢复必然失败；登录失效时后续请求都会失败
        if (isFatalError(err) || (err instanceof MiApiError && err.code === CODE_SPACE_FULL)) fatal = message;
      }
      if (targets.length > 1) await randomDelay(150);
    }

    const key = action === "restore" ? "restored" : "purged";
    success({ [key]: done, failed, count: done.length }, () => {
      logInfo(`\n已${verb} ${done.length} 条录音${failed.length ? `，${failed.length} 条失败` : ""}`);
    });
    if (failed.length > 0) process.exitCode = done.length > 0 ? EXIT_PARTIAL_FAILURE : 1;
  } catch (err) {
    fail(err);
  }
}

/** 从回收站里挑出目标；ver 必须用回收站条目当前的值（删除时 ver 会变） */
export function selectTrashTargets(
  trash: TrashedRecording[],
  ids: string[],
  all: boolean,
): { targets: TrashedRecording[]; missing: string[] } {
  if (all) return { targets: trash, missing: [] };
  const byId = new Map(trash.map((r) => [r.id, r]));
  const targets: TrashedRecording[] = [];
  const missing: string[] = [];
  for (const id of new Set(ids.map((s) => s.trim()).filter(Boolean))) {
    const r = byId.get(id);
    if (r) targets.push(r);
    else missing.push(id);
  }
  return { targets, missing };
}
