// Step3 修复回归（2026-08-19）：reopen 保留原文 + meta 新形态 + reuseQuote 历史回填 + lens hint 优先级。
// 用法：npx tsx scripts/verify-step3-reuse-reopen.mts
//
// 覆盖（对应修复计划 Step3 组 #1/#2/#8/#9）：
// 1. reopenSlot → minute 为 landed 且保留 slotKey/原文，再走确认写板成功；
// 2. meta 新形态「这前面不是已经解释了，…」被判 meta（不落槽）；
// 3. meta 反例（纯内容句）不误判；
// 4. reuseQuote 子串校验通过 → 引用文本落槽；伪造引用（历史中不存在）→ 拒绝且不落槽；
// 5. lens hint 优先级：llmHint 优先于 lens.hint。
import {
  appendMinute,
  appendAudit,
  landMinuteToSlot,
  commitPendingMinute,
  reopenSlot,
  renderBoard,
} from "../src/server/step3/secretary";
import { resolveLandingGate, findSlotDef } from "../src/server/step3/lens";
import { isMetaComment, validateReuseQuote } from "../src/server/step3/meta";
import type { Step3Subpoint, Step3Skeleton } from "../src/types";

const skeleton: Step3Skeleton = {
  blocks: [
    {
      id: "pb1",
      label: "分点1",
      subClaim: "超长时间工作损害健康",
      role: "major",
      slots: [
        { key: "pb1_s1", label: "分论点", placeholder: "…", semantic: "claim" },
        { key: "pb1_s2", label: "展开原因", placeholder: "…", semantic: "reason" },
        { key: "pb1_s3", label: "具体机制", placeholder: "…", semantic: "mechanism" },
      ],
    },
  ],
  chainType: "cause_effect",
};

function makeSubpoint(): Step3Subpoint {
  return {
    id: "body-1",
    content: "超长时间工作损害健康",
    isCompleted: false,
    skeleton,
    minutes: [],
    activeSlotIndex: 0,
    landingLog: [],
  } as any;
}

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  cond
    ? (pass++, console.log(`  ✓ ${name}`))
    : (fail++, console.error(`  ✗ ${name} ${detail}`));
};

// ============ 1. reopenSlot → landed 保留 slotKey/原文 → 确认写板 ============
console.log("\n== 1. reopenSlot 保留原文 + 确认写板 ==");
{
  const sp = makeSubpoint();
  const m1 = appendMinute(sp, "student", "超长时间高强度工作会导致心理压力变大");
  const l1 = landMinuteToSlot(sp, m1);
  check("slot1 落槽", l1.ok && l1.slotKey === "pb1_s1");
  commitPendingMinute(sp, m1);
  check("slot1 已确认", m1.status === "confirmed");

  const r = reopenSlot(sp, "pb1_s1");
  check("reopen ok", r.ok === true);
  check("reopen 后 minute 为 landed 且保留 slotKey", m1.status === "landed" && m1.slotKey === "pb1_s1");
  check("reopen 后原文保留", m1.text === "超长时间高强度工作会导致心理压力变大");
  const board = renderBoard(sp);
  check(
    "看板渲染为带原文的待确认草稿",
    board.blocks[0].slots[0].status === "draft" &&
      board.blocks[0].slots[0].pending === "超长时间高强度工作会导致心理压力变大",
  );

  // 再走确认写板（学生对「对」/点【确认写板】按钮）
  commitPendingMinute(sp, m1);
  check("确认写板成功（恢复 confirmed）", m1.status === "confirmed" && m1.slotKey === "pb1_s1");
  check(
    "重放一致（reopened → landed 语义）",
    (() => {
      const log = sp.landingLog || [];
      const last = [...log].reverse().find((e) => e.minuteId === m1.id);
      return last?.event === "confirmed";
    })(),
  );
}

// ============ 2/3. meta 新形态判定 + 反例不误判 ============
console.log("\n== 2. meta 新形态判 meta ==");
{
  check(
    "反问形态「这前面不是已经解释了，…」判 meta",
    isMetaComment("这前面不是已经解释了，超长时间高强度工作导致心理压力变大"),
  );
  check("「前面不是已经说过了」判 meta", isMetaComment("前面不是已经说过了"));
  check("「那个前面已经提了」判 meta", isMetaComment("那个前面已经提了"));
  check("旧锚定形态仍判 meta", isMetaComment("我前面已经说过了啊"));
}
console.log("\n== 3. meta 反例（纯内容句）不误判 ==");
{
  check("纯内容句不判 meta", !isMetaComment("超长时间高强度工作导致心理压力变大"));
  check("含「不是已经」但非言说动词不判 meta", !isMetaComment("压力不是已经存在的问题，而是新出现的"));
  check("「前面已经发生的拥堵」不判 meta", !isMetaComment("前面已经发生的交通拥堵会加剧通勤压力"));
  check("普通回答不判 meta", !isMetaComment("因为通勤时间太长，所以节省在路上的时间很重要"));
}

