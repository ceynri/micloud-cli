import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { downloadToFile, downloadToStream, fetchRecording, IntegrityError, urlExpiresAt, E2EE_MESSAGE } from "../src/download.ts";
import { downloadRecordings, pullRecordings, planTargets, selectPulled, type TransferClient } from "../src/pull.ts";
import { lockOutputDir, loadState } from "../src/config.ts";
import { selectTrashTargets } from "../src/commands/trash.ts";
import { parseRecording, parseTrashedRecording } from "../src/recording.ts";
import { sanitizeFileName } from "../src/utils.ts";
import { PassThrough } from "node:stream";
import { AuthExpiredError } from "../src/client.ts";
import type { RawRecording } from "../src/types.ts";

const sha1 = (buf: Buffer): string => createHash("sha1").update(buf).digest("hex");

interface FileServer {
  base: string;
  hits: { path: string; range?: string }[];
  close: () => Promise<void>;
}

/** 本地 HTTP 文件服务：支持 Range；可按路径注入故障 */
async function startServer(
  files: Record<string, Buffer>,
  opts: { failFirst?: Record<string, number>; ignoreRange?: boolean; badRange?: boolean } = {},
): Promise<FileServer> {
  const hits: FileServer["hits"] = [];
  const failures = { ...(opts.failFirst ?? {}) };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    hits.push({ path, range: req.headers.range });
    if (failures[path]) {
      failures[path]--;
      res.writeHead(403).end("expired");
      return;
    }
    const body = files[path];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (m && opts.badRange) {
      // 答非所问：返回 206 但从 0 开始
      res.writeHead(206, { "Content-Range": `bytes 0-${body.length - 1}/${body.length}` });
      res.end(body);
      return;
    }
    if (m && !opts.ignoreRange) {
      const start = Number(m[1]);
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`,
        "Content-Length": String(body.length - start),
      });
      res.end(body.subarray(start));
      return;
    }
    res.writeHead(200, { "Content-Length": String(body.length) });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mi-recording-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const AUDIO = Buffer.from(Array.from({ length: 50_000 }, (_, i) => (i * 7) % 251));

test("downloadToFile：写 .part 校验通过后改名，进度单调到达总大小", async (t) => {
  const srv = await startServer({ "/a": AUDIO });
  t.after(srv.close);
  const dir = await tempDir(t);
  const dest = join(dir, "sub", "a.mp3");
  const progress: number[] = [];
  await downloadToFile(`${srv.base}/a`, dest, { size: AUDIO.length, sha1: sha1(AUDIO) }, (b) => progress.push(b));
  assert.deepEqual(await readFile(dest), AUDIO);
  assert.deepEqual(await readdir(join(dir, "sub")), ["a.mp3"]);
  assert.equal(progress.at(-1), AUDIO.length);
  assert.ok(progress.every((v, i) => i === 0 || v >= progress[i - 1]));
});

test("downloadToFile：已有 .part 时用 Range 续传", async (t) => {
  const srv = await startServer({ "/a": AUDIO });
  t.after(srv.close);
  const dir = await tempDir(t);
  const dest = join(dir, "a.mp3");
  await writeFile(`${dest}.part`, AUDIO.subarray(0, 12_345));
  await downloadToFile(`${srv.base}/a`, dest, { size: AUDIO.length, sha1: sha1(AUDIO) });
  assert.deepEqual(await readFile(dest), AUDIO);
  assert.equal(srv.hits[0].range, "bytes=12345-");
});

test("downloadToFile：服务端忽略 Range 时从头下载", async (t) => {
  const srv = await startServer({ "/a": AUDIO }, { ignoreRange: true });
  t.after(srv.close);
  const dir = await tempDir(t);
  const dest = join(dir, "a.mp3");
  await writeFile(`${dest}.part`, AUDIO.subarray(0, 100));
  await downloadToFile(`${srv.base}/a`, dest, { size: AUDIO.length, sha1: sha1(AUDIO) });
  assert.deepEqual(await readFile(dest), AUDIO);
});

test("downloadToFile：续传得到起点不符的 206 时丢弃 .part 从头下载", async (t) => {
  const srv = await startServer({ "/a": AUDIO }, { badRange: true });
  t.after(srv.close);
  const dir = await tempDir(t);
  const dest = join(dir, "a.mp3");
  await writeFile(`${dest}.part`, AUDIO.subarray(0, 100));
  await downloadToFile(`${srv.base}/a`, dest, { size: AUDIO.length, sha1: sha1(AUDIO) });
  assert.deepEqual(await readFile(dest), AUDIO);
  assert.deepEqual(srv.hits.map((h) => h.range), ["bytes=100-", undefined]);
});

test("downloadToFile：下载期间目标位置出现内容不同的文件时不覆盖", async (t) => {
  const srv = await startServer({ "/a": AUDIO });
  t.after(srv.close);
  const dir = await tempDir(t);
  const dest = join(dir, "a.mp3");
  await writeFile(dest, "someone else's file");
  await assert.rejects(
    () => downloadToFile(`${srv.base}/a`, dest, { size: AUDIO.length, sha1: sha1(AUDIO) }),
    /未覆盖/,
  );
  assert.equal(await readFile(dest, "utf-8"), "someone else's file");

  // 目标位置是内容相同的文件：视为完成，清掉 .part
  await writeFile(dest, AUDIO);
  await downloadToFile(`${srv.base}/a`, dest, { size: AUDIO.length, sha1: sha1(AUDIO) });
  assert.deepEqual(await readdir(dir), ["a.mp3"]);
});

test("downloadToFile：SHA-1 不符时报错、删除 .part、不产生正式文件", async (t) => {
  const srv = await startServer({ "/a": AUDIO });
  t.after(srv.close);
  const dir = await tempDir(t);
  const dest = join(dir, "a.mp3");
  await assert.rejects(
    () => downloadToFile(`${srv.base}/a`, dest, { size: AUDIO.length, sha1: "0".repeat(40) }),
    IntegrityError,
  );
  assert.deepEqual(await readdir(dir), []);
});

const SOURCE_ID = "rec-1";

function sourceFor(base: string, opts: { encrypted?: boolean } = {}) {
  let urlCalls = 0;
  return {
    get urlCalls() {
      return urlCalls;
    },
    async getDownloadUrl(id: string) {
      urlCalls++;
      return `${base}/${id}`;
    },
    async getBlockStorage() {
      return opts.encrypted ? { encryptInfo: { v: 1 } } : { kss: {} };
    },
  };
}

test("fetchRecording：直链失效（403）时重新获取直链并重试", async (t) => {
  const srv = await startServer({ [`/${SOURCE_ID}`]: AUDIO }, { failFirst: { [`/${SOURCE_ID}`]: 1 } });
  t.after(srv.close);
  const dir = await tempDir(t);
  const source = sourceFor(srv.base);
  const dest = join(dir, "a.mp3");
  await fetchRecording(source, { id: SOURCE_ID, size: AUDIO.length, sha1: sha1(AUDIO) }, dest);
  assert.deepEqual(await readFile(dest), AUDIO);
  assert.equal(source.urlCalls, 2);
});

test("fetchRecording：内容校验失败且账号开启端到端加密时给出明确原因", async (t) => {
  const srv = await startServer({ [`/${SOURCE_ID}`]: AUDIO });
  t.after(srv.close);
  const dir = await tempDir(t);
  await assert.rejects(
    () => fetchRecording(sourceFor(srv.base, { encrypted: true }), { id: SOURCE_ID, size: AUDIO.length, sha1: "f".repeat(40) }, join(dir, "a.mp3")),
    (err: Error) => err.message === E2EE_MESSAGE,
  );
});

test("downloadToStream：校验通过才输出；校验失败时一个字节也不输出", async (t) => {
  const srv = await startServer({ [`/${SOURCE_ID}`]: AUDIO });
  t.after(srv.close);

  const good = new PassThrough();
  const chunks: Buffer[] = [];
  good.on("data", (c: Buffer) => chunks.push(c));
  await downloadToStream(sourceFor(srv.base), { id: SOURCE_ID, size: AUDIO.length, sha1: sha1(AUDIO) }, good);
  assert.deepEqual(Buffer.concat(chunks), AUDIO);

  const bad = new PassThrough();
  let emitted = 0;
  bad.on("data", (c: Buffer) => (emitted += c.length));
  await assert.rejects(
    () => downloadToStream(sourceFor(srv.base), { id: SOURCE_ID, size: AUDIO.length, sha1: "0".repeat(40) }, bad),
    IntegrityError,
  );
  assert.equal(emitted, 0);
});

test("urlExpiresAt：从直链 ts 参数取过期时间", () => {
  assert.equal(urlExpiresAt("https://x/download_file?a=1&ts=1794694529000&sig=s"), 1794694529000);
  assert.equal(urlExpiresAt("https://x/download_file?a=1"), undefined);
  assert.equal(urlExpiresAt("not a url"), undefined);
});

// ============ pull ============

interface FakeRecording {
  id: string;
  name: string;
  content: Buffer;
}

function rawOf(r: FakeRecording): RawRecording {
  return {
    id: r.id,
    ver: `v${r.id}`,
    sha1: sha1(r.content),
    size: r.content.length,
    name: r.name,
    type: "file",
    create_time: 1784218386816,
    modify_time: 1784218386816,
    extraInfo: "",
  };
}

class FakeCloud implements TransferClient {
  deleted: string[] = [];
  constructor(
    private readonly base: string,
    public recordings: FakeRecording[],
  ) {}
  async listRecordings() {
    return this.recordings.filter((r) => !this.deleted.includes(r.id)).map(rawOf);
  }
  async listTrash() {
    return this.recordings.filter((r) => this.deleted.includes(r.id)).map(rawOf);
  }
  async getDownloadUrl(id: string) {
    return `${this.base}/${id}`;
  }
  async deleteRecording(id: string) {
    this.deleted.push(id);
  }
}

const REC_A: FakeRecording = {
  id: "100",
  name: "2026年07月17日 00点10分.mp3_151_0_1784218380620_1784218384310",
  content: Buffer.from("aaaa-recording"),
};
const REC_B: FakeRecording = {
  id: "200",
  name: "微信录音 小王_20260711131118.aac_3294_3_1783749974963_1783784436805",
  content: Buffer.from("bbbb-recording-longer"),
};
/** 与 REC_A 同名、内容不同 */
const REC_A2: FakeRecording = {
  id: "300",
  name: "2026年07月17日 00点10分.mp3_10_0_1784218390620_1784218394310",
  content: Buffer.from("cccc"),
};

async function setupCloud(t: { after: (fn: () => Promise<void>) => void }, recs: FakeRecording[]) {
  const files: Record<string, Buffer> = {};
  for (const r of recs) files[`/${r.id}`] = r.content;
  const srv = await startServer(files);
  t.after(srv.close);
  return { srv, cloud: new FakeCloud(srv.base, recs) };
}

function pullOpts(outputDir: string, extra: Partial<Parameters<typeof pullRecordings>[1]> = {}) {
  return { outputDir, template: "${title}", concurrency: 2, filter: {}, quiet: true, ...extra };
}

function downloadOpts(outputDir: string) {
  return { outputDir, template: "${title}", concurrency: 2, quiet: true };
}

test("pull：首次全部拉取并记录状态；再次拉取全部跳过", async (t) => {
  const { cloud } = await setupCloud(t, [REC_A, REC_B]);
  const dir = await tempDir(t);

  const first = await pullRecordings(cloud, pullOpts(dir));
  assert.equal(first.pulled.length, 2);
  assert.equal(first.failed.length, 0);
  assert.deepEqual(await readFile(join(dir, "2026年07月17日 00点10分.mp3")), REC_A.content);
  assert.deepEqual(await readFile(join(dir, "微信录音 小王_20260711131118.aac")), REC_B.content);
  const state = await loadState(dir);
  assert.deepEqual(Object.keys(state.recordings).sort(), ["100", "200"]);
  assert.equal(state.recordings["100"].file, "2026年07月17日 00点10分.mp3");
  assert.equal(first.pulled[0].title, "2026年07月17日 00点10分", "按录音时间倒序");
  assert.equal(first.pulled[0].type, "recorder", "结果带完整录音信息");
  assert.ok(!(await readdir(dir)).some((f) => f.endsWith(".lock")), "结束后释放目录锁");

  const second = await pullRecordings(cloud, pullOpts(dir));
  assert.equal(second.pulled.length, 0);
  assert.equal(second.alreadyPulled, 2);
});

test("pull：本地文件被移走后不会重新下载；--force 才重新拉取", async (t) => {
  const { cloud, srv } = await setupCloud(t, [REC_A]);
  const dir = await tempDir(t);
  await pullRecordings(cloud, pullOpts(dir));
  await rm(join(dir, "2026年07月17日 00点10分.mp3"));
  const hitsBefore = srv.hits.length;

  const again = await pullRecordings(cloud, pullOpts(dir));
  assert.equal(again.pulled.length, 0);
  assert.equal(again.alreadyPulled, 1);
  assert.equal(srv.hits.length, hitsBefore, "没有发起下载");

  const forced = await pullRecordings(cloud, pullOpts(dir, { force: true }));
  assert.equal(forced.pulled.length, 1);
  assert.equal(forced.pulled[0].existing, false);
  assert.deepEqual(await readFile(join(dir, "2026年07月17日 00点10分.mp3")), REC_A.content);
});

test("pull：目标位置已有相同内容的文件直接认领，不下载", async (t) => {
  const { cloud, srv } = await setupCloud(t, [REC_A]);
  const dir = await tempDir(t);
  await writeFile(join(dir, "2026年07月17日 00点10分.mp3"), REC_A.content);
  const result = await pullRecordings(cloud, pullOpts(dir));
  assert.equal(result.pulled.length, 1);
  assert.equal(result.pulled[0].existing, true);
  assert.equal(result.downloadedBytes, 0);
  assert.equal(srv.hits.length, 0);
});

test("pull：同名冲突时加 _<id> 后缀；绝不覆盖内容不同的已有文件", async (t) => {
  const { cloud } = await setupCloud(t, [REC_A, REC_A2]);
  const dir = await tempDir(t);
  await writeFile(join(dir, "2026年07月17日 00点10分.mp3"), Buffer.from("user's own file"));
  await writeFile(join(dir, "2026年07月17日 00点10分_300.mp3"), Buffer.from("another user file"));
  const result = await pullRecordings(cloud, pullOpts(dir));

  assert.deepEqual(await readFile(join(dir, "2026年07月17日 00点10分.mp3")), Buffer.from("user's own file"));
  assert.deepEqual(await readFile(join(dir, "2026年07月17日 00点10分_300.mp3")), Buffer.from("another user file"));
  assert.deepEqual(await readFile(join(dir, "2026年07月17日 00点10分_100.mp3")), REC_A.content);
  assert.deepEqual(result.pulled.map((p) => p.relativePath), ["2026年07月17日 00点10分_100.mp3"]);
  assert.equal(result.failed.length, 1, "两个位置都被占用的录音报错而不是覆盖");
  assert.equal(result.failed[0].id, "300");
  assert.equal((await loadState(dir)).recordings["300"], undefined);
});

test("pull：--dry-run 不下载、不写状态、不加锁", async (t) => {
  const { cloud, srv } = await setupCloud(t, [REC_A, REC_B]);
  const dir = await tempDir(t);
  const result = await pullRecordings(cloud, pullOpts(dir, { dryRun: true, deleteCloud: true }));
  assert.equal(result.pulled.length, 2);
  assert.equal(result.deletedFromCloud.length, 2);
  assert.equal(srv.hits.length, 0);
  assert.deepEqual(cloud.deleted, []);
  assert.equal(await stat(dir).then(() => readdir(dir)).then((l) => l.length), 0);
});

test("pull：--limit 只拉最新的 n 条；筛选条件生效", async (t) => {
  const { cloud } = await setupCloud(t, [REC_A, REC_B]);
  const dir = await tempDir(t);
  const limited = await pullRecordings(cloud, pullOpts(dir, { limit: 1 }));
  assert.deepEqual(limited.pulled.map((p) => p.id), ["100"]);

  const dir2 = await tempDir(t);
  const filtered = await pullRecordings(cloud, pullOpts(dir2, { filter: { types: ["app"] } }));
  assert.deepEqual(filtered.pulled.map((p) => p.id), ["200"]);
  assert.equal(filtered.matched, 1);
});

test("pull：同一拉取目录不能同时运行两个 pull；持锁进程已退出时自动接管", async (t) => {
  const { cloud } = await setupCloud(t, [REC_A]);
  const dir = await tempDir(t);
  const release = await lockOutputDir(dir);
  await assert.rejects(() => pullRecordings(cloud, pullOpts(dir)), /正被另一个进程使用/);
  await assert.rejects(() => downloadRecordings(cloud, [REC_A.id], downloadOpts(dir)), /正被另一个进程使用/, "download 同样独占目录");
  await release();

  // 残留的锁（pid 已不存在）
  await writeFile(join(dir, ".mi-recording-cli.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname() }));
  const result = await pullRecordings(cloud, pullOpts(dir));
  assert.equal(result.pulled.length, 1);
});

test("lockOutputDir：内容不完整的锁文件刚创建时视为占用，超过一分钟视为残留并接管", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, ".mi-recording-cli.lock");
  await writeFile(file, "");
  await assert.rejects(() => lockOutputDir(dir), /正被另一个进程使用/);
  const old = new Date(Date.now() - 120_000);
  await utimes(file, old, old);
  const release = await lockOutputDir(dir);
  assert.equal(JSON.parse(await readFile(file, "utf-8")).pid, process.pid);
  await release();
  assert.deepEqual(await readdir(dir), []);
});

test("pull --delete-cloud：确认后删除新拉取的与之前已拉取的；拒绝确认则什么都不做", async (t) => {
  const { cloud } = await setupCloud(t, [REC_A, REC_B]);
  const dir = await tempDir(t);
  await pullRecordings(cloud, pullOpts(dir, { filter: { types: ["recorder"] } }));

  const cancelled = await pullRecordings(cloud, pullOpts(dir, { deleteCloud: true, confirmDelete: async () => false }));
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(cloud.deleted, []);
  assert.equal((await loadState(dir)).recordings["200"], undefined, "取消时也不下载");

  let asked = 0;
  const result = await pullRecordings(
    cloud,
    pullOpts(dir, {
      deleteCloud: true,
      confirmDelete: async (count) => {
        asked = count;
        return true;
      },
    }),
  );
  assert.equal(asked, 2);
  assert.deepEqual(cloud.deleted.sort(), ["100", "200"]);
  assert.equal(result.deletedFromCloud.length, 2);
  assert.equal(result.pulled.length, 1);
  const state = await loadState(dir);
  assert.ok(state.recordings["100"].cloudDeletedAt && state.recordings["200"].cloudDeletedAt, "记录删除时间");
});

test("pull --delete-cloud：之前拉取的文件已被转移走时默认不删云端，--allow-moved 才删", async (t) => {
  const { cloud } = await setupCloud(t, [REC_A]);
  const dir = await tempDir(t);
  await pullRecordings(cloud, pullOpts(dir));
  await rm(join(dir, "2026年07月17日 00点10分.mp3"));

  const strict = await pullRecordings(cloud, pullOpts(dir, { deleteCloud: true, confirmDelete: async () => true }));
  assert.deepEqual(cloud.deleted, []);
  assert.deepEqual(strict.deleteSkipped.map((s) => [s.id, s.code]), [["100", "local-missing"]]);

  // 本地文件被改动（内容不再一致）同样不删
  await writeFile(join(dir, "2026年07月17日 00点10分.mp3"), "edited");
  const edited = await pullRecordings(cloud, pullOpts(dir, { deleteCloud: true, confirmDelete: async () => true }));
  assert.deepEqual(cloud.deleted, []);
  assert.equal(edited.deleteSkipped[0].code, "local-missing");

  const moved = await pullRecordings(
    cloud,
    pullOpts(dir, { deleteCloud: true, allowMoved: true, confirmDelete: async () => true }),
  );
  assert.deepEqual(cloud.deleted, ["100"]);
  assert.equal(moved.deletedFromCloud.length, 1);
});

test("pull --delete-cloud：被删除后又恢复的录音视为有意保留，不再自动删除", async (t) => {
  const { cloud } = await setupCloud(t, [REC_A]);
  const dir = await tempDir(t);
  await pullRecordings(cloud, pullOpts(dir, { deleteCloud: true, confirmDelete: async () => true }));
  assert.deepEqual(cloud.deleted, ["100"]);
  cloud.deleted = []; // 用户从回收站恢复

  let asked = false;
  const again = await pullRecordings(
    cloud,
    pullOpts(dir, {
      deleteCloud: true,
      confirmDelete: async () => {
        asked = true;
        return true;
      },
    }),
  );
  assert.equal(asked, false);
  assert.deepEqual(cloud.deleted, []);
  assert.equal(again.deletedFromCloud.length, 0);
  assert.deepEqual(again.deleteSkipped.map((s) => s.code), ["kept"]);

  // --force 重新拉取后仍视为保留
  const forced = await pullRecordings(cloud, pullOpts(dir, { force: true, deleteCloud: true, confirmDelete: async () => true }));
  assert.deepEqual(cloud.deleted, []);
  assert.equal(forced.pulled.length, 1);
  assert.ok((await loadState(dir)).recordings["100"].cloudDeletedAt, "保留标记不被重新拉取覆盖");
});

test("pull --delete-cloud：下载失败的录音不删除云端", async (t) => {
  const files = { [`/${REC_A.id}`]: REC_A.content }; // REC_B 不提供 → 404
  const srv = await startServer(files);
  t.after(srv.close);
  const cloud = new FakeCloud(srv.base, [REC_A, REC_B]);
  const dir = await tempDir(t);
  const result = await pullRecordings(cloud, pullOpts(dir, { deleteCloud: true, confirmDelete: async () => true }));
  assert.deepEqual(cloud.deleted, ["100"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, "200");
  assert.equal((await loadState(dir)).recordings["200"], undefined);
});

test("pull --delete-cloud：删除前再核对本地文件，确认后被转移走的不删", async (t) => {
  const { cloud } = await setupCloud(t, [REC_A, REC_B]);
  const dir = await tempDir(t);
  await pullRecordings(cloud, pullOpts(dir));
  // 规划时两个文件都在；用户确认后、开始删除前，A 被转移走
  const result = await pullRecordings(
    cloud,
    pullOpts(dir, {
      deleteCloud: true,
      confirmDelete: async () => {
        await rm(join(dir, "2026年07月17日 00点10分.mp3"));
        return true;
      },
    }),
  );
  assert.deepEqual(cloud.deleted, ["200"]);
  assert.deepEqual(result.deleteSkipped.map((s) => [s.id, s.code]), [["100", "local-missing"]]);
  assert.equal((await loadState(dir)).recordings["100"].cloudDeletedAt, undefined);
});

test("pull --delete-cloud --limit：只清理本次拉取的录音，不动之前拉取过的", async (t) => {
  const { cloud } = await setupCloud(t, [REC_A, REC_B]);
  const dir = await tempDir(t);
  await pullRecordings(cloud, pullOpts(dir, { filter: { types: ["app"] } }));
  let asked = 0;
  const result = await pullRecordings(
    cloud,
    pullOpts(dir, {
      limit: 1,
      deleteCloud: true,
      confirmDelete: async (count) => {
        asked = count;
        return true;
      },
    }),
  );
  assert.equal(asked, 1);
  assert.deepEqual(result.pulled.map((p) => p.id), ["100"]);
  assert.deepEqual(cloud.deleted, ["100"]);
});

test("downloadToFile：大小已齐的 .part 直接校验放置；被其他进程写坏的 .part 不会放行", async (t) => {
  const srv = await startServer({ "/a": AUDIO });
  t.after(srv.close);
  const dir = await tempDir(t);
  const dest = join(dir, "a.mp3");
  await writeFile(`${dest}.part`, AUDIO);
  await downloadToFile(`${srv.base}/a`, dest, { size: AUDIO.length, sha1: sha1(AUDIO) });
  assert.deepEqual(await readFile(dest), AUDIO);
  assert.equal(srv.hits.length, 0, "没有重新下载");

  // 同样大小但内容不对的 .part：丢弃后从头下载
  const dest2 = join(dir, "b.mp3");
  await writeFile(`${dest2}.part`, Buffer.alloc(AUDIO.length));
  await downloadToFile(`${srv.base}/a`, dest2, { size: AUDIO.length, sha1: sha1(AUDIO) });
  assert.deepEqual(await readFile(dest2), AUDIO);
  assert.deepEqual(srv.hits.map((h) => h.range), [undefined]);
});

test("pull：登录态失效后立即停止，剩余录音记为失败、不再请求", async (t) => {
  const { cloud } = await setupCloud(t, [REC_A, REC_B]);
  const dir = await tempDir(t);
  let urlCalls = 0;
  cloud.getDownloadUrl = async () => {
    urlCalls++;
    throw new AuthExpiredError();
  };
  const result = await pullRecordings(cloud, pullOpts(dir, { concurrency: 1, deleteCloud: true, confirmDelete: async () => true }));
  assert.equal(urlCalls, 1);
  assert.equal(result.failed.length, 2);
  assert.ok(result.failed.every((f) => /登录态已过期/.test(f.error)));
  assert.deepEqual(cloud.deleted, []);
});

test("pull --delete-cloud：删除时登录态失效，后续删除不再尝试", async (t) => {
  const { cloud } = await setupCloud(t, [REC_A, REC_B]);
  const dir = await tempDir(t);
  await pullRecordings(cloud, pullOpts(dir));
  let deleteCalls = 0;
  cloud.deleteRecording = async () => {
    deleteCalls++;
    throw new AuthExpiredError();
  };
  const result = await pullRecordings(cloud, pullOpts(dir, { deleteCloud: true, confirmDelete: async () => true }));
  assert.equal(deleteCalls, 1);
  assert.equal(result.deleteFailed.length, 2);
});

test("planTargets：同一批里文件名冲突（大小写不同也算）按录音时间先到先得", async (t) => {
  const dir = await tempDir(t);
  const early = parseRecording(rawOf({ id: "1", name: "Talk.mp3_10_0_1700000000000_1700000000000", content: Buffer.from("x") }));
  const late = parseRecording(rawOf({ id: "2", name: "talk.mp3_10_0_1700000100000_1700000100000", content: Buffer.from("y") }));
  const { targets, failures } = await planTargets([late, early], dir, "${title}");
  assert.equal(failures.length, 0);
  const byId = Object.fromEntries(targets.map((x) => [x.recording.id, x.relPath]));
  assert.equal(byId["1"], "Talk.mp3");
  assert.equal(byId["2"], "talk_2.mp3");
});

test("selectPulled：按安全规则分出可删除与跳过的录音", async (t) => {
  const dir = await tempDir(t);
  const a = parseRecording(rawOf(REC_A));
  const b = parseRecording(rawOf(REC_B));
  const c = parseRecording(rawOf(REC_A2));
  const noSha = parseRecording({ ...rawOf({ id: "400", name: "x.mp3_1_0_1784218390620_1784218394310", content: Buffer.from("z") }), sha1: "" });
  await writeFile(join(dir, "a"), REC_A.content);
  const state = {
    version: 1 as const,
    recordings: {
      [a.id]: { sha1: a.sha1, size: a.size, file: "a", title: a.title, pulledAt: 1 },
      [b.id]: { sha1: "changed", size: b.size, file: "b", title: b.title, pulledAt: 1 },
      [c.id]: { sha1: c.sha1, size: c.size, file: "c", title: c.title, pulledAt: 1, cloudDeletedAt: 2 },
      [noSha.id]: { sha1: "", size: noSha.size, file: "d", title: noSha.title, pulledAt: 1 },
    },
  };
  const { targets, skipped } = await selectPulled([a, b, c, noSha], state, dir);
  assert.deepEqual(targets.map((r) => r.id), [a.id]);
  assert.deepEqual(
    skipped.map((s) => [s.id, s.code]),
    [[b.id, "cloud-changed"], [c.id, "kept"], [noSha.id, "unverifiable"]],
  );
  assert.deepEqual((await selectPulled([a, b, c], state, dir, { predicate: (r) => r.type === "app" })).targets, []);

  await rm(join(dir, "a"));
  assert.deepEqual((await selectPulled([a], state, dir)).skipped.map((s) => s.code), ["local-missing"]);
  assert.deepEqual((await selectPulled([a], state, dir, { allowMoved: true })).targets.map((r) => r.id), [a.id]);
});

test("selectTrashTargets：按 id 选取并报告缺失；--all 选取全部", () => {
  const trash = [parseTrashedRecording(rawOf(REC_A)), parseTrashedRecording(rawOf(REC_B))];
  const picked = selectTrashTargets(trash, ["200", "999", "200"], false);
  assert.deepEqual(picked.targets.map((r) => r.id), ["200"]);
  assert.equal(picked.targets[0].ver, "v200", "使用回收站条目的 ver");
  assert.deepEqual(picked.missing, ["999"]);
  assert.equal(selectTrashTargets(trash, [], true).targets.length, 2);
});

test("sanitizeFileName：Windows 保留设备名加前缀", () => {
  assert.equal(sanitizeFileName("CON"), "_CON");
  assert.equal(sanitizeFileName("nul.mp3"), "_nul.mp3");
  assert.equal(sanitizeFileName("com1"), "_com1");
  assert.equal(sanitizeFileName("CONTACT"), "CONTACT");
});
