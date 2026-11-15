const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * 解析时间参数（--since / --until 等），返回毫秒时间戳：
 * - 相对时间：`30m` `12h` `7d` `2w`（距今）
 * - `today` / `yesterday`
 * - 日期：`2026-07-01`、`2026/7/1`、`20260701`
 * - 日期时间：`2026-07-01 18:30`、`2026-07-01T18:30:05`（本地时间），或带时区的 ISO 字符串
 * - Unix 时间戳：13 位毫秒 / 10 位秒
 *
 * endOfDay：只给到日期（含 today / yesterday）时取当天 23:59:59.999，用于 --until 包含整天。
 */
export function parseTimeInput(raw: string, opts: { endOfDay?: boolean; now?: number } = {}): number {
  const text = raw.trim();
  const now = opts.now ?? Date.now();
  const lower = text.toLowerCase();

  const relative = lower.match(/^(\d+)\s*([smhdw])$/);
  if (relative) return now - Number(relative[1]) * UNIT_MS[relative[2]];

  if (lower === "today" || lower === "yesterday") {
    const d = new Date(now);
    if (lower === "yesterday") d.setDate(d.getDate() - 1);
    return dayBoundary(d.getFullYear(), d.getMonth() + 1, d.getDate(), opts.endOfDay);
  }

  if (/^\d{13}$/.test(text)) return Number(text);
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;

  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return checked(dayBoundary(Number(compact[1]), Number(compact[2]), Number(compact[3]), opts.endOfDay), raw);
  }

  const local = text.match(
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (local) {
    const [y, mo, d] = [Number(local[1]), Number(local[2]), Number(local[3])];
    if (local[4] === undefined) return checked(dayBoundary(y, mo, d, opts.endOfDay), raw);
    const date = new Date(y, mo - 1, d, Number(local[4]), Number(local[5]), Number(local[6] ?? 0));
    return checked(sameDay(date, y, mo, d) ? date.getTime() : NaN, raw);
  }

  return checked(Date.parse(text), raw);
}

function dayBoundary(y: number, mo: number, d: number, endOfDay?: boolean): number {
  const date = endOfDay ? new Date(y, mo - 1, d, 23, 59, 59, 999) : new Date(y, mo - 1, d);
  return sameDay(date, y, mo, d) ? date.getTime() : NaN;
}

function sameDay(date: Date, y: number, mo: number, d: number): boolean {
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

function checked(ts: number, raw: string): number {
  if (!Number.isFinite(ts)) {
    throw new Error(`无法识别的时间：${raw}（支持 2026-07-01、2026-07-01 18:30、7d / 12h、today 等）`);
  }
  return ts;
}
