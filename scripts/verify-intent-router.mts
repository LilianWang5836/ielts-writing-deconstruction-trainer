/**
 * ① 学生意图路由单测（V1 去门禁化，2026-08-18）。
 *
 * 覆盖：粗粒度 6 类（exhausted/object/accept/clarify/content/unknown）
 * 的判定与顺序规则（object 优先于 accept；"进入下一步"=exhausted）。
 *
 * 用法：npx tsx scripts/verify-intent-router.mts
 */
import assert from "node:assert/strict";
import {
  classifyStudentReply,
  isStudentExhausted,
} from "../src/server/intent-router.ts";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.error(`  ✗ ${name} ${detail}`); }
};

const eq = (msg: string, want: string) => {
  const got = classifyStudentReply(msg);
  check(`${msg} → ${want}`, got === want, `实际=${got}`);
};

console.log("--- exhausted ---");
eq("没有", "exhausted");
eq("想不出来了", "exhausted");
eq("够了", "exhausted");
eq("进入下一步", "exhausted");
eq("下一步", "exhausted");
eq("就这些吧", "exhausted");
eq("我暂时想不到别的了", "exhausted");
eq("没有更多的角度了", "exhausted");
eq("这个点我大概就想到这些，暂时展开不了更多了", "exhausted");
eq("展开不出来", "exhausted");
eq("暂时展开不了更多", "exhausted");
eq("这个点我就不硬展开了", "exhausted");

console.log("--- object ---");
eq("第二点换掉", "object");
eq("不对，不是这个意思", "object");
eq("等一下，先别写", "object");
eq("可以，但第三点改成别的", "object"); // object 优先于 accept
eq("把第一个论点删掉", "object");
eq("重写这一段", "object");

console.log("--- accept ---");
eq("对", "accept");
eq("好", "accept");
eq("可以", "accept");
eq("嗯", "accept");
eq("没问题", "accept");
eq("好的", "accept");
eq("ok", "accept");
eq("可以啊", "accept");

console.log("--- clarify ---");
eq("什么意思？", "clarify");
eq("我没听懂，能再说一遍吗", "clarify");
eq("不太明白你的意思", "clarify");
eq("能解释一下吗", "clarify");

console.log("--- content ---");
eq("上班的人可以根据自己的日程来选择上课时间，不用遵循固定的时间表，也可以选择不同城市的学校，可以在线上远程上课", "content");
eq("线下可以和老师同学面对面交流，双方都能清楚地感受到对方的反应", "content");
eq("学校里有老师的监管，有固定的学习课表，网上的课程就更考验自觉性", "content");
eq("我觉得便利性和互动效果是主要区别", "content");

console.log("--- skip ---");
eq("跳过", "skip");
eq("先跳过", "skip");
eq("略过", "skip");
eq("这拍先跳过", "skip");
eq("先不填", "skip");
eq("暂时不填", "skip");
eq("先过", "skip");

console.log("--- isStudentExhausted（exhausted ∪ skip）---");
check("isStudentExhausted: 没有", isStudentExhausted("没有") === true);
check("isStudentExhausted: 进入下一步", isStudentExhausted("进入下一步") === true);
check("isStudentExhausted: 跳过", isStudentExhausted("跳过") === true);
check("isStudentExhausted: 具体内容", isStudentExhausted("上班的人可以根据自己的日程来选择上课时间") === false);
check("isStudentExhausted: 纯确认", isStudentExhausted("可以") === false);

console.log("--- unknown / 边界 ---");
eq("", "unknown");
eq("   ", "unknown");
eq("嗯", "accept"); // 短确认词仍为 accept
eq("emm", "unknown");
check("空输入不抛异常", classifyStudentReply(null as any) === "unknown" || true);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
