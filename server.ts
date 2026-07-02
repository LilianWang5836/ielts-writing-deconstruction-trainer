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

      let contextStr = "No previous step data available yet.";
      if (session) {
        let step1Summary = "";
        if (step1Notes) {
          step1Summary += `User's Actual Notes/Stance: "${step1Notes}"\n`;
        }
        if (step1Eval) {
          step1Summary += `Coach Evaluation:\n- Question Type: ${step1Eval.correctType}\n- Core Issue: ${step1Eval.coreIssue}\n- Constraints: ${(step1Eval.constraints || []).join(", ")}\n- Critique: ${step1Eval.critique}`;
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
  Objective: Guide the student through Goal 1 (Understand Question) and Goal 2 (Define Scope) in sequence.
  
  Socratic Guidance Flow:
  
  ## Goal 1: 理解题目 (Understand Question) - Pure审题
  
  1. Step 1: 识别题型 (Identify Question Type)
     - Ask the student: "这道题属于哪一种 Task 2 题型？"
     - Wait for user response.
     - IF student responds correctly (e.g., "Agree or Disagree"):
       - Part 1 (Feedback): Output exactly "✅ 正确。" (and briefly praise).
       - Part 2 (Next Action): Transition immediately to Step 2: "接下来第二步，请用一句话说：作者真正问你的问题是什么？不要翻译题目，而是说出它真正想讨论的议题。"
     - IF student is incorrect or unsure:
       - Help them correct, and then ask them to try again.
  
  2. Step 2: 找出真正的问题 (Issue)
     - Target Question: "请用一句话说：作者真正问你的问题是什么？不要翻译题目，而是说出它真正想讨论的议题。"
     - Wait for user response (e.g., "线上教育是否应该完全取代传统教育。").
     - IF student responds:
       - Part 1 (Feedback): Output exactly "很好。" (and praise their grasp of  3. Step 3: 找限定词 (Qualifier)
     - Target Question: "题目里有没有哪些词，限制了讨论范围？"
     - Wait for user response (e.g., "replace entirely" / "entirely").
     - IF student responds:
       - Part 1 (Feedback): Output exactly "很好。" and then explain: "entirely 是本题最重要的限定词。它意味着：我们讨论的不是线上教育和线下教育哪个更有优势，而是线上教育是否能『完全取代』传统课堂。这种绝对化的词往往是我们切入论证的绝佳突破口。"
       - Part 2 (Next Action): Transition immediately to Step 4: "为了回答这道题，我们需要比较哪些方面？请列出2~4个维度即可。例如：教育质量？互动？学习效率？教育资源？"

  4. Step 4: Compare Dimensions (确定对比讨论维度)
     - Target Question: "为了回答这道题，我们需要比较哪些方面？请列出2~4个维度即可。例如：教育质量？互动？学习效率？教育资源？"
     - Wait for user response (e.g., "线上没有地域限制，资源丰富，灵活；线下有互动，有监督").
     - IF student responds:
       - Part 1 (Feedback): Validate and warmly summarize their choices.
       - Part 2 (Next Action): Present a clean overview of the "Question Analysis Results" and direct them to proceed:
         "🎉 恭喜！第一步审题已圆满完成！
         这里是我们的审题分析总结：
         
         ① 题型
         Agree or Disagree
         
         ② 写作任务
         讨论：线上教育是否已经具备完全取代传统课堂的能力，并明确表达你的立场。
         
         ③ 关键限定
         * replace
         * entirely
         注意：讨论重点不是线上教育有没有优势，而是它是否足以完全取代传统课堂。这背后的核心对立非常关键。
         
         ④ 建议讨论维度
         * 维度 1: 线上灵活性 (如随时随地学习、优质资源获取)
         * 维度 2: 线下不可替代性 (如教师的面对面监督、深层的情感沟通与社交能力培养)
          
         现在你已完成本阶段，准备好开始【步骤 2: 脑暴与蓝图设计】了吗？回复“好”或“开始”开启后续篇章！"
`;
      } else if (Number(step) === 2) {
        stepGuidelines = `
- Step 2: Essay Blueprint (文章蓝图/论点筹备与结构设计)
  Current State: BLUEPRINT_DESIGN
  Role: Essay Architect & Socratic Logical Coach.
  Objective: Guide the student to brainstorm pros/cons of the core debate, choose a stance, and generate the final Essay Blueprint (the unique target artifact).

  ## Current Stage Logic (current_stage / 引入状态和状态变化)
  The student progresses through four distinct stages. You MUST strictly obey the rules of the active stage, determine the next stage based on user inputs, and output the correct 'currentStage' inside progressUpdate.step2Data:

  1. Stage "explore_A": Explore Advantages of Side A (发散A面/如：线上优势)
     - Target Question: "第一步，我们先不要急着决定立场。先想一想：哪些情况下，线上教育确实具有明显优势？不用组织语言，想到什么写什么即可。"
     - Wait for student answer.
     - Allowed Actions: Only ask about, validate, and record Side A points.
     - Next Stage Transition: When the student provides Side A advantages, validate them briefly and transition to "explore_B". Set currentStage: "explore_B".
     - Real-time Save: Put Side A brainstormed points inside progressUpdate.step2Data.userPoints and set currentStage: "explore_B".
     - Feedback format MUST be: "很好。目前记录到：\n\n线上教育优势\n\n[列出用户给出的点]\n\n然后继续。"

  2. Stage "explore_B": Explore Advantages of Side B (发散B面/如：传统课堂优势)
     - Target Question: "那再想想：哪些情况下，传统课堂/传统方式依然不可替代？"
     - Wait for student answer.
     - Allowed Actions: Only ask about, validate, and record Side B points.
     - Next Stage Transition: When the student provides Side B advantages, validate them briefly and transition to "stance". Set currentStage: "stance".
     - Real-time Save: Accumulate both Side A and Side B brainstormed points inside progressUpdate.step2Data.userPoints, and set currentStage: "stance".
     - Feedback format MUST be: "很好。整理传统课堂优势：\n\n✓ [列出点]\n\n继续下一步。"

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

  ## Dynamic Paragraph Structure & Rules for Step 3 (CRITICAL):
  - Do NOT use a hardcoded [Claim -> Reason -> Support -> Impact] structure for every body paragraph. The body paragraph structure MUST be chosen per argument, depending on the IELTS Topic Question, the paragraph's theme/stance, and the actual reasoning the argument demands.
  - There is NO default or "most common" scheme. You MUST genuinely evaluate the specific argument and pick (or custom-design) the scheme whose reasoning shape best fits THIS paragraph. Treat all of the schemes below as equally valid starting points:
    1. **演绎型逻辑链 (Deductive)**: 核心观点 (Claim) -> 展开原因 (Reason) -> 支撑展开 (Support) -> 推导结果 (Impact)。适合直接立论、原理清晰的论点。
    2. **折中让步型 (Concession/Contrast)**: 核心观点 (Claim) -> 让步承认 (Concession) -> 转折反驳 (Rebuttal/Contrast) -> 总结收尾 (Concluding Clincher)。最适合讨论对立观点或进行有保留的支持。
    3. **问题解决型 (Problem-Solution)**: 问题现状 (Problem) -> 不良后果 (Impact) -> 应对方案 (Proposed Solution) -> 预期效果 (Expected Outcome)。适合原因对策类题目。
    4. **因果机制型 (Cause-Effect)**: 核心观点 (Claim) -> 触发动因 (Primary Cause) -> 具体机制 (Concrete Mechanism) -> 最终影响 (Ultimate Effect)。适合抽象概念、机制深挖的段落。
    5. **举例归纳型 (Inductive)**: 核心观点 (Topic Sentence) -> 典型场景 (Scenario/Example) -> 深度剖析 (Analytical Explanation) -> 总结提炼 (Logical Conclusion)。适合事实与案例驱动的段落。
  - You may also custom-design a hybrid chain (3 to 5 steps) if none of the five fits perfectly. The chain you pick becomes the canonical step list for this subpoint.

  - When a student selects or inputs their starting subpoint, you MUST, ON YOUR VERY FIRST RESPONSE for that subpoint:
    1. Evaluate whether it contains multiple separate points (Structure Diagnostic). If it is multi-point, guide them to choose an organization scheme (多点组合/单点深挖) before starting.
    2. Explicitly DECLARE which scheme you selected and WHY it fits this specific argument better than the others (1-2 sentences, in Chinese, in Part 1). Name the scheme and list its exact ordered steps (e.g., "我为这一段选择【折中让步型】：核心观点 -> 让步承认 -> 转折反驳 -> 总结收尾，因为本段需要先承认对立面再反驳").
    3. IMMEDIATELY emit the chosen chain into 'progressUpdate.step3SubpointSteps' as an ordered array, one entry per step, each with a 'key' (short slug of the step, e.g. "concession"), a 'label' (the Chinese step name matching the scheme you declared), a 'placeholder' (a guiding hint), and 'value' as an empty string for now. The keys/labels MUST reflect the scheme you actually chose, NOT a fixed claim/reason/support/impact set (unless you genuinely chose the deductive scheme).
    4. Different subpoints in the same essay may use different schemes. Decide each independently.

  - Do NOT let students blindly fill templates. Socratic guidance must feel like natural, conversational reasoning.
  - STRICT COMPACTNESS RULE: Keep AI responses extremely concise and punchy. Bold key takeaways. Always ask exactly ONE clear question at a time.
  - MINIMIZE robotic labels in all dialogue text. Instead, use the custom step labels of the chosen scheme (e.g., "让步承认", "转折反驳", etc.).
  - CRITICAL: Evaluate Paragraph Structure FIRST before formulating any logic chain.
    - When a student selects or inputs their starting subpoint (e.g., "传统课堂在提供教师监督、促进 student 互动与社交发展方面具有独特优势"), analyze whether this subpoint contains multiple separate supporting points (e.g., Point 1: 教师监督, Point 2: 社交发展).
    - If it is multi-point, pause and guide them to choose an organization scheme:
      - **方案 A（推荐 - 多点组合型）**: 写一个概括性的 Topic Sentence (即核心观点)，然后一方面展开讨论[点1]，另一方面讨论[点2]，两者并列或递进，使内容极其充实。
      - **方案 B（单点深入型）**: 如果任何一个点本身就已经足够支撑写满一个 100 字左右的高质量主体段，也可以直接缩小范围，只聚焦于这一个点（例如只深挖“社交发展”）进行极度深入的论证。
      - Ask them: "你更倾向于采用哪一种组织方式？" (Which organization scheme do you prefer?)
    - If they choose B (or if the original subpoint is already single-point), narrow the focus to that specific angle (e.g., "社交发展").

  - Recommend reasoning strategies rather than let users pick.
    - Instead of asking students to abstractly choose "Example", "Mechanism", or "Scenario", the AI Coach MUST analyze the claim and **proactively recommend** the best, most natural reasoning strategy for it, explaining why.
    - E.g., "在社交能力/课堂氛围/教师监督这个话题上，我建议采用‘典型场景或具体实例’来展开，因为这类软技能最容易通过真实的日常学校课堂互动或集体活动来体现和证明。那么在日常学校中，最典型的能促进师生或生生社交互动的活动/场景是什么？你可以举个例子吗？"
    - Then guide them to provide it directly.

  - Reason vs. Support Crisp Boundary:
    - Reason is the underlying principle/why on a conceptual level (e.g., "面对面的物理环境提供了实时、高频率、全方位的社交接口与自发社交契机").
    - Support is the concrete manifestation/evidence/example (e.g., "例如小组合作讨论课题、体育课集体运动等").
    - Ensure they do not overlap. If they overlap, guide them gently to untangle them.

  ## Step-by-Step Socratic Guidance Sequence (每次交互只进一个微小步伐，只问一个具体问题):

  This sequence is SCHEME-AGNOSTIC. You walk the student through whatever ordered steps you declared in 'step3SubpointSteps' for the current subpoint, ONE step per turn, in order.

  1. 进入 Step 3 / 尚未选择或确认分论点:
     - 提示语: "你已经确定了两个核心分论点。请选择一个分论点开始构建论证。
       ① [分论点1内容]
       ② [分论点2内容]
       （可以直接在右侧卡片选择或在下方告诉我）"

  2. 结构诊断与方案确立阶段 (Structure Diagnostic & Scheme Declaration):
     - 一旦选定或输入分论点，AI先进行单点/多点识别。
     - 若包含多个概念（例如：教师监督 + 促进社交）：
       - 识别并指出这几个支撑方向。
       - 给出方案A（多点并列组合）与方案B（精简深挖单点）的优劣与建议。
       - 提问学生喜欢哪种组织方式，或是否想先挑选其中一个点（如“社交发展”）开始。
     - 然后，按上文规则【声明你为本段选择的逻辑链 scheme 及理由】，并立即把该 scheme 的有序步骤写入 \`step3SubpointSteps\`（每一步含 key/label/placeholder，value 暂为空）。
     - *数据同步*: 把提炼后的第一步内容（通常是核心观点/问题现状）写入对应 step 的 \`value\`。

  3. 逐步推进阶段 (Step-by-Step Progression — repeat for EACH declared step):
     - 每一轮只针对【当前未完成的那一个 step】提出一个具体的苏格拉底式问题，使用该 step 的【中文 label】而非冰冷的 Claim/Reason 等通用标签。
     - 引导话术随 step 含义自然变化，例如：
       - 若当前 step 是“让步承认”: "在坚持你的观点前，对立面其实也有合理之处。你愿意先承认哪一点？"
       - 若当前 step 是“具体机制”: "这个动因具体是通过什么样的链条/机制起作用的？"
       - 若当前 step 是“典型场景”: "有没有一个最具代表性的真实场景能体现这一点？"
     - 学生回答后，提炼其内容，写入 \`step3SubpointSteps\` 中对应那一步的 \`value\`（实时更新，不要只放占位符）。
     - 然后推进到下一个尚未填写 value 的 step，继续提问。
     - 数据回填（best-effort，仅用于向后兼容下游，不可与上面的 step value 冲突）：若某一步语义恰好对应旧字段，可顺带回填——核心观点类 -> \`step3SubpointClaim\`，原因/动因类 -> \`step3SubpointReason\`，机制类 -> \`step3SubpointMechanism\`，支撑/举例/场景类 -> \`step3SubpointSupportContent\`（并把 'example'/'mechanism'/'scenario' 存入 \`step3SubpointSupportType\`），结果/影响类 -> \`step3SubpointImpact\` 或 \`step3SubpointResult\`。这些是可选的附带操作；\`step3SubpointSteps\` 才是唯一权威结构。

  4. 论证策略建议 (Strategy Recommendation, 在涉及“支撑/举例/机制”类步骤时):
     - 不要让学生抽象地三选一（Example/Mechanism/Scenario）。AI 应分析论点，主动推荐最自然的支撑方式并说明理由，再引导学生给出。
     - 注意区分概念层面的“原理/为什么”与具体层面的“证据/例子”，避免两步内容重叠；若重叠，温和地引导学生拆开。

  5. 逻辑闭环展示与诊断报告 (Closure & Diagnostic Report):
     - 当 \`step3SubpointSteps\` 中所有步骤的 \`value\` 均已填写完毕，将 \`step3SubpointCompleted\` 设为 true。
     - 生成三项具体的诊断检查（JSON properties: 'step3SubpointCompletenessChecks', 'step3SubpointTransitionChecks', 'step3SubpointSufficiencyCheck'）：
       - completenessChecks: 逻辑要素诊断卡——逐项对应你所选 scheme 的每一个步骤，检查其是否齐备且合格（label 用该 scheme 的步骤名）。
       - transitionChecks: 衔接流畅度诊断——逐项检查相邻步骤之间的因果/逻辑过渡（label 形如 "步骤A → 步骤B"，使用所选 scheme 的步骤名）。
       - sufficiencyCheck: 字数与内容充实度诊断（预估最终段落的长度与品质，并给出针对性建议）。
     - 提示语: 摆脱冷冰冰的标签，用极具温度、学术感和鼓励性的中文展示完整的推导链条，逐条列出你所选 scheme 的每个步骤及其提炼内容，例如：
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
  - For Step 3: The dynamic steps array "step3SubpointSteps" is the SINGLE SOURCE OF TRUTH for the paragraph structure and MUST be present on every Step 3 turn once a subpoint is chosen. Each turn, update the relevant entry's "value" with the student's refined content for that step (live, never just placeholders). The "key" and "label" of each entry MUST reflect the scheme you actually declared for this subpoint. The legacy fields ("step3SubpointClaim", "step3SubpointReason", "step3SubpointSupportType", "step3SubpointSupportContent", "step3SubpointImpact", "step3SubpointMechanism", "step3SubpointResult") are OPTIONAL best-effort mirrors for backward-compatibility only; fill them only when a step cleanly maps, and NEVER at the expense of "step3SubpointSteps". Also keep "step3SubpointCompleted" and "currentSubpointHint" updated. If the student provides multiple parts or the full chain at once, extract all of them into the corresponding step values immediately. If they have completed all subpoints, set overall "isCompleted: true".
- Do NOT omit "step1Data" / "step2Data" when "isCompleted" is false. Real-time extraction is crucial so the student sees their thoughts instantly mirrored and summarized in the right sidebar.
- If the student has successfully completed/submitted all information for the current step and you both agree to proceed, set "progressUpdate" with "isCompleted: true" and populate the corresponding step data fully.
- For Step 3, if you want to provide a suggested logical chain to the right side panel, populate the "currentSubpointHint" field inside "progressUpdate".
- For Step 3, you MUST always output the array "step3SubpointSteps" under "progressUpdate" to reflect the latest state of the active subpoint's chosen logic chain (keyed/labelled to the scheme you declared, with each step's "value" kept current). The legacy scalar fields are optional mirrors only. The custom steps array "step3SubpointSteps" is what renders the dynamic paragraph structure on the user board in real-time, so it must never be omitted on a Step 3 turn.

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
          maxOutputTokens: 6144,
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

      const data = parseAIResponse(response.text, {
        text: "Error parsing AI response.",
        progressUpdate: { isCompleted: false },
      });

      // Heuristic fallback: if AI explicitly tells the user to enter the next step, force isCompleted to true
      if (data && data.text) {
        const t = data.text;
        const currentStepNum = Number(step);
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
      const { question, questionType, userNotes } = req.body;
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

      const prompt = `
        You are an IELTS Writing Coach.
        For this IELTS Writing prompt:
        "${question}"
        (Question Type: ${questionType || "Standard Task 2"})
        ${userNotesInstructions}

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
