import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peekOrRefreshAuth, refreshAuth } from "../src/auth.ts";
import { MiRecordingClient } from "../src/client.ts";
import { pullRecordings } from "../src/pull.ts";
import { loadState } from "../src/config.ts";
import { parseRecording } from "../src/recording.ts";
import type { Recording } from "../src/types.ts";

/**
 * 真实 API 集成测试（需要有效登录态）。
 *
 * 运行：pnpm test:integration
 *
 * 读操作随意；写操作只有「把一条录音移到回收站 → 立刻恢复」的可逆往返，
 * 且仅在设置 MI_RECORDING_CLI_TEST_ID=<录音 id> 时执行（建议选一条无关紧要的短录音）。
 * 不做永久删除。注意：删除会同步到手机，恢复后手机端会随之恢复。
 */

const ENABLED = process.env.MI_RECORDING_CLI_INTEGRATION === "1";
const ROUNDTRIP_ID = process.env.MI_RECORDING_CLI_TEST_ID;
/** 下载测试的体积上限，避免拉取大文件 */
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;

let client: MiRecordingClient | null = null;
let authError: string | null = null;

before(async () => {
  if (!ENABLED) return;
  const auth = await peekOrRefreshAuth();
  if (!auth) {
    authError = "无有效登录态。请先运行 mi-recording-cli login";
    return;
  }
  client = new MiRecordingClient(auth, refreshAuth);
});

function skipIfUnavailable(t: { skip: (msg?: string) => void }): boolean {
  if (!ENABLED) {
    t.skip("设置 MI_RECORDING_CLI_INTEGRATION=1 以启用真实 API 集成测试");
    return true;
  }
  if (!client) {
    t.skip(authError ?? "无有效登录态，跳过集成测试");
    return true;
  }
  return false;
}

async function smallest(): Promise<Recording | undefined> {
  const list = (await client!.listRecordings()).map(parseRecording);
  return list.filter((r) => r.size > 0 && r.size <= MAX_DOWNLOAD_BYTES).sort((a, b) => a.size - b.size)[0];
}

test("集成：列表、回收站、空间与账号信息", async (t) => {
  if (skipIfUnavailable(t)) return;
  const raws = await client!.listRecordings();
  assert.ok(Array.isArray(raws));
  const list = raws.map(parseRecording);
  for (const r of list) {
    assert.ok(r.id && r.sha1 && r.size >= 0, `录音字段完整：${r.id}`);
    assert.ok(r.recordedAt > 0, `录音时间可解析：${r.rawName}`);
  }
  const trash = await client!.listTrash();
  assert.ok(Array.isArray(trash));
  const quota = await client!.getQuota();
  assert.equal(typeof quota.totalQuota, "number");
  const profile = await client!.getProfile();
  assert.equal(typeof profile, "object");
  console.error(`  → ${list.length} 条录音，回收站 ${trash.length} 条`);
});

test("集成：pull 最小的一条录音，校验内容并验证增量跳过", async (t) => {
  if (skipIfUnavailable(t)) return;
  const target = await smallest();
  if (!target) {
    t.skip("没有 5MB 以内的录音可供下载测试");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "mi-recording-integration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const opts = { outputDir: dir, template: "${id}", concurrency: 1, filter: { match: target.id }, quiet: true };

  const first = await pullRecordings(client!, opts);
  assert.equal(first.failed.length, 0, JSON.stringify(first.failed));
  assert.equal(first.pulled.length, 1);
  const content = await readFile(first.pulled[0].file);
  assert.equal(createHash("sha1").update(content).digest("hex"), target.sha1);
  assert.equal((await loadState(dir)).recordings[target.id].sha1, target.sha1);

  const second = await pullRecordings(client!, opts);
  assert.equal(second.pulled.length, 0);
  assert.equal(second.alreadyPulled, 1);
});

test("集成：不存在的录音给出明确错误", async (t) => {
  if (skipIfUnavailable(t)) return;
  await assert.rejects(() => client!.getDownloadUrl("1"), /录音不存在/);
});

test("集成：删除 → 回收站 → 恢复往返（仅设置 MI_RECORDING_CLI_TEST_ID 时）", async (t) => {
  if (skipIfUnavailable(t)) return;
  if (!ROUNDTRIP_ID) {
    t.skip("设置 MI_RECORDING_CLI_TEST_ID=<录音 id> 以启用可逆的删除/恢复往返测试");
    return;
  }
  const before = (await client!.listRecordings()).find((r) => r.id === ROUNDTRIP_ID);
  assert.ok(before, `云端没有录音 ${ROUNDTRIP_ID}`);

  await client!.deleteRecording(ROUNDTRIP_ID);
  let restored = false;
  try {
    assert.ok(!(await client!.listRecordings()).some((r) => r.id === ROUNDTRIP_ID), "删除后不在列表中");
    const trashed = (await client!.listTrash()).find((r) => r.id === ROUNDTRIP_ID);
    assert.ok(trashed, "删除后出现在回收站");
    assert.notEqual(trashed.ver, before.ver, "删除会让 ver 变化");
    await client!.recoverRecording(trashed.id, trashed.ver);
    restored = true;
  } finally {
    if (!restored) {
      // 断言失败也要尽力恢复，绝不把录音留在回收站
      const trashed = (await client!.listTrash()).find((r) => r.id === ROUNDTRIP_ID);
      if (trashed) await client!.recoverRecording(trashed.id, trashed.ver);
    }
  }
  const after = (await client!.listRecordings()).find((r) => r.id === ROUNDTRIP_ID);
  assert.ok(after, "恢复后回到列表");
  assert.equal(after.sha1, before.sha1);
});
