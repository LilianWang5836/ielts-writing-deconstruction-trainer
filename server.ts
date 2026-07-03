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
  - If the student answers coreIssue and already mentions qualifiers like "entirely / completely / only / 必须 / 完全", you MUST simultaneously write them into constraints and SKIP the qualifier question.
  - Example: "线上教育是否应该完全取代传统教育" already contains "完全/entirely". Do NOT ask again "题目里有没有哪些词限制了讨论范围？". Ask for dimensions directly.

  Missing-slot question templates (use only when that slot is truly missing):
  - missing correctType -> "这道题属于哪一种 Task 2 题型？"
  - missing coreIssue -> "请用一句话说：作者真正问你的问题是什么？不要翻译题目，而是说出它真正想讨论的议题。"
  - missing constraints -> "题目里有没有哪些词，限制了讨论范围？请列 1~3 个。"
  - missing suggestedDimensions -> "为了回答这道题，我们需要比较哪些方面？请列出 2~4 个维度即可。"

  Completion output (when all slots are filled):
  - Part 1: concise praise + structured summary (题型、核心争议、关键限定、建议维度)
  - Part 2: explicit CTA to enter Step 2.
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

  1. Stage "explore_A": Explore Advantages of Side A (发散A面/如：线上优势)
     - Preferred question: If Step1 dimensions already include online-flexibility/resource-access style ideas, explicitly quote that dimension and ask for concrete scenarios/target groups/mechanism. Example: "你已经提到『线上灵活性与资源可及性』，具体在哪些学习场景或人群上最能体现价值？"
     - Fallback question: "第一步，我们先不要急着决定立场。先想一想：哪些情况下，线上教育确实具有明显优势？不用组织语言，想到什么写什么即可。"
     - Wait for student answer.
     - Allowed Actions: Only ask about, validate, and record Side A points.
     - Next Stage Transition (sufficiency-gated):
       - IF SUFFICIENT (already enough to illustrate as a claim): do NOT re-ask or repeat any depth question about Side A — the information is already there. Briefly acknowledge and immediately transition to "explore_B". Set currentStage: "explore_B".
       - Transition to "explore_B" ONLY when the Side A content is sufficient enough for further illustration as a claim (not merely an echo/label of a Step1 dimension).
       - If it is NOT sufficient (only a repeated label or one-liner without any concrete angle), STAY in "explore_A" and ask ONE depth follow-up instead of advancing. Keep currentStage: "explore_A".
       - After that single follow-up, accept whatever is given and transition (respect the anti-loop guard: at most ONE follow-up per point).
     - Real-time Save: Put Side A brainstormed points inside progressUpdate.step2Data.userPoints. Only set currentStage: "explore_B" when the sufficiency gate above passes.
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
       - IF SUFFICIENT (already enough to illustrate as a claim): do NOT re-ask or repeat any depth question about Side B — the information is already there. Briefly acknowledge and immediately transition to "stance". Set currentStage: "stance".
       - Transition to "stance" ONLY when the Side B content is sufficient enough for further illustration as a claim (not merely an echo/label of a Step1 dimension such as "面对面互动，教师即时监督").
       - If it is NOT sufficient, STAY in "explore_B" and ask ONE depth follow-up (concrete scenario / mechanism / beneficiary) instead of advancing. Keep currentStage: "explore_B".
       - After that single follow-up, accept whatever is given and transition (anti-loop: at most ONE follow-up per point).
     - Real-time Save: Accumulate both Side A and Side B brainstormed points inside progressUpdate.step2Data.userPoints. Only set currentStage: "stance" when the sufficiency gate above passes.
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
  - For a MULTI-POINT claim with 2 sub-points, you MUST keep the whole paragraph within ~90-110 words. Therefore:
    1. Do NOT expand both points as full major chains. Pick ONE 'major' (2-3 steps) and keep the other 'minor' (1-2 steps).
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
  - Use deliberate detail balance. Do NOT expand every point equally. Decide which point needs explanation/mechanism and which point is better supported by a short example or impact.
  - Length-aware balance: the major/minor split and step counts MUST be chosen so the whole paragraph stays within the ~90-110 word budget. If both points need heavy expansion, downgrade one to 'minor' or switch mode to 'direct_points' rather than exceeding length. For a 2-point claim, do NOT mark both pointBlocks as 'major'.
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
    1. Evaluate how many internal points it contains and state the diagnosis briefly in Chinese.
    2. If it is multi-point, decide 'total_then_points' vs 'direct_points' yourself. Do NOT ask the student to choose A/B unless the claim is genuinely ambiguous; recommend the best mode and proceed.
    3. Assign each internal point a role ('major'/'minor') and expansionStrategy based on what the point naturally needs (explanation, example, mechanism, impact, contrast, or hybrid).
    4. Explicitly DECLARE the paragraphPlan mode, the pointBlocks, and why this distribution of detail is chosen (1-2 concise Chinese sentences in Part 1).
    5. IMMEDIATELY emit 'progressUpdate.paragraphPlan' and a compatible flattened 'progressUpdate.step3SubpointSteps'. The flattened steps may be labels like "总观点", "分点1：行为监管 - 解释", "分点2：同伴互动 - 举例/影响". Do NOT include "简短收束" or any summary/closing as a flattened step; use 'paragraphPlan.optionalShortClosing' only.
    6. Different subpoints in the same essay may use different paragraph modes and expansion strategies. Decide each independently.

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
       - 明确指出这几个支撑点分别是什么（每个点将成为一个 pointBlock）。
       - 你自己决定用 'total_then_points' 还是 'direct_points'，并说明为什么这样分配详略，直接推进。不要让学生在方案 A/B 之间做选择。
      - 仅当 claim 为空、过短、或本身模糊到无法判断是否该拆点时，才可以问一个澄清问题；即便如此也要先给出一个临时的 \`paragraphPlan\`。
     - 然后，按上文规则【声明 paragraphPlan mode、分点、详略权重、展开策略】，并立即写入 \`paragraphPlan\` 与兼容用 \`step3SubpointSteps\`。
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
       已为你放置【逻辑闭环诊断报告】，展现在右侧。这个分论点已经大功告成！我们接下来继续讨论另一个分论点，或者你可以点击下一步进入写作练习。"

  DECIDING COMPLETION:
  - 只有当所有主体段（subpoints中的每一项）的 \`step3SubpointCompleted\` 均已为 true，即所有主体段都锁定了全套逻辑链，才可以整体将 'isCompleted' 设为 true。
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

      // Heuristic fallback: if AI explicitly tells the user to enter the next step, force isCompleted to true
      if (data && data.text) {
        const t = data.text;
        let shouldForceComplete = false;

        if (currentStepNum === 1) {
          if (t.includes("进入第二步") || t.includes("进入第二阶段") || t.includes("脑暴与蓝图设计")) {
            shouldForceComplete = true;
          }
        } else if (currentStepNum === 2) {
          if (t.includes("进入第三步") || t.includes("进入第三阶段") || t.includes("段落逻辑链构建")) {
            shouldForceComplete = true;
          }
        } else if (currentStepNum === 3) {
          if (t.includes("第三步段落逻辑链构建已全部完成") || t.includes("进入第四步：逐句写作练习") || t.includes("进入第四阶段") || t.includes("进入逐句写作") || t.includes("进入逐句写作练习")) {
            shouldForceComplete = true;
          }
        } else {
          if (
            t.includes("进入第二步") ||
            t.includes("进入第三步") ||
            t.includes("进入第四步") ||
            t.includes("进入下一阶")
          ) {
            shouldForceComplete = true;
          }
        }

        if (shouldForceComplete) {
          if (!data.progressUpdate) {
            data.progressUpdate = { isCompleted: true };
          } else {
            data.progressUpdate.isCompleted = true;
          }
        }
      }

      if (data?.progressUpdate) {
        data.progressUpdate = sanitizeProgressUpdateWithSession(
          data.progressUpdate,
          session,
        );
      }

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
      const { question, questionType, selectedThesis, subpoints } = req.body;
      if (!question) {
        res.status(400).json({ error: "Missing topic question" });
        return;
      }

      const inputElements: {
        id: string;
        type: string;
        chineseText: string;
        label: string;
      }[] = [];
      if (Array.isArray(subpoints) && subpoints.length > 0) {
        subpoints.forEach((sp, i) => {
          if (sp.claim && sp.claim.trim()) {
            inputElements.push({
              id: `sp${i}-claim`,
              type: "claim",
              chineseText: sp.claim.trim(),
              label: `分论点 ${i + 1} 的核心论点 (Claim)`,
            });
          }
          if (sp.mechanism && sp.mechanism.trim()) {
            inputElements.push({
              id: `sp${i}-mech`,
              type: "mechanism",
              chineseText: sp.mechanism.trim(),
              label: `分论点 ${i + 1} 的论证机制 (Mechanism)`,
            });
          }
          if (sp.result && sp.result.trim()) {
            inputElements.push({
              id: `sp${i}-res`,
              type: "result",
              chineseText: sp.result.trim(),
              label: `分论点 ${i + 1} 的影响结果 (Result)`,
            });
          }
        });
      }

      const ai = getAI();
      let prompt = "";

      if (inputElements.length > 0) {
        const elementsList = inputElements
          .map((el, idx) => {
            return `${idx + 1}. [Task ID: ${el.id}] [Category: ${el.label}] Target Chinese Sentence: "${el.chineseText}"`;
          })
          .join("\n");

        prompt = `
        You are an expert IELTS Lexical Resource Tutor.
        For this IELTS topic: "${question}"
        Chosen position/thesis: "${selectedThesis || ""}"

        The user has completed Step 3 (Drafting) and has established a robust Chinese argumentation chain.
        We have broken down this chain sentence-by-sentence.
        
        YOUR TASK:
        You MUST generate exactly ${inputElements.length} sentence-level expression exercises (tasks) in the output.
        Each task corresponds directly and sequentially to one of the target Chinese sentences provided below.
        
        Here are the target Chinese sentences to translate:
        ${elementsList}

        CRITICAL RULES:
        1. For each task, set the "id" to the respective "Task ID" provided (e.g. "sp0-claim").
        2. Set the "concept" of the task to the EXACT "Target Chinese Sentence" text provided in the input. Do NOT change a single character of the Chinese text, and do NOT provide any English text in the "concept" field. This is critical because the student is practicing translating this exact Chinese sentence into English!
        3. For each task, you MUST provide a set of exactly 3 different high-scoring, abstract academic English patterns/prompts (prompts) to help the student construct their sentence.
        4. CRITICAL ANTI-SPOILER RULE (MUST OBEY): The English patterns/prompts MUST be abstract, key academic structures/templates (e.g., "The unique value of... lies in...", "It is widely acknowledged that...", "... is/are irreplaceable in terms of...") rather than highly specific, context-filled sentences. You are STRICTLY FORBIDDEN from including the actual translated nouns, verbs, or specific vocabulary from the user's Chinese sentence inside the English pattern itself! If you write the full specific sentence, the student has nothing left to translate, which ruins the learning effect. Keep the pattern 100% abstract, general, and filled with ellipsis ("...") or generic placeholders!
        5. To help the student understand how the English structures map to their target Chinese sentence, each prompt MUST strictly follow this format:
           "English academic pattern/starter -> Chinese mapping explanation (Explain how to use the structure, what it corresponds to in Chinese, and how to build the sentence around it)"
           
           Example formatting (Abstract patterns with ellipsis, NO specific translation leaks!):
           - "The unique value of... lies in... -> ...的独特价值在于...：'The unique value of... lies in...' 对应 '...的独特价值在于...'，'lies in' 后面接具体名词/动名词短语表达独特价值所处的方面"
           - "It is widely acknowledged that... -> 人们普遍认为...：形式主语 'It' 引导主语从句，用于引出大众共识或客观常理，使论述更客观正式"
           - "... is/are irreplaceable in terms of... -> ...在...方面是不可替代的：'... is irreplaceable' 对应 '具有不可替代的作用'，'in terms of...' 引入具体限定维度"
           - "... provides... with... -> ...为...提供...：'provide sb. with sth.' 对应 '为...提供'，以此构建核心主谓宾结构，后续可接分词短语"

        Format output as JSON:
        {
          "tasks": [
            {
              "id": "string (the matching Task ID)",
              "concept": "string (the EXACT matching Target Chinese Sentence)",
              "prompts": ["string (pattern 1 with -> explanation)", "string (pattern 2 with -> explanation)", "string (pattern 3 with -> explanation)"]
            }
          ]
        }
        `;
      } else {
        prompt = `
        You are an expert IELTS Lexical Resource Tutor.
        For this IELTS topic: "${question}"
        Chosen position/thesis: "${selectedThesis || ""}"

        The user has not provided fully segmented Chinese drafting elements from the previous step.
        Generate exactly 3 "Sentence-Level Expression Exercises" (逐句写作练习) based on the topic and thesis that train students on precision, grammar, and formal academic collocations.
        
        CRITICAL RULES:
        1. The target idea ("concept") MUST be written STRICTLY and ONLY in Chinese.
        2. Do NOT provide English sentences in the "concept" field under any circumstances. It must be written entirely in Chinese so that the user can practice converting this Chinese semantic goal into an elegant English sentence.
        3. For each exercise task, you MUST provide a set of exactly 3 different high-scoring academic patterns/prompts (prompts).
        4. CRITICAL ANTI-SPOILER RULE (MUST OBEY): The English patterns/prompts MUST be abstract, key academic structures/templates (e.g., "The unique value of... lies in...", "It is widely acknowledged that...", "... is/are irreplaceable in terms of...") rather than highly specific, context-filled sentences. You are STRICTLY FORBIDDEN from including the actual translated nouns, verbs, or specific vocabulary from the user's Chinese sentence inside the English pattern itself! If you write the full specific sentence, the student has nothing left to translate, which ruins the learning effect. Keep the pattern 100% abstract, general, and filled with ellipsis ("...") or generic placeholders!
        5. To help the student understand how the English structures map to the Chinese semantic goals, each prompt MUST strictly follow this format:
           "English academic pattern/starter -> Chinese mapping explanation (Explain how to use the structure, what it corresponds to in Chinese, and how to build the sentence around it)"
           
           Example formatting (Abstract patterns with ellipsis, NO specific translation leaks!):
           - "The unique value of... lies in... -> ...的独特价值在于...：'The unique value of... lies in...' 对应 '...的独特价值在于...'，'lies in' 后面接具体名词/动名词短语表达独特价值所处的方面"
           - "It is widely acknowledged that... -> 人们普遍认为...：形式主语 'It' 引导主语从句，用于引出大众共识或客观常理，使论述更客观正式"
           - "... is/are irreplaceable in terms of... -> ...在...方面是不可替代的：'... is irreplaceable' 对应 '具有不可替代的作用'，'in terms of...' 引入具体限定维度"
           - "... provides... with... -> ...为...提供...：'provide sb. with sth.' 对应 '为...提供'，以此构建核心主谓宾 structure，后续可接分词短语"

        Format output as JSON:
        {
          "tasks": [
            {
              "id": "string (e.g. st1, st2, st3)",
              "concept": "string (strictly Chinese conceptual target idea)",
              "prompts": ["string (pattern 1 with -> explanation)", "string (pattern 2 with -> explanation)", "string (pattern 3 with -> explanation)"]
            }
          ]
        }
        `;
      }

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          systemInstruction:
            "You are an expert IELTS Lexical Resource Tutor. All output properties called 'concept' MUST be written strictly and entirely in Chinese. Under no circumstances should you output an English sentence in the 'concept' property. Always translate any English core ideas into natural academic Chinese for the 'concept' property.",
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

      const data = parseAIResponse(response.text);

      // Safety Fallback: If any task has a concept with no Chinese characters, translate it to Chinese immediately
      if (data && Array.isArray(data.tasks)) {
        for (const task of data.tasks) {
          const hasChinese = /[\u4e00-\u9fa5]/.test(task.concept || "");
          if (!hasChinese && task.concept) {
            console.log(
              "[Safety Fallback] Concept has no Chinese characters. Translating: " +
                task.concept,
            );
            try {
              const translationResponse = await generateContentWithFallback({
                contents: `You are a professional English-to-Chinese translator specializing in IELTS academic writing. Translate this English IELTS essay sentence into natural, fluent, and formal academic Chinese. 

