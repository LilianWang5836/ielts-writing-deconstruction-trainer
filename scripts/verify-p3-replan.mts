// P3 验收：结构异议重规划执行（applyStep3StructureReplan）——确定性逻辑验证。
// 从 server.ts 提取真实函数（转译去 TS 类型），验证"确认后清空 Step3 + stale step2_5"。
// 用法：npx tsx scripts/verify-p3-replan.mts
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const serverPath = fileURLToPath(new URL("../server.ts", import.meta.url));
const src = fs.readFileSync(serverPath, "utf8");

const fnName = "function applyStep3StructureReplan(";
const startIdx = src.indexOf(fnName);
// 找到该函数结束：从函数体末尾的下一个顶层 function 作为边界
const blockEnd = src.indexOf("function enforceStep3SecretaryPath(");
if (startIdx < 0 || blockEnd < 0 || blockEnd <= startIdx) {
  console.error("FAIL: applyStep3StructureReplan not found");
  process.exit(2);
}
const blockTs = src.slice(startIdx, blockEnd);
const js = ts
  .transpileModule(blockTs, { compilerOptions: { target: ts.ScriptTarget.ES2020 } })
  .outputText;
const api = new Function(`${js}\nreturn { applyStep3StructureReplan };`)() as {
  applyStep3StructureReplan: (session: any) => void;
};

let fail = 0;
const check = (name: string, cond: boolean) => {
  console.log(cond ? `✓ ${name}` : `✗ ${name}`);
  if (!cond) fail += 1;
};

const session: any = {
  step3: {
    subpoints: [
      {
        id: "body-1",
        minutes: [{ id: "m1", status: "confirmed", slotKey: "pb1_s1", text: "x" }],
        skeleton: { blocks: [] },
        activeSlotIndex: 2,
        landingLog: [{ minuteId: "m1", event: "confirmed" }],
        isCompleted: true,
        pendingStructureOffer: { askedAt: 1 },
        step3SlotEval: { activeKey: "pb1_s1" },
        kickoffPendingDrafts: [],
        paragraphPlan: { mode: "single_point", pointBlocks: [] },
        structureSteps: [],
        chatHistory: [{ id: "c1", sender: "user", text: "hi" }],
      },
      {
        id: "body-2",
        minutes: [{ id: "m2", status: "landed", slotKey: "pb2_s1", text: "y" }],
        skeleton: { blocks: [] },
        activeSlotIndex: 0,
        landingLog: [],
        isCompleted: false,
      },
    ],
    activeSubpointId: "body-1",
    isCompleted: true,
  },
  step2_5: { status: "passed", bodyPlans: [] },
};

api.applyStep3StructureReplan(session);

const sp1 = session.step3.subpoints[0];
check("body-1 minutes 已清空", Array.isArray(sp1.minutes) && sp1.minutes.length === 0);
check("body-1 skeleton 已清空", sp1.skeleton === undefined);
check("body-1 activeSlotIndex 已清空", sp1.activeSlotIndex === undefined);
check("body-1 landingLog 已清空", Array.isArray(sp1.landingLog) && sp1.landingLog.length === 0);
check("body-1 isCompleted 重置", sp1.isCompleted === false);
check("body-1 pendingStructureOffer 已清", sp1.pendingStructureOffer === undefined);
check("body-1 step3SlotEval 已清", sp1.step3SlotEval === undefined);
check("body-1 kickoffPendingDrafts 已清", sp1.kickoffPendingDrafts === undefined);
check("body-1 paragraphPlan 已清", sp1.paragraphPlan === undefined);
check("body-1 structureSteps 已清", sp1.structureSteps === undefined);
check("body-1 chatHistory 保留", Array.isArray(sp1.chatHistory) && sp1.chatHistory.length === 1);
const sp2 = session.step3.subpoints[1];
check("body-2 也被清空", Array.isArray(sp2.minutes) && sp2.minutes.length === 0 && sp2.skeleton === undefined);
check("step3.activeSubpointId 已清", session.step3.activeSubpointId === undefined);
check("step3.isCompleted 重置", session.step3.isCompleted === false);
check("step2_5 标记 stale", session.step2_5.status === "stale");
check("step2_5.bodyPlans 保留", Array.isArray(session.step2_5.bodyPlans));

console.log(fail === 0 ? "\nALL P3 REPLAN CASES PASS" : `\n${fail} CASE(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
