import { getClient, buildFilter, hasFilter, DEVICE_SYNC_WARNING, type FilterOptions } from "./shared.js";
import { printRecordingTable, summarize } from "./list.js";
import { isFatalError } from "../../core/http.js";
import { getStatePath, lockOutputDir, resolveOutputDir, saveState } from "../config.js";
import {
  checkCloudDeletable,
  errorMessage,
  listCloud,
  loadExistingState,
  resolveIds,
  selectPulled,
  skippedItem,
  type FailedItem,
  type SkippedItem,
} from "../pull.js";
import { matchesFilter, sortByRecordedAt } from "../recording.js";
import { success, logInfo, fail, isJsonMode, confirmDestructive, finishBatch } from "../../core/output.js";
import { formatBytes, formatDuration, randomDelay } from "../../core/utils.js";
import type { PullState, Recording } from "../types.js";

interface DeleteOptions extends FilterOptions {
  pulled?: boolean;
  allowMoved?: boolean;
  output?: string;
  all?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

/**
 * delete：把云端录音移到回收站（可在 trash 中恢复）。
 *
 * 目标三选一：
 * - 直接给 id；
 * - --pulled：已拉取到本地的录音（规则见 checkCloudDeletable），可再叠加筛选条件；
 * - 筛选条件（--type / --since / --until / --query），或 --all 表示全部。
 */
export async function deleteCommand(ids: string[], opts: DeleteOptions): Promise<void> {
  let release: (() => Promise<void>) | null = null;
  try {
    const filtered = hasFilter(opts);
    const modes = [ids.length > 0, !!opts.pulled, !!opts.all].filter(Boolean).length;
    if (modes > 1) throw new Error("id、--pulled、--all 只能选一种方式指定要删除的录音");
    if (ids.length > 0 && filtered) throw new Error("指定 id 时不能再加筛选条件");
    if (opts.all && filtered) throw new Error("--all 表示删除全部录音，不能再加筛选条件");
    if (opts.allowMoved && !opts.pulled) throw new Error("--allow-moved 只能与 --pulled 一起使用");
    if (modes === 0 && !filtered) {
      throw new Error("请指定要删除的录音：id、--pulled、筛选条件（--type / --since / --until / --query），或 --all");
    }
    const filter = buildFilter(opts);

    let outputDir: string | undefined;
    let state: PullState | null = null;
    if (opts.pulled) {
      outputDir = await resolveOutputDir(opts.output);
      state = await loadExistingState(outputDir);
      if (!state) throw new Error(`拉取目录里没有拉取记录：${getStatePath(outputDir)}（用 -o 指定 pull 时的目录）`);
      if (!opts.dryRun) {
        release = await lockOutputDir(outputDir);
        state = (await loadExistingState(outputDir)) ?? state;
      }
    }

    const client = await getClient();
    const cloud = await listCloud(client, isJsonMode());
    const failed: FailedItem[] = [];
    let skipped: SkippedItem[] = [];
    let targets: Recording[];

    if (ids.length > 0) {
      const resolved = await resolveIds(client, cloud, ids);
      targets = resolved.found;
      failed.push(...resolved.failures);
    } else if (state && outputDir) {
      const selection = await selectPulled(cloud, state, outputDir, {
        allowMoved: opts.allowMoved,
        predicate: (r) => matchesFilter(r, filter),
      });
      targets = selection.targets;
      skipped = selection.skipped;
    } else {
      targets = cloud.filter((r) => matchesFilter(r, filter));
    }
    targets = sortByRecordedAt(targets, "desc");

    const plan = { count: targets.length, ...summarize(targets) };
    const printSkipped = (): void => {
      if (skipped.length === 0) return;
      logInfo(`ℹ️  另有 ${skipped.length} 条已拉取的录音未删除：`);
      for (const s of skipped.slice(0, 20)) logInfo(`   ${s.title}：${s.reason}`);
      if (skipped.length > 20) logInfo(`   ……其余 ${skipped.length - 20} 条略（--json 查看全部）`);
    };

    if (opts.dryRun || targets.length === 0) {
      const data = { dryRun: !!opts.dryRun, deleted: [], wouldDelete: targets, skipped, failed, ...plan };
      finishBatch(data, { succeeded: targets.length, failed }, () => {
        if (targets.length === 0) logInfo("（没有要删除的录音）");
        else {
          logInfo(`🔍 预览：将把以下 ${targets.length} 条录音移到回收站（${formatDuration(plan.duration)}，${formatBytes(plan.size)}）`);
          printRecordingTable(targets);
        }
        printSkipped();
        for (const f of failed) logInfo(`⚠️  ${f.title || f.id}：${f.error}`);
      });
      return;
    }

    if (!isJsonMode()) {
      logInfo(`将把以下 ${targets.length} 条云端录音移到回收站（${formatDuration(plan.duration)}，${formatBytes(plan.size)}）：`);
      printRecordingTable(targets.slice(0, 20));
      if (targets.length > 20) logInfo(`……其余 ${targets.length - 20} 条略`);
      printSkipped();
      logInfo(DEVICE_SYNC_WARNING);
    }
    if (!(await confirmDestructive(`确认删除这 ${targets.length} 条录音吗？`, opts.yes))) {
      success({ cancelled: true }, () => logInfo("已取消"));
      return;
    }

    const deleted: Recording[] = [];
    const warnings: string[] = [];
    let fatal: string | null = null;
    for (const r of targets) {
      if (fatal) {
        failed.push({ id: r.id, title: r.title, error: fatal });
        continue;
      }
      // --pulled：删除前再核对一次（确认后、逐条删除期间，本地文件可能已被转移或改动）
      const record = state?.recordings[r.id];
      if (record && outputDir) {
        const code = await checkCloudDeletable(r, record, outputDir, !!opts.allowMoved);
        if (code) {
          skipped.push(skippedItem(r, code));
          continue;
        }
      }
      try {
        await client.deleteRecording(r.id);
        deleted.push(r);
        if (!isJsonMode()) logInfo(`🗑️  ${r.title}`);
      } catch (err) {
        const message = errorMessage(err);
        failed.push({ id: r.id, title: r.title, error: message });
        if (!isJsonMode()) logInfo(`❌ ${r.title}：${message}`);
        if (isFatalError(err)) fatal = message;
      }
      if (targets.length > 1) await randomDelay(150);
    }

    // 记下删除时间：之后若从回收站恢复，--pulled / --delete-cloud 不会再自动删除它
    if (state && outputDir) {
      let marked = false;
      for (const r of deleted) {
        const record = state.recordings[r.id];
        if (record) {
          record.cloudDeletedAt = Date.now();
          marked = true;
        }
      }
      if (marked) {
        try {
          await saveState(outputDir, state);
        } catch (err) {
          warnings.push(`无法写入拉取状态：${errorMessage(err)}`);
        }
      }
    }

    const data = { deleted, skipped, failed, warnings, count: deleted.length, ...summarize(deleted) };
    finishBatch(data, { succeeded: deleted.length, failed, warnings: warnings.length }, () => {
      for (const w of warnings) logInfo(`⚠️  ${w}`);
      logInfo(`\n已将 ${deleted.length} 条录音移到回收站${failed.length ? `，${failed.length} 条失败` : ""}（可用 trash restore 恢复）`);
    });
  } catch (err) {
    fail(err);
  } finally {
    await release?.();
  }
}
