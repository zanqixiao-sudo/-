import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import XLSX from "xlsx";
import {
  readOfflineCache,
  readOfflineCrawlState,
  readOfflineProgress,
} from "./offline-store.js";

const app = express();
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3210);
const sharedMode = process.env.SHARED_MODE === "1";
const previewMode = process.env.PREVIEW_MODE === "1";
const previewPassword = process.env.PREVIEW_ACCESS_PASSWORD || "";
const cookieName = "preview_auth";
const cookieTtlMs = 1000 * 60 * 60 * 12;
const cookieSecret =
  process.env.PREVIEW_COOKIE_SECRET ||
  crypto.createHash("sha256").update(previewPassword || "preview-secret").digest("hex");
const workerDisabled =
  process.env.OFFLINE_WORKER_DISABLED === "1" || sharedMode || previewMode;

const publicDir = path.resolve("public");
const outputDir = path.resolve("output", "spreadsheet");
const dataDir = path.resolve("data");
const logsDir = path.resolve("logs");
const workerStateFile = path.join(dataDir, "offline-worker.json");
const excelFile = path.join(outputDir, "勘察企业离线总库.xlsx");
const loginPageFile = path.join(publicDir, "login.html");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureOutputDir() {
  ensureDir(outputDir);
}

function parseCookies(cookieHeader) {
  return Object.fromEntries(
    String(cookieHeader || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        if (index < 0) {
          return [item, ""];
        }
        return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
      }),
  );
}

function createSignedCookieValue() {
  const expiresAt = Date.now() + cookieTtlMs;
  const payload = String(expiresAt);
  const signature = crypto
    .createHmac("sha256", cookieSecret)
    .update(payload)
    .digest("hex");
  return `${payload}.${signature}`;
}

function isValidSignedCookie(value) {
  if (!value || !value.includes(".")) {
    return false;
  }

  const [expiresAtRaw, signature] = value.split(".");
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", cookieSecret)
    .update(String(expiresAt))
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function setPreviewCookie(res) {
  const cookieValue = createSignedCookieValue();
  res.setHeader(
    "Set-Cookie",
    `${cookieName}=${encodeURIComponent(cookieValue)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
      cookieTtlMs / 1000,
    )}`,
  );
}

function clearPreviewCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

function previewAuthRequired(req) {
  if (!previewMode) {
    return false;
  }

  if (!previewPassword) {
    return false;
  }

  if (req.path === "/api/health") {
    return false;
  }

  if (req.path === "/login" || req.path === "/auth/login") {
    return false;
  }

  const cookies = parseCookies(req.headers.cookie);
  return !isValidSignedCookie(cookies[cookieName]);
}

function readWorkerState() {
  if (!fs.existsSync(workerStateFile)) {
    return {
      running: false,
      status: "idle",
      message: workerDisabled
        ? "当前模式未启用后台抓取守护任务。"
        : "后台守护任务尚未启动。",
      updatedAt: null,
    };
  }

  try {
    const state = JSON.parse(fs.readFileSync(workerStateFile, "utf8"));
    if (state.pid) {
      try {
        process.kill(state.pid, 0);
        return {
          ...state,
          running: true,
        };
      } catch {
        return {
          ...state,
          running: false,
          status: "stale",
          message: "检测到旧的守护记录，服务将自动重新拉起。",
        };
      }
    }

    return {
      ...state,
      running: false,
    };
  } catch {
    return {
      running: false,
      status: "error",
      message: "守护任务状态文件损坏，服务将自动重新拉起。",
      updatedAt: null,
    };
  }
}

function ensureOfflineWorkerStarted() {
  if (workerDisabled) {
    return;
  }

  const state = readWorkerState();
  if (state.running) {
    return;
  }

  ensureDir(logsDir);
  const workerLogFile = path.join(logsDir, "offline-worker.log");
  const stdoutFd = fs.openSync(workerLogFile, "a");
  const stderrFd = fs.openSync(workerLogFile, "a");

  const child = spawn(process.execPath, ["src/offline-worker.js"], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    windowsHide: true,
  });

  child.unref();
}

function buildQualificationSummary(cache) {
  return (cache.qualifications || [])
    .map((item) => {
      const fetched = cache.fetchedQualifications?.[item.aptCode];
      return {
        ...item,
        fetched: Boolean(fetched),
        totalCompanies: fetched?.totalCompanies ?? null,
        fetchedAt: fetched?.fetchedAt ?? null,
      };
    })
    .sort((a, b) => {
      if (a.aptOrder !== b.aptOrder) {
        return a.aptOrder - b.aptOrder;
      }
      return a.aptCode.localeCompare(b.aptCode);
    });
}

function filterCompanies(cache, qualificationCodes, keyword) {
  const selectedCodes = qualificationCodes.filter(Boolean);
  const normalizedKeyword = keyword.trim().toLowerCase();

  return (cache.companies || []).filter((company) => {
    const hasAllQualifications = selectedCodes.every((code) =>
      (company.qualificationCodes || []).includes(code),
    );

    if (!hasAllQualifications) {
      return false;
    }

    if (!normalizedKeyword) {
      return true;
    }

    const fields = [
      company.companyName,
      company.unifiedCode,
      company.legalRepresentative,
      company.province,
      company.city,
      company.regionName,
      ...(company.qualificationNames || []),
    ];

    return fields
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedKeyword));
  });
}

