import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const serverPath = path.join(repoRoot, "server.ts");
const step3DraftingPath = path.join(repoRoot, "src/components/Step3Drafting.tsx");
const step2BrainstormPath = path.join(repoRoot, "src/components/Step2Brainstorm.tsx");
const source = fs.readFileSync(serverPath, "utf8");
const step3DraftingSource = fs.readFileSync(step3DraftingPath, "utf8");
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
mustContain("若是 FILLED_SHALLOW：最多追问一次具体化问题", "step3 follow-up-once rule in progression");

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
  "If questionBrief.requiresStance=true: Set currentStage: \"stance\".",
  "explore_B sufficient → stance when requiresStance",
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
  "Retention-aware clustering (CRITICAL)",
  "step2 summary stage reads retention tags",
);
mustContain(
  "ask the student to CHOOSE which point to detail-write",
  "step2 main prompt: ask-then-expand choice instead of forced KEEP/DROP",
);
mustContain(
  'Vague agreement ("好的"/"随便"/"你定") → apply the soft default',
  "step2 main prompt: vague replies fall back to soft default after choice ask",
);
mustContain(
  "If the chosen 详写 point still lacks a concrete scene/mechanism, ask ONE expansion question",
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
  "await applyStep2RetentionGuard(data, session, userMessage, messages, question);",
  "step2 retention guard: wired into coach handler",
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
  "你想选哪一个重点详写？另一个简单带一句就好",
  "step2 retention: ask student to choose detail vs brief",
);
mustContain(
  "［待裁决：详=${developed}｜略=${uncovered}｜默认=${recommendation}］",
  "step2 retention: pending marker embeds both candidates and default",
);
mustContain(
  "do NOT silently assign 详写/略写 for the student",
  "step2 prompt: forbids AI-forced detail/brief assignment",
);
mustContain(
  'A point tagged "已选略写" / "保留-略写" MUST be mapped into its body paragraph as a minor/brief supporting point',
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
mustContain("LENGTH BUDGET (decide mode & detail BEFORE writing steps):", "step3 length budget header");
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
mustContain("function enforceStep3LogicCompletion(", "step3 completion: enforce function exists");
mustContain(
  "Backfilled empty paragraphPlan step from user message.",
  "step3 completion: backfills missed last step from user message",
);
mustContain(
  "Cleared premature completion CTA; paragraphPlan still has empty steps.",
  "step3 completion: clears premature CTA while empty steps remain",
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
mustContain("function guardStep3ValueProvenance(", "step3 completion: provenance firewall exists (server)");
mustContain("function applyStudentAnswerToTargetStep(", "step3 completion: prefers student utterance for target step (server)");
mustContain("function isSubpointGenuinelyComplete(", "step3 completion: genuine complete requires student dialogue (server)");
mustContain("function clearAllStep3PlanValues(", "step3 completion: kickoff clears all values (server)");
mustContain(
  "Kickoff turn: cleared all step values",
  "step3 completion: kickoff path logs value wipe",
);
mustContain(
  "KICKOFF / FIRST PLANNING TURN",
  "step3 prompt: kickoff must leave all values empty",
);
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
    "export function isPlaceholderEchoValue(",
  ),
  "Missing: step3 completion: placeholder-echo detector exists (client)",
);
console.log("OK: step3 completion: placeholder-echo detector exists (client)");
assert.ok(
  fs.readFileSync(path.join(repoRoot, "src/utils/step3Quality.ts"), "utf8").includes(
    "export function guardStep3ValueProvenance(",
  ),
  "Missing: step3 completion: provenance firewall exists (client)",
);
console.log("OK: step3 completion: provenance firewall exists (client)");
assert.ok(
  coachChatSource.includes("guardStep3ValueProvenance(updatedSp.paragraphPlan, prevPlanSnapshot)"),
  "Missing: step3 CoachChat: provenance firewall wired after merge",
);
console.log("OK: step3 CoachChat: provenance firewall wired after merge");
mustContain("function finalizeStep3WholeStepCompletion(", "step3 completion: whole-step finalizer exists");
mustContain("function rewriteStep3AdvanceToNextBody(", "step3 completion: rewrites CTA when other bodies remain");
mustContain(
  "Never trust sibling isCompleted flags",
  "step3 completion: never trust sibling isCompleted alone",
);
mustContain(
  "Do NOT force-complete Step 3 from CTA text alone.",
  "step3 heuristic: CTA text alone cannot force complete",
);
assert.ok(
  fs.readFileSync(path.join(repoRoot, "src/utils/step3Quality.ts"), "utf8").includes(
    "export function isStep3FullyComplete(",
  ),
  "Missing: step3 client: isStep3FullyComplete quality unlock",
);
console.log("OK: step3 client: isStep3FullyComplete quality unlock");
assert.ok(
  step3DraftingSource.includes(
    "const isStep3Finished = isStep3FullyComplete(session, subpoints);",
  ),
  "Missing: step3 UI: jump button uses quality-filled gate",
);
console.log("OK: step3 UI: jump button uses quality-filled gate");
assert.ok(
  fs.readFileSync(path.join(repoRoot, "src/utils/step3Quality.ts"), "utf8").includes(
    "export function isSubpointGenuinelyComplete(",
  ),
  "Missing: step3 client: genuine complete requires student dialogue",
);
console.log("OK: step3 client: genuine complete requires student dialogue");
assert.ok(
  coachChatSource.includes("clearAllStep3PlanValues(updatedSp.paragraphPlan)"),
  "Missing: step3 CoachChat: kickoff clears plan values",
);
console.log("OK: step3 CoachChat: kickoff clears plan values");
assert.ok(
  coachChatSource.includes("isSubpointGenuinelyComplete(withDraft"),
  "Missing: step3 CoachChat: revalidates every body with dialogue gate",
);
console.log("OK: step3 CoachChat: revalidates every body with dialogue gate");
mustContain(
  "Only unlock Step 1 completion when slots are filled AND the coach already",
  "step1 completion: enforce requires completion CTA, not slots alone",
);
mustContain(
  "Premature-completion guard: clear isCompleted if the model set it while",
  "step1 completion: premature isCompleted cleared without CTA",
);
mustContain(
  "FORBIDDEN: Do NOT set isCompleted: true while still asking Task A/Task B dimension questions",
  "step1 prompt: forbids isCompleted during mid-flow dimension questions",
);
mustContain("function textSuggestsStep1Complete(", "step1 completion: text heuristic exists");
mustContain(
  '// Canonical CTA required by Step 1 completion prompt. Keep this strict so',
  "step1 completion: text heuristic kept strict for Task B mid-flow",
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
  "enforceStep2Completion(data, session)",
  "step2 completion: enforce wired after heuristic",
);
mustContain(
  "[Step2CompletionGuard] Cleared premature isCompleted",
  "step2 completion: clears premature isCompleted mid-explore",
);
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
  step3DraftingSource.includes("结构细节写入系统即可，不要在对话里提字段名"),
  "Missing: step3 kickoff: no internal field names in kickoff prompt",
);
console.log("OK: step3 kickoff: no internal field names in kickoff prompt");

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
  "step2New.requiresStance = brief.requiresStance;",
  "no-stance gate stamps requiresStance every turn for client stepper",
);
mustContain(
  "applyNoStanceGate(question, data, session);",
  "no-stance gate wired into Step2 handler",
);

