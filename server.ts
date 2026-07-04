import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { jsonrepair } from "jsonrepair";

dotenv.config();

// Lazy-initialize Gemini API client to avoid startup crashes if key is missing
let aiInstance: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    throw new Error(
      "GEMINI_API_KEY is not set or is still the default. Please add your real key in Settings > Secrets.",
    );
  }
  if (!aiInstance) {
    aiInstance = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiInstance;
}

function parseAIResponse(text: string | undefined, defaultData: any = {}): any {
  if (!text) return defaultData;
  let responseText = text.trim();
  if (responseText.startsWith("\`\`\`json")) {
    responseText = responseText
      .replace(/^\`\`\`json\n?/, "")
      .replace(/\n?\`\`\`$/, "");
  }
  try {
    return JSON.parse(responseText);
  } catch (e: any) {
    try {
      const repaired = jsonrepair(responseText);
      return JSON.parse(repaired);
    } catch (e2: any) {
      console.warn("JSON parsing completely failed, attempting regex salvage");
      const textMatch = responseText.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (textMatch) {
        return {
          ...defaultData,
          text: textMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'),
        };
      }
      return defaultData;
    }
  }
}

function splitTwoParts(
  text: string | undefined,
  minPart2Length: number = 6,
): {
  ok: boolean;
  part1: string;
  part2: string;
  reason: string;
} {
  const raw = String(text || "").trim();
  if (!raw) {
    return { ok: false, part1: "", part2: "", reason: "empty_text" };
  }
  const parts = raw.split(/\n\s*---\s*\n/);
  if (parts.length < 2) {
    return {
      ok: false,
      part1: raw,
      part2: "",
      reason: "missing_delimiter",
    };
  }
  const part1 = String(parts[0] || "").trim();
  const part2 = String(parts.slice(1).join("\n---\n") || "").trim();
  if (!part1) {
    return { ok: false, part1, part2, reason: "empty_part1" };
  }
  if (!part2) {
    return { ok: false, part1, part2, reason: "empty_part2" };
  }
  if (part2.replace(/\s+/g, "").length < minPart2Length) {
    return { ok: false, part1, part2, reason: "part2_too_short" };
  }
  return { ok: true, part1, part2, reason: "" };
}

function fallbackNextStep(stepNum: number, session: any): string {
  if (stepNum === 1) {
    const eval1 = session?.step1?.coachEvaluation || {};
    if (!eval1.correctType) {
      return "先完成题型识别：这道 Task 2 题属于哪一类（如 Agree/Disagree、Discussion、Advantages/Disadvantages）？请直接给出你的判断。";
    }
    if (!eval1.coreIssue) {
      return "请用一句话说出题目的核心争议：作者真正让你判断的焦点是什么（不要直译题干）？";
    }
    if (!Array.isArray(eval1.constraints) || eval1.constraints.length === 0) {
      return "再补一步：这道题有哪些关键限定词（人群、场景、程度、时间）必须在论证中回应？请列 1-3 个。";
    }
    return "很好。请把你的审题结论整合成一句写作任务说明：你准备如何回应题目、覆盖哪些限定并给出什么立场？";
  }

  if (stepNum === 2) {
    const stage =
      session?.step2?.coachEvaluation?.currentStage ||
      session?.step2?.currentStage ||
      "explore_A";
    if (stage === "explore_A") {
      return "我们先完成 A 面发散：请给出 1-2 个支持 A 面的具体论据，并说明每个论据对应的受益对象。";
    }
    if (stage === "explore_B") {
      return "继续补齐 B 面：请给出 1-2 个 B 面不可替代的点，并尽量和刚才 A 面形成可对照关系。";
    }
    if (stage === "stance") {
      return "现在请明确你的全文立场（支持/反对/部分同意），并用一句话说明“为什么这个立场最能回应题目限定”。";
    }
    if (stage === "summary") {
      return "请确认最终蓝图：你的 Body 1 和 Body 2 分别打算写什么核心分论点？每个分论点给出一句可展开的中心句。";
    }
    return "请基于目前讨论，给出“全文立场 + 两个主体段分论点”的简版草图，我来帮你即时校准逻辑闭环。";
  }

  if (stepNum === 3) {
    const activeId = session?.step3?.activeSubpointId;
    const activeSubpoint = (session?.step3?.subpoints || []).find(
      (sp: any) => sp.id === activeId,
    );
    if (!activeSubpoint) {
      return "请先确认要推进的主体段分论点（当前没有激活分论点）。确认后我会直接做单点/多点诊断并给出 paragraphPlan。";
    }

    const plan = activeSubpoint.paragraphPlan;
    if (plan && Array.isArray(plan.pointBlocks)) {
      for (const block of plan.pointBlocks) {
        if (!Array.isArray(block?.steps)) continue;
        const pending = block.steps.find(
          (s: any) => !String(s?.value || "").trim(),
        );
        if (pending) {
          return `继续推进「${block.label || "分点"}」：请先回答这一步「${pending.label || "展开"}」的具体内容。`;
        }
      }
      return "这个分论点的关键步骤已基本齐全。要继续完善，我建议你补一句更有力度的收束句，或者告诉我现在切换到下一个分论点。";
    }

    if (Array.isArray(activeSubpoint.structureSteps)) {
      const pending = activeSubpoint.structureSteps.find(
        (s: any) => !String(s?.value || "").trim(),
      );
      if (pending) {
        return `我们继续当前链条：请完成「${pending.label || "下一步"}」这一步，用一句具体可论证的话表达。`;
      }
    }

    return "请基于这个分论点补充一个最关键的“为什么成立”的理由，我会据此继续向下一步（机制/举例/影响）推进。";
  }

  if (stepNum === 4) {
    return "请把你当前最薄弱的那一句先贴出来（主题句/解释句/例证句都可以），我先做一轮针对性升级。";
  }

  if (stepNum === 5) {
    return "请先选择你最想优先修正的一项（任务回应、逻辑连贯、词句准确性），我会按这一项给你可执行的改写动作。";
  }

  return "我们继续下一步：请基于当前内容补充一个最具体、最可展开的论证点。";
}

function isBlankString(v: any): boolean {
  return typeof v === "string" && v.trim() === "";
}

function isBlankStringArray(v: any): boolean {
  return Array.isArray(v) && v.every((item) => String(item || "").trim() === "");
}

function sanitizeProgressUpdateWithSession(
  progressUpdate: any,
  session: any,
): any {
  if (!progressUpdate || typeof progressUpdate !== "object") {
    return progressUpdate;
  }

  const step1New = progressUpdate?.step1Data;
  const step1Old = session?.step1?.coachEvaluation || {};
  if (step1New && typeof step1New === "object") {
    const step1StringKeys = [
      "correctType",
      "coreIssue",
      "critique",
      "writingTask",
      "keyQualifier",
    ];
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

// Deterministic Step 1 constraint backfill (safety net for the slot-reuse skip rule).
// The "关键限定词" is a property of the essay QUESTION. When the student's answer
// echoes a scope qualifier that also exists in the question (e.g. answers coreIssue
// with "完全替代" while the prompt says "replace ... entirely"), we credit it into the
// constraints slot deterministically so the Coach never re-asks the qualifier question.
const STEP1_QUALIFIER_GROUPS: { label: string; zh: RegExp; en: RegExp }[] = [
  { label: "完全 (entirely)", zh: /完全|彻底|完整/, en: /\bentirely\b|\bcompletely\b|\bwholly\b/i },
  { label: "只/仅 (only)", zh: /仅|唯一/, en: /\bonly\b|\bsolely\b|\bexclusively\b/i },
  { label: "必须 (must)", zh: /必须|一定要/, en: /\bmust\b/i },
  { label: "始终 (always)", zh: /始终|一直|永远/, en: /\balways\b/i },
  { label: "所有 (all)", zh: /所有|全部|一切/, en: /\ball\b/i },
  { label: "从不 (never)", zh: /从不|绝不/, en: /\bnever\b/i },
];

function detectEchoedQualifiers(question: string, userText: string): string[] {
  const q = String(question || "");
  const u = String(userText || "");
  const labels: string[] = [];
  for (const group of STEP1_QUALIFIER_GROUPS) {
    const inQuestion = group.zh.test(q) || group.en.test(q);
    const inUser = group.zh.test(u) || group.en.test(u);
    if (inQuestion && inUser) labels.push(group.label);
  }
  return labels;
}

// Returns the labels backfilled (empty if nothing was filled).
function backfillStep1Constraints(
  question: string,
  userMessage: string,
  progressUpdate: any,
  session: any,
): string[] {
  if (!progressUpdate || typeof progressUpdate !== "object") return [];
  const step1New =
    progressUpdate.step1Data && typeof progressUpdate.step1Data === "object"
      ? progressUpdate.step1Data
      : null;
  const step1Old = session?.step1?.coachEvaluation || {};

  const newConstraints = step1New?.constraints;
  const oldConstraints = step1Old?.constraints;
  const alreadyFilled =
    (Array.isArray(newConstraints) && newConstraints.some((c) => String(c || "").trim())) ||
    (Array.isArray(oldConstraints) && oldConstraints.some((c) => String(c || "").trim()));
  if (alreadyFilled) return [];

  const effectiveCoreIssue = String(
    step1New?.coreIssue || step1Old?.coreIssue || "",
  );
  const scanText = `${userMessage} ${effectiveCoreIssue}`;
  const labels = detectEchoedQualifiers(question, scanText);
  if (labels.length === 0) return [];

  const target = step1New || {};
  target.constraints = labels;
  if (isBlankString(target.keyQualifier) || target.keyQualifier === undefined) {
    if (!String(step1Old?.keyQualifier || "").trim()) {
      target.keyQualifier = labels[0];
    }
  }
  progressUpdate.step1Data = target;
  return labels;
}

function looksLikeConstraintQuestion(part2: string): boolean {
  const t = String(part2 || "");
  return (
    /限制了讨论范围/.test(t) ||
    /限定词/.test(t) ||
    /(哪些词)[^。？?]{0,8}(限制|限定)/.test(t) ||
    /(限制|限定)[^。？?]{0,8}(讨论范围|范围)/.test(t)
  );
}

function mergeStep1Evaluation(progressUpdate: any, session: any): Record<string, any> {
  const newS1 =
    progressUpdate?.step1Data && typeof progressUpdate.step1Data === "object"
      ? progressUpdate.step1Data
      : {};
  const oldS1 = session?.step1?.coachEvaluation || {};
  return { ...oldS1, ...newS1 };
}

function isStep1SlotsComplete(step1Eval: Record<string, any>): boolean {
  const hasType = String(step1Eval.correctType || "").trim().length > 0;
  const hasIssue = String(step1Eval.coreIssue || "").trim().length > 0;
  const constraints = step1Eval.constraints;
  const hasConstraints =
    Array.isArray(constraints) &&
    constraints.some((c: any) => String(c || "").trim().length > 0);
  const dims = step1Eval.suggestedDimensions;
  const filledDims = Array.isArray(dims)
    ? dims.filter((d: any) => String(d || "").trim().length > 0)
    : [];
  return hasType && hasIssue && hasConstraints && filledDims.length >= 2;
}

function textSuggestsStep1Complete(text: string): boolean {
  const t = String(text || "");
  return (
    t.includes("进入第二步") ||
    t.includes("进入第二阶段") ||
    t.includes("脑暴与蓝图设计") ||
    /进入\s*Step\s*2/i.test(t) ||
    /Step\s*2\s*[:：]/i.test(t) ||
    t.includes("观点形成") ||
    t.includes("观点生成") ||
    t.includes("恭喜通关审题") ||
    (t.includes("审题") && t.includes("通关")) ||
    t.includes("四个审题要素都齐了") ||
    (t.includes("已完成") && t.includes("审题")) ||
    /Argument Formation/i.test(t)
  );
}

function textSuggestsStep2Complete(text: string): boolean {
  const t = String(text || "");
  return (
    t.includes("进入第三步") ||
    t.includes("进入第三阶段") ||
    t.includes("段落逻辑链构建") ||
    /进入\s*Step\s*3/i.test(t) ||
    t.includes("段落论证训练") ||
    t.includes("段落写作训练") ||
    (t.includes("下一步") && t.includes("第三步"))
  );
}

function applyStepCompletionHeuristic(data: any, stepNum: number): void {
  if (!data) return;

  let shouldForceComplete = false;

  if (stepNum === 1) {
    if (data.text && textSuggestsStep1Complete(data.text)) {
      shouldForceComplete = true;
    }
    // Anti-drift: Step 2 payload must not appear while Step 1 is active.
    if (
      data.progressUpdate?.step2Data &&
      typeof data.progressUpdate.step2Data === "object"
    ) {
      shouldForceComplete = true;
    }
  } else if (stepNum === 2) {
    if (data.text && textSuggestsStep2Complete(data.text)) {
      shouldForceComplete = true;
    }
    if (
      data.progressUpdate?.paragraphPlan ||
      (Array.isArray(data.progressUpdate?.step3SubpointSteps) &&
        data.progressUpdate.step3SubpointSteps.length > 0)
    ) {
      shouldForceComplete = true;
    }
  } else if (stepNum === 3) {
    const t = String(data.text || "");
    if (
      t.includes("第三步段落逻辑链构建已全部完成") ||
      t.includes("进入第四步：逐句写作练习") ||
      t.includes("进入第四阶段") ||
      t.includes("进入逐句写作") ||
      t.includes("进入逐句写作练习")
    ) {
      shouldForceComplete = true;
    }
  } else if (data.text) {
    const t = data.text;
    if (
      t.includes("进入第二步") ||
      t.includes("进入第三步") ||
      t.includes("进入第四步") ||
      t.includes("进入下一阶")
    ) {
      shouldForceComplete = true;
    }
  }

  if (!shouldForceComplete) return;

  if (!data.progressUpdate) {
    data.progressUpdate = { isCompleted: true };
  } else {
    data.progressUpdate.isCompleted = true;
  }
}

function enforceStep1SlotCompletion(data: any, session: any): void {
  if (!data?.progressUpdate) return;

  const merged = mergeStep1Evaluation(data.progressUpdate, session);
  if (!isStep1SlotsComplete(merged)) return;

  data.progressUpdate.isCompleted = true;

  // Step 2 fields leaked into a Step 1 response are ignored by the client; strip them.
  if (data.progressUpdate.step2Data) {
    delete data.progressUpdate.step2Data;
  }
}

async function generateContentWithFallback(params: {
  contents: any;
  config?: any;
}): Promise<any> {
  const ai = getAI();
  const models = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-2.5-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro"];
  let lastError: any = null;

  for (const model of models) {
    let retries = 2;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(
          `[Gemini] Attempting generation with model: ${model} (attempt ${attempt}/${retries})`,
        );
        const response = await ai.models.generateContent({
          model,
          contents: params.contents,
          config: params.config,
        });
        return response;
      } catch (error: any) {
        lastError = error;
        console.warn(
          `[Gemini] Model ${model} (attempt ${attempt}) failed. Error:`,
          error.message || error,
        );

        if (
          error.message?.includes("API_KEY") ||
          error.message?.includes("not set") ||
          error.message?.includes("unauthorized") ||
          error.message?.includes("invalid") ||
          error.status === 401 ||
          error.status === 403
        ) {
          throw error;
        }

        if (error.status === 404) {
          // Model not found, skip to next model
          break;
        }

        if (error.status === 503) {
          // Model overloaded, immediately fall back to the next model.
          break;
        }

        if (error.status === 429) {
          // If quota exceeded, try to extract retry delay, default 5s
          const delayMatch = (error.message || "").match(
            /retry in ([\d\.]+)s/i,
          );
          const delaySec = delayMatch ? parseFloat(delayMatch[1]) : 5;
          if (delaySec > 10) {
            console.log(
              `[Gemini] Rate limited with long delay (${delaySec}s). Skipping to next model...`,
            );
            break;
          }
          if (attempt < retries) {
            const delayMs = delaySec * 1000 + 500; // add 500ms buffer
            console.log(
              `[Gemini] Rate limited. Waiting ${delayMs}ms before retry...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        } else if (attempt < retries) {
          const delay = attempt * 1000;
          console.log(`[Gemini] Waiting ${delay}ms before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }

  throw lastError || new Error("All fallback models failed.");
}

// Step 2 Dimension Coverage & Retention Guard.
//
// The prompt-only "Dimension Coverage & Retention Rule" is diluted by the huge
// multi-thousand-line Step 2 prompt and gets silently ignored by the model in
// practice (verified via isolated testing: the same check succeeds reliably in a
// small, narrow-scope prompt but fails inside the full prompt). This guard runs a
// SEPARATE, narrow-scope verification call only at the moment a Step 2 explore
// stage is about to transition, and corrects the response deterministically if an
// uncovered sibling dimension is found. State is persisted purely in
// progressUpdate.step2Data.userPoints (the only Layer-1 field available in real
// time during explore_A/explore_B) using a "［待裁决：...］" marker.

// Marker format: ［待裁决：<dimension>｜<recommendation>］ — the recommendation is
// embedded so that a short, ambiguous user reply (e.g. "好的"/"都行") can be resolved
// relative to what was actually recommended, instead of always defaulting to one
// fixed outcome regardless of which recommendation was proposed.
const PENDING_RETENTION_MARKER_RE = /［待裁决：([^｜］]+)(?:｜([^］]+))?］/;

type RetentionRecommendation = "EXPAND_BOTH" | "KEEP_MINOR" | "DROP";

function extractPendingRetention(
  userPointsText: string,
): { dimension: string; recommendation: RetentionRecommendation | null } | null {
  const match = PENDING_RETENTION_MARKER_RE.exec(String(userPointsText || ""));
  if (!match) return null;
  const recommendation = match[2] as RetentionRecommendation | undefined;
  return {
    dimension: match[1].trim(),
    recommendation:
      recommendation === "KEEP_MINOR" || recommendation === "DROP"
        ? recommendation
        : null,
  };
}

// Pure, testable decision table: turns two LLM-judged signals into ONE default
// recommendation + a short Chinese reason. Kept deterministic (not another LLM
// call) so behavior is stable and unit-testable without network access.
function decideStep2Retention(
  developedIsSolid: boolean,
  uncoveredRelevantToQuestion: boolean,
): { recommendation: RetentionRecommendation; reasonZh: string } {
  if (!developedIsSolid) {
    return {
      recommendation: "EXPAND_BOTH",
      reasonZh: "已展开的点还不够具体，两个维度都需要先补充内容",
    };
  }
  if (uncoveredRelevantToQuestion) {
    return {
      recommendation: "KEEP_MINOR",
      reasonZh: "这一点和题目直接相关，建议保留下来作为略写的补充点",
    };
  }
  return {
    recommendation: "DROP",
    reasonZh: "这一点和已展开的点比较重复或次要，建议专注写已展开的这一点",
  };
}

// Resolves the student's short reply to a pending retention question relative to
// the recommendation that was actually proposed. An explicit contradiction of the
// recommendation flips the outcome; anything else (including vague agreement like
// "好的"/"都行"/"随便") is treated as accepting the recommendation.
function resolvePendingRetentionChoice(
  userMessage: string,
  recommendation: RetentionRecommendation | null,
): string {
  const t = String(userMessage || "");
  const wantsDrop = /放弃|算了|不用了|不需要|只写|不要|drop|skip/i.test(t);
  const wantsKeep = /保留|都写|都要|都展开|两个都/i.test(t);

  if (recommendation === "DROP") {
    // Recommendation was to drop; an explicit "keep" contradicts it.
    return wantsKeep && !wantsDrop ? "保留-略写" : "用户放弃";
  }
  // Recommendation was KEEP_MINOR (or unknown/legacy marker without a recommendation);
  // an explicit "drop" contradicts it.
  return wantsDrop ? "用户放弃" : "保留-略写";
}

function extractLastCoachQuestion(messages: any[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.sender === "ai" && String(m.text || "").trim()) {
      return String(m.text).trim();
    }
  }
  return "";
}

async function checkStep2DimensionCoverage(params: {
  question: string;
  lastCoachQuestion: string;
  studentAnswer: string;
}): Promise<{
  hasMultipleDimensions: boolean;
  uncoveredDimension: string;
  developedIsSolid: boolean;
  uncoveredRelevantToQuestion: boolean;
} | null> {
  const essayQuestion = String(params.question || "").trim();
  const lastCoachQuestion = String(params.lastCoachQuestion || "").trim();
  const studentAnswer = String(params.studentAnswer || "").trim();
  if (!lastCoachQuestion || !studentAnswer) return null;

  try {
    const prompt = `
You are checking ONE narrow fact about a single turn of an IELTS coaching dialogue. Do not do anything else, do not evaluate writing quality, do not generate coaching feedback.

The IELTS essay question being discussed:
"${essayQuestion}"

The coach's most recent question was:
"${lastCoachQuestion}"

The student's answer was:
"${studentAnswer}"

Task:
1. Does the coach's question name TWO OR MORE distinct sub-dimensions/sub-angles/scenarios for the same side of the argument (e.g. joined by 与/和/、, or listed as 『A』『B』, or "A以及B")? If it only names ONE (or none), set hasMultipleDimensions=false, uncoveredDimension="", developedIsSolid=false, uncoveredRelevantToQuestion=false, and stop.
2. If it names 2+, does the student's answer substantively develop ONLY ONE of them (the other is not mentioned at all, or only trivially/synonymously restated)? If the student's answer already substantively covers ALL named sub-dimensions, set hasMultipleDimensions=true but uncoveredDimension="".
3. If exactly one sub-dimension is left uncovered, copy it EXACTLY as a short phrase from the coach's question (in Chinese) into "uncoveredDimension".
4. Judge whether the student's answer for the DEVELOPED dimension is already "solid" (includes a concrete scenario/beneficiary/mechanism, could support a full IELTS body paragraph alone) vs "thin" (still vague/generic, one-liner). Set developedIsSolid accordingly.
5. Judge whether the UNCOVERED dimension directly responds to a core qualifier/contrast in the essay question (e.g. "entirely", "highly beneficial", an explicit comparison) — set uncoveredRelevantToQuestion=true. If it is more of a repetition/overlap with the developed dimension, or a peripheral/minor detail that doesn't add a distinct angle to the essay's core argument, set uncoveredRelevantToQuestion=false.

Respond with JSON only, matching the schema.
`;
    const response = await generateContentWithFallback({
      contents: prompt,
      config: {
        maxOutputTokens: 512,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            hasMultipleDimensions: { type: Type.BOOLEAN },
            uncoveredDimension: { type: Type.STRING },
            developedIsSolid: { type: Type.BOOLEAN },
            uncoveredRelevantToQuestion: { type: Type.BOOLEAN },
          },
          required: [
            "hasMultipleDimensions",
            "uncoveredDimension",
            "developedIsSolid",
            "uncoveredRelevantToQuestion",
          ],
        },
      },
    });
    const parsed = parseAIResponse(response?.text, null);
    if (!parsed) return null;
    return {
      hasMultipleDimensions: !!parsed.hasMultipleDimensions,
      uncoveredDimension: String(parsed.uncoveredDimension || "").trim(),
      developedIsSolid: !!parsed.developedIsSolid,
      uncoveredRelevantToQuestion: !!parsed.uncoveredRelevantToQuestion,
    };
  } catch (e: any) {
    console.warn(
      "[Step2RetentionGuard] verification call failed (fail-open, no correction applied):",
      e.message || e,
    );
    return null;
  }
}

// Applies the retention guard in-place on `data`. Fails open on any error so a
// verification-call failure never blocks the primary coaching response.
async function applyStep2RetentionGuard(
  data: any,
  session: any,
  userMessage: string,
  messages: any[],
  question: string,
): Promise<void> {
  if (!data?.progressUpdate?.step2Data) return;

  const oldStage = session?.step2?.coachEvaluation?.currentStage || "explore_A";
  const newStage = data.progressUpdate.step2Data.currentStage;
  const oldUserPoints = session?.step2?.coachEvaluation?.userPoints || "";

  const pending = extractPendingRetention(oldUserPoints);
  if (pending) {
    // This turn is the student's answer to a retention question asked last turn.
    const choice = resolvePendingRetentionChoice(userMessage, pending.recommendation);
    const basePoints = String(
      data.progressUpdate.step2Data.userPoints || oldUserPoints || "",
    ).replace(PENDING_RETENTION_MARKER_RE, "").trim();
    data.progressUpdate.step2Data.userPoints =
      `${basePoints}；${pending.dimension}（${choice}）`.trim();
    return;
  }

  const isExploreTransition =
    (oldStage === "explore_A" && newStage && newStage !== "explore_A") ||
    (oldStage === "explore_B" && newStage && newStage !== "explore_B");
  if (!isExploreTransition) return;

  const lastCoachQuestion = extractLastCoachQuestion(messages);
  if (!lastCoachQuestion) return;

  const check = await checkStep2DimensionCoverage({
    question,
    lastCoachQuestion,
    studentAnswer: userMessage,
  });
  if (!check?.hasMultipleDimensions || !check.uncoveredDimension) return;

  const { recommendation, reasonZh } = decideStep2Retention(
    check.developedIsSolid,
    check.uncoveredRelevantToQuestion,
  );

  // Revert the transition and fold a recommendation-driven retention question
  // into this same turn, instead of an open-ended "which do you prefer" ask.
  data.progressUpdate.step2Data.currentStage = oldStage;
  const split = splitTwoParts(data.text, 1);
  const part1 = (split.part1 || data.text || "").trim();
  const uncovered = check.uncoveredDimension;

  let retentionQuestion: string;
  if (recommendation === "EXPAND_BOTH") {
    retentionQuestion = `我们先记录下这一点（${reasonZh}）。你之前还提到『${uncovered}』——能否也补充 1-2 句，让这一维度也有具体内容？`;
  } else if (recommendation === "KEEP_MINOR") {
    retentionQuestion = `这一点已经足够扎实，可以独立支撑一段。${reasonZh}——建议把『${uncovered}』保留下来作为一个略写的补充点（Step 3 会详写这一点、略写『${uncovered}』，控制在 90-110 词内）。如果你想专注只写这一点，回复"放弃${uncovered}"即可。`;
  } else {
    retentionQuestion = `这一点已经足够扎实，可以独立支撑一段。${reasonZh}——建议专注写这一点就好。如果你还是想把『${uncovered}』也简单提一句，回复"保留${uncovered}"即可。`;
  }
  data.text = `${part1}\n\n---\n\n${retentionQuestion}`;

  const basePoints = String(
    data.progressUpdate.step2Data.userPoints || oldUserPoints || "",
  ).trim();
  data.progressUpdate.step2Data.userPoints =
    `${basePoints} ［待裁决：${uncovered}｜${recommendation}］`.trim();

  console.warn(
    `[Step2RetentionGuard] Reverted transition ${oldStage}->${newStage}; uncovered="${uncovered}"; recommendation=${recommendation}`,
  );
}

// Cross-step safety net: strip internal JSON field/enum names from user-facing chat
// text. The UI panels already render localized versions of progressUpdate; chat
// text should never echo raw implementation vocabulary (see NO INTERNAL JARGON rule).
const INTERNAL_JARGON_REPLACEMENTS: [RegExp, string][] = [
  // Step 3 paragraph-plan enums & fields
  [/['"“‘]?total_then_points['"”’]?\s*(模式|mode)?/gi, "先总起再分点的写法"],
  [/['"“‘]?direct_points['"”’]?\s*(模式|mode)?/gi, "直接分点展开的写法"],
  [/['"“‘]?single_point['"”’]?\s*(模式|mode)?/gi, "单点展开的写法"],
  [/\bparagraphPlan\b/gi, ""],
  [/\bpointBlock[s]?\b/gi, "分点"],
  [/\bstep3SubpointSteps\b/gi, ""],
  [/\bexpansionStrategy\b/gi, ""],
  [/\b(?:Multi-?point|multi-?point)\b/gi, "多点"],
  // Step 2 stage & retention enums
  [/\bexplore_[AB]\b/gi, ""],
  [/\bcurrentStage\b/gi, ""],
  [/\bKEEP_MINOR\b/g, "保留为略写"],
  [/\bEXPAND_BOTH\b/g, ""],
  [/\bDROP\b/g, ""],
  [/\bclustering\b/gi, ""],
  [/\boutliers\b/gi, ""],
  // Step 1 slot & data fields
  [/\bcorrectType\b/gi, "题型"],
  [/\bcoreIssue\b/gi, "核心争议"],
  [/\bconstraints\b/gi, "关键限定"],
  [/\bsuggestedDimensions\b/gi, "讨论维度"],
  [/\bstep1Data\b/gi, ""],
  [/\bstep2Data\b/gi, ""],
  // Global implementation vocabulary
  [/\bprogressUpdate\b/gi, ""],
  [/\bisCompleted\b/gi, ""],
  [/\buserPoints\b/gi, ""],
  [/\bblueprint\b/gi, "文章蓝图"],
  // English role names -> Chinese (when leaked as raw words)
  [/\bmajor\b/gi, "详写"],
  [/\bminor\b/gi, "略写"],
];

function stripInternalJargonFromChatText(text: string): string {
  let cleaned = String(text || "");
  for (const [pattern, replacement] of INTERNAL_JARGON_REPLACEMENTS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  // Collapse whitespace left by stripped tokens; preserve paragraph breaks.
  cleaned = cleaned
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/gm, (m) => (m.includes("\n") ? m : m.trim()))
    .trim();
  return cleaned;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Log requests in dev
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  // 1. API - Health check
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      hasKey:
        !!process.env.GEMINI_API_KEY &&
        process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY",
    });
  });

  // 2. API - Analyze Topic (Step 1)
  app.post("/api/analyze-topic", async (req, res) => {
    try {
      const { question, userSelectedType } = req.body;
      if (!question) {
        res.status(400).json({ error: "Missing question text" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an elite IELTS Writing Task 2 Examiner.
        Analyze the following IELTS Writing Task 2 prompt:
        "${question}"

        Determine the correct IELTS Task 2 Question Type from this exact list:
        - "Agree / Disagree"
        - "Discuss Both Views"
        - "Advantages / Disadvantages"
        - "Two-part Question"
        - "Problem / Solution"

        Extract:
        1. The primary core controversy/issue to discuss.
        2. Any key scope constraints (specific target groups, limiting conditions, or absolutist terms like "only", "always", "entirely").
        3. A brief, highly-academic explanation (1-2 sentences) of why it belongs to this category.

        If a userSelectedType is provided: "${userSelectedType || ""}", check if it matches the correct type. Set isCorrectType to true or false.

        Format your output strictly as a JSON object matching this schema:
        {
          "questionType": "string (the correct question type)",
          "isCorrectType": boolean,
          "correctType": "string (the correct question type)",
          "coreIssue": "string (succinctly state the central controversy)",
          "constraints": ["string (constraint 1)", "string (constraint 2)"],
          "explanation": "string (academic explanation)"
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              questionType: { type: Type.STRING },
              isCorrectType: { type: Type.BOOLEAN },
              correctType: { type: Type.STRING },
              coreIssue: { type: Type.STRING },
              constraints: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              explanation: { type: Type.STRING },
            },
            required: [
              "questionType",
              "isCorrectType",
              "correctType",
              "coreIssue",
              "constraints",
              "explanation",
            ],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/analyze-topic:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to analyze topic" });
    }
  });

  // Coach API - Dynamic Chat with AI Coach
  app.post("/api/coach/chat", async (req, res) => {
    try {
      const { question, step, messages, stepContext, session, userMessage } =
        req.body;
      if (!question || !step || !userMessage) {
        res
          .status(400)
          .json({
            error:
              "Missing required parameters: question, step, or userMessage",
          });
        return;
      }

      const promptHistory = (messages || [])
        .slice(-15)
        .map((m: any) => {
          return `${m.sender === "user" ? "Student" : "IELTS AI Coach"}: ${m.text}`;
        })
        .join("\n");

      // Extract user inputs and coach evaluations from previous steps to make AI truly aware
      const step1Chat = session?.step1?.chatHistory || [];
      const step1ChatText = step1Chat
        .filter((m: any) => m.sender === "user")
        .map((m: any) => m.text.trim())
        .filter((t: string) => t.length > 0)
        .join(" | ");
      const step1UserNotes = session?.step1?.userAnalysisNotes?.trim() || "";
      let step1Notes = step1UserNotes;
      if (step1ChatText) {
        if (step1Notes) {
          if (step1Notes !== step1ChatText) {
            step1Notes = `${step1Notes} (Chat History: ${step1ChatText})`;
          }
        } else {
          step1Notes = step1ChatText;
        }
      }
      if (!step1Notes) {
        step1Notes = "Not provided";
      }

      const step1Eval = session?.step1?.coachEvaluation;

      const step2Chat = session?.step2?.chatHistory || [];
      const step2ChatText = step2Chat
        .filter((m: any) => m.sender === "user")
        .map((m: any) => m.text.trim())
        .filter((t: string) => t.length > 0)
        .join(" | ");
      const step2UserStance = session?.step2?.userStance || "";
      const step2UserPoints = session?.step2?.userPoints || "";
      let step2Stance = step2UserStance;
      let step2Points = step2UserPoints;
      if (step2ChatText) {
        if (step2Stance) {
          if (step2Stance !== step2ChatText) {
            step2Stance = `${step2Stance} (Chat Stance: ${step2ChatText})`;
          }
        } else {
          step2Stance = step2ChatText;
        }
        if (step2Points) {
          if (step2Points !== step2ChatText) {
            step2Points = `${step2Points} (Chat Points: ${step2ChatText})`;
          }
        } else {
          step2Points = step2ChatText;
        }
      }

      const step2Eval = session?.step2?.coachEvaluation;
      const step3Draft = session?.step3?.userDraft || "";
      const step3Subpoints = session?.step3?.subpoints || [];
      const activeStep3Subpoint = step3Subpoints.find(
        (sp: any) => sp.id === session?.step3?.activeSubpointId,
      );
      const activeStep3Claim = activeStep3Subpoint?.content?.trim?.() || "";

      let contextStr = "No previous step data available yet.";
      if (session) {
        let step1Summary = "";
        if (step1Notes) {
          step1Summary += `User's Actual Notes/Stance: "${step1Notes}"\n`;
        }
        if (step1Eval) {
          const step1Dims = (step1Eval.suggestedDimensions || [])
            .map((d: string) => d?.trim?.() || "")
            .filter((d: string) => d.length > 0);
          step1Summary += `Coach Evaluation:\n- Question Type: ${step1Eval.correctType}\n- Core Issue: ${step1Eval.coreIssue}\n- Constraints: ${(step1Eval.constraints || []).join(", ")}\n- Suggested Dimensions: ${step1Dims.length > 0 ? step1Dims.join(", ") : "Not provided"}\n- Critique: ${step1Eval.critique}`;
        }
        if (!step1Summary) {
          step1Summary = "Not provided";
        }

        let step2Summary = "";
        if (step2Stance || step2Points) {
          step2Summary += `User's Formulated Stance: "${step2Stance || "Not provided"}"\nUser's Formulated Points: "${step2Points || "Not provided"}"\n`;
        }
        if (step2Eval) {
          step2Summary += `Coach Evaluation:\n- Current Stage: ${step2Eval.currentStage || "explore_A"}\n- User Stance: ${step2Eval.userStance || step2Stance}\n- User Points: ${step2Eval.userPoints || step2Points}\n- Coach Critique: ${step2Eval.critique}\n- Recommended Stance: ${step2Eval.suggestedStance}\n- Recommended Points: ${step2Eval.suggestedPoints}`;
        }
        if (!step2Summary) {
          step2Summary = "Not provided";
        }

        contextStr = `
=== ContextSummary(CoachingState) ===
Question:
${question}

Known user ideas & Coach Diagnostics:

[Step 1 (Question Analysis) Diagnosis]:
${step1Summary}

[Step 2 (Argument Formation) Diagnosis]:
${step2Summary}

[Step 3 (Drafting) Ideas]:
- Paragraph Drafts: ${step3Draft || "Not provided"}
- Subpoint logic chains: ${JSON.stringify(step3Subpoints)}
- Active Subpoint (= starting claim for this turn): ${activeStep3Claim || "Not selected / not provided"}
- Rule for this turn: If Active Subpoint exists, treat it as the student's already-approved claim. Start diagnosis and paragraphPlan directly. Ask clarification only if this claim is empty, too vague, or bundles unclear mixed points.

Current objective:
Review the context above and the current step's instructions. Organize and develop the existing ideas. Keep full consistency with the established positions.
=====================================
`;
      }

      let stepGuidelines = "";
      if (Number(step) === 1) {
        stepGuidelines = `
- Step 1: Topic Analysis (审题与题目拆解)
  Current State: ANALYSIS
  Role: You are a Socratic Question Analyst.
  Objective: Complete Step 1 using SLOT-based progression (not rigid fixed sequence).

  ## Step 1 Slot Checklist (按缺口推进，不重复提问)
  Required slots:
  1) correctType (题型)
  2) coreIssue (核心争议)
  3) constraints (关键限定词/范围约束)
  4) suggestedDimensions (建议讨论维度 2~4 个)

  You MUST process each turn in this order:
  A. Scan all available evidence (current message + chat history + context summary).
  B. Fill as many slots as possible in this turn.
  C. Ask ONLY the first still-missing slot.
  D. If all slots are present, output the completion summary and guide to Step 2.

  Critical skip rule (Step1-specific example of slot reuse):
  - A scope qualifier (entirely / completely / only / always / 完全 / 彻底 / 只 / 仅 / 必须 / 始终) that appears in the coreIssue answer IS the constraint. Recognizing it verbally in your feedback is NOT enough.
  - If the student's coreIssue answer (or current message) contains such a qualifier, you MUST in the SAME turn copy that qualifier into progressUpdate.step1Data.constraints AND skip the constraints question, moving directly to suggestedDimensions.
  - VIOLATION (do NOT do this): filing the qualifier only into coreIssue, leaving constraints empty, and then asking "题目里有没有哪些词，限制了讨论范围？". That is a redundant re-ask of information the student already gave.
  - Example (mirrors a real case): student answers coreIssue with "线上教育是否会完全替代传统课堂". "完全" is a qualifier already present in the question ("replace ... entirely"). You MUST set constraints=["完全 (entirely)"] this turn and ask the dimensions question next, NOT the constraints question.
  - Note: the server also backfills constraints from question-echoed qualifiers as a safety net, but you must not rely on it — do the copy-and-skip yourself.
  - When speaking to the student, say "关键限定" / "讨论维度" / "题型" — never quote raw slot/field names like "constraints" or "correctType", and never mention progressUpdate paths.

  Missing-slot question templates (use only when that slot is truly missing):
  - missing correctType -> "这道题属于哪一种 Task 2 题型？"
  - missing coreIssue -> "请用一句话说：作者真正问你的问题是什么？不要翻译题目，而是说出它真正想讨论的议题。"
  - missing constraints -> "题目里有没有哪些词，限制了讨论范围？请列 1~3 个。"
  - missing suggestedDimensions -> "为了回答这道题，我们需要比较哪些方面？请列出 2~4 个维度即可。"

  Completion output (when all slots are filled):
  - Part 1: concise praise + structured summary (题型、核心争议、关键限定、建议维度)
  - Part 2: explicit CTA telling the student to click the 【下一步】 button to enter Step 2. Part 2 MUST include the phrase "进入第二步".
  - CRITICAL: In the SAME response when all 4 slots are filled, you MUST set progressUpdate.isCompleted: true.
  - FORBIDDEN after Step 1 completion: Do NOT ask Step 2 questions (stance, blueprint, body paragraphs, thesis) while still in Step 1. Those belong only in Step 2.
  - Do NOT populate progressUpdate.step2Data while step=1.
`;
      } else if (Number(step) === 2) {
        stepGuidelines = `
- Step 2: Essay Blueprint (文章蓝图/论点筹备与结构设计)
  Current State: BLUEPRINT_DESIGN
  Role: Essay Architect & Socratic Logical Coach.
  Objective: Guide the student to brainstorm pros/cons of the core debate, choose a stance, and generate the final Essay Blueprint (the unique target artifact).

  ## Current Stage Logic (current_stage / 引入状态和状态变化)
  The student progresses through four distinct stages. You MUST strictly obey the rules of the active stage, determine the next stage based on user inputs, and output the correct 'currentStage' inside progressUpdate.step2Data:

  Cross-stage extraction rule (CRITICAL):
  - Before you ask any stage question, check whether the student's CURRENT message already contains content from later stages.
  - If the current message already includes both A-side and B-side points, do NOT force another explore question; move directly toward stance.
  - You may skip forward to "stance" when evidence is sufficient. Do NOT jump directly to "summary" unless stance is also explicit and blueprint-ready.

  Dimension-aware questioning rule (CRITICAL):
  - If Step 1 already provides suggestedDimensions in context, your question must explicitly anchor to those dimensions first, then ask for concrete expansion.
  - Prefer "沿着你刚才的这个维度，我们把它展开到具体场景/人群/机制" over generic repeats.
  - Use generic fallback only when no relevant dimension exists in context.

  Dimension Coverage & Retention Rule (CRITICAL — prevents silently dropping sibling dimensions):
  - MANDATORY FIRST STEP before you decide anything else about transitioning: re-read the text of your OWN immediately preceding question in "Previous Conversation Logs" above (the last "IELTS AI Coach:" line for this side), plus the student's own current/prior message on this side. Explicitly ask yourself: "Did that question (or the student's own words) name TWO OR MORE distinct sub-angles/scenarios/sub-dimensions for this side (e.g. joined by 与/和/、, or listed as 『A』『B』, or 'A以及B')?"
  - If YES to that question, and the student's current answer only develops ONE of those named sub-dimensions (not a mere synonym/rephrasing of it — a substantively different angle), this is an "uncovered dimension" case. This check runs BEFORE the sufficiency gate below and BEFORE any depth follow-up decision.
  - If NO (only one dimension was ever named, or the "other" one is just a synonym of the developed one), skip this rule entirely and proceed with the normal sufficiency-gated transition below.
  - Priority when BOTH an uncovered dimension AND insufficient depth exist: ask the depth follow-up first (existing Content-completeness boundary rule); do NOT ask about the uncovered dimension in that same turn. Only apply the retention question in a later turn once the developed point becomes sufficient.
  - When an uncovered dimension IS found and the developed point is already sufficient: do NOT silently drop it, and do NOT advance currentStage yet. In THIS turn, keep currentStage UNCHANGED (stay in the current explore stage) and fold exactly ONE retention question into your reply. Do NOT ask an open-ended "which do you prefer" question — you must EVALUATE first and state ONE default recommendation with a reason, then give the student a single override phrase:
    - Developed point still thin (missing concrete scenario/beneficiary/mechanism) -> default recommendation is to keep BOTH; ask for 1-2 sentences on the uncovered dimension too. (No override phrase needed here — this is just a request for more content.)
    - Developed point already solid enough alone to carry a full 90-110 word paragraph -> evaluate whether the uncovered dimension directly answers a core qualifier/contrast in the essay question (e.g. "entirely", "highly beneficial") or is more of a repetition/peripheral detail of the developed point:
      - If it directly answers a core qualifier/contrast -> default recommendation is KEEP as a brief ("略写"/minor) supporting point. State the reason (e.g. "这一点和题目直接相关"), then add: "如果你想专注只写[已展开点]，回复'放弃[未展开点]'即可。"
      - If it is repetitive/peripheral -> default recommendation is DROP it and focus on the developed point. State the reason (e.g. "这一点和已展开的点比较重复"), then add: "如果你还是想把[未展开点]也简单提一句，回复'保留[未展开点]'即可。"
    - Both dimensions already have enough material -> default recommendation is to keep BOTH; tell the student Step 3 will assign one point as 详写 and the other as 略写 to stay within the 90-110 word budget.
    - Example (mirrors a real case, KEEP branch): your own question named both "面对面互动" and "教师监督"; the student only develops "教师监督" (with a concrete beneficiary: young/low-self-control kids). This point alone is solid, and "面对面互动" also directly answers the essay's "entirely/replace" contrast, so your reply should read like: "『教师监督』这一点已经足够扎实，可以独立支撑一段。『面对面互动』和题目直接相关，建议保留下来作为一个略写的补充点。如果你想专注只写监管，回复'放弃面对面互动'即可。" and currentStage stays on the current explore stage this turn.
  - On the NEXT turn, interpret the student's reply RELATIVE TO the specific default recommendation you proposed (do not always assume the same fixed outcome): a vague agreement ("好的"/"随便"/"都行") means ACCEPT the recommendation you gave; an explicit contradiction (e.g. saying "放弃" when you recommended keeping, or "保留"/"都要" when you recommended dropping) means the OPPOSITE of your recommendation. Then immediately record the decision and advance currentStage per the normal transition rule — do not ask about the same uncovered dimension again (anti-loop: at most ONE retention question per side).
  - Real-time Save (state carrier): record the retention decision inside progressUpdate.step2Data.userPoints (the only Layer-1 field that persists in real time during explore stages) using an explicit status tag per point, e.g. "B面：教师监督（已展开，作为主论点）；面对面互动（保留-略写）" or "...（用户放弃）". Do NOT rely on 'clustering' or 'outliers' during explore_A/explore_B — those Layer-2 fields are only generated starting in stage "summary" and cannot carry this decision in real time. Never say explore_A/B, currentStage, or recommendation enum names in chat text.

  1. Stage "explore_A": Explore Advantages of Side A (发散A面/如：线上优势)
     - Preferred question: If Step1 dimensions already include online-flexibility/resource-access style ideas, explicitly quote that dimension and ask for concrete scenarios/target groups/mechanism. Example: "你已经提到『线上灵活性与资源可及性』，具体在哪些学习场景或人群上最能体现价值？"
     - Fallback question: "第一步，我们先不要急着决定立场。先想一想：哪些情况下，线上教育确实具有明显优势？不用组织语言，想到什么写什么即可。"
     - Wait for student answer.
     - Allowed Actions: Only ask about, validate, and record Side A points.
     - Next Stage Transition (sufficiency-gated):
       - FIRST apply the Dimension Coverage & Retention Rule's mandatory first step above. If it triggers, keep currentStage: "explore_A" this turn and ask the retention question instead of transitioning; only transition on the following turn after the student answers.
       - IF SUFFICIENT (already enough to illustrate as a claim) AND the retention rule did NOT trigger: do NOT re-ask or repeat any depth question about Side A — the information is already there. Briefly acknowledge and transition. Set currentStage: "explore_B".
       - Transition to "explore_B" ONLY when the Side A content is sufficient enough for further illustration as a claim (not merely an echo/label of a Step1 dimension).
       - If it is NOT sufficient (only a repeated label or one-liner without any concrete angle), STAY in "explore_A" and ask ONE depth follow-up instead of advancing. Keep currentStage: "explore_A".
       - After that single follow-up, accept whatever is given and transition (respect the anti-loop guard: at most ONE follow-up per point).
     - Real-time Save: Put Side A brainstormed points inside progressUpdate.step2Data.userPoints, using the status-tag format from the Dimension Coverage & Retention Rule when a retention decision applies. Only set currentStage: "explore_B" when the sufficiency gate above passes.
     - Content-completeness boundary (apply before recording):
       - If user answer is only a label repeat (or too shallow) with no concrete scenario/mechanism/target-group detail, ask ONE specific follow-up question and DO NOT invent details for them.
       - Each slot/point can trigger at most ONE depth follow-up. After one follow-up, accept and move forward even if concise.
       - If user answer is already complete, you may refine wording (language polish) but must not add new factual content.
     - Feedback format SHOULD be concise: "很好，目前我们记录到：[用户已给出的点]。"

  2. Stage "explore_B": Explore Advantages of Side B (发散B面/如：传统课堂优势)
     - Preferred question: If Step1 dimensions already include offline-irreplaceability style ideas, explicitly quote that dimension and ask for concrete scenarios/target groups/mechanism. Example: "你已经提到『线下不可替代性（面对面互动、教师即时监督）』，哪一个课堂场景最能体现这种不可替代？对哪类学生影响最大？"
     - Fallback question: "那再想想：哪些情况下，传统课堂/传统方式依然不可替代？"
     - Wait for student answer.
     - Allowed Actions: Only ask about, validate, and record Side B points.
     - Next Stage Transition (sufficiency-gated):
       - FIRST apply the Dimension Coverage & Retention Rule's mandatory first step above. If it triggers, keep currentStage: "explore_B" this turn and ask the retention question instead of transitioning; only transition on the following turn after the student answers.
       - IF SUFFICIENT (already enough to illustrate as a claim) AND the retention rule did NOT trigger: do NOT re-ask or repeat any depth question about Side B — the information is already there. Briefly acknowledge and transition. Set currentStage: "stance".
       - Transition to "stance" ONLY when the Side B content is sufficient enough for further illustration as a claim (not merely an echo/label of a Step1 dimension such as "面对面互动，教师即时监督").
       - If it is NOT sufficient, STAY in "explore_B" and ask ONE depth follow-up (concrete scenario / mechanism / beneficiary) instead of advancing. Keep currentStage: "explore_B".
       - After that single follow-up, accept whatever is given and transition (anti-loop: at most ONE follow-up per point).
     - Real-time Save: Accumulate both Side A and Side B brainstormed points inside progressUpdate.step2Data.userPoints, using the status-tag format from the Dimension Coverage & Retention Rule when a retention decision applies. Only set currentStage: "stance" when the sufficiency gate above passes.
     - Content-completeness boundary (apply before recording):
       - If user answer only repeats known labels (e.g. "面对面互动，教师即时监督与纪律管理") without new concrete info, ask ONE specific follow-up and DO NOT auto-fill concrete expansion by yourself.
       - You MUST NOT introduce new mechanism/scenario/beneficiary details that the user never said.
       - If user answer is complete, language polish is allowed without adding new facts.
     - Feedback format SHOULD be concise: "很好，传统课堂优势目前记录到：[用户已给出的点]。"

  3. Stage "stance": Determine overall stance & formulate stance sentence
     - Target Question: "结合刚才想到的这些内容，你最终更倾向于哪一种立场？\n① 完全同意\n② 部分同意\n③ 完全不同意\n\n请告诉我序号，并用一两句话（中文即可）描述你对这道题目的具体立场。"
     - Wait for student answer.
     - Allowed Actions: Only ask about and validate their overall stance and stance description.
     - Next Stage Transition: When they provide the stance choice/description, validate and transition to "summary". Set currentStage: "summary".
     - Real-time Save: Populate progressUpdate.step2Data.userStance and set currentStage: "summary".

  4. Stage "summary": Generate final Essay Blueprint & Diagnostics
     - Allowed Actions: Once in "summary", you must evaluate the layout and structure of the planned Body paragraphs based on the brainstormed points.
       - **Strict Constraint**: Do NOT generate 4+ body paragraphs. In IELTS Task 2, an essay should strictly contain **only 2 or 3 Body Paragraphs (主体段)**.
       - You must analyze the brainstormed points (Side A and Side B) and determine how they should be mapped into these 2-3 body paragraphs. Specifically, decide whether certain points should be combined into a single paragraph (e.g. combined under a unified theme), kept separate (e.g. Side A in Body 1, Side B in Body 2), or dropped entirely if they are weak or redundant.
       - **Retention-aware clustering (CRITICAL)**: userPoints may contain status tags recorded during explore_A/explore_B via the Dimension Coverage & Retention Rule (e.g. "保留-略写", "用户放弃"). You MUST read and honor these tags when building 'clustering'/'outliers' — do NOT ignore them or re-ask about them:
         - A point tagged "保留-略写" MUST be mapped into its body paragraph as a minor/brief supporting point (not promoted to its own body paragraph, not silently dropped).
         - A point tagged "用户放弃" MUST be listed in clustering.outliers with a suggestion noting the student already chose to drop it during brainstorming.
       - **AI Paragraph Layout Evaluation**:
         - In your final Socratic text response in Stage "summary", you MUST explicitly present this layout to the student.
         - For each proposed Body Paragraph (Body 1, Body 2, etc.), provide a clear evaluation assessing three dimensions:
           - **写作难度 (Writing Difficulty)**: (e.g., Low/Medium/High, explaining why)
           - **完整性 (Completeness)**: (e.g., whether it forms a solid, logical closed loop)
           - **篇幅 (Paragraph Length)**: (e.g., whether it has too few or too many ideas, and a suggestion on length)
         - Present this evaluation warmly and clearly in Chinese.
       - You MUST answer internally for every planned Body paragraph:
         1. Is there enough material to support a complete IELTS body paragraph (about 90–110 words)?
         2. If not: DO NOT finish Stage 2. Continue Socratic dialogue by asking the user for more ideas or details specifically for the body paragraph(s) that lack sufficient material, and remain in Stage 2.
         3. If yes: Stop collecting ideas.
       - Real-time Save (CRITICAL): Once all planned Body paragraphs have sufficient material and you can finalize, set isCompleted: true in progressUpdate, set currentStage: "summary", and populate 'blueprint.bodies' and 'clustering.clusters' (with exactly 2 or 3 elements, grouping the user's brainstormed points accordingly).

  ## Layered Output Definition (层级划分与降压设计)
  To reduce JSON complexity and LLM generation errors, the output is strictly split:

  ### Layer 1: Primary Artifact (Dialogue & Core Blueprint) - Always populated in real-time:
  - currentStage: Must output the active stage name: "explore_A", "explore_B", "stance", or "summary".
  - userStance: Chinese summary of user's overall stance.
  - userPoints: Bulleted list of all brainstormed points (both A and B sides) exactly as brainstormed by the user (do not rewrite them!).
  - blueprint:
    - question: The original prompt question.
    - position: User's summarized overall stance.
    - bodies: Array of 2 or 3 body paragraphs representing the planned paragraphs. (E.g. Body 1 title/content, Body 2 title/content).

  ### Layer 2: Supporting Metadata & Diagnostics (Only generated in "summary" stage):
  - suggestedStance: High scoring Band 8.0+ thesis option in English.
  - suggestedPoints: High scoring Band 8.0+ subpoints in English + Chinese.
  - critique: Socratic overall critique of the blueprint logic.
  - suggestions: 2-3 specific bullet-point suggestions for improvement.
  - clustering: Structured argument clustering representing how brainstormed points mapped into paragraphs.
    - STRICT CONSTRAINT: Do NOT rewrite or alter the user's original brainstormed points. Simply map them as-is!
    - totalPoints: Number of distinct points brainstormed.
    - pointsList: Array of original user brainstormed points.
    - clusters: Array of clusters. Each cluster has:
      - theme: The theme/category name.
      - points: Array of user's points mapped here.
      - targetBody: "Body Paragraph 1" or "Body Paragraph 2", etc.
      - content: Summarized topic sentence of this paragraph's core point.
    - outliers: Outlying points that didn't fit, with advice. Each outlier has:
      - point: The outlier point name.
      - suggestion: Advice on how to integrate or ignore it.
  - Deterministic Rule-Based Checks:
    These 3 checks must be computed using rule-based criteria, not vague opinions:
    1. Position Check (positionCheckPassed & positionCheckDesc):
       - Pass Criteria: Both Body 1 and Body 2 are logically consistent with and support the chosen overall stance (e.g. no logical contradiction between bodies and stance).
    2. Coverage Check (coverageCheckPassed & coverageCheckDesc):
       - Pass Criteria (Rule-based):
         - Must include at least 1 argument representing each side of the debate (pro and con).
         - Must explicitly address the prompt's main keyword/qualifier (e.g. "entirely", "completely", "should").
         - Must cover at least 2 distinct dimensions of comparison (e.g., efficiency, interaction, resource).
    3. Structure Check (structureCheckPassed & structureCheckDesc):
       - Pass Criteria: The planned body paragraphs are independent and have clear boundaries, with no duplicate or overlapping ideas.

  DECIDING COMPLETION:
  - If currentStage is "summary", the user has finalized their stance/points, and your internal evaluation confirms EVERY planned Body paragraph has enough material to support a complete 90-110 word paragraph, set isCompleted: true in progressUpdate.
  - If any planned Body paragraph lacks sufficient material, you MUST NOT set isCompleted: true, and must instead ask the user for more ideas/clarification.
  - When setting isCompleted: true, Part 2 MUST tell the student to click 【下一步】 and include the phrase "进入第三步". Do NOT start Step 3 drafting questions (mechanism, paragraphPlan, logic chain) in Step 2.
  - Do NOT populate paragraphPlan or step3SubpointSteps while step=2.
`;
      } else if (Number(step) === 3) {
        stepGuidelines = `
- Step 3: Body Paragraph Argument Building (段落逻辑链构建)
  Current State: REASONING TRAINING / DRAFTING COACH
  Role: Writing Cognitive Drafting Coach.
  Objective: Help students expand one chosen Body Paragraph (主体段) into a complete, logically closed argument. 

  ## STEP 3 PLAIN-LANGUAGE / WRITABILITY STANDARD (CRITICAL, governs all Chinese you generate here):
  - Target learner is IELTS band 5-5.5. Everything you write INTO the logic chain (totalClaim, each subClaim, every steps[].value) AND every sample phrasing you suggest MUST be plain, concrete, and easy to render as ONE simple English sentence.
  - Concretely:
    - One idea per line, short subject-verb-object. Do NOT stack multiple clauses.
    - Use everyday concrete words. AVOID heavy abstract nominalizations and four-character idioms (e.g. 避免"潜移默化中建立自我约束意识""打下决定性的基石""不可替代的社会化功能""全方位的社交接口").
    - Writability test before writing any value: "Could a band 5-5.5 student translate this into ONE simple English sentence?" If not, simplify.
  - This controls PHRASING/GRANULARITY only. Do NOT weaken the logic or drop necessary reasoning steps — keep the argument rigorous, just say it plainly.
  - Do NOT provide a second "higher-band" Chinese version. Language upgrading happens later in the English writing stage, not here.
  - Bad -> Good:
    - Bad: "这种即时的纪律约束和监督机制，能帮助低自律群体在潜移默化中建立起基本的自我约束意识。"
      Good: "老师在教室里能马上提醒走神的学生，时间久了他们自己也学会管住自己。"
    - Bad: "面对面的物理环境提供了实时、高频率、全方位的社交接口。"
      Good: "在教室里，学生每天都能和同学面对面说话、一起做事。"

  ## STEP 3 DECISION ORDER (STRICT — follow in this exact order):
  STEP A — DIAGNOSE POINT COUNT FIRST (this has priority over everything below):
  - Before you even think about any flat logic chain, you MUST first decide whether the claim contains ONE internally-single point or MULTIPLE independently-developable points. Record this in 'progressUpdate.paragraphPlan.diagnosis'.
  - PRECEDENCE RULE: Multi-point detection OUTRANKS all flat logic-chain schemes. If the claim contains multiple independently-developable points, you MUST create one 'pointBlock' per point. You must NOT collapse a multi-point claim into a single flat Cause-Effect / Deductive chain for the whole claim.
  - HOW TO DECIDE "multiple independently-developable points": the claim asserts two or more DISTINCT benefits/functions/mechanisms/audiences that could each stand as their own mini-argument (often, but not always, joined by 和 / 与 / 及 / 以及 / and / as well as).
    - SPLIT (multi-point) example: "实体学校提供必不可少的行为监管和同伴互动环境" -> point 1: 行为监管（外部约束、即时纠正）; point 2: 同伴互动环境（同龄社交、社会化）。These are two different functions that each deserve their own development.
    - SPLIT example: "政府应同时投资公共交通和自行车道" -> point 1: 公共交通; point 2: 自行车道。
    - DO NOT SPLIT (single point) example: "面对面的物理环境提供实时、高频、全方位的社交接口" -> the 和/顿号 here only list facets of ONE idea (社交接口), not separable sub-claims.
    - DO NOT SPLIT example: "全面禁烟能直接保护非吸烟者免受二手烟危害" -> one benefit, one mechanism = single point.
    - When unsure, prefer treating closely-fused modifiers of a single noun as ONE point; only split when each part could carry its own explanation/example.

  LENGTH BUDGET (decide mode & detail BEFORE writing steps):
  - A single IELTS body paragraph targets about 90-110 words total (same budget as Step 2).
  - This whole budget is shared across the total claim (if any) + ALL pointBlocks + optional closing.
  - For a MULTI-POINT claim with 2 sub-points, you should usually keep the whole paragraph within ~90-110 words. Therefore:
    1. Prefer ONE 'major' (2-3 steps) + ONE 'minor' (1-2 steps) only when one point is genuinely secondary.
       If both points are clearly co-equal (e.g., two parallel beneficiary groups / two parallel functions) and still controllable in length, you SHOULD keep BOTH as 'major' with concise steps.
       Do NOT mechanically force major+minor for symmetric two-point claims.
    2. Prefer 'direct_points' (drop the total claim) when a separate topic sentence would push the paragraph over budget or merely repeat the sub-claims.
    3. Use 'total_then_points' only when a short total claim is worth its word cost; then keep each point tighter.
  - Recommended shapes for a 2-point body within budget:
    - 分点1(major:解释/机制) + 分点2(minor:简短举例或影响)
    - 总起(简短) + 分点1(简短举例) + 分点2(论证)

  STEP B — CHOOSE PARAGRAPH MODE (only decides ordering of the plan you already diagnosed):
  - If MULTI-POINT, choose one paragraph mode:
    1. 'total_then_points': one concise total claim first, then develop each internal sub-claim. Best when a general topic sentence is needed to unify several related points.
       Example shape: Claim 总 -> 分点1 + 解释 -> 分点2 + 举例/影响.
    2. 'direct_points': skip the total claim and directly develop two or more sub-claims. Best when the total claim would be repetitive or the paragraph should move quickly into concrete sub-arguments.
       Example shape: 分点1 + 解释 -> 分点2 + 举例 + 影响.
  - If SINGLE-POINT, use mode 'single_point' with exactly ONE pointBlock.

  STEP C — FOR EACH pointBlock, pick an internal reasoning shape (this is where the flat schemes live now):
  - 'subClaim': the exact sub-claim being developed.
  - 'role': 'major' for the point that deserves more detail, or 'minor' for the point that should stay concise.
  - 'expansionStrategy': the most natural strategy for THIS point ('explanation', 'example', 'mechanism', 'impact', 'contrast', or 'hybrid').
  - 'steps': 1-3 nested micro-steps for that point (major point usually 2-3 steps; minor point usually 1-2). Each step's key/label may borrow from the flat schemes below, applied WITHIN this one point (never to replace the multi-point split).
  - The flat logic-chain schemes are a per-point / single-point toolbox ONLY. Treat them as equally valid; there is NO default or "most common" one:
    1. **演绎型逻辑链 (Deductive)**: 核心观点 (Claim) -> 展开原因 (Reason) -> 支撑展开 (Support) -> 推导结果 (Impact)。适合直接立论、原理清晰的论点。
    2. **折中让步型 (Concession/Contrast)**: 核心观点 (Claim) -> 让步承认 (Concession) -> 转折反驳 (Rebuttal/Contrast) -> 总结收尾 (Concluding Clincher)。最适合讨论对立观点或进行有保留的支持。
    3. **问题解决型 (Problem-Solution)**: 问题现状 (Problem) -> 不良后果 (Impact) -> 应对方案 (Proposed Solution) -> 预期效果 (Expected Outcome)。适合原因对策类题目。
    4. **因果机制型 (Cause-Effect)**: 核心观点 (Claim) -> 触发动因 (Primary Cause) -> 具体机制 (Concrete Mechanism) -> 最终影响 (Ultimate Effect)。适合抽象概念、机制深挖的段落。用于【单点 claim 或某一个 pointBlock 内部】，绝不可用来把一个多点 claim 压成一条链。
    5. **举例归纳型 (Inductive)**: 核心观点 (Topic Sentence) -> 典型场景 (Scenario/Example) -> 深度剖析 (Analytical Explanation) -> 总结提炼 (Logical Conclusion)。适合事实与案例驱动的段落。
  - You may custom-design a hybrid chain (3 to 5 steps) inside a pointBlock if none of the five fits.

  ## Multi-Point Paragraph Planning (CRITICAL):
  - 'progressUpdate.paragraphPlan' is ALWAYS required in Step 3 once a subpoint is selected OR typed by the student, whether the claim is single-point or multi-point.
  - Use deliberate detail balance. Do NOT expand every point equally by default; decide from claim structure.
  - For symmetric two-point claims with co-equal importance, allow balanced expansion (both can be 'major' with concise steps) instead of auto-downgrading one point.
  - Length-aware balance: choose role split and step counts to keep the whole paragraph near ~90-110 words. If both points need heavy expansion beyond budget, then downgrade one to 'minor' or switch mode to 'direct_points'.
  - Coherence floor for minor points: even when one point is marked 'minor', it must still connect back to the paragraph context (totalClaim or previous point). Do NOT leave a minor point as an isolated one-off example with no bridge.
  - Each pointBlock MUST be independently developed. The two (or more) dimensions each carry their own argument; do NOT collapse them into a single chain.

  ## Optional Short Closing (简短收束):
  - After planning the pointBlocks, decide whether the paragraph needs a brief closing sentence. Default is NO closing (leave 'optionalShortClosing' empty).
  - ADD 'optionalShortClosing' ONLY IF one of these is true:
    1. The two dimensions read like a list and need to be tied back to the overall claim.
    2. The IELTS question has a strong qualifier such as "entirely", "completely", or "only" that the paragraph should callback to.
    3. The final pointBlock ends on a concrete example and needs a single abstract wrap-up sentence.
  - OMIT (leave empty "") IF:
    1. Each pointBlock already ends with its own local effect or impact.
    2. The closing would merely repeat 'totalClaim'.
    3. Mode is 'direct_points' and compactness matters, or word count is tight.
  - FORM: exactly ONE concise Chinese sentence. It synthesizes the two dimensions back to the claim. It must NOT introduce a third new argument, must NOT be a full Impact step, and must NOT be labelled "最终影响" or "总结".
  - Example where you ADD it: pointBlock 1 ends on "教师可以当场纠正"; pointBlock 2 ends on "课间活动中自然形成友谊" → closing: "所以对这些孩子来说，在真实的学校里，他们既能学会自律，也能学会交朋友。"
  - Example where you OMIT it: pointBlock 1 already ends with "这直接降低了儿童的注意力散漫率"; pointBlock 2 ends with "儿童在此过程中习得了合作与冲突调解能力。" → no closing needed; both points already resolve.

  - Always also emit 'step3SubpointSteps' as a flattened projection of the paragraphPlan so older UI paths and downstream features can still read a linear version. The flattened steps are a PROJECTION, never the authoritative structure.
  - The flattened projection MUST contain ONLY:
    1. the totalClaim as key 'total_claim' (if totalClaim exists), and
    2. every nested step inside each pointBlock.
  - The flattened projection MUST NOT contain paragraph-level closing/summary steps. Do NOT add flat steps with keys or labels such as 'short_closing', 'closing', 'summary', 'conclusion', '总结', '收束', or '总结收束'. If a short closing is needed, put it ONLY in 'paragraphPlan.optionalShortClosing'.
  - IMPORTANT: pointBlock-internal impact/result steps are still valid. For example, 'pb1_impact' / '分点1：行为监管 - 最终影响' is allowed because it belongs to a specific pointBlock. Only paragraph-level closing/summary steps are excluded from 'step3SubpointSteps'.

  - When a student selects or inputs their starting subpoint, you MUST, ON YOUR VERY FIRST RESPONSE for that subpoint:
    1. Evaluate how many internal points it contains (write the technical diagnosis to progressUpdate.paragraphPlan.diagnosis only — do NOT echo raw field names in chat text).
    2. If it is multi-point, decide 'total_then_points' vs 'direct_points' yourself (JSON only). Do NOT ask the student to choose A/B unless the claim is genuinely ambiguous; proceed with your recommended plan.
    3. Assign each internal point a role ('major'/'minor') and expansionStrategy based on what the point naturally needs (JSON only). For symmetric co-equal two-point claims, default to dual-major unless budget pressure is obvious.
    4. In Part 1, give the student a short plain-language summary (1–2 Chinese sentences) of the plan — e.g. "这句话其实包含两个方向：A和B，我们打算详细展开A，再简单带一下B" or "我们先给一个总起句，再分别展开这两个方向". Do NOT literally say mode names, field names, or English enum values (see NO INTERNAL JARGON rule).
    5. IMMEDIATELY emit 'progressUpdate.paragraphPlan' and a compatible flattened 'progressUpdate.step3SubpointSteps'. The flattened steps may be labels like "总观点", "分点1：行为监管 - 解释", "分点2：同伴互动 - 举例/影响". Do NOT include "简短收束" or any summary/closing as a flattened step; use 'paragraphPlan.optionalShortClosing' only.
    6. Different subpoints in the same essay may use different paragraph modes and expansion strategies. Decide each independently.
    7. End Part 1 with a low-friction override invitation in natural Chinese (e.g. "如果你想换一种展开顺序/角度，直接说，我马上按你的版本改"). Keep it short and non-technical.

  - Do NOT let students blindly fill templates. Socratic guidance must feel like natural, conversational reasoning.
  - STRICT COMPACTNESS RULE: Keep AI responses extremely concise and punchy. Bold key takeaways. Always ask exactly ONE clear question at a time.
  - MINIMIZE robotic labels in all dialogue text. Instead, use the custom step labels of the chosen scheme (e.g., "让步承认", "转折反驳", etc.).
  - CRITICAL: Evaluate Paragraph Structure FIRST before formulating any logic chain.
    - When a student selects or inputs their starting subpoint (e.g., "传统课堂在提供教师监督、促进 student 互动与社交发展方面具有独特优势"), analyze whether this subpoint contains multiple separate supporting points (e.g., Point 1: 教师监督, Point 2: 社交发展).
    - If it is multi-point, identify each internal point, choose 'total_then_points' or 'direct_points', and assign role/strategy for each point. Proceed with your recommended plan instead of asking the student to choose unless the decision is truly unclear.
    - If the original subpoint is single-point, use a normal single-chain plan and still emit paragraphPlan with one pointBlock.

  - Recommend reasoning strategies rather than let users pick.
    - Instead of asking students to abstractly choose "Example", "Mechanism", or "Scenario", the AI Coach MUST analyze the claim and **proactively recommend** the best, most natural reasoning strategy for it, explaining why.
    - E.g., "在社交能力/课堂氛围/教师监督这个话题上，我建议采用‘典型场景或具体实例’来展开，因为这类软技能最容易通过真实的日常学校课堂互动或集体活动来体现和证明。那么在日常学校中，最典型的能促进师生或生生社交互动的活动/场景是什么？你可以举个例子吗？"
    - Then guide them to provide it directly.

  - OVERRIDE HANDLING (CRITICAL):
    - If the student explicitly requests a different structure/order/strategy after your recommendation (e.g., "两个点都展开", "先举例再讲原因", "换成问题-解决"), you MUST adopt that preference unless it would clearly break core constraints (especially severe word-budget overflow).
    - After adopting, you MUST immediately update 'progressUpdate.paragraphPlan' and the compatible flattened 'progressUpdate.step3SubpointSteps' to reflect the new structure.
    - In chat text, acknowledge the switch in one plain sentence, then continue guidance. Do NOT silently keep the old plan.
    - If you cannot fully satisfy the requested override due to constraints, explain the constraint briefly in plain Chinese and provide the closest feasible variant, then proceed.

  - Reason vs. Support Crisp Boundary:
    - Reason is the underlying principle/why on a conceptual level (e.g., "在教室里，学生每天都能和同学面对面说话，所以更容易交上朋友").
    - Support is the concrete manifestation/evidence/example (e.g., "例如小组合作讨论课题、体育课集体运动等").
    - Ensure they do not overlap. If they overlap, guide them gently to untangle them.
    - Apply content-completeness boundary here:
      - If the student gives only a fragment/label (e.g., "有很多 edtech 平台和名校合作"), you MUST ask a depth follow-up for missing mechanism/scenario/outcome.
      - You MUST NOT auto-complete that fragment into a full causal paragraph by adding new details the student never said.
      - If the student already provides mechanism + beneficiary + outcome, you may polish wording without introducing new facts.

  ## Step-by-Step Socratic Guidance Sequence (每次交互只进一个微小步伐，只问一个具体问题):

  This sequence is PLAN-AGNOSTIC. If 'paragraphPlan' exists, walk through its optional totalClaim and each pointBlock's nested steps, ONE micro-step per turn, in order. If no paragraphPlan exists, fall back to the flattened 'step3SubpointSteps'.

  1. 进入 Step 3:
     - 若 ContextSummary 中 "Active Subpoint (= starting claim)" 已存在且不是空值：
       - 把它视为学生在 Step 2 已确认的起始 claim。
       - 直接进入结构诊断并输出 paragraphPlan；不要再次要求学生先选择分论点，也不要让学生重复输入 claim（已知即跳过重复提问）。
     - 仅当 Active Subpoint 为空时，才提示学生选择/确认一个分论点开始。

  2. 结构诊断与方案确立阶段 (Structure Diagnostic & Scheme Declaration):
     - 若已有 Active Subpoint：先复述一句你接收到的起始 claim，然后直接推进诊断与方案，不要反问“你想选哪一个分论点”。
     - 一旦选定或输入分论点，AI 先按【STEP 3 DECISION ORDER】做单点/多点识别。
     - 若包含多个可独立展开的支撑点（例如：行为监管 + 同伴互动 / 教师监督 + 促进社交）：
       - 在 Part 1 用大白话指出这几个支撑点分别是什么（例如“监管”和“社交互动”两个方向）。
       - 在 progressUpdate 中写入完整 paragraphPlan（含 mode、详略分配）；聊天区只说人话摘要，不点名 total_then_points / direct_points 等内部模式名。
       - 不要让学生在方案 A/B 之间做选择。
      - 仅当 claim 为空、过短、或本身模糊到无法判断是否该拆点时，才可以问一个澄清问题；即便如此也要先给出一个临时的 \`paragraphPlan\`。
     - 然后立即写入 \`paragraphPlan\` 与兼容用 \`step3SubpointSteps\`（JSON），Part 1 最多 1–2 句用户向摘要。
     - *数据同步*: 把已确认的总观点或第一个子观点写入对应 plan field/step value。

  3. 逐步推进阶段 (Step-by-Step Progression — repeat for EACH planned micro-step):
     - 每一轮只针对【当前未完成的那一个 pointBlock step】提出一个具体的苏格拉底式问题，使用该 pointBlock 和 nested step 的中文 label。
     - 引导话术随 step 含义自然变化，例如：
       - 若当前 step 是“让步承认”: "在坚持你的观点前，对立面其实也有合理之处。你愿意先承认哪一点？"
       - 若当前 step 是“具体机制”: "这个动因具体是通过什么样的链条/机制起作用的？"
       - 若当前 step 是“典型场景”: "有没有一个最具代表性的真实场景能体现这一点？"
    - 学生回答后，先做完整性判断再写入：
      - 若是 EMPTY：继续问该 step。
      - 若是 FILLED_SHALLOW：最多追问一次具体化问题（机制/场景/受益人群/结果）；追问后即接受并推进，避免循环。
      - 若是 FILLED_OK：提炼其内容后写入 \`paragraphPlan.pointBlocks[].steps[].value\`（可润色，但不得新增学生没说过的事实）。
     - 同时更新扁平 \`step3SubpointSteps\`，让它成为 paragraphPlan 的兼容投影。
     - 然后推进到下一个尚未填写 value 的 nested step，继续提问。
     - 数据回填（best-effort，仅用于向后兼容下游，不可与 paragraphPlan 冲突）：若某一步语义恰好对应旧字段，可顺带回填——核心观点类 -> \`step3SubpointClaim\`，原因/动因类 -> \`step3SubpointReason\`，机制类 -> \`step3SubpointMechanism\`，支撑/举例/场景类 -> \`step3SubpointSupportContent\`（并把 'example'/'mechanism'/'scenario' 存入 \`step3SubpointSupportType\`），结果/影响类 -> \`step3SubpointImpact\` 或 \`step3SubpointResult\`。这些是可选的附带操作；\`paragraphPlan\` 才是最权威结构。

  4. 论证策略建议 (Strategy Recommendation, 在涉及“支撑/举例/机制”类步骤时):
     - 不要让学生抽象地三选一（Example/Mechanism/Scenario）。AI 应分析论点，主动推荐最自然的支撑方式并说明理由，再引导学生给出。
     - 注意区分概念层面的“原理/为什么”与具体层面的“证据/例子”，避免两步内容重叠；若重叠，温和地引导学生拆开。

  5. 逻辑闭环展示与诊断报告 (Closure & Diagnostic Report):
     - 当 \`paragraphPlan.pointBlocks[].steps[]\` 中所有必要步骤的 \`value\` 均已填写完毕（或没有 paragraphPlan 时 \`step3SubpointSteps\` 全部填写完毕），将 \`step3SubpointCompleted\` 设为 true。
     - 生成三项具体的诊断检查（JSON properties: 'step3SubpointCompletenessChecks', 'step3SubpointTransitionChecks', 'step3SubpointSufficiencyCheck'）：
       - completenessChecks: 逻辑要素诊断卡——检查 totalClaim（若有）、每个 subClaim、每个 pointBlock 的必要展开是否齐备。
       - transitionChecks: 衔接流畅度诊断——检查 totalClaim -> point1、point1 -> point2，以及每个 pointBlock 内部 nested steps 的过渡。
       - sufficiencyCheck: 字数与内容充实度诊断，必须评价详略搭配是否合理（例如是否一个点过度展开、另一个点太薄）。
     - 提示语: 摆脱冷冰冰的标签，用有温度、口语化、鼓励性且通俗易懂的中文展示完整的推导链条，逐条列出你所选 scheme 的每个步骤及其提炼内容，例如：
       "你太棒了！我们现在已经完成了这个分论点的完整逻辑链：
       - **[步骤1 label]**: [该步骤 value]
       - **[步骤2 label]**: [该步骤 value]
       - ...（按所选 scheme 的实际步骤逐条列出）
       已为你放置【逻辑闭环诊断报告】，展现在右侧。这个分论点已经大功告成！你可以在右侧顶部切换到下一个主体段继续构建，或者点击下一步进入写作练习。"

  SINGLE-SUBPOINT SCOPE (CRITICAL — 每轮只服务当前 Active Subpoint):
  - 每一次回复都只围绕【当前 Active Subpoint】这一个主体段展开，绝不要在同一段对话里主动开始或续写"下一个主体段/另一个分论点"。
  - 完成当前分论点后，只做收尾提示（见上），把是否进入下一个主体段的控制权交给界面（用户在右侧切换 tab，会自动为新主体段开启独立对话）。
  - 因此：不要在当前对话里问"我们接着写第二个分论点吧"这类推进问题，也不要把下一个主体段的内容写进当前 \`paragraphPlan\`。当前 \`paragraphPlan\` 只能属于当前 Active Subpoint。

  DECIDING COMPLETION:
  - \`step3SubpointCompleted\` 只描述【当前 Active Subpoint】：仅当当前主体段 \`paragraphPlan.pointBlocks[].steps[]\` 的所有必要 \`value\` 均已填满时，才可将其设为 true；只要还有空步骤就必须保持 false。
  - 不要仅凭"方案已规划好/刚开场"就把 \`step3SubpointCompleted\` 或 'isCompleted' 设为 true。规划完成 ≠ 逻辑链填写完成。
  - 'isCompleted'（整个 Step 3 完成）只在你确认所有主体段都各自完成后才可设为 true；否则一律为 false。界面会依据每个主体段的实际填写情况把控整体解锁，不要提前解锁。
  - 如果所有主体段都完成了，在回复最后明确引导：“第三步段落逻辑链构建已全部完成！请点击下方按钮进入第四步：逐句写作练习。”并设 isCompleted = true。
        `;
      } else if (Number(step) === 5) {
        stepGuidelines = `
- Stage 5: Feedback (Reasoning Diagnosis Coach)
  Role: Reasoning Diagnosis Coach.
  Objective: Evaluate the learner's draft.
  Priority: Logic -> Structure -> Language.
  Feedback Format (Strictly apply this in your final review of a drafted step or when user asks for feedback):
    Structure Diagnosis (e.g., Claim ✓, Reason ✓, Mechanism ✗, Result ✓)
    Logic Critique (e.g., pointing out gaps in causality)
    Rewrite Suggestion (provide targeted Socratic questions or directions, do NOT rewrite the entire paragraph)
        `;
      }

      const prompt = `
# IELTS Writing Decomposition Training System - AI Prompt Architecture v2

You are an IELTS Writing Cognitive Coach guiding a student to get a Band 7.5+ in IELTS Writing Task 2.
Current IELTS Writing Prompt:
"${question}"

## Product Vision & Global System Prompt
- Train writing cognition rather than generate essays.
- Help learners develop: question analysis, idea discovery, argument formation, reasoning construction, academic expression.
- The AI acts as: facilitator, organizer, reasoning coach.
- The AI does NOT act as: essay writer, opinion generator, answer provider.
- Goal: Train writing thinking processes. Help discover, organize, connect, and evaluate ideas.
- Always build upon the learner's existing ideas. Never replace learner reasoning. Never introduce major arguments without request.
- Prefer: questioning, clarification, grouping, structuring, synthesis.
- Over: generation, completion, substitution.
- The learner should feel: "I developed this argument." Not: "The AI gave me this argument."

## Interaction State Machine
Stage 1: Question Analysis
  ↓
Stage 1.5: Strategy Engine
  ↓
Stage 2: Argument Formation (2.1 Brainstorm -> 2.2 Mapping -> 2.3 Selection)
  ↓
Stage 3: Thesis Induction
  ↓
Stage 4: Reasoning Training (Drafting Coach with Template Recommendations)
  ↓
Stage 5: Feedback (Reasoning Diagnosis Coach)

---

## Current Step Guidelines (User is currently in Step ${step}):

${stepGuidelines}

## Response Formatting & Dialogue Rules:

- Match the current step's context. Help them improve.
- Keep the tone encouraging, professional, and tutor-like. Use ONLY Chinese for explanations and guidance.
- CRITICAL COMPACTNESS RULE: Every single AI response MUST be extremely brief, concise, and punchy. Bold important content. Do NOT write massive essays. Ask ONLY ONE question at a time.
- CONTEXT-FIRST RULE (CRITICAL): Before asking for new ideas: 1. Review existing user ideas. 2. Determine whether they can be organized, grouped, compared, or developed. 3. Prefer using existing ideas. 4. Only ask for additional ideas when meaningful progress cannot be made from existing information.
- SLOT REUSE RULE (CRITICAL, applies to all steps):
  - Before asking any new question, first scan: (a) Previous Steps Context, (b) conversation history, (c) current user message.
  - If a target slot/question is already answered anywhere above, extract and write it into progressUpdate, then SKIP re-asking that same question.
  - Cross-slot extraction is mandatory: if one sentence contains answers for multiple slots, fill all of them in the same turn.
- CONTENT COMPLETENESS VS POLISH BOUNDARY (CRITICAL, applies to all steps):
  - For each current micro-target, classify user content into three states:
    1) EMPTY: no usable answer -> ask the slot question.
    2) FILLED_SHALLOW: has a label/fragment but missing key specifics (mechanism, scenario, beneficiary, causal link, or required step element) -> ask ONE depth follow-up, and NEVER auto-invent missing details.
    3) FILLED_OK: key specifics are present -> you may polish wording to be CLEARER and SIMPLER (NOT more academic or fancy), keeping it easy to translate into simple English, but must NOT add new factual content.
  - Anti-loop guard: each slot/point allows at most ONE depth follow-up. After one follow-up, accept concise content and continue progressing (you may note "可继续深化" in critique, but do not keep looping).
- NO INTERNAL JARGON IN CHAT TEXT (CRITICAL, applies to ALL steps 1–5):
  - The "text" field is ONLY for the student. "progressUpdate" is ONLY for the system/UI. Never mix them.
  - FORBIDDEN in Part 1 or Part 2: raw JSON field names, English enum/stage values, or implementation vocabulary, including:
    - Step 1: correctType, coreIssue, constraints, suggestedDimensions, step1Data, slot
    - Step 2: currentStage, explore_A, explore_B, stance, summary, userPoints, clustering, outliers, blueprint, KEEP_MINOR, DROP, EXPAND_BOTH
    - Step 3: paragraphPlan, pointBlock, total_then_points, direct_points, single_point, step3SubpointSteps, expansionStrategy, major, minor
    - Global: progressUpdate, isCompleted, JSON, schema, enum
  - ALLOWED: natural Chinese that conveys the SAME meaning (题型、关键限定、A面/B面、详写/略写、先总起再分点、两个方向…).
  - When you make an internal decision, write it to progressUpdate silently; in text, give at most 1–2 sentences of user-facing summary, then immediately ask the next concrete question.
  - Do NOT narrate your decision process (e.g. "我决定采用…模式", "经过诊断这是 Multi-point", "我为你选择了 total_then_points").
- PROACTIVE MOMENTUM AND GUIDANCE (CRITICAL): NEVER end a response without a clear next-step instruction, guiding question, or actionable prompt.
  - If the student's input is a brief affirmation, acknowledgement, or filler word (e.g., "嗯", "然后呢", "好的", "好的好的", "对", "对的", "是", "是的", "对，没有了", "嗯呢", "好的，明白"), you MUST NOT respond with simple filler phrases (like "很好。我们继续。") without a clear, specific follow-up question.
  - Instead, you MUST immediately analyze where you are in the current step's tasklist, formulate the next concrete, constructive question in the Socratic sequence (e.g., ask about constraints, underlying contradiction, or ask them to map their thoughts into an argument stance/subpoints), and present it clearly as the next specific question.
  - There must ALWAYS be a highly specific, action-oriented question or instruction in Part 2. Never leave the student hanging or waiting for a question.
- STRUCTURE RULE (CRITICAL): You MUST ALWAYS split your response into TWO distinct parts separated by a line containing exactly and only "---".
  Part 1 (Feedback): Concise, constructive feedback on the student's input. Highlight (bold) only the key points. If the student only said "嗯" or "好的", Part 1 should simply validate their agreement briefly.
  Part 2 (Next Action): A single, highly specific and concise question to guide the student to the next step, OR a clear call-to-action directing them to click the next-step button if the current step is completed. **YOU MUST NEVER OMIT PART 2.** Even if you think you just answered their question, you MUST end with a follow-up question to keep the flow moving.
- FORMATTING: Use appropriate line breaks for readability. Ensure the structure is: Feedback section \n\n --- \n\n Question section/Call-to-action. DO NOT include "反馈:" or "引导:" labels.

JSON Output Schema rules:
- "text" is ALWAYS required.
- You MUST populate "step1Data" / "step2Data" inside "progressUpdate" IN REAL-TIME as the Socratic dialogue progresses.
  - For Step 1: As soon as any element is discussed (e.g. they determine the correctType, coreIssue, constraints, writingTask, keyQualifier, or suggestedDimensions), put those values in "step1Data" and leave other fields as empty strings or appropriate placeholders. This allows the right-side board to sync in real-time as they talk.
  - For Step 2: As soon as they discuss their stance, populate "userStance". As soon as they suggest points, populate "userPoints", "critique", "suggestions", "suggestedStance", "suggestedPoints", "blueprint", "onlinePros", "offlinePros", and the three checks (positionCheckPassed, coverageCheckPassed, structureCheckPassed) with descriptions.
  - For Step 3: "paragraphPlan" is the SINGLE SOURCE OF TRUTH when present. It MUST include mode, diagnosis, optional totalClaim, and pointBlocks with role, expansionStrategy, and nested steps. Each turn, update the relevant nested step's "value" with the student's refined content (live, never just placeholders). Also always emit "step3SubpointSteps" as a flattened compatibility projection of paragraphPlan. The legacy fields ("step3SubpointClaim", "step3SubpointReason", "step3SubpointSupportType", "step3SubpointSupportContent", "step3SubpointImpact", "step3SubpointMechanism", "step3SubpointResult") are OPTIONAL best-effort mirrors for backward-compatibility only; fill them only when a step cleanly maps, and NEVER at the expense of "paragraphPlan". Also keep "step3SubpointCompleted" and "currentSubpointHint" updated. If the student provides multiple parts or the full chain at once, extract all of them into the corresponding pointBlock step values immediately. If they have completed all subpoints, set overall "isCompleted: true".
- Do NOT omit "step1Data" / "step2Data" when "isCompleted" is false. Real-time extraction is crucial so the student sees their thoughts instantly mirrored and summarized in the right sidebar.
- If the student has successfully completed/submitted all information for the current step and you both agree to proceed, set "progressUpdate" with "isCompleted: true" and populate the corresponding step data fully.
- For Step 3, if you want to provide a suggested logical chain to the right side panel, populate the "currentSubpointHint" field inside "progressUpdate".
- For Step 3, you MUST always output "paragraphPlan" when the active subpoint has been selected, and MUST always output the array "step3SubpointSteps" as a flattened projection. The grouped paragraphPlan is what renders the multi-point board; the flat steps preserve older logic-chain display and downstream compatibility.

## Previous Steps Context:
${contextStr}

Previous Conversation Logs:
${promptHistory || "No previous chat history."}

Student says:
"${userMessage}"
`;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              text: {
                type: Type.STRING,
                description:
                  "The AI Coach's message to the student. This string MUST consist of exactly two sections separated by a line containing ONLY '---'. Part 1 (above '---') is the validation/feedback of the student's answer. Part 2 (below '---') is the NEXT Socratic guiding question in the sequence (e.g. asking about Core Issue, Key Constraints, or Contradiction) or Next-Step Call-to-Action. YOU MUST NEVER OMIT PART 2 AND MUST NEVER OMIT THE '---' SEPARATOR.",
              },
              progressUpdate: {
                type: Type.OBJECT,
                properties: {
                  isCompleted: { type: Type.BOOLEAN },
                  currentSubpointHint: { type: Type.STRING },
                  step3SubpointClaim: { type: Type.STRING },
                  step3SubpointReason: { type: Type.STRING },
                  step3SubpointSupportType: { type: Type.STRING },
                  step3SubpointSupportContent: { type: Type.STRING },
                  step3SubpointImpact: { type: Type.STRING },
                  step3SubpointMechanism: { type: Type.STRING },
                  step3SubpointResult: { type: Type.STRING },
                  step3SubpointCompleted: { type: Type.BOOLEAN },
                  paragraphPlan: {
                    type: Type.OBJECT,
                    properties: {
                      mode: {
                        type: Type.STRING,
                        enum: ["single_point", "total_then_points", "direct_points"],
                        description:
                          "'single_point' for a single-point claim (exactly one pointBlock), 'total_then_points' or 'direct_points' for multi-point claims.",
                      },
                      diagnosis: { type: Type.STRING },
                      totalClaim: { type: Type.STRING },
                      optionalShortClosing: {
                        type: Type.STRING,
                        description:
                          "OPTIONAL. Default is empty (\"\"). Only fill this when the paragraph genuinely needs a single closing sentence that ties the pointBlocks back to the overall claim. This is NOT a required Impact step and NOT a third argument. Omit (leave \"\") when each pointBlock already ends with a local effect, or when this would merely repeat totalClaim.",
                      },
                      pointBlocks: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            id: { type: Type.STRING },
                            label: { type: Type.STRING },
                            subClaim: { type: Type.STRING },
                            role: {
                              type: Type.STRING,
                              enum: ["major", "minor"],
                            },
                            expansionStrategy: {
                              type: Type.STRING,
                              enum: [
                                "explanation",
                                "example",
                                "mechanism",
                                "impact",
                                "contrast",
                                "hybrid",
                              ],
                            },
                            steps: {
                              type: Type.ARRAY,
                              items: {
                                type: Type.OBJECT,
                                properties: {
                                  key: { type: Type.STRING },
                                  label: { type: Type.STRING },
                                  placeholder: { type: Type.STRING },
                                  value: { type: Type.STRING },
                                },
                                required: ["key", "label", "placeholder", "value"],
                              },
                            },
                          },
                          required: [
                            "id",
                            "label",
                            "subClaim",
                            "role",
                            "expansionStrategy",
                            "steps",
                          ],
                        },
                      },
                    },
                    required: ["mode", "diagnosis", "pointBlocks"],
                  },
                  step3SubpointSteps: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        key: { type: Type.STRING },
                        label: { type: Type.STRING },
                        placeholder: { type: Type.STRING },
                        value: { type: Type.STRING }
                      },
                      required: ["key", "label", "placeholder", "value"]
                    }
                  },
                  step3SubpointCompletenessChecks: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        label: { type: Type.STRING },
                        passed: { type: Type.BOOLEAN },
                        desc: { type: Type.STRING },
                      },
                      required: ["label", "passed", "desc"],
                    },
                  },
                  step3SubpointTransitionChecks: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        label: { type: Type.STRING },
                        passed: { type: Type.BOOLEAN },
                        desc: { type: Type.STRING },
                      },
                      required: ["label", "passed", "desc"],
                    },
                  },
                  step3SubpointSufficiencyCheck: {
                    type: Type.OBJECT,
                    properties: {
                      label: { type: Type.STRING },
                      passed: { type: Type.BOOLEAN },
                      desc: { type: Type.STRING },
                    },
                    required: ["label", "passed", "desc"],
                  },
                  step1Data: {
                    type: Type.OBJECT,
                    properties: {
                      correctType: { type: Type.STRING },
                      coreIssue: { type: Type.STRING },
                      constraints: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      critique: { type: Type.STRING },
                      score: { type: Type.INTEGER },
                      writingTask: { type: Type.STRING },
                      keyQualifier: { type: Type.STRING },
                      suggestedDimensions: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                    },
                    required: [
                      "correctType",
                      "coreIssue",
                      "constraints",
                      "critique",
                      "score",
                    ],
                  },
                  step2Data: {
                    type: Type.OBJECT,
                    properties: {
                      currentStage: {
                        type: Type.STRING,
                        description: "The current active stage: 'explore_A', 'explore_B', 'stance', or 'summary'."
                      },
                      userStance: { type: Type.STRING },
                      userPoints: { type: Type.STRING },
                      critique: { type: Type.STRING },
                      suggestions: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      suggestedStance: { type: Type.STRING },
                      suggestedPoints: { type: Type.STRING },
                      blueprint: {
                        type: Type.OBJECT,
                        properties: {
                          question: { type: Type.STRING },
                          position: { type: Type.STRING },
                          body1: { type: Type.STRING },
                          body2: { type: Type.STRING },
                          bodies: {
                            type: Type.ARRAY,
                            items: {
                              type: Type.OBJECT,
                              properties: {
                                title: { type: Type.STRING },
                                content: { type: Type.STRING },
                              },
                              required: ["title", "content"],
                            },
                          },
                        },
                        required: ["question", "position"],
                      },
                      clustering: {
                        type: Type.OBJECT,
                        properties: {
                          totalPoints: { type: Type.INTEGER },
                          pointsList: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING },
                          },
                          clusters: {
                            type: Type.ARRAY,
                            items: {
                              type: Type.OBJECT,
                              properties: {
                                theme: { type: Type.STRING },
                                points: {
                                  type: Type.ARRAY,
                                  items: { type: Type.STRING },
                                },
                                targetBody: { type: Type.STRING },
                                content: { type: Type.STRING },
                              },
                              required: [
                                "theme",
                                "points",
                                "targetBody",
                                "content",
                              ],
                            },
                          },
                          outliers: {
                            type: Type.ARRAY,
                            items: {
                              type: Type.OBJECT,
                              properties: {
                                point: { type: Type.STRING },
                                suggestion: { type: Type.STRING },
                              },
                              required: ["point", "suggestion"],
                            },
                          },
                        },
                        required: ["totalPoints", "pointsList", "clusters"],
                      },
                      positionCheckPassed: { type: Type.BOOLEAN },
                      positionCheckDesc: { type: Type.STRING },
                      coverageCheckPassed: { type: Type.BOOLEAN },
                      coverageCheckDesc: { type: Type.STRING },
                      structureCheckPassed: { type: Type.BOOLEAN },
                      structureCheckDesc: { type: Type.STRING },
                    },
                    required: [
                      "userStance",
                      "userPoints",
                      "critique",
                      "suggestions",
                      "suggestedStance",
                      "suggestedPoints",
                    ],
                  },
                  step3Data: {
                    type: Type.OBJECT,
                    properties: {
                      userDraft: { type: Type.STRING },
                      structure: {
                        type: Type.OBJECT,
                        properties: {
                          claim: { type: Type.BOOLEAN },
                          reason: { type: Type.BOOLEAN },
                          mechanism: { type: Type.BOOLEAN },
                          example: { type: Type.BOOLEAN },
                          result: { type: Type.BOOLEAN },
                          evaluation: { type: Type.BOOLEAN },
                          concession: { type: Type.BOOLEAN },
                          contrast: { type: Type.BOOLEAN },
                          definition: { type: Type.BOOLEAN },
                          affectedGroup: { type: Type.BOOLEAN },
                        },
                        required: [
                          "claim",
                          "reason",
                          "mechanism",
                          "example",
                          "result",
                        ],
                      },
                      missingElements: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      socraticQuestions: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      suggestedChain: { type: Type.STRING },
                      critique: { type: Type.STRING },
                    },
                    required: [
                      "userDraft",
                      "structure",
                      "missingElements",
                      "socraticQuestions",
                      "suggestedChain",
                      "critique",
                    ],
                  },
                },
                required: ["isCompleted"],
              },
            },
            required: ["text"],
          },
        },
      });

      let data = parseAIResponse(response.text, {
        text: "Error parsing AI response.",
        progressUpdate: { isCompleted: false },
      });

      const currentStepNum = Number(step);
      const checkNeedsRepair = (parsed: any) => {
        const split = splitTwoParts(parsed?.text);
        if (!split.ok) {
          return { needsRepair: true, reason: `text_${split.reason}`, split };
        }

        // Optional signal: only for Step 2 summary stage.
        if (currentStepNum === 2) {
          const stageFromOutput =
            parsed?.progressUpdate?.step2Data?.currentStage || "";
          const stageFromSession =
            session?.step2?.coachEvaluation?.currentStage || "";
          const stage = stageFromOutput || stageFromSession || "";
          const bodies = parsed?.progressUpdate?.step2Data?.blueprint?.bodies;
          if (
            stage === "summary" &&
            (!Array.isArray(bodies) || bodies.length === 0)
          ) {
            return {
              needsRepair: true,
              reason: "step2_summary_missing_blueprint",
              split,
            };
          }
        }
        return { needsRepair: false, reason: "", split };
      };

      const firstCheck = checkNeedsRepair(data);
      if (firstCheck.needsRepair) {
        console.warn(
          `[CoachGuard] Response requires repair. reason=${firstCheck.reason}`,
        );
        const correctionSuffix = `

[SYSTEM CORRECTION]
你的上一次输出存在格式或推进缺陷（reason=${firstCheck.reason}）。
请严格重写本轮 JSON：
1) text 必须包含两段，且用单独一行的 --- 分隔；
2) Part 1 是简明反馈；
3) Part 2 必须是一个具体、可执行的下一步问题或明确行动指令（不能省略）。
4) 保持与当前步骤一致，继续推进流程，不要停在空泛回应。`;

        const retryResponse = await generateContentWithFallback({
          contents: `${prompt}${correctionSuffix}`,
          config: {
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
          },
        });
        const retryData = parseAIResponse(retryResponse.text, {
          text: "Error parsing AI response.",
          progressUpdate: { isCompleted: false },
        });
        const retryCheck = checkNeedsRepair(retryData);

        if (retryCheck.needsRepair) {
          const bestSplit = splitTwoParts(
            retryData?.text || data?.text || "",
            1,
          );
          const safePart1 =
            bestSplit.part1 ||
            String(retryData?.text || data?.text || "我们继续推进。").trim();
          const safePart2 = fallbackNextStep(currentStepNum, session);
          retryData.text = `${safePart1}\n\n---\n\n${safePart2}`;
          if (!retryData.progressUpdate) {
            retryData.progressUpdate = { isCompleted: false };
          }
          console.warn(
            `[CoachGuard] Retry still invalid. Applied fallback next-step template. reason=${retryCheck.reason}`,
          );
        }
        data = retryData;
      }

      if (data?.progressUpdate) {
        data.progressUpdate = sanitizeProgressUpdateWithSession(
          data.progressUpdate,
          session,
        );
      }

      // Step 1 deterministic safety net (A): if the student already echoed a scope
      // qualifier that exists in the essay question, credit it into constraints even
      // when the model left the slot empty, and repair a redundant "限定词" question.
      if (currentStepNum === 1 && data?.progressUpdate) {
        const backfilled = backfillStep1Constraints(
          question,
          userMessage,
          data.progressUpdate,
          session,
        );
        if (backfilled.length > 0 && data?.text) {
          const split = splitTwoParts(data.text, 1);
          if (split.part1 && looksLikeConstraintQuestion(split.part2)) {
            const s1 = data.progressUpdate.step1Data || {};
            const oldS1 = session?.step1?.coachEvaluation || {};
            const dims = s1.suggestedDimensions;
            const oldDims = oldS1.suggestedDimensions;
            const dimsFilled =
              (Array.isArray(dims) && dims.some((d: any) => String(d || "").trim())) ||
              (Array.isArray(oldDims) && oldDims.some((d: any) => String(d || "").trim()));
            const nextPart2 = dimsFilled
              ? "关键限定我已经帮你记下了。四个审题要素都齐了，请点击下方【下一步】按钮，我们进入第二步：确定立场与论点。"
              : `关键限定我已经帮你记下了（你提到的「${backfilled.join("、")}」）。那我们直接看下一步：为了回答这道题，需要从哪些方面来比较或展开？请列出 2~4 个讨论维度。`;
            data.text = `${split.part1.trim()}\n\n---\n\n${nextPart2}`;
            if (dimsFilled) {
              data.progressUpdate.isCompleted = true;
            }
            console.warn(
              `[Step1Guard] Backfilled constraints=${JSON.stringify(backfilled)} and repaired redundant qualifier question.`,
            );
          }
        }

        enforceStep1SlotCompletion(data, session);
      }

      // Step 2 Dimension Coverage & Retention Guard: a narrow, separate verification
      // call that catches cases where the prompt-only rule gets diluted by the large
      // Step 2 prompt and the model silently drops an uncovered sibling dimension.
      if (currentStepNum === 2 && data?.progressUpdate) {
        await applyStep2RetentionGuard(data, session, userMessage, messages, question);
      }

      // Heuristic + anti-drift completion (runs AFTER backfill text repair & slot check)
      applyStepCompletionHeuristic(data, currentStepNum);

      // Step 3 data-contract guard: the UI/CoachChat treat paragraphPlan as the
      // authoritative grouped structure. The model is instructed to always emit it,
      // but Gemini can still omit it. If it does, wrap the flat step3SubpointSteps
      // into a single-point paragraphPlan so downstream never lacks the contract.
      // NOTE: this only guarantees the shape exists; it does NOT invent a multi-point
      // split. Genuine point-splitting is driven by the prompt, not this fallback.
      if (
        Number(step) === 3 &&
        data?.progressUpdate &&
        !data.progressUpdate.paragraphPlan &&
        Array.isArray(data.progressUpdate.step3SubpointSteps) &&
        data.progressUpdate.step3SubpointSteps.length > 0
      ) {
        const flatSteps = data.progressUpdate.step3SubpointSteps.map((s: any) => ({
          key: s.key || "",
          label: s.label || "",
          placeholder: s.placeholder || "",
          value: s.value || "",
        }));
        const activeSubpoint = (session?.step3?.subpoints || []).find(
          (sp: any) => sp.id === session?.step3?.activeSubpointId,
        );
        const subClaim =
          data.progressUpdate.step3SubpointClaim ||
          activeSubpoint?.content ||
          flatSteps[0]?.value ||
          "";
        data.progressUpdate.paragraphPlan = {
          mode: "single_point",
          diagnosis:
            "Auto-normalized: model returned a flat chain without a paragraphPlan; wrapped as a single point for the data contract.",
          totalClaim: "",
          pointBlocks: [
            {
              id: "point-1",
              label: "分点1",
              subClaim,
              role: "major",
              expansionStrategy: "explanation",
              steps: flatSteps,
            },
          ],
        };
      }

      // Step 3 projection guard: paragraphPlan is the source of truth. Rebuild
      // the flat compatibility list from totalClaim + pointBlock.steps so model
      // drift cannot leak paragraph-level closing/summary as a fake required step.
      if (
        Number(step) === 3 &&
        data?.progressUpdate?.paragraphPlan &&
        Array.isArray(data.progressUpdate.paragraphPlan.pointBlocks)
      ) {
        const paragraphPlan = data.progressUpdate.paragraphPlan;
        const isParagraphClosing = (key: string, label: string) => {
          const k = (key || "").toLowerCase();
          const l = label || "";
          return (
            k === "short_closing" ||
            k === "closing" ||
            k === "summary" ||
            k === "conclusion" ||
            k.includes("short_closing") ||
            l.includes("收束") ||
            l.includes("总结")
          );
        };

        const derivedSteps: any[] = [];
        if (paragraphPlan.totalClaim && String(paragraphPlan.totalClaim).trim()) {
          derivedSteps.push({
            key: "total_claim",
            label: "总观点",
            placeholder: "",
            value: paragraphPlan.totalClaim,
          });
        }

        paragraphPlan.pointBlocks = paragraphPlan.pointBlocks.map((block: any, index: number) => {
          const blockLabel = block?.label || `分点${index + 1}`;
          const cleanSteps = Array.isArray(block?.steps)
            ? block.steps.filter((step: any) => {
                const key = step?.key || "";
                const label = step?.label || "";
                if (isParagraphClosing(key, label)) {
                  if (
                    !paragraphPlan.optionalShortClosing ||
                    !String(paragraphPlan.optionalShortClosing).trim()
                  ) {
                    paragraphPlan.optionalShortClosing =
                      step?.value && String(step.value).trim()
                        ? step.value
                        : label;
                  }
                  return false;
                }

                derivedSteps.push({
                  key,
                  label: `${blockLabel} - ${label}`,
                  placeholder: step?.placeholder || "",
                  value: step?.value || "",
                });
                return true;
              })
            : [];

          return {
            ...block,
            steps: cleanSteps,
          };
        });

        data.progressUpdate.step3SubpointSteps = derivedSteps;
      }

      if (typeof data?.text === "string") {
        const cleanedText = stripInternalJargonFromChatText(data.text);
        if (cleanedText !== data.text) {
          console.warn(
            `[JargonGuard] Stripped internal terms from step ${step} chat text.`,
          );
          data.text = cleanedText;
        }
      }

      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/coach/chat:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to generate chat response" });
    }
  });

  // Coach API - Evaluate Step 1 (User Topic Analysis Notes)
  app.post("/api/coach/evaluate-step1", async (req, res) => {
    try {
      const { question, userAnalysisText } = req.body;
      if (!question || !userAnalysisText) {
        res
          .status(400)
          .json({ error: "Missing question or user analysis text" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an elite IELTS Writing AI Coach.
        Evaluate the user's self-written Topic Analysis Notes for the following IELTS Task 2 prompt:
        "${question}"

        User's Analysis Notes:
        "${userAnalysisText}"

        Analyze the question yourself first:
        1. Determine the correct IELTS Question Type (Agree / Disagree, Discuss Both Views, Advantages / Disadvantages, Two-part Question, or Problem / Solution).
        2. Identify the central core issue/controversy.
        3. Identify any critical scope constraints (e.g. "entirely", "only", "always", specific target groups).

        Then, evaluate the user's analysis:
        - Did they identify the correct question type or structure?
        - Did they correctly capture the core issue/debate?
        - Did they notice the constraints?
        - Provide an encouraging, academic, and sharp coaching critique (3-4 sentences in Chinese, but citing English academic terms as needed). Give practical advice. Avoid exposing any internal raw thought blocks or XML elements.
        - Give a qualitative score from 1 to 10 for their analysis.

        Format your output strictly as a JSON object matching this schema:
        {
          "correctType": "string",
          "coreIssue": "string",
          "constraints": ["string"],
          "critique": "string",
          "score": number
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              correctType: { type: Type.STRING },
              coreIssue: { type: Type.STRING },
              constraints: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              critique: { type: Type.STRING },
              score: { type: Type.INTEGER },
            },
            required: [
              "correctType",
              "coreIssue",
              "constraints",
              "critique",
              "score",
            ],
          },
        },
      });

      const data = parseAIResponse(response.text, {
        correctType: "",
        coreIssue: "",
        constraints: [],
        critique: "Failed to generate evaluation due to output format error.",
        score: 0,
      });
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/coach/evaluate-step1:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to evaluate step 1" });
    }
  });

  // Coach API - Evaluate Step 2 (User Stance & Subpoints)
  app.post("/api/coach/evaluate-step2", async (req, res) => {
    try {
      const { question, questionType, userStance, userPoints } = req.body;
      if (!question || !userStance || !userPoints) {
        res
          .status(400)
          .json({ error: "Missing required stance/points or question" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an elite IELTS Writing AI Coach.
        Evaluate the user's overall stance and paragraph sub-arguments for the following IELTS Task 2 prompt:
        "${question}"
        (Question Type: ${questionType || "Standard Task 2"})

        User's Full-Text Overall Stance (全文立场):
        "${userStance}"

        User's Paragraph Sub-arguments/Points (段落分论点):
        "${userPoints}"

        Your tasks:
        1. Evaluate the Overall Stance: Is it clear, academically strong, and directly answering all parts of the question?
        2. Evaluate the Sub-arguments: Are there 2 distinct, logical sub-points? Do they support the stance without overlapping or repeating?
        3. Provide an encouraging, analytical, and highly professional critique (in Chinese, 3-4 sentences). Do NOT output any XML tags or internal thinking steps.
        4. Give 2-3 specific bullet-point suggestions for improvement.
        5. Formulate a polished, high-scoring IELTS-ready version of their Stance (in English) and Points (in English and Chinese) for them to study and compare.

        Format your output strictly as a JSON object matching this schema:
        {
          "critique": "string (coaching review in Chinese)",
          "suggestions": ["string (suggestion 1)", "string (suggestion 2)"],
          "suggestedStance": "string (polished English stance)",
          "suggestedPoints": "string (polished English/Chinese sub-arguments)"
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              critique: { type: Type.STRING },
              suggestions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              suggestedStance: { type: Type.STRING },
              suggestedPoints: { type: Type.STRING },
            },
            required: [
              "critique",
              "suggestions",
              "suggestedStance",
              "suggestedPoints",
            ],
          },
        },
      });

      const data = parseAIResponse(response.text, {
        critique: "Failed to generate evaluation due to format error.",
        suggestions: [],
        suggestedStance: "",
        suggestedPoints: "",
      });
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/coach/evaluate-step2:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to evaluate step 2" });
    }
  });

  // Coach API - Evaluate Step 3 (User Paragraph Structure Breakdown)
  app.post("/api/coach/evaluate-step3", async (req, res) => {
    try {
      const { question, draftText } = req.body;
      if (!draftText) {
        res.status(400).json({ error: "Draft text is empty" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are a Feedback Coach focusing purely on "Reasoning Diagnosis" (Logic > Structure > Language) rather than academic tone/clarity.
        Analyze the user's drafted paragraph:
        "${draftText}"

        Based on the IELTS Topic Question: "${question || ""}"

        Analyze if the paragraph satisfies the logical reasoning chain (Claim -> Reason -> Mechanism -> Example -> Result).

        Evaluate:
        - Structure Diagnosis: Which elements are present? Map the sentences from the user's paragraph to these categories.
        - List any missing or weak elements.
        - Formulate 1-2 sharp Socratic questions prodding the user to think deeper about their missing logic. (Keep questions in Chinese, e.g., "为什么线上教育能够节省时间？节省的时间如何转化为更高的学习效率？").
        - Rewrite Suggestion / Possible Direction: Provide a suggested direction (in Chinese) for the missing parts (e.g., "Possible direction: time flexibility / self-paced learning / fewer interruptions").
        - Logic Critique: Provide a constructive, professional logical critique (in Chinese, 2-3 sentences). Focus on gaps in reasoning. For example: "你直接从原因跳到了结果，中间的具体机制（过程）没有解释清楚。". Do NOT critique vocabulary or grammar.

        Format output as a JSON object matching this schema:
        {
          "structure": {
            "topicSentence": boolean,
            "explanation": boolean,
            "example": boolean,
            "concludingSentence": boolean
          },
          "sentenceMapping": {
            "topicSentence": "string (user's sentence matching this, or 'Missing')",
            "explanation": "string (user's sentence matching this, or 'Missing')",
            "example": "string (user's sentence matching this, or 'Missing')",
            "concludingSentence": "string (user's sentence matching this, or 'Missing')"
          },
          "missingElements": ["string"],
          "socraticQuestions": ["string"],
          "suggestedChain": "string (Possible direction or rewrite suggestion in Chinese)",
          "critique": "string (Logic Critique in Chinese)"
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              structure: {
                type: Type.OBJECT,
                properties: {
                  topicSentence: { type: Type.BOOLEAN },
                  explanation: { type: Type.BOOLEAN },
                  example: { type: Type.BOOLEAN },
                  concludingSentence: { type: Type.BOOLEAN },
                },
                required: [
                  "topicSentence",
                  "explanation",
                  "example",
                  "concludingSentence",
                ],
              },
              sentenceMapping: {
                type: Type.OBJECT,
                properties: {
                  topicSentence: { type: Type.STRING },
                  explanation: { type: Type.STRING },
                  example: { type: Type.STRING },
                  concludingSentence: { type: Type.STRING },
                },
                required: [
                  "topicSentence",
                  "explanation",
                  "example",
                  "concludingSentence",
                ],
              },
              missingElements: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              socraticQuestions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              suggestedChain: { type: Type.STRING },
              critique: { type: Type.STRING },
            },
            required: [
              "structure",
              "sentenceMapping",
              "missingElements",
              "socraticQuestions",
              "suggestedChain",
              "critique",
            ],
          },
        },
      });

      const data = parseAIResponse(response.text, {
        structure: {
          topicSentence: false,
          explanation: false,
          example: false,
          concludingSentence: false,
        },
        sentenceMapping: {
          topicSentence: "",
          explanation: "",
          example: "",
          concludingSentence: "",
        },
        missingElements: [],
        socraticQuestions: [],
        suggestedChain: "",
        critique: "Failed to generate evaluation due to format error.",
      });
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/coach/evaluate-step3:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to evaluate step 3" });
    }
  });

  // 3. API - Brainstorm Dimensions (Step 2 - 3.1)
  app.post("/api/brainstorm-dimensions", async (req, res) => {
    try {
      const { question, questionType, userNotes, suggestedDimensions } = req.body;
      if (!question) {
        res.status(400).json({ error: "Missing question text" });
        return;
      }

      const ai = getAI();
      let userNotesInstructions = "";
      if (userNotes && userNotes.trim().length > 0) {
        userNotesInstructions = `
        The student has already expressed their initial perspective / stance during the previous step: "${userNotes}".
        You MUST custom-tailor these Thinking Dimensions to align directly with or expand on the student's perspective. For example:
        - If they suggested that online and traditional education are complementary and satisfy different needs, make sure the dimensions facilitate exploring how they complement each other, what distinct needs they meet, or why they cannot completely replace each other.
        - Ensure at least 2 dimensions are directly related to exploring the specific themes or vocabulary words in their perspective (e.g. "mutual complementarity", "distinct demands", "socializing needs", "discipline").
        `;
      }
      const approvedDimensions = Array.isArray(suggestedDimensions)
        ? suggestedDimensions
            .map((d: any) => (typeof d === "string" ? d.trim() : ""))
            .filter((d: string) => d.length > 0)
        : [];
      const approvedDimensionInstructions =
        approvedDimensions.length > 0
          ? `
        Step 1 already surfaced these approved analytical angles:
        ${approvedDimensions.map((d: string, idx: number) => `${idx + 1}. ${d}`).join("\n")}
        You MUST treat them as baseline thinking directions.
        Keep the generated dimensions aligned with, deepening, or refining these angles.
        Avoid duplicates or near-duplicates of these baseline dimensions.
        `
          : "";

      const prompt = `
        You are an IELTS Writing Coach.
        For this IELTS Writing prompt:
        "${question}"
        (Question Type: ${questionType || "Standard Task 2"})
        ${userNotesInstructions}
        ${approvedDimensionInstructions}

        Brainstorm 4 to 5 "Thinking Dimensions" (critical angles / analytical entry points) to analyze the issue.
        Each dimension must be concise and represented as: "dimension_name (short explanation of scope/meaning)".
        For example:
        - "accessibility (who can access)"
        - "efficiency (learning speed)"
        - "motivation (student engagement)"
        - "inequality (gap between groups)"
        - "financial cost (affordability)"

        Limit dimensions strictly to high-quality nouns + short <= 5 words explanations.
        Do NOT write full arguments or complete sentences.

        Format output as a JSON object containing an array of dimensions:
        {
          "dimensions": [
            {
              "id": "string (unique code e.g. d1, d2...)",
              "name": "string (dimension name, e.g., 'accessibility')",
              "prompt": "string (e.g., 'accessibility (who can access)')"
            }
          ]
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              dimensions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    name: { type: Type.STRING },
                    prompt: { type: Type.STRING },
                  },
                  required: ["id", "name", "prompt"],
                },
              },
            },
            required: ["dimensions"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/brainstorm-dimensions:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to brainstorm dimensions" });
    }
  });

  // 4. API - Generate Argument Seeds (Step 2 - 3.2 Mapping)
  app.post("/api/generate-seeds", async (req, res) => {
    try {
      const { question, questionType, selectedDimensions } = req.body;
      if (!question || !selectedDimensions || !selectedDimensions.length) {
        res
          .status(400)
          .json({ error: "Missing question or selected dimensions" });
        return;
      }

      const ai = getAI();
      const dimensionListStr = selectedDimensions
        .map((d: any) => d.prompt)
        .join(", ");
      const prompt = `
        You are an IELTS Coach.
        Given the IELTS Writing topic: "${question}"
        And these selected thinking dimensions: [${dimensionListStr}]

        Create exactly ONE "Argument Seed" (semi-structured argument snippet) for each selected dimension.
        An Argument Seed is a logical precursor, NOT a full sentence. It consists of:
        1. Direction: Either "SUPPORT" (agree/pro/advantages) or "AGAINST" (disagree/con/disadvantages) or "MIXED".
        2. Mechanism: A short active phrase explaining HOW/WHY it works (e.g. "more rural students reach education").
        3. Scope: Optional group, time, or constraint affected (e.g. "removes distance constraint").

        Strict Constraints:
        - NO full sentences.
        - NO thesis statement.
        - Strictly concise and logical.

        Format output as a JSON object:
        {
          "seeds": [
            {
              "id": "string (unique code, e.g. s1, s2)",
              "dimension": "string (the matching dimension name)",
              "direction": "SUPPORT" | "AGAINST" | "MIXED",
              "mechanism": "string (short mechanism phrase, <=8 words)",
              "scope": "string (short scope phrase, <=5 words)"
            }
          ]
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              seeds: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    dimension: { type: Type.STRING },
                    direction: { type: Type.STRING },
                    mechanism: { type: Type.STRING },
                    scope: { type: Type.STRING },
                  },
                  required: [
                    "id",
                    "dimension",
                    "direction",
                    "mechanism",
                    "scope",
                  ],
                },
              },
            },
            required: ["seeds"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/generate-seeds:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to generate seeds" });
    }
  });

  // 5. API - Induce Thesis & Bundles (Step 2 - 3.3 & Step 4 Hook)
  app.post("/api/induce-thesis", async (req, res) => {
    try {
      const { question, questionType, seeds } = req.body;
      if (!question || !seeds || !seeds.length) {
        res.status(400).json({ error: "Missing topic or seeds" });
        return;
      }

      const ai = getAI();
      const seedsStr = JSON.stringify(seeds);
      const prompt = `
        You are an IELTS Writing Tutor.
        Topic: "${question}"
        Question Type: ${questionType}
        Input Argument Seeds: ${seedsStr}

        Task:
        1. Formulate exactly 3 distinct "Argument Bundles" (combinations of 1 to 3 seeds) that represent different reasoning tracks or logical stances (e.g. Option A: Pure Pro-impact, Option B: Mixed-impact, Option C: Critical/Con-impact).
        2. For each bundle, induce a high-scoring IELTS Thesis Statement (under 2 sentences) that perfectly summarizes the position of those seeds, requiring minimal extra assumptions.
        3. Rate each thesis option's structural and logical strength ("Strong" | "Balanced" | "Weak") and describe its logical flow (e.g. "Acknowledges minor drawback before asserting main benefit").

        Format output as a JSON object:
        {
          "bundles": [
            {
              "id": "string (b1, b2, b3)",
              "name": "string (e.g. 'Option A: Positive Stance')",
              "seeds": [
                {
                  "id": "string (seed id matching inputs)",
                  "dimension": "string",
                  "direction": "string",
                  "mechanism": "string",
                  "scope": "string"
                }
              ],
              "implicitImpact": "string (e.g., 'Positive Impact' or 'Mixed Position')"
            }
          ],
          "thesisOptions": [
            {
              "id": "string (t1, t2, t3 matching bundles b1, b2, b3)",
              "thesis": "string (the inferred formal high-scoring thesis statement)",
              "strength": "Strong" | "Balanced" | "Weak",
              "logicFlow": "string (short description of the argumentative flow)"
            }
          ]
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              bundles: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    name: { type: Type.STRING },
                    seeds: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          id: { type: Type.STRING },
                          dimension: { type: Type.STRING },
                          direction: { type: Type.STRING },
                          mechanism: { type: Type.STRING },
                          scope: { type: Type.STRING },
                        },
                      },
                    },
                    implicitImpact: { type: Type.STRING },
                  },
                  required: ["id", "name", "seeds", "implicitImpact"],
                },
              },
              thesisOptions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    thesis: { type: Type.STRING },
                    strength: { type: Type.STRING },
                    logicFlow: { type: Type.STRING },
                  },
                  required: ["id", "thesis", "strength", "logicFlow"],
                },
              },
            },
            required: ["bundles", "thesisOptions"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/induce-thesis:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to induce thesis options" });
    }
  });

  // 6. API - Recommend Template & Keywords (Step 3 论证)
  app.post("/api/recommend-template", async (req, res) => {
    try {
      const { question, questionType, selectedThesis, selectedBundle } =
        req.body;
      if (!question || !selectedThesis) {
        res.status(400).json({ error: "Missing topic or thesis" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an IELTS Writing Specialist.
        Analyzing the IELTS Topic: "${question}" (Type: ${questionType})
        With the chosen Thesis: "${selectedThesis}"

        Recommend the absolute best argumentation template from these 6 standardized structures:
        - Template A: Claim -> Reason -> Mechanism -> Result (Ideal for pure causal or process links, remote work, automation, etc.)
        - Template B: Claim -> Reason -> Example -> Result (Ideal for broad social or behavioral trends with easy illustrative group examples)
        - Template C: Claim -> Contrast -> Reason -> Example (Ideal for comparison or alternative choice prompts e.g. online vs offline)
        - Template D: Claim -> Concession -> Reason -> Result (Ideal for complex debate, acknowledging opposite limits before countering)
        - Template E: Claim -> Reason -> Example -> Result -> Evaluation (Ideal for 7+ deep critical assessment of social impact)
        - Template F: Claim -> Reason -> Affected Group -> Result -> Evaluation (Ideal for government policy, public transport, bans)

        Recommend the template ID ("A", "B", "C", "D", "E", or "F") that best matches.
        Provide:
        1. 4-5 high-scoring lexical Keywords (useful verbs/phrases) appropriate for this argument.
        2. A structured breakdown of what each template element would say based on this thesis.

        Format output as JSON:
        {
          "templateId": "A" | "B" | "C" | "D" | "E" | "F",
          "keywords": ["string", "string"],
          "sampleElements": {
            "claim": "string",
            "reason": "string",
            "mechanism": "string (optional)",
            "example": "string (optional)",
            "result": "string (optional)",
            "contrast": "string (optional)",
            "concession": "string (optional)",
            "definition": "string (optional)",
            "affectedGroup": "string (optional)",
            "evaluation": "string (optional)"
          }
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              templateId: { type: Type.STRING },
              keywords: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              sampleElements: {
                type: Type.OBJECT,
                properties: {
                  claim: { type: Type.STRING },
                  reason: { type: Type.STRING },
                  mechanism: { type: Type.STRING },
                  example: { type: Type.STRING },
                  result: { type: Type.STRING },
                  contrast: { type: Type.STRING },
                  concession: { type: Type.STRING },
                  definition: { type: Type.STRING },
                  affectedGroup: { type: Type.STRING },
                  evaluation: { type: Type.STRING },
                },
                required: ["claim", "reason"],
              },
            },
            required: ["templateId", "keywords", "sampleElements"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/recommend-template:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to recommend template" });
    }
  });

  // 7. API - Analyze Paragraph Argumentation (Step 3 & 5 Feedback)
  app.post("/api/analyze-argumentation", async (req, res) => {
    try {
      const { question, templateId, draftText } = req.body;
      if (!draftText) {
        res.status(400).json({ error: "Draft text is empty" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an IELTS Writing Tutor specializing in logical coherence.
        Analyze this user's drafted paragraph:
        "${draftText}"

        Based on IELTS Topic: "${question || ""}"
        We are testing against Argumentation Template ID: "${templateId || "A"}"

        Analyze which template elements are present or absent:
        - Claim (Main assertion)
        - Reason (Underlying cause)
        - Mechanism (How it works precisely / causal chain)
        - Example (Illustrative fact or case study)
        - Result (Ultimate consequence)
        - Evaluation (Significance / moral upgrade)
        - Concession (Acknowledging opposite side)
        - Contrast (Alternative stance comparison)

        Task:
        1. Identify true/false for each element's presence.
        2. Detail missing elements.
        3. Formulate 1-2 sharp Socratic questions prodding the user to think deeper about the missing or weak logical link. Do NOT give them the answer; ask a question that guides them (e.g., "While you state that remote work reduces distractions, what exact aspects of the office environment are avoided?").
        4. Reconstruct a "Suggested Logical Chain" showing how this paragraph would look with a highly cohesive structure following the exact template.
        5. Provide a critical, professional critique (2-3 sentences) on logic, flow, and structural integrity.

        Format output as a JSON object:
        {
          "structure": {
            "claim": boolean,
            "reason": boolean,
            "mechanism": boolean,
            "example": boolean,
            "result": boolean,
            "evaluation": boolean,
            "concession": boolean,
            "contrast": boolean,
            "definition": boolean,
            "affectedGroup": boolean
          },
          "missingElements": ["string", "string"],
          "socraticQuestions": ["string"],
          "suggestedChain": {
            "claim": "string",
            "reason": "string",
            "mechanism": "string (optional)",
            "example": "string (optional)",
            "result": "string (optional)",
            "evaluation": "string (optional)",
            "concession": "string (optional)",
            "contrast": "string (optional)",
            "definition": "string (optional)",
            "affectedGroup": "string (optional)"
          },
          "critique": "string (professional logical critique)"
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              structure: {
                type: Type.OBJECT,
                properties: {
                  claim: { type: Type.BOOLEAN },
                  reason: { type: Type.BOOLEAN },
                  mechanism: { type: Type.BOOLEAN },
                  example: { type: Type.BOOLEAN },
                  result: { type: Type.BOOLEAN },
                  evaluation: { type: Type.BOOLEAN },
                  concession: { type: Type.BOOLEAN },
                  contrast: { type: Type.BOOLEAN },
                  definition: { type: Type.BOOLEAN },
                  affectedGroup: { type: Type.BOOLEAN },
                },
                required: ["claim", "reason", "mechanism", "example", "result"],
              },
              missingElements: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              socraticQuestions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              suggestedChain: {
                type: Type.OBJECT,
                properties: {
                  claim: { type: Type.STRING },
                  reason: { type: Type.STRING },
                  mechanism: { type: Type.STRING },
                  example: { type: Type.STRING },
                  result: { type: Type.STRING },
                  evaluation: { type: Type.STRING },
                  concession: { type: Type.STRING },
                  contrast: { type: Type.STRING },
                  definition: { type: Type.STRING },
                  affectedGroup: { type: Type.STRING },
                },
                required: ["claim", "reason"],
              },
              critique: { type: Type.STRING },
            },
            required: [
              "structure",
              "missingElements",
              "socraticQuestions",
              "suggestedChain",
              "critique",
            ],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/analyze-argumentation:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to analyze paragraph" });
    }
  });

  // 8. API - Floating Action Bar Text Helpers
  app.post("/api/inline-action", async (req, res) => {
    try {
      const { sentence, action, contextTopic } = req.body;
      if (!sentence || !action) {
        res.status(400).json({ error: "Missing sentence or action" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an elite IELTS Writing Editor.
        Optimize this selected sentence from an essay draft:
        "${sentence}"

        Task: Apply the action "${action}" to improve the sentence.
        Actions defined:
        - "clarity": Eliminate wordiness, improve flow, and make the meaning crystal clear.
        - "mechanism": Embed a logical/causal step or mechanism directly into the sentence (how/why).
        - "formal": Upgrade vocabulary and style to be highly academic and formal (appropriate for band 8.0+).
        - "grammar": Fix any grammatical, tense, concord, or spelling errors.
        - "extend": Add a logical extension, consequence, or illustrative detail to support the claim.

        Context topic (if any): "${contextTopic || ""}"

        Provide the improved sentence and a brief, professional 1-sentence explanation of the change.

        Format output as a JSON object:
        {
          "improved": "string (the improved sentence)",
          "explanation": "string (the brief explanation of the change)"
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              improved: { type: Type.STRING },
              explanation: { type: Type.STRING },
            },
            required: ["improved", "explanation"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/inline-action:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to perform action" });
    }
  });

  // 9. API - Generate Sentence Practice Tasks (Step 4)
  app.post("/api/generate-sentence-tasks", async (req, res) => {
    try {
      const { question, selectedThesis, subpoints } = req.body;
      if (!question) {
        res.status(400).json({ error: "Missing topic question" });
        return;
      }

      const normalizeText = (value: unknown): string =>
        typeof value === "string" ? value.trim() : "";

      const dedupeOrdered = (items: string[]) => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const item of items) {
          const normalized = item.trim();
          if (!normalized) continue;
          if (seen.has(normalized)) continue;
          seen.add(normalized);
          result.push(normalized);
        }
        return result;
      };

      const inferSection = (taskId: string): "intro" | "body1" | "body2" | "conclusion" => {
        if (taskId.startsWith("intro-")) return "intro";
        if (taskId.startsWith("body1-")) return "body1";
        if (taskId.startsWith("body2-")) return "body2";
        return "conclusion";
      };

      const claimRegex = /(?:^|_)(subclaim|claim)$/i;
      const extractBodySentences = (plan: any): string[] => {
        if (!plan || typeof plan !== "object") return [];

        const sentences: string[] = [];
        const totalClaim = normalizeText(plan.totalClaim);
        if (totalClaim) sentences.push(totalClaim);

        const pointBlocks = Array.isArray(plan.pointBlocks) ? plan.pointBlocks : [];
        pointBlocks.forEach((block: any) => {
          const blockSubClaim = normalizeText(block?.subClaim);
          const steps = Array.isArray(block?.steps) ? block.steps : [];

          let claimStepIndex = -1;
          for (let i = 0; i < steps.length; i += 1) {
            const key = normalizeText(steps[i]?.key);
            const value = normalizeText(steps[i]?.value);
            if (value && claimRegex.test(key)) {
              claimStepIndex = i;
              break;
            }
          }

          if (claimStepIndex >= 0) {
            sentences.push(normalizeText(steps[claimStepIndex]?.value));
          } else if (blockSubClaim) {
            sentences.push(blockSubClaim);
          }

          steps.forEach((step: any, index: number) => {
            if (index === claimStepIndex) return;
            const value = normalizeText(step?.value);
            if (value) sentences.push(value);
          });
        });

        const shortClosing = normalizeText(plan.optionalShortClosing);
        if (shortClosing) sentences.push(shortClosing);

        return dedupeOrdered(sentences);
      };

      const extractBodyClaimContext = (plan: any): string => {
        if (!plan || typeof plan !== "object") return "";
        const totalClaim = normalizeText(plan.totalClaim);
        if (totalClaim) return totalClaim;

        const pointBlocks = Array.isArray(plan.pointBlocks) ? plan.pointBlocks : [];
        const subClaims = dedupeOrdered(
          pointBlocks.map((block: any) => normalizeText(block?.subClaim)).filter(Boolean),
        );
        return subClaims.join("；");
      };

      const allSubpoints = Array.isArray(subpoints) ? subpoints : [];
      const body1Subpoint =
        allSubpoints.find((sp) =>
          normalizeText(sp?.targetBody).toLowerCase().includes("1"),
        ) || allSubpoints[0];

      let body2Subpoint =
        allSubpoints.find((sp) =>
          normalizeText(sp?.targetBody).toLowerCase().includes("2"),
        ) || allSubpoints[1];
      if (body1Subpoint && body2Subpoint && body1Subpoint.id === body2Subpoint.id) {
        body2Subpoint = undefined;
      }

      const body1Plan = body1Subpoint?.paragraphPlan;
      const body2Plan = body2Subpoint?.paragraphPlan;
      const body1Sentences = extractBodySentences(body1Plan);
      const body2Sentences = extractBodySentences(body2Plan);

      const body1ClaimContext = extractBodyClaimContext(body1Plan);
      const body2ClaimContext = extractBodyClaimContext(body2Plan);
      const stance = normalizeText(selectedThesis) || "需要结合题干进行立场表达";

      const inputElements: {
        id: string;
        type: string;
        chineseText: string;
        label: string;
      }[] = [];
      const introConclusionPrompt = `
You are an IELTS Writing coach creating Chinese sentence-level semantic targets for translation practice.

Topic question:
"${question}"

Stance:
"${stance}"

Body 1 core claim context:
"${body1ClaimContext || "（缺失）"}"

Body 2 core claim context:
"${body2ClaimContext || "（缺失）"}"

Generate exactly three Chinese outputs:
1) introParaphrase: A concise paraphrase of the original topic sentence. It should be a topic restatement only.
2) introStance: One sentence that states the overall stance while naturally foreshadowing the two body directions.
3) conclusion: One sentence that summarizes the final stance with concise reference to the two body directions. Must not copy introStance wording.

