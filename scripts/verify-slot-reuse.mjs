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
mustContain(
  "Per-slot feedback — no spoiler (CRITICAL):",
  "step1 per-slot no-spoiler feedback rule",
);
mustContain(
  "correctType filled, coreIssue missing -> confirm the type label only",
  "step1 Q1 feedback must not spoil coreIssue",
);
mustContain(
  'BAD (Q1 correct, coreIssue still missing): "它包含两个任务：分析原因 + 判断积极消极。"',
  "step1 no-spoiler bad example",
);
mustContain(
  'GOOD (Q1 correct): "Two-part，判断正确。"',
  "step1 no-spoiler good Q1 example",
);
mustContain(
  "Student-facing silence on skip (CRITICAL): never explain this gate in chat",
  "step1 hard-qualifier skip must stay silent in chat",
);
mustContain(
  'BAD (coreIssue correct, auto-skip constraints): "由于题目中没有 entirely/only',
  "step1 bad example: narrating hard-qualifier skip",
);
mustNotContain(
  "我们不需要做特殊的去极端化思考",
  "no de-extremization narration in prompt examples",
);

// Step 1 suggestedDimensions anti-fabrication + sufficiency gate
mustContain(
  "suggestedDimensions anti-fabrication rule (CRITICAL — do not pad to hit the count):",
  "step1 dimensions anti-fabrication rule header",
);
mustContain(
  "You MUST NOT invent an ADDITIONAL dimension the student never mentioned or implied just to reach the 2~4 target count.",
  "step1 dimensions anti-fabrication hard rule",
);
mustContain(
  'adding "文化身份认同" (never mentioned) as a 3rd dimension to look more thorough is FABRICATION and FORBIDDEN',
  "step1 dimensions anti-fabrication violation example",
);
mustContain(
  "Sufficiency gate: if the student's message truly yields only ONE genuine dimension, do NOT fabricate a second one and do NOT mark the step complete yet",
  "step1 dimensions sufficiency gate forbids premature completion",
);
mustContain(
  "at most ONE such follow-up for this slot; after that, accept whatever the student gives",
  "step1 dimensions follow-up is anti-loop bounded",
);
mustContain(
  "Feedback proportionality: Part 1's confirmation must match what was ACTUALLY given.",
  "step1 dimensions feedback proportionality rule",
);
mustContain(
  "suggestedDimensions has only 1 genuine dimension so far after both tasks -> use the sufficiency-gate follow-up above",
  "step1 dimensions missing-slot template covers single-dimension case",
);

// Step 1 granularity calibration (entry points, not content — do not drift into Step 2)
mustContain(
  "Granularity calibration (CRITICAL — Step 1 collects ENTRY POINTS, not content; do not drift into Step 2's job):",
  "step1 granularity calibration header",
);
mustContain(
  'If the student\'s answer is ALREADY a full causal chain or concrete scenario (e.g. "人们为了有更多的工作机会，会重点学习主流语言，母语会被忽略"), do NOT chase it deeper',
  "step1 granularity: abstract-up example mirrors real case",
);
mustContain(
  'Do NOT ask "这会带来什么影响" / "这是好事还是坏事" / "举个例子" while still in the suggestedDimensions slot',
  "step1 granularity: forbids Step2-style content questions in Step1",
);
mustContain(
  "This is the mirror-image of the global FILLED_SHALLOW follow-up rule",
  "step1 granularity: mirrors FILLED_SHALLOW rule in the opposite direction",
);

