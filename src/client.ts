import { buildHeaders } from "./auth.js";
import { delay, randomDelay } from "./utils.js";
import type {
  ApiEnvelope,
  AuthInfo,
  BlockStorageData,
  DownloadUrlData,
  ProfileData,
  QuotaData,
  RawRecording,
  RecordingListData,
  TrashListData,
} from "./types.js";

const API_BASE = "https://i.mi.com";
const RECORDER = "/sfs/ns/recorder";
/** 与网页端一致的分页大小 */
const PAGE_SIZE = 500;
/** 分页上限，防止服务端异常时死循环 */
const MAX_PAGES = 1000;
const REQUEST_TIMEOUT = 30_000;
/** 只读 GET 遇网络错误 / 5xx 时的重试次数 */
const GET_RETRIES = 2;

/** 云空间已满（从回收站恢复时出现） */
export const CODE_SPACE_FULL = 50006;

const KNOWN_ERRORS: Record<number, string> = {
  50202: "录音不存在（可能已被删除，或 id 有误）",
  [CODE_SPACE_FULL]: "云空间已满",
};

/**
 * 登录态失效时的续期回调：成功返回新的 AuthInfo，失败返回 null。
 * 由上层注入（通常是静默重开持久化浏览器换发 serviceToken）。
 */
export type AuthRefresher = () => Promise<AuthInfo | null>;

/** 小米云服务返回的业务错误（HTTP 200 但 code 非 0） */
export class MiApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly retriable = false,
  ) {
    super(message);
    this.name = "MiApiError";
  }
}

/** 登录态失效且无法静默续期：后续请求都会失败，批量操作应立即停止 */
export class AuthExpiredError extends Error {
  constructor() {
    super("登录态已过期，请重新登录（mi-recording-cli login）");
    this.name = "AuthExpiredError";
  }
}

/**
 * 小米云录音 API 客户端（端点来自 i.mi.com/record 网页端）。
 *
 * - 读：GET，query 带 ts 防缓存
 * - 写：POST + application/x-www-form-urlencoded，body 携带 serviceToken
 * - 删除是两段式：`file/{id}/delete` 移入回收站（ver 会变）→ 回收站里用新 ver `recover` 恢复或 `purge` 永久删除
 * - 登录态失效（401）时，若注入了 refresher，会静默续期并自动重试一次
 */
export class MiRecordingClient {
  constructor(
    private auth: AuthInfo,
    private readonly refresher?: AuthRefresher,
  ) {}

  get userId(): string {
    return this.auth.userId;
  }

  // ============ 读 ============

