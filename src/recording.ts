import type { RawRecording, Recording, RecordingType, TrashedRecording } from "./types.js";

/** 类型码 → 类型（与网页端分组一致；未知类型码网页端归入录音机） */
const TYPE_BY_CODE: Record<number, RecordingType> = {
  0: "recorder",
  1: "phonecall",
  2: "fm",
  3: "app",
};

export const ALL_TYPES: RecordingType[] = ["recorder", "phonecall", "fm", "app"];

export const TYPE_NAMES: Record<RecordingType, string> = {
  recorder: "录音机录音",
  phonecall: "通话录音",
  fm: "FM录音",
  app: "应用录音",
};

/** 名字里没有时长段时按码率（bit/s）估算时长，沿用网页端的取值 */
const BITRATE_BY_TYPE_EXT: Record<string, number> = {
  "1_mp3": 8000,
  "0_mp3": 64000,
  "0_amr": 24000,
  "0_3gpp": 160000,
  "2_mp3": 32000,
};
const DEFAULT_BITRATE = 64000;

/** extraInfo.appType → 来源应用 */
const APP_TYPE_NAMES: Record<number, string> = { 1: "微信", 2: "企业微信" };

/** 回收站保留天数（按会员等级，取自网页端） */
export const TRASH_RETENTION_DAYS: Record<string, number> = {
  None: 30,
  FirstLevel: 60,
  SecondLevel: 90,
  ThirdLevel: 180,
};

const DAY = 86_400_000;
/** 早于此时间的时间戳视为无效（2000-01-01） */
const MIN_VALID_TIME = 946_684_800_000;

interface NameParts {
  base: string;
  extension: string;
  duration: number | null;
  typeCode: number;
  fileTime: number | null;
}

/**
 * 拆解云端 name：`<标题>.<扩展名>[_<时长秒>]_<类型码>_<文件时间>_<上传时间>`。
 * 时长段只在扩展名之后出现；不符合格式时整串视为标题。
 */
export function parseRawName(raw: string): NameParts {
  const full = raw.match(/^([\s\S]*)\.([A-Za-z0-9]{1,10})_(\d+)_(-?\d+)_(\d+)_(\d+)$/);
  if (full) {
    return {
      base: full[1],
      extension: full[2],
      duration: Number(full[3]),
      typeCode: Number(full[4]),
      fileTime: validTime(Number(full[5])),
    };
  }
  const noDuration = raw.match(/^([\s\S]*)\.([A-Za-z0-9]{1,10})_(-?\d+)_(\d+)_(\d+)$/);
  if (noDuration) {
    return {
      base: noDuration[1],
      extension: noDuration[2],
      duration: null,
      typeCode: Number(noDuration[3]),
      fileTime: validTime(Number(noDuration[4])),
    };
  }
  const plain = raw.match(/^([\s\S]+)\.([A-Za-z0-9]{1,10})$/);
  if (plain) {
    return { base: plain[1], extension: plain[2], duration: null, typeCode: -1, fileTime: null };
  }
  return { base: raw, extension: "", duration: null, typeCode: -1, fileTime: null };
}

