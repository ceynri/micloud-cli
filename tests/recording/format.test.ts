import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTimeInput } from "../../src/recording/dates.ts";
import { recordingRelPath, renderFileName, pathKey } from "../../src/recording/template.ts";
import { parseRecording } from "../../src/recording/recording.ts";
import {
  formatBytes,
  formatDuration,
  sanitizeFileName,
  truncateDisplay,
  truncateUtf8,
  displayWidth,
} from "../../src/core/utils.ts";

function local(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
}

const end = local(2026, 7, 11, 14, 6, 12);
const wechat = parseRecording({
  id: "10000000000000003",
  ver: "1",
  sha1: "x",
  size: 1,
  name: `微信录音 小王_20260711131118.aac_3294_3_${end}_${end}`,
  create_time: end,
  modify_time: end,
  extraInfo: '{"appType": 1}',
});
const recorderEnd = local(2026, 7, 2, 17, 2, 56);
const recorder = parseRecording({
  id: "10000000000000004",
  ver: "1",
  sha1: "x",
  size: 1,
  name: `2026年07月02日 16点04分.mp3_3536_0_${recorderEnd}_${recorderEnd}`,
  create_time: recorderEnd,
  modify_time: recorderEnd,
});

test("parseTimeInput：日期、日期时间、紧凑日期", () => {
  assert.equal(parseTimeInput("2026-07-01"), local(2026, 7, 1));
  assert.equal(parseTimeInput("2026/7/1"), local(2026, 7, 1));
  assert.equal(parseTimeInput("20260701"), local(2026, 7, 1));
  assert.equal(parseTimeInput("2026-07-01", { endOfDay: true }), local(2026, 7, 1, 23, 59, 59, 999));
  assert.equal(parseTimeInput("2026-07-01 18:30"), local(2026, 7, 1, 18, 30));
  assert.equal(parseTimeInput("2026-07-01T18:30:05"), local(2026, 7, 1, 18, 30, 5));
  assert.equal(parseTimeInput("2026-07-01 18:30", { endOfDay: true }), local(2026, 7, 1, 18, 30));
  assert.equal(parseTimeInput("2026-07-01T10:00:00Z"), Date.UTC(2026, 6, 1, 10));
});

test("parseTimeInput：相对时间、today / yesterday、时间戳", () => {
  const now = local(2026, 7, 10, 12, 0);
  assert.equal(parseTimeInput("7d", { now }), now - 7 * 86_400_000);
  assert.equal(parseTimeInput("12h", { now }), now - 12 * 3_600_000);
  assert.equal(parseTimeInput("2w", { now }), now - 14 * 86_400_000);
  assert.equal(parseTimeInput("today", { now }), local(2026, 7, 10));
  assert.equal(parseTimeInput("yesterday", { now, endOfDay: true }), local(2026, 7, 9, 23, 59, 59, 999));
  assert.equal(parseTimeInput("1782982976700"), 1782982976700);
  assert.equal(parseTimeInput("1782982976"), 1782982976000);
});

test("parseTimeInput：非法输入报错", () => {
  assert.throws(() => parseTimeInput("next week"), /无法识别的时间/);
  assert.throws(() => parseTimeInput("2026-02-30"), /无法识别的时间/);
  assert.throws(() => parseTimeInput("2026-07-01 25:00"), /无法识别的时间/);
});

test("renderFileName：默认模板沿用手机文件名", () => {
  assert.equal(renderFileName("${title}", wechat), "微信录音 小王_20260711131118");
  assert.equal(recordingRelPath("${title}", wechat), "微信录音 小王_20260711131118.aac");
});

test("renderFileName：时间占位符取录音开始时间，支持子目录", () => {
  assert.equal(
    renderFileName("${typeName}/${YYYY}-${MM}/${YYYY}${MM}${DD}_${HH}${mm}${ss}", wechat),
    "应用录音/2026-07/20260711_131118",
  );
  assert.equal(renderFileName("${YY}-${MM}-${DD} ${HH}.${mm}", recorder), "26-07-02 16.04");
});

test("renderFileName：条件段在变量为空时整段消失", () => {
  const tpl = "${YYYY}-${MM}-${DD}_${HH}${mm}[_${contact}][_${app}]";
  assert.equal(renderFileName(tpl, wechat), "2026-07-11_1311_小王_微信");
  assert.equal(renderFileName(tpl, recorder), "2026-07-02_1604");
  assert.equal(renderFileName("\\[${type}\\] ${title}", recorder), "[recorder] 2026年07月02日 16点04分");
});

test("renderFileName：变量里的斜杠不会变成目录，.. 段被丢弃，空结果回退", () => {
  const tricky = { ...recorder, title: "a/b\\c" };
  assert.equal(renderFileName("${title}", tricky), "a_b_c");
  assert.equal(renderFileName("../${id}", recorder), "10000000000000004");
  assert.equal(renderFileName("/./x/../y/", recorder), "x/y");
  // 录音开始时间 = 17:02:56 - 58:56 = 16:04:00
  assert.equal(renderFileName("[${contact}]", recorder), "2026-07-02_16-04-00_10000000000000004");
  assert.equal(renderFileName("${unknown}", recorder), "${unknown}");
});

test("recordingRelPath：冲突后缀加在扩展名之前；没有扩展名时标题里的点号不被当成扩展名 / pathKey", () => {
  assert.equal(recordingRelPath("${typeName}/${title}", wechat, "_42"), "应用录音/微信录音 小王_20260711131118_42.aac");
  const dotted = { ...recorder, title: "v1.2 会议", extension: "" };
  assert.equal(recordingRelPath("${title}", dotted, "_42"), "v1.2 会议_42");
  assert.equal(pathKey("A/录音.MP3"), pathKey("a/录音.mp3"));
});

test("sanitizeFileName：清理非法字符并按 UTF-8 字节截断", () => {
  assert.equal(sanitizeFileName('a<b>:"c"|d?*'), "a_b___c__d__");
  assert.equal(sanitizeFileName("  ..名字. "), "名字");
  const long = "录".repeat(100);
  const cut = sanitizeFileName(long);
  assert.ok(Buffer.byteLength(cut) <= 200);
  assert.equal(cut, "录".repeat(66));
  assert.equal(truncateUtf8("ab录", 4), "ab");
});

test("格式化：体积、时长、显示宽度", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(20160), "19.7 KB");
  assert.equal(formatBytes(3612672), "3.45 MB");
  assert.equal(formatBytes(4183396050), "3.90 GB");
  assert.equal(formatDuration(1), "0:01");
  assert.equal(formatDuration(3536), "58:56");
  assert.equal(formatDuration(167559), "46:32:39");
  assert.equal(displayWidth("录音a"), 5);
  assert.equal(truncateDisplay("一二三四五", 6), "一二三…");
  assert.equal(truncateDisplay("a\nb", 10), "a b");
});