  /** 列出全部云端录音（offset 分页，单页不满即为最后一页） */
  async listRecordings(onProgress?: (count: number) => void): Promise<RawRecording[]> {
    const all: RawRecording[] = [];
    const seen = new Set<string>();
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await this.get<RecordingListData>(`${RECORDER}/dir/0/list`, {
        offset,
        limit: PAGE_SIZE,
        _dc: Date.now(),
      });
      const list = data.list ?? [];
      for (const item of list) {
        const id = String(item.id);
        if (seen.has(id)) continue;
        seen.add(id);
        all.push({ ...item, id });
      }
      onProgress?.(all.length);
      if (list.length < PAGE_SIZE) break;
      offset += list.length;
      await randomDelay(200);
    }
    return all;
  }

  /** 列出回收站（最近删除）里的录音（syncToken 分页，响应不再带 syncToken 即为最后一页） */
  async listTrash(onProgress?: (count: number) => void): Promise<RawRecording[]> {
    const all: RawRecording[] = [];
    const seen = new Set<string>();
    let syncToken = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await this.get<TrashListData>(`${RECORDER}/deleted`, {
        syncToken,
        limit: PAGE_SIZE,
      });
      for (const item of data.list ?? []) {
        const id = String(item.id);
        if (seen.has(id)) continue;
        seen.add(id);
        all.push({ ...item, id });
      }
      onProgress?.(all.length);
      const next = data.syncToken;
      if (!next || next === syncToken) break;
      syncToken = next;
      await randomDelay(200);
    }
    return all;
  }

  /** 获取录音的临时直链（预签名，无需 cookie，支持 Range；实测约 4 小时有效） */
  async getDownloadUrl(id: string): Promise<string> {
    const data = await this.get<DownloadUrlData>(`${RECORDER}/file/${encodeURIComponent(id)}/storage/geturl`);
    if (!data.url) throw new MiApiError(`未拿到录音 ${id} 的下载地址`);
    return data.url;
  }

  /** 分块下载凭证；账号开启「高级数据保护」（端到端加密）时带 encryptInfo，用于诊断 */
  async getBlockStorage(id: string): Promise<BlockStorageData> {
    return await this.get<BlockStorageData>(`${RECORDER}/file/${encodeURIComponent(id)}/block/storage`);
  }

  /** 云空间用量与会员等级 */
  async getQuota(): Promise<QuotaData> {
    return await this.get<QuotaData>("/status/alldetail");
  }

  /** 账号昵称与头像 */
  async getProfile(): Promise<ProfileData> {
    return await this.get<ProfileData>("/status/lite/profile");
  }

  // ============ 写 ============

  /** 删除录音：移入回收站（网页端同样只做软删除，永久删除需再对回收站条目 purge） */
  async deleteRecording(id: string): Promise<void> {
    await this.post(`${RECORDER}/file/${encodeURIComponent(id)}/delete`, { permanent: "false" });
  }

  /** 从回收站恢复；ver 必须取回收站条目当前的 ver */
  async recoverRecording(id: string, ver: string): Promise<void> {
    await this.post(`${RECORDER}/deleted/${encodeURIComponent(id)}/${encodeURIComponent(ver)}/recover`);
  }

  /** 从回收站永久删除（不可恢复）；ver 必须取回收站条目当前的 ver */
  async purgeRecording(id: string, ver: string): Promise<void> {
    await this.post(`${RECORDER}/deleted/${encodeURIComponent(id)}/${encodeURIComponent(ver)}/purge`);
  }

  // ============ 底层请求 ============

  /**
   * 执行一次带登录态的请求；遇 401 且有 refresher 时静默续期并重试一次。
   * @param send 用当前登录态发请求，返回 Response
   */
  private async requestWithRetry(send: () => Promise<Response>): Promise<Response> {
    let resp = await send();
    if (resp.status === 401 && this.refresher) {
      await discardResponseBody(resp);
      const newAuth = await this.refresher();
      if (newAuth) {
        this.auth = newAuth;
        resp = await send();
      }
    }
    if (resp.status === 401) {
      await discardResponseBody(resp);
      throw new AuthExpiredError();
    }
    return resp;
  }

  private async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) params.set(key, String(value));
    for (let attempt = 0; ; attempt++) {
      params.set("ts", String(Date.now()));
      const url = `${API_BASE}${path}?${params}`;
      try {
        const resp = await this.requestWithRetry(() =>
          fetch(url, {
            headers: buildHeaders(this.auth.cookie),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT),
          }),
        );
        if (!resp.ok) {
          await discardResponseBody(resp);
          throw new MiApiError(`请求失败 ${resp.status} ${resp.statusText}`, undefined, resp.status >= 500);
        }
        return unwrapEnvelope<T>(await parseJsonResponse(resp));
      } catch (err) {
        if (attempt >= GET_RETRIES || !isRetriable(err)) throw err;
        await delay(500 * 3 ** attempt);
      }
    }
  }

  private async post<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    // serviceToken 随 cookie 续期一起更新，故每次发送时重新取值构造 body
    const send = (): Promise<Response> =>
      fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: {
          ...buildHeaders(this.auth.cookie),
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: new URLSearchParams({ ...params, serviceToken: this.auth.serviceToken }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
    const resp = await this.requestWithRetry(send);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new MiApiError(`请求失败 ${resp.status}: ${text.slice(0, 200)}`);
    }
    return unwrapEnvelope<T>(await parseJsonResponse(resp));
  }
}

/** 批量操作遇到这类错误时应立即停止：登录态失效后续请求都会失败 */
export function isFatalError(err: unknown): boolean {
  return err instanceof AuthExpiredError;
}

/** 拆开 `{ code, data }` 信封：code 为 0 返回 data，否则抛 MiApiError（与网页端请求层一致） */
export function unwrapEnvelope<T>(json: unknown): T {
  if (!json || typeof json !== "object") {
    throw new MiApiError(`服务端返回了无法识别的响应：${String(json).slice(0, 120)}`);
  }
  const env = json as ApiEnvelope<T> & { data?: { redirectUrl?: string } };
  if (typeof env.code === "number") {
    if (env.code === 0) return (env.data ?? {}) as T;
    if (env.code === 308) {
      const target = env.data?.redirectUrl ?? "其他区域";
      throw new MiApiError(`该账号的数据位于其他区域的小米云服务（${target}），本工具目前只支持 i.mi.com`, 308);
    }
    const known = KNOWN_ERRORS[env.code];
    const detail = env.description || env.reason || env.result || "未知错误";
    throw new MiApiError(known ?? `小米云服务返回错误 ${env.code}：${detail}`, env.code, env.retriable === true);
  }
  if (env.result === "ok") return (env.data ?? {}) as T;
  return json as T;
}

function isRetriable(err: unknown): boolean {
  if (err instanceof MiApiError) return err.retriable;
  if (!(err instanceof Error)) return false;
  // fetch 网络层失败（TypeError: fetch failed）与超时
  return err.name === "TypeError" || err.name === "TimeoutError" || err.name === "AbortError";
}

/**
 * 解析响应体为 JSON。服务端降级 / 网关错误时可能返回 HTML 而非 JSON，
 * 此时 resp.json() 会抛出晦涩的 SyntaxError，这里转成可读错误。
 */
async function parseJsonResponse(resp: Response): Promise<unknown> {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, " ").trim();
    throw new MiApiError(`服务端返回了非 JSON 响应（可能是登录态失效或服务异常）：${preview}`, undefined, true);
  }
}

async function discardResponseBody(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {
    // ignore cleanup errors
  }
}
