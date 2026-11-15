import { dateVars, renderTemplate } from "../core/template.js";
import { formatDateTime, sanitizeFileName } from "../core/utils.js";
import type { Recording } from "./types.js";

/** 缺省文件名模板：沿用手机上的录音文件名 */
export const DEFAULT_FILE_NAME_TEMPLATE = "${title}";

/** 模板可用的占位符 → 取值 */
export function templateVars(r: Recording): Record<string, string> {
  return {
    ...dateVars(r.recordedAt),
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
 * - 占位符见 templateVars，语法（含条件段 `[...]`）见 core/template.ts
 * - `/` 分隔子目录；变量值里的斜杠不会变成目录；每段单独清理非法字符，空段与 `.` / `..` 段被丢弃，无法逃出拉取目录
 * - 渲染为空时回退到 `<录音时间>_<id>`
 */
export function renderFileName(template: string, r: Recording): string {
  const rendered = renderTemplate(template, templateVars(r), (v) => v.replace(/[/\\]/g, "_"));
  const segments = rendered
    .split(/[/\\]/)
    .map((seg) => sanitizeFileName(seg))
    .filter((seg) => seg.length > 0);
  if (segments.length > 0) return segments.join("/");
  return `${formatDateTime(r.recordedAt)}_${r.id}`;
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
