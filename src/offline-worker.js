import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { readOfflineCache, readOfflineProgress } from "./offline-store.js";

const LOOP_DELAY_MS = Number(process.env.WORKER_LOOP_DELAY_MS || 30 * 60 * 1000);
const CRAWL_WINDOW_START = process.env.CRAWL_WINDOW_START || "01:00";
const CRAWL_WINDOW_END = process.env.CRAWL_WINDOW_END || "06:00";
const DAYTIME_FAILED_RETRY_ENABLED = process.env.DAYTIME_FAILED_RETRY_ENABLED !== "0";
const DAYTIME_FAILED_RETRY_INTERVAL_MS = Number(
  process.env.DAYTIME_FAILED_RETRY_INTERVAL_MS || 3 * 60 * 60 * 1000,
);

const dataDir = path.resolve("data");
const workerStateFile = path.join(dataDir, "offline-worker.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function parseTimeValue(value) {
  const [hours, minutes] = String(value || "00:00")
    .split(":")
    .map((item) => Number(item));

  return {
    hours: Number.isFinite(hours) ? hours : 0,
    minutes: Number.isFinite(minutes) ? minutes : 0,
  };
}

function isWithinCrawlWindow(now = new Date()) {
  const start = parseTimeValue(CRAWL_WINDOW_START);
  const end = parseTimeValue(CRAWL_WINDOW_END);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;

  if (startMinutes === endMinutes) {
    return true;
  }

  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function msUntilNextWindow(now = new Date()) {
  const start = parseTimeValue(CRAWL_WINDOW_START);
  const next = new Date(now);
  next.setHours(start.hours, start.minutes, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function readWorkerState() {
  if (!fs.existsSync(workerStateFile)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(workerStateFile, "utf8"));
  } catch {
    return {};
  }
}

function writeWorkerState(patch) {
  ensureDataDir();
  const current = readWorkerState();
  const next = {
    ...current,
    ...patch,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(workerStateFile, JSON.stringify(next, null, 2), "utf8");
}

function removeWorkerState() {
  if (!fs.existsSync(workerStateFile)) {
    return;
  }

  try {
    const current = JSON.parse(fs.readFileSync(workerStateFile, "utf8"));
    if (!current.pid || current.pid === process.pid) {
      fs.unlinkSync(workerStateFile);
    }
  } catch {
    fs.unlinkSync(workerStateFile);
  }
}

function isCompleted() {
  const cache = readOfflineCache();
  const progress = readOfflineProgress();

  return (
    cache.stats?.qualificationCount > 0 &&
    cache.stats?.qualificationCount === cache.stats?.fetchedQualificationCount &&
    (progress.failedCodes?.length || 0) === 0
  );
}

function runOneRound({ failedOnly = false } = {}) {
  return new Promise((resolve) => {
    const args = ["src/scrapers/jzsc-offline.js"];
    if (failedOnly) {
      args.push("--failed-only");
    }

    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      windowsHide: false,
    });

    child.on("exit", (code) => resolve(code ?? 0));
  });
}

function getFailedCount() {
  return readOfflineProgress().failedCodes?.length || 0;
}

async function runDaytimeFailedRetry() {
  const failedCount = getFailedCount();
  writeWorkerState({
    status: "daytime_failed_retry",
    message: `Daytime low-frequency retry started for ${failedCount} failed qualifications.`,
  });

  const exitCode = await runOneRound({ failedOnly: true });
  const nextProgress = readOfflineProgress();
  const nextFailedCount = nextProgress.failedCodes?.length || 0;

  writeWorkerState({
    status: nextFailedCount > 0 ? "cooldown_wait" : "waiting_window",
    lastExitCode: exitCode,
    lastDaytimeRetryAt: new Date().toISOString(),
    failedCodes: nextProgress.failedCodes || [],
    message:
      nextFailedCount > 0
        ? `Daytime retry completed. ${nextFailedCount} failed qualifications remain queued.`
        : "Daytime retry completed. No failed qualifications remain.",
  });
}

async function main() {
  writeWorkerState({
    status: "running",
    mode: "night-window",
    startedAt: new Date().toISOString(),
    message: "Low-risk offline worker started.",
  });
  console.log("Offline worker started in low-risk mode.");

  while (true) {
    if (isCompleted()) {
      writeWorkerState({
        status: "completed",
        message: "All qualifications completed.",
      });
      console.log("Offline worker finished: all qualifications completed.");
      return;
    }

    const failedCount = getFailedCount();

    if (!isWithinCrawlWindow()) {
      const waitMs = msUntilNextWindow();
      const currentWorkerState = readWorkerState();
      const lastDaytimeRetryAt = currentWorkerState.lastDaytimeRetryAt
        ? new Date(currentWorkerState.lastDaytimeRetryAt).getTime()
        : 0;
      const nowMs = Date.now();
      const canRunDaytimeRetry =
        DAYTIME_FAILED_RETRY_ENABLED &&
        failedCount > 0 &&
        (!lastDaytimeRetryAt || nowMs - lastDaytimeRetryAt >= DAYTIME_FAILED_RETRY_INTERVAL_MS);

      if (canRunDaytimeRetry) {
        await runDaytimeFailedRetry();
        await sleep(Math.min(LOOP_DELAY_MS, DAYTIME_FAILED_RETRY_INTERVAL_MS));
        continue;
      }

      const retryWaitMs =
        DAYTIME_FAILED_RETRY_ENABLED && failedCount > 0 && lastDaytimeRetryAt
          ? Math.max(DAYTIME_FAILED_RETRY_INTERVAL_MS - (nowMs - lastDaytimeRetryAt), 0)
          : waitMs;
      const sleepMs = Math.min(waitMs, retryWaitMs || waitMs);

      writeWorkerState({
        status: "waiting_window",
        message:
          DAYTIME_FAILED_RETRY_ENABLED && failedCount > 0
            ? `Outside night window. Next daytime failed-only retry in ${Math.round(
                sleepMs / 60000,
              )} minutes.`
            : `Outside night window. Waiting ${Math.round(waitMs / 60000)} minutes for next run.`,
      });
      await sleep(sleepMs);
      continue;
    }

    writeWorkerState({
      status: "running",
      message: "Running night-window crawl round.",
    });

    const exitCode = await runOneRound();
    const roundProgress = readOfflineProgress();
    const roundFailedCount = roundProgress.failedCodes?.length || 0;

    if (isCompleted()) {
      writeWorkerState({
        status: "completed",
        message: "All qualifications completed.",
      });
      console.log("Offline worker finished: all qualifications completed.");
      return;
    }

    writeWorkerState({
      status: roundFailedCount > 0 ? "cooldown_wait" : "waiting",
      lastExitCode: exitCode,
      failedCodes: roundProgress.failedCodes || [],
      message:
        roundFailedCount > 0
          ? `${roundFailedCount} qualifications remain in retry queue after this round.`
          : "Round completed. Waiting for next low-frequency cycle.",
    });

    console.log(
      `Offline worker round complete. exit=${exitCode}, failed=${roundFailedCount}, next check in ${Math.round(
        LOOP_DELAY_MS / 60000,
      )}m.`,
    );
    await sleep(LOOP_DELAY_MS);
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    writeWorkerState({
      status: "stopped",
      message: `Worker stopped after ${signal}.`,
    });
    removeWorkerState();
    process.exit(0);
  });
}

process.on("exit", () => {
  removeWorkerState();
});

main().catch((error) => {
  writeWorkerState({
    status: "error",
    message: error.message,
  });
  console.error("Offline worker failed:", error.message);
  removeWorkerState();
  process.exitCode = 1;
});