// ============ 4. reuseQuote 历史回填通道 ============
console.log("\n== 4. reuseQuote 子串校验 + 历史回填 ==");
{
  const sp = makeSubpoint();
  // body-2 的一条历史学生发言（跨 body），另含一条带 displayText 的纪要
  const otherSp = {
    id: "body-2",
    minutes: [
      { id: "x1", role: "student", text: "远程办公节省了每天两小时的通勤时间", ts: 1, status: "recorded" },
      { id: "x2", role: "coach", text: "很好，我们继续。", ts: 2, status: "recorded" },
      {
        id: "x3",
        role: "student",
        text: "平台把课程切成短课",
        displayText: "平台把课程切成短课时，学生可以随时回看",
        ts: 3,
        status: "confirmed",
        slotKey: "pb1_s1",
      },
    ],
  };
  const session: any = { step3: { subpoints: [sp, otherSp] } };

  // 校验通过：跨 body 历史原文子串
  const quote = "远程办公节省了每天两小时的通勤时间";
  check("跨 body 子串校验通过", validateReuseQuote(session, quote) === quote);
  // 校验通过：displayText 子串
  check(
    "displayText 子串校验通过",
    validateReuseQuote(session, "学生可以随时回看") === "学生可以随时回看",
  );
  // 伪造引用：历史中不存在 → 拒绝
  check("伪造引用被拒绝", validateReuseQuote(session, "政府应该补贴所有在线课程") === null);
  check("过短引用被拒绝", validateReuseQuote(session, "好的") === null);
  check("coach 发言不可被引用", validateReuseQuote(session, "很好，我们继续") === null);

  // 模拟 meta 命中 + 无 pending → reuse 回填：meta 不落槽，引用文本落槽
  const metaMinute = appendMinute(sp, "student", "这前面不是已经解释了，远程办公节省了每天两小时的通勤时间");
  appendAudit(sp, metaMinute.id, "held", undefined, "meta 发言，不落槽", {
    verdict: "meta",
    source: "meta",
  });
  check("meta 分钟不落槽", metaMinute.status === "recorded" && !metaMinute.slotKey);

  const validated = validateReuseQuote(session, quote);
  const reuseMinute = appendMinute(sp, "student", validated!);
  const land = landMinuteToSlot(sp, reuseMinute);
  check("引用文本落到目标槽", land.ok && land.slotKey === "pb1_s1" && reuseMinute.status === "landed");
  check(
    "落槽文本是引用原文而非 meta 消息",
    reuseMinute.text === "远程办公节省了每天两小时的通勤时间",
  );
  const board = renderBoard(sp);
  check("看板 pending 为引用文本", board.blocks[0].slots[0].pending === "远程办公节省了每天两小时的通勤时间");

  // affirm（「对」）确认流程兼容 reuse 落槽
  commitPendingMinute(sp, reuseMinute);
  check("reuse 落槽后确认写板成功", reuseMinute.status === "confirmed" && reuseMinute.slotKey === "pb1_s1");

  // 伪造引用场景：校验失败 → 不落任何槽（按无 reuseQuote 处理）
  const sp2 = makeSubpoint();
  const forged = validateReuseQuote({ step3: { subpoints: [sp2] } }, "学生从没说过的内容");
  check("伪造引用不落槽", forged === null && (sp2.minutes || []).every((m) => m.status !== "landed"));
}

// ============ 5. lens hint 优先级：llmHint 优先 ============
console.log("\n== 5. resolveLandingGate hint 优先级 ==");
{
  const sp = makeSubpoint();
  const slot = findSlotDef(sp.skeleton, "pb1_s1")!;
  // thin 情形：lens 自带 hint；传入 llmHint 时必须优先采用 llmHint
  const g = resolveLandingGate({
    text: "很灵活。",
    slot,
    confirmed: [],
    llmVerdict: "thin",
    llmHint: "你提到「很灵活」——具体是哪种场景下灵活？补一个例子。",
  });
  check("llmHint 优先于 lens.hint", g.hint === "你提到「很灵活」——具体是哪种场景下灵活？补一个例子。", `got=${g.hint}`);
  // 无 llmHint 时回退 lens.hint
  const g2 = resolveLandingGate({ text: "很灵活。", slot, confirmed: [] });
  check("无 llmHint 时回退 lens.hint", !!g2.hint && g2.hint.includes("具体"), `got=${g2.hint}`);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
console.log("全部通过 ✅");
