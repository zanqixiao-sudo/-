import { fetchSurveyQualifications } from "../jzsc-api.js";
import { updateQualifications } from "../storage.js";

async function main() {
  try {
    console.log("开始同步勘察企业资质目录...");
    const qualifications = await fetchSurveyQualifications();
    const payload = updateQualifications(qualifications);
    console.log(`已同步 ${payload.qualifications.length} 个勘察资质，更新时间 ${payload.updatedAt}`);
  } catch (error) {
    console.error("抓取失败:", error.message);
    process.exitCode = 1;
  }
}

main();
