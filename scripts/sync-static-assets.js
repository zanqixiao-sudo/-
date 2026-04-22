import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = process.cwd();
const sourceCacheFile = path.join(rootDir, "data", "offline-cache.json");
const sourceExcelFile = path.join(rootDir, "output", "spreadsheet", "勘察企业离线总库.xlsx");

const publicDataDir = path.join(rootDir, "public", "data");
const publicDownloadsDir = path.join(rootDir, "public", "downloads");
const targetCacheFile = path.join(publicDataDir, "offline-cache.json");
const targetExcelFile = path.join(publicDownloadsDir, "勘察企业离线总库.xlsx");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function copyIfExists(sourceFile, targetFile) {
  if (!fs.existsSync(sourceFile)) {
    console.log(`Skip missing file: ${sourceFile}`);
    return false;
  }

  ensureDir(path.dirname(targetFile));
  fs.copyFileSync(sourceFile, targetFile);
  console.log(`Synced: ${targetFile}`);
  return true;
}

if (fs.existsSync(sourceCacheFile)) {
  const cacheMtime = fs.statSync(sourceCacheFile).mtimeMs;
  const excelMtime = fs.existsSync(sourceExcelFile) ? fs.statSync(sourceExcelFile).mtimeMs : 0;

  if (!fs.existsSync(sourceExcelFile) || cacheMtime > excelMtime) {
    const result = spawnSync(process.execPath, ["src/export-offline-xlsx.js"], {
      cwd: rootDir,
      stdio: "inherit",
    });

    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  }
}

copyIfExists(sourceCacheFile, targetCacheFile);
copyIfExists(sourceExcelFile, targetExcelFile);
