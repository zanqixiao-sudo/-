import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { SURVEY_TYPE_CODE } from "./jzsc-api.js";

const API_BASE = "https://jzsc.mohurd.gov.cn/APi/webApi";
const API_VERSION = "231012";
const AES_KEY = "Dt8j9wGw%6HbxfFn";
const AES_IV = "0123456789ABCDEF";
const PAGE_SIZE = 15;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(targetDir) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
}

function resolveSystemEdgeUserDataDir() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }

  const candidate = path.join(localAppData, "Microsoft", "Edge", "User Data");
  return fs.existsSync(candidate) ? candidate : null;
}

function resolvePreferredUserDataDir(options = {}) {
  if (options.userDataDir) {
    return {
      userDataDir: path.resolve(options.userDataDir),
      usingSystemProfile: false,
      profileDirectory: null,
    };
  }

  if (options.manualKeepAlive && process.env.EDGE_USE_SYSTEM_PROFILE !== "0") {
    const systemUserDataDir = resolveSystemEdgeUserDataDir();
    if (systemUserDataDir) {
      return {
        userDataDir: systemUserDataDir,
        usingSystemProfile: true,
        profileDirectory: process.env.EDGE_PROFILE_DIRECTORY || "Default",
      };
    }
  }

  return {
    userDataDir: path.resolve(
      path.join("data", options.manualKeepAlive ? "edge-session-manual" : "edge-session"),
    ),
    usingSystemProfile: false,
    profileDirectory: null,
  };
}

export function resolveEdgeExecutablePath() {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("未找到本地 Edge，请检查 msedge.exe 安装路径。");
}

function decryptPayload(cipherText) {
  const encoding = /^[0-9a-f]+$/i.test(cipherText.trim()) ? "hex" : "base64";
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    Buffer.from(AES_KEY, "utf8"),
    Buffer.from(AES_IV, "utf8"),
  );

  let decrypted = decipher.update(cipherText, encoding, "utf8");
  decrypted += decipher.final("utf8");
  return JSON.parse(decrypted);
}

function normalizeCompany(item) {
  const regionName = item?.QY_REGION_NAME || item?.QY_XIAN || "";
  const regionParts = String(regionName).split("-").filter(Boolean);

  return {
    companyId: item?.QY_ID || item?.QYID || "",
    companyName: item?.QY_NAME || item?.QYM || item?.QYMC || "",
    unifiedCode: item?.QY_ORG_CODE || item?.TYXY_CODE || item?.TYXYDM || "",
    legalRepresentative: item?.QY_FR_NAME || item?.FRDB || "",
    province: item?.QY_SHENG || regionParts[0] || "",
    city: item?.QY_SHI || regionParts[1] || "",
    regionCode: item?.QY_REGION || item?.QY_REGION_CODE || "",
    regionName,
  };
}

