import { rmSync } from "node:fs";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { hostname } from "node:os";
import { ensureDir, ensureFileDir } from "./utils.js";
import type { PullState, UserConfig } from "./types.js";

/**
 * 两类元数据按位置与归属拆分：
 *
 * - 用户配置：项目根 `.mi-recording-cli/config.json`（手写或 `config set`，可随项目共享）
 * - 拉取状态：`<output>/.mi-recording-cli.state.json`（自动生成、跟拉取目录 1:1 绑定）
 *
 * `MI_RECORDING_CLI_CONFIG_DIR` 环境变量可覆盖项目根，便于测试隔离。
 */
const CONFIG_DIRNAME = ".mi-recording-cli";
const CONFIG_FILENAME = "config.json";
const STATE_FILENAME = ".mi-recording-cli.state.json";
const LOCK_FILENAME = ".mi-recording-cli.lock";
const DEFAULT_OUTPUT_SUBDIR = "output";
export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 8;

export const CONFIG_KEYS = ["output", "fileNameTemplate", "concurrency"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

// ============ 路径解析 ============

/** 项目根目录（用户配置与默认拉取目录的基准） */
export function getProjectRoot(): string {
  return process.env.MI_RECORDING_CLI_CONFIG_DIR || process.cwd();
}

/** 用户配置文件绝对路径：`<root>/.mi-recording-cli/config.json` */
export function getUserConfigPath(): string {
  return join(getProjectRoot(), CONFIG_DIRNAME, CONFIG_FILENAME);
}

/** 默认拉取目录：`<root>/.mi-recording-cli/output/` */
export function getDefaultOutputDir(): string {
  return join(getProjectRoot(), CONFIG_DIRNAME, DEFAULT_OUTPUT_SUBDIR);
}

/** 拉取目录内的状态文件路径 */
export function getStatePath(outputDir: string): string {
  return join(outputDir, STATE_FILENAME);
}

// ============ 用户配置 ============

/** 读取项目用户配置；不存在或解析失败时返回空对象（消费者用 `??` 回落默认值） */
export async function loadUserConfig(): Promise<UserConfig> {
  try {
    const parsed = JSON.parse(await readFile(getUserConfigPath(), "utf-8")) as Partial<UserConfig>;
    const cfg: UserConfig = {};
    if (typeof parsed.output === "string" && parsed.output.trim()) cfg.output = parsed.output;
    if (typeof parsed.fileNameTemplate === "string" && parsed.fileNameTemplate.trim()) {
      cfg.fileNameTemplate = parsed.fileNameTemplate;
    }
    if (typeof parsed.concurrency === "number") cfg.concurrency = parsed.concurrency;
    return cfg;
  } catch {
    return {};
  }
}

/** 写入用户配置（自动创建 .mi-recording-cli 目录） */
export async function saveUserConfig(cfg: UserConfig): Promise<void> {
  const file = getUserConfigPath();
  await ensureFileDir(file);
  await writeFile(file, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
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
 * 优先级：CLI `-o <dir>`（相对当前目录）> 用户配置 output（相对项目根）> `<root>/.mi-recording-cli/output/`
 */
export async function resolveOutputDir(cliOutput?: string): Promise<string> {
  if (cliOutput) return resolve(cliOutput);
  const cfg = await loadUserConfig();
  if (cfg.output) {
    return isAbsolute(cfg.output) ? cfg.output : resolve(getProjectRoot(), cfg.output);
  }
  return getDefaultOutputDir();
}

// ============ 拉取状态 ============

function emptyState(): PullState {
  return { version: 1, recordings: {} };
}

/** 读取拉取目录内的状态；不存在时返回空壳，损坏时报错（避免把已拉取的录音当成新的重复下载） */
export async function loadState(outputDir: string): Promise<PullState> {
  const file = getStatePath(outputDir);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PullState>;
    return { version: 1, recordings: parsed.recordings ?? {} };
  } catch {
    throw new Error(`拉取状态文件已损坏：${file}。请修复或删除后重试（删除后已拉取的录音会按同名文件重新认领）`);
  }
}

/** 原子写回拉取状态（先写临时文件再改名，进程中断也不会留下半截 JSON） */
export async function saveState(outputDir: string, state: PullState): Promise<void> {
  await ensureDir(outputDir);
  const file = getStatePath(outputDir);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  await rename(tmp, file);
}

// ============ 拉取目录锁 ============

/**
 * 独占拉取目录：同一目录同时只允许一个会读写拉取状态的命令（pull / delete --pulled）运行，
 * 避免两个进程各自持有旧状态、互相覆盖，或并发写同一个 `.part`。
 * 持锁进程已退出（同一台机器上 pid 不存在）时自动接管残留的锁。返回释放函数。
 */
export async function lockOutputDir(outputDir: string): Promise<() => Promise<void>> {
  await ensureDir(outputDir);
  const file = join(outputDir, LOCK_FILENAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() }));
      await handle.close();
      let released = false;
      // 进程被 Ctrl+C 等方式结束时也要清掉锁，避免残留
      const onExit = (): void => {
        if (released) return;
        try {
          rmSync(file, { force: true });
        } catch {
          // ignore
        }
      };
      process.once("exit", onExit);
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        process.off("exit", onExit);
        await rm(file, { force: true });
      };
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = await readLock(file);
      if (holder && isStale(holder)) {
        await rm(file, { force: true });
        continue;
      }
      const who = holder ? `（pid ${holder.pid}${holder.host && holder.host !== hostname() ? `@${holder.host}` : ""}）` : "";
      throw new Error(
        `拉取目录正被另一个 mi-recording-cli 进程使用${who}：${outputDir}。` +
          `请等它结束；确认没有在运行时可删除 ${file}`,
      );
    }
  }
  throw new Error(`无法锁定拉取目录：${outputDir}`);
}

interface LockInfo {
  pid: number;
  host?: string;
  startedAt?: number;
}

async function readLock(file: string): Promise<LockInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as LockInfo;
    return typeof parsed.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** 同一台机器上持锁进程已不存在 */
function isStale(lock: LockInfo): boolean {
  if (lock.host && lock.host !== hostname()) return false;
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}
