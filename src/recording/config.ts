import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadSection, resolveOutputPath, saveSection } from "../core/config.js";
import { lockDir } from "../core/lock.js";
import { fileExists, writeFileAtomic } from "../core/utils.js";
import type { PullState, RecordingConfig } from "./types.js";

/**
 * 两类元数据按位置与归属拆分：
 *
 * - 配置：项目配置 `.micloud/config.json` 的 `recording` 节（手写或 `recording config set`）
 * - 拉取状态：`<拉取目录>/.micloud-recording.json`（自动生成、跟拉取目录 1:1 绑定）
 */
const STATE_FILENAME = ".micloud-recording.json";
/** 合并前的独立录音工具写的状态文件，读取时兼容 */
const LEGACY_STATE_FILENAME = ".mi-recording-cli.state.json";
export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 8;

export const CONFIG_KEYS = ["output", "fileNameTemplate", "concurrency"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

// ============ 配置 ============

/** 读取录音配置；字段类型不对的忽略（消费者用 `??` 回落默认值） */
export async function loadRecordingConfig(): Promise<RecordingConfig> {
  const raw = await loadSection("recording");
  const cfg: RecordingConfig = {};
  if (typeof raw.output === "string" && raw.output.trim()) cfg.output = raw.output;
  if (typeof raw.fileNameTemplate === "string" && raw.fileNameTemplate.trim()) cfg.fileNameTemplate = raw.fileNameTemplate;
  if (typeof raw.concurrency === "number") cfg.concurrency = raw.concurrency;
  return cfg;
}

export async function saveRecordingConfig(cfg: RecordingConfig): Promise<void> {
  await saveSection("recording", { ...cfg });
}

/** 校验并转换 `config set` 的值 */
export function parseConfigValue(key: ConfigKey, raw: string): string | number {
  switch (key) {
    case "concurrency":
      return parseConcurrency(raw);
    case "output":
    case "fileNameTemplate":
      if (!raw.trim()) throw new Error(`${key} 不能为空`);
      return raw;
  }
}

/** 并发数：1 ~ MAX_CONCURRENCY 的整数 */
export function parseConcurrency(raw: string | number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
    throw new Error(`并发数必须是 1 ~ ${MAX_CONCURRENCY} 的整数，收到：${raw}`);
  }
  return n;
}

/**
 * 解析生效的拉取目录（绝对路径）。
 * 优先级：命令行 `-o`（相对当前目录）> 配置 output（相对项目根）> `<项目根>/.micloud/recording/`
 */
export async function resolveOutputDir(cliOutput?: string): Promise<string> {
  return resolveOutputPath("recording", cliOutput, cliOutput ? undefined : (await loadRecordingConfig()).output);
}

// ============ 拉取状态 ============

/** 拉取目录内的状态文件路径 */
export function getStatePath(outputDir: string): string {
  return join(outputDir, STATE_FILENAME);
}

function emptyState(): PullState {
  return { version: 1, recordings: {} };
}

/** 拉取目录里是否有拉取记录（含合并前的旧状态文件） */
export async function hasState(outputDir: string): Promise<boolean> {
  return (await fileExists(getStatePath(outputDir))) || (await fileExists(join(outputDir, LEGACY_STATE_FILENAME)));
}

/**
 * 读取拉取目录内的状态；不存在时返回空壳，损坏时报错（避免把已拉取的录音当成新的重复下载）。
 * 只有旧状态文件时读取它，下次保存写到新文件名。
 */
export async function loadState(outputDir: string): Promise<PullState> {
  let file = getStatePath(outputDir);
  if (!(await fileExists(file))) {
    file = join(outputDir, LEGACY_STATE_FILENAME);
    if (!(await fileExists(file))) return emptyState();
  }
  const raw = await readFile(file, "utf-8");
  try {
    const parsed = JSON.parse(raw) as Partial<PullState>;
    return { version: 1, recordings: parsed.recordings ?? {} };
  } catch {
    throw new Error(`拉取状态文件已损坏：${file}。请修复或删除后重试（删除后已拉取的录音会按同名文件重新认领）`);
  }
}

/** 原子写回拉取状态（先写临时文件再改名，进程中断也不会留下半截 JSON）；写成功后移除合并前的旧状态文件 */
export async function saveState(outputDir: string, state: PullState): Promise<void> {
  await writeFileAtomic(getStatePath(outputDir), JSON.stringify(state, null, 2) + "\n");
  await rm(join(outputDir, LEGACY_STATE_FILENAME), { force: true });
}

/**
 * 独占拉取目录：同一目录同时只允许一个会写入它的命令（pull / download / delete --pulled）运行。
 * 返回释放函数。
 */
export async function lockOutputDir(outputDir: string): Promise<() => Promise<void>> {
  return await lockDir(outputDir);
}