function autosizeWorksheet(worksheet, rows) {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  worksheet["!cols"] = keys.map((key) => {
    const maxCell = Math.max(
      key.length,
      ...rows.map((row) => String(row[key] ?? "").length),
    );
    return { wch: Math.min(Math.max(maxCell + 2, 12), 60) };
  });
}

function buildExportRows(companies) {
  return companies.map((company) => ({
    企业名称: company.companyName,
    统一社会信用代码: company.unifiedCode,
    法人: company.legalRepresentative,
    省份: company.province,
    城市: company.city,
    区域: company.regionName,
    资质数量: (company.qualificationCodes || []).length,
    资质编码: (company.qualificationCodes || []).join("；"),
    资质名称: (company.qualificationNames || []).join("；"),
  }));
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use((req, res, next) => {
  if (!previewAuthRequired(req)) {
    return next();
  }

  if (req.path.startsWith("/api/")) {
    res.status(401).json({ ok: false, message: "请先输入预览口令后再访问。" });
    return;
  }

  res.redirect("/login");
});

app.get("/login", (_req, res) => {
  if (previewMode && previewPassword && fs.existsSync(loginPageFile)) {
    res.sendFile(loginPageFile);
    return;
  }

  res.redirect("/");
});

app.post("/auth/login", (req, res) => {
  if (!previewMode || !previewPassword) {
    res.json({ ok: true, redirectTo: "/" });
    return;
  }

  const password = String(req.body.password || "");
  if (password !== previewPassword) {
    res.status(401).json({ ok: false, message: "预览口令不正确。" });
    return;
  }

  setPreviewCookie(res);
  res.json({ ok: true, redirectTo: "/" });
});

app.post("/auth/logout", (_req, res) => {
  clearPreviewCookie(res);
  res.json({ ok: true, redirectTo: "/login" });
});

app.use(express.static(publicDir));

if (fs.existsSync(outputDir)) {
  app.use("/downloads", express.static(outputDir));
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, host, port, sharedMode, previewMode, now: new Date().toISOString() });
});

app.get("/api/offline/status", (_req, res) => {
  const cache = readOfflineCache();
  const progress = readOfflineProgress();
  const worker = readWorkerState();
  const crawlState = readOfflineCrawlState();

  res.json({
    scope: cache.scope,
    stats: cache.stats,
    progress,
    worker,
    crawlState,
    sharedMode,
    previewMode,
    excel: {
      exists: fs.existsSync(excelFile),
      filename: path.basename(excelFile),
      url: fs.existsSync(excelFile)
        ? `/downloads/${encodeURIComponent(path.basename(excelFile))}`
        : null,
    },
    updatedAt: cache.updatedAt,
  });
});

app.get("/api/public/config", (_req, res) => {
  res.json({
    sharedMode,
    previewMode,
    workerDisabled,
    authRequired: Boolean(previewMode && previewPassword),
    downloadEnabled: fs.existsSync(excelFile),
  });
});

app.get("/api/offline/qualifications", (_req, res) => {
  const cache = readOfflineCache();
  res.json({
    items: buildQualificationSummary(cache),
    updatedAt: cache.updatedAt,
  });
});

app.get("/api/offline/companies", (req, res) => {
  const cache = readOfflineCache();
  const keyword = String(req.query.keyword || "");
  const qualifications = String(req.query.qualifications || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const companies = filterCompanies(cache, qualifications, keyword);

  res.json({
    total: companies.length,
    items: companies.slice(0, 2000),
    selectedQualifications: qualifications,
    keyword,
    updatedAt: cache.updatedAt,
  });
});

app.get("/api/offline/export/current.xlsx", (req, res) => {
  const cache = readOfflineCache();
  const keyword = String(req.query.keyword || "");
  const qualifications = String(req.query.qualifications || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const companies = filterCompanies(cache, qualifications, keyword);
  const rows = buildExportRows(companies);
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(
    rows.length
      ? rows
      : [
          {
            说明: "当前筛选条件下没有匹配企业",
            关键词: keyword || "无",
            资质编码: qualifications.join("；") || "无",
          },
        ],
  );

  autosizeWorksheet(worksheet, rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, "筛选结果");

  const metaRows = [
    {
      导出时间: new Date().toLocaleString("zh-CN"),
      关键词: keyword || "无",
      资质编码: qualifications.join("；") || "无",
      命中企业数: companies.length,
    },
  ];
  const metaSheet = XLSX.utils.json_to_sheet(metaRows);
  autosizeWorksheet(metaSheet, metaRows);
  XLSX.utils.book_append_sheet(workbook, metaSheet, "导出说明");

  ensureOutputDir();
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const filename = `筛选结果-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.xlsx`;

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  res.send(buffer);
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

ensureOfflineWorkerStarted();

app.listen(port, host, () => {
  console.log(`Server running at http://${host}:${port}`);
});
