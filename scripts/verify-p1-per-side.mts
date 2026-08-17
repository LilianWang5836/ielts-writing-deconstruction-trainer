// P1 验收：Step1 每问/每侧 ≥2 有效维度门禁（PM 需求 D1）——确定性逻辑验证。
// 从 server.ts 提取真实的 Step1 门禁纯函数（转译去 TS 类型），跑 PM 验收用例。
// 用法：npx tsx scripts/verify-p1-per-side.mts
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

// 依赖 stub（与本次改动的纯逻辑无关的外部函数）
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
  `${deps}\n${js}\nreturn { step1PerSideStatus, formatStep1MissingSideHint, isStep1SlotsComplete, applyStep1DimensionSides };`,
);
const api = fn();

const effective = (side: string, ...labels: string[]) =>
  labels.map((l) => `${l}（侧：${side}）（已探测）（可展开）`);
const eff = (l: string) => `${l}（已探测）（可展开）`;

const cases: {
  name: string;
  type: string;
  dims: string[];
  exhausted: boolean;
  expectPass?: boolean;
  expectHint?: string;
}[] = [
  { name: "双边：A3点/B0点 → 不通过", type: "Discuss Both Views", dims: [...effective("A", "经济", "文化", "教育")], exhausted: false, expectPass: false },
  { name: "双边：A2/B2 → 通过", type: "Discuss Both Views", dims: [...effective("A", "经济", "文化"), ...effective("B", "自由", "传统")], exhausted: false, expectPass: true },
  { name: "同意与否：2点(未标侧) → 通过", type: "Agree / Disagree", dims: [eff("经济"), eff("健康")], exhausted: false, expectPass: true },
  { name: "双边：B仅1点+exhausted → 逃生放行", type: "Discuss Both Views", dims: [...effective("A", "经济", "文化"), ...effective("B", "自由")], exhausted: true, expectPass: true },
  { name: "双边：B0点+exhausted(无标签) → 放行防死锁", type: "Discuss Both Views", dims: [...effective("A", "经济", "文化", "教育")], exhausted: true, expectPass: true },
  { name: "双边：B仅1点+未exhausted → 不通过", type: "Discuss Both Views", dims: [...effective("A", "经济", "文化"), ...effective("B", "自由")], exhausted: false, expectPass: false },
  { name: "两问：第1问/第2问各2 → 通过", type: "Two-part Question", dims: [...effective("A", "原因A", "原因B"), ...effective("B", "措施A", "措施B")], exhausted: false, expectPass: true },
  { name: "双边：A=1+G=1 & B=1+G=1 → 通过", type: "Discuss Both Views", dims: [effective("A", "经济")[0], "通用（侧：G）（已探测）（可展开）", effective("B", "自由")[0], "通用2（侧：G）（已探测）（可展开）"], exhausted: false, expectPass: true },
  { name: "双边：未归属不计入任何侧 → B侧未达标", type: "Discuss Both Views", dims: [...effective("A", "经济", "文化"), eff("游离角度"), eff("另一个游离")], exhausted: false, expectPass: false },
  { name: "双边：B0点 → 提示指向观点B", type: "Discuss Both Views", dims: [...effective("A", "经济", "文化")], exhausted: false, expectHint: "观点B" },
];

let fail = 0;
for (const c of cases) {
  const st = api.step1PerSideStatus(c.dims, c.type, c.exhausted);
  let ok = true;
  if (typeof c.expectPass === "boolean" && st.pass !== c.expectPass) {
    ok = false;
    console.log(`✗ ${c.name}  期望=${c.expectPass} 实际=${st.pass} ${JSON.stringify(st.sides)}`);
  }
  if (c.expectHint) {
    const h = api.formatStep1MissingSideHint(c.type, c.dims, c.exhausted);
    if (!h.includes(c.expectHint)) {
      ok = false;
      console.log(`✗ ${c.name}  提示未指向「${c.expectHint}」：${h}`);
    }
  }
  if (ok) console.log(`✓ ${c.name}`);
  else fail += 1;
}

const gate = api.isStep1SlotsComplete(
  { correctType: "Discuss Both Views", coreIssue: "x", constraints: ["all"], suggestedDimensions: [...effective("A", "经济", "文化"), ...effective("B", "自由", "传统")] },
  { exhausted: false },
);
console.log(gate ? "✓ isStep1SlotsComplete 通过(A2/B2)" : "✗ isStep1SlotsComplete 应通过");
if (!gate) fail += 1;

const gate2 = api.isStep1SlotsComplete(
  { correctType: "Discuss Both Views", coreIssue: "x", constraints: ["all"], suggestedDimensions: [...effective("A", "经济", "文化")] },
  { exhausted: false },
);
console.log(gate2 ? "✗ isStep1SlotsComplete 应拦截(B0)" : "✓ isStep1SlotsComplete 拦截(B0)");
if (gate2) fail += 1;

// ---- F1：结构化 dimensionSides 注入（DeepSeek 不打文内侧签的修复通道） ----
{
  // ① 无侧签维度 + 结构化声明 → 注入侧签后按侧门禁通过（实机主场景）
  const dims = [eff("经济"), eff("文化"), eff("自由"), eff("传统")];
  const sided = api.applyStep1DimensionSides(dims, [
    { dimension: "经济", side: "A" },
    { dimension: "文化", side: "A" },
    { dimension: "自由", side: "B" },
    { dimension: "传统", side: "B" },
  ]);
  const ok =
    sided.every((d: string) => /（侧：[AB]）/.test(d)) &&
    api.step1PerSideStatus(sided, "Discuss Both Views", false).pass;
  console.log(ok ? "✓ F1 结构化注入 → 按侧通过" : `✗ F1 结构化注入失败: ${JSON.stringify(sided)}`);
  if (!ok) fail += 1;
}
{
  // ② 声明里的标签带状态戳（模型复制全串）也能匹配；已有文内侧签不被覆盖
  const dims = ["经济（侧：A）（已探测）（可展开）", "文化（已探测）（可展开）"];
  const sided = api.applyStep1DimensionSides(dims, [
    { dimension: "经济（已探测）（可展开）", side: "B" }, // 试图改侧 → 应被忽略（已有 A）
    { dimension: "文化（已探测）", side: "B" }, // 带部分戳的标签 → 模糊匹配注入
  ]);
  const ok =
    /（侧：A）/.test(sided[0]) &&
    !/（侧：B）/.test(sided[0]) &&
    /文化（侧：B）（已探测）（可展开）/.test(sided[1]);
  console.log(ok ? "✓ F1 已有侧签不覆盖 + 模糊匹配注入" : `✗ F1 覆盖/模糊匹配失败: ${JSON.stringify(sided)}`);
  if (!ok) fail += 1;
}
{
  // ③ 空/非法 sideMap 不改动维度
  const dims = [eff("经济")];
  const same = api.applyStep1DimensionSides(dims, [{ dimension: "经济", side: "X" }]);
  const ok = same[0] === dims[0] && api.applyStep1DimensionSides(dims, null)[0] === dims[0];
  console.log(ok ? "✓ F1 非法 sideMap 不改动" : "✗ F1 非法 sideMap 应原样返回");
  if (!ok) fail += 1;
}

console.log(fail === 0 ? "\nALL P1 LOGIC CASES PASS" : `\n${fail} CASE(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
