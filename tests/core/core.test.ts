import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTemplate } from "../../src/core/template.ts";
import { MiCloudHttp, MiApiError, AuthExpiredError, unwrapEnvelope } from "../../src/core/http.ts";
import { getConfigPath, loadSection, saveSection, resolveOutputPath } from "../../src/core/config.ts";
import { finishBatch, setJsonMode, EXIT_PARTIAL_FAILURE } from "../../src/core/output.ts";
import { buildWhoami } from "../../src/commands/account.ts";
import type { AuthInfo } from "../../src/core/auth.ts";

const OLD_AUTH: AuthInfo = { cookie: "serviceToken=old; userId=u", serviceToken: "old", userId: "u" };
const NEW_AUTH: AuthInfo = { cookie: "serviceToken=new; userId=u", serviceToken: "new", userId: "u" };

function mockFetch(t: { after: (fn: () => void) => void }, impl: (url: string, init?: RequestInit) => Response): string[] {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    return impl(String(input), init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return urls;
}

async function withProjectRoot(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "micloud-core-"));
  const prev = process.env.MICLOUD_CONFIG_DIR;
  process.env.MICLOUD_CONFIG_DIR = root;
  t.after(async () => {
    if (prev === undefined) delete process.env.MICLOUD_CONFIG_DIR;
    else process.env.MICLOUD_CONFIG_DIR = prev;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

/** 捕获 stdout 输出与退出码 */
function captureOutput(t: { after: (fn: () => void) => void }): { out: string[] } {
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const prevExitCode = process.exitCode;
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = write;
    process.exitCode = prevExitCode;
    setJsonMode(false);
  });
  return { out };
}

// ============ 文件名模板 ============

