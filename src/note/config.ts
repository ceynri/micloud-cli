import { readFile, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import {
  getConfigPath,
  getDefaultOutputDir as coreDefaultOutputDir,
  getProjectRoot,
  loadSection,
  resolveOutputPath,
  saveSection,
} from "../core/config.js";
import { logInfo } from "../core/output.js";
import { fileExists, writeFileAtomic } from "../core/utils.js";
import type { SyncMode, UserConfig, SyncState } from "./types.js";

/**
 * 两类元数据按位置与归属拆分：
 *
 * - 笔记配置：项目配置 `.micloud/config.json` 的 `note` 节（手写、可入版控、可团队共享）
 * - 同步状态：`<outputDir>/.micloud-note.state.json`（自动生成、跟 output 1:1 绑定）
 *
 * 兼容旧版（mi-note-cli）：没有 `note` 节时读 `.mi-note-cli/config.json`；
 * 没有新状态文件时读 `.mi-note-cli.state.json`（保存时改用新文件名并移除旧文件）；
 * 既没传 `-o` 也没配 output 时，若旧的默认目录 `.mi-note-cli/output/` 存在则继续用它。
 */
const STATE_FILENAME = ".micloud-note.state.json";
const LEGACY_STATE_FILENAME = ".mi-note-cli.state.json";
const LEGACY_CONFIG = join(".mi-note-cli", "config.json");
const LEGACY_DEFAULT_OUTPUT = join(".mi-note-cli", "output");
const DEFAULT_SYNC_MODE: SyncMode = "manual";

export { getProjectRoot };

// ============================================================
// 路径解析
// ============================================================

/** 配置文件绝对路径：`<root>/.micloud/config.json` */
export function getUserConfigPath(): string {
  return getConfigPath();
}

/** 默认 output 目录绝对路径：`<root>/.micloud/note/` */
export function getDefaultOutputDir(): string {
  return coreDefaultOutputDir("note");
}

/** 给定 output 目录，返回其内的 state 文件绝对路径 */
export function getStatePath(outputDir: string): string {
  return join(outputDir, STATE_FILENAME);
}

/** 绝对路径 → 相对 output（用于写入 state.notes[].filePath） */
export function toOutputRel(absPath: string, outputDir: string): string {
  return relative(outputDir, absPath);
}

/** 相对 output 的路径 → 绝对路径（用于实际文件读写） */
export function toOutputAbs(relPath: string, outputDir: string): string {
  return isAbsolute(relPath) ? relPath : resolve(outputDir, relPath);
}

// ============================================================
// 笔记配置（UserConfig）
// ============================================================

/**
 * 读取笔记配置（不存在则返回空壳）。
 *
 * 回落形态：返回 `{}`（全字段 undefined）。消费者通过 `??` 链回落到默认值；
 * 显式 syncMode/output/fileNameTemplate 白名单也防止无关字段误漂进 UserConfig。
 * 与 `loadState` 的容错风格刻意不同：state 由工具自动写入，schema 漂移可控。
 */
export async function loadUserConfig(): Promise<UserConfig> {
  const raw = await loadSection("note");
  return {
    syncMode: typeof raw.syncMode === "string" ? (raw.syncMode as SyncMode) : undefined,
    output: typeof raw.output === "string" ? raw.output : undefined,
    fileNameTemplate: typeof raw.fileNameTemplate === "string" ? raw.fileNameTemplate : undefined,
  };
}

/** 写入笔记配置（其他服务的配置原样保留）；旧版配置文件从此不再使用，提示可删除 */
export async function saveUserConfig(cfg: UserConfig): Promise<void> {
  const section: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (value !== undefined) section[key] = value;
  }
  await saveSection("note", section);
  const legacy = join(getProjectRoot(), LEGACY_CONFIG);
  if (await fileExists(legacy)) {
    logInfo(`ℹ️ 笔记配置已写入 ${getConfigPath()}，旧的 ${legacy} 不再使用，可删除`);
  }
}

// ============================================================
// 同步状态（SyncState）
// ============================================================

function emptyState(): SyncState {
  return { lastSync: null, notes: {}, folders: {} };
}

/**
 * 读取指定 output 内的同步状态；不存在或解析失败时返回空壳。
 *
 * 回落形态与 `loadUserConfig` 不同：state 是「数据载体」，消费者要直接遍历
 * `notes`/`folders`，因此回落到带空容器的对象（`{ lastSync: null, notes: {}, folders: {} }`）；
 * 而 `loadUserConfig` 回落到全字段 undefined（消费者用 `??` 链回落到默认值）。
 */
export async function loadState(outputDir: string): Promise<SyncState> {
  let file = getStatePath(outputDir);
  if (!(await fileExists(file))) {
    file = join(outputDir, LEGACY_STATE_FILENAME);
    if (!(await fileExists(file))) return emptyState();
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as Partial<SyncState>;
    return {
      lastSync: parsed.lastSync ?? null,
      syncTag: parsed.syncTag,
      notes: parsed.notes ?? {},
      folders: parsed.folders ?? {},
    };
  } catch {
    return emptyState();
  }
}

/**
 * 原子写回同步状态（自动创建父目录，幂等）。
 * 写成功后移除旧版状态文件，避免两份状态并存、旧版工具读到过期的基线。
 */
export async function saveState(outputDir: string, state: SyncState): Promise<void> {
  await writeFileAtomic(getStatePath(outputDir), JSON.stringify(state, null, 2));
  await rm(join(outputDir, LEGACY_STATE_FILENAME), { force: true });
}

// ============================================================
// 解析（output / mode）
// ============================================================

/**
 * 解析生效的 output 目录（绝对路径）。
 * 优先级：命令行 `-o <dir>` > 配置 output > 旧版默认目录 `.mi-note-cli/output/`（存在时）> `<root>/.micloud/note/`
 *
 * 相对路径基准：命令行 `-o` 基于当前目录（符合 Unix 工具约定）；配置 output 与默认值基于项目根。
 */
export async function resolveOutputDir(cliOutput?: string): Promise<string> {
  if (cliOutput) return resolve(cliOutput);
  const cfg = await loadUserConfig();
  if (cfg.output) return resolveOutputPath("note", undefined, cfg.output);
  const legacy = join(getProjectRoot(), LEGACY_DEFAULT_OUTPUT);
  if (await fileExists(legacy)) return legacy;
  return getDefaultOutputDir();
}

/** 解析生效的同步模式：命令行 > 配置 > 默认 */
export async function resolveSyncMode(cliMode?: SyncMode): Promise<SyncMode> {
  if (cliMode) return cliMode;
  const cfg = await loadUserConfig();
  return cfg.syncMode ?? DEFAULT_SYNC_MODE;
}

/** 设置默认同步模式（写入配置） */
export async function setSyncMode(mode: SyncMode): Promise<void> {
  const cfg = await loadUserConfig();
  cfg.syncMode = mode;
  await saveUserConfig(cfg);
}

/** 设置默认 output 目录（写入配置） */
export async function setOutput(output: string): Promise<void> {
  const cfg = await loadUserConfig();
  cfg.output = output;
  await saveUserConfig(cfg);
}

export const ALL_MODES: SyncMode[] = ["cloud-first", "local-first", "two-way", "manual"];

export { DEFAULT_SYNC_MODE };
