/**
 * Step2 详略提案「探索结束门」回归（2026-08-18）。
 *
 * 覆盖计划项：
 *  #3 explore 中途禁止 Priority 3 信息量兜底武装（真实来源/exhausted/walk 完成才可）；
 *  #5 单点侧无真实方案来源 → 不走提案，确定性自动确认（confirmed + detail）；
 *  #4 多点侧提案 ask 文案含 claim+elaboration 全文，无「兜底方案」硬编码、
 *     无「确认写入材料池」旧字样。
 *
 * 用法：npx tsx scripts/verify-step2-settle-gate.mts
 */
import {
  armNextProposal,
  buildAskFromProposal,
} from "../src/server/step2/proposal.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
};

function pt(partial: any) {
  return {
    id: partial.id,
    claim: partial.claim,
    elaboration: partial.elaboration || "",
    leanTags: partial.leanTags || ["part_1"],
    quality: partial.quality || "ready",
    retentionRole: partial.retentionRole,
    fromDimension: partial.fromDimension || partial.claim,
    ...(partial.seedOnly !== undefined ? { seedOnly: partial.seedOnly } : {}),
  };
}

function basePayload(points: any[], extra: any = {}) {
  return {
    version: 1,
    status: "draft",
    updatedAt: new Date().toISOString(),
    questionType: "Two-part Question",
    requiresStance: true,
    slotsLocked: true,
    stance: { text: "", polarity: "unknown", strength: "unknown" },
    points,
    redirects: {},
    dimensionDispositions: [],
    coverage: {
      passed: false,
      requiredBuckets: ["part_1", "part_2"],
      filledBuckets: [],
      missingBuckets: ["part_1", "part_2"],
      softMissingBuckets: [],
    },
    exitGate: { canComplete: false, canForceExit: false, forceExitUsed: false },
    sideSettled: [],
    pendingProposal: null,
    ...extra,
  } as any;
}

const P1 = () =>
  pt({
    id: "p1",
    claim: "强势文化冲击（原因）",
    leanTags: ["part_1"],
    elaboration: "外来影视作品流行，使人们认为外来文化更新潮高级，冷落本土文化",
    seedOnly: false,
  });
const P2 = () =>
  pt({
    id: "p2",
    claim: "网络普及（原因）",
    leanTags: ["part_1"],
    elaboration: "信息传播速度更快规模更大，传统文化易被跨国文化淹没",
    seedOnly: false,
  });
// 尚未落槽的 Step1 pending 维度（与板上点不兼容 → 探索未结束信号）。
const PENDING_DIM = {
  dimension: "全球消费主义（原因）",
  disposition: "pending",
};

console.log("--- #3 探索结束门：explore 中途禁止兜底武装 ---");
{
  // 多点侧、内容均已展开，但还有未落槽 pending 维度 → 兜底提案不得武装。
  const payload = basePayload([P1(), P2()], {
    dimensionDispositions: [
      { dimension: "强势文化冲击（原因）", disposition: "expanded" },
      { ...PENDING_DIM },
    ],
  });
  const armed = armNextProposal({ payload });
  check("未落槽 pending 维度存在 → 不武装兜底提案", armed === null, String(armed));
  check(
    "中途不确认任何点（无副作用提交）",
    payload.points.every((p: any) => p.confirmed !== true),
  );
  check("无 pendingProposal", !payload.pendingProposal);

  // 门条件 c：学生 exhausted → 允许武装。
  const payloadEx = basePayload([P1(), P2()], {
    dimensionDispositions: [{ ...PENDING_DIM }],
  });
  const armedEx = armNextProposal({ payload: payloadEx, exhausted: true });
  check(
    "学生 exhausted → 兜底可武装",
    armedEx?.kind === "side_settle",
    String(armedEx?.kind),
  );

  // 门条件 a：教练文本自带方案 → 中途也可武装。
  const coach = "我推荐详写『强势文化冲击』，略写『网络普及』。\n请点击「采纳」或「拒绝」。";
  const payloadCoach = basePayload([P1(), P2()], {
    dimensionDispositions: [{ ...PENDING_DIM }],
  });
  const armedCoach = armNextProposal({ payload: payloadCoach, coachText: coach });
  check(
    "教练文本自带方案 → 中途即可武装",
    armedCoach?.kind === "side_settle",
    String(armedCoach?.kind),
  );

  // 门条件 d：pending 维度已处置（dropped）→ walk 完成 → 兜底武装。
  const payloadDone = basePayload([P1(), P2()], {
    dimensionDispositions: [
      { dimension: "强势文化冲击（原因）", disposition: "expanded" },
      { dimension: "全球消费主义（原因）", disposition: "dropped" },
    ],
  });
  const armedDone = armNextProposal({ payload: payloadDone });
  check(
    "walk 完成（无未落槽 pending）→ 兜底武装",
    armedDone?.kind === "side_settle",
    String(armedDone?.kind),
  );
}

