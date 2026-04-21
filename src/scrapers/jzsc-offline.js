import { fetchCompaniesByQualification, fetchSurveyQualifications } from "../jzsc-api.js";
import {
  createEdgeSession,
  fetchCompaniesByQualificationViaBrowser,
  fetchSurveyQualificationsViaBrowser,
} from "../jzsc-browser.js";
import {
  readOfflineCache,
  readOfflineCrawlState,
  readOfflineProgress,
  rebuildOfflineCompanies,
  updateQualificationCrawlState,
  writeOfflineCache,
  writeOfflineProgress,
} from "../offline-store.js";

const LOW_RISK_PAGE_DELAY_MS = Number(process.env.QUALIFICATION_PAGE_DELAY_MS || 5000);
const FAILED_ONLY_PAGE_DELAY_MS = Number(
  process.env.FAILED_ONLY_PAGE_DELAY_MS || Math.max(LOW_RISK_PAGE_DELAY_MS, 9000),
);
const QUALIFICATION_SWITCH_DELAY_MS = Number(process.env.QUALIFICATION_SWITCH_DELAY_MS || 15000);
const FAILED_ONLY_SWITCH_DELAY_MS = Number(
  process.env.FAILED_ONLY_SWITCH_DELAY_MS || Math.max(QUALIFICATION_SWITCH_DELAY_MS, 30000),
);
const QUALIFICATION_RETRY_COUNT = Number(process.env.QUALIFICATION_RETRY_COUNT || 3);
const FAILED_ONLY_RETRY_COUNT = Number(process.env.FAILED_ONLY_RETRY_COUNT || 2);
const QUALIFICATION_RETRY_DELAY_MS = Number(process.env.QUALIFICATION_RETRY_DELAY_MS || 45000);
const FAILED_ONLY_RETRY_DELAY_MS = Number(
  process.env.FAILED_ONLY_RETRY_DELAY_MS || 180000,
);
const LOW_RISK_COOLDOWN_HOURS = Number(process.env.FAILED_COOLDOWN_HOURS || 12);
const HIGH_RISK_COOLDOWN_HOURS = Number(process.env.HIGH_RISK_COOLDOWN_HOURS || 36);
const PRIORITY_REFETCH_AFTER_HOURS = Number(process.env.PRIORITY_REFETCH_AFTER_HOURS || 24 * 7);
const STANDARD_REFETCH_AFTER_HOURS = Number(process.env.REFETCH_AFTER_HOURS || 24 * 30);
const RATE_LIMIT_PATTERN = /(401|403|Unauthorized|Forbidden|HTML response)/i;
const PRIORITY_QUALIFICATION_CODES = new Set([
  "B203A",
  "B202A",
]);

const args = new Set(process.argv.slice(2));
const targetCode =
  [...args].find((item) => item.startsWith("--code="))?.split("=")[1] || null;
const useEdgeSession = !args.has("--api");
const useHeaded = args.has("--headed");
const useManualKeepAlive = args.has("--manual-keepalive");
const failedOnly = args.has("--failed-only");
const retryCount = failedOnly ? FAILED_ONLY_RETRY_COUNT : QUALIFICATION_RETRY_COUNT;
const retryDelayMs = failedOnly ? FAILED_ONLY_RETRY_DELAY_MS : QUALIFICATION_RETRY_DELAY_MS;
const switchDelayMs = failedOnly ? FAILED_ONLY_SWITCH_DELAY_MS : QUALIFICATION_SWITCH_DELAY_MS;
const pageDelayMs = failedOnly ? FAILED_ONLY_PAGE_DELAY_MS : LOW_RISK_PAGE_DELAY_MS;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateProgress(partial) {
  const current = readOfflineProgress();
  return writeOfflineProgress({
    ...current,
    ...partial,
  });
}

function nowIso() {
  return new Date().toISOString();
}

function addHours(value, hours) {
  const next = new Date(value);
  next.setHours(next.getHours() + hours);
  return next.toISOString();
}

function classifyError(error) {
  const message = String(error?.message || "");
  if (/403|Forbidden/i.test(message)) {
    return "forbidden";
  }
  if (/401|Unauthorized/i.test(message)) {
    return "unauthorized";
  }
  if (/HTML response/i.test(message)) {
    return "html_response";
  }
  return "generic";
}

