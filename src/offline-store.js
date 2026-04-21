import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";

const dataDir = path.resolve("data");
const offlineFile = path.join(dataDir, "offline-cache.json");
const progressFile = path.join(dataDir, "offline-progress.json");
const crawlStateFile = path.join(dataDir, "offline-crawl-state.json");

function ensureDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function writeJson(filePath, value) {
  ensureDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readJson(filePath, fallback) {
  ensureDir();
  if (!fs.existsSync(filePath)) {
    writeJson(filePath, fallback);
    return fallback;
  }

  return normalizeValue(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function looksLikeMojibake(value) {
  return /[閸曟ê鐧傜紒鐓庢値鐠у嫯宸濋悽鑼獓娴间椒绗熷銉р柤]/.test(value);
}

function maybeFixString(value) {
  if (!value || typeof value !== "string" || !looksLikeMojibake(value)) {
    return value;
  }

  try {
    const fixed = iconv.encode(value, "gb18030").toString("utf8");
    return fixed.includes("锟?") ? value : fixed;
  } catch {
    return value;
  }
}

function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeValue(nestedValue)]),
    );
  }

  return maybeFixString(value);
}

export function readOfflineCache() {
  return readJson(offlineFile, {
    scope: {
      qyType: "QY_ZZ_ZZZD_003",
      qyTypeName: "勘察企业",
    },
    qualifications: [],
    fetchedQualifications: {},
    companies: [],
    stats: {
      qualificationCount: 0,
      fetchedQualificationCount: 0,
      companyCount: 0,
      relationCount: 0,
    },
    updatedAt: null,
  });
}

export function writeOfflineCache(cache) {
  const payload = {
    ...cache,
    updatedAt: new Date().toISOString(),
  };
  writeJson(offlineFile, payload);
  return payload;
}

export function readOfflineProgress() {
  return readJson(progressFile, {
    status: "idle",
    currentQualification: null,
    completedCodes: [],
    failedCodes: [],
    startedAt: null,
    updatedAt: null,
  });
}

export function writeOfflineProgress(progress) {
  const payload = {
    ...progress,
    updatedAt: new Date().toISOString(),
  };
  writeJson(progressFile, payload);
  return payload;
}

export function readOfflineCrawlState() {
  return readJson(crawlStateFile, {
    qualificationStates: {},
    updatedAt: null,
  });
}

export function writeOfflineCrawlState(state) {
  const payload = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  writeJson(crawlStateFile, payload);
  return payload;
}

export function updateQualificationCrawlState(aptCode, patch) {
  const state = readOfflineCrawlState();
  state.qualificationStates = {
    ...(state.qualificationStates || {}),
    [aptCode]: {
      ...(state.qualificationStates?.[aptCode] || {}),
      ...patch,
    },
  };
  return writeOfflineCrawlState(state);
}

export function rebuildOfflineCompanies(cache) {
  const companyMap = new Map();
  const fetchedQualifications = Object.values(cache.fetchedQualifications || {});

  for (const qualification of fetchedQualifications) {
    for (const company of qualification.companies || []) {
      const current = companyMap.get(company.companyId) || {
        ...company,
        qualificationCodes: [],
        qualificationNames: [],
      };

      current.qualificationCodes.push(qualification.aptCode);
      current.qualificationNames.push(qualification.aptName);
      companyMap.set(company.companyId, current);
    }
  }

  const companies = [...companyMap.values()]
    .map((company) => ({
      ...company,
      qualificationCodes: [...new Set(company.qualificationCodes)],
      qualificationNames: [...new Set(company.qualificationNames)],
    }))
    .sort((a, b) => a.companyName.localeCompare(b.companyName, "zh-CN"));

  return {
    ...cache,
    companies,
    stats: {
      qualificationCount: cache.qualifications.length,
      fetchedQualificationCount: fetchedQualifications.length,
      companyCount: companies.length,
      relationCount: fetchedQualifications.reduce(
        (sum, item) => sum + (item.companies || []).length,
        0,
      ),
    },
  };
}