test("renderTemplate：占位符、条件段、转义与未知变量", () => {
  const vars = { a: "1", b: "", c: "x/y" };
  assert.equal(renderTemplate("${a}-${c}", vars), "1-x/y");
  assert.equal(renderTemplate("${a}[_${b}][_${a}]", vars), "1_1");
  assert.equal(renderTemplate("\\[${a}\\] ${unknown}", vars), "[1] ${unknown}");
  assert.equal(renderTemplate("[${unknown}]", vars), "${unknown}", "未知变量不算空，条件段保留");
  assert.equal(renderTemplate("${c}", vars, (v) => v.replace(/\//g, "_")), "x_y", "transform 只作用于变量值");
});

// ============ 请求层 ============

test("MiCloudHttp：401 后静默续期并用新登录态重试；POST body 带新的 serviceToken", async (t) => {
  const bodies: string[] = [];
  mockFetch(t, (_url, init) => {
    const cookie = (init?.headers as Record<string, string>).Cookie;
    if (init?.method === "POST") bodies.push(String(init.body));
    return cookie === OLD_AUTH.cookie ? new Response("", { status: 401 }) : Response.json({ code: 0, data: {} });
  });
  let refreshed = 0;
  const http = new MiCloudHttp(OLD_AUTH, async () => {
    refreshed++;
    return NEW_AUTH;
  });
  await http.postForm("/x", { a: "1" });
  assert.equal(refreshed, 1);
  assert.match(bodies[0], /serviceToken=old/);
  assert.match(bodies[1], /a=1&serviceToken=new/);
  await http.getJson("/y");
  assert.equal(refreshed, 1, "续期后的登录态继续使用");
});

test("MiCloudHttp：续期失败时抛 AuthExpiredError；GET 遇 5xx 重试，POST 不重试", async (t) => {
  mockFetch(t, () => new Response("", { status: 401 }));
  await assert.rejects(() => new MiCloudHttp(OLD_AUTH, async () => null).getJson("/x"), AuthExpiredError);

  let calls = 0;
  mockFetch(t, () => (++calls === 1 ? new Response("bad", { status: 502 }) : Response.json({ ok: 1 })));
  assert.deepEqual(await new MiCloudHttp(OLD_AUTH).getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);

  calls = 0;
  mockFetch(t, () => {
    calls++;
    return new Response("bad", { status: 502 });
  });
  await assert.rejects(() => new MiCloudHttp(OLD_AUTH).postForm("/x"), MiApiError);
  assert.equal(calls, 1, "写操作不自动重试，避免重复提交");
});

test("unwrapEnvelope：服务特有错误码给出可读说明", () => {
  assert.throws(() => unwrapEnvelope({ code: 50202 }, { 50202: "录音不存在" }), /录音不存在/);
  assert.deepEqual(unwrapEnvelope({ result: "ok", data: { a: 1 } }), { a: 1 });
});

// ============ 项目配置 ============

test("项目配置按服务分节：写一节不影响另一节；output 相对项目根解析", async (t) => {
  const root = await withProjectRoot(t);
  await saveSection("recording", { output: "rec" });
  await saveSection("note", { syncMode: "two-way" });
  assert.deepEqual(JSON.parse(await readFile(getConfigPath(), "utf-8")), {
    recording: { output: "rec" },
    note: { syncMode: "two-way" },
  });
  assert.deepEqual(await loadSection("recording"), { output: "rec" });
  assert.equal(resolveOutputPath("recording", undefined, "rec"), join(root, "rec"));
  assert.equal(resolveOutputPath("recording", undefined, undefined), join(root, ".micloud", "recording"));
  assert.equal(resolveOutputPath("note", "/abs/dir", "ignored"), "/abs/dir");
});

test("项目配置：文件损坏时按空配置处理，旧版笔记配置只在笔记节缺失时生效", async (t) => {
  const root = await withProjectRoot(t);
  await mkdir(join(root, ".micloud"), { recursive: true });
  await writeFile(getConfigPath(), "{oops", "utf-8");
  assert.deepEqual(await loadSection("recording"), {});

  await mkdir(join(root, ".mi-note-cli"), { recursive: true });
  await writeFile(join(root, ".mi-note-cli", "config.json"), JSON.stringify({ syncMode: "manual" }), "utf-8");
  assert.deepEqual(await loadSection("note"), { syncMode: "manual" });
  assert.deepEqual(await loadSection("recording"), {}, "旧版配置只属于笔记");
  await saveSection("note", { syncMode: "two-way" });
  assert.deepEqual(await loadSection("note"), { syncMode: "two-way" }, "有笔记节后以它为准");
});

// ============ 批量结果与退出码 ============

test("finishBatch：全部成功退出码 0；部分失败 ok:true + 2；全部失败 ok:false + 1", (t) => {
  const { out } = captureOutput(t);
  setJsonMode(true);
  const parse = (): { ok: boolean; error?: string } => JSON.parse(out.pop()!);

  process.exitCode = undefined;
  finishBatch({ n: 1 }, { succeeded: 1, failed: [] }, () => {});
  assert.equal(parse().ok, true);
  assert.equal(process.exitCode, undefined);

  finishBatch({}, { succeeded: 1, failed: [{ error: "x" }] }, () => {});
  assert.equal(parse().ok, true);
  assert.equal(process.exitCode, EXIT_PARTIAL_FAILURE);

  process.exitCode = undefined;
  finishBatch({}, { succeeded: 2, failed: [], warnings: 1 }, () => {});
  assert.equal(process.exitCode, EXIT_PARTIAL_FAILURE, "有警告也算部分失败");

  finishBatch({}, { succeeded: 0, failed: [{ error: "网络错误" }, { error: "y" }] }, () => {});
  const failed = parse();
  assert.equal(failed.ok, false);
  assert.match(failed.error!, /全部 2 条失败，首条原因：网络错误/);
  assert.equal(process.exitCode, 1);
});

// ============ 账号 ============

test("buildWhoami：会员等级换算回收站天数，用量明细带上中文标签", () => {
  const data = buildWhoami("u1", { nickname: "n" }, {
    level: "FirstLevel",
    totalQuota: 100,
    used: 40,
    usedDetail: { Recorder: { size: 30, text: "录音备份" }, NoteSize: { size: 10 } },
  });
  assert.equal(data.levelName, "黄金会员");
  assert.equal(data.trashRetentionDays, 60);
  assert.deepEqual(data.quota, {
    total: 100,
    used: 40,
    usedDetail: { Recorder: { label: "录音备份", size: 30 }, NoteSize: { label: "NoteSize", size: 10 } },
  });
  assert.deepEqual(buildWhoami("u2"), { loggedIn: true, userId: "u2" });
});
