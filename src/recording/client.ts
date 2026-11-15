import { getQuota, type QuotaData } from "../core/account.js";
import { MiCloudHttp, MiApiError, unwrapEnvelope, type AuthRefresher } from "../core/http.js";
import { randomDelay } from "../core/utils.js";
import type { AuthInfo } from "../core/auth.js";
import type { BlockStorageData, DownloadUrlData, RawRecording, RecordingListData, TrashListData } from "./types.js";

const RECORDER = "/sfs/ns/recorder";
/** 与网页端一致的分页大小 */
const PAGE_SIZE = 500;
/** 分页上限，防止服务端异常时死循环 */
const MAX_PAGES = 1000;

/** 云空间已满（从回收站恢复时出现） */
export const CODE_SPACE_FULL = 50006;

const KNOWN_ERRORS: Record<number, string> = {
  50202: "录音不存在（可能已被删除，或 id 有误）",
  [CODE_SPACE_FULL]: "云空间已满",
};

/**
 * 小米云录音 API 客户端（端点来自 i.mi.com/record 网页端）。
 *
 * - 删除是两段式：`file/{id}/delete` 移入回收站（ver 会变）→ 回收站里用新 ver `recover` 恢复或 `purge` 永久删除
 * - 登录态续期、超时与重试由 MiCloudHttp 负责
 */
export class MiRecordingClient {
  private readonly http: MiCloudHttp;

  constructor(auth: AuthInfo, refresher?: AuthRefresher) {
    this.http = new MiCloudHttp(auth, refresher, "https://i.mi.com/record");
  }

  get userId(): string {
    return this.http.userId;
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
      const data = await this.get<TrashListData>(`${RECORDER}/deleted`, { syncToken, limit: PAGE_SIZE });
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

  /** 云空间用量与会员等级（会员等级决定回收站保留天数） */
  async getQuota(): Promise<QuotaData> {
    return await getQuota(this.http);
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

  // ============ 底层 ============

  private async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    return await this.http.getJson(path, query, (json) => unwrapEnvelope<T>(json, KNOWN_ERRORS));
  }

  private async post<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    return unwrapEnvelope<T>(await this.http.postForm(path, params), KNOWN_ERRORS);
  }
}