function getCooldownHours(category) {
  return category === "forbidden" || category === "unauthorized" || category === "html_response"
    ? HIGH_RISK_COOLDOWN_HOURS
    : LOW_RISK_COOLDOWN_HOURS;
}

function getRefetchAfterHours(qualification) {
  return PRIORITY_QUALIFICATION_CODES.has(qualification?.aptCode)
    ? PRIORITY_REFETCH_AFTER_HOURS
    : STANDARD_REFETCH_AFTER_HOURS;
}

function isFetchedQualificationStale(qualification, fetchedAt) {
  if (!fetchedAt) {
    return true;
  }
  const fetchedTime = new Date(fetchedAt).getTime();
  if (Number.isNaN(fetchedTime)) {
    return true;
  }
  return Date.now() - fetchedTime > getRefetchAfterHours(qualification) * 60 * 60 * 1000;
}

function getQualificationPriority(qualification, cache, crawlState) {
  const fetched = cache.fetchedQualifications?.[qualification.aptCode];
  const state = crawlState.qualificationStates?.[qualification.aptCode] || {};
  const cooldownUntil = state.cooldownUntil ? new Date(state.cooldownUntil).getTime() : 0;
  const inCooldown = cooldownUntil && cooldownUntil > Date.now();
  const isPriority = PRIORITY_QUALIFICATION_CODES.has(qualification.aptCode);

  if (failedOnly) {
    const lastAttemptAt = state.lastAttemptAt ? new Date(state.lastAttemptAt).getTime() : 0;
    return lastAttemptAt || 0;
  }

  if (!fetched) {
    return inCooldown ? (isPriority ? 30 : 50) : isPriority ? -20 : 0;
  }
  if (isFetchedQualificationStale(qualification, fetched.fetchedAt)) {
    return inCooldown ? (isPriority ? 40 : 60) : isPriority ? -10 : 10;
  }
  return inCooldown ? 100 : isPriority ? 15 : 20;
}

function shouldSkipByCooldown(qualification, crawlState) {
  if (failedOnly) {
    return false;
  }

  const state = crawlState.qualificationStates?.[qualification.aptCode];
  if (!state?.cooldownUntil) {
    return false;
  }
  const cooldownTime = new Date(state.cooldownUntil).getTime();
  return !Number.isNaN(cooldownTime) && cooldownTime > Date.now();
}

async function loadQualifications(browserSession, options = {}) {
  const cache = readOfflineCache();

  try {
    const qualifications = browserSession
      ? await fetchSurveyQualificationsViaBrowser(browserSession, options)
      : await fetchSurveyQualifications();

    if (qualifications.length) {
      return qualifications;
    }
  } catch (error) {
    if ((cache.qualifications || []).length) {
      console.log(`Using cached qualification catalog after fetch failure: ${error.message}`);
      return cache.qualifications;
    }
    throw error;
  }

  return cache.qualifications || [];
}

async function fetchWithQualificationRetry(qualification, startedAt, browserSession) {
  let lastError;

  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    updateProgress({
      status: "running",
      currentQualification: qualification,
      currentAttempt: attempt,
      maxAttempts: retryCount,
      lastError: null,
      startedAt,
    });

    updateQualificationCrawlState(qualification.aptCode, {
      lastAttemptAt: nowIso(),
    });

    try {
      const sharedOptions = {
        retryCount: failedOnly ? 1 : 2,
        retryDelayMs: failedOnly ? 15000 : 12000,
        pageDelayMs: useManualKeepAlive ? Math.max(pageDelayMs, 6500) : pageDelayMs,
        manualKeepAlive: useManualKeepAlive,
        manualPauseMs: failedOnly ? 60000 : 45000,
        onProgress(progress) {
          updateProgress({
            currentQualification: {
              ...qualification,
              page: progress.page + 1,
              fetchedCount: progress.fetchedCount,
              totalCompanies: progress.totalCompanies,
            },
            currentAttempt: attempt,
            maxAttempts: retryCount,
            startedAt,
          });
        },
      };

      const result = browserSession
        ? await fetchCompaniesByQualificationViaBrowser(
            browserSession,
            qualification,
            sharedOptions,
          )
        : await fetchCompaniesByQualification(qualification, sharedOptions);

      updateQualificationCrawlState(qualification.aptCode, {
        lastSuccessAt: nowIso(),
        consecutiveFailures: 0,
        lastStatusCodeCategory: "success",
        cooldownUntil: null,
      });

      return result;
    } catch (error) {
      lastError = error;
      const errorCategory = classifyError(error);
      const state = readOfflineCrawlState().qualificationStates?.[qualification.aptCode] || {};
      const consecutiveFailures = Number(state.consecutiveFailures || 0) + 1;

      updateQualificationCrawlState(qualification.aptCode, {
        lastAttemptAt: nowIso(),
        consecutiveFailures,
        lastStatusCodeCategory: errorCategory,
        cooldownUntil: addHours(nowIso(), getCooldownHours(errorCategory)),
      });

      updateProgress({
        currentQualification: qualification,
        currentAttempt: attempt,
        maxAttempts: retryCount,
        lastError: error.message,
        startedAt,
      });

      if (RATE_LIMIT_PATTERN.test(error.message || "")) {
        throw new Error(`Rate-limited qualification moved to cooldown queue: ${error.message}`);
      }

      if (attempt < retryCount) {
        console.log(
          `Retrying ${qualification.aptName} in ${Math.round(retryDelayMs / 1000)}s after failure: ${error.message}`,
        );
        await sleep(retryDelayMs);
      }
    }
  }

  throw lastError;
}