// Step 1 per-task dimension flow (compound question types)
mustContain(
  "Per-task dimension flow (CRITICAL — ONLY for compound question types where questionBrief.taskMap names 2 distinct tasks",
  "step1 per-task dimension flow header",
);
mustContain(
  "phrase BOTH as natural, direct ANGLE-level questions — never as a meta/procedural question about the analysis method itself, and never as a Step-2-style content/evaluation question",
  "step1 per-task dimension flow: angle-level, not content-level, phrasing",
);
mustContain(
  'FORBIDDEN framing: asking the student to judge whether their Task A angles "同样适用/是否可复用"',
  "step1 per-task dimension flow: forbids meta reusability framing",
);
mustContain(
  'FORBIDDEN framing (Granularity — CRITICAL): do NOT ask "这会带来什么影响" / "是好事还是坏事" / "举个例子"',
  "step1 per-task dimension flow: forbids Step2-style Task B content framing",
);
mustContain(
  "Do NOT invent the Task B dimension yourself — it must come from what the student actually said.",
  "step1 per-task dimension flow: Task B dimension must come from student",
);
mustContain(
  "Per-task sufficiency (CRITICAL — prefer collecting per-task, not just a pooled total):",
  "step1 per-task sufficiency header",
);
mustContain(
  "do not silently transition to the next task with only 1 angle recorded for the current one",
  "step1 per-task sufficiency: forbids premature task transition with only 1 angle",
);
mustContain(
  "Anti-loop: at most ONE such follow-up per task; if the student still only gives 1, accept it and move on",
  "step1 per-task sufficiency: anti-loop bounded per task",
);
mustContain(
  "Single-task question types (Agree / Disagree, Discuss Both Views, Advantages / Disadvantages) keep the existing single generic",
  "step1 per-task dimension flow: single-task types unaffected",
);
mustContain(
  "Tag each recorded dimension with which task(s) it covers using a short natural-language suffix",
  "step1 per-task dimension flow: dimension task tagging",
);
mustContain(
  "missing suggestedDimensions, compound type, Task A not yet answered -> use the Per-task dimension flow above, Task A question.",
  "step1 missing-slot template: compound type Task A",
);
mustContain(
  "Task A answered, Task B not yet answered (compound type) -> use the Per-task dimension flow above, Task B question (guided by Task A's answer).",
  "step1 missing-slot template: compound type Task B",
);
mustContain(
  "Task A dimensions given, Task B dimensions missing (compound type) -> confirm Task A's dimension(s) only; do NOT preview",
  "step1 no-spoiler rule covers Task A -> Task B transition",
);

// Step 2 dynamic dimension and anti-autofill
mustContain("Dimension-aware questioning rule (CRITICAL):", "step2 dimension-aware rule");
mustContain(
  "Preferred question: quote a Step1 dimension and ask for concrete scenarios/target groups/mechanism.",
  "step2 explore_A preferred question",
);
mustContain(
  "Preferred question: quote a Step1 dimension and ask for concrete expansion of THIS side/task.",
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
  "Transition to \"explore_B\" ONLY when Side A content is enough to illustrate as a claim",
  "explore_A sufficiency gate",
);
mustContain(
  "Transition to \"stance\" ONLY when Side B content is enough to illustrate as a claim",
  "explore_B sufficiency gate",
);
mustContain('STAY in "explore_A" and ask ONE depth follow-up', "explore_A not-sufficient branch");
mustContain('STAY in "explore_B" and ask ONE depth follow-up', "explore_B not-sufficient branch");
mustContain(
  "IF SUFFICIENT (exampleReady=true, or logicValid=true after one follow-up with （待补例子） tag) AND the retention rule did NOT trigger: briefly acknowledge and transition. Set currentStage: \"explore_B\".",
  "explore_A sufficient no-reask branch",
);
mustContain(
  "IF SUFFICIENT (exampleReady=true, or logicValid=true after one follow-up with （待补例子） tag) AND the retention rule did NOT trigger: briefly acknowledge and transition. Set currentStage: \"stance\".",
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
  "Also check progressUpdate.step2Data.userPoints / prior user messages on this side",
  "step2 retention trigger covers user-introduced dimensions",
);
mustContain(
  "only develops ONE of those named sub-dimensions",
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
  "function extractCoachQuestionsWindow(",
  "step2 retention guard: multi-turn coach question window exists",
);
mustContain(
  "coachQuestionsWindow",
  "step2 retention guard: coverage check uses coach question window",
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
  'A point tagged "待补例子" MUST NOT be described as "完整性极高"',
  "step2 summary stays honest about thin points tagged 待补例子",
);
mustContain(
  "Question-type stage mapping (CRITICAL)",
  "step2 maps explore stages by question type",
);
mustContain(
  "Dual readiness check (CRITICAL",
  "step2 distinguishes logicValid vs exampleReady",
);

