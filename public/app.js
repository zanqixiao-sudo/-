const state = {
  cache: null,
  qualifications: [],
  selectedCodes: new Set(),
  status: null,
  sharedMode: false,
  previewMode: false,
  refreshing: false,
  runtimeMode: "api",
  lastQueryResults: [],
};

const WEEKLY_UPDATE_CODES = new Set(["B203A", "B202A"]);

const elements = {
  refreshStatus: document.querySelector("#refresh-status"),
  logoutButton: document.querySelector("#logout-button"),
  excelLink: document.querySelector("#excel-link"),
  progressStatus: document.querySelector("#progress-status"),
  progressDetail: document.querySelector("#progress-detail"),
  progressBar: document.querySelector("#progress-bar"),
  progressNote: document.querySelector("#progress-note"),
  qualificationProgressBar: document.querySelector("#qualification-progress-bar"),
  qualificationProgressNote: document.querySelector("#qualification-progress-note"),
  libraryStatus: document.querySelector("#library-status"),
  libraryDetail: document.querySelector("#library-detail"),
  fetchedCount: document.querySelector("#fetched-count"),
  companyCount: document.querySelector("#company-count"),
  qualificationTotal: document.querySelector("#qualification-total"),
  qualificationFilter: document.querySelector("#qualification-filter"),
  qualificationList: document.querySelector("#qualification-list"),
  selectedSummary: document.querySelector("#selected-summary"),
  clearSelection: document.querySelector("#clear-selection"),
  keywordInput: document.querySelector("#keyword-input"),
  queryButton: document.querySelector("#query-button"),
  exportButton: document.querySelector("#export-button"),
  messageBox: document.querySelector("#message-box"),
  resultCount: document.querySelector("#result-count"),
  selectedCount: document.querySelector("#selected-count"),
  resultBody: document.querySelector("#result-body"),
};

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) {
    return "未更新";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未更新";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setMessage(text, type = "info") {
  elements.messageBox.textContent = text;
  elements.messageBox.dataset.type = type;
}

function setRefreshState(isRefreshing) {
  state.refreshing = isRefreshing;
  elements.refreshStatus.disabled = isRefreshing;
  elements.refreshStatus.textContent = isRefreshing ? "刷新中..." : "刷新数据状态";
}

function buildQueryUrl(basePath) {
  const url = new URL(basePath, window.location.origin);
  const selected = [...state.selectedCodes];
  const keyword = elements.keywordInput.value.trim();
  url.searchParams.set("qualifications", selected.join(","));
  if (keyword) {
    url.searchParams.set("keyword", keyword);
  }
  return url;
}

function getSelectedQualifications() {
  return state.qualifications.filter((item) => state.selectedCodes.has(item.aptCode));
}

function updateSelectedSummary() {
  const selected = getSelectedQualifications();
  elements.selectedCount.textContent = String(selected.length);

  if (!selected.length) {
    elements.selectedSummary.textContent = "尚未选择资质";
    return;
  }

  elements.selectedSummary.textContent = `已选择 ${selected.length} 个资质：${selected
    .map((item) => item.aptName)
    .join("；")}`;
}

