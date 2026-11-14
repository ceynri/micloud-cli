import { getClient, resolveTransferSettings, showProgress, buildFilter, DEVICE_SYNC_WARNING, type FilterOptions } from "./shared.js";
import { resolveOutputDir } from "../config.js";
import { downloadToStream, urlExpiresAt } from "../download.js";
import { downloadRecordings, listCloud, pullRecordings, resolveIds } from "../pull.js";
import { success, logInfo, fail, isJsonMode, confirmDestructive, canPrompt, EXIT_PARTIAL_FAILURE } from "../output.js";
import { formatBytes, formatDuration, formatTime, parsePositiveInt } from "../utils.js";

interface PullCommandOptions extends FilterOptions {
  output?: string;
  template?: string;
  concurrency?: string;
  limit?: string;
  force?: boolean;
  dryRun?: boolean;
  deleteCloud?: boolean;
  allowMoved?: boolean;
  yes?: boolean;
}

/** pull：增量拉取云端录音到本地目录 */
export async function pullCommand(opts: PullCommandOptions): Promise<void> {
  try {
    const filter = buildFilter(opts);
    const limit = opts.limit !== undefined ? parsePositiveInt(opts.limit, Infinity, "--limit") : undefined;
    const outputDir = await resolveOutputDir(opts.output);
    const { template, concurrency } = await resolveTransferSettings(opts);
    if (opts.allowMoved && !opts.deleteCloud) throw new Error("--allow-moved 只能与 --delete-cloud 一起使用");
    if (opts.deleteCloud && !opts.dryRun && !opts.yes && !canPrompt()) {
      throw new Error("--delete-cloud 会删除云端录音，非交互模式（--json / 无终端）下需同时加 -y 明确确认");
    }
    const client = await getClient();
    const quiet = isJsonMode();

    const result = await pullRecordings(client, {
      outputDir,
      template,
      concurrency,
      filter,
      limit,
      force: opts.force,
      dryRun: opts.dryRun,
      deleteCloud: opts.deleteCloud,
      allowMoved: opts.allowMoved,
      confirmDelete: async (count) => {
        if (!quiet) logInfo(`⚠️  拉取并校验成功后，将把 ${count} 条云端录音移到回收站。${DEVICE_SYNC_WARNING}`);
        return await confirmDestructive("确认继续吗？", opts.yes);
      },
      quiet,
      showProgress: showProgress(),
    });

    success(result, () => {
      if (result.cancelled) {
        logInfo("已取消");
        return;
      }
      const printSkipped = (): void => {
        if (result.deleteSkipped.length === 0) return;
        logInfo(`ℹ️  ${result.deleteSkipped.length} 条录音未删除云端：`);
        for (const s of result.deleteSkipped.slice(0, 20)) logInfo(`   ${s.title}：${s.reason}`);
        if (result.deleteSkipped.length > 20) logInfo(`   ……其余 ${result.deleteSkipped.length - 20} 条略（--json 查看全部）`);
      };
      if (result.dryRun) {
        logInfo(`🔍 预览（未下载任何文件）：将拉取 ${result.pulled.length} 条，已拉取过 ${result.alreadyPulled} 条 → ${outputDir}`);
        for (const item of result.pulled) {
          const tag = item.existing ? "（本地已有相同文件）" : "";
          process.stdout.write(`  ${formatTime(item.recordedAt)}  ${formatDuration(item.duration).padStart(8)}  ${formatBytes(item.size).padStart(9)}  ${item.relativePath}${tag}\n`);
        }
        if (opts.deleteCloud) {
          logInfo(`将把 ${result.deletedFromCloud.length} 条云端录音移到回收站`);
          printSkipped();
        }
        for (const f of result.failed) logInfo(`❌ ${f.title || f.id}：${f.error}`);
        return;
      }
      printSkipped();
      for (const w of result.warnings) logInfo(`⚠️  ${w}`);
      const parts = [`拉取 ${result.pulled.length} 条（下载 ${formatBytes(result.downloadedBytes)}）`, `已拉取过 ${result.alreadyPulled} 条`];
      if (result.failed.length) parts.push(`失败 ${result.failed.length} 条`);
      if (opts.deleteCloud) parts.push(`云端移到回收站 ${result.deletedFromCloud.length} 条`);
      if (result.deleteFailed.length) parts.push(`云端删除失败 ${result.deleteFailed.length} 条`);
      const problem = result.failed.length || result.deleteFailed.length || result.warnings.length;
      logInfo(`\n${problem ? "⚠️" : "🎉"} 完成：${parts.join("，")}`);
    });
    if (result.failed.length > 0 || result.deleteFailed.length > 0 || result.warnings.length > 0) {
      process.exitCode = EXIT_PARTIAL_FAILURE;
    }
  } catch (err) {
    fail(err);
  }
}

