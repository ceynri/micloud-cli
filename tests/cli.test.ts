import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 命令行层的端到端测试：真实启动 CLI 进程，用临时的缓存目录与项目根隔离，不触网。
 * 只覆盖「发请求之前」就能确定结果的路径：参数校验、非交互确认、配置读写、子命令选项。
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
/** 子进程的工作目录在临时目录里，按绝对路径加载 tsx */
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;

interface Run {
  status: number | null;
  json: { ok: boolean; data?: any; error?: string };
}

async function sandbox(t: { after: (fn: () => Promise<void>) => void }): Promise<{ root: string; run: (...args: string[]) => Run }> {
  // 子进程看到的当前目录是解析过符号链接的真实路径（macOS 的 /var → /private/var）
  const root = await realpath(await mkdtemp(join(tmpdir(), "micloud-cli-")));
  const cache = join(root, "cache");
  await mkdir(cache);
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (...args: string[]): Run => {
    const res = spawnSync(process.execPath, ["--import", TSX, CLI, ...args, "--json"], {
      cwd: root,
      env: { ...process.env, MICLOUD_CACHE_DIR: cache, MICLOUD_CONFIG_DIR: root },
      encoding: "utf-8",
      input: "",
    });
    return { status: res.status, json: JSON.parse(res.stdout) };
  };
  return { root, run };
}

test("CLI：笔记 / 文件夹删除在非交互模式下不带 -y 直接报错，且不发任何请求", async (t) => {
  const { run } = await sandbox(t);
  for (const args of [["note", "delete", "1"], ["note", "folder", "delete", "1", "--purge"]]) {
    const r = run(...args);
    assert.equal(r.status, 1);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error!, /需加 -y/, `${args.join(" ")} 应先要求 -y，而不是去检查登录`);
  }
});

test("CLI：未登录时返回明确错误；whoami 报告未登录", async (t) => {
  const { run } = await sandbox(t);
  const r = run("rec", "list");
  assert.equal(r.status, 1);
  assert.match(r.json.error!, /micloud login/);
  const who = run("whoami");
  assert.equal(who.status, 0);
  assert.deepEqual(who.json.data, { loggedIn: false });
});

test("CLI：rec config 写入 recording 节；config show -o 与 note sync status -o 都生效", async (t) => {
  const { root, run } = await sandbox(t);
  assert.equal(run("rec", "config", "set", "concurrency", "99").json.ok, false);
  assert.equal(run("rec", "config", "set", "concurrency", "4").status, 0);

  const shown = run("rec", "config", "show", "-o", "pulled");
  assert.equal(shown.json.data.effective.concurrency, 4);
  assert.equal(shown.json.data.effective.output, join(root, "pulled"));

  const status = run("note", "sync", "status", "-o", "notes");
  assert.equal(status.json.data.outputDir, join(root, "notes"));
});

test("CLI：沿用旧版笔记配置与同步状态", async (t) => {
  const { root, run } = await sandbox(t);
  await mkdir(join(root, ".mi-note-cli"), { recursive: true });
  await writeFile(join(root, ".mi-note-cli", "config.json"), JSON.stringify({ output: "inbox", syncMode: "two-way" }));
  await mkdir(join(root, "inbox"));
  await writeFile(
    join(root, "inbox", ".mi-note-cli.state.json"),
    JSON.stringify({ lastSync: 7, notes: { "1": { id: "1", subject: "a", filePath: "a.md" } }, folders: {} }),
  );
  const status = run("note", "sync", "status");
  assert.equal(status.json.data.outputDir, join(root, "inbox"));
  assert.equal(status.json.data.config.syncMode, "two-way");
  assert.equal(status.json.data.state.lastSync, 7);
});

test("CLI：录音删除参数互斥在发请求前报错", async (t) => {
  const { run } = await sandbox(t);
  assert.match(run("rec", "delete", "1", "--pulled").json.error!, /只能选一种方式/);
  assert.match(run("rec", "pull", "--allow-moved").json.error!, /--delete-cloud/);
  assert.match(run("rec", "delete").json.error!, /请指定要删除的录音/);
});
