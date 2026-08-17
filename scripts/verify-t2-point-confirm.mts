// T2 验收：每侧批量确认并入 side_settle（points.confirmed + planner 只消费已确认点）。
// 用法：npx tsx scripts/verify-t2-point-confirm.mts
import { commitProposal, validateProposal } from "../src/server/step2/proposal";
import { isPointConfirmed, plannerPayloadFingerprint } from "../src/server/step2/planner-payload";
import type { Step2PlannerPayload, Step2Proposal } from "../src/types";

let fail = 0;
const check = (name: string, cond: boolean) => {
  console.log(cond ? `✓ ${name}` : `✗ ${name}`);
  if (!cond) fail += 1;
};

function makePayload(): Step2PlannerPayload {
  return {
    points: [
      { id: "p1", claim: "经济", elaboration: "具体场景…", leanTags: ["view_a"], quality: "ready", confirmed: false },
      { id: "p2", claim: "文化", elaboration: "具体场景…", leanTags: ["view_a"], quality: "ready", confirmed: false },
      { id: "p3", claim: "自由", elaboration: "具体场景…", leanTags: ["view_b"], quality: "ready", confirmed: false },
    ],
    sideSettled: [],
    requiresStance: true,
    coverage: { requiredBuckets: ["view_a", "view_b"], filledBuckets: ["view_a", "view_b"], missingBuckets: [] },
    exitGate: { canComplete: false },
  } as Step2PlannerPayload;
}

// 1) isPointConfirmed：新点 false → 未确认；true → 已确认；legacy undefined + 侧已 settled → 已确认（读取侧迁移）
const payload0 = makePayload();
check("confirmed=false → 未确认", isPointConfirmed(payload0, payload0.points[0]) === false);
check("confirmed=true → 已确认", isPointConfirmed(payload0, { ...payload0.points[0], confirmed: true }) === true);
const legacySettled = makePayload();
legacySettled.sideSettled = ["view_a"];
const legacyPt = { ...legacySettled.points[0], confirmed: undefined as boolean | undefined };
check("legacy undefined + 侧已settled → 已确认（读取侧迁移）", isPointConfirmed(legacySettled, legacyPt) === true);
const legacyUnsettled = makePayload();
legacyUnsettled.sideSettled = [];
const legacyPt2 = { ...legacyUnsettled.points[0], confirmed: undefined as boolean | undefined };
check("legacy undefined + 侧未settled → 未确认", isPointConfirmed(legacyUnsettled, legacyPt2) === false);

// 2) side_settle 采纳 → 该侧全部点 confirmed:true + 详略锁定；他侧不变
const sideSettle: Step2Proposal = {
  proposalId: "settle-test",
  kind: "side_settle",
  rationale: "test",
  payload: {
    side: "view_a",
    assignments: [
      { slotId: "p1", role: "detail" },
      { slotId: "p2", role: "brief" },
    ],
  },
};
check("side_settle 提案校验通过", validateProposal(makePayload(), sideSettle).ok === true);
const committed = commitProposal({ payload: makePayload(), proposal: sideSettle, userPoints: "" });
check("side_settle 提交成功", committed.ok === true);
const p1 = committed.payload.points.find((p) => p.id === "p1")!;
const p2 = committed.payload.points.find((p) => p.id === "p2")!;
const p3 = committed.payload.points.find((p) => p.id === "p3")!;
check("采纳后 p1 confirmed=true + 详写", p1.confirmed === true && p1.retentionRole === "detail");
check("采纳后 p2 confirmed=true + 略写", p2.confirmed === true && p2.retentionRole === "brief");
check("采纳后他侧 p3 仍未确认", p3.confirmed === false);
check("采纳后该侧进入 sideSettled", (committed.payload.sideSettled || []).includes("view_a"));

// 3) slot_add 采纳 → 新点直接 confirmed:true
const slotAdd: Step2Proposal = {
  proposalId: "slotadd-test",
  kind: "slot_add",
  payload: { claim: "教育", body: "具体…", side: "view_a" },
};
const committed2 = commitProposal({ payload: makePayload(), proposal: slotAdd, userPoints: "" });
const newPt = committed2.payload.points.find((p) => p.claim === "教育")!;
check("slot_add 新点 confirmed=true", newPt.confirmed === true);

// 4) 指纹含确认态：确认翻转 → 指纹变化（step2_5 stale 依赖）
const fpBefore = plannerPayloadFingerprint(makePayload());
const fpAfter = plannerPayloadFingerprint(committed.payload);
check("确认态变化 → 指纹变化", fpBefore !== fpAfter);

console.log(fail === 0 ? "\nALL T2 POINT-CONFIRM CASES PASS" : `\n${fail} CASE(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
