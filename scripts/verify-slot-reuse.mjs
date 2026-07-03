import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const serverPath = path.join(repoRoot, "server.ts");
const step3DraftingPath = path.join(repoRoot, "src/components/Step3Drafting.tsx");
const source = fs.readFileSync(serverPath, "utf8");
const step3DraftingSource = fs.readFileSync(step3DraftingPath, "utf8");

function mustContain(snippet, label) {
  assert.ok(source.includes(snippet), `Missing: ${label}`);
  console.log(`OK: ${label}`);
}

function mustNotContain(snippet, label) {
  assert.ok(!source.includes(snippet), `Should be absent but found: ${label}`);
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
mustContain("线上教育是否会完全替代传统课堂", "step1 entirely skip example (mirrors real case)");

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
  'IF SUFFICIENT (already enough to illustrate as a claim) AND the retention rule did NOT trigger: do NOT re-ask or repeat any depth question about Side A',
  "explore_A sufficient no-reask branch",
);
mustContain(
  'IF SUFFICIENT (already enough to illustrate as a claim) AND the retention rule did NOT trigger: do NOT re-ask or repeat any depth question about Side B',
  "explore_B sufficient no-reask branch",
);

// Step 2 Dimension Coverage & Retention Rule (prevents silently dropping sibling dimensions)
mustContain(
  "Dimension Coverage & Retention Rule (CRITICAL — prevents silently dropping sibling dimensions):",
  "step2 retention rule header",
);
mustContain(
  "MANDATORY FIRST STEP before you decide anything else about transitioning",
  "step2 retention rule is a mandatory pre-transition check",
);
mustContain(
  "plus the student's own current/prior message on this side",
  "step2 retention trigger covers user-introduced dimensions",
);
mustContain(
  "not a mere synonym/rephrasing of it — a substantively different angle",
  "step2 retention rule excludes synonym repeats",
);
mustContain(
  "ask the depth follow-up first (existing Content-completeness boundary rule); do NOT ask about the uncovered dimension in that same turn",
  "step2 retention rule mutually exclusive with depth follow-up",
);
mustContain(
  "anti-loop: at most ONE retention question per side",
  "step2 retention rule anti-loop",
);
mustContain(
  "Do NOT rely on 'clustering' or 'outliers' during explore_A/explore_B",
  "step2 retention rule userPoints is the real-time carrier, not outliers",
);
mustContain(
  'FIRST apply the Dimension Coverage & Retention Rule\'s mandatory first step above. If it triggers, keep currentStage: "explore_A" this turn',
  "step2 explore_A transition wired to retention rule",
);
mustContain(
  'FIRST apply the Dimension Coverage & Retention Rule\'s mandatory first step above. If it triggers, keep currentStage: "explore_B" this turn',
  "step2 explore_B transition wired to retention rule",
);
mustContain(
  "Retention-aware clustering (CRITICAL)",
  "step2 summary stage reads retention tags",
);
mustContain(
  'Do NOT ask an open-ended "which do you prefer" question — you must EVALUATE first and state ONE default recommendation with a reason',
  "step2 main prompt: retention rule mirrors guard's evaluate-then-recommend behavior (not just the code fallback)",
);
mustContain(
  "evaluate whether the uncovered dimension directly answers a core qualifier/contrast in the essay question",
  "step2 main prompt: relevance-to-question evaluation described for solid branch",
);
mustContain(
  "interpret the student's reply RELATIVE TO the specific default recommendation you proposed",
  "step2 main prompt: resolves ambiguous replies relative to the proposed recommendation, not a fixed default",
);

// Step 2 Dimension Coverage & Retention Guard (deterministic verification-call fallback,
// since the prompt-only rule was verified to be diluted inside the huge Step2 prompt).
mustContain(
  "function checkStep2DimensionCoverage(",
  "step2 retention guard: verification-call function exists",
);
mustContain(
  "function applyStep2RetentionGuard(",
  "step2 retention guard: orchestration function exists",
);
mustContain(
  "function extractPendingRetention(",
  "step2 retention guard: pending-marker extractor exists",
);
mustContain(
  "function resolvePendingRetentionChoice(",
  "step2 retention guard: pending-choice resolver exists",
);
mustContain(
  "function extractLastCoachQuestion(",
  "step2 retention guard: last-question extractor exists",
);
mustContain(
  "await applyStep2RetentionGuard(data, session, userMessage, messages, question);",
  "step2 retention guard: wired into coach handler",
);
mustContain(
  "fail-open, no correction applied",
  "step2 retention guard: fails open on verification-call error",
);