function buildQualificationList(qualifications, cache, crawlState) {
  const filtered = targetCode
    ? qualifications.filter((item) => item.aptCode === targetCode)
    : failedOnly
      ? qualifications.filter((item) =>
          (readOfflineProgress().failedCodes || []).includes(item.aptCode),
        )
      : qualifications.filter((item) => {
          const fetched = cache.fetchedQualifications?.[item.aptCode];
          return !fetched || isFetchedQualificationStale(item, fetched.fetchedAt);
        });

  return [...filtered]
    .filter((item) => !shouldSkipByCooldown(item, crawlState) || targetCode)
    .sort((a, b) => {
      const aPriority = getQualificationPriority(a, cache, crawlState);
      const bPriority = getQualificationPriority(b, cache, crawlState);
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      if (a.aptOrder !== b.aptOrder) {
        return a.aptOrder - b.aptOrder;
      }
      return a.aptCode.localeCompare(b.aptCode);
    });
}

async function main() {
  const modeLabel = useEdgeSession
    ? useManualKeepAlive
      ? "Edge manual keep-alive session"
      : "Edge session"
    : "API mode";
  console.log(`Starting offline crawl in ${modeLabel}${failedOnly ? " (failed-only)" : ""}.`);

  const browserSession = useEdgeSession
    ? await createEdgeSession({
        headless: !useHeaded,
        manualKeepAlive: useManualKeepAlive,
      })
    : null;

  try {
    const progress = readOfflineProgress();
    const cache = readOfflineCache();
    const crawlState = readOfflineCrawlState();
    const startedAt = progress.startedAt || nowIso();

    const qualifications = await loadQualifications(browserSession, {
      retryCount: 2,
      retryDelayMs: 15000,
      manualKeepAlive: useManualKeepAlive,
      manualPauseMs: failedOnly ? 60000 : 45000,
    });

    cache.qualifications = qualifications.map((item) => ({
      aptCode: item.aptCode,
      aptName: item.aptName,
      aptType: item.aptType,
      aptOrder: item.aptOrder,
    }));
    writeOfflineCache(cache);

    writeOfflineProgress({
      ...progress,
      status: "running",
      currentQualification: null,
      currentAttempt: 0,
      maxAttempts: retryCount,
      lastError: null,
      startedAt,
    });

    const qualificationList = buildQualificationList(qualifications, cache, crawlState);
    const failedQualifications = [];

    if (!qualificationList.length) {
      writeOfflineProgress({
        ...readOfflineProgress(),
        status: "waiting",
        currentQualification: null,
        currentAttempt: 0,
        maxAttempts: retryCount,
        lastError: "No due qualifications available for this round.",
        startedAt,
      });
      console.log("No qualifications selected for this round.");
      return;
    }

    for (const qualification of qualificationList) {
      const currentCache = readOfflineCache();
      const fetched = currentCache.fetchedQualifications?.[qualification.aptCode];
      if (
        fetched &&
        !isFetchedQualificationStale(qualification, fetched.fetchedAt) &&
        !targetCode &&
        !failedOnly
      ) {
        console.log(`Skipping fresh qualification: ${qualification.aptName}`);
        continue;
      }

      console.log(`Fetching qualification: ${qualification.aptName}`);
      updateProgress({
        status: "running",
        currentQualification: qualification,
        completedCodes: Object.keys(readOfflineCache().fetchedQualifications || {}),
        failedCodes: (readOfflineProgress().failedCodes || []).filter(
          (code) => code !== qualification.aptCode,
        ),
        currentAttempt: 1,
        maxAttempts: retryCount,
        lastError: null,
        startedAt,
      });

      try {
        const result = await fetchWithQualificationRetry(
          qualification,
          startedAt,
          browserSession,
        );

        const nextCache = readOfflineCache();
        nextCache.fetchedQualifications = {
          ...(nextCache.fetchedQualifications || {}),
          [qualification.aptCode]: {
            aptCode: qualification.aptCode,
            aptName: qualification.aptName,
            aptType: qualification.aptType,
            aptOrder: qualification.aptOrder,
            totalCompanies: result.totalCompanies,
            fetchedAt: result.fetchedAt,
            companies: result.companies,
          },
        };

        const rebuilt = rebuildOfflineCompanies(nextCache);
        writeOfflineCache(rebuilt);

        updateProgress({
          status: "running",
          currentQualification: qualification,
          completedCodes: Object.keys(rebuilt.fetchedQualifications || {}),
          failedCodes: (readOfflineProgress().failedCodes || []).filter(
            (code) => code !== qualification.aptCode,
          ),
          currentAttempt: 0,
          maxAttempts: retryCount,
          lastError: null,
          startedAt,
        });

        console.log(`Completed ${qualification.aptName}, companies=${result.totalCompanies}`);
        await sleep(switchDelayMs);
      } catch (error) {
        const failedCodes = new Set(readOfflineProgress().failedCodes || []);
        failedCodes.add(qualification.aptCode);
        failedQualifications.push(qualification);

        updateProgress({
          status: "paused",
          currentQualification: qualification,
          completedCodes: Object.keys(readOfflineCache().fetchedQualifications || {}),
          failedCodes: [...failedCodes],
          currentAttempt: retryCount,
          maxAttempts: retryCount,
          lastError: error.message,
          startedAt,
        });

        console.error(`Failed ${qualification.aptName}: ${error.message}`);
        await sleep(switchDelayMs);
      }
    }

    const finalCache = readOfflineCache();
    const finalProgress = readOfflineProgress();
    const remainingFailedCodes = finalProgress.failedCodes || [];
    const pendingQualifications = qualifications.filter((item) => {
      const fetched = finalCache.fetchedQualifications?.[item.aptCode];
      return !fetched || isFetchedQualificationStale(item, fetched.fetchedAt);
    });

    if (pendingQualifications.length === 0 && remainingFailedCodes.length === 0) {
      writeOfflineProgress({
        ...finalProgress,
        status: "completed",
        currentQualification: null,
        completedCodes: Object.keys(finalCache.fetchedQualifications || {}),
        failedCodes: [],
        currentAttempt: 0,
        maxAttempts: retryCount,
        lastError: null,
        startedAt,
      });
      console.log(
        `Offline crawl completed. qualifications=${finalCache.stats.fetchedQualificationCount}, companies=${finalCache.stats.companyCount}`,
      );
      return;
    }

    writeOfflineProgress({
      ...finalProgress,
      status: "paused",
      currentQualification:
        failedQualifications[failedQualifications.length - 1] || finalProgress.currentQualification,
      completedCodes: Object.keys(finalCache.fetchedQualifications || {}),
      failedCodes: [...new Set(remainingFailedCodes)],
      currentAttempt: retryCount,
      maxAttempts: retryCount,
      lastError: failedOnly
        ? "Failed-only round finished. Remaining qualifications will be retried later."
        : "This round finished. Remaining qualifications will continue in later low-frequency retries.",
      startedAt,
    });
    console.log(
      `Round finished. fetched=${finalCache.stats.fetchedQualificationCount}, remainingFailed=${remainingFailedCodes.length}`,
    );
    process.exitCode = failedQualifications.length ? 2 : 0;
  } finally {
    if (browserSession) {
      await browserSession.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error("Offline crawl failed:", error.message);
  process.exitCode = 1;
});
