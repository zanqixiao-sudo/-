import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = process.cwd();
const publicDir = path.join(rootDir, "public");
const publicCacheFile = path.join(publicDir, "data", "offline-cache.json");
const publicExcelFile = path.join(publicDir, "downloads", "勘察企业离线总库.xlsx");
const sourceCacheFile = path.join(rootDir, "data", "offline-cache.json");
const sourceExcelFile = path.join(rootDir, "output", "spreadsheet", "勘察企业离线总库.xlsx");

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runSyncIfSourcesExist() {
  if (!fileExists(sourceCacheFile) && !fileExists(sourceExcelFile)) {
    return;
  }

  const result = spawnSync(process.execPath, ["scripts/sync-static-assets.js"], {
    cwd: rootDir,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    fail("Cloudflare Pages build preparation failed while syncing static assets.");
  }
}

runSyncIfSourcesExist();

if (!fileExists(publicDir)) {
  fail("Missing public directory. Cloudflare Pages output directory should be public.");
}

if (!fileExists(publicCacheFile)) {
  fail("Missing public/data/offline-cache.json. Run node scripts/sync-static-assets.js before deploy.");
}

if (!fileExists(publicExcelFile)) {
  fail("Missing public/downloads/勘察企业离线总库.xlsx. Run node scripts/sync-static-assets.js before deploy.");
}

console.log("Cloudflare Pages static bundle is ready.");