// Step 2 Retention Recommendation (evaluate-then-recommend, not open-ended A/B)
mustContain(
  "function decideStep2Retention(",
  "step2 retention: pure decision-table function exists",
);
mustContain(
  "uncoveredRelevantToQuestion",
  "step2 retention: relevance-to-question signal exists",
);
mustContain(
  '"EXPAND_BOTH" | "KEEP_MINOR" | "DROP"',
  "step2 retention: recommendation enum defined",
);
mustContain(
  "Recommendation was to drop; an explicit",
  "step2 retention: resolver interprets reply relative to proposed recommendation",
);
mustContain(
  "建议把『${uncovered}』保留下来作为一个略写的补充点",
  "step2 retention: KEEP_MINOR template gives default recommendation with reason",
);
mustContain(
  "建议专注写这一点就好",
  "step2 retention: DROP template gives default recommendation with reason",
);
mustContain(
  "［待裁决：${uncovered}｜${recommendation}］",
  "step2 retention: pending marker embeds the recommendation for later resolution",
);
mustContain(
  'A point tagged "保留-略写" MUST be mapped into its body paragraph as a minor/brief supporting point',
  "step2 summary maps retained dimension to minor point",
);
mustContain(
  'A point tagged "用户放弃" MUST be listed in clustering.outliers',
  "step2 summary maps dropped dimension to outliers",
);

// Step 3 length budget
mustContain("LENGTH BUDGET (decide mode & detail BEFORE writing steps):", "step3 length budget header");
mustContain("targets about 90-110 words total", "step3 90-110 word budget");
mustContain("For a 2-point claim, do NOT mark both pointBlocks as 'major'.", "step3 no-two-major rule");
mustContain("Length-aware balance:", "step3 length-aware balance rule");

// Step 3 plain-language / writability standard
mustContain(
  "## STEP 3 PLAIN-LANGUAGE / WRITABILITY STANDARD (CRITICAL, governs all Chinese you generate here):",
  "step3 writability standard header",
);
mustContain(
  'Could a band 5-5.5 student translate this into ONE simple English sentence?',
  "step3 writability test",
);
mustContain(
  'Do NOT provide a second "higher-band" Chinese version.',
  "step3 no dual-version rule",
);
mustContain(
  "you may polish wording to be CLEARER and SIMPLER (NOT more academic or fancy)",
  "global polish rule simplified",
);
mustNotContain(
  "you may polish wording (more academic, concise)",
  "old more-academic polish rule removed",
);
mustNotContain("用极具温度、学术感和鼓励性的中文", "step3 closing academic tone removed");

// Step 1 constraint re-ask fix: strengthened skip rule (B)
mustContain(
  "Recognizing it verbally in your feedback is NOT enough.",
  "step1 skip rule: recognition != slot fill",
);
mustContain(
  "VIOLATION (do NOT do this): filing the qualifier only into coreIssue",
  "step1 skip rule: violation example",
);

// Step 1 constraint re-ask fix: deterministic backfill safety net (A)
mustContain("function detectEchoedQualifiers(", "step1 backfill: qualifier detector exists");
mustContain("function backfillStep1Constraints(", "step1 backfill: backfill function exists");
mustContain("function looksLikeConstraintQuestion(", "step1 backfill: constraint-question detector exists");
mustContain("function isStep1SlotsComplete(", "step1 completion: slot checker exists");
mustContain("function enforceStep1SlotCompletion(", "step1 completion: enforce function exists");
mustContain("function applyStepCompletionHeuristic(", "step completion: heuristic function exists");
mustContain("function textSuggestsStep1Complete(", "step1 completion: text heuristic exists");
mustContain("Step 1 deterministic safety net (A):", "step1 backfill: wired in coach handler");
mustContain("progressUpdate.isCompleted: true", "step1 prompt: requires isCompleted on completion");
mustContain("Do NOT populate progressUpdate.step2Data while step=1", "step1 prompt: anti-drift rule");
mustContain("applyStepCompletionHeuristic(data, currentStepNum)", "step completion: heuristic wired after backfill");

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

// Cross-step NO INTERNAL JARGON IN CHAT TEXT
mustContain(
  "NO INTERNAL JARGON IN CHAT TEXT (CRITICAL, applies to ALL steps 1–5):",
  "global jargon rule: cross-step header exists",
);
mustContain(
  'Do NOT narrate your decision process',
  "global jargon rule: forbids decision-process narration",
);
mustContain(
  "function stripInternalJargonFromChatText(",
  "global jargon guard: strip function exists",
);
mustContain(
  "[JargonGuard] Stripped internal terms from step",
  "global jargon guard: wired for all steps in coach handler",
);
mustNotContain(
  "Explicitly DECLARE the paragraphPlan mode",
  "step3 prompt: old DECLARE instruction removed",
);
mustContain(
  "give the student a short plain-language summary",
  "step3 prompt: user-facing summary instead of DECLARE",
);
assert.ok(
  step3DraftingSource.includes("结构细节写入系统即可，不要在对话里提字段名"),
  "Missing: step3 kickoff: no internal field names in kickoff prompt",
);
console.log("OK: step3 kickoff: no internal field names in kickoff prompt");

console.log("\nAll slot-reuse/static-guard assertions passed.");
