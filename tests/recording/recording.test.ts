import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchesFilter,
  parseChineseTime,
  parseRawName,
  parseRecording,
  parseTrashedRecording,
  parseTypes,
  shortTypeName,
  sortByRecordedAt,
} from "../src/recording.ts";
import type { RawRecording } from "../src/types.ts";

/** 本地时间 → 毫秒 */
function local(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function raw(name: string, extra: Partial<RawRecording> = {}): RawRecording {
  return {
    id: "1",
    ver: "1",
    sha1: "ABCDEF",
    size: 1000,
    name,
    type: "file",
    parent_id: "0",
    create_time: local(2026, 7, 2, 17, 0),
    modify_time: local(2026, 7, 2, 17, 0),
    extraInfo: "",
    ...extra,
  };
}

test("parseRawName：拆出标题、扩展名、时长、类型码、文件时间", () => {
  const parts = parseRawName("2026年07月02日 16点04分.mp3_3536_0_1782982976700_1782983001427");
  assert.deepEqual(parts, {
    base: "2026年07月02日 16点04分",
    extension: "mp3",
    duration: 3536,
    typeCode: 0,
    fileTime: 1782982976700,
  });
});

test("parseRawName：标题里带点号与下划线也能正确拆分", () => {
  const parts = parseRawName("微信录音 A   某某公寓&管家13800000000_20260326110044.aac_1002_3_1774495047221_1774516341054");
  assert.equal(parts.base, "微信录音 A   某某公寓&管家13800000000_20260326110044");
  assert.equal(parts.extension, "aac");
  assert.equal(parts.duration, 1002);
  assert.equal(parts.typeCode, 3);

  const dotted = parseRawName("v1.2 会议.m4a_60_0_1782982976700_1782983001427");
  assert.equal(dotted.base, "v1.2 会议");
  assert.equal(dotted.extension, "m4a");
});

test("parseRawName：没有时长段的旧格式与无法识别的名字", () => {
  const legacy = parseRawName("通话.mp3_1_1782982976700_1782983001427");
  assert.equal(legacy.duration, null);
  assert.equal(legacy.typeCode, 1);
  assert.equal(legacy.fileTime, 1782982976700);

  const plain = parseRawName("随便.amr");
  assert.deepEqual(plain, { base: "随便", extension: "amr", duration: null, typeCode: -1, fileTime: null });

  const weird = parseRawName("no-extension");
  assert.equal(weird.base, "no-extension");
  assert.equal(weird.extension, "");
});

test("parseRecording：录音机录音的时间取「文件时间 - 时长」以保留秒", () => {
  const end = local(2026, 7, 2, 17, 2, 56, );
  const r = parseRecording(raw(`2026年07月02日 16点04分.mp3_3536_0_${end}_${end + 1000}`, { id: "42" }));
  assert.equal(r.id, "42");
  assert.equal(r.type, "recorder");
  assert.equal(r.typeName, "录音机录音");
  assert.equal(r.title, "2026年07月02日 16点04分");
  assert.equal(r.fileName, "2026年07月02日 16点04分.mp3");
  assert.equal(r.duration, 3536);
  assert.equal(r.durationEstimated, false);
  assert.equal(r.recordedAt, end - 3536 * 1000);
  assert.equal(new Date(r.recordedAt).getMinutes(), 4);
  assert.equal(r.endedAt, end);
  assert.equal(r.sha1, "abcdef", "sha1 统一小写");
});

test("parseRecording：录音中途暂停过时（文件时间 - 时长 偏晚），以标题时间为准", () => {
  const end = local(2026, 5, 31, 19, 39, 14);
  const r = parseRecording(raw(`2026年05月31日 17点49分.mp3_463_0_${end}_${end + 1000}`));
  assert.equal(r.recordedAt, local(2026, 5, 31, 17, 49));
});

test("parseRecording：缺年份的旧标题按文件时间推断年份；带上下午的标题换算 24 小时制", () => {
  const end = local(2023, 9, 28, 13, 3, 46);
  const a = parseRecording(raw(`9月28日 14点01分 某某车站.mp3_131_0_${end}_${end}`));
  // 标题时间晚于文件时间（异地时区录制），不可信，退回文件时间 - 时长
  assert.equal(a.recordedAt, end - 131_000);

  const end2 = local(2025, 6, 28, 0, 46, 14);
  const b = parseRecording(raw(`2025年06月27日 下午11点06分.m4a_5981_0_${end2}_${end2}`));
  assert.equal(new Date(b.recordedAt).getHours(), 23);
  assert.equal(new Date(b.recordedAt).getDate(), 27);
});

test("parseRecording：应用录音解析来源应用与对方，时间取标题时间戳", () => {
  const end = local(2026, 7, 11, 14, 6, 12);
  const r = parseRecording(
    raw(`微信录音 小王_20260711131118.aac_3294_3_${end}_${end}`, {
      extraInfo: '{"mark": "","time": 0,"appType": 1,"appTypeTime": 1783784436805}',
    }),
  );
  assert.equal(r.type, "app");
  assert.equal(r.appName, "微信");
  assert.equal(r.contactName, "小王");
  assert.equal(r.recordedAt, local(2026, 7, 11, 13, 11, 18));
  assert.equal(shortTypeName(r), "微信");
  assert.deepEqual(r.extraInfo, { mark: "", time: 0, appType: 1, appTypeTime: 1783784436805 });

  const wecom = parseRecording(raw(`企业微信录音_20260714160146.aac_162_3_${end}_${end}`));
  assert.equal(wecom.appName, "企业微信");
  assert.equal(wecom.contactName, undefined);
});

test("parseRecording：通话录音解析联系人与号码", () => {
  const end = local(2026, 3, 1, 10, 5);
  const named = parseRecording(raw(`张三(13800138000)_20260301100000.mp3_300_1_${end}_${end}`));
  assert.equal(named.type, "phonecall");
  assert.equal(named.contactName, "张三");
  assert.equal(named.phoneNumber, "13800138000");
  assert.equal(named.recordedAt, local(2026, 3, 1, 10, 0, 0));

  const numberOnly = parseRecording(raw(`abc@10086_20260301100000.mp3_60_1_${end}_${end}`));
  assert.equal(numberOnly.phoneNumber, "10086");
  assert.equal(numberOnly.contactName, undefined);
});

test("parseRecording：名字里没有时长时按码率估算", () => {
  const end = local(2026, 3, 1, 10, 5);
  const r = parseRecording(raw(`通话.mp3_1_${end}_${end}`, { size: 8000 * 60 / 8 }));
  assert.equal(r.durationEstimated, true);
  assert.equal(r.duration, 60);
});

test("parseRecording：未知类型码归入录音机，非法 extraInfo 被忽略", () => {
  const end = local(2026, 3, 1, 10, 5);
  const r = parseRecording(raw(`x.mp3_10_9_${end}_${end}`, { extraInfo: "{oops" }));
  assert.equal(r.type, "recorder");
  assert.equal(r.typeCode, 9);
  assert.equal(r.extraInfo, undefined);
});

test("parseTrashedRecording：删除时间取 modify_time，按保留天数推算清除时间", () => {
  const deletedAt = local(2026, 11, 15, 2, 17);
  const r = parseTrashedRecording(raw("x.mp3_10_0_1782982976700_1782983001427", { modify_time: deletedAt }), 30);
  assert.equal(r.deletedAt, deletedAt);
  assert.equal(r.expiresAt, deletedAt + 30 * 86_400_000);
  assert.equal(parseTrashedRecording(raw("x.mp3", { modify_time: deletedAt })).expiresAt, undefined);
});

test("parseChineseTime：中文时间与时段", () => {
  const ref = local(2026, 7, 2, 18, 0);
  assert.equal(parseChineseTime("2026年07月02日 16点04分", ref), local(2026, 7, 2, 16, 4));
  assert.equal(parseChineseTime("7月2日 16点04分", ref), local(2026, 7, 2, 16, 4));
  assert.equal(parseChineseTime("2025年06月27日 下午11点06分", ref), local(2025, 6, 27, 23, 6));
  assert.equal(parseChineseTime("2025年06月27日 上午12点06分", ref), local(2025, 6, 27, 0, 6));
  // 缺年份且落在参考时间之后 → 上一年
  assert.equal(parseChineseTime("12月31日 23点00分", local(2026, 1, 1, 0, 10)), local(2025, 12, 31, 23, 0));
  assert.equal(parseChineseTime("没有时间", ref), null);
  assert.equal(parseChineseTime("2026年02月30日 10点00分", ref), null);
});

test("matchesFilter：类型、时间区间、关键词（全部命中、忽略大小写）", () => {
  const end = local(2026, 7, 11, 14, 6, 12);
  const r = parseRecording(raw(`微信录音 Alice_20260711131118.aac_3294_3_${end}_${end}`, { id: "9" }));
  assert.ok(matchesFilter(r, {}));
  assert.ok(matchesFilter(r, { types: ["app"] }));
  assert.ok(!matchesFilter(r, { types: ["recorder", "phonecall"] }));
  assert.ok(matchesFilter(r, { since: local(2026, 7, 11), until: local(2026, 7, 11, 23, 59) }));
  assert.ok(!matchesFilter(r, { since: local(2026, 7, 12) }));
  assert.ok(!matchesFilter(r, { until: local(2026, 7, 10) }));
  assert.ok(matchesFilter(r, { match: "alice 微信" }));
  assert.ok(!matchesFilter(r, { match: "alice 企业" }));
  assert.ok(matchesFilter(r, { match: "9" }), "可按 id 匹配");
});

test("parseTypes：逗号分隔，拒绝未知类型", () => {
  assert.deepEqual(parseTypes("recorder, App"), ["recorder", "app"]);
  assert.throws(() => parseTypes("video"), /未知的录音类型/);
});

test("sortByRecordedAt：按录音时间排序，同时间按 id 稳定", () => {
  const items = [
    { id: "b", recordedAt: 2 },
    { id: "a", recordedAt: 2 },
    { id: "c", recordedAt: 1 },
  ];
  assert.deepEqual(sortByRecordedAt(items, "desc").map((i) => i.id), ["b", "a", "c"]);
  assert.deepEqual(sortByRecordedAt(items, "asc").map((i) => i.id), ["c", "a", "b"]);
});
