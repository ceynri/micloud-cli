import { getDateTokens, sanitizeFileName } from "./utils.js";
import type { Recording } from "./types.js";

/** 缺省文件名模板：沿用手机上的录音文件名 */
export const DEFAULT_FILE_NAME_TEMPLATE = "${title}";

/** 模板可用的占位符 → 取值 */
export function templateVars(r: Recording): Record<string, string> {
  const t = getDateTokens(r.recordedAt);
  return {
    YYYY: t.YYYY,
    YY: t.YY,
    MM: t.MM,
    DD: t.DD,
    HH: t.HH,
    mm: t.mm,
    ss: t.ss,
    title: r.title,
    id: r.id,
    type: r.type,
    typeName: r.typeName,
    duration: String(r.duration),
    contact: r.contactName ?? r.phoneNumber ?? "",
    phone: r.phoneNumber ?? "",
    app: r.appName ?? "",
  };
}

/**
 * 渲染文件名模板，返回相对拉取目录的路径（`/` 分隔、不含扩展名）。
 *
 * - `${var}` 占位符见 templateVars；未识别的原样保留
 * - 条件段 `[...]`：段内所有 `${var}` 都非空才渲染，否则整段（含分隔符）丢弃；不支持嵌套；字面 `[` `]` 用 `\[` `\]`
 * - `/` 分隔子目录；每段单独清理非法字符，空段与 `.` / `..` 段被丢弃，无法逃出拉取目录
 * - 渲染为空时回退到 `<录音时间>_<id>`
 */
export function renderFileName(template: string, r: Recording): string {
  const vars = templateVars(r);
  const ESC_OPEN = "\u0000";
  const ESC_CLOSE = "\u0001";
  let s = template.replace(/\\\[/g, ESC_OPEN).replace(/\\\]/g, ESC_CLOSE);

  s = s.replace(/\[([^\[\]]*)\]/g, (_, segment: string) => {
    let allFilled = true;
    const rendered = segment.replace(/\$\{(\w+)\}/g, (m, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) return m;
      const v = vars[key];
      if (!v) allFilled = false;
      return v.replace(/[/\\]/g, "_");
    });
    return allFilled ? rendered : "";
  });

  // 变量值里的斜杠不能被当成目录分隔符，先替换掉
  s = s.replace(/\$\{(\w+)\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key].replace(/[/\\]/g, "_") : m,
  );
  s = s.replace(new RegExp(ESC_OPEN, "g"), "[").replace(new RegExp(ESC_CLOSE, "g"), "]");

  const segments = s
    .split(/[/\\]/)
    .map((seg) => sanitizeFileName(seg))
    .filter((seg) => seg.length > 0);
  if (segments.length > 0) return segments.join("/");

  const t = getDateTokens(r.recordedAt);
  return `${t.YYYY}-${t.MM}-${t.DD}_${t.HH}-${t.mm}-${t.ss}_${r.id}`;
}

/** 录音落盘的相对路径（含扩展名）；suffix 加在文件名主体之后、扩展名之前（同名冲突时用 `_<id>`） */
export function recordingRelPath(template: string, r: Recording, suffix = ""): string {
  const base = renderFileName(template, r) + suffix;
  return r.extension ? `${base}.${r.extension}` : base;
}

/** 路径比较键：大小写与 Unicode 规范化不敏感（macOS / Windows 默认文件系统如此） */
export function pathKey(relPath: string): string {
  return relPath.normalize("NFC").toLowerCase();
}
