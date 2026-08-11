import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const serverPath = path.join(repoRoot, "server.ts");
const step3DraftingPath = path.join(repoRoot, "src/components/Step3Drafting.tsx");
const step3QualityPath = path.join(repoRoot, "src/utils/step3Quality.ts");
const step2BrainstormPath = path.join(repoRoot, "src/components/Step2Brainstorm.tsx");
const source = fs.readFileSync(serverPath, "utf8");
const step3DraftingSource = fs.readFileSync(step3DraftingPath, "utf8");
const step3QualitySource = fs.readFileSync(step3QualityPath, "utf8");
const step2BrainstormSource = fs.readFileSync(step2BrainstormPath, "utf8");

function mustContain(snippet, label) {
  assert.ok(source.includes(snippet), `Missing: ${label}`);
  console.log(`OK: ${label}`);
}

function mustNotContain(snippet, label) {
  assert.ok(!source.includes(snippet), `Should be absent but found: ${label}`);
  console.log(`OK: ${label}`);
}

// Global rules
mustContain(
  "INTENT CLASSIFICATION BEFORE FORMAT (CRITICAL, applies to all steps",
  "global intent-classification-before-format meta rule exists",
);
mustContain(
  "ASKING FOR YOUR JUDGMENT/OPINION",
  "global intent classification: covers delegated-judgment intent generically",
);
mustContain(
  "is only ONE possible way to phrase this, not a mandatory template",
  "global intent classification: literal confirmation phrase downgraded to example",
);
mustContain(
  "This rule does NOT apply to CTA phrases explicitly marked",
  "global intent classification: CTA literal-phrase contracts remain exempt",
);
mustContain(
  "a CONSTRAINT, not a literal template",
  "step2 compact feedback rule downgraded from literal template to constraint",
);
mustNotContain(
  'Part 1 MUST be one short confirmation in this shape: "很好，目前我们记录到：[用户原话要点]。"',
  "old literal Compact feedback template removed",
);
mustNotContain(
  'Feedback format MUST be concise: "很好，目前我们记录到：[用户已给出的点]。"',
  "old per-stage literal feedback template removed",
);
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
mustContain(
  "是否要在公共场所完全禁止吸烟",
  "step1 entirely/all skip example (mirrors real case)",
);
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
  "You MUST NOT invent an ADDITIONAL dimension the student never mentioned or implied just to reach a target count.",
  "step1 dimensions anti-fabrication hard rule",
);
mustContain(
  "Causal-chain vs parallel-angles test (CRITICAL — decide split vs collapse BEFORE writing labels):",
  "step1 dimensions causal-chain vs parallel-angles test",
);
mustContain(
  'student says "经济文化交流增多之后，强势文化流入，对本国文化的冲击". This is ONE causal chain',
  "step1 dimensions causal-chain violation mirrors real case",
);
mustContain(
  'adding "文化身份认同" (never mentioned) as an extra dimension to look more thorough is FABRICATION and FORBIDDEN',
  "step1 dimensions anti-fabrication violation example",
);
mustContain(
  "AI sufficiency first (CRITICAL): YOU judge whether the angle set is enough BEFORE asking the student",
  "step1 dimensions sufficiency gate forbids premature completion",
);
mustContain(
  "each dimension gets at most ONE probe",
  "step1 dimensions follow-up is anti-loop bounded",
);
mustContain(
  "Feedback proportionality: Part 1's confirmation must match what was ACTUALLY given.",
  "step1 dimensions feedback proportionality rule",
);
mustContain(
  "suggestedDimensions has fewer than 3 effective dimensions so far -> ask for another NEW angle with no exit option yet",
  "step1 dimensions missing-slot template covers under-3 effective case",
);

