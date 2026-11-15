// ============ 小米云录音 API 原始数据结构 ============

/**
 * 录音列表 / 回收站接口返回的原始条目。
 *
 * `name` 编码了手机端元数据：`<标题>.<扩展名>[_<时长秒>]_<类型码>_<文件时间>_<上传时间>`，解析见 recording.ts。
 * `ver` 是版本号，删除、恢复都会让它变化；回收站的恢复/永久删除要用回收站条目当前的 ver。
 */
export interface RawRecording {
  id: string;
  ver: string;
  sha1: string;
  size: number;
  name: string;
  /** 恒为 "file"（录音没有目录层级） */
  type?: string;
  parent_id?: string;
  /** 云端创建时间（上传时间） */
  create_time: number;
  /** 云端修改时间；回收站条目里即删除时间 */
  modify_time: number;
  /** JSON 字符串，如 `{"mark": "","time": 0,"appType": 1,"appTypeTime": ...}`，可能为空串 */
  extraInfo?: string;
}

export interface RecordingListData {
  list?: RawRecording[];
}

/** 回收站分页：响应里带 syncToken 表示还有下一页 */
export interface TrashListData {
  list?: RawRecording[];
  syncToken?: string;
}

export interface DownloadUrlData {
  url?: string;
}

/** 分块下载凭证；账号开启「高级数据保护」（端到端加密）时带 encryptInfo */
export interface BlockStorageData {
  kss?: {
    stat?: string;
    blocks?: Array<{ sha1: string; size: number; urls: string[] }>;
    secure_key?: string;
  };
  encryptInfo?: unknown;
}

// ============ 领域模型 ============

/** 录音类型，与网页端分类一致：录音机 / 通话录音 / FM 录音 / 应用录音（微信、企业微信等） */
export type RecordingType = "recorder" | "phonecall" | "fm" | "app";

/** 解析后的录音 */
export interface Recording {
  id: string;
  /** 手机上的文件名（不含扩展名），也是网页端展示的名字来源 */
  title: string;
  /** `${title}.${extension}` */
  fileName: string;
  extension: string;
  type: RecordingType;
  typeName: string;
  /** 原始类型码：0 录音机、1 通话、2 FM、3 应用；无法解析时为 -1 */
  typeCode: number;
  /** 时长（秒） */
  duration: number;
  /** 名字里没有时长段，duration 由文件大小按码率估算 */
  durationEstimated: boolean;
  /** 录音开始时间（毫秒）：标题带精确时间戳时取它，否则由文件时间减时长推算 */
  recordedAt: number;
  /** 手机端文件时间（毫秒），约等于录音结束时间 */
  endedAt: number;
  size: number;
  sha1: string;
  /** 云端创建（上传）时间 */
  createTime: number;
  /** 云端修改时间 */
  modifyTime: number;
  ver: string;
  /** 通话录音的对方号码（能从文件名解析时） */
  phoneNumber?: string;
  /** 通话 / 应用录音的对方名称（能从文件名解析时） */
  contactName?: string;
  /** 应用录音的来源应用，如「微信」「企业微信」 */
  appName?: string;
  /** 云端原始 name */
  rawName: string;
  /** 解析后的 extraInfo（appType 1 为微信、2 为企业微信） */
  extraInfo?: Record<string, unknown>;
}

/** 回收站里的录音 */
export interface TrashedRecording extends Recording {
  /** 删除时间（回收站条目的 modify_time） */
  deletedAt: number;
  /** 预计被自动清除的时间（按会员等级的保留天数推算，未知时缺省） */
  expiresAt?: number;
}

// ============ 配置与拉取状态 ============

/**
 * 录音配置（项目配置 `.micloud/config.json` 的 `recording` 节），所有字段可选。
 * - output：默认拉取目录（命令行 `-o` 优先；都缺省时为 `.micloud/recording/`）
 * - fileNameTemplate：落盘文件名模板（不含扩展名，可用 `/` 分子目录），见 template.ts
 * - concurrency：pull / download 的并发下载数
 */
export interface RecordingConfig {
  output?: string;
  fileNameTemplate?: string;
  concurrency?: number;
}

/** 某条录音的拉取记录 */
export interface PulledRecord {
  sha1: string;
  size: number;
  /** 相对拉取目录的路径（`/` 分隔） */
  file: string;
  title: string;
  pulledAt: number;
  /** 本工具把它的云端副本移到回收站的时间 */
  cloudDeletedAt?: number;
}

/**
 * 拉取状态（`<拉取目录>/.micloud-recording.json`），自动维护、跟拉取目录 1:1 绑定。
 * 记录过的录音之后的 pull 都会跳过，即使本地文件已被移走（`--force` 例外）。
 */
export interface PullState {
  version: 1;
  recordings: Record<string, PulledRecord>;
}
