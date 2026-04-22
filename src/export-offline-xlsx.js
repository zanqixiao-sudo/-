import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import { readOfflineCache } from "./offline-store.js";

const outputDir = path.resolve("output", "spreadsheet");
const outputFile = path.join(outputDir, "勘察企业离线总库.xlsx");

function ensureOutputDir() {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
}

function autosizeWorksheet(worksheet, rows) {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  worksheet["!cols"] = keys.map((key) => {
    const maxCell = Math.max(
      key.length,
      ...rows.map((row) => String(row[key] ?? "").length),
    );
    return { wch: Math.min(Math.max(maxCell + 2, 12), 36) };
  });
}

function getFetchedQualifications(cache) {
  const fetchedMap = cache.fetchedQualifications || {};
  return (cache.qualifications || [])
    .filter((item) => fetchedMap[item.aptCode])
    .sort((a, b) => {
      if (a.aptOrder !== b.aptOrder) {
        return a.aptOrder - b.aptOrder;
      }
      return a.aptCode.localeCompare(b.aptCode);
    });
}

function buildCompanyRows(cache) {
  const fetchedQualifications = getFetchedQualifications(cache);

  return (cache.companies || []).map((company) => {
    const codeSet = new Set(company.qualificationCodes || []);
    const row = {
      企业ID: company.companyId,
      企业名称: company.companyName,
      统一社会信用代码: company.unifiedCode,
      法人: company.legalRepresentative,
      省份: company.province,
      城市: company.city,
      注册属地: company.regionName,
      已抓取资质数量: (company.qualificationCodes || []).length,
      已抓取资质编码汇总: (company.qualificationCodes || []).join("；"),
      已抓取资质名称汇总: (company.qualificationNames || []).join("；"),
    };

    for (const qualification of fetchedQualifications) {
      row[`${qualification.aptCode}_${qualification.aptName}`] = codeSet.has(
        qualification.aptCode,
      )
        ? "有"
        : "";
    }

    return row;
  });
}

function buildQualificationRows(cache) {
  return (cache.qualifications || []).map((item) => {
    const fetched = cache.fetchedQualifications?.[item.aptCode];

    return {
      资质编码: item.aptCode,
      资质名称: item.aptName,
      资质类别编码: item.aptType,
      排序: item.aptOrder,
      是否已抓取: fetched ? "是" : "否",
      企业数量: fetched?.totalCompanies ?? "",
      抓取时间: fetched?.fetchedAt ?? "",
    };
  });
}

function buildRelationRows(cache) {
  const rows = [];

  for (const qualification of Object.values(cache.fetchedQualifications || {})) {
    for (const company of qualification.companies || []) {
      rows.push({
        资质编码: qualification.aptCode,
        资质名称: qualification.aptName,
        企业ID: company.companyId,
        企业名称: company.companyName,
        统一社会信用代码: company.unifiedCode,
        法人: company.legalRepresentative,
        省份: company.province,
        城市: company.city,
      });
    }
  }

  return rows;
}

function buildMetaRows(cache) {
  const fetchedQualifications = getFetchedQualifications(cache);

  return [
    {
      导出时间: new Date().toLocaleString("zh-CN"),
      离线库更新时间: cache.updatedAt || "",
      资质总数: Number(cache.stats?.qualificationCount || (cache.qualifications || []).length),
      已抓取资质数: fetchedQualifications.length,
      企业总数: Number(cache.stats?.companyCount || (cache.companies || []).length),
      企业资质关系数: Number(cache.stats?.relationCount || 0),
    },
  ];
}

function main() {
  const cache = readOfflineCache();

  if (!cache.companies?.length) {
    throw new Error("离线总库还没有企业数据，请先执行 npm run prefetch:offline");
  }

  ensureOutputDir();

  const workbook = XLSX.utils.book_new();
  const companyRows = buildCompanyRows(cache);
  const qualificationRows = buildQualificationRows(cache);
  const relationRows = buildRelationRows(cache);
  const metaRows = buildMetaRows(cache);

  const companySheet = XLSX.utils.json_to_sheet(companyRows);
  const qualificationSheet = XLSX.utils.json_to_sheet(qualificationRows);
  const relationSheet = XLSX.utils.json_to_sheet(relationRows);
  const metaSheet = XLSX.utils.json_to_sheet(metaRows);

  autosizeWorksheet(companySheet, companyRows);
  autosizeWorksheet(qualificationSheet, qualificationRows);
  autosizeWorksheet(relationSheet, relationRows);
  autosizeWorksheet(metaSheet, metaRows);

  XLSX.utils.book_append_sheet(workbook, companySheet, "企业总表");
  XLSX.utils.book_append_sheet(workbook, qualificationSheet, "资质总表");
  XLSX.utils.book_append_sheet(workbook, relationSheet, "企业资质关系");
  XLSX.utils.book_append_sheet(workbook, metaSheet, "导出说明");

  XLSX.writeFile(workbook, outputFile);
  console.log(`Excel 已导出: ${outputFile}`);
}

main();