// Step 1 board-authority + continuation-signal routing
mustContain(
  "Board-authority rule (CRITICAL — right-side diagnosis board may be user-edited):",
  "step1 board-authority rule header",
);
mustContain(
  "When a slot already has a non-empty value in ContextSummary, treat it as filled. Do NOT overwrite it in progressUpdate with a different AI-preferred wording unless the student explicitly asks to change it in chat.",
  "step1 board-authority: do not overwrite filled board values",
);
mustContain(
  "Continuation-signal routing (CRITICAL — student may still be finishing the previous task after you already asked the next one):",
  "step1 continuation-signal routing header",
);
mustContain(
  'If your previous question already moved to Task B (or the next slot), but the student\'s CURRENT message signals they are still continuing the previous task — e.g. "还没说完"',
  "step1 continuation-signal: recognizes 还没说完-style signals",
);
mustContain(
  "then route this turn's content into the PREVIOUS task/slot",
  "step1 continuation-signal: routes into previous task/slot",
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
  "HARD: do NOT ask Task B while any Task A label is still unprobed",
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
mustContain(
  "FORBIDDEN when suggestedDimensions is non-empty in ContextSummary",
  "step2 forbid re-asking dimension inventory / coreIssue / type",
);
mustContain(
  'Re-asking a dimension inventory: "可以从哪些角度切入"',
  "step2 forbid angle-list questions",
);
mustContain(
  "Re-confirming question type / correctType",
  "step2 forbid re-confirming question type",
);
mustContain(
  "Re-confirming coreIssue / writing task",
  "step2 forbid re-confirming coreIssue",
);
mustContain(
  "Student's own words from Step 1 (unprocessed",
  "step1 raw student words in ContextSummary",
);

// Step 2 kickoff must name a Step1 dimension and forbid angle-list questions
assert.ok(
  step2BrainstormSource.includes("直接进入 Explore-A：点名第一步已确认的维度"),
  "Missing: step2 kickoff names a Step1 dimension",
);
console.log("OK: step2 kickoff names a Step1 dimension");
assert.ok(
  step2BrainstormSource.includes("禁止再问「可以从哪些角度切入」"),
  "Missing: step2 kickoff forbids angle-list questions",
);
console.log("OK: step2 kickoff forbids angle-list questions");
assert.ok(
  step2BrainstormSource.includes("禁止再确认题型或核心议题"),
  "Missing: step2 kickoff forbids re-confirming type/coreIssue",
);
console.log("OK: step2 kickoff forbids re-confirming type/coreIssue");

// Step 3 completeness boundary
mustContain("Apply content-completeness boundary here:", "step3 completeness boundary section");
mustContain("you MUST ask a depth follow-up for missing mechanism/scenario/outcome", "step3 fragment follow-up rule");
mustContain("If the student already provides mechanism + beneficiary + outcome", "step3 polish allowed rule");
mustContain("若是 EMPTY / FILLED_SHALLOW：mode=expand", "step3 follow-up-once rule in progression");

// Step 2 explore sufficiency gating (explore_A + explore_B)
mustContain("Next Stage Transition (sufficiency-gated):", "explore sufficiency-gated transition header");
mustContain(
  "Transition to \"explore_B\" ONLY when Side A content is enough to illustrate as a claim",
  "explore_A sufficiency gate",
);
mustContain(
  "Transition to \"stance\" ONLY when requiresStance=true AND Side B content is enough to illustrate as a claim",
  "explore_B sufficiency gate",
);
mustContain('STAY in "explore_A" and ask ONE depth follow-up', "explore_A not-sufficient branch");
mustContain('STAY in "explore_B" and ask ONE depth follow-up', "explore_B not-sufficient branch");
mustContain(
  "IF SUFFICIENT (exampleReady=true, or logicValid=true after one follow-up with （待补例子） tag) AND the retention rule did NOT trigger: briefly acknowledge and transition. Set currentStage: \"explore_B\".",
  "explore_A sufficient no-reask branch",
);
mustContain(
  "If questionBrief.requiresStance=true: Set currentStage: \"stance\" AND immediately",
  "explore_B sufficient → immediate stance recommendation when requiresStance",
);
mustContain(
  "If questionBrief.requiresStance=false: Set currentStage: \"summary\" (skip stance entirely)",
  "explore_B sufficient → summary when no stance",
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
  "Anti-loop: at most ONE 详写/略写 choice question per side",
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
  "Retention tags in userPoints (已选详写/已选略写/用户放弃/待补例子) still matter",
  "step2 summary stage reads retention tags",
);
mustContain(
  "Only then may you present a numbered 详略 scheme for confirm (UI「采纳/拒绝」)",
  "step2 main prompt: recommend-then-confirm instead of forced KEEP/DROP",
);
mustContain(
  'Bounce-back ("你觉得呢"/"你定") → do NOT tag',
  "step2 main prompt: bounce-back replies wait for confirm before tagging",
);
mustContain(
  "function isRetentionSoftAckConfirm(",
  "step2 retention: soft ack 好/可以 counts while pending confirm-ask",
);
mustContain(
  "请再补充 1-2 句具体场景 / 机制 / 受影响对象，把它写扎实。",
  "step2 main prompt: expand chosen detail point after role choice",
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
  "await applyStep2RetentionGuard(",
  "step2 retention guard: wired into coach handler",
);
mustContain(
  "applyStep2ProposalChannelEarly(",
  "step2 proposal channel: early accept/reject wired before retention guard",
);
mustContain(
  "applyStep2ProposalChannelLate(data, session, userMessage);",
  "step2 proposal channel: late arm wired after ask-contract",
);
mustContain(
  "fail-open, no correction applied",
  "step2 retention guard: fails open on verification-call error",
);
mustContain(
  "function textSuggestsExploreSideAdvance(",
  "step2 retention guard: verbal side-advance detector exists",
);
mustContain(
  "[Step2RetentionGuard][NO_TRANSITION]",
  "step2 retention guard: logs when no stage/verbal transition",
);
mustContain(
  "[Step2RetentionGuard][NO_TRIGGER]",
  "step2 retention guard: logs when coverage check does not intervene",
);
mustContain(
  "[Step2RetentionGuard][CALL_FAILED]",
  "step2 retention guard: tags verification-call failures distinctly",
);
mustContain(
  "[Step2RetentionGuard][VERBAL_ADVANCE]",
  "step2 retention guard: logs text/field desync verbal advances",
);
mustContain(
  "Already-recorded brainstorm points (priorUserPoints) already list TWO OR MORE",
  "step2 retention guard: coverage check treats priorUserPoints siblings as multi-dimension",
);
mustContain(
  "Anti-loop vs retention precedence (CRITICAL)",
  "step2 prompt: anti-loop does not override retention of sibling dimensions",
);
mustContain(
  "it does NOT authorize skipping a sibling named dimension",
  "step2 prompt: explore transition anti-loop cannot skip uncovered siblings",
);
assert.ok(
  step2BrainstormSource.includes("function stripStep2InternalTags("),
  "Missing: step2 blueprint UI strips internal retention/thinness tags before display",
);
console.log("OK: step2 blueprint UI strips internal retention/thinness tags before display");
assert.ok(
  step2BrainstormSource.includes("function splitUserPointsForBlueprint("),
  "Missing: step2 blueprint UI splits userPoints by A面/B面 instead of newline index",
);
console.log("OK: step2 blueprint UI splits userPoints by A面/B面 instead of newline index");
assert.ok(
  !step2BrainstormSource.includes("evalData.userPoints.split('\\n')[0]"),
  "Should be absent but found: step2 blueprint no longer uses naive newline split for body1",
);
console.log("OK: step2 blueprint no longer uses naive newline split for body1");

// Board role inference must NOT leak sibling locked tags onto an unmentioned
// slot (incident: unfilled B-side 商业发展 painted 详写 by A-side 已选详写
// via the whole-text fallback window).
assert.ok(
  step2BrainstormSource.includes("if (!relevant.length) return undefined;"),
  "Missing: board retentionRoleFromUserPoints returns undefined for unmentioned claims",
);
console.log("OK: board retentionRoleFromUserPoints returns undefined for unmentioned claims");
assert.ok(
  !step2BrainstormSource.includes("(relevant.length ? relevant : chunks).join"),
  "Should be absent but found: whole-corpus fallback window in board role inference",
);
console.log("OK: board role inference whole-corpus fallback removed");
assert.ok(
  !step2BrainstormSource.includes(
    "retentionRoleFromUserPoints(\n                              claim,\n                              userPointsRaw,\n                            )",
  ),
  "Should be absent but found: board role rendering bypasses roleCorpus guard with raw userPoints",
);
console.log("OK: board role rendering only reads the locked-tag corpus");

// Step 2 Retention: ask student to choose 详写/略写 (heuristic default only on vague reply)
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
  "function resolveRetentionUserChoice(",
  "step2 retention: ask-then-expand choice resolver exists",
);
mustContain(
  "ACTIVE POINT FOCUS",
  "step2 prompt: active point focus rule",
);
mustContain(
  "NEW SLOT ONLY AFTER CONFIRM",
  "step2 prompt: new slot only after confirm",
);
mustContain(
  "function applyStep2FocusAndSlotAddPostProcess(",
  "step2 focus/slot-add post-process exists",
);
mustContain(
  "activePointId",
  "step2 planner payload tracks activePointId",
);
mustContain(
  "focusMode",
  "step2 planner payload tracks deepen focusMode",
);
mustContain(
  "CRITICAL — ACTIVE POINT FOCUS / MOUNT: Server mounts STUDENT material only",
  "step2 dual-path mount: deepen rescue vs chunk match",
);
mustContain(
  "function isRetentionDeferToCoach(",
  "step2 retention: bounce-back detector exists",
);
mustContain(
  "function isRetentionExplicitConfirm(",
  "step2 retention: explicit-confirm detector exists",
);
mustContain(
  "applied: false",
  "step2 retention: choice result can await confirm without tagging",
);
mustContain(
  "function extractPointContent(",
  "step2 retention: extracts on-record content for a labeled point",
);
mustContain(
  "function pointAlreadyHasConcreteContent(",
  "step2 retention: sufficiency check against on-record content exists",
);
mustContain(
  "content already concrete — skipping redundant expand ask",
  "step2 retention: skips redundant expand-ask when content already provided",
);
mustContain(
  "const alreadySolid = pointAlreadyHasConcreteContent(\n        data.progressUpdate.step2Data.userPoints,\n        choice.needExpandDetail,\n      );",
  "step2 retention: checks freshly-tagged userPoints (not raw choice message) for sufficiency",
);
mustContain(
  "是否按这个方案定下来？请回复「同意」「好」或直接说明你的详略选择。",
  "step2 retention: ask student to confirm recommended detail vs brief",
);
mustContain(
  "[Step2RetentionGuard][PENDING_AWAIT_CONFIRM]",
  "step2 retention: pending branch waits for explicit confirm before tagging",
);
mustContain(
  "［待裁决：详=${pending.developed}｜略=${pending.uncovered}｜默认=${pending.recommendation || \"EXPAND_BOTH\"}］",
  "step2 retention: pending marker embeds both candidates and default",
);
mustContain(
  "do NOT silently assign 详写/略写 for the student",
  "step2 prompt: forbids AI-forced detail/brief assignment",
);
mustContain(
  "Allowed Actions: recommend stance + point selection + major/minor roles",
  "step2 summary maps retained dimension to minor point",
);
mustContain(
  'Tag thin developed points so summary does not claim "完整性极高"',
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
mustContain("function detectRequiresStance(", "requiresStance detector exists");
mustContain("function hasExplicitStanceAsk(", "explicit stance-ask detector exists");
mustContain("requiresStance:", "questionBrief prompt includes requiresStance");
mustContain('requiresStance: ${brief.requiresStance ? "true" : "false"}', "questionBrief formats requiresStance boolean");
mustContain("function applyNoStanceGate(", "no-stance gate safety net exists");
mustContain("function buildOverviewStance(", "overview stance builder for no-stance essays");
mustContain(
  "When INTERNAL questionBrief.requiresStance=false: NEVER enter \"stance\"",
  "step2 prompt: skip stance when requiresStance=false",
);
mustContain(
  "If questionBrief.requiresStance=false: Set currentStage: \"summary\" (skip stance entirely)",
  "step2 explore_B: transitions to summary when no stance required",
);
mustContain(
  "ONLY enter this stage when questionBrief.requiresStance=true",
  "step2 stance stage gated by requiresStance",
);
mustContain(
  "applyNoStanceGate(question, data, session)",
  "no-stance gate wired after Step2 retention guard",
);

// Cross-step memory digests (stable digest + sourceHash + invalidation)
mustContain("function stableHash(", "memory: stableHash exists");
mustContain("function computeStep1SourceHash(", "memory: step1 sourceHash exists");
mustContain("function computeStep2SourceHash(", "memory: step2 sourceHash exists");
mustContain("function computeStep3SourceHash(", "memory: step3 sourceHash exists");
mustContain("function buildStep1Digest(", "memory: buildStep1Digest exists");
mustContain("function buildStep2Digest(", "memory: buildStep2Digest exists");
mustContain("function buildStep3Digest(", "memory: buildStep3Digest exists");
mustContain("function resolveSessionMemory(", "memory: resolveSessionMemory exists");
mustContain("function refreshMemoryAfterProgress(", "memory: refreshMemoryAfterProgress exists");
mustContain("function formatMemoryDigestsForPrompt(", "memory: formatMemoryDigestsForPrompt exists");
mustContain("function getMergedStep1Eval(", "memory: boardOverrides folded into step1 eval");
mustContain(
  "=== INTERNAL memory digests (stable; NEVER quote field names to the student) ===",
  "memory: digests injected into ContextSummary",
);
mustContain(
  "data.progressUpdate.memory = refreshMemoryAfterProgress(",
  "memory: refreshed digests attached to progressUpdate",
);
mustContain(
  "Memory digests: memory, sourceHash, openGaps, step1Digest, step2Digest, step3Digest",
  "memory: jargon list forbids digest field names in chat",
);
mustContain(
  "Prefer memory digests' filled/openGaps over re-deriving what is already known",
  "memory: prompt prefers digests for filled/openGaps",
);
// Client persistence + board-edit invalidation
const coachChatPath = path.join(repoRoot, "src/components/CoachChat.tsx");
const coachChatSource = fs.readFileSync(coachChatPath, "utf8");
const step1AnalysisPath = path.join(repoRoot, "src/components/Step1Analysis.tsx");
const step1AnalysisSource = fs.readFileSync(step1AnalysisPath, "utf8");
const typesPath = path.join(repoRoot, "src/types.ts");
const typesSource = fs.readFileSync(typesPath, "utf8");
assert.ok(
  coachChatSource.includes("memory: data.progressUpdate.memory"),
  "Missing: CoachChat persists progressUpdate.memory",
);
console.log("OK: CoachChat persists progressUpdate.memory");
assert.ok(
  coachChatSource.includes("data.progressUpdate.isCompleted === false") &&
    coachChatSource.includes("session.step2.isCompleted"),
  "Missing: CoachChat Step2 honors explicit isCompleted false",
);
console.log("OK: CoachChat Step2 honors explicit isCompleted false");
assert.ok(
  step1AnalysisSource.includes("step1: undefined") &&
    step1AnalysisSource.includes("Invalidate step1 digest"),
  "Missing: Step1 board edit invalidates step1 digest",
);
console.log("OK: Step1 board edit invalidates step1 digest");
assert.ok(
  typesSource.includes("memory?: SessionMemory") &&
    typesSource.includes("export interface Step1Digest"),
  "Missing: SessionMemory types on PracticeSession",
);
console.log("OK: SessionMemory types on PracticeSession");

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
  "If questionBrief.hasHardQualifiers=false AND the student did not echo any qualifier: do NOT ask the constraints question",
  "step1 skips constraints when no hard qualifiers",
);
mustContain(
  'Structural preview ONLY (optional, one short clause): e.g. "下面我们按：原因段 → 评价段 来梳理"',
  "step1 completion preview is structural only",
);
mustContain(
  "Coach recommendation first (CRITICAL)",
  "step2 stance recommends a preferred stance from prior evidence",
);
mustContain(
  "The recommendation must be evidence-based from THIS student's brainstorm.",
  "step2 stance recommendation cannot invent supporting arguments",
);
mustContain(
  'Set currentStage: "stance" AND immediately apply the stance-stage "Coach recommendation first" rule',
  "step2 explore-B transition recommends stance without an empty extra turn",
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
  "Internal brief: questionBrief, writingDestination, taskMap, hasHardQualifiers, requiresStance, candidateDirectionSeeds, evalNote, recommendedStance, easyCauses",
  "NO INTERNAL JARGON lists brief fields including rejected content fields",
);
mustNotContain("recommendedStance:", "no recommendedStance field assignment in brief");
mustNotContain("easyPath", "no easyPath content-suggestion structure");
mustNotContain(
  "可轻提示：多数稳妥路径",
  "no soft stance recommendation phrasing",
);