Do NOT output any explanations, introduction, markdown tags, or English. Output ONLY the clean Chinese translation itself.

Sentence: "${task.concept}"`,
              });
              if (translationResponse?.text) {
                const cleanTranslation = translationResponse.text.trim();
                if (
                  cleanTranslation &&
                  /[\u4e00-\u9fa5]/.test(cleanTranslation)
                ) {
                  task.concept = cleanTranslation;
                }
              }
            } catch (translateErr) {
              console.error(
                "Failed to translate fallback concept:",
                translateErr,
              );
            }
          }
        }
      }

      res.json(data);
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
        Review the user's sentence draft to identify if there are any grammatical, stylistic, or lexical issues, or to confirm it is fully accurate and natural:
        User's Draft: "${userDraft}"

        Target Idea (Concept) to convey: "${concept}"
        Given lexical prompts: ${JSON.stringify(prompts)}

        CRITICAL INSTRUCTIONS:
        1. Keep the feedback extremely brief, concise, and straight to the point. No fluff or overly long theoretical explanations.
        2. Directly pinpoint grammatical errors, structural flaws, vocabulary/collocation issues, or confirm correctness in 1-2 brief sentences per point.
        3. Use Markdown bold tags (**word** or **phrase**) to highlight core terms, errors, or exact suggestions so they are immediately scannable.
        4. If the sentence is correct and natural, provide a short 1-sentence confirmation (e.g. "**The syntax is correct.** Use of the cleft sentence emphasizes the concept beautifully.").
        5. Do NOT suggest alternative rewritten sentences. Do NOT offer any alternative sentence versions or "improved" translations.
        6. Do NOT assign or mention any IELTS band score or grade.
        
        Provide:
        - 1-2 points of very brief and scannable grammar/sentence structure analysis.
        - 1-2 points of very brief and scannable lexical/vocabulary/style analysis.

        Format output as JSON:
        {
          "grammar": ["string (extremely brief, direct grammatical feedback with **bold** highlights)"],
          "lexicalResource": ["string (extremely brief, direct lexical feedback with **bold** highlights)"],
          "improved": "",
          "score": 0
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              grammar: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              lexicalResource: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              improved: { type: Type.STRING },
              score: { type: Type.NUMBER },
            },
            required: ["grammar", "lexicalResource", "improved", "score"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/evaluate-sentence-practice:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to evaluate sentence" });
    }
  });

  // 11. API - Step 5 Overall Feedback
  app.post("/api/overall-feedback", async (req, res) => {
    try {
      const { question, thesis, paragraphDraft, sentenceDrafts } = req.body;
      if (!paragraphDraft) {
        res.status(400).json({ error: "Missing paragraph draft" });
        return;
      }

      const ai = getAI();
      const sentenceDraftsStr = sentenceDrafts
        ? JSON.stringify(sentenceDrafts)
        : "None";
      const prompt = `
        You are a Chief IELTS Writing Examiner.
        Provide a comprehensive assessment of the user's completed writing outputs.

        Inputs:
        - IELTS Topic Question: "${question}"
        - Induced Thesis/Stance: "${thesis}"
        - Main Body Paragraph Draft: "${paragraphDraft}"
        - Supporting sentence tasks completed: ${sentenceDraftsStr}

        Evaluate the logic, vocabulary, grammar, and task completion of the body paragraph and overall work.
        Estimate IELTS Band Scores (1.0 - 9.0) for:
        - Overall Band Score
        - Task Achievement (TA)
        - Coherence & Cohesion (CC)
        - Lexical Resource (LR)
        - Grammatical Range & Accuracy (GRA)

        Structure Feedback to include:
        1. "Structure Diagnosis" (highlighting which parts of the claim-reason-mechanism logic worked, or what got lost).
        2. "Logic Critique" (evaluating argument strength, assumptions, gaps).
        3. "Detailed Feedback" (comprehensive tutoring explanation).
        4. "Revisions": A list of 2 specific Before/After sentence optimizations with deep logical explanations.

        Format output as a JSON object:
        {
          "bandScore": number (overall estimated band, e.g. 7.0),
          "taScore": number (TA band, e.g. 7.5),
          "ccScore": number (CC band, e.g. 6.5),
          "lrScore": number (LR band, e.g. 7.0),
          "graScore": number (GRA band, e.g. 7.0),
          "structureDiagnosis": "string",
          "logicCritique": "string",
          "detailedFeedback": "string",
          "revisions": [
            {
              "before": "string (the user's draft sentence)",
              "after": "string (the polished exam-ready version)",
              "explanation": "string (why the rewrite achieves a higher band)"
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
              bandScore: { type: Type.NUMBER },
              taScore: { type: Type.NUMBER },
              ccScore: { type: Type.NUMBER },
              lrScore: { type: Type.NUMBER },
              graScore: { type: Type.NUMBER },
              structureDiagnosis: { type: Type.STRING },
              logicCritique: { type: Type.STRING },
              detailedFeedback: { type: Type.STRING },
              revisions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    before: { type: Type.STRING },
                    after: { type: Type.STRING },
                    explanation: { type: Type.STRING },
                  },
                  required: ["before", "after", "explanation"],
                },
              },
            },
            required: [
              "bandScore",
              "taScore",
              "ccScore",
              "lrScore",
              "graScore",
              "structureDiagnosis",
              "logicCritique",
              "detailedFeedback",
              "revisions",
            ],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/overall-feedback:", error);
      res
        .status(500)
        .json({
          error: error.message || "Failed to generate overall feedback",
        });
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
