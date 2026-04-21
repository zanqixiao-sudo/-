import crypto from "node:crypto";

const API_BASE = "https://jzsc.mohurd.gov.cn/APi/webApi";
const API_VERSION = "231012";
const AES_KEY = "Dt8j9wGw%6HbxfFn";
const AES_IV = "0123456789ABCDEF";
const PAGE_SIZE = 15;
const DEFAULT_RETRY_COUNT = 6;
const DEFAULT_RETRY_DELAY_MS = 5000;

export const SURVEY_TYPE_CODE = "QY_ZZ_ZZZD_003";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function shouldRetry(error) {
  const message = String(error?.message || "");
  return (
    error?.name === "AbortError" ||
    /401|403|429|502|503|504/i.test(message) ||
    /decrypt|timeout|timed out|ECONNRESET|ECONNREFUSED|socket|fetch failed/i.test(message) ||
    /busy|temporarily unavailable|unauthorized|forbidden/i.test(message)
  );
}

async function requestApi(pathname, params = {}, options = {}) {
  const retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastError;

  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    try {
      const url = new URL(`${API_BASE}${pathname}`);
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }

      const response = await fetch(url, {
        headers: {
          accept: "application/json, text/plain, */*",
          referer: "https://jzsc.mohurd.gov.cn/",
          origin: "https://jzsc.mohurd.gov.cn",
          v: API_VERSION,
          "cache-control": "no-cache",
          pragma: "no-cache",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0",
        },
        signal: options.signal,
      });

      if (!response.ok) {
        throw new Error(`请求失败: ${response.status} ${response.statusText}`);
      }

      const text = await response.text();
      if (text.startsWith("<html")) {
        throw new Error("请求失败: 403 Forbidden");
      }

      const payload = decryptPayload(text);
      if (payload.code && payload.code !== 200) {
        throw new Error(payload.message || `接口返回异常: ${payload.code}`);
      }

      return payload.data ?? payload;
    } catch (error) {
      lastError = error;
      if (attempt >= retryCount || !shouldRetry(error)) {
        break;
      }

      const backoff = retryDelayMs * attempt + Math.floor(Math.random() * 1000);
      await sleep(backoff);
    }
  }

  throw lastError;
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

export async function fetchSurveyQualifications(options = {}) {
  const data = await requestApi(
    "/asite/qualapt/aptData",
    { apt_root: "B" },
    options,
  );

  const rawList = Array.isArray(data)
    ? data.flatMap((category) => category?.list || [])
    : data?.pageList || [];

  const qualifications = rawList
    .filter((item) => (item?.apt_type || item?.APT_TYPE) === SURVEY_TYPE_CODE)
    .map((item) => ({
      aptCode: item.apt_code || item.APT_CODE,
      aptName: item.name || item.APT_CASENAME,
      aptType: item.apt_type || item.APT_TYPE,
      aptOrder: Number(item.apt_order || item.APT_ORDER || 0),
    }));

  return qualifications.sort((a, b) => {
    if (a.aptOrder !== b.aptOrder) {
      return a.aptOrder - b.aptOrder;
    }
    return a.aptCode.localeCompare(b.aptCode);
  });
}

export async function fetchCompaniesByQualification(qualification, options = {}) {
  const companies = [];
  let totalCompanies = 0;
  let page = 0;

  while (true) {
    const data = await requestApi(
      "/dataservice/query/comp/list",
      {
        qy_type: SURVEY_TYPE_CODE,
        apt_code: qualification.aptCode,
        pg: page,
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
        page,
        fetchedCount: companies.length,
        totalCompanies,
      });
    }

    if (companies.length >= totalCompanies || list.length === 0) {
      break;
    }

    page += 1;
    await sleep(options.pageDelayMs ?? 1500);
  }

  const dedupedCompanies = [
    ...new Map(companies.map((item) => [item.companyId, item])).values(),
  ];

  return {
    aptCode: qualification.aptCode,
    aptName: qualification.aptName,
    totalCompanies,
    companies: dedupedCompanies,
    fetchedAt: new Date().toISOString(),
  };
}