export async function createEdgeSession(options = {}) {
  const preferred = resolvePreferredUserDataDir(options);
  const fallbackUserDataDir = path.resolve(
    path.join("data", options.manualKeepAlive ? "edge-session-manual" : "edge-session"),
  );
  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
  ];

  if (preferred.profileDirectory) {
    launchArgs.push(`--profile-directory=${preferred.profileDirectory}`);
  }

  ensureDir(preferred.userDataDir);

  let context;

  try {
    context = await chromium.launchPersistentContext(preferred.userDataDir, {
      executablePath: resolveEdgeExecutablePath(),
      headless: options.headless ?? true,
      viewport: { width: 1440, height: 960 },
      args: launchArgs,
    });
  } catch (error) {
    if (!preferred.usingSystemProfile) {
      throw error;
    }

    console.log(
      `System Edge profile launch failed, fallback to project session: ${error.message}`,
    );
    ensureDir(fallbackUserDataDir);
    context = await chromium.launchPersistentContext(fallbackUserDataDir, {
      executablePath: resolveEdgeExecutablePath(),
      headless: options.headless ?? true,
      viewport: { width: 1440, height: 960 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
  }

  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://jzsc.mohurd.gov.cn/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(options.manualKeepAlive ? 6000 : 2500);

  return {
    context,
    page,
    manualKeepAlive: Boolean(options.manualKeepAlive),
    async close() {
      await context.close();
    },
  };
}

async function allowManualKeepAlive(page, options = {}) {
  const pauseMs = options.manualPauseMs ?? 45000;
  await page.bringToFront().catch(() => {});
  await page.goto("https://jzsc.mohurd.gov.cn/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  }).catch(() => {});
  console.log(
    `人工保活窗口已切回住建站首页，请在 ${Math.round(pauseMs / 1000)} 秒内保持页面活跃或手动浏览后再继续抓取。`,
  );
  await sleep(pauseMs);
}

async function requestApiViaBrowser(page, pathname, params = {}, options = {}) {
  const maxAttempts = options.retryCount ?? 5;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payload = await page.evaluate(
        async ({ apiBase, pathnameArg, paramsArg, version }) => {
          const url = new URL(`${apiBase}${pathnameArg}`);
          for (const [key, value] of Object.entries(paramsArg)) {
            if (value !== undefined && value !== null && value !== "") {
              url.searchParams.set(key, String(value));
            }
          }

          const response = await fetch(url.toString(), {
            headers: {
              accept: "application/json, text/plain, */*",
              referer: "https://jzsc.mohurd.gov.cn/",
              origin: "https://jzsc.mohurd.gov.cn",
              v: version,
              "cache-control": "no-cache",
              pragma: "no-cache",
            },
            credentials: "include",
          });

          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            text: await response.text(),
          };
        },
        {
          apiBase: API_BASE,
          pathnameArg: pathname,
          paramsArg: params,
          version: API_VERSION,
        },
      );

      if (!payload.ok) {
        throw new Error(`请求失败: ${payload.status} ${payload.statusText}`);
      }

      if (payload.text.startsWith("<html")) {
        throw new Error(`请求失败: ${payload.status || 403} HTML response`);
      }

      const decoded = decryptPayload(payload.text);
      if (decoded.code && decoded.code !== 200) {
        throw new Error(decoded.message || `接口返回异常: ${decoded.code}`);
      }

      return decoded.data ?? decoded;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
      if (
        options.manualKeepAlive &&
        /(401|403|Unauthorized|Forbidden|HTML response)/i.test(error.message || "")
      ) {
        await allowManualKeepAlive(page, options);
      }
      await sleep((options.retryDelayMs ?? 6000) * attempt);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await sleep(2000);
    }
  }

  throw lastError;
}

export async function fetchSurveyQualificationsViaBrowser(session, options = {}) {
  const data = await requestApiViaBrowser(
    session.page,
    "/asite/qualapt/aptData",
    { apt_root: "B" },
    options,
  );

  const rawList = Array.isArray(data)
    ? data.flatMap((category) => category?.list || [])
    : data?.pageList || [];

  return rawList
    .filter((item) => (item?.apt_type || item?.APT_TYPE) === SURVEY_TYPE_CODE)
    .map((item) => ({
      aptCode: item.apt_code || item.APT_CODE,
      aptName: item.name || item.APT_CASENAME,
      aptType: item.apt_type || item.APT_TYPE,
      aptOrder: Number(item.apt_order || item.APT_ORDER || 0),
    }))
    .sort((a, b) => {
      if (a.aptOrder !== b.aptOrder) {
        return a.aptOrder - b.aptOrder;
      }
      return a.aptCode.localeCompare(b.aptCode);
    });
}

export async function fetchCompaniesByQualificationViaBrowser(
  session,
  qualification,
  options = {},
) {
  const companies = [];
  let totalCompanies = 0;
  let pageIndex = 0;

  while (true) {
    const data = await requestApiViaBrowser(
      session.page,
      "/dataservice/query/comp/list",
      {
        qy_type: SURVEY_TYPE_CODE,
        apt_code: qualification.aptCode,
        pg: pageIndex,
        pgsz: PAGE_SIZE,
        total: totalCompanies,
      },
      options,
    );

    const list = data?.list || [];
    totalCompanies = Number(data?.total || totalCompanies || list.length);
    companies.push(...list.map(normalizeCompany));

    if (typeof options.onProgress === "function") {
      options.onProgress({
        qualification,
        page: pageIndex,
        fetchedCount: companies.length,
        totalCompanies,
      });
    }

    if (companies.length >= totalCompanies || list.length === 0) {
      break;
    }

    pageIndex += 1;
    await sleep(options.pageDelayMs ?? 2200);
  }

  return {
    aptCode: qualification.aptCode,
    aptName: qualification.aptName,
    totalCompanies,
    companies: [...new Map(companies.map((item) => [item.companyId, item])).values()],
    fetchedAt: new Date().toISOString(),
  };
}
