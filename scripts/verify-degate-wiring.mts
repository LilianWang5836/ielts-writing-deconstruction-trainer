/**
 * V1.1：Step2/Step3 接入共享意图路由——接线回归（2026-08-18）。
 *
 * 1) Step2：直接调用真实 `classifyStep2StudentTurnHeuristic`，断言共享路由富集后的行为：
 *    - 长句"想不出别的角度" → unknown（不再误判为 content_elaboration）
 *    - 待提案槽位：accept → accept_slot_add；短句 object（排除增量）→ reject_slot_add；
 *      "继续" 不误判为采纳；"补充一个例子" 不误判为拒绝
 *    - 纯确认富集："没问题/可以啊/好嘞/对对/确认" → confirm_ack
 * 2) Step3（server.ts 秘书路径）+ Step2（server.ts 两处 exhausted）：源码断言接线存在。
 *
 * 用法：npx tsx scripts/verify-degate-wiring.mts
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyStep2StudentTurnHeuristic,
} from "../src/server/step2/student-turn-intent.ts";

const serverPath = fileURLToPath(new URL("../server.ts", import.meta.url));
const src = fs.readFileSync(serverPath, "utf8");

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.error(`  ✗ ${name} ${detail}`); }
};

console.log("--- Step2 启发式（真实模块）---");
{
  const h = (msg: string, opts: { hasPendingSlotAdd?: boolean; coachAsk?: string } = {}) =>
    classifyStep2StudentTurnHeuristic({ userMessage: msg, ...opts });

  // 长句耗尽不再误判为内容（去门禁化关键）
  const ex = h("我暂时想不出别的角度了，就先这样吧");
  check("长句耗尽 → unknown（不误判 content）", ex.kind === "unknown", JSON.stringify(ex));

  // 待提案槽位
  const a1 = h("可以", { hasPendingSlotAdd: true });
  check("待提案 + 可以 → accept_slot_add", a1.kind === "accept_slot_add", JSON.stringify(a1));
  const a2 = h("没问题", { hasPendingSlotAdd: true });
  check("待提案 + 没问题 → accept_slot_add", a2.kind === "accept_slot_add", JSON.stringify(a2));
  const a3 = h("继续", { hasPendingSlotAdd: true });
  check("待提案 + 继续 → 不误判为采纳", a3.kind !== "accept_slot_add", JSON.stringify(a3));
  const r1 = h("换成别的", { hasPendingSlotAdd: true });
  check("待提案 + 换成别的 → reject_slot_add", r1.kind === "reject_slot_add", JSON.stringify(r1));
  const r2 = h("补充一个例子", { hasPendingSlotAdd: true });
  check("待提案 + 补充一个例子 → 不误判为拒绝", r2.kind !== "reject_slot_add", JSON.stringify(r2));

  // 纯确认富集（共享路由新增覆盖）
  for (const m of ["没问题", "可以啊", "好嘞", "对对", "确认"]) {
    const c = h(m);
    check(`${m} → confirm_ack`, c.kind === "confirm_ack", JSON.stringify(c));
  }

  // 展开不了家族 → exhausted → unknown（不误判为内容）
  for (const m of ["这个点我大概就想到这些，暂时展开不了更多了", "展开不出来"]) {
    const c = h(m);
    check(`展开不了（${m.slice(0, 12)}…）→ unknown`, c.kind === "unknown", JSON.stringify(c));
  }
}

console.log("--- Step3 秘书暂略接线（server.ts 源码断言）---");
{
  const skipBlockIdx = src.indexOf("const isSkipAsk =");
  const skipBlock = src.slice(skipBlockIdx, skipBlockIdx + 900);
  check(
    "秘书跳过出口接入 exhausted 意图（isStudentExhausted）",
    /const exhaustedIntent = isStudentExhausted\(msg\)/.test(skipBlock) &&
      /\(isSkipAsk \|\| exhaustedIntent\)/.test(skipBlock),
  );
  check(
    "跳过触发条件含目标槽被拒≥2（防误伤）",
    /targetRejectedCount >= 2/.test(skipBlock),
  );
}

console.log("--- Step3 接线（server.ts 源码断言）---");
{
  // isAff 接入 accept
  const affIdx = src.indexOf("const isAff =");
  const affBlock = src.slice(affIdx, affIdx + 260);
  check(
    "Step3 isAff 接入 classifyStudentReply==accept",
    /classifyStudentReply\(msg\) === "accept"/.test(affBlock),
  );
  // isRej 接入 object（含增量表达排除）
  const rejIdx = src.indexOf("const isRej =");
  const rejBlock = src.slice(rejIdx, rejIdx + 300);
  check(
    "Step3 isRej 接入 object + 排除增量表达",
    /classifyStudentReply\(msg\) === "object"/.test(rejBlock) &&
      /还有一\|补充一\|再补\|等等/.test(rejBlock),
  );
  // isSkipAsk 接入 skip
  const skipIdx = src.indexOf("const isSkipAsk =");
  const skipBlock = src.slice(skipIdx, skipIdx + 260);
  check(
    "Step3 isSkipAsk 接入 classifyStudentReply==skip",
    /classifyStudentReply\(msg\) === "skip"/.test(skipBlock),
  );
}

console.log("--- Step2 接线（server.ts 源码断言）---");
{
  const exploreIdx = src.indexOf("function isStep2ExploreDone(");
  const exploreBlock = src.slice(exploreIdx, exploreIdx + 500);
  check(
    "isStep2ExploreDone 接入 isStudentExhausted",
    /isStudentExhausted\(args\.userMessage\)/.test(exploreBlock),
  );
  const retentionIdx = src.indexOf("const forceExitUsed = Boolean(");
  const retentionBlock = src.slice(retentionIdx - 300, retentionIdx + 120);
  check(
    "retention-lock exhausted 接入 isStudentExhausted",
    /isStudentExhausted\(userMessage\)/.test(retentionBlock),
  );
  const s2path = fileURLToPath(new URL("../src/server/step2/student-turn-intent.ts", import.meta.url));
  const s2src = fs.readFileSync(s2path, "utf8");
  check(
    "student-turn-intent.ts 接入 classifyStudentReply",
    /import \{ classifyStudentReply \} from '\.\.\/intent-router'/.test(s2src) &&
      /const coarse = classifyStudentReply\(msg\)/.test(s2src),
  );
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