function renderQualifications() {
  const keyword = elements.qualificationFilter.value.trim().toLowerCase();
  const filtered = state.qualifications.filter((item) =>
    item.aptName.toLowerCase().includes(keyword),
  );

  if (!filtered.length) {
    elements.qualificationList.innerHTML = '<div class="empty-list">没有匹配的资质</div>';
    return;
  }

  elements.qualificationList.innerHTML = filtered
    .map((item) => {
      const checked = state.selectedCodes.has(item.aptCode) ? "checked" : "";
      const countText = item.fetched ? `${formatNumber(item.totalCompanies)} 家企业` : "待补充";
      const badgeClass = item.fetched ? "badge badge-ready" : "badge badge-pending";
      const isWeekly = WEEKLY_UPDATE_CODES.has(item.aptCode);
      const updatedText = item.fetchedAt
        ? `本次更新：${formatDateTime(item.fetchedAt)}`
        : "本次更新：尚未整理";
      const scheduleText = isWeekly ? "周更新资质｜建议周更" : "月更新资质｜滚动补库";

      return `
        <label class="qualification-item">
          <input type="checkbox" value="${escapeHtml(item.aptCode)}" ${checked} />
          <div class="qualification-copy">
            <strong>${escapeHtml(item.aptName)}</strong>
            <span>${escapeHtml(item.aptCode)}</span>
            <small class="qualification-priority ${isWeekly ? "is-priority" : ""}">${escapeHtml(scheduleText)}</small>
            <small class="qualification-updated">${escapeHtml(updatedText)}</small>
          </div>
          <span class="${badgeClass}">${escapeHtml(countText)}</span>
        </label>
      `;
    })
    .join("");

  for (const input of elements.qualificationList.querySelectorAll("input[type='checkbox']")) {
    input.addEventListener("change", () => {
      if (input.checked) {
        state.selectedCodes.add(input.value);
      } else {
        state.selectedCodes.delete(input.value);
      }
      updateSelectedSummary();
    });
  }
}

