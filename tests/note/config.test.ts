import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileExists } from "../../src/core/utils.ts";
import {
  getProjectRoot,
  getUserConfigPath,
  getDefaultOutputDir,
  getStatePath,
  loadUserConfig,
  saveUserConfig,
  loadState,
  saveState,
  hasLegacyOnlyState,
  getEffectiveUserConfigPath,
  resolveOutputDir,
  resolveSyncMode,
  setSyncMode,
  setOutput,
  toOutputRel,
  toOutputAbs,
} from "../../src/note/config.ts";
import type { SyncState } from "../../src/note/types.ts";

/**
 * src/config.ts 纯逻辑单元测试。
 *
 * 通过 MICLOUD_CONFIG_DIR 环境变量把项目根隔离到临时目录，
 * 不触碰真实工作区与用户配置。零网络依赖。
 */

let projectRoot: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "micloud-cfgtest-"));
  prevEnv = process.env.MICLOUD_CONFIG_DIR;
  process.env.MICLOUD_CONFIG_DIR = projectRoot;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.MICLOUD_CONFIG_DIR;
  else process.env.MICLOUD_CONFIG_DIR = prevEnv;
  await rm(projectRoot, { recursive: true, force: true });
});

// ============ 路径解析 ============

test("getProjectRoot 读取 MICLOUD_CONFIG_DIR 环境变量", () => {
  assert.equal(getProjectRoot(), projectRoot);
});

test("getUserConfigPath 落在 <root>/.micloud/config.json", () => {
  assert.equal(getUserConfigPath(), join(projectRoot, ".micloud", "config.json"));
});

test("getDefaultOutputDir 落在 <root>/.micloud/note", () => {
  assert.equal(getDefaultOutputDir(), join(projectRoot, ".micloud", "note"));
});

test("getStatePath 在传入 output 目录内", () => {
  const out = join(projectRoot, "anywhere");
  assert.equal(getStatePath(out), join(out, ".micloud-note.state.json"));
});

test("toOutputRel / toOutputAbs 互逆", () => {
  const out = join(projectRoot, "out");
  const abs = join(out, "sub", "note.md");
  const rel = toOutputRel(abs, out);
  assert.equal(rel, join("sub", "note.md"));
  assert.equal(toOutputAbs(rel, out), abs);
});

test("toOutputAbs 接受绝对路径直接返回", () => {
  const out = join(projectRoot, "out");
  const abs = join(projectRoot, "elsewhere", "x.md");
  assert.equal(toOutputAbs(abs, out), abs);
});

// ============ UserConfig 读写 ============

test("loadUserConfig：文件不存在返回空配置", async () => {
  const cfg = await loadUserConfig();
  assert.equal(cfg.syncMode, undefined);
  assert.equal(cfg.output, undefined);
  assert.equal(cfg.fileNameTemplate, undefined);
});

test("loadUserConfig：JSON 解析失败时静默回落空对象（不抛错）", async () => {
  // 用 saveUserConfig 先建好父目录，再写入坏内容
  await saveUserConfig({});
  await writeFile(getUserConfigPath(), "{not valid json", "utf-8");
  const cfg = await loadUserConfig();
  assert.equal(cfg.syncMode, undefined);
  assert.equal(cfg.output, undefined);
  assert.equal(cfg.fileNameTemplate, undefined);
});

test("saveUserConfig → loadUserConfig 往返保留所有字段", async () => {
  await saveUserConfig({
    syncMode: "two-way",
    output: "./mi-notes",
    fileNameTemplate: "${YYYY}-${MM}-${DD}",
  });
  const cfg = await loadUserConfig();
  assert.equal(cfg.syncMode, "two-way");
  assert.equal(cfg.output, "./mi-notes");
  assert.equal(cfg.fileNameTemplate, "${YYYY}-${MM}-${DD}");
});