// Step 2: momentum guard (Part 2 must always be a question or CTA)
mustContain("function enforceStep2Momentum(", "step2 momentum guard exists");
mustContain("function looksLikeQuestionEnding(", "step2 momentum: question-ending detector exists");
mustContain(
  "appended fallback next-step prompt",
  "step2 momentum: logs when fallback question is injected",
);
mustContain(
  "enforceStep2Momentum(data, session);",
  "step2 momentum guard wired into Step2 handler",
);

// Client stepper: requiresStance-aware stage list
assert.ok(
  step2BrainstormSource.includes("const requiresStance = (evalData as any)?.requiresStance !== false;"),
  "Missing: step2 stepper reads requiresStance from evalData",
);
console.log("OK: step2 stepper reads requiresStance from evalData");
assert.ok(
  step2BrainstormSource.includes("{ id: 'explore_A', label: '1. 第一任务' }"),
  "Missing: step2 stepper has 3-stage variant for no-stance essays",
);
console.log("OK: step2 stepper has 3-stage variant for no-stance essays");

// Step 3: kickoff isolation + quality-filled gate + sequential body lock
mustContain("function isKickoffOrInstructionText(", "step3 kickoff pollution detector exists");
mustContain("function isValidStep3StepValue(", "step3 valid step value gate exists");
mustContain("function sanitizeParagraphPlanValues(", "step3 sanitize paragraphPlan values exists");
mustContain("isHiddenKickoff", "step3 API accepts isHiddenKickoff flag");
mustContain(
  "skipBackfill =\n    options?.isHiddenKickoff || isKickoffOrInstructionText(userMessage)",
  "step3 guard skips backfill on hidden kickoff",
);
assert.ok(
  step3DraftingSource.includes("canSelectSubpoint"),
  "Missing: Step3Drafting sequential body lock",
);
console.log("OK: Step3Drafting sequential body lock");
assert.ok(
  fs.readFileSync(path.join(repoRoot, "src/utils/step3Quality.ts"), "utf8").includes(
    "export function canSelectSubpoint",
  ),
  "Missing: step3Quality utils module",
);
console.log("OK: step3Quality utils module");

console.log("\nAll slot-reuse/static-guard assertions passed.");
