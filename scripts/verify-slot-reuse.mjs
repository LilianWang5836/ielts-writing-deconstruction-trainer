import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const serverPath = path.join(repoRoot, "server.ts");
const source = fs.readFileSync(serverPath, "utf8");

function mustContain(snippet, label) {
  assert.ok(source.includes(snippet), `Missing: ${label}`);
  console.log(`OK: ${label}`);
}

// Global rules
mustContain("SLOT REUSE RULE (CRITICAL, applies to all steps):", "global slot reuse rule");
mustContain(
  "CONTENT COMPLETENESS VS POLISH BOUNDARY (CRITICAL, applies to all steps):",
  "global completeness vs polish rule",
);
mustContain(
  "Anti-loop guard: each slot/point allows at most ONE depth follow-up.",
  "global anti-loop guard",
);

// Step 1 slot checklist + cross-slot example
mustContain("## Step 1 Slot Checklist (按缺口推进，不重复提问)", "step1 slot checklist");
mustContain("Cross-slot extraction is mandatory", "step1 cross-slot extraction instruction");
mustContain("already contains \"完全/entirely\"", "step1 entirely skip example");

// Step 2 dynamic dimension and anti-autofill
mustContain("Dimension-aware questioning rule (CRITICAL):", "step2 dimension-aware rule");
mustContain(
  "Preferred question: If Step1 dimensions already include online-flexibility/resource-access style ideas",
  "step2 explore_A preferred question",
);
mustContain(
  "Preferred question: If Step1 dimensions already include offline-irreplaceability style ideas",
  "step2 explore_B preferred question",
);
mustContain("If user answer only repeats known labels", "step2 no label-repeat autofill rule");
mustContain("You MUST NOT introduce new mechanism/scenario/beneficiary details", "step2 anti-autofill hard rule");

// Step 3 completeness boundary
mustContain("Apply content-completeness boundary here:", "step3 completeness boundary section");
mustContain("you MUST ask a depth follow-up for missing mechanism/scenario/outcome", "step3 fragment follow-up rule");
mustContain("If the student already provides mechanism + beneficiary + outcome", "step3 polish allowed rule");
mustContain("若是 FILLED_SHALLOW：最多追问一次具体化问题", "step3 follow-up-once rule in progression");

// Step 2 explore sufficiency gating (explore_A + explore_B)
mustContain("Next Stage Transition (sufficiency-gated):", "explore sufficiency-gated transition header");
mustContain(
  "Transition to \"explore_B\" ONLY when the Side A content is sufficient enough for further illustration as a claim",
  "explore_A sufficiency gate",
);
mustContain(
  "Transition to \"stance\" ONLY when the Side B content is sufficient enough for further illustration as a claim",
  "explore_B sufficiency gate",
);
mustContain('STAY in "explore_A" and ask ONE depth follow-up', "explore_A not-sufficient branch");
mustContain('STAY in "explore_B" and ask ONE depth follow-up', "explore_B not-sufficient branch");
mustContain(
  'IF SUFFICIENT (already enough to illustrate as a claim): do NOT re-ask or repeat any depth question about Side A',
  "explore_A sufficient no-reask branch",
);
mustContain(
  'IF SUFFICIENT (already enough to illustrate as a claim): do NOT re-ask or repeat any depth question about Side B',
  "explore_B sufficient no-reask branch",
);

// Step 3 length budget
mustContain("LENGTH BUDGET (decide mode & detail BEFORE writing steps):", "step3 length budget header");
mustContain("targets about 90-110 words total", "step3 90-110 word budget");
mustContain("For a 2-point claim, do NOT mark both pointBlocks as 'major'.", "step3 no-two-major rule");
mustContain("Length-aware balance:", "step3 length-aware balance rule");

// Merge guard functions and wiring
mustContain("function sanitizeProgressUpdateWithSession(", "merge guard function exists");
mustContain("isBlankStringArray", "merge guard array blank detector");
mustContain("data.progressUpdate = sanitizeProgressUpdateWithSession(", "merge guard wired before output");

