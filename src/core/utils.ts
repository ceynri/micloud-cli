import { randomUUID } from "node:crypto";
import { mkdir, access, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";

export const APP_NAME = "micloud";

/** 文件名主体的最大 UTF-8 字节数（留出 `_<id>` 后缀与扩展名的空间，整体不超过常见文件系统的 255 字节上限） */
const MAX_NAME_BYTES = 200;

/** 清理文件名中的非法字符，并按 UTF-8 字节截断；Windows 保留设备名（CON、NUL、COM1 等）前加 `_` */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  const truncated = truncateUtf8(cleaned, MAX_NAME_BYTES).replace(/[.\s]+$/, "");
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(truncated) ? `_${truncated}` : truncated;
}

/** 按 UTF-8 字节数截断，不切断多字节字符 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += ch;
  }
  return out;
}

/** 延时 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 带随机抖动的延时（模拟人类节奏，降低风控概率） */
export function randomDelay(baseMs: number, jitterRatio = 0.5): Promise<void> {
  const jitter = baseMs * jitterRatio * (2 * Math.random() - 1);
  return delay(Math.max(50, Math.round(baseMs + jitter)));
}

/** 时间分量（按本地时区拆出年/月/日/时/分/秒，用于文件名模板替换） */
export interface DateTokens {
  YYYY: string;
  YY: string;
  MM: string;
  DD: string;
  HH: string;
  mm: string;
  ss: string;
}

/** 把时间戳拆为本地时区的零填充分量 */
export function getDateTokens(ts: number): DateTokens {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return {
    YYYY: yyyy,
    YY: yyyy.slice(-2),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
  };
}

/** 格式化为 YYYY-MM-DD_HH-mm-ss（可用作文件名） */
export function formatDateTime(ts: number): string {
  const t = getDateTokens(ts);
  return `${t.YYYY}-${t.MM}-${t.DD}_${t.HH}-${t.mm}-${t.ss}`;
}

/** 本地时间显示：`2026-07-02 16:04`（withSeconds 时带秒） */
export function formatTime(ts: number, withSeconds = false): string {
  if (!ts) return "";
  const t = getDateTokens(ts);
  const base = `${t.YYYY}-${t.MM}-${t.DD} ${t.HH}:${t.mm}`;
  return withSeconds ? `${base}:${t.ss}` : base;
}

/** 字节数转可读体积：`45.2 MB` */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
}

/** 秒数转时长：`3:05` / `1:02:03` */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 确保目录存在 */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/** 检查文件是否存在 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 确保文件所在目录存在 */
export async function ensureFileDir(filePath: string): Promise<void> {
  await ensureDir(dirname(filePath));
}

/** 原子写文件：先写同目录临时文件再改名，进程中断也不会留下半截内容 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await ensureFileDir(filePath);
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, filePath);
}

/**
 * 全局缓存目录（跨平台）——只放登录状态等可重建的缓存。
 *
 * - macOS:   ~/Library/Caches/micloud/
 * - Linux:   $XDG_CACHE_HOME/micloud/ 或 ~/.cache/micloud/
 * - Windows: %LOCALAPPDATA%/micloud/cache/
 *
 * `MICLOUD_CACHE_DIR` 可覆盖（测试隔离用）。
 */
export function getCacheDir(): string {
  return process.env.MICLOUD_CACHE_DIR || platformCacheDir(APP_NAME);
}

/** 旧版工具（如 mi-note-cli）的缓存目录，只用于首次使用时沿用其登录状态 */
export function getLegacyCacheDir(app: string): string {
  return platformCacheDir(app);
}

function platformCacheDir(app: string): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Caches", app);
    case "win32":
      return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), app, "cache");
    default:
      return join(process.env.XDG_CACHE_HOME || join(home, ".cache"), app);
  }
}

/** 解析正整数参数；未提供时返回 fallback */
export function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} 必须是正整数，收到：${raw}`);
  }
  return n;
}

// ============ 终端显示宽度（CJK 记 2 列） ============

/** 字符串在终端中的显示宽度 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += isWide(ch) ? 2 : 1;
  return width;
}

/**
 * 按显示宽度截断字符串，超出加省略号。
 * 同时把内部换行/连续空白压成单空格，保证终端列表每条只占一行。
 */
export function truncateDisplay(text: string, maxWidth: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  let width = 0;
  let out = "";
  for (const ch of flat) {
    const w = isWide(ch) ? 2 : 1;
    if (width + w > maxWidth) return out + "…";
    width += w;
    out += ch;
  }
  return out;
}

/** 右侧补空格到指定显示宽度 */
export function padEndDisplay(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/** 左侧补空格到指定显示宽度 */
export function padStartDisplay(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(text))) + text;
}

/** 判断字符是否为宽字符（CJK、全角等占 2 列） */
function isWide(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首、标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名、CJK 符号
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+及表情等
  );
}