Rules:
- All three fields MUST be Chinese only.
- Keep each field as one sentence.
- Do NOT include bullets, numbering, or explanation text.
      `;

      const introConclusionResponse = await generateContentWithFallback({
        contents: introConclusionPrompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              introParaphrase: { type: Type.STRING },
              introStance: { type: Type.STRING },
              conclusion: { type: Type.STRING },
            },
            required: ["introParaphrase", "introStance", "conclusion"],
          },
        },
      });

      const introConclusionData = parseAIResponse(introConclusionResponse.text);
      const introParaphrase =
        normalizeText(introConclusionData?.introParaphrase) ||
        "该题围绕一个公共议题展开讨论，需要比较不同路径并作出判断。";
      const introStance =
        normalizeText(introConclusionData?.introStance) ||
        `${stance}，并将结合两个主体段展开论证。`;
      const conclusion =
        normalizeText(introConclusionData?.conclusion) ||
        `综上所述，${stance}这一立场更具说服力。`;

      inputElements.push({
        id: "intro-1",
        type: "intro_paraphrase",
        chineseText: introParaphrase,
        label: "第一段：题干改写",
      });
      inputElements.push({
        id: "intro-2",
        type: "intro_stance",
        chineseText: introStance,
        label: "第一段：总立场句",
      });

      body1Sentences.forEach((sentence, index) => {
        inputElements.push({
          id: `body1-${index + 1}`,
          type: "body1_sentence",
          chineseText: sentence,
          label: `Body 1 句子 ${index + 1}`,
        });
      });
      body2Sentences.forEach((sentence, index) => {
        inputElements.push({
          id: `body2-${index + 1}`,
          type: "body2_sentence",
          chineseText: sentence,
          label: `Body 2 句子 ${index + 1}`,
        });
      });

      inputElements.push({
        id: "conclusion-1",
        type: "conclusion_summary",
        chineseText: conclusion,
        label: "结尾：总结立场",
      });

      if (inputElements.length === 0) {
        res.status(400).json({ error: "Missing step4 task source sentences" });
        return;
      }

      const elementsList = inputElements
        .map((el, idx) => {
          return `${idx + 1}. [Task ID: ${el.id}] [Category: ${el.label}] Target Chinese Sentence: "${el.chineseText}"`;
        })
        .join("\n");

      const prompt = `
      You are an expert IELTS Lexical Resource Tutor.
      For this IELTS topic: "${question}"
      Chosen position/thesis: "${selectedThesis || ""}"

      The user has completed structured drafting and we have segmented the writing flow sentence-by-sentence.
      
      YOUR TASK:
      You MUST generate exactly ${inputElements.length} sentence-level expression exercises (tasks) in the output.
      Each task corresponds directly and sequentially to one of the target Chinese sentences provided below.
      
      Here are the target Chinese sentences to translate:
      ${elementsList}

      CRITICAL RULES:
      1. For each task, set the "id" to the respective "Task ID" provided.
      2. Set the "concept" to the EXACT "Target Chinese Sentence" text provided in the input. Do NOT change any character and do NOT output English in "concept".
      3. For each task, provide exactly 3 different prompts. Each prompt teaches ONE structural dimension only:
         - Prompt 1: subject-verb / clause skeleton (where the main subject and predicate go)
         - Prompt 2: modifier placement (adverbials, prepositional phrases, non-finite clauses)
         - Prompt 3: logical connector (cause/result/contrast linking)
      4. ANTI-SPOILER RULE (MUST OBEY):
         - The English side MUST use ONLY "..." as placeholders. NEVER use square brackets like [Online learning] or [convenience].
         - NEVER fill in nouns, verbs, or adjectives from the Chinese concept on the English side.
         - Do NOT output a near-complete English translation. The student must supply all content words.
         BAD: "[Online learning] is characterized by [its high level of convenience], thereby catering to the needs of [diverse demographic groups]"
         BAD: "Online learning is characterized by convenience -> ..."
         GOOD: "... is characterized by ..., thereby catering to the needs of ... -> 主语放论述对象；characterized by 后接抽象名词短语；thereby 引出结果"
         GOOD: "It is widely acknowledged that... -> 形式主语 It 引出客观陈述，主语从句放真正主语"
      5. Each prompt MUST strictly follow this single-line format:
         "English academic pattern with ... only -> Chinese explanation of structure (主谓/修饰/连接，不要写具体译词)"

      Format output as JSON:
      {
        "tasks": [
          {
            "id": "string (matching Task ID)",
            "concept": "string (EXACT matching Target Chinese Sentence)",
            "prompts": ["string", "string", "string"]
          }
        ]
      }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          systemInstruction:
            "You are an expert IELTS Lexical Resource Tutor. All output properties called 'concept' MUST be written strictly and entirely in Chinese. For 'prompts', English patterns must use ONLY '...' placeholders—never square brackets, never filled-in content words from the concept. Each prompt must contain '->' followed by Chinese structural guidance (主谓/修饰/连接).",
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              tasks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    concept: { type: Type.STRING },
                    prompts: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                  },
                  required: ["id", "concept", "prompts"],
                },
              },
            },
            required: ["tasks"],
          },
        },
      });

      const llmData = parseAIResponse(response.text);
      const llmTasks = Array.isArray(llmData?.tasks) ? llmData.tasks : [];

      const DEFAULT_PROMPTS = [
        "... is characterized by ... -> 主谓框架：主语位置放核心论述对象，系表结构 + by 后接抽象名词短语表达特征",
        "..., thereby ... / ..., which ... -> 修饰与扩展：逗号后用 thereby/which 等非谓语或从句补充结果，注意修饰成分挂靠位置",
        "This is largely because ... / As a result, ... -> 逻辑连接：用因果或结果连接词组织句间逻辑，避免按中文语序硬译",
      ];

      const isValidPromptLine = (line: string): boolean => {
        const trimmed = normalizeText(line);
        if (!trimmed) return false;
        if (!trimmed.includes("->")) return false;
        if (!trimmed.includes("...")) return false;
        if (/\[[^\]]+\]/.test(trimmed)) return false;

        const englishPart = trimmed.split("->")[0]?.trim() || "";
        const englishWords = englishPart
          .replace(/\.\.\./g, " ")
          .split(/\s+/)
          .map((w) => w.replace(/[^a-zA-Z'-]/g, ""))
          .filter((w) => w.length > 2);
        // Reject near-complete sentences: too many content words outside placeholders
        if (englishWords.length > 10) return false;

        return true;
      };

      const sanitizePrompts = (rawPrompts: string[]): string[] => {
        const valid = rawPrompts.filter(isValidPromptLine);
        const result = [...valid];
        for (let i = 0; result.length < 3; i += 1) {
          result.push(DEFAULT_PROMPTS[i % DEFAULT_PROMPTS.length]);
        }
        return result.slice(0, 3);
      };

      const promptsById = new Map<string, string[]>();
      llmTasks.forEach((task: any, index: number) => {
        const id = normalizeText(task?.id);
        const prompts = Array.isArray(task?.prompts)
          ? task.prompts.map((p: unknown) => normalizeText(p)).filter(Boolean)
          : [];
        if (id && prompts.length > 0) {
          promptsById.set(id, prompts);
        }
        if (prompts.length > 0 && !promptsById.has(`__index_${index}`)) {
          promptsById.set(`__index_${index}`, prompts);
        }
      });

      const mergedTasks = inputElements.map((el, index) => {
        const matchedPrompts =
          promptsById.get(el.id) ||
          promptsById.get(`__index_${index}`) ||
          [];
        const prompts = sanitizePrompts(matchedPrompts);

        return {
          id: el.id,
          concept: el.chineseText,
          section: inferSection(el.id),
          prompts,
          confirmed: false,
          confirmedSentence: "",
        };
      });

      const rejectedPromptCount = llmTasks.reduce((count: number, task: any) => {
        const raw = Array.isArray(task?.prompts) ? task.prompts : [];
        const valid = raw.filter((p: unknown) => isValidPromptLine(normalizeText(p)));
        return count + Math.max(0, raw.length - valid.length);
      }, 0);

      console.log("[generate-sentence-tasks]", {
        subpointsCount: allSubpoints.length,
        body1SentenceCount: body1Sentences.length,
        body2SentenceCount: body2Sentences.length,
        inputElementIds: inputElements.map((el) => el.id),
        mergedTaskIds: mergedTasks.map((task) => `${task.id}:${task.section}`),
        llmTaskCount: llmTasks.length,
        rejectedPromptCount,
      });

      res.json({ tasks: mergedTasks });
    } catch (error: any) {
      console.error("Error in /api/generate-sentence-tasks:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to generate tasks" });
    }
  });

  // 10. API - Check Sentence Practice Draft (Step 4 Evaluation)
  app.post("/api/evaluate-sentence-practice", async (req, res) => {
    try {
      const { concept, prompts, userDraft } = req.body;
      if (!userDraft) {
        res.status(400).json({ error: "Draft is empty" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an expert IELTS Writing Tutor.
        Analyze the user's sentence and return precise inline annotations for errors.

        User's Draft: "${userDraft}"
        Target Idea (Concept): "${concept}"
        Given lexical prompts: ${JSON.stringify(prompts)}

        CRITICAL INSTRUCTIONS:
        1. DO NOT rewrite the sentence.
        2. DO NOT provide an improved or corrected sentence.
        3. Return only issue annotations that can be highlighted directly on the original sentence.
        4. For each annotation, "text" MUST be an exact substring copied from the user's draft.
        5. Explanations MUST be in plain Chinese with beginner-friendly wording (IELTS 5-5.5 level). Avoid heavy grammar jargon.
        6. If you need to mention the problematic phrase, quote the original English words but explain in Chinese.
        7. Also evaluate meaning alignment against the Chinese concept:
           - aligned: core meaning is fully and correctly conveyed.
           - partial: core direction is right but some key points are missing/weak.
           - mismatched: major meaning is wrong, opposite, or largely unrelated.
           IMPORTANT: Allow natural paraphrasing. Do NOT require literal word-by-word translation.
        8. If the sentence is already natural and correct, return an empty annotations array.

        Allowed categories:
        - "grammar"
        - "lexical"
        - "wordOrder"
        - "meaning"

        Format output as JSON:
        {
          "annotations": [
            {
              "text": "string (exact substring from user's draft)",
              "category": "grammar | lexical | wordOrder | meaning",
              "explanation": "string (brief explanation of issue and guidance)"
            }
          ],
          "contentAlignment": {
            "status": "aligned | partial | mismatched",
            "summary": "string (plain Chinese summary)",
            "coveredPoints": ["string"],
            "missingPoints": ["string"],
            "extraPoints": ["string"]
          }
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              annotations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    text: { type: Type.STRING },
                    category: { type: Type.STRING },
                    explanation: { type: Type.STRING },
                  },
                  required: ["text", "category", "explanation"],
                },
              },
              contentAlignment: {
                type: Type.OBJECT,
                properties: {
                  status: { type: Type.STRING },
                  summary: { type: Type.STRING },
                  coveredPoints: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  missingPoints: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  extraPoints: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: [
                  "status",
                  "summary",
                  "coveredPoints",
                  "missingPoints",
                  "extraPoints",
                ],
              },
            },
            required: ["annotations", "contentAlignment"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      const rawAnnotations = Array.isArray(data?.annotations)
        ? data.annotations
        : [];

      const normalizeCategory = (
        category: unknown,
      ): "grammar" | "lexical" | "wordOrder" | "meaning" => {
        const normalized = String(category || "")
          .trim()
          .toLowerCase();
        if (
          normalized.includes("meaning") ||
          normalized.includes("semantic") ||
          normalized.includes("content")
        ) {
          return "meaning";
        }
        if (
          normalized.includes("lex") ||
          normalized.includes("vocab") ||
          normalized.includes("word choice")
        ) {
          return "lexical";
        }
        if (
          normalized.includes("order") ||
          normalized.includes("syntax") ||
          normalized.includes("position")
        ) {
          return "wordOrder";
        }
        return "grammar";
      };

      const sanitizedAnnotations = rawAnnotations
        .map((item: any) => {
          const text = String(item?.text || "").trim();
          const explanation = String(item?.explanation || "").trim();
          if (!text || !explanation) return null;
          if (!String(userDraft).includes(text)) return null;
          return {
            text,
            category: normalizeCategory(item?.category),
            explanation,
          };
        })
        .filter(Boolean);

      const rawAlignment = data?.contentAlignment || {};
      const normalizedStatus = String(rawAlignment?.status || "")
        .trim()
        .toLowerCase();
      const status: "aligned" | "partial" | "mismatched" =
        normalizedStatus.includes("mismatch") || normalizedStatus.includes("wrong")
          ? "mismatched"
          : normalizedStatus.includes("partial") || normalizedStatus.includes("some")
            ? "partial"
            : "aligned";

      const normalizeStringList = (value: unknown): string[] =>
        Array.isArray(value)
          ? value
              .map((item) => String(item || "").trim())
              .filter(Boolean)
          : [];

      res.json({
        annotations: sanitizedAnnotations,
        contentAlignment: {
          status,
          summary: String(rawAlignment?.summary || "").trim(),
          coveredPoints: normalizeStringList(rawAlignment?.coveredPoints),
          missingPoints: normalizeStringList(rawAlignment?.missingPoints),
          extraPoints: normalizeStringList(rawAlignment?.extraPoints),
        },
      });
    } catch (error: any) {
      console.error("Error in /api/evaluate-sentence-practice:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to evaluate sentence" });
    }
  });

  // 11. API - Inline guidance (selected text or whole sentence)
  app.post("/api/inline-guidance", async (req, res) => {
    try {
      const { scopeText, fullDraft, concept, prompts, intent, questionText } = req.body;
      const normalizedScopeText = String(scopeText || "").trim();
      const normalizedFullDraft = String(fullDraft || "").trim();
      const normalizedIntent = String(intent || "").trim();
      const normalizedQuestionText = String(questionText || "").trim();
      if (!normalizedScopeText && !normalizedFullDraft) {
        // Allow empty draft guidance, but we still need concept context.
        if (!String(concept || "").trim()) {
          res.status(400).json({ error: "Missing concept for empty draft guidance" });
          return;
        }
      }
      if (!String(concept || "").trim()) {
        res.status(400).json({ error: "Missing concept" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an IELTS writing coach.
        The student is drafting ONE sentence in Step 4.

        Chinese target concept:
        "${String(concept || "")}"

        Current full draft sentence:
        "${normalizedFullDraft}"

        User-selected text scope (can be empty):
        "${normalizedScopeText}"

        User-selected help intent tag (can be empty):
        "${normalizedIntent}"

        User free-text question (can be empty):
        "${normalizedQuestionText}"

        Suggested structural patterns:
        ${JSON.stringify(Array.isArray(prompts) ? prompts : [])}

        Classify the user's help need into one of:
        - "vocabulary"
        - "grammar"
        - "wordOrder"
        - "expression"

        Classification rules:
        - If intent tag is provided, use it as the primary signal:
          selected_vocabulary/find_word -> vocabulary
          selected_grammar -> grammar
          selected_wordOrder -> wordOrder
          selected_expression/start_sentence -> expression
        - If selected scope is non-empty, focus diagnosis on that selected fragment first.
        - If selected scope is empty and full draft exists, do NOT perform full-sentence "check"; focus on the student's stated blocker from intent/question and provide targeted guidance.
        - If both selected scope and full draft are empty, classify as "expression" and guide how to start this sentence from the concept.

        CRITICAL INSTRUCTIONS:
        1. For "grammar", "wordOrder", and "expression", give guidance only and do NOT rewrite any part of the sentence.
        2. Exception for "vocabulary": if the student clearly does not know which word/phrase to use, you MAY suggest 1-3 concrete candidate words or short phrases, with brief Chinese notes about nuance/register/collocation differences.
        3. Even for "vocabulary", do NOT provide a ready-made full sentence, polished sentence, or full translated answer.
        4. issue/hint MUST be plain Chinese with learner-friendly wording (IELTS 5-5.5 level), avoid heavy grammar jargon.
        5. Keep it short and practical.

        Return JSON:
        {
          "category": "vocabulary | grammar | wordOrder | expression",
          "issue": "string (what is problematic now)",
          "hint": "string (for vocabulary: may include 1-3 candidate words/phrases with brief nuance notes; for other categories: guidance only, no direct rewrite)"
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              category: { type: Type.STRING },
              issue: { type: Type.STRING },
              hint: { type: Type.STRING },
            },
            required: ["category", "issue", "hint"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      const forcedCategoryFromIntent = (() => {
        const intentLower = normalizedIntent.toLowerCase();
        if (!intentLower) return null;
        if (intentLower.includes("vocabulary") || intentLower === "find_word") {
          return "vocabulary" as const;
        }
        if (intentLower.includes("grammar")) {
          return "grammar" as const;
        }
        if (intentLower.includes("wordorder") || intentLower.includes("word_order")) {
          return "wordOrder" as const;
        }
        if (intentLower.includes("expression") || intentLower === "start_sentence") {
          return "expression" as const;
        }
        return null;
      })();
      const normalizedCategory = String(data?.category || "")
        .trim()
        .toLowerCase();
      let category: "vocabulary" | "grammar" | "wordOrder" | "expression" = "expression";
      if (forcedCategoryFromIntent) {
        category = forcedCategoryFromIntent;
      } else if (normalizedCategory.includes("vocab") || normalizedCategory.includes("lex")) {
        category = "vocabulary";
      } else if (normalizedCategory.includes("order") || normalizedCategory.includes("syntax")) {
        category = "wordOrder";
      } else if (normalizedCategory.includes("gram")) {
        category = "grammar";
      }

      res.json({
        category,
        issue: String(data?.issue || "").trim(),
        hint: String(data?.hint || "").trim(),
      });
    } catch (error: any) {
      console.error("Error in /api/inline-guidance:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to get inline guidance" });
    }
  });

  // 12. API - Match user draft to sentence task
  app.post("/api/match-sentence-task", async (req, res) => {
    try {
      const { userDraft, candidates } = req.body;
      const normalizedDraft = String(userDraft || "").trim();
      const normalizedCandidates = Array.isArray(candidates)
        ? candidates
            .map((item: any) => ({
              id: String(item?.id || "").trim(),
              concept: String(item?.concept || "").trim(),
            }))
            .filter((item) => item.id && item.concept)
        : [];

      if (!normalizedDraft) {
        res.status(400).json({ error: "Missing userDraft" });
        return;
      }
      if (normalizedCandidates.length === 0) {
        res.status(400).json({ error: "Missing candidates" });
        return;
      }
      if (normalizedCandidates.length === 1) {
        res.json({
          matchedTaskId: normalizedCandidates[0].id,
          confidence: "high",
          reason: "只有一个候选句子，直接匹配。",
        });
        return;
      }

      const prompt = `
        You are matching one English sentence draft to one Chinese target concept.
        Choose the BEST matching candidate by meaning.

        English draft:
        "${normalizedDraft}"

        Candidate concepts (JSON):
        ${JSON.stringify(normalizedCandidates)}

        Rules:
        1. Return exactly one matchedTaskId from the candidates.
        2. Use semantic meaning, not literal word overlap.
        3. Allow paraphrasing; do NOT require word-by-word translation.
        4. If two candidates are close, still pick one but lower confidence.
        5. reason MUST be concise plain Chinese.

        Return JSON:
        {
          "matchedTaskId": "string",
          "confidence": "high | medium | low",
          "reason": "string"
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              matchedTaskId: { type: Type.STRING },
              confidence: { type: Type.STRING },
              reason: { type: Type.STRING },
            },
            required: ["matchedTaskId", "confidence", "reason"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      const candidateIds = new Set(normalizedCandidates.map((item) => item.id));
      let matchedTaskId = String(data?.matchedTaskId || "").trim();
      if (!candidateIds.has(matchedTaskId)) {
        matchedTaskId = normalizedCandidates[0].id;
      }
      const normalizedConfidence = String(data?.confidence || "")
        .trim()
        .toLowerCase();
      const confidence: "high" | "medium" | "low" =
        normalizedConfidence.includes("high")
          ? "high"
          : normalizedConfidence.includes("low")
            ? "low"
            : "medium";

      res.json({
        matchedTaskId,
        confidence,
        reason: String(data?.reason || "").trim(),
      });
    } catch (error: any) {
      console.error("Error in /api/match-sentence-task:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to match sentence task" });
    }
  });

  // Serve frontend files in development or production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