/** 把云端原始条目解析为领域模型 */
export function parseRecording(raw: RawRecording): Recording {
  const id = String(raw.id);
  const size = Number(raw.size) || 0;
  const createTime = Number(raw.create_time) || 0;
  const parts = parseRawName(raw.name ?? "");
  const typeCode = Number.isFinite(parts.typeCode) ? parts.typeCode : -1;
  const type = TYPE_BY_CODE[typeCode] ?? "recorder";

  let duration = parts.duration;
  const durationEstimated = duration === null;
  if (duration === null) {
    const bitrate = BITRATE_BY_TYPE_EXT[`${typeCode}_${parts.extension.toLowerCase()}`] ?? DEFAULT_BITRATE;
    duration = (8 * size) / bitrate;
  }
  duration = Math.max(1, Math.round(duration));

  const title = parts.base.trim() || id;
  const extraInfo = parseExtraInfo(raw.extraInfo);
  const peer = parsePeer(parts.base, type);
  const appType = typeof extraInfo?.appType === "number" ? extraInfo.appType : undefined;
  const appName = peer.appName ?? (type === "app" && appType ? APP_TYPE_NAMES[appType] : undefined);
  const endedAt = parts.fileTime ?? createTime;

  const recording: Recording = {
    id,
    title,
    fileName: parts.extension ? `${title}.${parts.extension}` : title,
    extension: parts.extension,
    type,
    typeName: TYPE_NAMES[type],
    typeCode,
    duration,
    durationEstimated,
    recordedAt: resolveRecordedAt({
      base: parts.base,
      duration,
      durationEstimated,
      fileTime: parts.fileTime,
      fallback: createTime,
    }),
    endedAt,
    size,
    sha1: String(raw.sha1 ?? "").toLowerCase(),
    createTime,
    modifyTime: Number(raw.modify_time) || createTime,
    ver: String(raw.ver ?? ""),
    rawName: raw.name ?? "",
  };
  if (peer.phoneNumber) recording.phoneNumber = peer.phoneNumber;
  if (peer.contactName) recording.contactName = peer.contactName;
  if (appName) recording.appName = appName;
  if (extraInfo) recording.extraInfo = extraInfo;
  return recording;
}

/** 解析回收站条目：删除时间取 modify_time；给定保留天数时推算自动清除时间 */
export function parseTrashedRecording(raw: RawRecording, retentionDays?: number): TrashedRecording {
  const recording = parseRecording(raw);
  const deletedAt = Number(raw.modify_time) || recording.modifyTime;
  const trashed: TrashedRecording = { ...recording, deletedAt };
  if (retentionDays) trashed.expiresAt = deletedAt + retentionDays * DAY;
  return trashed;
}

/** 列表的人类可读类型名：应用录音优先显示来源应用 */
export function shortTypeName(r: Recording): string {
  switch (r.type) {
    case "recorder":
      return "录音机";
    case "phonecall":
      return "通话";
    case "fm":
      return "FM";
    case "app":
      return r.appName ?? "应用";
  }
}

/** 按录音时间排序（同一时间按 id 保证稳定） */
export function sortByRecordedAt<T extends { recordedAt: number; id: string }>(
  list: T[],
  order: "asc" | "desc" = "desc",
): T[] {
  const sign = order === "asc" ? 1 : -1;
  return [...list].sort(
    (a, b) => sign * (a.recordedAt - b.recordedAt) || sign * a.id.localeCompare(b.id),
  );
}

// ============ 过滤 ============

export interface RecordingFilter {
  types?: RecordingType[];
  /** 录音时间下限（含），毫秒 */
  since?: number;
  /** 录音时间上限（含），毫秒 */
  until?: number;
  /** 关键词：空白分隔、全部命中才算匹配，不区分大小写 */
  match?: string;
}

export function matchesFilter(r: Recording, filter: RecordingFilter): boolean {
  if (filter.types?.length && !filter.types.includes(r.type)) return false;
  if (filter.since !== undefined && r.recordedAt < filter.since) return false;
  if (filter.until !== undefined && r.recordedAt > filter.until) return false;
  if (filter.match?.trim()) {
    const haystack = [r.title, r.contactName, r.phoneNumber, r.appName, r.id]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    const keywords = filter.match.toLowerCase().split(/\s+/).filter(Boolean);
    if (!keywords.every((k) => haystack.includes(k))) return false;
  }
  return true;
}

/** 解析 --type：逗号分隔，取值见 ALL_TYPES */
export function parseTypes(raw: string): RecordingType[] {
  const types = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const t of types) {
    if (!ALL_TYPES.includes(t as RecordingType)) {
      throw new Error(`未知的录音类型：${t}（可选：${ALL_TYPES.join(" / ")}）`);
    }
  }
  return types as RecordingType[];
}

// ============ 内部 ============

function validTime(ts: number): number | null {
  return Number.isFinite(ts) && ts > MIN_VALID_TIME ? ts : null;
}