function filterCompaniesLocal(cache, qualificationCodes, keyword) {
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

function buildStaticStatus(cache) {
  const qualificationItems = (cache.qualifications || []).map((item) => {
    const fetched = cache.fetchedQualifications?.[item.aptCode];
    return {
      ...item,
      fetched: Boolean(fetched),
      totalCompanies: fetched?.totalCompanies ?? null,
      fetchedAt: fetched?.fetchedAt ?? null,
    };
  });

  const totalQualifications = qualificationItems.length;
  const fetchedQualificationCount = qualificationItems.filter((item) => item.fetched).length;
  const recentUpdatedAt = qualificationItems
    .map((item) => item.fetchedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || cache.updatedAt || null;

  return {
    scope: cache.scope || { qyTypeName: "勘察企业" },
    stats: {
      qualificationCount: totalQualifications,
      fetchedQualificationCount,
      companyCount: Number(cache.stats?.companyCount || (cache.companies || []).length),
      relationCount: Number(cache.stats?.relationCount || 0),
    },
    progress: {
      status: "shared",
      currentQualification: null,
      completedCodes: qualificationItems.filter((item) => item.fetched).map((item) => item.aptCode),
      failedCodes: [],
      updatedAt: recentUpdatedAt,
    },
    worker: {
      running: false,
      status: "disabled",
      message: "静态部署模式不包含在线抓取守护。",
    },
    crawlState: {
      qualificationStates: {},
    },
    sharedMode: true,
    previewMode: false,
    excel: {
      exists: true,
      filename: "勘察企业离线总库.xlsx",
      url: "/downloads/%E5%8B%98%E5%AF%9F%E4%BC%81%E4%B8%9A%E7%A6%BB%E7%BA%BF%E6%80%BB%E5%BA%93.xlsx",
    },
    updatedAt: cache.updatedAt || recentUpdatedAt,
  };
}

function renderStatus() {
  const status = state.status || {};
  const stats = status.stats || {};
  const progress = status.progress || {};
  const fetchedQualifications = Number(stats.fetchedQualificationCount || 0);
  const totalQualifications = Number(stats.qualificationCount || 0);
  const currentQualification = progress.currentQualification?.aptName;
  const currentPage = progress.currentQualification?.page;
  const currentFetched = Number(progress.currentQualification?.fetchedCount || 0);
  const currentTotal = Number(progress.currentQualification?.totalCompanies || 0);
  const currentAttempt = Number(progress.currentAttempt || 0);
  const maxAttempts = Number(progress.maxAttempts || 0);
  const qualificationRatio = totalQualifications
    ? Math.min((fetchedQualifications / totalQualifications) * 100, 100)
    : 0;
  const currentQualificationRatio = currentTotal
    ? Math.min((currentFetched / currentTotal) * 100, 100)
    : 0;

  state.sharedMode = Boolean(status.sharedMode);
  state.previewMode = Boolean(status.previewMode);
  elements.logoutButton.classList.toggle("hidden", !state.previewMode);

  elements.fetchedCount.textContent = `${formatNumber(fetchedQualifications)} / ${formatNumber(
    totalQualifications,
  )}`;
  elements.companyCount.textContent = formatNumber(stats.companyCount);

  if (status.excel?.exists && status.excel.url) {
    elements.excelLink.classList.remove("hidden");
    elements.excelLink.href = status.excel.url;
  } else {
    elements.excelLink.classList.add("hidden");
    elements.excelLink.removeAttribute("href");
  }

  elements.progressBar.style.width = `${Math.max(qualificationRatio, 8)}%`;
  elements.qualificationProgressBar.style.width = `${Math.max(currentQualificationRatio, 8)}%`;

  if (state.runtimeMode === "static" || state.sharedMode || state.previewMode) {
    const recentUpdatedAt = status.updatedAt || progress.updatedAt || null;
    elements.progressStatus.textContent = "最近更新时间";
    elements.progressDetail.textContent = recentUpdatedAt
      ? `本地离线库最近更新：${formatDateTime(recentUpdatedAt)}`
      : "当前暂无最近更新时间。";
    elements.progressNote.textContent = `已整理 ${formatNumber(fetchedQualifications)} / ${formatNumber(
      totalQualifications,
    )} 个资质`;
    elements.qualificationProgressBar.style.width = "100%";
    elements.qualificationProgressNote.textContent =
      state.runtimeMode === "static"
        ? "当前页面为静态部署模式，查询与下载均直接基于离线库。"
        : "当前页面默认使用本地离线库提供查询与下载。";
  } else if (progress.status === "running") {
    elements.progressStatus.textContent = "正在抓取中";
    elements.progressDetail.textContent = currentQualification
      ? `当前资质：${currentQualification}${currentPage ? `，第 ${currentPage} 页` : ""}`
      : "后台抓取任务正在运行。";
    elements.progressNote.textContent =
      currentTotal > 0
        ? `当前资质已抓 ${formatNumber(currentFetched)} / ${formatNumber(currentTotal)}，当前第 ${currentAttempt || 1}${maxAttempts ? ` / ${maxAttempts}` : ""} 次尝试`
        : `已完成 ${formatNumber(fetchedQualifications)} / ${formatNumber(totalQualifications)} 个资质整理`;
    elements.qualificationProgressNote.textContent =
      currentTotal > 0
        ? `当前资质进度 ${Math.round(currentQualificationRatio)}%`
        : "等待当前资质分页进度...";
  } else if (progress.status === "completed") {
    elements.progressStatus.textContent = "抓取已完成";
    elements.progressDetail.textContent = "全部资质已整理完成，当前查询与下载均基于本地离线总库。";
    elements.progressNote.textContent = `已完成 ${formatNumber(fetchedQualifications)} / ${formatNumber(
      totalQualifications,
    )} 个资质整理`;
    elements.qualificationProgressBar.style.width = "100%";
    elements.qualificationProgressNote.textContent = "当前资质进度 100%";
  } else if (progress.status === "paused") {
    elements.progressStatus.textContent = "本轮补库已结束";
    elements.progressDetail.textContent = currentQualification
      ? `最新处理资质：${currentQualification}${currentPage ? `，第 ${currentPage} 页` : ""}`
      : "本轮补库已结束，等待下一次执行。";
    elements.progressNote.textContent =
      progress.lastError || "剩余资质会在下一轮低频重试中继续处理。";
    elements.qualificationProgressNote.textContent =
      currentTotal > 0
        ? `当前资质进度 ${Math.round(currentQualificationRatio)}%`
        : "当前资质进度暂不可用。";
  } else {
    elements.progressStatus.textContent = "等待补库窗口";
    elements.progressDetail.textContent = "当前页面可正常查询与下载，抓取可稍后继续。";
    elements.progressNote.textContent = "数据会在后续补库后继续更新。";
    elements.qualificationProgressNote.textContent = "等待当前资质进度...";
  }

  if (progress.status === "completed") {
    elements.libraryStatus.textContent = "离线总库已整理完成";
    elements.libraryDetail.textContent = "当前查询与下载均基于本地离线总库，可直接使用。";
    return;
  }

  if (fetchedQualifications > 0) {
    elements.libraryStatus.textContent = "离线总库可用";
    elements.libraryDetail.textContent =
      state.runtimeMode === "static" || state.sharedMode || state.previewMode
        ? "当前页面基于离线库提供查询、筛选与下载。"
        : currentQualification
          ? `当前本地库仍在补充中，最新整理到：${currentQualification}${currentPage ? ` 第 ${currentPage} 页` : ""}。`
          : "当前可先使用已整理完成的数据进行查询与下载。";
    return;
  }

  elements.libraryStatus.textContent = "离线总库准备中";
  elements.libraryDetail.textContent = "当前还没有可用的离线总表，请稍后刷新。";
}

function renderResults(items) {
  if (!items.length) {
    elements.resultBody.innerHTML =
      '<tr><td colspan="5" class="empty-row">当前条件下没有匹配企业</td></tr>';
    return;
  }

  elements.resultBody.innerHTML = items
    .map((item) => {
      const region = [item.province, item.city, item.regionName].filter(Boolean).join(" / ");
      const qualificationNames = (item.qualificationNames || []).join("；");
      return `
        <tr>
          <td>${escapeHtml(item.companyName || "-")}</td>
          <td>${escapeHtml(item.unifiedCode || "-")}</td>
          <td>${escapeHtml(item.legalRepresentative || "-")}</td>
          <td>${escapeHtml(region || "-")}</td>
          <td>${escapeHtml(qualificationNames || "-")}</td>
        </tr>
      `;
    })
    .join("");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("预览登录已失效，请重新输入口令。");
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || "请求失败");
  }
  return data;
}

