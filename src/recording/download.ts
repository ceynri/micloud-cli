import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdtemp, open, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { AuthExpiredError, MiApiError } from "../core/http.js";
import { delay, ensureFileDir } from "../core/utils.js";
import type { BlockStorageData } from "./types.js";

/** 连续这么久收不到数据即视为卡住 */
const IDLE_TIMEOUT = 60_000;
const DOWNLOAD_ATTEMPTS = 3;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const E2EE_MESSAGE =
  "该账号开启了「高级数据保护」（端到端加密），录音内容需在已登录的手机或小米云服务电脑客户端上解密，本工具暂不支持下载";

/** 下载内容与云端记录的大小 / SHA-1 不一致 */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

/** 下载节点返回非成功状态（如直链过期的 403） */
export class DownloadHttpError extends Error {
  constructor(readonly status: number) {
    super(`下载失败：HTTP ${status}`);
    this.name = "DownloadHttpError";
  }
}

/** 目标位置在下载期间出现了内容不同的文件 */
export class TargetExistsError extends Error {
  constructor(path: string) {
    super(`目标位置已有内容不同的文件，未覆盖：${path}`);
    this.name = "TargetExistsError";
  }
}

export interface ExpectedContent {
  size: number;
  /** 缺省时只校验大小 */
  sha1?: string;
}

/** fetchRecording 需要的最小客户端能力（便于测试替身） */
export interface DownloadSource {
  getDownloadUrl(id: string): Promise<string>;
  getBlockStorage?(id: string): Promise<BlockStorageData>;
}

/**
 * 把直链内容下载到 dest：先写 `<dest>.part`，写完后**按磁盘上的文件**校验大小与 SHA-1，通过才放到正式位置，
 * 因此正式文件一旦出现就是完整的（即使有其他进程同时写同一个 `.part`，校验也会失败而不会放行）。
 * 已有 `.part` 时用 Range 断点续传，大小已齐的直接校验；服务端忽略或答非所问（206 起点不符）时丢弃 `.part` 从头下载。
 * 放置时绝不覆盖：dest 已有相同内容视为完成，内容不同则报 TargetExistsError。
 * @param onProgress 回调该文件已就绪的字节数（含续传前已有的部分）
 */
export async function downloadToFile(
  url: string,
  dest: string,
  expected: ExpectedContent,
  onProgress?: (bytes: number) => void,
): Promise<void> {
  const part = `${dest}.part`;
  await ensureFileDir(dest);

  let offset = 0;
  const partStat = await stat(part).catch(() => null);
  if (partStat?.isFile() && partStat.size === expected.size && (await sameContent(part, expected))) {
    // 上次已下载完整、但没来得及放到正式位置
    onProgress?.(expected.size);
    await placeWithoutOverwrite(part, dest, expected);
    return;
  }
  if (partStat?.isFile() && partStat.size > 0 && partStat.size < expected.size) {
    offset = partStat.size;
  } else if (partStat) {
    await rm(part, { recursive: true, force: true });
  }

  const watchdog = new Watchdog(IDLE_TIMEOUT);
  try {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (offset > 0) headers.Range = `bytes=${offset}-`;
    let resp = await fetch(url, { headers, signal: watchdog.signal });

    if (offset > 0 && !(resp.status === 206 && rangeStartsAt(resp, offset))) {
      if (resp.status !== 200) {
        // 续传请求被答非所问：丢弃 .part，不带 Range 从头再来
        await discard(resp);
        resp = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: watchdog.signal });
      }
      offset = 0;
    }
    if (offset === 0 && resp.status !== 200) {
      await discard(resp);
      throw new DownloadHttpError(resp.status);
    }
    if (!resp.body) throw new Error("下载响应没有内容");

    let received = offset;
    onProgress?.(received);
    await pipeline(
      toNodeStream(resp.body),
      meter((n) => {
        watchdog.kick();
        received += n;
        onProgress?.(received);
      }),
      createWriteStream(part, { flags: offset > 0 ? "a" : "w" }),
    );

    await verifyFile(part, expected);
    await placeWithoutOverwrite(part, dest, expected);
  } catch (err) {
    if (err instanceof IntegrityError) await rm(part, { force: true });
    throw watchdog.reason(err);
  } finally {
    watchdog.stop();
  }
}

/**
 * 校验通过的 `.part` 放到正式位置，不覆盖任何已有文件：
 * 用硬链接实现「目标不存在才创建」的原子操作；目标已存在且内容相同视为完成。
 * 文件系统不支持硬链接（如 exFAT、部分网络盘）时，先独占创建占位文件再改名覆盖这个占位文件，
 * 同样不会覆盖别人的文件。
 */
async function placeWithoutOverwrite(part: string, dest: string, expected: ExpectedContent): Promise<void> {
  try {
    await link(part, dest);
    await unlink(part);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return await settleExisting(part, dest, expected);
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EMLINK"].includes(code ?? "")) throw err;
  }
  try {
    await (await open(dest, "wx")).close();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return await settleExisting(part, dest, expected);
    throw err;
  }
  try {
    await rename(part, dest);
  } catch (err) {
    await rm(dest, { force: true });
    throw err;
  }
}

/** 目标位置已有文件：内容相同视为完成，否则报错且不动它 */
async function settleExisting(part: string, dest: string, expected: ExpectedContent): Promise<void> {
  if (await sameContent(dest, expected)) {
    await unlink(part);
    return;
  }
  throw new TargetExistsError(dest);
}