// Deterministic tests mirroring merge guard behavior
function isBlankString(v) {
  return typeof v === "string" && v.trim() === "";
}
function isBlankStringArray(v) {
  return Array.isArray(v) && v.every((item) => String(item || "").trim() === "");
}
function sanitizeProgressUpdateWithSession(progressUpdate, session) {
  if (!progressUpdate || typeof progressUpdate !== "object") return progressUpdate;

  const step1New = progressUpdate?.step1Data;
  const step1Old = session?.step1?.coachEvaluation || {};
  if (step1New && typeof step1New === "object") {
    const step1StringKeys = ["correctType", "coreIssue", "critique", "writingTask", "keyQualifier"];
    for (const key of step1StringKeys) {
      if (isBlankString(step1New[key]) && String(step1Old?.[key] || "").trim()) {
        delete step1New[key];
      }
    }
    const step1ArrayKeys = ["constraints", "suggestedDimensions"];
    for (const key of step1ArrayKeys) {
      if (
        isBlankStringArray(step1New[key]) &&
        Array.isArray(step1Old?.[key]) &&
        step1Old[key].length > 0
      ) {
        delete step1New[key];
      }
    }
  }

  const step2New = progressUpdate?.step2Data;
  const step2Old = session?.step2?.coachEvaluation || {};
  if (step2New && typeof step2New === "object") {
    const step2StringKeys = [
      "currentStage",
      "userStance",
      "userPoints",
      "critique",
      "suggestedStance",
      "suggestedPoints",
      "positionCheckDesc",
      "coverageCheckDesc",
      "structureCheckDesc",
    ];
    for (const key of step2StringKeys) {
      if (isBlankString(step2New[key]) && String(step2Old?.[key] || "").trim()) {
        delete step2New[key];
      }
    }
    if (
      isBlankStringArray(step2New?.suggestions) &&
      Array.isArray(step2Old?.suggestions) &&
      step2Old.suggestions.length > 0
    ) {
      delete step2New.suggestions;
    }
  }

  return progressUpdate;
}

{
  const progress = { step1Data: { constraints: [] } };
  const session = { step1: { coachEvaluation: { constraints: ["entirely"] } } };
  sanitizeProgressUpdateWithSession(progress, session);
  assert.equal("constraints" in progress.step1Data, false, "Step1 constraints empty overwrite should be dropped");
  console.log("OK: step1 constraints empty overwrite dropped");
}

{
  const progress = { step1Data: { coreIssue: "" } };
  const session = { step1: { coachEvaluation: { coreIssue: "线上教育是否能完全取代线下学校" } } };
  sanitizeProgressUpdateWithSession(progress, session);
  assert.equal("coreIssue" in progress.step1Data, false, "Step1 coreIssue empty overwrite should be dropped");
  console.log("OK: step1 coreIssue empty overwrite dropped");
}

{
  const progress = { step2Data: { userPoints: "", suggestions: [] } };
  const session = {
    step2: {
      coachEvaluation: {
        userPoints: "A面：灵活性；B面：监督与互动",
        suggestions: ["补充受益人群"],
      },
    },
  };
  sanitizeProgressUpdateWithSession(progress, session);
  assert.equal("userPoints" in progress.step2Data, false, "Step2 userPoints empty overwrite should be dropped");
  assert.equal("suggestions" in progress.step2Data, false, "Step2 suggestions empty overwrite should be dropped");
  console.log("OK: step2 empty overwrite dropped");
}

{
  const progress = { step2Data: { userPoints: "新增：偏远地区学生受益明显" } };
  const session = { step2: { coachEvaluation: { userPoints: "旧值" } } };
  sanitizeProgressUpdateWithSession(progress, session);
  assert.equal(progress.step2Data.userPoints, "新增：偏远地区学生受益明显", "Non-empty new value must be kept");
  console.log("OK: non-empty values are preserved");
}

console.log("\nAll slot-reuse/static-guard assertions passed.");
