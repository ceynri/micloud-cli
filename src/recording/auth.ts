import { readFile, writeFile, rm, chmod, readdir, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { getCacheDir, fileExists, ensureDir } from "./utils.js";
import type { AuthInfo } from "./types.js";

const RECORD_URL = "https://i.mi.com/record";
const VALIDATE_URL = "https://i.mi.com/sfs/ns/recorder/dir/0/list";
/** 首次使用时可只读导入其登录态的姊妹工具 */
const SIBLING_APP = "mi-note-cli";
const LOGIN_TIMEOUT = 300_000;
const POLL_INTERVAL = 2_000;
const REFRESH_TIMEOUT = 20_000;
const VALIDATE_TIMEOUT = 10_000;
const CHROME_VERSION = "131";

/** 复制浏览器数据时跳过：可重建的缓存目录与单实例锁 */
const SKIPPED_PROFILE_ENTRIES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "GraphiteDawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "BrowserMetrics",
  "component_crx_cache",
  "extensions_crx_cache",
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
]);

function cookieFile(): string {
  return join(getCacheDir(), "cookie");
}

function browserDataDir(): string {
  return join(getCacheDir(), "browser-data");
}

let refreshInFlight: Promise<AuthInfo | null> | null = null;
let bootstrapChecked = false;

/**
 * 确保拥有有效的认证信息（cookie + serviceToken + userId）。
 *
 * 解析顺序：
 * 1. forceLogin=true → 直接浏览器登录。
 * 2. 缓存 cookie 有效 → 使用。
 * 3. 缓存失效但长效登录态可续期 → 静默续期。
 * 4. 否则 → 浏览器登录。
 */
export async function ensureAuth(forceLogin = false): Promise<AuthInfo> {
  if (!forceLogin) {
    const auth = await peekOrRefreshAuth();
    if (auth) return auth;
  }

  const cookie = await loginAndGetCookie();
  await saveCookie(cookie);
  return buildAuthInfo(cookie);
}

/** 仅读取当前缓存的认证信息，不触发登录与续期。无有效缓存时返回 null。 */
export async function peekAuth(): Promise<AuthInfo | null> {
  await bootstrapFromSibling();
  const cached = await loadCachedCookie();
  if (cached && (await validateCookie(cached))) {
    return buildAuthInfo(cached);
  }
  return null;
}

/** 先读有效缓存，失效时再静默续期；不触发交互式登录。 */
export async function peekOrRefreshAuth(): Promise<AuthInfo | null> {
  return (await peekAuth()) ?? (await refreshAuth());
}

/**
 * 清除本工具的登录态（cookie + 浏览器数据）。
 * 保留缓存目录本身：它的存在表示「已初始化」，之后不会再从 mi-note-cli 自动导入。
 */
export async function clearAuthCache(): Promise<string> {
  const dir = getCacheDir();
  await rm(cookieFile(), { force: true });
  await rm(browserDataDir(), { recursive: true, force: true });
  await ensurePrivateDir(dir);
  return dir;
}

/**
 * 静默续期并落盘，返回新的 AuthInfo；长效登录态已失效时返回 null。
 * 供 client 在请求遇 401 时作为续期回调调用；并发调用共享同一次续期。
 */
export async function refreshAuth(): Promise<AuthInfo | null> {
  refreshInFlight ??= doRefreshAuth().finally(() => {
    refreshInFlight = null;
  });
  return await refreshInFlight;
}

async function doRefreshAuth(): Promise<AuthInfo | null> {
  await bootstrapFromSibling();
  const cookie = await silentRefreshCookie();
  if (!cookie) {
    // 其他进程可能刚刚完成续期并落盘；失败前再读一次缓存。
    const cached = await loadCachedCookie();
    return cached && (await validateCookie(cached)) ? buildAuthInfo(cached) : null;
  }
  await saveCookie(cookie);
  return buildAuthInfo(cookie);
}

/**
 * 首次使用（本工具缓存目录尚不存在）时，从 mi-note-cli 只读复制浏览器登录数据与 cookie，
 * 免去再登录一次。两者都是小米账号 i.mi.com 的登录态，复制后各自独立续期、互不影响；
 * 绝不修改 mi-note-cli 的任何文件。只尝试一次：无论成败都会建立本工具缓存目录。
 */
async function bootstrapFromSibling(): Promise<void> {
  if (bootstrapChecked) return;
  bootstrapChecked = true;
  const dir = getCacheDir();
  if (await fileExists(dir)) return;
  await ensurePrivateDir(dir);

  const source = getCacheDir(SIBLING_APP);
  const sourceBrowser = join(source, "browser-data");
  if (!(await fileExists(sourceBrowser))) return;
  try {
    await copyProfile(sourceBrowser, browserDataDir());
    const sourceCookie = join(source, "cookie");
    if (await fileExists(sourceCookie)) {
      const cookie = (await readFile(sourceCookie, "utf-8")).trim();
      if (cookie) await saveCookie(cookie);
    }
    process.stderr.write(`ℹ️ 已从 ${SIBLING_APP} 只读导入小米账号登录态\n`);
  } catch {
    await rm(browserDataDir(), { recursive: true, force: true });
    await rm(cookieFile(), { force: true });
  }
}

