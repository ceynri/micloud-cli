import { rmSync } from "node:fs";
import { open, readFile, rm, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { ensureDir } from "./utils.js";

const LOCK_FILENAME = ".micloud.lock";
/** 读不出内容的锁文件超过这个时间仍没写完，视为持锁进程已异常退出 */
const ABANDONED_AFTER = 60_000;

/**
 * 独占输出目录：同一目录同时只允许一个会写入它的命令运行，
 * 避免两个进程各自持有旧状态、互相覆盖，或并发写同一个文件。
 * 持锁进程已退出（同一台机器上 pid 不存在）时自动接管残留的锁。返回释放函数。
 */
export async function lockDir(dir: string): Promise<() => Promise<void>> {
  await ensureDir(dir);
  const file = join(dir, LOCK_FILENAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: FileHandle;
    try {
      handle = await open(file, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = await readLock(file);
      if (holder ? isStale(holder) : await isAbandoned(file)) {
        await rm(file, { force: true });
        continue;
      }
      const who = holder ? `（pid ${holder.pid}${holder.host && holder.host !== hostname() ? `@${holder.host}` : ""}）` : "";
      throw new Error(`目录正被另一个 micloud 进程使用${who}：${dir}。请等它结束；确认没有在运行时可删除 ${file}`);
    }

    // 一创建就登记退出清理，之后任何一步失败（含被 Ctrl+C 结束）都不会留下锁
    let released = false;
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
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() }));
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await release();
      throw err;
    }
    return release;
  }
  throw new Error(`无法锁定目录：${dir}`);
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

async function isAbandoned(file: string): Promise<boolean> {
  const st = await stat(file).catch(() => null);
  return !st || Date.now() - st.mtimeMs > ABANDONED_AFTER;
}