async function tryLoadApiMode() {
  const [status, qualifications] = await Promise.all([
    fetchJson("/api/offline/status"),
    fetchJson("/api/offline/qualifications"),
  ]);

  state.runtimeMode = "api";
  state.status = status;
  state.qualifications = qualifications.items || [];
}

async function loadStaticMode() {
  const cache = await fetchJson("/data/offline-cache.json");
  state.runtimeMode = "static";
  state.cache = cache;
  state.status = buildStaticStatus(cache);
  state.qualifications = (state.status.stats.qualificationCount
    ? (cache.qualifications || []).map((item) => {
        const fetched = cache.fetchedQualifications?.[item.aptCode];
        return {
          ...item,
          fetched: Boolean(fetched),
          totalCompanies: fetched?.totalCompanies ?? null,
          fetchedAt: fetched?.fetchedAt ?? null,
        };
      })
    : []
  ).sort((a, b) => {
    if (a.aptOrder !== b.aptOrder) {
      return a.aptOrder - b.aptOrder;
    }
    return a.aptCode.localeCompare(b.aptCode);
  });
}

function renderLoadedData() {
  elements.qualificationTotal.textContent = `共 ${state.qualifications.length} 个资质`;
  renderStatus();
  renderQualifications();
  updateSelectedSummary();
}

async function loadAllData() {
  try {
    await tryLoadApiMode();
  } catch {
    await loadStaticMode();
  }

  renderLoadedData();
}

async function queryCompanies() {
  const selected = [...state.selectedCodes];
  if (!selected.length) {
    setMessage("请先在左侧选择一个或多个资质。", "warn");
    renderResults([]);
    elements.resultCount.textContent = "0";
    return;
  }

  setMessage("正在从离线总库查询，请稍候...", "info");
  elements.queryButton.disabled = true;

  try {
    let items = [];
    let total = 0;

    if (state.runtimeMode === "api") {
      const data = await fetchJson(buildQueryUrl("/api/offline/companies"));
      items = data.items || [];
      total = Number(data.total || items.length);
    } else {
      const keyword = elements.keywordInput.value.trim();
      const companies = filterCompaniesLocal(state.cache, selected, keyword);
      items = companies.slice(0, 2000);
      total = companies.length;
    }

    state.lastQueryResults = items;
    elements.resultCount.textContent = formatNumber(total);
    renderResults(items);
    setMessage(
      total
        ? `已命中 ${formatNumber(total)} 家企业，可以继续下载当前筛选表。`
        : "当前条件下没有找到匹配企业，建议调整资质组合或关键词。",
      total ? "success" : "warn",
    );
  } catch (error) {
    setMessage(`查询失败：${error.message}`, "error");
  } finally {
    elements.queryButton.disabled = false;
  }
}

