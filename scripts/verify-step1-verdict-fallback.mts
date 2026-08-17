/**
 * 回归验证：Step1 探针裁决服务端兜底（真实用户死锁 2026-08-17）。
 *
 * 场景复现（来自 docs 真实对话语料）：
 *   - 学生给出 3 个中性角度：便利性 / 互动效果 / 监管强度
 *   - 教练逐轮轻探针，学生每次都给出具体场景（真实内容）
 *   - 但实机 DeepSeek 三轮全不返回 probeVerdict → 修复前全部误标（空标签）
 *     → effectiveDims=0 → “当前 0 个有效角度” 死锁，学生无法进入第二步
 *
 * 修复后断言：
 *   1) inferProbeVerdictFromStudentMessage：纯拒绝/含糊 → thin；含具体内容 → expandable
 *   2) 逐轮 resolve（模型缺省 verdict + 服务端推断）→ 三个角度全部（已探测）（可展开）
 *   3) 最终 countEffectiveStep1Dimensions=3、computeStep1DimensionsSufficient=true
 *      （与 enforceStep1SlotCompletion 使用同一批真实纯函数）
 *   4) exhausted + 全 thin 时按侧逃生仍放行（F2 slotsOk 门通过的前提）
 *
 * 用法：npx tsx scripts/verify-step1-verdict-fallback.mts
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import assert from "node:assert/strict";
import {
  inferProbeVerdictFromStudentMessage,
  resolvePendingProbeAnswer,
  stripStep1StatusTags,
  hasStep1StatusTag,
  STEP1_PROBE_PROBED,
  STEP1_PROBE_EXPANDABLE,
  STEP1_PROBE_THIN,
  stripIllegalSameTurnProbeTags,
} from "../src/server/step1/dimension-probe.ts";

const serverPath = fileURLToPath(new URL("../server.ts", import.meta.url));
const src = fs.readFileSync(serverPath, "utf8");

const startIdx = src.indexOf('const STEP1_DIM_EXPANDABLE_TAG = "可展开";');
const blockEnd = src.indexOf("function textSuggestsStep1Complete(");
if (startIdx < 0 || blockEnd < 0 || blockEnd <= startIdx) {
  console.error("FAIL: markers not found in server.ts");
  process.exit(2);
}
const blockTs = src.slice(startIdx, blockEnd);
const js = ts
  .transpileModule(blockTs, { compilerOptions: { target: ts.ScriptTarget.ES2020 } })
  .outputText;

// 与 enforceStep1SlotCompletion 共享的外部纯函数（同 verify-p1-per-side.mts 的 stub 口径）
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
const isStep1DimensionUnprobed = (dim) => {
  const t = String(dim || '').trim();
  if (!t) return false;
  const has = (tag) => new RegExp('[（(]\\\\s*' + tag + '\\\\s*[）)]').test(t);
  if (has('已探测') || has('可展开') || has('空标签') || has('质量待确认')) return false;
  return true;
};
const isRealConstraintList = (constraints) => {
  if (!Array.isArray(constraints)) return false;
  return constraints.some((c) => String(c || '').trim());
};
const studentSignalsExhausted = () => false;
`;

const fn = new Function(
  `${deps}\n${js}\nreturn { countEffectiveStep1Dimensions, computeStep1DimensionsSufficient, step1PerSideStatus, formatStep1MissingSideHint };`,
);
const api = fn() as {
  countEffectiveStep1Dimensions: (dims: any) => number;
  computeStep1DimensionsSufficient: (eval_: any, opts?: { exhausted?: boolean }) => boolean;
  step1PerSideStatus: (dims: string[], type: string, exhausted: boolean) => any;
  formatStep1MissingSideHint: (type: string, dims: string[], exhausted: boolean) => string;
};

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.error(`  ✗ ${name} ${detail}`); }
};

// ===== 1. inferProbeVerdictFromStudentMessage 单测 =====
console.log("--- 1. 服务端裁决推断 ---");
check("空回答 → thin", inferProbeVerdictFromStudentMessage("") === "thin");
check("没有 → thin", inferProbeVerdictFromStudentMessage("没有") === "thin");
check("暂时还没有 → thin", inferProbeVerdictFromStudentMessage("暂时还没有") === "thin");
check("想不出来 → thin", inferProbeVerdictFromStudentMessage("想不出来") === "thin");
check("不太清楚 → thin", inferProbeVerdictFromStudentMessage("不太清楚") === "thin");
check("还没想好 → thin", inferProbeVerdictFromStudentMessage("还没想好") === "thin");
check("没有具体例子 → thin", inferProbeVerdictFromStudentMessage("没有具体例子") === "thin");
check("含具体内容 → expandable", inferProbeVerdictFromStudentMessage("上班的人可以根据自己的日程来选择上课时间，不用遵循固定的时间表，也可以选择不同城市的学校，可以在线上远程上课") === "expandable");
check("含具体内容2 → expandable", inferProbeVerdictFromStudentMessage("线下可以和老师同学面对面交流，双方都能清楚地感受到对方的反应") === "expandable");
check("含具体内容3 → expandable", inferProbeVerdictFromStudentMessage("学校里有老师的监管，有固定的学习课表，网上的课程就更考验自觉性") === "expandable");
check("拒绝但带解释内容 → expandable（偏向可展开）", inferProbeVerdictFromStudentMessage("没有具体的，但可能跟成本有关") === "expandable");

// ===== 2. 逐轮探针 resolve（复现实机三轮） =====
console.log("--- 2. 逐轮探针盖章（模型不返回 probeVerdict 时走服务端推断） ---");
// 学生第 1 轮列出 3 个裸角度 → 服务端 probe-first 挂起 pendingProbeCore=便利性（模拟）
let dims: string[] = ["时间和地点上的便利程度", "互动效果", "监管强度"];
// 模型下一轮返回时可能自报（已探测）（可展开）——先被 stripIllegalSameTurnProbeTags 剥掉（不信任自报）
dims = stripIllegalSameTurnProbeTags(
  ["时间和地点上的便利程度（已探测）（可展开）", "互动效果", "监管强度"],
  [],
).dims;
// 服务端推断（模型没给 probeVerdict）
const verdict1 = inferProbeVerdictFromStudentMessage(
  "上班的人可以根据自己的日程来选择上课时间，不用遵循固定的时间表，也可以选择不同城市的学校，可以在线上远程上课",
);
check("便利性 推断=expandable", verdict1 === "expandable");
dims = resolvePendingProbeAnswer(dims, "时间和地点上的便利程度", verdict1);
check("便利性 →（已探测）（可展开）", hasStep1StatusTag(dims[0], STEP1_PROBE_PROBED) && hasStep1StatusTag(dims[0], STEP1_PROBE_EXPANDABLE) && !hasStep1StatusTag(dims[0], STEP1_PROBE_THIN));

const verdict2 = inferProbeVerdictFromStudentMessage(
  "线下可以和老师同学面对面交流，双方都能清楚地感受到对方的反应",
);
check("互动效果 推断=expandable", verdict2 === "expandable");
dims = resolvePendingProbeAnswer(dims, "互动效果", verdict2);
check("互动效果 →（已探测）（可展开）", hasStep1StatusTag(dims[1], STEP1_PROBE_PROBED) && hasStep1StatusTag(dims[1], STEP1_PROBE_EXPANDABLE) && !hasStep1StatusTag(dims[1], STEP1_PROBE_THIN));

const verdict3 = inferProbeVerdictFromStudentMessage(
  "学校里有老师的监管，有固定的学习课表，网上的课程就更考验自觉性",
);
check("监管强度 推断=expandable", verdict3 === "expandable");
dims = resolvePendingProbeAnswer(dims, "监管强度", verdict3);
check("监管强度 →（已探测）（可展开）", hasStep1StatusTag(dims[2], STEP1_PROBE_PROBED) && hasStep1StatusTag(dims[2], STEP1_PROBE_EXPANDABLE) && !hasStep1StatusTag(dims[2], STEP1_PROBE_THIN));

console.log("  最终 dims:", JSON.stringify(dims, null, 2));

// ===== 3. 最终充分性（与 enforceStep1SlotCompletion 同一批纯函数） =====
console.log("--- 3. 最终充分性 ---");
const effective = api.countEffectiveStep1Dimensions(dims);
check("effectiveDims=3（不再为 0）", effective === 3, `实际=${effective}`);
const suff = api.computeStep1DimensionsSufficient({
  correctType: "Agree / Disagree",
  suggestedDimensions: dims,
  dimensionsSufficient: undefined,
});
check("dimsSufficient=true（可进入第二步）", suff === true, `实际=${suff}`);

// ===== 4. 学生耗尽 + 全 thin 时按侧逃生仍放行（F2 slotsOk 前提） =====
console.log("--- 4. 耗尽逃生（防御性） ---");
const thinDims = dims.map((d) => {
  const core = stripStep1StatusTags(d);
  return `${core}（已探测）（空标签）`;
});
const perSideEx = api.step1PerSideStatus(thinDims, "Agree / Disagree", true);
check("exhausted + 全 thin → 按侧放行", perSideEx.pass === true, JSON.stringify(perSideEx.sides));
const suffEx = api.computeStep1DimensionsSufficient(
  { correctType: "Agree / Disagree", suggestedDimensions: thinDims },
  { exhausted: true },
);
check("exhausted → dimsSufficient 逃生放行", suffEx === true, `实际=${suffEx}`);

// ===== 5. 薄弱侧提示措辞兼容 =====
console.log("--- 5. 薄弱侧提示 ---");
const hint = api.formatStep1MissingSideHint("Agree / Disagree", thinDims, false);
check("提示含「整体角度」与有效角度计数", hint.includes("整体角度") && hint.includes("有效角度"));
check("提示不再暴露内部术语「该侧」", !hint.includes("该侧"), hint);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
