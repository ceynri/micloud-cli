import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasState, loadState, saveState, getStatePath } from "../../src/recording/config.ts";
import { fileExists } from "../../src/core/utils.ts";

test("拉取状态：读取合并前的 .mi-recording-cli.state.json；保存后改用新文件名并移除旧文件", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "micloud-rec-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await hasState(dir), false);

  const legacy = { version: 1, recordings: { "100": { sha1: "a", size: 1, file: "a.mp3", title: "a", pulledAt: 1 } } };
  await writeFile(join(dir, ".mi-recording-cli.state.json"), JSON.stringify(legacy), "utf-8");
  assert.equal(await hasState(dir), true);
  const state = await loadState(dir);
  assert.deepEqual(Object.keys(state.recordings), ["100"]);

  await saveState(dir, state);
  assert.equal(getStatePath(dir), join(dir, ".micloud-recording.json"));
  assert.deepEqual(JSON.parse(await readFile(getStatePath(dir), "utf-8")).recordings["100"].file, "a.mp3");
  assert.equal(await fileExists(join(dir, ".mi-recording-cli.state.json")), false);
});

test("拉取状态：文件损坏时报错，而不是当成空状态重新下载", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "micloud-rec-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(getStatePath(dir), "{broken", "utf-8");
  await assert.rejects(() => loadState(dir), /拉取状态文件已损坏/);
});
