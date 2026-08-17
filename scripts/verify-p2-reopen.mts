// P2 验收：Step3 已确认槽修订入口（reopenSlot）——确定性逻辑验证。
// 用法：npx tsx scripts/verify-p2-reopen.mts
import {
  appendMinute,
  landMinuteToSlot,
  commitPendingMinute,
  reopenSlot,
  renderBoard,
  isSkeletonComplete,
  activeSlotLabel,
} from "../src/server/step3/secretary";
import type { Step3Subpoint, Step3Skeleton } from "../src/types";

const skeleton: Step3Skeleton = {
  blocks: [
    {
      id: "pb1",
      label: "分点1",
      subClaim: "论点1",
      role: "major",
      slots: [
        { key: "pb1_s1", label: "分论点", placeholder: "…", semantic: "claim" },
        { key: "pb1_s2", label: "展开原因", placeholder: "…", semantic: "reason" },
        { key: "pb1_s3", label: "具体例子", placeholder: "…", semantic: "example" },
      ],
    },
  ],
  chainType: "support",
};

function makeSubpoint(): Step3Subpoint {
  const sp: any = {
    id: "body-1",
    content: "论点1",
    isCompleted: false,
    skeleton,
    minutes: [],
    activeSlotIndex: 0,
    landingLog: [],
  };
  return sp as Step3Subpoint;
}

let fail = 0;
const check = (name: string, cond: boolean) => {
  console.log(cond ? `✓ ${name}` : `✗ ${name}`);
  if (!cond) fail += 1;
};

// 场景：确认 slot1、slot2，然后 reopen slot2
const sp = makeSubpoint();
const m1 = appendMinute(sp, "student", "线上学习更灵活");
const l1 = landMinuteToSlot(sp, m1);
check("slot1 落槽成功", l1.ok && l1.slotKey === "pb1_s1");
commitPendingMinute(sp, m1);
check("slot1 已确认", m1.status === "confirmed");

const m2 = appendMinute(sp, "student", "通勤路上可以听课");
const l2 = landMinuteToSlot(sp, m2);
check("slot2 落槽成功", l2.ok && l2.slotKey === "pb1_s2");
commitPendingMinute(sp, m2);
check("slot2 已确认", m2.status === "confirmed");

const before = renderBoard(sp);
check("reopen 前：2 槽已确认", before.filledSlots === 2);

const r = reopenSlot(sp, "pb1_s2");
check("reopen 返回 ok", r.ok === true);
check("reopen 后 slot2 minute 回退 recorded", m2.status === "recorded" && !m2.slotKey);
check("reopen 后 slot1 仍 confirmed", m1.status === "confirmed" && m1.slotKey === "pb1_s1");
const after = renderBoard(sp);
check("reopen 后看板：slot2 变空", after.filledSlots === 1 && after.blocks[0].slots[1].status === "empty");
check("reopen 后 body 未完成", isSkeletonComplete(sp) === false);
check("reopen 有 reopened 审计事件", sp.landingLog!.some((e: any) => e.event === "reopened" && e.slotKey === "pb1_s2"));
check("activeSlotLabel 指向展开原因", activeSlotLabel(sp) === "展开原因");

// 重新作答并确认 → 复用 pending→confirm 路径
const m3 = appendMinute(sp, "student", "通勤或午休的碎片时间可以听课程回放");
const l3 = landMinuteToSlot(sp, m3);
check("重答后落回 slot2", l3.ok && l3.slotKey === "pb1_s2");
commitPendingMinute(sp, m3);
check("重答确认后 slot2 恢复 confirmed", m3.status === "confirmed" && m3.slotKey === "pb1_s2");
check("重答后 body 仍未全完（slot3 空）", isSkeletonComplete(sp) === false);

// 对未确认槽 reopen → 失败
const r2 = reopenSlot(sp, "pb1_s3");
check("对未确认槽 reopen 返回失败", r2.ok === false);

console.log(fail === 0 ? "\nALL P2 LOGIC CASES PASS" : `\n${fail} CASE(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