test("saveUserConfig 写进 .micloud/config.json 的 note 节，不动其他服务的配置", async () => {
  await mkdir(join(projectRoot, ".micloud"), { recursive: true });
  await writeFile(getUserConfigPath(), JSON.stringify({ recording: { output: "rec" } }), "utf-8");
  await saveUserConfig({ syncMode: "manual" });
  const raw = JSON.parse(await readFile(getUserConfigPath(), "utf-8"));
  assert.deepEqual(raw, { recording: { output: "rec" }, note: { syncMode: "manual" } });
});

test("兼容旧版：没有 note 节时读 .mi-note-cli/config.json", async () => {
  await mkdir(join(projectRoot, ".mi-note-cli"), { recursive: true });
  await writeFile(
    join(projectRoot, ".mi-note-cli", "config.json"),
    JSON.stringify({ syncMode: "two-way", output: "inbox/mi-notes", fileNameTemplate: "${id}" }),
    "utf-8",
  );
  const cfg = await loadUserConfig();
  assert.equal(cfg.syncMode, "two-way");
  assert.equal(cfg.output, "inbox/mi-notes");
  assert.equal(await resolveOutputDir(), join(projectRoot, "inbox", "mi-notes"));

  // 写入后迁到新位置，旧文件原样保留
  await setSyncMode("cloud-first");
  const raw = JSON.parse(await readFile(getUserConfigPath(), "utf-8"));
  assert.deepEqual(raw.note, { syncMode: "cloud-first", output: "inbox/mi-notes", fileNameTemplate: "${id}" });
  assert.ok(await fileExists(join(projectRoot, ".mi-note-cli", "config.json")));
});

test("兼容旧版：没配 output 时沿用已存在的 .mi-note-cli/output/", async () => {
  await mkdir(join(projectRoot, ".mi-note-cli", "output"), { recursive: true });
  assert.equal(await resolveOutputDir(), join(projectRoot, ".mi-note-cli", "output"));
});

test("兼容旧版：读取 .mi-note-cli.state.json；保存后改用新文件名并移除旧文件", async () => {
  const out = join(projectRoot, "legacy-out");
  await mkdir(out, { recursive: true });
  const legacy: SyncState = { lastSync: 5, notes: { "1": { id: "1", subject: "a", filePath: "a.md" } }, folders: {} };
  await writeFile(join(out, ".mi-note-cli.state.json"), JSON.stringify(legacy), "utf-8");
  const loaded = await loadState(out);
  assert.equal(loaded.lastSync, 5);
  assert.deepEqual(Object.keys(loaded.notes), ["1"]);
  await saveState(out, loaded);
  assert.ok(await fileExists(join(out, ".micloud-note.state.json")));
  assert.ok(!(await fileExists(join(out, ".mi-note-cli.state.json"))));
});

test("hasLegacyOnlyState：只有旧状态文件时为 true，保存后为 false", async () => {
  const out = join(projectRoot, "legacy-out2");
  await mkdir(out, { recursive: true });
  assert.equal(await hasLegacyOnlyState(out), false);
  await writeFile(join(out, ".mi-note-cli.state.json"), JSON.stringify({ lastSync: 1, notes: {}, folders: {} }), "utf-8");
  assert.equal(await hasLegacyOnlyState(out), true);
  await saveState(out, await loadState(out));
  assert.equal(await hasLegacyOnlyState(out), false);
});

test("getEffectiveUserConfigPath：回落旧配置时指向旧文件，写入后指向新文件", async () => {
  const legacy = join(projectRoot, ".mi-note-cli", "config.json");
  await mkdir(join(projectRoot, ".mi-note-cli"), { recursive: true });
  await writeFile(legacy, JSON.stringify({ syncMode: "two-way" }), "utf-8");
  assert.equal(await getEffectiveUserConfigPath(), legacy);
  await saveUserConfig({ syncMode: "two-way" });
  assert.equal(await getEffectiveUserConfigPath(), getUserConfigPath());
});

// ============ SyncState 读写 ============

