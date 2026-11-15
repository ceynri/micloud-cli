import { test } from "node:test";
import assert from "node:assert/strict";
import { MiRecordingClient } from "../../src/recording/client.ts";
import { MiApiError, unwrapEnvelope } from "../../src/core/http.ts";
import type { AuthInfo } from "../../src/core/auth.ts";
import type { RawRecording } from "../../src/recording/types.ts";

const OLD_AUTH: AuthInfo = { cookie: "serviceToken=old; userId=u", serviceToken: "old", userId: "u" };
const NEW_AUTH: AuthInfo = { cookie: "serviceToken=new; userId=u", serviceToken: "new", userId: "u" };

interface Call {
  url: string;
  method: string;
  cookie: string;
  body: string;
}

function mockFetch(t: { after: (fn: () => void) => void }, impl: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      cookie: String((init?.headers as Record<string, string> | undefined)?.Cookie ?? ""),
      body: String(init?.body ?? ""),
    };
    calls.push(call);
    return await impl(call);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function ok(data: unknown): Response {
  return Response.json({ result: "ok", retriable: false, code: 0, data, description: "成功", ts: 1 });
}

function item(id: string): RawRecording {
  return { id, ver: id, sha1: "s", size: 1, name: `${id}.mp3_1_0_1782982976700_1782983001427`, create_time: 1, modify_time: 1 };
}

test("GET 401 后静默续期并用新 cookie 重试", async (t) => {
  let refreshCount = 0;
  const calls = mockFetch(t, (call) =>
    call.cookie === OLD_AUTH.cookie ? new Response("expired", { status: 401 }) : ok({ list: [] }),
  );
  const client = new MiRecordingClient(OLD_AUTH, async () => {
    refreshCount++;
    return NEW_AUTH;
  });
  assert.deepEqual(await client.listRecordings(), []);
  assert.deepEqual(calls.map((c) => c.cookie), [OLD_AUTH.cookie, NEW_AUTH.cookie]);
  assert.equal(refreshCount, 1);
});

test("POST 重试时用续期后的 serviceToken 重建 body", async (t) => {
  const calls = mockFetch(t, (call) =>
    call.body.includes("serviceToken=old") ? new Response("expired", { status: 401 }) : ok({}),
  );
  const client = new MiRecordingClient(OLD_AUTH, async () => NEW_AUTH);
  await client.deleteRecording("42");
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/sfs\/ns\/recorder\/file\/42\/delete$/);
  assert.equal(calls[1].method, "POST");
  assert.match(calls[1].body, /permanent=false/);
  assert.match(calls[1].body, /serviceToken=new/);
});

test("refresher 失败时只重试一次并抛出登录态错误", async (t) => {
  const calls = mockFetch(t, () => new Response("expired", { status: 401 }));
  let refreshCount = 0;
  const client = new MiRecordingClient(OLD_AUTH, async () => {
    refreshCount++;
    return null;
  });
  await assert.rejects(() => client.listRecordings(), /登录态已过期/);
  assert.equal(calls.length, 1);
  assert.equal(refreshCount, 1);
});

test("录音列表按 offset 分页，单页不满即停止并去重", async (t) => {
  const page1 = Array.from({ length: 500 }, (_, i) => item(String(i)));
  const page2 = [item("499"), item("500")];
  const calls = mockFetch(t, (call) => {
    const offset = new URL(call.url).searchParams.get("offset");
    return ok({ list: offset === "0" ? page1 : page2 });
  });
  const client = new MiRecordingClient(OLD_AUTH);
  const all = await client.listRecordings();
  assert.equal(all.length, 501);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get("offset"), "500");
  assert.ok(new URL(calls[0].url).searchParams.get("ts"), "带 ts 防缓存");
});

test("回收站按 syncToken 分页，响应不再带 syncToken 即停止", async (t) => {
  const calls = mockFetch(t, (call) => {
    const token = new URL(call.url).searchParams.get("syncToken");
    return token === "" ? ok({ list: [item("1")], syncToken: "next" }) : ok({ list: [item("2")] });
  });
  const client = new MiRecordingClient(OLD_AUTH);
  const all = await client.listTrash();
  assert.deepEqual(all.map((r) => r.id), ["1", "2"]);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get("syncToken"), "next");
});

test("回收站恢复 / 永久删除使用 id 与 ver 拼路径", async (t) => {
  const calls = mockFetch(t, () => ok({}));
  const client = new MiRecordingClient(OLD_AUTH);
  await client.recoverRecording("1", "99");
  await client.purgeRecording("1", "100");
  assert.match(calls[0].url, /\/sfs\/ns\/recorder\/deleted\/1\/99\/recover$/);
  assert.match(calls[1].url, /\/sfs\/ns\/recorder\/deleted\/1\/100\/purge$/);
});

test("业务错误码转成可读错误；已知错误码给出明确提示", async (t) => {
  mockFetch(t, () =>
    Response.json({ result: "error", reason: "file not exist", retriable: false, code: 50202, description: "文件或目录不存在" }),
  );
  const client = new MiRecordingClient(OLD_AUTH);
  await assert.rejects(() => client.getDownloadUrl("123"), (err: unknown) => {
    assert.ok(err instanceof MiApiError);
    assert.equal(err.code, 50202);
    assert.match(err.message, /录音不存在/);
    return true;
  });
});

test("unwrapEnvelope：成功返回 data；未知错误码带上描述；308 提示区域", () => {
  assert.deepEqual(unwrapEnvelope({ code: 0, data: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrapEnvelope({ code: 0 }), {});
  assert.throws(() => unwrapEnvelope({ code: 10001, description: "参数错误" }), /10001：参数错误/);
  assert.throws(() => unwrapEnvelope({ code: 308, data: { redirectUrl: "https://us.i.mi.com/" } }), /其他区域/);
  assert.throws(() => unwrapEnvelope("nope"), MiApiError);
});

test("GET 遇 5xx 自动重试；非 JSON 响应给出可读错误", async (t) => {
  let n = 0;
  mockFetch(t, () => (++n === 1 ? new Response("bad gateway", { status: 502 }) : ok({ list: [item("1")] })));
  const client = new MiRecordingClient(OLD_AUTH);
  assert.equal((await client.listRecordings()).length, 1);
  assert.equal(n, 2);
});

test("非 JSON 响应重试耗尽后报可读错误", async (t) => {
  mockFetch(t, () => new Response("<html>oops</html>", { status: 200 }));
  const client = new MiRecordingClient(OLD_AUTH);
  await assert.rejects(() => client.getQuota(), /非 JSON 响应/);
});
