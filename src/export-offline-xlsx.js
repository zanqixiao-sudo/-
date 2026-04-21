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

function buildCompanyRows(cache) {
  return (cache.companies || []).map((company) => ({
    企业ID: company.companyId,
    企业名称: company.companyName,
    统一社会信用代码: company.unifiedCode,
    法人: company.legalRepresentative,
    省份: company.province,
    城市: company.city,
    注册属地: company.regionName,
    资质数量: (company.qualificationCodes || []).length,
    资质编码: (company.qualificationCodes || []).join("；"),
    资质名称: (company.qualificationNames || []).join("；"),
  }));
}

function buildQualificationRows(cache) {
  return (cache.qualifications || []).map((item) => {
    const fetched = cache.fetchedQualifications?.[item.aptCode];

    return {
      资质编码: item.aptCode,
      资质名称: item.aptName,
      资质类别编码: item.aptType,
      排序: item.aptOrder,
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

function autosizeWorksheet(worksheet, rows) {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  worksheet["!cols"] = keys.map((key) => {
    const maxCell = Math.max(
      key.length,
      ...rows.map((row) => String(row[key] ?? "").length),
    );
    return { wch: Math.min(maxCell + 2, 60) };
  });
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

  const companySheet = XLSX.utils.json_to_sheet(companyRows);
  const qualificationSheet = XLSX.utils.json_to_sheet(qualificationRows);
  const relationSheet = XLSX.utils.json_to_sheet(relationRows);

  autosizeWorksheet(companySheet, companyRows);
  autosizeWorksheet(qualificationSheet, qualificationRows);
  autosizeWorksheet(relationSheet, relationRows);

  XLSX.utils.book_append_sheet(workbook, companySheet, "企业总表");
  XLSX.utils.book_append_sheet(workbook, qualificationSheet, "资质总表");
  XLSX.utils.book_append_sheet(workbook, relationSheet, "企业资质关系");

  XLSX.writeFile(workbook, outputFile);
  console.log(`Excel 已导出: ${outputFile}`);
}

main();