console.log("--- #5 单点侧自动确认 ---");
{
  // 单侧仅 1 条 active 点、无 fromCoach/retentionSuggestion → 不弹提案，
  // 直接确定性提交：confirmed=true、retentionRole='detail'、侧入 sideSettled。
  const payload = basePayload([P1()]);
  const armed = armNextProposal({ payload });
  check("单点侧不武装提案（返回 null）", armed === null, String(armed));
  const p1 = payload.points.find((p: any) => p.id === "p1");
  check("自动确认 confirmed=true", p1.confirmed === true);
  check("自动锁定 retentionRole=detail", p1.retentionRole === "detail");
  check(
    "侧进入 sideSettled",
    (payload.sideSettled || []).includes("part_1"),
  );
  check("无 pendingProposal", !payload.pendingProposal);

  // 幂等：再次调用不重复提交、不武装。
  const again = armNextProposal({ payload });
  check("已 settled 单点侧再次调用 → 仍无提案", again === null);

  // 单点侧但教练文本自带方案 → 仍走提案（不自动确认）。
  const coach = "我推荐详写『强势文化冲击』。\n请点击「采纳」或「拒绝」。";
  const payloadCoach = basePayload([P1()]);
  const armedCoach = armNextProposal({ payload: payloadCoach, coachText: coach });
  check(
    "单点侧 + 教练方案 → 走提案而非自动确认",
    armedCoach?.kind === "side_settle",
    String(armedCoach?.kind),
  );
  const cp1 = payloadCoach.points.find((p: any) => p.id === "p1");
  check("提案路径不提前 confirmed", cp1.confirmed !== true);

  // 单 pending 槽排队语义：已有 pendingProposal → 原样返回，不重复武装。
  const pendingProp = {
    proposalId: "settle-part_1",
    kind: "side_settle",
    payload: {
      side: "part_1",
      assignments: [{ slotId: "p1", role: "detail" }],
    },
  };
  const payloadPending = basePayload([P1()], { pendingProposal: pendingProp });
  const armedPending = armNextProposal({ payload: payloadPending });
  check(
    "已有 pendingProposal → 原样保留（单 pending 槽）",
    armedPending?.proposalId === "settle-part_1",
    String(armedPending?.proposalId),
  );
}

console.log("--- #4 ask 文案：论点全文 + 无兜底硬编码 ---");
{
  // 多点侧、walk 完成 → 武装兜底提案，ask 含每条 claim+elaboration 全文。
  const p1 = P1();
  const p2 = P2();
  const payload = basePayload([p1, p2]);
  const armed = armNextProposal({ payload });
  check("多点侧 walk 完成 → 武装 side_settle", armed?.kind === "side_settle");
  check(
    "兜底提案不带 rationale",
    (armed as any)?.rationale === undefined,
    String((armed as any)?.rationale),
  );
  const ask = buildAskFromProposal(payload, armed!);
  check("ask 含 p1 claim 全文", ask.includes(p1.claim));
  check("ask 含 p1 elaboration 全文", ask.includes(p1.elaboration));
  check("ask 含 p2 claim 全文", ask.includes(p2.claim));
  check("ask 含 p2 elaboration 全文", ask.includes(p2.elaboration));
  check("ask 语义为确认表述及详略分工", ask.includes("请确认以下论点表述及详略分工"));
  check("ask 无「兜底方案」硬编码", !ask.includes("兜底方案"));
  check(
    "ask 无「确认写入材料池」旧字样",
    !ask.includes("写入材料池"),
    ask.slice(0, 200),
  );
  check("ask 说明看板实时列入（待确认）", ask.includes("待确认"));

  // 真实来源（retentionSuggestion）→ rationale 正常输出。
  const payloadSug = basePayload([P1(), P2()]);
  const armedSug = armNextProposal({
    payload: payloadSug,
    retentionSuggestion: {
      detail: ["网络普及"],
      brief: ["强势文化冲击"],
      reason: "传播机制的因果链最完整",
    },
  });
  const askSug = buildAskFromProposal(payloadSug, armedSug!);
  check(
    "真实来源提案 → ask 含 rationale",
    askSug.includes("因果链"),
    askSug.slice(0, 200),
  );
}

console.log(
  fail === 0 ? `\nALL ${pass} SETTLE-GATE CASES PASS` : `\n${fail} CASE(S) FAILED (${pass} passed)`,
);
process.exit(fail === 0 ? 0 : 1);