/** 递归复制浏览器数据目录，跳过缓存、锁文件与符号链接 */
async function copyProfile(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (SKIPPED_PROFILE_ENTRIES.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) await copyProfile(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

/** 从 cookie 字符串构造 AuthInfo（提取 serviceToken / userId） */
function buildAuthInfo(cookie: string): AuthInfo {
  return {
    cookie,
    serviceToken: extractCookieValue(cookie, "serviceToken"),
    userId: extractCookieValue(cookie, "userId", false),
  };
}

/** 从 cookie 字符串中提取某字段值 */
export function extractCookieValue(cookie: string, key: string, required = true): string {
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
  if (!match) {
    if (required) {
      throw new Error(`Cookie 中未找到 ${key}，请重新登录（mi-recording-cli login）`);
    }
    return "";
  }
  return match[1];
}

/**
 * 用持久化上下文启动浏览器。
 * 浏览器策略：优先系统 Chrome，回退 Playwright Chromium。
 * @param headless 是否无头（静默续期用 true，交互登录用 false）
 */
async function launchPersistentBrowser(
  headless: boolean,
): Promise<import("playwright").BrowserContext> {
  const { chromium } = await import("playwright");
  // 启用沙箱并移除 Playwright 默认追加的 --no-sandbox，
  // 避免浏览器顶部出现「您使用的是不受支持的命令行标记 --no-sandbox」警告条。
  const launchOptions = {
    headless,
    chromiumSandbox: true,
    ignoreDefaultArgs: ["--no-sandbox", "--enable-automation"],
  };
  try {
    return await chromium.launchPersistentContext(browserDataDir(), {
      ...launchOptions,
      channel: "chrome",
    });
  } catch {
    if (!headless) {
      process.stderr.write("⚠️ 未检测到系统 Chrome，回退到 Playwright 自带 Chromium\n");
    }
    try {
      return await chromium.launchPersistentContext(browserDataDir(), {
        ...launchOptions,
        channel: "chromium",
      });
    } catch (err) {
      throw new Error(
        "无法启动浏览器：未检测到系统 Chrome，也没有 Playwright 自带的 Chromium。" +
          "请安装 Google Chrome，或运行 `npx playwright install chromium` 后重试。" +
          `\n  原始错误：${(err as Error).message.split("\n")[0]}`,
      );
    }
  }
}

/**
 * 静默续期：复用持久化的浏览器数据目录，无头打开 i.mi.com 录音页，
 * 让浏览器用 account 域的长效 passToken 自动换发新的 serviceToken，提取并返回新 cookie。
 *
 * 仅当 browser-data 里的长效登录态仍有效时成功；失效则返回 null，由调用方回退到交互式 login。
 */
export async function silentRefreshCookie(): Promise<string | null> {
  if (!(await fileExists(browserDataDir()))) return null;
  let context: import("playwright").BrowserContext | undefined;
  try {
    context = await launchPersistentBrowser(true);
    const page = context.pages()[0] || (await context.newPage());
    const deadline = Date.now() + REFRESH_TIMEOUT;
    await page.goto(RECORD_URL, { waitUntil: "load", timeout: REFRESH_TIMEOUT }).catch(() => undefined);

    while (true) {
      const cookieStr = await extractCookies(context);
      if (cookieStr && (await validateCookie(cookieStr))) return cookieStr;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise((r) => setTimeout(r, Math.min(POLL_INTERVAL, remaining)));
    }
  } catch {
    return null;
  } finally {
    await context?.close();
  }
}

/** 通过 Playwright 打开浏览器让用户登录，获取 Cookie */
async function loginAndGetCookie(): Promise<string> {
  process.stderr.write("🌐 正在打开浏览器，请在浏览器中登录小米账号...\n");
  await ensurePrivateDir(getCacheDir());
  const context = await launchPersistentBrowser(false);

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(RECORD_URL).catch(() => undefined);
    process.stderr.write("⏳ 等待登录完成...（登录成功后会自动检测）\n");

    const startTime = Date.now();
    while (Date.now() - startTime < LOGIN_TIMEOUT) {
      const cookieStr = await extractCookies(context).catch(() => "");
      if (cookieStr && (await validateCookie(cookieStr))) {
        process.stderr.write("✅ 登录成功\n");
        return cookieStr;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
    throw new Error("登录超时（5 分钟），请重试");
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function extractCookies(context: {
  cookies: (url: string) => Promise<{ name: string; value: string }[]>;
}): Promise<string> {
  const cookies = await context.cookies("https://i.mi.com");
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** 校验 cookie 是否能访问录音服务 */
export async function validateCookie(cookie: string): Promise<boolean> {
  if (!/(?:^|;\s*)serviceToken=/.test(cookie)) return false;
  try {
    const url = `${VALIDATE_URL}?offset=0&limit=1&ts=${Date.now()}`;
    const resp = await fetch(url, {
      headers: buildHeaders(cookie),
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { code?: number; result?: string };
    return data.code === 0 || data.result === "ok";
  } catch {
    return false;
  }
}

/** 构建请求头 */
export function buildHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Referer: "https://i.mi.com/record",
    Origin: "https://i.mi.com",
    "User-Agent": `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "sec-ch-ua": `"Google Chrome";v="${CHROME_VERSION}", "Chromium";v="${CHROME_VERSION}", "Not_A Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

async function loadCachedCookie(): Promise<string | null> {
  try {
    const content = await readFile(cookieFile(), "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function saveCookie(cookie: string): Promise<void> {
  await ensurePrivateDir(getCacheDir());
  await writeFile(cookieFile(), cookie, { encoding: "utf-8", mode: 0o600 });
  // mode 只对新建文件生效，已存在的旧文件需显式收紧
  await chmod(cookieFile(), 0o600);
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await ensureDir(dir);
  await chmod(dir, 0o700);
}
