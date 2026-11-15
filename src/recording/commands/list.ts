import { getClient, buildFilter, type FilterOptions } from "./shared.js";
import { listCloud } from "../pull.js";
import {
  ALL_TYPES,
  TYPE_NAMES,
  matchesFilter,
  parseTrashedRecording,
  shortTypeName,
  sortByRecordedAt,
} from "../recording.js";
import { success, logInfo, fail, isJsonMode } from "../output.js";
import {
  displayWidth,
  formatBytes,
  formatDuration,
  formatTime,
  getDateTokens,
  padEndDisplay,
  padStartDisplay,
  parsePositiveInt,
  truncateDisplay,
} from "../utils.js";
import type { Recording, RecordingType, TrashedRecording } from "../types.js";

const TITLE_MAX_WIDTH = 56;
const SORT_KEYS = ["time", "size", "duration"] as const;
type SortKey = (typeof SORT_KEYS)[number];

interface ListOptions extends FilterOptions {
  limit?: string;
  sort?: string;
  asc?: boolean;
}

/** 列出云端录音 */
export async function listCommand(opts: ListOptions): Promise<void> {
  try {
    const filter = buildFilter(opts);
    const limit = parsePositiveInt(opts.limit, Infinity, "--limit");
    const sortKey = parseSortKey(opts.sort);
    const client = await getClient();
    const all = await listCloud(client, isJsonMode());
    const matched = sortRecordings(all.filter((r) => matchesFilter(r, filter)), sortKey, !!opts.asc);
    const items = matched.slice(0, limit);

    success(items, () => {
      if (items.length === 0) {
        logInfo("（没有符合条件的录音）");
        return;
      }
      printRecordingTable(items);
      const total = summarize(matched);
      const shown = items.length < matched.length ? `，显示前 ${items.length} 条` : "";
      logInfo(
        `\n共 ${matched.length} 条，总时长 ${formatDuration(total.duration)}，总大小 ${formatBytes(total.size)}${shown}`,
      );
    });
  } catch (err) {
    fail(err);
  }
}

/** 按关键词搜索（标题、联系人、号码、来源应用） */
export async function searchCommand(keywords: string[], opts: ListOptions): Promise<void> {
  await listCommand({ ...opts, query: keywords.join(" ") });
}

/** 查看单条录音的完整信息（也会查找回收站） */
export async function infoCommand(id: string): Promise<void> {
  try {
    const client = await getClient();
    const all = await listCloud(client, true);
    let recording: Recording | TrashedRecording | undefined = all.find((r) => r.id === id);
    let inTrash = false;
    if (!recording) {
      const trashed = (await client.listTrash()).find((r) => String(r.id) === id);
      if (trashed) {
        recording = parseTrashedRecording(trashed);
        inTrash = true;
      }
    }
    if (!recording) throw new Error(`找不到录音 ${id}（云端与回收站都没有）`);
    const r = recording;

    success({ ...r, inTrash }, () => {
      const rows: [string, string][] = [
        ["标题", r.title],
        ["ID", r.id],
        ["类型", r.appName && r.type === "app" ? `${r.typeName}（${r.appName}）` : r.typeName],
        ["录音时间", formatTime(r.recordedAt, true)],
        ["时长", `${formatDuration(r.duration)}${r.durationEstimated ? "（按大小估算）" : ""}`],
        ["大小", `${formatBytes(r.size)}（${r.size} 字节）`],
        ["格式", r.extension || "未知"],
      ];
      if (r.contactName) rows.push(["对方", r.contactName]);
      if (r.phoneNumber) rows.push(["号码", r.phoneNumber]);
      rows.push(["上传时间", formatTime(r.createTime, true)], ["SHA-1", r.sha1], ["云端文件名", r.rawName]);
      if (inTrash && "deletedAt" in r) rows.push(["状态", `在回收站中（${formatTime(r.deletedAt)} 删除）`]);
      for (const [label, value] of rows) {
        process.stdout.write(`${padEndDisplay(label, 10)}  ${value}\n`);
      }
    });
  } catch (err) {
    fail(err);
  }
}

const GROUP_KEYS = ["type", "month", "year"] as const;
type GroupKey = (typeof GROUP_KEYS)[number];

