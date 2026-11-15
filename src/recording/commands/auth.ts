import { ensureAuth, peekOrRefreshAuth, clearAuthCache, refreshAuth } from "../auth.js";
import { MiRecordingClient } from "../client.js";
import { success, logInfo, fail } from "../output.js";
import { TRASH_RETENTION_DAYS } from "../recording.js";
import { formatBytes } from "../utils.js";
import type { ProfileData, QuotaData } from "../types.js";

const LEVEL_NAMES: Record<string, string> = {
  None: "普通用户",
  FirstLevel: "黄金会员",
  SecondLevel: "白金会员",
  ThirdLevel: "钻石会员",
};

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

/** logout：清除本工具的登录态 */
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
      success({ loggedIn: false }, () => logInfo("未登录（运行 mi-recording-cli login 登录）"));
      return;
    }
    const client = new MiRecordingClient(auth, refreshAuth);
    const [profile, quota] = await Promise.allSettled([client.getProfile(), client.getQuota()]);
    const data = buildWhoami(
      client.userId,
      profile.status === "fulfilled" ? profile.value : undefined,
      quota.status === "fulfilled" ? quota.value : undefined,
    );
    success(data, () => {
      logInfo(`已登录：${data.nickname ?? ""}（userId: ${data.userId || "未知"}）`);
      if (data.quota) {
        const q = data.quota;
        const recorder = q.recorderUsed !== undefined ? `，录音占用 ${formatBytes(q.recorderUsed)}` : "";
        logInfo(`云空间：已用 ${formatBytes(q.used)} / 共 ${formatBytes(q.total)}${recorder}`);
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
  quota?: { total: number; used: number; recorderUsed?: number };
}

function buildWhoami(userId: string, profile?: ProfileData, quota?: QuotaData): WhoamiData {
  const data: WhoamiData = { loggedIn: true, userId };
  if (profile?.nickname) data.nickname = profile.nickname;
  if (quota) {
    if (quota.level) {
      data.level = quota.level;
      data.levelName = LEVEL_NAMES[quota.level] ?? quota.level;
      data.trashRetentionDays = TRASH_RETENTION_DAYS[quota.level];
    }
    if (typeof quota.totalQuota === "number" && typeof quota.used === "number") {
      data.quota = { total: quota.totalQuota, used: quota.used };
      const recorder = quota.usedDetail?.Recorder?.size;
      if (typeof recorder === "number") data.quota.recorderUsed = recorder;
    }
  }
  return data;
}
