// T1 验收：Step1 侧别标签服务端加固（preserveStep1ProbeTags 恢复丢失的侧标签等）。
// 用法：npx tsx scripts/verify-t1-side-preserve.mts
import {
  preserveStep1ProbeTags,
  resolvePendingProbeAnswer,
  buildBareDimensionProbeAsk,
} from "../src/server/step1/dimension-probe";

let fail = 0;
const check = (name: string, cond: boolean) => {
  console.log(cond ? `✓ ${name}` : `✗ ${name}`);
  if (!cond) fail += 1;
};

// 1) 改写丢侧标签 → 恢复 prior 的侧标签 + 状态戳
const prior1 = ["经济发展（侧：A）（已探测）（可展开）", "健康（侧：B）（已探测）（空标签）"];
const rewrite1 = ["经济发展（已探测）（可展开）"]; // 丢了（侧：A）
const r1 = preserveStep1ProbeTags(rewrite1, prior1);
check("丢侧标签 → 恢复 prior 侧标签 A", r1.dims[0].includes("（侧：A）"));
check("丢侧标签 → 状态戳仍在", r1.dims[0].includes("（已探测）") && r1.dims[0].includes("（可展开）"));

// 2) LLM 显式换侧 A→B → 尊重新值 B（不恢复 prior 的 A）
const rewrite2 = ["经济发展（侧：B）（已探测）（可展开）"];
const r2 = preserveStep1ProbeTags(rewrite2, prior1);
check("换侧 A→B → 尊重新值 B", r2.dims[0].includes("（侧：B）") && !r2.dims[0].includes("（侧：A）"));

// 3) core 匹配不受侧标签有无影响：prior 带侧、新轮不带侧，仍能匹配同一 core
const r3 = preserveStep1ProbeTags(["经济发展（可展开）"], ["经济发展（侧：A）（已探测）（可展开）"]);
check("core 匹配不受侧标签影响（恢复后含侧A）", r3.dims[0].includes("（侧：A）") && r3.dims[0].includes("（已探测）"));

// 4) 新维度无 prior → 不加杜撰侧标签
const r4 = preserveStep1ProbeTags(["全新维度（已探测）（可展开）"], ["经济（侧：A）（已探测）（可展开）"]);
const fresh = r4.dims.find((d) => d.includes("全新维度"));
check("新维度不加杜撰侧标签", !!fresh && !fresh.includes("（侧：") && fresh.includes("（已探测）"));

// 5) re-append 保留 prior 侧标签（prior 有而新轮整体缺失的维度被补回）
const r5 = preserveStep1ProbeTags(["经济（侧：A）（已探测）（可展开）"], [
  "经济（侧：A）（已探测）（可展开）",
  "健康（侧：B）（已探测）（空标签）",
]);
const reappended = r5.dims.find((d) => d.includes("健康"));
check("re-append 保留侧标签 B", !!reappended && reappended.includes("（侧：B）") && reappended.includes("（空标签）"));

// 6) 连带坑：resolvePendingProbeAnswer 在带侧标签维度上正确解析（core 匹配需剥离侧标签）
const resolved = resolvePendingProbeAnswer(
  ["经济发展（侧：A）"],
  "经济发展", // server 端 pendingProbeCore 已剥离状态+侧标签
  "expandable",
);
check("resolvePendingProbeAnswer 匹配剥离侧标签", resolved[0].includes("（已探测）") && resolved[0].includes("（可展开）") && resolved[0].includes("（侧：A）"));

// 7) 探针文案不泄露侧标签
const ask = buildBareDimensionProbeAsk("经济发展（侧：A）");
check("探针文案不泄露侧标签", !ask.includes("（侧：A）") && ask.includes("经济发展"));

console.log(fail === 0 ? "\nALL T1 SIDE-PRESERVE CASES PASS" : `\n${fail} CASE(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