interface StatsOptions extends FilterOptions {
  by?: string;
}

/** 录音统计：按类型 / 月份 / 年份汇总条数、时长与大小 */
export async function statsCommand(opts: StatsOptions): Promise<void> {
  try {
    const by = (opts.by ?? "type") as GroupKey;
    if (!GROUP_KEYS.includes(by)) {
      throw new Error(`--by 只支持 ${GROUP_KEYS.join(" / ")}，收到：${opts.by}`);
    }
    const filter = buildFilter(opts);
    const client = await getClient();
    const matched = (await listCloud(client, isJsonMode())).filter((r) => matchesFilter(r, filter));

    const groups = new Map<string, { key: string; label: string; count: number; duration: number; size: number }>();
    for (const r of matched) {
      const key = groupKey(r, by);
      const group = groups.get(key) ?? { key, label: groupLabel(key, by), count: 0, duration: 0, size: 0 };
      group.count++;
      group.duration += r.duration;
      group.size += r.size;
      groups.set(key, group);
    }
    const ordered = [...groups.values()].sort((a, b) =>
      by === "type"
        ? ALL_TYPES.indexOf(a.key as RecordingType) - ALL_TYPES.indexOf(b.key as RecordingType)
        : b.key.localeCompare(a.key),
    );
    const total = { count: matched.length, ...summarize(matched) };

    success({ by, total, groups: ordered }, () => {
      if (matched.length === 0) {
        logInfo("（没有符合条件的录音）");
        return;
      }
      const labelWidth = Math.max(4, ...ordered.map((g) => displayWidth(g.label)));
      for (const g of ordered) {
        process.stdout.write(
          `${padEndDisplay(g.label, labelWidth)}  ${padStartDisplay(String(g.count), 5)} 条  ` +
            `${padStartDisplay(formatDuration(g.duration), 10)}  ${padStartDisplay(formatBytes(g.size), 10)}\n`,
        );
      }
      process.stdout.write(
        `${padEndDisplay("合计", labelWidth)}  ${padStartDisplay(String(total.count), 5)} 条  ` +
          `${padStartDisplay(formatDuration(total.duration), 10)}  ${padStartDisplay(formatBytes(total.size), 10)}\n`,
      );
    });
  } catch (err) {
    fail(err);
  }
}

/** 录音表格：ID、录音时间、时长、大小、类型、标题 */
export function printRecordingTable(items: Recording[]): void {
  for (const r of items) {
    const cells = [
      r.id.padEnd(17),
      formatTime(r.recordedAt),
      padStartDisplay(formatDuration(r.duration), 8),
      padStartDisplay(formatBytes(r.size), 9),
      padEndDisplay(shortTypeName(r), 8),
      truncateDisplay(r.title, TITLE_MAX_WIDTH),
    ];
    process.stdout.write(cells.join("  ") + "\n");
  }
}

export function summarize(items: { duration: number; size: number }[]): { duration: number; size: number } {
  return items.reduce(
    (acc, r) => ({ duration: acc.duration + r.duration, size: acc.size + r.size }),
    { duration: 0, size: 0 },
  );
}

function parseSortKey(raw: string | undefined): SortKey {
  if (raw === undefined) return "time";
  if (!SORT_KEYS.includes(raw as SortKey)) {
    throw new Error(`--sort 只支持 ${SORT_KEYS.join(" / ")}，收到：${raw}`);
  }
  return raw as SortKey;
}

function sortRecordings(items: Recording[], key: SortKey, asc: boolean): Recording[] {
  if (key === "time") return sortByRecordedAt(items, asc ? "asc" : "desc");
  const sign = asc ? 1 : -1;
  return [...items].sort((a, b) => sign * (a[key] - b[key]) || b.recordedAt - a.recordedAt);
}

function groupKey(r: Recording, by: GroupKey): string {
  if (by === "type") return r.type;
  const t = getDateTokens(r.recordedAt);
  return by === "month" ? `${t.YYYY}-${t.MM}` : t.YYYY;
}

function groupLabel(key: string, by: GroupKey): string {
  return by === "type" ? TYPE_NAMES[key as RecordingType] ?? key : key;
}
