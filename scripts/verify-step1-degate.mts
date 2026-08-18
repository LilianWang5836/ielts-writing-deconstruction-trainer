/**
 * ② Step1 去门禁化回归（V1，2026-08-18）。
 *
 * 直接提取并运行 server.ts 中的真实 `enforceStep1SlotCompletion`（转译 + stub 外部
 * 依赖），断言去门禁化后的新行为：
 *   T2 教练硬 CTA → isCompleted=true 且 Part2 不被 guard 覆写（即使维度不足/exit 未开）
 *   T3 模型置 isCompleted=true 且非软退出 → 保持完成
 *   T4 软退出且无 CTA → 不完成，文本保持
 *   T5 学生耗尽（进入下一步）+ slotsOk + 已探测≥2 → F2 确定性 CTA + 完成
 *   T6 卡死语料回归：3 轮探针（模型不返回 probeVerdict）→ 维度全部可展开、充分
 *
 * 用法：npx tsx scripts/verify-step1-degate.mts
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  buildBareDimensionProbeAsk,
  countUnprobedStep1Dimensions,
  earliestUnprobedDimension,
  inferProbeVerdictFromStudentMessage,
  isStep1DimensionUnprobed,
  normalizeProbeVerdict,
  preserveStep1ProbeTags,
  resolvePendingProbeAnswer,
  stampUnprobedQualityPending,
  step1CapProbeComplete,
  stripIllegalSameTurnProbeTags,
  textLooksLikeProbeAskForDim,
} from "../src/server/step1/dimension-probe.ts";
import { classifyStudentReply } from "../src/server/intent-router.ts";

const serverPath = fileURLToPath(new URL("../server.ts", import.meta.url));
const src = fs.readFileSync(serverPath, "utf8");

// ---- 提取 server.ts 代码块 ----
function findFunctionEnd(source: string, startIdx: number): number {
  const braceStart = source.indexOf("{", startIdx);
  if (braceStart < 0) throw new Error("no brace");
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("unbalanced");
}

const helperStart = src.indexOf('const STEP1_DIM_EXPANDABLE_TAG = "可展开";');
const sscStart = src.indexOf("function textSuggestsStep1Complete(");
if (helperStart < 0 || sscStart < 0) throw new Error("helper markers missing");
// 提取到 textSuggestsStep1Complete 结束（guard 依赖它判定 CTA）。
const helperEnd = findFunctionEnd(src, sscStart);

const exhaustedStart = src.indexOf("function studentSignalsExhausted(");
const exhaustedEnd = findFunctionEnd(src, exhaustedStart);

const guardStart = src.indexOf("function enforceStep1SlotCompletion(");
const guardEnd = findFunctionEnd(src, guardStart);
if (guardStart < 0 || guardEnd < 0) throw new Error("guard markers missing");

const blockTs =
  src.slice(helperStart, helperEnd) +
  "\n" +
  src.slice(exhaustedStart, exhaustedEnd) +
  "\n" +
  src.slice(guardStart, guardEnd);
const js = ts
  .transpileModule(blockTs, { compilerOptions: { target: ts.ScriptTarget.ES2020 } })
  .outputText;

// ---- 外部依赖 stub（仅与推进无关的工具函数） ----
const deps = `
const normalizeQuestionTypeLabel = (raw) => {
  const t = String(raw || '').trim();
  if (!t) return '';
  const lower = t.toLowerCase().replace(/[／]/g, '/').replace(/\\s+/g, ' ');
  if (/^agree\\s*(or|\\/)\\s*disagree$/.test(lower)) return 'Agree / Disagree';
  if (/^discuss\\s*both(\\s*views)?$/.test(lower)) return 'Discuss Both Views';
  if (/^positive\\s*(or|\\/)\\s*negative$/.test(lower)) return 'Positive / Negative';
  if (/^advantages?\\s*(and|\\/|&)\\s*disadvantages?$/.test(lower)) return 'Advantages / Disadvantages';
  if (/^problem\\s*(and|\\/|&|\\+)\\s*solution$/.test(lower)) return 'Problem / Solution';
  if (/^two[- ]?part(\\s*question)?$/.test(lower)) return 'Two-part Question';
  return t;
};
const isRealConstraintList = (constraints) => {
  if (!Array.isArray(constraints)) return false;
  return constraints.some((c) => String(c || '').trim());
};
const sanitizeStep1ConstraintMarkers = () => {};
const mergeStep1Evaluation = (progressUpdate, session) => {
  const newS1 = progressUpdate?.step1Data && typeof progressUpdate.step1Data === 'object' ? progressUpdate.step1Data : {};
  const oldS1 = session?.step1?.coachEvaluation || {};
  return { ...oldS1, ...newS1 };
};
const ensureStep1DataBucket = (data, merged) => {
  if (!data.progressUpdate || typeof data.progressUpdate !== 'object') data.progressUpdate = {};
  if (!data.progressUpdate.step1Data || typeof data.progressUpdate.step1Data !== 'object') data.progressUpdate.step1Data = { ...merged };
  return data.progressUpdate.step1Data;
};
const splitTwoParts = (text) => {
  const parts = String(text || '').split('---');
  return { part1: (parts[0] || '').trim(), part2: parts.slice(1).join('---').trim() };
};
const safeOverridePart1 = (p1) => String(p1 || '').trim() || '好的。';
`;

const fn = new Function(
  "preserveStep1ProbeTags",
  "stripIllegalSameTurnProbeTags",
  "resolvePendingProbeAnswer",
  "stampUnprobedQualityPending",
  "buildBareDimensionProbeAsk",
  "earliestUnprobedDimension",
  "step1CapProbeComplete",
  "textLooksLikeProbeAskForDim",
  "countUnprobedStep1Dimensions",
  "inferProbeVerdictFromStudentMessage",
  "classifyStudentReply",
  "isStep1DimensionUnprobed",
  "normalizeProbeVerdict",
  `${deps}\n${js}\nreturn { enforceStep1SlotCompletion };`,
);
const api = fn(
  preserveStep1ProbeTags,
  stripIllegalSameTurnProbeTags,
  resolvePendingProbeAnswer,
  stampUnprobedQualityPending,
  buildBareDimensionProbeAsk,
  earliestUnprobedDimension,
  step1CapProbeComplete,
  textLooksLikeProbeAskForDim,
  countUnprobedStep1Dimensions,
  inferProbeVerdictFromStudentMessage,
  classifyStudentReply,
  isStep1DimensionUnprobed,
  normalizeProbeVerdict,
) as {
  enforceStep1SlotCompletion: (data: any, session: any, userMessage?: string) => void;
};

const enforce = api.enforceStep1SlotCompletion;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.error(`  ✗ ${name} ${detail}`); }
};

const eff = (l: string) => `${l}（已探测）（可展开）`;
const thin = (l: string) => `${l}（已探测）（空标签）`;

function baseSession(dims: string[], extra: Record<string, any> = {}) {
  return {
    topic: { question: "Some people believe that online learning is highly beneficial and should replace traditional classroom education entirely. To what extent do you agree or disagree?", questionType: "Agree / Disagree" },
    currentStep: "step1",
    step1: {
      isCompleted: false,
      coachEvaluation: {
        correctType: "Agree / Disagree",
        coreIssue: "线上教育是否会完全取代传统教育形式",
        constraints: ["完全 (entirely)"],
        suggestedDimensions: dims,
        ...extra,
      },
      chatHistory: [],
    },
    step2: { isCompleted: false },
    step3: { isCompleted: false, subpoints: [], activeSubpointId: null, chatHistory: [] },
    step4: { isCompleted: false },
  };
}

console.log("--- T2: 硬 CTA 完成不被门禁弹回、Part2 不被覆写 ---");
{
  // 维度不足（只有 1 个空标签）+ exit 未开 + 模型发硬 CTA → 应完成且文本保持
  const session = baseSession([thin("便利性")]);
  const text = "好的，角度差不多了。\n\n---\n\n点击【下一步】按钮，进入第二步。";
  const data = {
    text,
    progressUpdate: {
      isCompleted: true,
      step1Data: { suggestedDimensions: [thin("便利性")] },
    },
  };
  enforce(data, session, "可以");
  check("硬 CTA → isCompleted=true", data.progressUpdate.isCompleted === true, JSON.stringify(data.progressUpdate));
  check("Part2 未被 guard 覆写（仍含点击下一步）", data.text === text, data.text);
}

console.log("--- T3: 模型置 isCompleted=true 且非软退出 → 保持完成 ---");
{
  const session = baseSession([eff("便利性"), eff("互动效果"), eff("监管强度")]);
  const text = "好的，那我们就进入第二步。现在请思考你的立场。";
  const data = {
    text,
    progressUpdate: {
      isCompleted: true,
      step1Data: { suggestedDimensions: [eff("便利性"), eff("互动效果"), eff("监管强度")] },
    },
  };
  enforce(data, session, "是");
  check("isCompleted 保持 true", data.progressUpdate.isCompleted === true, JSON.stringify(data.progressUpdate));
  check("文本未被覆写", data.text === text, data.text);
}

console.log("--- T4: 软退出且无 CTA → 不完成、文本保持 ---");
{
  const session = baseSession([thin("便利性")]);
  const text = "这几个角度已经可以支撑分析了。你还能想到别的吗？如果暂时想不到，告诉我，我们再进入第二步。";
  const data = {
    text,
    progressUpdate: {
      isCompleted: false,
      step1Data: { suggestedDimensions: [thin("便利性")] },
    },
  };
  enforce(data, session, "不知道");
  check("软退出无 CTA → isCompleted=false", data.progressUpdate.isCompleted === false, JSON.stringify(data.progressUpdate));
  check("文本未被覆写为 missing-hint", data.text === text, data.text);
  check("文本不再含「0 个有效角度」类注入", !/有效角度|还差至少/.test(data.text), data.text);
}

console.log("--- T5: 学生耗尽 → F2 确定性 CTA + 完成 ---");
{
  const session = baseSession([eff("便利性"), eff("互动效果")]);
  const data: any = {
    text: "嗯，我暂时想不到更多角度了。",
    progressUpdate: { step1Data: { suggestedDimensions: [eff("便利性"), eff("互动效果")] } },
  };
  enforce(data, session, "进入下一步");
  check("F2 → isCompleted=true", data.progressUpdate.isCompleted === true, JSON.stringify(data.progressUpdate));
  check("F2 → 文本含确定性 CTA（点击下一步）", /点击【下一步】/.test(data.text), data.text);
}

console.log("--- T6: 卡死语料回归（3 轮探针，模型不返回 probeVerdict）---");
{
  // 仿真主流程：每轮后把 progressUpdate.step1Data 合并回 session（真实 handler 行为），
  // 让 preserve 跨轮生效。
  const persistSession = (s: any, data: any) => {
    s.step1.coachEvaluation = {
      ...s.step1.coachEvaluation,
      ...(data.progressUpdate.step1Data || {}),
    };
  };

  // 第 1 轮：学生列 3 角度，教练引导探针（probe-first）
  let session = baseSession([]);
  let data: any = {
    text: "嗯，我们记下这三个角度：便利性、互动效果、监管强度。\n\n---\n\n",
    progressUpdate: { step1Data: { suggestedDimensions: ["时间和地点上的便利程度", "互动效果", "监管强度"] } },
  };
  enforce(data, session, "时间和地点上的便利程度，互动效果，监管强度");
  persistSession(session, data);
  check("T6 第1轮：武装 pendingProbeCore=便利性", /时间和地点上的便利程度/.test(String(data.progressUpdate.step1Data.pendingProbeCore || "")), JSON.stringify(data.progressUpdate.step1Data));

  // 第 2 轮：学生给便利性具体场景；模型不返回 probeVerdict、自报（可展开）被剥
  data = {
    text: "便利性这个角度你已经有了具体的场景，不错。",
    progressUpdate: {
      step1Data: {
        suggestedDimensions: [
          "时间和地点上的便利程度（已探测）（可展开）",
          "互动效果",
          "监管强度",
        ],
      },
    },
  };
  enforce(data, session, "上班的人可以根据自己的日程来选择上课时间，不用遵循固定的时间表，也可以选择不同城市的学校，可以在线上远程上课");
  persistSession(session, data);
  const d1 = data.progressUpdate.step1Data.suggestedDimensions as string[];
  check("T6 第2轮：便利性 →（已探测）（可展开）", /便利程度（已探测）（可展开）/.test(d1[0]), JSON.stringify(d1));

  // 第 3 轮：互动效果具体场景
  data = {
    text: "互动效果这个角度你已经有了具体的场景，不错。",
    progressUpdate: { step1Data: { suggestedDimensions: d1 } },
  };
  enforce(data, session, "线下可以和老师同学面对面交流，双方都能清楚地感受到对方的反应");
  persistSession(session, data);
  const d2 = data.progressUpdate.step1Data.suggestedDimensions as string[];
  check("T6 第3轮：互动效果 →（已探测）（可展开）", /互动效果（已探测）（可展开）/.test(d2[1]), JSON.stringify(d2));

  // 第 4 轮：监管强度具体场景
  data = {
    text: "监管强度这个角度你也有了具体的场景，不错。",
    progressUpdate: { step1Data: { suggestedDimensions: d2 } },
  };
  enforce(data, session, "学校里有老师的监管，有固定的学习课表，网上的课程就更考验自觉性");
  persistSession(session, data);
  const d3 = data.progressUpdate.step1Data.suggestedDimensions as string[];
  check("T6 第4轮：监管强度 →（已探测）（可展开）", /监管强度（已探测）（可展开）/.test(d3[2]), JSON.stringify(d3));
  check("T6 第4轮：三个维度均无（空标签）", !d3.some((d) => /空标签/.test(d)), JSON.stringify(d3));
  check("T6 第4轮：无 pendingProbeCore 残留", !data.progressUpdate.step1Data.pendingProbeCore, JSON.stringify(data.progressUpdate.step1Data));

  // 随后教练发硬 CTA → 完成（不再"0 个有效角度"）
  const finalData: any = {
    text: "好，那我们就进入第二步。\n\n---\n\n点击【下一步】按钮，进入第二步。",
    progressUpdate: { isCompleted: true, step1Data: { suggestedDimensions: d3 } },
  };
  enforce(finalData, session, "进入下一步");
  check("T6 完成：硬 CTA → isCompleted=true", finalData.progressUpdate.isCompleted === true);
  check("T6 完成：文本保持（无 missing-hint 覆写）", !/有效角度|还差至少/.test(finalData.text), finalData.text);
}

console.log("--- T7: probe-first 仅在未完成时引导，不拦完成 ---");
{
  // 存在裸标签 + 教练已发 CTA → 不覆写、不拦（去门禁化关键）
  const session = baseSession([]);
  const text = "好。\n\n---\n\n点击【下一步】按钮，进入第二步。";
  const data = {
    text,
    progressUpdate: { isCompleted: true, step1Data: { suggestedDimensions: ["新角度", "另一个角度"] } },
  };
  enforce(data, session, "好的");
  check("裸标签 + 硬 CTA → isCompleted=true", data.progressUpdate.isCompleted === true, JSON.stringify(data.progressUpdate));
  check("裸标签 + 硬 CTA → 文本不被 probe-first 覆写", data.text === text, data.text);
}

console.log("--- T7: Step2 完成弹回移除（源码断言）---");
{
  const s2Start = src.indexOf("function enforceStep2Completion(");
  if (s2Start < 0) throw new Error("enforceStep2Completion marker missing");
  const s2Block = src.slice(s2Start, findFunctionEnd(src, s2Start));
  check(
    "enforceStep2Completion 不再清 isCompleted",
    !/data\.progressUpdate\.isCompleted = false/.test(s2Block),
    "仍存在清除赋值",
  );
  check(
    "enforceStep2Completion 保留 degated 日志",
    /\(degated\) keep isCompleted/.test(s2Block),
  );
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
