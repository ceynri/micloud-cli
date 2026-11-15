import { unwrapEnvelope, type MiCloudHttp } from "./http.js";

export interface ProfileData {
  nickname?: string;
  icon?: string;
}

export interface QuotaData {
  /** 会员等级：None / FirstLevel / SecondLevel / ThirdLevel */
  level?: string;
  totalQuota?: number;
  used?: number;
  /** 各项占用，如 `{ Recorder: { size, text: "录音备份" } }` */
  usedDetail?: Record<string, { size?: number; text?: string }>;
  quotaStatus?: string;
}

export const LEVEL_NAMES: Record<string, string> = {
  None: "普通用户",
  FirstLevel: "黄金会员",
  SecondLevel: "白金会员",
  ThirdLevel: "钻石会员",
};

/** 回收站保留天数（按会员等级，取自网页端） */
export const TRASH_RETENTION_DAYS: Record<string, number> = {
  None: 30,
  FirstLevel: 60,
  SecondLevel: 90,
  ThirdLevel: 180,
};

/** 账号昵称与头像 */
export async function getProfile(http: MiCloudHttp): Promise<ProfileData> {
  return await http.getJson("/status/lite/profile", {}, (json) => unwrapEnvelope<ProfileData>(json));
}

/** 云空间用量与会员等级 */
export async function getQuota(http: MiCloudHttp): Promise<QuotaData> {
  return await http.getJson("/status/alldetail", {}, (json) => unwrapEnvelope<QuotaData>(json));
}
