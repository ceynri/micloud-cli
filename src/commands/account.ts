import { ensureAuth, peekOrRefreshAuth, clearAuthCache, refreshAuth } from "../core/auth.js";
import {
  getProfile,
  getQuota,
  LEVEL_NAMES,
  TRASH_RETENTION_DAYS,
  type ProfileData,
  type QuotaData,
} from "../core/account.js";
import { MiCloudHttp } from "../core/http.js";
import { success, logInfo, fail } from "../core/output.js";
import { formatBytes } from "../core/utils.js";

/** login：强制打开浏览器登录，刷新缓存 */
export async function loginCommand(): Promise<void> {
  try {
    const auth = await ensureAuth(true);
    success({ loggedIn: true, userId: auth.userId }, () => {
      logInfo(`✅ 登录成功${auth.userId ? `（userId: ${auth.userId}）` : ""}`);
    });
  } catch (err) {
    fail(err);
  }
}

/** logout：清除登录态 */
export async function logoutCommand(): Promise<void> {
  try {
    await clearAuthCache();
    success({ loggedOut: true }, () => logInfo("✅ 已清除登录态"));
  } catch (err) {
    fail(err);
  }
}

/** whoami：登录状态、账号昵称与云空间用量 */
export async function whoamiCommand(): Promise<void> {
  try {
    const auth = await peekOrRefreshAuth();
    if (!auth) {
      success({ loggedIn: false }, () => logInfo("未登录（运行 micloud login 登录）"));
      return;
    }
    const http = new MiCloudHttp(auth, refreshAuth);
    const [profile, quota] = await Promise.allSettled([getProfile(http), getQuota(http)]);
    const data = buildWhoami(
      http.userId,
      profile.status === "fulfilled" ? profile.value : undefined,
      quota.status === "fulfilled" ? quota.value : undefined,
    );
    success(data, () => {
      logInfo(`已登录：${data.nickname ?? ""}（userId: ${data.userId || "未知"}）`);
      if (data.quota) {
        const q = data.quota;
        const parts = Object.values(q.usedDetail).map((d) => `${d.label} ${formatBytes(d.size)}`);
        logInfo(`云空间：已用 ${formatBytes(q.used)} / 共 ${formatBytes(q.total)}${parts.length ? `（${parts.join("，")}）` : ""}`);
      }
      if (data.levelName) {
        const days = data.trashRetentionDays ? `，回收站保留 ${data.trashRetentionDays} 天` : "";
        logInfo(`会员等级：${data.levelName}${days}`);
      }
    });
  } catch (err) {
    fail(err);
  }
}

interface WhoamiData {
  loggedIn: true;
  userId: string;
  nickname?: string;
  level?: string;
  levelName?: string;
  trashRetentionDays?: number;
  quota?: { total: number; used: number; usedDetail: Record<string, { label: string; size: number }> };
}

export function buildWhoami(userId: string, profile?: ProfileData, quota?: QuotaData): WhoamiData {
  const data: WhoamiData = { loggedIn: true, userId };
  if (profile?.nickname) data.nickname = profile.nickname;
  if (quota) {
    if (quota.level) {
      data.level = quota.level;
      data.levelName = LEVEL_NAMES[quota.level] ?? quota.level;
      data.trashRetentionDays = TRASH_RETENTION_DAYS[quota.level];
    }
    if (typeof quota.totalQuota === "number" && typeof quota.used === "number") {
      const usedDetail: Record<string, { label: string; size: number }> = {};
      for (const [key, detail] of Object.entries(quota.usedDetail ?? {})) {
        if (typeof detail?.size === "number") usedDetail[key] = { label: detail.text || key, size: detail.size };
      }
      data.quota = { total: quota.totalQuota, used: quota.used, usedDetail };
    }
  }
  return data;
}
