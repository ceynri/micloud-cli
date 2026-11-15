import { getDateTokens } from "./utils.js";

/**
 * 文件名模板引擎（笔记与录音共用；可用的变量由各服务提供）。
 *
 * - `${var}` 替换为 vars 中的值；未识别的变量原样保留
 * - 条件段 `[...]`：段内所有已知 `${var}` 都非空才渲染，否则整段（含分隔符）丢弃；不支持嵌套；
 *   未闭合的 `[` 按字面保留；字面 `[` `]` 用 `\[` `\]`
 * - transform 用于加工替换进来的变量值（如把值里的 `/` 换掉，避免被当成目录分隔符）
 *
 * 不做文件名清理，调用方按需 sanitize。
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
  transform: (value: string) => string = (v) => v,
): string {
  // 用 NUL/SOH 哨兵临时替换 `\[` `\]` 转义，避免被条件段解析器误吞（这两个控制字符不会出现在模板里）
  const ESC_OPEN = "\u0000";
  const ESC_CLOSE = "\u0001";
  const lookup = (key: string): string | undefined =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : undefined;

  let s = template.replace(/\\\[/g, ESC_OPEN).replace(/\\\]/g, ESC_CLOSE);

  s = s.replace(/\[([^\[\]]*)\]/g, (_, segment: string) => {
    let allFilled = true;
    const rendered = segment.replace(/\$\{(\w+)\}/g, (m, key: string) => {
      const v = lookup(key);
      if (v === undefined) return m;
      if (!v) allFilled = false;
      return transform(v);
    });
    return allFilled ? rendered : "";
  });

  s = s.replace(/\$\{(\w+)\}/g, (m, key: string) => {
    const v = lookup(key);
    return v === undefined ? m : transform(v);
  });

  return s.replace(new RegExp(ESC_OPEN, "g"), "[").replace(new RegExp(ESC_CLOSE, "g"), "]");
}

/** 时间占位符 `${YYYY}` `${YY}` `${MM}` `${DD}` `${HH}` `${mm}` `${ss}`（本地时区） */
export function dateVars(ts: number): Record<string, string> {
  return { ...getDateTokens(ts) };
}