function parseExtraInfo(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

interface PeerInfo {
  phoneNumber?: string;
  contactName?: string;
  appName?: string;
}

/**
 * 从标题解析通话对方 / 来源应用（格式取自网页端）：
 * - 通话录音：`[xx@]联系人(号码)_yyyyMMddHHmmss` 或 `[xx@]号码_yyyyMMddHHmmss`
 * - 应用录音：`微信录音 对方昵称_yyyyMMddHHmmss`、`企业微信录音_yyyyMMddHHmmss`
 */
function parsePeer(base: string, type: RecordingType): PeerInfo {
  if (type !== "phonecall" && type !== "app") return {};
  const at = base.indexOf("@");
  const text = at > -1 ? base.slice(at + 1) : base;
  const m = text.match(/^([\s\S]*?)_\d{14}$/);
  if (!m) return {};
  const label = m[1].trim();
  if (!label) return {};

  if (type === "phonecall") {
    const paren = label.lastIndexOf("(");
    if (paren > 0 && label.endsWith(")")) {
      return {
        contactName: label.slice(0, paren).trim() || undefined,
        phoneNumber: label.slice(paren + 1, -1).trim() || undefined,
      };
    }
    return { phoneNumber: label };
  }

  const app = label.match(/^(\S+?)录音(?:\s+([\s\S]+))?$/);
  if (!app) return {};
  return { appName: app[1], contactName: app[2]?.trim() || undefined };
}

/** 标题末尾的 14 位时间戳（yyyyMMddHHmmss，本地时间），是通话 / 应用 / FM 录音的精确开始时间 */
function parseStamp(base: string): number | null {
  const m = base.match(/_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return buildLocalTime(y, mo, d, h, mi, s);
}

const CN_TIME =
  /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})点(\d{1,2})分/;

/**
 * 录音机默认标题里的中文时间，如 `2026年07月02日 16点04分`、`9月28日 14点01分`、`2025年06月27日 下午11点06分`。
 * 缺年份时取参考时间所在年；落在参考时间一天之后则视为上一年。
 */
export function parseChineseTime(text: string, reference: number): number | null {
  const m = text.match(CN_TIME);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  const period = m[4];
  let hour = Number(m[5]);
  const minute = Number(m[6]);
  if ((period === "下午" || period === "晚上") && hour < 12) hour += 12;
  else if (period === "中午" && hour < 11) hour += 12;
  else if ((period === "凌晨" || period === "早上" || period === "上午") && hour === 12) hour = 0;

  if (m[1]) return buildLocalTime(Number(m[1]), month, day, hour, minute, 0);
  const refYear = new Date(reference).getFullYear();
  const sameYear = buildLocalTime(refYear, month, day, hour, minute, 0);
  if (sameYear !== null && sameYear > reference + DAY) {
    return buildLocalTime(refYear - 1, month, day, hour, minute, 0);
  }
  return sameYear;
}

function buildLocalTime(y: number, mo: number, d: number, h: number, mi: number, s: number): number | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi, s);
  if (date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

/**
 * 推算录音开始时间，按可靠度依次取：
 * 1. 标题末尾的 14 位时间戳（精确到秒）；
 * 2. 录音机默认标题里的中文时间——能覆盖暂停过的录音（文件时间减时长会偏晚）；
 *    与「文件时间 - 时长」落在同一分钟时取后者以保留秒；落在合理区间外（如异地时区录制）则不采用；
 * 3. 文件时间 - 时长；
 * 4. 云端创建时间。
 */
function resolveRecordedAt(input: {
  base: string;
  duration: number;
  durationEstimated: boolean;
  fileTime: number | null;
  fallback: number;
}): number {
  const { base, duration, durationEstimated, fileTime, fallback } = input;
  const stamp = parseStamp(base);
  if (stamp !== null) return stamp;

  const computed = fileTime !== null ? fileTime - duration * 1000 : null;
  const end = fileTime ?? fallback;
  const titled = end ? parseChineseTime(base, end) : null;
  if (titled !== null) {
    const latestStart = end - (durationEstimated ? 0 : duration * 1000) + 60_000;
    const earliestStart = fileTime !== null ? fileTime - 2 * DAY : -Infinity;
    if (titled <= latestStart && titled >= earliestStart) {
      if (computed !== null && !durationEstimated && computed >= titled && computed < titled + 60_000) {
        return computed;
      }
      return titled;
    }
  }
  return computed ?? fallback;
}
