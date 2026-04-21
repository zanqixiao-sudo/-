import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve("data");
const dbFile = path.join(dataDir, "companies.json");

function ensureDb() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(
      dbFile,
      JSON.stringify(
        {
          scope: {
            qyType: "QY_ZZ_ZZZD_003",
            qyTypeName: "勘察企业",
          },
          qualifications: [],
          companies: [],
          qualificationCache: {},
          stats: {
            qualificationCount: 0,
            companyCount: 0,
            relationCount: 0,
          },
          updatedAt: null,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
}

export function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(dbFile, "utf8"));
}

export function writeQualificationDataset(dataset) {
  ensureDb();
  const current = readDb();
  const payload = {
    ...current,
    ...dataset,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(dbFile, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

export function listQualifications() {
  const db = readDb();
  return db.qualifications || [];
}

export function updateQualifications(qualifications) {
  const db = readDb();
  const payload = {
    ...db,
    qualifications,
    companies: [],
    stats: {
      ...db.stats,
      qualificationCount: qualifications.length,
    },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(dbFile, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

export function cacheQualificationCompanies(qualification, companies) {
  const db = readDb();
  const qualificationCache = {
    ...(db.qualificationCache || {}),
    [qualification.aptCode]: {
      aptCode: qualification.aptCode,
      aptName: qualification.aptName,
      aptType: qualification.aptType,
      totalCompanies: companies.length,
      fetchedAt: new Date().toISOString(),
      companies,
    },
  };

  const payload = {
    ...db,
    qualificationCache,
    qualifications: (db.qualifications || []).map((item) =>
      item.aptCode === qualification.aptCode
        ? { ...item, totalCompanies: companies.length }
        : item,
    ),
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(dbFile, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

export function getCachedQualification(aptCode) {
  const db = readDb();
  return db.qualificationCache?.[aptCode] || null;
}

export function buildIntersectionFromQualifications(qualificationRows) {
  if (!qualificationRows.length) {
    const db = readDb();
    return db.companies || [];
  }

  const [first, ...rest] = qualificationRows;
  const map = new Map();

  for (const company of first.companies || []) {
    map.set(company.companyId, {
      ...company,
      qualificationCodes: [first.aptCode],
      qualificationNames: [first.aptName],
    });
  }

  for (const qualification of rest) {
    const currentIds = new Set((qualification.companies || []).map((item) => item.companyId));

    for (const companyId of [...map.keys()]) {
      if (!currentIds.has(companyId)) {
        map.delete(companyId);
      }
    }

    for (const company of qualification.companies || []) {
      const hit = map.get(company.companyId);
      if (hit) {
        hit.qualificationCodes.push(qualification.aptCode);
        hit.qualificationNames.push(qualification.aptName);
      }
    }
  }

  return [...map.values()].sort((a, b) =>
    a.companyName.localeCompare(b.companyName, "zh-CN"),
  );
}

export function searchCompanies({ keyword = "", qualificationCodes = [] } = {}) {
  const db = readDb();
  const q = String(keyword || "").trim().toLowerCase();
  const requiredCodes = qualificationCodes.filter(Boolean);

  const sourceRows = requiredCodes.length
    ? buildIntersectionFromQualifications(
        requiredCodes
          .map((code) => db.qualificationCache?.[code])
          .filter(Boolean),
      )
    : [];

  return sourceRows.filter((company) => {
    const keywordMatched = !q
      ? true
      : [
          company.companyName,
          company.unifiedCode,
          company.legalRepresentative,
          company.city,
          company.province,
          ...(company.qualificationNames || []),
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(q));

    const qualificationMatched = requiredCodes.every((code) =>
      (company.qualificationCodes || []).includes(code),
    );

    return keywordMatched && qualificationMatched;
  });
}