test("loadState：文件不存在返回空 state（lastSync=null, notes/folders 空）", async () => {
  const state = await loadState(join(projectRoot, "outX"));
  assert.equal(state.lastSync, null);
  assert.deepEqual(state.notes, {});
  assert.deepEqual(state.folders, {});
});

test("saveState → loadState 往返保留 notes/folders", async () => {
  const out = join(projectRoot, "out1");
  const original: SyncState = {
    lastSync: 1717_000_000_000,
    syncTag: "abc",
    notes: {
      "100": {
        id: "100",
        subject: "测试",
        filePath: "测试.md",
        baseHash: "h1",
        localHash: "h1",
        remoteModify: 1717_000_000_000,
      },
    },
    folders: {},
  };
  await saveState(out, original);
  const loaded = await loadState(out);
  assert.equal(loaded.lastSync, original.lastSync);
  assert.equal(loaded.syncTag, "abc");
  assert.deepEqual(loaded.notes, original.notes);
});

test("saveState 写到 <output>/.micloud-note.state.json，不写到项目根", async () => {
  const out = join(projectRoot, "out2");
  await saveState(out, { lastSync: 1, notes: {}, folders: {} });
  assert.ok(await fileExists(join(out, ".micloud-note.state.json")), "state 文件应在 output 目录内");
  assert.ok(!(await fileExists(join(projectRoot, ".micloud-note.state.json"))), "state 不应写到项目根");
});

// ============ 优先级解析 ============

test("resolveOutputDir 优先级：CLI > 配置 output > 默认 .micloud/note/", async () => {
  // 1) 全空 → 默认（基于项目根）
  assert.equal(await resolveOutputDir(), getDefaultOutputDir());

  // 2) 只配 UserConfig.output（相对路径基于项目根，与配置文件同处）
  await saveUserConfig({ output: "./custom" });
  assert.equal(await resolveOutputDir(), join(projectRoot, "custom"));

  // 3) CLI 覆盖 UserConfig；CLI 相对路径基于 cwd（终端 pwd 直觉，符合 Unix 工具约定）
  assert.equal(
    await resolveOutputDir("./from-cli"),
    join(process.cwd(), "from-cli"),
  );
});

test("resolveOutputDir：CLI 绝对路径直接返回", async () => {
  const abs = join(projectRoot, "abs-cli");
  assert.equal(await resolveOutputDir(abs), abs);
});

test("resolveOutputDir：UserConfig 中绝对路径直接返回", async () => {
  const abs = join(projectRoot, "abs-out");
  await saveUserConfig({ output: abs });
  assert.equal(await resolveOutputDir(), abs);
});

test("resolveSyncMode 优先级：CLI > UserConfig.syncMode > 默认 manual", async () => {
  // 1) 全空 → manual
  assert.equal(await resolveSyncMode(), "manual");

  // 2) UserConfig
  await saveUserConfig({ syncMode: "two-way" });
  assert.equal(await resolveSyncMode(), "two-way");

  // 3) CLI 覆盖
  assert.equal(await resolveSyncMode("local-first"), "local-first");
});

// ============ setSyncMode / setOutput 写入 ============

test("setSyncMode 写入 UserConfig 且不影响其他字段", async () => {
  await saveUserConfig({ output: "./keep", fileNameTemplate: "${id}" });
  await setSyncMode("cloud-first");
  const cfg = await loadUserConfig();
  assert.equal(cfg.syncMode, "cloud-first");
  assert.equal(cfg.output, "./keep", "output 字段应保留");
  assert.equal(cfg.fileNameTemplate, "${id}", "template 应保留");
});

test("setOutput 写入 UserConfig 且不影响其他字段", async () => {
  await saveUserConfig({ syncMode: "cloud-first" });
  await setOutput("./new-out");
  const cfg = await loadUserConfig();
  assert.equal(cfg.output, "./new-out");
  assert.equal(cfg.syncMode, "cloud-first", "syncMode 字段应保留");
});