// Step 3 length budget + dynamic paragraph mode
mustContain("LENGTH BUDGET (decide mode & detail BEFORE writing steps — planning only):", "step3 length budget header");
mustContain("targets about 90-110 words total", "step3 90-110 word budget");
mustContain(
  "Do NOT mechanically force major+minor for symmetric two-point claims.",
  "step3 no-two-major rule",
);
mustContain("Length-aware balance:", "step3 length-aware balance rule");
mustContain(
  "DEFAULT for multi-point: prefer 'direct_points' (drop the total claim)",
  "step3 mode: default prefer direct_points for multi-point",
);
mustContain(
  "when mode is 'direct_points', leave totalClaim empty (\"\") and do NOT ask the student for a separate 总起句",
  "step3 mode: direct_points skips totalClaim ask",
);
mustContain(
  "If mode is 'direct_points', SKIP totalClaim entirely",
  "step3 dialogue: plan-agnostic skips totalClaim for direct_points",
);
mustContain(
  "Overall Thesis/Position:",
  "step3 context: Step2 blueprint position in ContextSummary",
);
mustContain(
  "Active Subpoint belongs to:",
  "step3 context: active body targetBody in ContextSummary",
);
mustContain(
  "ESSAY FRAMEWORK METADATA:",
  "step2 summary: emits internal essay framework for Step 3",
);
mustContain(
  "paragraphDensity",
  "step2 schema: paragraphDensity on clustering clusters",
);
mustContain(
  "stanceRelation",
  "step2 schema: stanceRelation on clustering clusters",
);
mustContain(
  "STEP 0 — INHERIT STEP 2 ESSAY FRAMEWORK",
  "step3 prompt: inherits Step 2 body framework",
);
mustContain(
  "function resolveStep2BodyFrameworkForSubpoint(",
  "step3 server: resolves Step 2 framework for active subpoint",
);
mustContain(
  "Step 2 Body Framework for Active Subpoint",
  "step3 context: Step 2 body framework in ContextSummary",
);
mustContain(
  "[inherited-step2-framework]",
  "step3 prompt: tags inherited framework in diagnosis",
);
mustContain("function recommendParagraphMode(", "step3 mode: recommendParagraphMode exists");
mustContain("function applyParagraphModeCorrection(", "step3 mode: applyParagraphModeCorrection exists");
mustContain(
  "applyParagraphModeCorrection(data, session)",
  "step3 mode: correction wired before completion guard",
);
mustContain(
  "[mode-correction]",
  "step3 mode: diagnosis records mode-correction tag",
);