async function sameContent(path: string, expected: ExpectedContent): Promise<boolean> {
  const st = await stat(path).catch(() => null);
  if (!st?.isFile() || st.size !== expected.size) return false;
  return !expected.sha1 || (await sha1File(path)) === expected.sha1.toLowerCase();
}

/**
 * 把录音内容写到给定流（如 stdout）：先完整下载到临时文件并校验大小与 SHA-1，
 * 通过后才开始输出，校验失败时不输出任何字节，下游不会拿到残缺或错误的音频。
 */
export async function downloadToStream(
  source: DownloadSource,
  recording: { id: string; size: number; sha1?: string },
  out: Writable,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "micloud-recording-"));
  try {
    const file = join(dir, "audio");
    await fetchRecording(source, recording, file);
    await pipeline(createReadStream(file), out, { end: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 下载一条录音到 dest，失败自动重试（每次重新获取直链，规避直链过期）。
 * 校验失败或接口报错时检查账号是否开启了端到端加密，是则直接给出明确原因。
 */
export async function fetchRecording(
  source: DownloadSource,
  recording: { id: string; size: number; sha1?: string },
  dest: string,
  onProgress?: (bytes: number) => void,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const url = await source.getDownloadUrl(recording.id);
      await downloadToFile(url, dest, { size: recording.size, sha1: recording.sha1 }, onProgress);
      return;
    } catch (err) {
      lastError = err;
      if (
        attempt === 1 &&
        (err instanceof IntegrityError || err instanceof MiApiError) &&
        (await isEndToEndEncrypted(source, recording.id))
      ) {
        throw new Error(E2EE_MESSAGE);
      }
      if (!isRetriableDownloadError(err) || attempt === DOWNLOAD_ATTEMPTS) break;
      await delay(1000 * attempt);
    }
  }
  throw lastError;
}

/** 下载失败是否值得重试：业务错误、登录失效、目标被占用、本地磁盘问题不重试 */
export function isRetriableDownloadError(err: unknown): boolean {
  if (err instanceof MiApiError) return err.retriable;
  if (err instanceof AuthExpiredError || err instanceof TargetExistsError) return false;
  if (err instanceof DownloadHttpError) {
    return err.status === 403 || err.status === 408 || err.status === 429 || err.status >= 500;
  }
  if (!(err instanceof Error)) return false;
  if (err.message === E2EE_MESSAGE) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && ["ENOSPC", "EACCES", "EPERM", "EROFS", "EISDIR", "ENOTDIR", "ENAMETOOLONG", "EMFILE", "EINVAL"].includes(code)) {
    return false;
  }
  return true;
}

/** 计算本地文件的 SHA-1 */
export async function sha1File(path: string): Promise<string> {
  const hash = createHash("sha1");
  await hashFile(path, hash);
  return hash.digest("hex");
}

/** 本地文件是否与云端录音一致（大小 + SHA-1） */
export async function matchesLocalFile(path: string, expected: ExpectedContent): Promise<boolean> {
  return await sameContent(path, expected);
}

/** 直链 query 里的 ts 是过期时间（毫秒），取不到时返回 undefined */
export function urlExpiresAt(url: string): number | undefined {
  try {
    const ts = Number(new URL(url).searchParams.get("ts"));
    return Number.isFinite(ts) && ts > 1e12 ? ts : undefined;
  } catch {
    return undefined;
  }
}

// ============ 内部 ============

async function isEndToEndEncrypted(source: DownloadSource, id: string): Promise<boolean> {
  if (!source.getBlockStorage) return false;
  try {
    return Boolean((await source.getBlockStorage(id)).encryptInfo);
  } catch {
    return false;
  }
}

/** 按磁盘上的文件校验大小与 SHA-1 */
async function verifyFile(path: string, expected: ExpectedContent): Promise<void> {
  const { size } = await stat(path);
  if (size !== expected.size) {
    throw new IntegrityError(`下载内容大小不符：期望 ${expected.size} 字节，实际 ${size} 字节`);
  }
  if (!expected.sha1) return;
  const actual = await sha1File(path);
  if (actual !== expected.sha1.toLowerCase()) {
    throw new IntegrityError(`下载内容 SHA-1 校验失败：期望 ${expected.sha1}，实际 ${actual}`);
  }
}

function rangeStartsAt(resp: Response, offset: number): boolean {
  const range = resp.headers.get("content-range") ?? "";
  return new RegExp(`^bytes\\s+${offset}-`).test(range);
}

async function hashFile(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

function meter(onChunk: (bytes: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onChunk(chunk.length);
      callback(null, chunk);
    },
  });
}

function toNodeStream(body: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>);
}

async function discard(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {
    // ignore
  }
}

/** 空闲超时：一段时间内没有 kick 就中止请求 */
class Watchdog {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private fired = false;

  constructor(private readonly timeoutMs: number) {
    this.kick();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  kick(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.fired = true;
      this.controller.abort();
    }, this.timeoutMs);
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  /** 超时引发的中止错误替换为可读信息 */
  reason(err: unknown): unknown {
    return this.fired ? new Error(`下载超时：${this.timeoutMs / 1000} 秒内没有收到数据`) : err;
  }
}
