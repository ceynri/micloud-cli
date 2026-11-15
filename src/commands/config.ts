import { resolveOutputDir, loadState, loadUserConfig, saveUserConfig, getUserConfigPath, getStatePath, CONFIG_KEYS, DEFAULT_CONCURRENCY, parseConfigValue, type ConfigKey } from "../config.js";
import { DEFAULT_FILE_NAME_TEMPLATE } from "../template.js";
import { success, logInfo, fail } from "../output.js";
import { formatTime } from "../utils.js";
import type { UserConfig } from "../types.js";

/** config：查看生效配置与拉取状态 */
export async function configShowCommand(opts: { output?: string } = {}): Promise<void> {
  try {
    const cfg = await loadUserConfig();
    const outputDir = await resolveOutputDir(opts.output);
    const state = await loadState(outputDir);
    const pulled = Object.values(state.recordings);
    const lastPulledAt = pulled.reduce((max, r) => Math.max(max, r.pulledAt), 0);
    const data = {
      configFile: getUserConfigPath(),
      config: cfg,
      effective: {
        output: outputDir,
        fileNameTemplate: cfg.fileNameTemplate ?? DEFAULT_FILE_NAME_TEMPLATE,
        concurrency: cfg.concurrency ?? DEFAULT_CONCURRENCY,
      },
      state: {
        file: getStatePath(outputDir),
        pulledCount: pulled.length,
        cloudDeletedCount: pulled.filter((r) => r.cloudDeletedAt).length,
        lastPulledAt: lastPulledAt || null,
      },
    };
    success(data, () => {
      logInfo(`配置文件：${data.configFile}${Object.keys(cfg).length ? "" : "（未创建，使用默认值）"}`);
      logInfo(`拉取目录：${outputDir}${opts.output || cfg.output ? "" : "（默认）"}`);
      logInfo(`文件名模板：${data.effective.fileNameTemplate}`);
      logInfo(`并发下载数：${data.effective.concurrency}`);
      logInfo(
        `已拉取：${pulled.length} 条${data.state.cloudDeletedCount ? `（其中 ${data.state.cloudDeletedCount} 条已删除云端副本）` : ""}` +
          `${lastPulledAt ? `，最近一次 ${formatTime(lastPulledAt)}` : ""}`,
      );
    });
  } catch (err) {
    fail(err);
  }
}

/** config set <key> <value> */
export async function configSetCommand(key: string, value: string): Promise<void> {
  try {
    const k = parseKey(key);
    const cfg = await loadUserConfig();
    (cfg as Record<string, unknown>)[k] = parseConfigValue(k, value);
    await saveUserConfig(cfg);
    success({ configFile: getUserConfigPath(), config: cfg }, () => logInfo(`✅ 已设置 ${k} = ${cfg[k as keyof UserConfig]}`));
  } catch (err) {
    fail(err);
  }
}

/** config unset <key> */
export async function configUnsetCommand(key: string): Promise<void> {
  try {
    const k = parseKey(key);
    const cfg = await loadUserConfig();
    delete (cfg as Record<string, unknown>)[k];
    await saveUserConfig(cfg);
    success({ configFile: getUserConfigPath(), config: cfg }, () => logInfo(`✅ 已移除 ${k}，恢复默认值`));
  } catch (err) {
    fail(err);
  }
}

function parseKey(key: string): ConfigKey {
  if (!CONFIG_KEYS.includes(key as ConfigKey)) {
    throw new Error(`未知配置项：${key}（可选：${CONFIG_KEYS.join(" / ")}）`);
  }
  return key as ConfigKey;
}