// questionBrief + INTERNAL-ONLY (top-down ask strategy; never force Coach opinions)
mustContain("function buildQuestionBrief(", "questionBrief builder exists");
mustContain("function formatQuestionBriefForPrompt(", "questionBrief formatter exists");
mustContain("function applyNoHardQualifierGate(", "hard-qualifier gate safety net exists");
mustContain(
  "INTERNAL-ONLY RULE (CRITICAL, applies to all steps):",
  "global INTERNAL-ONLY RULE",
);
mustContain(
  "NATURAL LANGUAGE & CONTINUITY RULE (CRITICAL, applies to all steps):",
  "global natural language & continuity rule",
);
mustContain(
  "Any example wording given in these guidelines (e.g. \"ask something like: '...'\") is illustrative ONLY — rephrase it in your own natural words",
  "global rule: example wording is illustrative only, must be rephrased",
);
mustContain(
  'NEVER turn an internal bookkeeping check (e.g. "is this dimension reusable", "does this cover both tasks", "is there a hard qualifier") into the literal question you ask the student',
  "global rule: forbids exposing internal bookkeeping checks as student-facing questions",
);
mustContain(
  "Hard-qualifier gate (from INTERNAL questionBrief — CRITICAL):",
  "step1 hard-qualifier gate in prompt",
);
mustContain(
  'If questionBrief.hasHardQualifiers=false: do NOT ask the constraints question',
  "step1 skips constraints when no hard qualifiers",
);
mustContain(
  'Structural preview ONLY (optional, one short clause): e.g. "下面我们按：原因段 → 评价段 来梳理"',
  "step1 completion preview is structural only",
);
mustContain(
  'FORBIDDEN: recommending which stance option is safer/better/more common (e.g. "多数稳妥路径是弊大于利" / "建议选③")',
  "step2 stance forbids recommending a preferred stance",
);
mustContain(
  "Candidate directions MUST be neutral: do NOT imply which direction is easier, safer, or higher-scoring",
  "step2 candidate directions must stay neutral",
);
mustContain(
  "You may privately consult questionBrief.candidateDirectionSeeds, but never present them as preferred answers",
  "step2 candidateDirectionSeeds are internal-only",
);
mustContain(
  "Internal brief: questionBrief, writingDestination, taskMap, hasHardQualifiers, candidateDirectionSeeds, evalNote, recommendedStance, easyCauses",
  "NO INTERNAL JARGON lists brief fields including rejected content fields",
);
mustNotContain("recommendedStance:", "no recommendedStance field assignment in brief");
mustNotContain("easyPath", "no easyPath content-suggestion structure");
mustNotContain(
  "可轻提示：多数稳妥路径",
  "no soft stance recommendation phrasing",
);

// Step 3 length budget
mustContain("LENGTH BUDGET (decide mode & detail BEFORE writing steps):", "step3 length budget header");
mustContain("targets about 90-110 words total", "step3 90-110 word budget");
mustContain(
  "Do NOT mechanically force major+minor for symmetric two-point claims.",
  "step3 no-two-major rule",
);
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
  "if (step === 3 && typeof data?.text",
  "global jargon guard: not limited to step 3 only",
);
mustNotContain(
  "Explicitly DECLARE the paragraphPlan mode",
  "step3 prompt: old DECLARE instruction removed",
);
mustContain(
  "give the student a short plain-language summary",
  "step3 prompt: user-facing summary instead of DECLARE",
);
mustContain(
  'When speaking to the student, say "关键限定"',
  "step1 prompt: use Chinese labels not raw field names",
);
mustContain(
  "Never say explore_A/B, currentStage, or recommendation enum names in chat text",
  "step2 prompt: forbids stage/enum names in chat text",
);
assert.ok(
  step3DraftingSource.includes("结构细节写入系统即可，不要在对话里提字段名"),
  "Missing: step3 kickoff: no internal field names in kickoff prompt",
);
console.log("OK: step3 kickoff: no internal field names in kickoff prompt");

console.log("\nAll slot-reuse/static-guard assertions passed.");