// Step 3 plain-language / writability standard
mustContain(
  "## STEP 3 PLAIN-LANGUAGE / WRITABILITY STANDARD (CRITICAL, governs all Chinese you generate here):",
  "step3 writability standard header",
);
mustContain(
  "Prefer plain, concrete Chinese that a band 5-5.5 student can later turn into English",
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
mustContain(
  "preserveStep1ProbeTags(",
  "step1 probe: preserves confirmed probe tags across model rewrites",
);
mustContain(
  "Confirmed dimension LOCK",
  "step1 probe: prompt forbids rewriting confirmed dimension stamps",
);
mustContain(
  "stripIllegalSameTurnProbeTags(",
  "step1 probe: strips same-turn self-reported expandable tags",
);
mustContain(
  "Probe-first: rewrote Part2 to probe",
  "step1 probe: bare labels force probe-first Part2 rewrite",
);
mustContain(
  "stampUnprobedQualityPending(",
  "step1 probe: escape hatch stamps 质量待确认 on bare labels",
);
mustContain(
  "pendingProbeCore",
  "step1 probe: tracks server-forced probe target across turns",
);
mustContain(
  "probeVerdict",
  "step1 probe: B-lite probeVerdict field in schema/guard",
);
mustContain(
  "step1CapProbeComplete(",
  "step1 probe: cap+all-probed deadlock relief",
);
mustContain("function enforceStep3LogicCompletion(", "step3 completion: enforce function exists");
mustContain(
  "function enforceConfirmedOnlySlots(",
  "step3 completion: confirmed-only board clears unconfirmed model prefills",
);
mustContain(
  "normalizeStep3SlotLabelForMatch(",
  "step3 completion: confirmed restore matches by normalized label when key churns",
);
mustContain(
  "confirmedByBlockLabel",
  "step3 completion: confirmed restore secondary index by blockId+label",
);
mustContain(
  "function pruneUnauthorizedEmptySteps(",
  "step3 completion: prunes unauthorized empty steps not in prevPlan",
);
mustContain(
  "pruneUnauthorizedEmptySteps(",
  "step3 completion: prune unauthorized empties wired after framework guard",
);
mustContain(
  'slotEval?.mode === "confirm" && slotEval.activeKey',
  "step3 completion: prune protects confirm activeKey for one-shot reclass",
);
mustContain(
  "/_beat_\\d+$/",
  "step3 completion: framework beat key pattern allowed through prune",
);
mustContain(
  "function absorbStep3ConfirmReclass(",
  "step3 completion: one-shot confirm reclass absorbs onto firstEmpty key",
);
mustContain(
  "One-shot reclass:",
  "step3 completion: reclass path logs before key_not_first_empty veto",
);
mustContain(
  "OFF-ASK BUT REASONABLE → ONE CLEAN RECLASS",
  "step3 prompt: off-ask but reasonable one clean reclass rule",
);
mustContain(
  "function salvageStep3VetoAskText(",
  "step3 server: mid-dialogue veto soft-salvages model ask",
);
mustContain(
  "请先把「${L}」说具体一点。",
  "step3 server: soft veto ask (not rigid 谁/情况下 template)",
);
mustNotContain(
  "请先用一句话说清「${L}」：谁、在什么情况下、发生了什么？",
  "step3 server: rigid 谁/情况下 veto template removed",
);
mustContain(
  "function commitPendingOnAffirm(",
  "step3 completion: unique write entry commits pending only on affirm",
);
mustContain(
  "function evaluateSlotDraft(",
  "step3 completion: evaluateSlotDraft demoted to hard-check helper only",
);
mustContain(
  "MUST NOT stage pending or own student-facing asks",
  "step3 completion: evaluateSlotDraft must not stage pending",
);
mustContain(
  "[Step3Guard] Staged pending for「${stageLoc.label}」— confirm-turn text locked (no same-turn next ask).",
  "step3 completion: pending staged from step3SlotEval only",
);
mustContain(
  "no server heuristic stage",
  "step3 completion: no server heuristic stage for firstEmpty",
);
mustContain(
  "isDraftNearDuplicateOfConfirmedSiblings(",
  "step3 completion: rejects drafts that near-duplicate confirmed siblings",
);
mustContain(
  "kept model next-slot ask; aligned expand state",
  "step3 completion: after affirm keeps model ask when legal",
);
mustContain(
  "vetoed illegal next-ask text; short firstEmpty ask",
  "step3 completion: after affirm vetoes illegal next-ask",
);
mustContain(
  "Step2-only must not auto-qualify",
  "step3 completion: evaluateSlotDraft requires student utterance (not Step2 alone)",
);
mustNotContain(
  "backfillFirstEmptyStepFromUser(",
  "step3 completion: does not reuse one utterance in the next open slot",
);
mustContain(
  "CRITICAL WRITE-BEFORE-COMPLETE: In the SAME turn you set \\`step3SubpointCompleted: true\\`",
  "step3 prompt: write-before-complete rule",
);
mustContain(
  "enforceStep3LogicCompletion(data, session, userMessage, {",
  "step3 completion: enforce wired in coach handler",
);
mustContain("function isSubpointQualityComplete(", "step3 completion: quality gate ignores isCompleted flag");
mustContain("function isPlaceholderEchoValue(", "step3 completion: placeholder-echo detector exists (server)");
mustContain("function isGenuineStep3StepValue(", "step3 completion: genuine-value gate combines kickoff + echo checks (server)");
mustContain(
  "CONFIRMED VALUE IMMUTABILITY",
  "step3 prompt: confirmed values are frozen after first genuine fill",
);
mustContain(
  "BUDGET APPLIES AT PLANNING ONLY",
  "step3 prompt: word budget applies at planning only",
);
assert.ok(
  fs.readFileSync(path.join(repoRoot, "src/utils/step3Quality.ts"), "utf8").includes(
    "function mergeStep3ValuePreserveConfirmed(",
  ),
  "Missing: step3 merge preserves confirmed step values",
);
console.log("OK: step3 merge preserves confirmed step values");
assert.ok(
  fs.readFileSync(path.join(repoRoot, "src/utils/step3Quality.ts"), "utf8").includes(
    "export function restoreFrozenParagraphPlanValues(",
  ),
  "Missing: step3 restore frozen paragraphPlan values helper",
);
console.log("OK: step3 restore frozen paragraphPlan values helper");
mustContain(
  "enforceConfirmedOnlySlots(plan, prevPlan)",
  "step3 completion: confirmed-only freeze wired into state machine",
);
mustContain("function guardStep3ValueProvenance(", "step3 completion: provenance firewall exists (server)");
mustContain(
  "function isStep3RejectMessage(",
  "step3 completion: reject/protest detector exists",
);
mustContain(
  "function buildContinuousConfirmAsk(",
  "step3 completion: legacy confirm ask builder retained but not main path",
);
mustContain("function applyStudentAnswerToTargetStep(", "step3 completion: prefers student utterance for target step (server)");
mustContain("function isSubpointGenuinelyComplete(", "step3 completion: genuine complete requires student dialogue (server)");
mustContain(
  "function buildStep3KickoffPendingDrafts(",
  "step3 kickoff legacy builder retained (not main path)",
);
mustContain(
  "Kickoff-only: align expand state; sanitize dump; keep model ask when possible.",
  "step3 kickoff never stages confirm; sanitizes dump; keeps model ask",
);
mustContain(
  "function applyKickoffPendingDraftsToPlan(",
  "step3 kickoff applies pending drafts only after affirmation",
);
mustContain(
  "function buildStep3KickoffConfirmText(",
  "step3 kickoff confirm chat lists pending drafts",
);
mustContain(
  "clearAllStep3PlanValues(plan)",
  "step3 kickoff clears slot values before confirm-then-write",
);
mustContain(
  "step3KickoffPendingDrafts",
  "step3 kickoff pending drafts field exists",
);
mustContain(
  "confirm-then-write",
  "step3 prompt: kickoff confirm-then-write rule",
);
mustContain(
  "function inferStep2SideForSubpoint(",
  "step3 kickoff maps body to A/B userPoints side",
);
mustContain(
  "function cleanStep2EvidenceSnippet(",
  "step3 kickoff cleans 已选详写 blobs into draft prose",
);
mustContain(
  "kickoffPendingDrafts",
  "step3 client persists kickoffPendingDrafts on subpoint",
);
mustContain(
  "function salvageStep3KickoffAskText(",
  "step3 kickoff salvages ask without mid-dialogue veto template",
);
mustContain(
  "[Step3Guard] Kickoff expand on「${emptyLabel}」— material as question seed (confirm only when especially complete).",
  "step3 kickoff keeps legal model expand ask",
);
mustContain(
  "function prepareStep3KickoffCoachText(",
  "step3 kickoff prepare path is separate from mid-dialogue veto",
);
mustContain(
  "function salvageStep3KickoffAskText(",
  "step3 kickoff salvages model question after dump strip",
);
mustContain(
  "function countNarrativeChainLabels(",
  "step3 server: detects narrative 原因/场景/影响 chain dumps",
);
mustContain(
  "narrativeLabels >= 2",
  "step3 illegal dump includes narrative chain labels",
);
mustContain(
  "function detectStep3IllegalCoachText(",
  "step3 server: illegal coach-text detector (dump/fake-complete)",
);
mustContain(
  "function detectStep3CrossBlockSkipAsk(",
  "step3 server: forbid skip-ahead asks across pointBlocks while earlier empty",
);
mustContain(
  "skip_ahead_cross_block",
  "step3 illegal text code for cross-block skip while empty remains",
);
mustContain(
  "QUESTION CUES only",
  "step3 ContextSummary: Step2 points are ask cues, not confirm bundle",
);
mustNotContain(
  "confirm this reused bundle once",
  "step3 ContextSummary must not ask to confirm a reused Step2 bundle",
);
mustNotContain(
  "organize their already-supplied details into matching Step 3 slots as draft values",
  "step3 ContextSummary must not organize Step2 into draft slot values on kickoff",
);
mustContain(
  "请先用你自己的话写",
  "step3 kickoff salvage soft fallback (not rigid 先从…一句话表达 template)",
);
mustContain(
  "STUCK / 「不知道」",
  "step3 prompt: stuck students get clues not rubber-stamp sentences",
);
mustContain(
  "narrative「原因：/场景：/影响：」prose (common kickoff leak)",
  "step3 prompt: kickoff forbids narrative full-sentence chain dump",
);
mustContain(
  "function vetoStep3TextToFirstEmptyAsk(",
  "step3 server: mid-dialogue full-text veto still exists",
);
mustContain(
  "function enforceStep3TextBoardConsistency(",
  "step3 server: board-consistency enforce (trust or veto)",
);
mustContain(
  "affirm_no_pending",
  "step3 server: bare affirm with no pending is vetoed",
);
mustContain(
  "function resolvePostAffirmNextSlotPending(",
  "step3 server: post-affirm next-slot confirm resolver",
);
mustContain(
  "function stagePostAffirmNextSlotConfirm(",
  "step3 server: post-affirm next-slot confirm staging",
);
mustContain(
  "Post-affirm staged next-slot confirm (declare or text-salvage)",
  "step3 server: logs post-affirm next-slot staging",
);
mustContain(
  "function alignFirstEmptyExpandState(",
  "step3 server: alignFirstEmptyExpandState keeps legal model ask",
);
mustContain(
  "function isKickoffDraftSubstantiveEnough(",
  "step3 kickoff substantive-enough gate for confirm-write",
);
mustContain(
  "function lookLikeStep2ThemeLabel(",
  "step3 kickoff rejects Step2 theme-label shorthand as sentences",
);
mustContain(
  "function splitOutsideParens(",
  "step3 kickoff splits clauses without breaking parentheses",
);
mustContain(
  "usedFullEvidence",
  "step3 kickoff full-sentence evidence is consumed once across beats",
);
mustContain(
  "function rewriteStep3AskText(",
  "step3 rewriteStep3AskText helper retained (not main ask path)",
);
mustContain(
  "function paraphraseKickoffDraftText(",
  "step3 kickoff paraphrases drafts without adding facts",
);
mustContain(
  "function buildStep3KickoffExpandText(",
  "step3 kickoff expand-ask builder exists",
);
mustContain(
  "KICKOFF / FIRST PLANNING TURN",
  "step3 prompt: kickoff expand-first (Step2 is ask clue only)",
);
mustContain(
  "CONTENT REUSE FROM STEP 2 / PLANNER (CRITICAL)",
  "step3 prompt: mapped Step2 points are ask evidence only (no complete-then-confirm)",
);
mustContain(
  "NO LLM-COMPLETE-THEN-CONFIRM",
  "step3 prompt: expand content must be student-authored",
);
mustContain(
  "confirm_requires_student_utterance",
  "step3 server: confirm pending requires substantive student utterance",
);
mustContain(
  "Kickoff / Step2-only polish must use mode=expand",
  "step3 server: kickoff forces expand when model tries confirm",
);
mustContain(
  "isStep3AffirmativeConfirmation",
  "step3 explicit short confirmation counts after grounded draft reuse",
);
mustContain(
  "function applyStep3FrameworkGuard(",
  "step3 framework guard enforces Step2 inheritance",
);
mustContain(
  "function ensureArgumentRelationCoverage(",
  "step3 generic argument-relation coverage exists",
);
mustContain(
  "function ensureConcessionStructure(",
  "step3 concession structure enforcement exists (compat wrapper)",
);
mustContain(
  "[argument-relation-coverage:",
  "step3 relation coverage tags enforced structure",
);
mustContain(
  "refusing to merge stale paragraphPlan",
  "step3 refuses merge when framework signature drifted",
);
assert.ok(
  step3QualitySource.includes("export function computeSubpointFrameworkSignature("),
  "Missing: step3Quality framework signature helper",
);
console.log("OK: step3Quality framework signature helper");
assert.ok(
  step3QualitySource.includes("export function computeEssayFrameworkSignature("),
  "Missing: step3Quality essay framework signature helper",
);
console.log("OK: step3Quality essay framework signature helper");
assert.ok(
  step3QualitySource.includes("ARGUMENT_RELATION_BEATS"),
  "Missing: argument relation beats table",
);
console.log("OK: argument relation beats table");
assert.ok(
  step3DraftingSource.includes("computeSubpointFrameworkSignature") &&
    step3DraftingSource.includes("computeEssayFrameworkSignature"),
  "Missing: Step3Drafting uses framework signature for stale-plan invalidation",
);
console.log("OK: Step3Drafting uses framework signature for stale-plan invalidation");
mustContain(
  "VALUE vs PLANNING DRAFT SEPARATION",
  "step3 prompt: separates planning drafts from confirmed value fields",
);
mustContain(
  "NO PLACEHOLDER-ECHO (this causes silent premature completion)",
  "step3 prompt: forbids echoing placeholder text into value",
);
assert.ok(
  fs.readFileSync(path.join(repoRoot, "src/utils/step3Quality.ts"), "utf8").includes(
    "export function mergeParagraphPlanPreserveBlocks(",
  ),
  "Missing: step3 plan merge: union preserve helper exists",
);
console.log("OK: step3 plan merge: union preserve helper exists");
assert.ok(
  !coachChatSource.includes("mergeParagraphPlanPreserveBlocks(") &&
    !coachChatSource.includes("guardStep3ValueProvenance(") &&
    !coachChatSource.includes("isSubpointGenuinelyComplete("),
  "Step3 client must not merge, guard, or recompute completion",
);
console.log("OK: step3 CoachChat trusts server-authored board and progress");
mustContain(
  "mergeParagraphPlanPreserveBlocks",
  "step3 server: union paragraphPlan merge wired",
);
mustContain("function finalizeStep3WholeStepCompletion(", "step3 completion: whole-step finalizer exists");
mustContain("function rewriteStep3AdvanceToNextBody(", "step3 completion: rewrites CTA when other bodies remain");
mustContain(
  "Never trust sibling isCompleted flags",
  "step3 completion: never trust sibling isCompleted alone",
);
mustContain("function textSuggestsStep3Complete(", "step3 completion: text heuristic exists");
mustContain(
  't.includes("大功告成")',
  "step3 completion: text heuristic catches premature 大功告成 CTA",
);
mustContain(
  't.includes("点击下一步进入写作练习")',
  "step3 completion: text heuristic catches premature writing-practice CTA",
);
mustContain(
  't.includes("切换到下一个主体段")',
  "step3 completion: text heuristic catches premature next-body tab CTA",
);
mustContain(
  "anchored to whole-chain / advance-CTA phrasing",
  "step3 completion: text heuristic stays scoped to whole-chain language",
);
mustContain(
  "Do NOT force-complete Step 3 from CTA text alone.",
  "step3 heuristic: CTA text alone cannot force complete",
);
mustContain(
  "function sanitizeStep3RewritePart1(",
  "step3 completion: part1 sanitizer exists (avoids self-contradictory rewrite)",
);
mustContain(
  "function textSuggestsStep3SlotAlreadyWritten(",
  "step3 completion: detects false already-written-to-board claims in part1",
);
mustContain(
  "textSuggestsStep3SlotAlreadyWritten(t)",
  "step3 completion: part1 sanitizer strips already-written claims",
);
mustContain(
  "forceNeutralPart1",
  "step3 ask rewrite can force neutral part1 for confirm-ask",
);
mustContain(
  "sanitizeStep3RewritePart1(split.part1,",
  "step3 completion: rewrite sites use the part1 sanitizer",
);
assert.ok(
  step3QualitySource.includes("export function promoteAcknowledgedStep3DraftTarget("),
  "Missing: step3Quality auto-promote helper (paragraphPlan) exists",
);
console.log("OK: step3Quality auto-promote helper (paragraphPlan) exists");
assert.ok(
  step3QualitySource.includes("export function promoteAcknowledgedFlatStep3Target("),
  "Missing: step3Quality auto-promote helper (flat steps) exists",
);
console.log("OK: step3Quality auto-promote helper (flat steps) exists");
assert.ok(
  step3QualitySource.includes("export function isStep3AffirmativeConfirmation("),
  "Missing: step3Quality shared affirmative-confirmation detector",
);
console.log("OK: step3Quality shared affirmative-confirmation detector");
mustContain(
  "commitPendingOnAffirm(plan, pending)",
  "step3 completion: affirm writes via commitPendingOnAffirm only",
);
mustContain(
  "function resolveStep3StepConfirmation(",
  "step3 confirm-resolution function exists",
);
mustContain(
  "wasAcceptedPolishedDraft",
  "step3 confirm-resolution skips corpus-grounding demotion for just-affirmed drafts (fixes confirm deadlock)",
);
mustContain(
  "polishedFromCurrentAnswer",
  "step3 confirm-resolution also accepts substantive-answer + light-polish grounding",
);
mustContain(
  "isStep3AffirmativeConfirmation(userMessage)",
  "step3 state machine gates slot write on affirmative confirmation",
);
mustContain(
  "function rewriteStep3AskText(",
  "step3 ask rewrite helper always owns part2 after ---",
);
mustContain(
  "function isKickoffDraftDeepEnough(",
  "step3 kickoff beat-level depth gate exists (rejects grammatical-but-shallow drafts)",
);
mustContain(
  "function isKickoffDraftReadyToConfirm(",
  "step3 kickoff combined substantive+deep confirm gate exists",
);
mustContain(
  "applyLabeledPendingEdits(",
  "step3 completion: labeled pending edits (partial update by key)",
);
mustContain(
  "Refused confirm/pending without substantive student utterance — vetoed to firstEmpty ask",
  "step3: confirm without student utterance vetoes to firstEmpty ask",
);
mustContain(
  "function stripStep3EnglishTranslationShow(",
  "step3 server: strips mid-flow English translation show-offs",
);
mustContain(
  "NO ENGLISH IN STEP 3 CHAT",
  "step3 prompt: forbids English translations in coaching chat",
);
mustContain(
  "SERVER vs LLM OWNERSHIP",
  "step3 prompt: LLM owns asks; server owns flow/state only",
);
mustContain(
  "confirm-then-write via commitPendingOnAffirm",
  "step3 kickoff: affirmation writes pending drafts into slots",
);
mustContain(
  "function buildStep3PendingAsk(",
  "step3 ask: distinguishes confirm-draft vs fill-empty",
);
mustContain(
  "NO INVENTED SLOT PROSE",
  "step3 prompt: forbids inventing slot prose without Step2 grounding",
);
mustContain(
  "CHAT vs BOARD AFTER CONFIRM",
  "step3 prompt: chat vs board rules after confirm-then-write",
);
mustContain(
  "function stripStep3BlockLabelPrefix(",
  "step3 labels: strip duplicated 分点N prefix helper exists",
);
mustContain(
  "function formatStep3FlatStepLabel(",
  "step3 labels: flat label formatter avoids double prefix",
);
mustContain("function attachStep3UiProgress(", "step3 server: authoritative UI progress exists");
mustContain("data.progressUpdate.step3Ui = {", "step3 server: emits authoritative UI progress");
mustContain("areNearDuplicateStep3Values(", "step3 server: adjacent duplicate detector exists");
mustContain(
  "function doesStep3AnswerCoverValue(",
  "step3 server: detects a paraphrased adjacent value covered by one answer",
);
mustContain(
  "function collapseCoveredAdjacentStep3Slots(",
  "step3 server: collapses adjacent open slots covered by one answer",
);
mustContain(
  "enforceConfirmedOnlySlots(plan, prevPlan)",
  "step3 server: confirmed-only freeze supersedes adaptive collapse in state machine",
);
mustContain(
  "function wereStep3RefsAdjacentInPreviousPlan(",
  "step3 server: merged-slot index shifts cannot expose a later step",
);
mustContain(
  "ADAPTIVE SLOT MERGE（左侧判断、右侧同步）",
  "step3 prompt: left coach can merge redundant adjacent right-board slots",
);
mustContain(
  "Merge only when the TWO slot values themselves are near-duplicates.",
  "step3 server: merge compares two slot values, not userMessage vs next",
);
mustContain(
  "删除紧邻 step",
  "step3 prompt: merged slot keeps a stable key",
);
mustContain(
  "function resolveStep3StepConfirmation(",
  "step3 server: confirm gate demotes invalid confirmed proposals",
);
mustContain(
  "commitPendingOnAffirm(plan, pending)",
  "step3 server: confirm-then-write gate wired (affirm commits pending to slots)",
);
mustContain(
  "CRITICAL — SLOT STATUS (draft vs confirmed)",
  "step3 prompt: draft vs confirmed slot status contract",
);
mustContain(
  "After the student affirms (「对/是的/没问题」), the SERVER writes confirmed values",
  "step3 prompt: draft confirmation must overwrite the same slot",
);

// Step 3 LLM-owned eval architecture
mustContain("step3SlotEval", "step3 architecture: step3SlotEval in server");
mustContain("function hardRejectSlotText(", "step3 architecture: hard-reject firewall");
mustContain("function normalizeStep3SlotEval(", "step3 architecture: normalize step3SlotEval");
mustContain("function formatStep3SlotCursorForPrompt(", "step3 architecture: slot cursor context injection");
mustContain("lastRejectCode", "step3 architecture: lastRejectCode in context/persistence");
mustContain("NO META PROCESS PHRASES", "step3 prompt: forbids meta process phrases");
mustContain("不会现在写入右侧", "step3 architecture: strip/forbid 不会现在写入右侧 meta");
mustContain("function stripStep3MetaProcessPhrases(", "step3 architecture: strips meta process phrases");
mustContain("function ensureMinimalStep3Text(", "step3 architecture: minimal text fallback only");
mustNotContain(
  'data.text = `${hint}\n\n---\n\n请先用一句话把「${empty.cleanStepLabel}」说完整；说清楚后我们再整理确认，不会现在写入右侧。`',
  "step3 architecture: main path must not template 不会现在写入右侧 expand asks",
);
mustContain(
  "commitPendingOnAffirm(plan, pending)",
  "step3 architecture: affirm writes via commitPendingOnAffirm",
);

mustContain(
  'enum: ["draft", "confirmed"]',
  "step3 schema: status enum draft/confirmed on nested steps",
);
assert.ok(
  fs.readFileSync(path.join(repoRoot, "src/utils/step3Quality.ts"), "utf8").includes(
    "export function isStep3Confirmed(",
  ),
  "Missing: step3Quality: confirmed helper exists",
);
console.log("OK: step3Quality: confirmed helper exists");
mustContain(
  "syncPlanProgressFields(data, plan, pending)",
  "step3 completion: pending sync keeps slots empty until affirm",
);
assert.ok(
  fs.readFileSync(path.join(repoRoot, "src/utils/step3Quality.ts"), "utf8").includes(
    'block.steps.every((step: any) => isStep3Confirmed(step))',
  ),
  "Missing: quality-filled requires confirmed status",
);
console.log("OK: quality-filled requires confirmed status");
assert.ok(
  fs.readFileSync(path.join(repoRoot, "src/types.ts"), "utf8").includes(
    'status?: "draft" | "confirmed"',
  ),
  "Missing: LogicStep status field on types",
);
console.log("OK: LogicStep status field on types");
assert.ok(
  step3DraftingSource.includes("const isStep3Finished = !!session.step3.isCompleted") &&
    !step3DraftingSource.includes("inferExpectedStep3BodyCount") &&
    !step3DraftingSource.includes("canSelectSubpoint"),
  "Step3Drafting must render server-authored progress without recomputing it",
);
console.log("OK: step3 UI renders server-authored completion and selectability");
assert.ok(
  !step3DraftingSource.includes("进入第四步：逐句写作练习"),
  "Should be absent: step3 right-footer duplicate jump CTA",
);
console.log("OK: step3 right-footer duplicate jump CTA removed");
assert.ok(
  coachChatSource.includes("const step3Ui = data.progressUpdate.step3Ui") &&
    coachChatSource.includes("isCompleted: !!uiBody.isCompleted") &&
    coachChatSource.includes("selectable: !!uiBody.selectable"),
  "Step3 CoachChat must synchronize server-authored UI status",
);
console.log("OK: step3 CoachChat synchronizes server-authored UI status");
mustContain(
  "Only unlock when slots filled, dimensions sufficient, exit gate open",
  "step1 completion: enforce requires completion CTA, not slots alone",
);
mustContain(
  "Premature-completion guard: clear isCompleted if the model set it while",
  "step1 completion: premature isCompleted cleared without CTA",
);
mustContain(
  'FORBIDDEN: Do NOT set isCompleted: true while still asking dimension questions, soft exit ("够用了吗"), or any other missing-slot question.',
  "step1 prompt: forbids isCompleted during mid-flow dimension questions",
);
mustContain("function textSuggestsStep1Complete(", "step1 completion: text heuristic exists");
mustContain(
  "// Soft exit asks may say",
  "step1 completion: text heuristic kept strict for soft-exit vs hard CTA",
);
mustContain("function applyStepCompletionHeuristic(", "step completion: heuristic function exists");
mustContain("Step 1 deterministic safety net (A):", "step1 backfill: wired in coach handler");
mustContain("progressUpdate.isCompleted: true", "step1 prompt: requires isCompleted on completion");
mustContain("Do NOT populate progressUpdate.step2Data while step=1", "step1 prompt: anti-drift rule");
mustContain(
  "applyStepCompletionHeuristic(data, currentStepNum, session)",
  "step completion: heuristic wired after backfill (with session for stage gate)",
);
mustContain(
  "function enforceStep2Completion(",
  "step2 completion: enforce gate exists",
);
mustContain(
  "function isStep2BlueprintContentComplete(",
  "step2 completion: content-gate helper exists",
);
mustContain(
  "Content-gate unlock: corrected stage",
  "step2 completion: content-gate corrects stuck stage to summary",
);
mustContain(
  "enforceStep2Completion(data, session)",
  "step2 completion: enforce wired after heuristic",
);
mustContain(
  "[Step2CompletionGuard] Cleared premature isCompleted",
  "step2 completion: clears premature isCompleted mid-explore",
);
mustContain(
  'set currentStage: "summary" in the SAME turn',
  "step2 prompt: require currentStage=summary with completion CTA",
);
mustContain(
  "left-side 【立即跳转】",
  "step2 prompt: CTA points to left jump button",
);
assert.ok(
  step2BrainstormSource.includes("const showNextStepButton = useMemo"),
  "Missing: step2 UI jump button uses showNextStepButton content gate",
);
console.log("OK: step2 UI jump button uses showNextStepButton content gate");
assert.ok(
  step2BrainstormSource.includes("进入第三步"),
  "Missing: step2 UI detects 进入第三步 CTA for stuck-session unlock",
);
console.log("OK: step2 UI detects 进入第三步 CTA for stuck-session unlock");

mustContain(
  "function findUndevelopedNumberedSibling(",
  "step2 retention: deterministic numbered-sibling fallback exists",
);
mustContain(
  "[Step2RetentionGuard][HEURISTIC_UNCOVERED]",
  "step2 retention: logs when heuristic overrides LLM miss",
);
mustContain(
  "Sibling confirmation before leave (CRITICAL)",
  "step2 prompt: sibling confirmation required before leaving explore stage",
);
mustContain(
  "Merely appearing as an item in priorUserPoints",
  "step2 retention coverage: listed-in-userPoints is not covered",
);
mustContain(
  "if (progressUpdate.isCompleted === false) virtual.step2.isCompleted = false;",
  "memory: step2 isCompleted false branch",
);

// Merge guard functions and wiring
mustContain("function sanitizeProgressUpdateWithSession(", "merge guard function exists");
mustContain("isBlankStringArray", "merge guard array blank detector");
mustContain("data.progressUpdate = sanitizeProgressUpdateWithSession(", "merge guard wired before output");
mustContain(
  "User board edits always win over AI rewrites for the same fields.",
  "merge guard: boardOverrides win over AI step1Data",
);

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
  const boardOverrides =
    session?.step1?.boardOverrides && typeof session.step1.boardOverrides === "object"
      ? session.step1.boardOverrides
      : {};
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
    for (const [key, value] of Object.entries(boardOverrides)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && !String(value).trim()) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      step1New[key] = value;
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

{
  const progress = {
    step1Data: {
      suggestedDimensions: ["经济角度", "强势文化角度"],
      coreIssue: "AI 想改写的核心议题",
    },
  };
  const session = {
    step1: {
      coachEvaluation: {
        coreIssue: "旧核心议题",
        suggestedDimensions: ["经济全球化冲击"],
      },
      boardOverrides: {
        suggestedDimensions: ["经济全球化冲击", "教育制度"],
        coreIssue: "用户手改的核心议题",
      },
    },
  };
  sanitizeProgressUpdateWithSession(progress, session);
  assert.deepEqual(
    progress.step1Data.suggestedDimensions,
    ["经济全球化冲击", "教育制度"],
    "boardOverrides suggestedDimensions must win",
  );
  assert.equal(
    progress.step1Data.coreIssue,
    "用户手改的核心议题",
    "boardOverrides coreIssue must win",
  );
  console.log("OK: boardOverrides win over AI step1Data");
}

// Deterministic tests for Step 3 paragraph-mode recommendation (mirrors server.ts)
function recommendParagraphMode(signals) {
  if (signals.pointCount <= 1) return "single_point";
  if (
    signals.totalWouldRepeatSubClaims ||
    signals.bothPointsNeedMajorExpansion ||
    signals.bodyClaimIsUmbrella ||
    signals.thesisAlreadyStated
  ) {
    return "direct_points";
  }
  if (signals.estimatedCharBudget > 260) return "direct_points";
  return "total_then_points";
}

{
  assert.equal(
    recommendParagraphMode({
      pointCount: 1,
      estimatedCharBudget: 80,
      totalWouldRepeatSubClaims: false,
      bothPointsNeedMajorExpansion: false,
      bodyClaimIsUmbrella: false,
      thesisAlreadyStated: false,
    }),
    "single_point",
    "single point must stay single_point",
  );
  assert.equal(
    recommendParagraphMode({
      pointCount: 2,
      estimatedCharBudget: 120,
      totalWouldRepeatSubClaims: false,
      bothPointsNeedMajorExpansion: true,
      bodyClaimIsUmbrella: false,
      thesisAlreadyStated: false,
    }),
    "direct_points",
    "dual major should prefer direct_points",
  );
  assert.equal(
    recommendParagraphMode({
      pointCount: 2,
      estimatedCharBudget: 100,
      totalWouldRepeatSubClaims: true,
      bothPointsNeedMajorExpansion: false,
      bodyClaimIsUmbrella: false,
      thesisAlreadyStated: false,
    }),
    "direct_points",
    "repeating totalClaim should prefer direct_points",
  );
  assert.equal(
    recommendParagraphMode({
      pointCount: 2,
      estimatedCharBudget: 100,
      totalWouldRepeatSubClaims: false,
      bothPointsNeedMajorExpansion: false,
      bodyClaimIsUmbrella: false,
      thesisAlreadyStated: false,
    }),
    "total_then_points",
    "no strong direct_points signal may keep total_then_points",
  );
  console.log("OK: recommendParagraphMode decision table");
}

function applyParagraphModeCorrectionLocal(data, session) {
  const plan = data?.progressUpdate?.paragraphPlan;
  if (!plan || !Array.isArray(plan.pointBlocks)) return;
  const activeId = session?.step3?.activeSubpointId;
  const activeSp = (session?.step3?.subpoints || []).find((sp) => sp.id === activeId);
  const blocks = plan.pointBlocks;
  const signals = {
    pointCount: blocks.length,
    estimatedCharBudget: 120,
    totalWouldRepeatSubClaims: false,
    bothPointsNeedMajorExpansion:
      blocks.filter((b) => String(b?.role || "").toLowerCase() === "major").length >= 2,
    bodyClaimIsUmbrella: false,
    thesisAlreadyStated: Boolean(
      String(session?.step2?.coachEvaluation?.blueprint?.position || "").trim(),
    ),
  };
  // Approximate totalWouldRepeatSubClaims with simple includes check for the unit test.
  const totalClaim = String(plan.totalClaim || "").trim();
  if (totalClaim && blocks.length >= 2) {
    signals.totalWouldRepeatSubClaims = blocks.some((b) => {
      const sc = String(b?.subClaim || "").trim();
      return sc && (totalClaim.includes(sc) || sc.includes(totalClaim.slice(0, Math.min(6, totalClaim.length))));
    });
  }
  const recommended = recommendParagraphMode(signals);
  if (plan.mode !== recommended) {
    plan.mode = recommended;
    if (recommended === "direct_points") plan.totalClaim = "";
    plan.diagnosis = `${String(plan.diagnosis || "").trim()} [mode-correction] ${recommended}`.trim();
  }
}

{
  const data = {
    progressUpdate: {
      paragraphPlan: {
        mode: "total_then_points",
        diagnosis: "multi-point",
        totalClaim: "线上学习对偏远学生和在职人员都有帮助",
        pointBlocks: [
          { id: "p1", subClaim: "帮偏远学生", role: "major", steps: [{ key: "a", value: "" }] },
          { id: "p2", subClaim: "给在职人员灵活时间", role: "major", steps: [{ key: "b", value: "" }] },
        ],
      },
    },
  };
  applyParagraphModeCorrectionLocal(data, {
    step2: { coachEvaluation: { blueprint: { position: "总体支持线上学习" } } },
    step3: { activeSubpointId: "body-1", subpoints: [{ id: "body-1", content: "线上学习既能帮偏远也能帮在职" }] },
  });
  assert.equal(data.progressUpdate.paragraphPlan.mode, "direct_points");
  assert.equal(data.progressUpdate.paragraphPlan.totalClaim, "");
  assert.ok(String(data.progressUpdate.paragraphPlan.diagnosis).includes("[mode-correction]"));
  console.log("OK: applyParagraphModeCorrection clears totalClaim for dual-major");
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
  step3DraftingSource.includes("DEFAULT：mode=expand") &&
    step3DraftingSource.includes("禁止静默写入") &&
    !step3DraftingSource.includes("并先请我一次性确认"),
  "Missing: step3 kickoff: expand-only, no internal field names, no one-shot confirm",
);
console.log("OK: step3 kickoff: expand-only, no internal field names, no one-shot confirm");

// Memory digest: boardOverrides must change Step1 sourceHash (invalidation rule)
function stableHashLocal(input) {
  let h = 5381;
  const s = String(input || "");
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}
function normalizeStringListLocal(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((d) => String(d || "").trim()).filter((d) => d.length > 0);
}
function computeStep1SourceHashLocal(session, question) {
  const eval1 = session?.step1?.coachEvaluation || {};
  const overrides = session?.step1?.boardOverrides || {};
  const merged = { ...eval1, ...overrides };
  const payload = [
    String(question || "").trim(),
    String(merged.correctType || "").trim(),
    String(merged.coreIssue || "").trim(),
    normalizeStringListLocal(merged.constraints).join("|"),
    normalizeStringListLocal(merged.suggestedDimensions).join("|"),
    session?.step1?.isCompleted ? "1" : "0",
  ].join("\n");
  return stableHashLocal(payload);
}
{
  const question = "Traditional cultures are being lost. What are the causes?";
  const baseSession = {
    step1: {
      isCompleted: true,
      coachEvaluation: {
        correctType: "Two-part Question",
        coreIssue: "原因 + 利弊判定",
        constraints: ["无明显限定词"],
        suggestedDimensions: ["经济全球化冲击", "身份认同"],
      },
    },
  };
  const hashBefore = computeStep1SourceHashLocal(baseSession, question);
  const editedSession = {
    step1: {
      ...baseSession.step1,
      boardOverrides: {
        suggestedDimensions: ["经济全球化冲击", "教育制度"],
      },
    },
  };
  const hashAfter = computeStep1SourceHashLocal(editedSession, question);
  assert.notEqual(
    hashBefore,
    hashAfter,
    "boardOverrides must invalidate step1 sourceHash",
  );
  // Same overrides again -> same hash (stable)
  assert.equal(
    hashAfter,
    computeStep1SourceHashLocal(editedSession, question),
    "identical sources must yield identical sourceHash",
  );
  console.log("OK: memory sourceHash invalidates on boardOverrides and is stable otherwise");
}

// Step 2 retention: question-aware sibling detection (not blind positional guess)
mustContain(
  "lastCoachQuestion?: string;",
  "findUndevelopedNumberedSibling accepts lastCoachQuestion signal",
);
mustContain(
  "const questionTargets = siblings.filter((s) => answerTouchesSibling(lastQ, s));",
  "findUndevelopedNumberedSibling checks which sibling the coach's last question targeted",
);
mustContain(
  "No reliable question-target signal — fall back to the old positional",
  "findUndevelopedNumberedSibling: positional guess is now a last resort",
);
mustContain(
  "lastCoachQuestion,\n  });",
  "findUndevelopedNumberedSibling call site threads lastCoachQuestion",
);

// Step 2 retention: safe Part 1 override when model omits the "---" separator
mustContain("function safeOverridePart1(", "safeOverridePart1 helper exists");
mustContain(
  "Reusing it verbatim would carry that\n * stale conclusion into the corrected response",
  "safeOverridePart1: documents why raw draft text cannot be reused blindly",
);
mustNotContain(
  'const part1 = (split.part1 || data.text || "").trim();',
  "step2 retention: no more unsafe raw-text fallback for Part 1 override",
);

// Step 2: anti-spoiler follow-up scoping + no-mechanism-explanation feedback
mustContain(
  "this is a RESCUE mechanism, NOT the default first-ask style",
  "step2 depth follow-up: candidate-directions scoped to follow-up only",
);
mustContain(
  "First ask for a NEW dimension/sub-point (CRITICAL — anti-spoiler):",
  "step2: first-ask for new dimension must not pre-fill example answers",
);
mustContain(
  "No-spoiler acknowledgment (CRITICAL): Part 1 may name WHICH dimension/point",
  "step2: feedback must not explain mechanism/why-it-works for the student",
);

// Step 2: requiresStance detection + no-stance gate + client stepper sync
mustContain("function detectRequiresStance(", "requiresStance detector exists");
mustContain("function applyNoStanceGate(", "no-stance gate exists");
mustContain(
  "step2.requiresStance = brief.requiresStance;",
  "no-stance gate stamps requiresStance every turn for client stepper",
);
mustContain(
  "applyNoStanceGate(question, data, session);",
  "no-stance gate wired into Step2 handler",
);
mustContain(
  "function enforceStep2StanceMaterialGuard(",
  "step2 stance-material guard exists",
);
mustContain(
  "enforceStep2StanceMaterialGuard(data, session, userMessage);",
  "step2 stance-material guard wired into Step2 handler",
);
mustContain(
  "function enforceStep2StanceMaterialGuard(",
  "step2 prompt: stance-material fit rule",
);
mustContain(
  "function studentSignalsExhausted(",
  "shared student termination-signal helper exists",
);
mustContain(
  "材料校验已提示",
  "step2 material-guard anti-loop tag exists",
);
mustContain(
  "countEffectiveStep1Dimensions(",
  "step1 effective-dimension counter exists",
);
mustContain(
  "Dimension quality & exit rules (CRITICAL",
  "step1 dimension quality & exit rules exist",
);
mustContain(
  "hasStandaloneStep1Tag(t, STEP1_DIM_EXPANDABLE_TAG) &&",
  "step1 effective dims require standalone expandable tag",
);
mustContain(
  "hasStandaloneStep1Tag(t, STEP1_DIM_PROBED_TAG)",
  "step1 effective dims require probed tag",
);
mustContain(
  "function isStep1ExitGateOpen(",
  "step1 exit-offer gate helper exists",
);
mustContain(
  "Blocked premature Step1 completion; exit offer required",
  "step1 exit-offer gate blocks early complete",
);
mustContain(
  "Blocked same-turn complete while new dimension introduced",
  "step1 same-turn new-dimension complete blocked",
);
mustContain(
  "exitOffered",
  "step1 schema/prompt includes exitOffered",
);
mustContain(
  "FORBIDDEN: tagging status on the introduce turn",
  "step1 prompt forbids same-turn expandable+introduce",
);
mustContain(
  "enforceStep1SlotCompletion(data, session, userMessage);",
  "step1 completion guard receives userMessage",
);
mustContain(
  "const STEP1_DIM_MIN_EFFECTIVE = 3;",
  "step1 effective minimum is 3",
);
mustContain(
  "function computeStep1DimensionsSufficient(",
  "step1 dimensionsSufficient helper exists",
);
mustContain(
  "AI sufficiency first (CRITICAL)",
  "step1 prompt: AI sufficiency before student exit ask",
);
mustContain(
  "function questionHasScopedAll(",
  "step1 scoped-all hard-qualifier detector exists",
);
mustContain(
  "Cross-group: student says 完全/彻底 while question has scoped all",
  "step1 cross-group qualifier echo (完全↔all) exists",
);
mustContain(
  "constraintsSkipped = true;",
  "step1 no-hard-qualifier gate uses constraintsSkipped",
);
mustContain(
  "Stripped student-visible '无明显限定词' marker",
  "step1 strips 无明显限定词 marker from board",
);
mustContain(
  "Soft exit asks may say",
  "step1 hard CTA excludes soft exit phrasing",
);
mustContain(
  '(/点击/.test(t) && /下一步/.test(t) && /进入第二步/.test(t))',
  "step1 hard CTA requires click next-step button",
);
mustNotContain(
  'set constraints=["无明显限定词"]',
  "step1 prompt no longer tells model to write 无明显限定词",
);
mustContain(
  "argumentRelation",
  "step2 schema: argumentRelation on clustering clusters",
);
mustContain(
  "CONVERGE — select stance after flat points are ready; NO paragraph layout",
  "step2 converge stage selects points and stance together",
);
mustContain(
  "SKIP this entire step. Copy",
  "step3 skips re-diagnosis when framework present",
);

// Step 2: momentum guard (Part 2 must always be a question or CTA)
mustContain("function enforceStep2Momentum(", "step2 momentum guard exists");
mustContain("function looksLikeQuestionEnding(", "step2 momentum: question-ending detector exists");
mustContain(
  "appended content-aware prompt for resolved stage",
  "step2 momentum: logs content-aware fallback injection",
);
mustContain(
  "function fallbackStep2QuestionForStage(",
  "step2 momentum resolves fallback from updated stage",
);
mustContain(
  "Repaired verbal stage advance",
  "step2 momentum repairs text and stage desynchronization",
);
mustContain(
  "stanceRecommendationAlreadyPresent",
  "step2 momentum preserves an evidence-based stance recommendation",
);
mustContain(
  "enforceStep2Momentum(data, session, {",
  "step2 momentum guard wired into Step2 handler",
);
mustContain(
  "function sideHasSolidExploreContent(",
  "step2 momentum: solid-side detector exists",
);
mustContain(
  "hasSeedOnlySprouts",
  "step2 seedOnly: momentum ignores text-solid while Step1 sprouts remain",
);
mustContain(
  "isPointExpandedForWalk",
  "step2 seedOnly: walk/ready counts use expanded-for-walk gate",
);
mustContain(
  "在第一步你提到过",
  "step2 seedOnly: content-aware expand ask cites Step1 seed",
);
mustContain(
  "[Step2Momentum] explore_A solid → stage=",
  "step2 momentum advances when A+B already solid",
);
mustContain(
  "function normalizeQuestionTypeLabel(",
  "question type alias normalizer exists",
);
mustContain(
  'if (/^agree\\s*(or|\\/)\\s*disagree$/.test(lower)) return "Agree / Disagree";',
  "Agree or Disagree alias maps to Agree / Disagree",
);
mustContain(
  "STEP1_DIM_SYNONYM_BAGS",
  "step1 dimension synonym bags for disposition matching",
);

// Client stepper: requiresStance-aware stage list + taskMap labels
assert.ok(
  step2BrainstormSource.includes("const requiresStance = (evalData as any)?.requiresStance !== false;"),
  "Missing: step2 stepper reads requiresStance from evalData",
);
console.log("OK: step2 stepper reads requiresStance from evalData");
assert.ok(
  step2BrainstormSource.includes("taskLabelA") &&
    step2BrainstormSource.includes("taskLabelB") &&
    step2BrainstormSource.includes("labelA || '第一任务'"),
  "Missing: step2 stepper uses taskMap labels with 第一任务 fallback",
);
console.log("OK: step2 stepper has 3-stage variant for no-stance essays");
mustContain("function stampStep2TaskBrief(", "step2 stamps taskMap labels for client stepper");
mustContain(
  "step2.taskLabelA = brief.taskMap.explore_A;",
  "step2 taskLabelA comes from questionBrief.taskMap",
);
mustContain(
  "function enforceStep2DimensionDispositionGuard(",
  "step2 dimension disposition guard exists",
);
mustContain(
  "Step1 dimension disposition ledger (CRITICAL — no silent drop):",
  "step2 prompt forbids silent drop of Step1 dimensions",
);
mustContain(
  "enforceStep2DimensionDispositionGuard(data, session);",
  "step2 dimension disposition guard wired into handler",
);
mustContain(
  "dimensionDispositions",
  "step2 schema includes dimensionDispositions ledger",
);
assert.ok(
  step2BrainstormSource.includes("材料池（平铺论点）") &&
    step2BrainstormSource.includes("可写") &&
    step2BrainstormSource.includes("待加深"),
  "Missing: step2 UI shows Step1 dimension disposition checklist",
);
console.log("OK: step2 UI shows Step1 dimension disposition checklist");

// Step 3: kickoff isolation + server-authored UI progress
mustContain("function isKickoffOrInstructionText(", "step3 kickoff pollution detector exists");
mustContain("function isValidStep3StepValue(", "step3 valid step value gate exists");
mustContain("function sanitizeParagraphPlanValues(", "step3 sanitize paragraphPlan values exists");
mustContain("isHiddenKickoff", "step3 API accepts isHiddenKickoff flag");
mustContain(
  "if (options?.isHiddenKickoff)",
  "step3 guard uses dedicated confirm-then-write path on hidden kickoff",
);
assert.ok(
  step3DraftingSource.includes("sp.selectable !== false") &&
    step3DraftingSource.includes("subpoint.selectable !== false"),
  "Missing: Step3Drafting renders server-authored selectable state",
);
console.log("OK: Step3Drafting renders server-authored selectable state");
assert.ok(
  !step3DraftingSource.includes("step.placeholder") &&
    !step3DraftingSource.includes("等待上一步构建完成后开启"),
  "Step3 right panel must not render model placeholder demo text",
);
console.log("OK: Step3 right panel hides placeholder demo text for empty steps");
assert.ok(
  !step3DraftingSource.includes("canSelectSubpoint") &&
    !coachChatSource.includes("isStep3FullyComplete"),
  "Step3 client must not contain progress decision helpers",
);
console.log("OK: Step3 client contains no progress decision helpers");

// Momentum must treat decision CTAs (采纳/拒绝 without question marks) as valid
// endings — a proposal ask ending in 。 was previously replaced by an expand ask.
mustContain(
  "Decision CTAs (采纳/拒绝 buttons) are valid endings",
  "momentum question-ending check accepts decision CTA endings",
);
// A bare 详写『x』 scheme statement must not drive deepen focus (culture-loss loop).
assert.ok(
  fs
    .readFileSync(
      path.join(repoRoot, "src/server/step2/planner-payload.ts"),
      "utf8",
    )
    .includes("must NOT drive deepen focus"),
  "focus extractor documents 详写 scheme exclusion",
);
console.log("OK: focus extractor excludes bare 详写 scheme statements");

// A locked/accepted stance must never be re-confirmed by the content fallback,
// and the stance text must not be truncated mid-sentence.
mustContain(
  "A stance the student just accepted (locked/resolved) must not be re-confirmed",
  "fallback stance branch checks stanceConfirmResolved before re-asking",
);
mustNotContain(
  "stanceText.slice(0, 40)",
  "fallback stance re-confirm no longer truncates at 40 chars",
);
// The mis-attributed 已记入：「X」 prefix was removed from the late channel.
mustNotContain(
  "已记入：「${core}」",
  "已记入 tip generator removed",
);

// Momentum must not rewrite text authored by the proposal channel this turn
// (it was eating the server recap of committed retention roles).
mustContain(
  "if (opts?.channelAuthoredText) return;",
  "momentum skips text rewrite for channel-authored turns",
);
mustContain(
  "channelAuthoredText: Boolean(proposalEarly.handled)",
  "chat pipeline passes channel-handled flag into momentum",
);

// Step3 kickoff plan must be checked against the planner framework so mapped
// points the coach narration dropped get a synthesized block.
mustContain(
  "ensureParagraphPlanCoversFrameworkPoints(",
  "step3 merge point runs framework coverage guard",
);

console.log("\nAll slot-reuse/static-guard assertions passed.");
