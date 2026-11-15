import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileExists, writeFileAtomic } from "./utils.js";

/**
 * 项目配置：`<项目根>/.micloud/config.json`，按服务分节，各节由对应服务定义和解释：
 *
 * ```json
 * { "note": { "output": "inbox/mi-notes", "syncMode": "two-way" }, "recording": { "output": "recordings" } }
 * ```
 *
 * 项目根默认是当前目录，`MICLOUD_CONFIG_DIR` 可覆盖（测试隔离用）。
 * 旧版的笔记配置 `.mi-note-cli/config.json` 在新配置没有笔记节时继续读取，写入时迁到新位置。
 */
export const CONFIG_DIRNAME = ".micloud";
const CONFIG_FILENAME = "config.json";
const LEGACY_NOTE_CONFIG = join(".mi-note-cli", "config.json");

export type ServiceName = "note" | "recording";
export type ProjectConfig = Partial<Record<ServiceName, Record<string, unknown>>>;

/** 项目根目录（配置与默认输出目录的基准） */
export function getProjectRoot(): string {
  return process.env.MICLOUD_CONFIG_DIR || process.cwd();
}

/** 项目配置文件绝对路径：`<root>/.micloud/config.json` */
export function getConfigPath(): string {
  return join(getProjectRoot(), CONFIG_DIRNAME, CONFIG_FILENAME);
}

/** 某个服务的默认输出目录：`<root>/.micloud/<service>/` */
export function getDefaultOutputDir(service: ServiceName): string {
  return join(getProjectRoot(), CONFIG_DIRNAME, service);
}

/** 读取完整项目配置；不存在或解析失败时返回空对象 */
export async function loadProjectConfig(): Promise<ProjectConfig> {
  const parsed = await readJson(getConfigPath());
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ProjectConfig) : {};
}

/** 读取某个服务的配置节（原样返回，由服务自己校验字段）；笔记节缺失时回落到旧版配置 */
export async function loadSection(service: ServiceName): Promise<Record<string, unknown>> {
  const section = (await loadProjectConfig())[service];
  if (section && typeof section === "object" && !Array.isArray(section)) return section;
  if (service === "note") {
    const legacy = await readJson(join(getProjectRoot(), LEGACY_NOTE_CONFIG));
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) return legacy as Record<string, unknown>;
  }
  return {};
}

/** 写回某个服务的配置节（其他服务的配置原样保留） */
export async function saveSection(service: ServiceName, section: Record<string, unknown>): Promise<void> {
  const config = await loadProjectConfig();
  config[service] = section;
  await writeFileAtomic(getConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

/**
 * 解析生效的输出目录（绝对路径）。
 * 优先级：命令行 `-o`（相对当前目录）> 配置 output（相对项目根）> `<root>/.micloud/<service>/`
 *
 * 两种相对基准刻意不同：命令行参数遵循终端当前位置的直觉，配置字段遵循「相对配置文件」的直觉。
 */
export function resolveOutputPath(service: ServiceName, cliOutput: string | undefined, configured: unknown): string {
  if (cliOutput) return resolve(cliOutput);
  if (typeof configured === "string" && configured.trim()) {
    return isAbsolute(configured) ? configured : resolve(getProjectRoot(), configured);
  }
  return getDefaultOutputDir(service);
}

async function readJson(file: string): Promise<unknown> {
  if (!(await fileExists(file))) return undefined;
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return undefined;
  }
}