interface DownloadCommandOptions {
  output?: string;
  template?: string;
  concurrency?: string;
  stdout?: boolean;
}

/** download：按 id 下载指定录音（不记录拉取状态） */
export async function downloadCommand(ids: string[], opts: DownloadCommandOptions): Promise<void> {
  try {
    if (opts.stdout) {
      await downloadToStdout(ids);
      return;
    }
    const outputDir = opts.output ? (await resolveOutputDir(opts.output)) : process.cwd();
    const { template, concurrency } = await resolveTransferSettings(opts);
    const client = await getClient();
    const result = await downloadRecordings(client, ids, {
      outputDir,
      template,
      concurrency,
      quiet: isJsonMode(),
      showProgress: showProgress(),
    });
    success(result, () => {
      logInfo(`\n完成：下载 ${result.downloaded.length} 条（${formatBytes(result.downloadedBytes)}）${result.failed.length ? `，失败 ${result.failed.length} 条` : ""}`);
    });
    if (result.failed.length > 0) process.exitCode = result.downloaded.length > 0 ? EXIT_PARTIAL_FAILURE : 1;
  } catch (err) {
    fail(err);
  }
}

/** 把单条录音写到 stdout（便于管道交给转写等工具）；先下载校验，通过后才输出 */
async function downloadToStdout(ids: string[]): Promise<void> {
  if (ids.length !== 1) throw new Error("--stdout 一次只能输出一条录音");
  if (isJsonMode()) throw new Error("--stdout 输出的是音频二进制，不能与 --json 同时使用");
  if (process.stdout.isTTY) throw new Error("--stdout 会输出音频二进制，请重定向到文件或管道（如 `> a.mp3` / `| ffmpeg -i - ...`）");
  const client = await getClient();
  const all = await listCloud(client, true);
  const { found, failures } = await resolveIds(client, all, ids);
  if (failures.length > 0) throw new Error(failures[0].error);
  await downloadToStream(client, found[0], process.stdout);
}

interface UrlCommandOptions {}

/** url：获取录音的临时直链（可直接在浏览器 / 播放器 / 下载工具中使用） */
export async function urlCommand(ids: string[], _opts: UrlCommandOptions = {}): Promise<void> {
  try {
    const client = await getClient();
    const all = await listCloud(client, true);
    const { found, failures } = await resolveIds(client, all, ids);
    const items: { id: string; title: string; url: string; expiresAt?: number }[] = [];
    for (const r of found) {
      const url = await client.getDownloadUrl(r.id);
      const expiresAt = urlExpiresAt(url);
      items.push({ id: r.id, title: r.title, url, ...(expiresAt ? { expiresAt } : {}) });
    }
    success({ items, failed: failures }, () => {
      for (const item of items) {
        if (items.length > 1) logInfo(`# ${item.title}`);
        process.stdout.write(item.url + "\n");
      }
      if (items.length > 0) {
        const expiresAt = items[0].expiresAt;
        logInfo(`直链无需登录即可访问${expiresAt ? `，约 ${formatTime(expiresAt)} 前有效` : "，有效期有限"}，请勿公开分享`);
      }
      for (const f of failures) logInfo(`❌ ${f.id}：${f.error}`);
    });
    if (failures.length > 0) process.exitCode = items.length > 0 ? EXIT_PARTIAL_FAILURE : 1;
  } catch (err) {
    fail(err);
  }
}

/** play：用系统默认播放器（或浏览器）打开录音直链 */
export async function playCommand(id: string): Promise<void> {
  try {
    const client = await getClient();
    const all = await listCloud(client, true);
    const { found, failures } = await resolveIds(client, all, [id]);
    if (failures.length > 0) throw new Error(failures[0].error);
    const r = found[0];
    const url = await client.getDownloadUrl(r.id);
    await openExternal(url);
    success({ id: r.id, title: r.title, url }, () => {
      logInfo(`▶️  已在默认播放器 / 浏览器中打开：${r.title}（${formatDuration(r.duration)}）`);
    });
  } catch (err) {
    fail(err);
  }
}

async function openExternal(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
    child.once("error", (err) => reject(new Error(`无法打开播放器：${err.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