function exportCurrentResultsStatic() {
  const selected = [...state.selectedCodes];
  if (!selected.length) {
    setMessage("请先选择资质并完成查询后，再下载当前筛选表。", "warn");
    return;
  }

  const keyword = elements.keywordInput.value.trim();
  const rows = buildExportRows(state.lastQueryResults);
  const exportRows = rows.length
    ? rows
    : [
        {
          说明: "当前筛选条件下没有匹配企业",
          关键词: keyword || "无",
          资质编码: selected.join("；") || "无",
        },
      ];

  if (window.XLSX) {
    const workbook = window.XLSX.utils.book_new();
    const worksheet = window.XLSX.utils.json_to_sheet(exportRows);
    const metaSheet = window.XLSX.utils.json_to_sheet([
      {
        导出时间: new Date().toLocaleString("zh-CN"),
        关键词: keyword || "无",
        资质编码: selected.join("；") || "无",
        命中企业数: state.lastQueryResults.length,
      },
    ]);
    window.XLSX.utils.book_append_sheet(workbook, worksheet, "筛选结果");
    window.XLSX.utils.book_append_sheet(workbook, metaSheet, "导出说明");
    const filename = `筛选结果-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.xlsx`;
    window.XLSX.writeFile(workbook, filename);
  } else {
    const header = Object.keys(exportRows[0]);
    const csv = [
      header.join(","),
      ...exportRows.map((row) =>
        header
          .map((key) => `"${String(row[key] ?? "").replaceAll('"', '""')}"`)
          .join(","),
      ),
    ].join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `筛选结果-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  setMessage("正在下载当前筛选表，请稍候...", "success");
}

function exportCurrentResults() {
  const selected = [...state.selectedCodes];
  if (!selected.length) {
    setMessage("请先选择资质并完成查询后，再下载当前筛选表。", "warn");
    return;
  }

  if (state.runtimeMode === "api") {
    const url = buildQueryUrl("/api/offline/export/current.xlsx");
    window.location.href = url.toString();
    setMessage("正在下载当前筛选表，请稍候...", "success");
    return;
  }

  exportCurrentResultsStatic();
}

async function logoutPreview() {
  elements.logoutButton.disabled = true;
  try {
    await fetch("/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/login";
  }
}

async function bootstrap() {
  await loadAllData();
}

elements.refreshStatus.addEventListener("click", async () => {
  if (state.refreshing) {
    return;
  }

  setRefreshState(true);
  setMessage("正在刷新本地数据状态...", "info");

  try {
    await loadAllData();
    setMessage(
      `本地数据状态已刷新，最近更新时间：${formatDateTime(state.status?.updatedAt)}`,
      "success",
    );
  } catch (error) {
    setMessage(`刷新失败：${error.message}`, "error");
  } finally {
    setRefreshState(false);
  }
});

elements.qualificationFilter.addEventListener("input", renderQualifications);
elements.queryButton.addEventListener("click", queryCompanies);
elements.exportButton.addEventListener("click", exportCurrentResults);
elements.logoutButton.addEventListener("click", logoutPreview);
elements.clearSelection.addEventListener("click", () => {
  state.selectedCodes.clear();
  renderQualifications();
  updateSelectedSummary();
  setMessage("已清空当前资质选择。", "success");
});

bootstrap().catch((error) => {
  setMessage(`页面初始化失败：${error.message}`, "error");
});

window.setInterval(() => {
  loadAllData().catch(() => {});
}, 30000);
