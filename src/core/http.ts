import { buildHeaders, type AuthInfo } from "./auth.js";
import { delay } from "./utils.js";

export const API_BASE = "https://i.mi.com";
const REQUEST_TIMEOUT = 30_000;
/** 只读 GET 遇网络错误 / 5xx / 非 JSON 响应时的重试次数 */
const GET_RETRIES = 2;

/**
 * 登录态失效时的续期回调：成功返回新的 AuthInfo，失败返回 null。
 * 由上层注入（通常是静默重开持久化浏览器换发 serviceToken）。
 */
export type AuthRefresher = () => Promise<AuthInfo | null>;

/** i.mi.com 通用响应信封：code 为 0（或 result 为 "ok"）表示成功 */
export interface ApiEnvelope<T> {
  result?: string;
  code?: number;
  retriable?: boolean;
  description?: string;
  reason?: string;
  ts?: number;
  data?: T;
}

/** 小米云服务返回的业务错误或 HTTP 错误 */
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
    super("登录态已过期，请重新登录（micloud login）");
    this.name = "AuthExpiredError";
  }
}

/** 批量操作遇到这类错误时应立即停止：登录态失效后续请求都会失败 */
export function isFatalError(err: unknown): boolean {
  return err instanceof AuthExpiredError;
}

/**
 * i.mi.com 带登录态的请求层（各服务的客户端共用）：
 * - 请求带 cookie 与浏览器请求头，30 秒超时；
 * - 遇 401 时用 refresher 静默续期并重试一次，仍失败抛 AuthExpiredError；
 * - GET 只读，遇网络错误、超时、5xx、非 JSON 响应自动重试；POST 是写操作，不重试；
 * - POST 为 application/x-www-form-urlencoded，body 自动带上当前的 serviceToken（续期后随之更新）。
 */
export class MiCloudHttp {
  constructor(
    private auth: AuthInfo,
    private readonly refresher?: AuthRefresher,
    private readonly referer = `${API_BASE}/`,
  ) {}

  get userId(): string {
    return this.auth.userId;
  }

  /**
   * GET 并解析 JSON；query 自动带 ts 防缓存。
   * parse 在重试范围内执行：抛出 retriable 的 MiApiError（如信封里 retriable: true）时同样会重试。
   */
  async getJson<T>(
    path: string,
    query: Record<string, string | number> = {},
    parse: (json: unknown) => T = (json) => json as T,
  ): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) params.set(key, String(value));
    for (let attempt = 0; ; attempt++) {
      params.set("ts", String(Date.now()));
      const url = `${API_BASE}${path}?${params}`;
      try {
        const resp = await this.send(() =>
          fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(REQUEST_TIMEOUT) }),
        );
        if (!resp.ok) {
          await discardBody(resp);
          throw new MiApiError(`请求失败 ${resp.status} ${resp.statusText}`, undefined, resp.status >= 500);
        }
        return parse(await parseJsonResponse(resp));
      } catch (err) {
        if (attempt >= GET_RETRIES || !isRetriable(err)) throw err;
        await delay(500 * 3 ** attempt);
      }
    }
  }

  /** 表单 POST 并解析 JSON；body 自动带上 serviceToken */
  async postForm<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const resp = await this.send(() => {
      // serviceToken 随 cookie 续期一起更新，故每次发送时重新取值构造 body
      const body = Object.entries({ ...params, serviceToken: this.auth.serviceToken })
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      return fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new MiApiError(`请求失败 ${resp.status}: ${text.slice(0, 200)}`);
    }
    return (await parseJsonResponse(resp)) as T;
  }

  /** 带登录态请求任意地址（如附件下载），返回原始响应；不设超时、不重试 */
  async fetchRaw(url: string, init: RequestInit = {}): Promise<Response> {
    return await this.send(() =>
      fetch(url, { ...init, headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) } }),
    );
  }

  private headers(): Record<string, string> {
    return buildHeaders(this.auth.cookie, this.referer);
  }

  /** 发送一次请求；遇 401 且有 refresher 时静默续期并用新登录态重试一次 */
  private async send(request: () => Promise<Response>): Promise<Response> {
    let resp = await request();
    if (resp.status === 401 && this.refresher) {
      await discardBody(resp);
      const fresh = await this.refresher();
      if (fresh) {
        this.auth = fresh;
        resp = await request();
      }
    }
    if (resp.status === 401) {
      await discardBody(resp);
      throw new AuthExpiredError();
    }
    return resp;
  }
}

/**
 * 拆开 `{ code, data }` 信封：code 为 0 返回 data，否则抛 MiApiError（与网页端请求层一致）。
 * @param knownErrors 服务特有错误码的可读说明
 */
export function unwrapEnvelope<T>(json: unknown, knownErrors: Record<number, string> = {}): T {
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
    const known = knownErrors[env.code];
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

async function discardBody(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {
    // ignore cleanup errors
  }
}
