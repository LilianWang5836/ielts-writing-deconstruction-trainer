// P4 验收：润色失败对用户可见（validatePolishedText 回退 + polishReverted 持久化）。
// 用法：npx tsx scripts/verify-p4-polish.mts
import {
  validatePolishedText,
  appendMinute,
} from "../src/server/step3/secretary";
import type { Step3Subpoint } from "../src/types";

let fail = 0;
const check = (name: string, cond: boolean) => {
  console.log(cond ? `✓ ${name}` : `✗ ${name}`);
  if (!cond) fail += 1;
};

// 1) 合理轻润色（去口水词/顺语序，保留原义）→ 应通过校验，返回整理稿（displayText 有值）。
const rawLight = "通勤路上可以听课程的回放，比较方便";
const polishedLight = "通勤路上可以听课程回放，比较方便";
const r1 = validatePolishedText(rawLight, polishedLight);
check("轻润色通过校验（返回整理稿）", typeof r1 === "string" && r1.length > 0);

// 2) 加料/整句重写（新增事实/语义）→ 应回退（返回 null → 看板显示原话 + polishReverted）。
const rawHeavy = "通勤路上可以听课程回放";
const polishedHeavy = "远程办公极大提升了员工的效率与生活品质，还显著促进了经济发展与创新";
const r2 = validatePolishedText(rawHeavy, polishedHeavy);
check("加料润色被拦截（返回 null）", r2 === null);

// 3) 同义替换/大改 → 应回退（长度与覆盖率双关）。
const raw3 = "在教室里学生每天都能和同学面对面说话一起做事";
const polished3 = "校园环境中，青少年们每时每刻都可以与同伴展开即时交谈、协作与互动，从而建立深厚的情谊并形成良好的社会网络";
const r3 = validatePolishedText(raw3, polished3);
check("大改重写被拦截（返回 null）", r3 === null);

// 4) appendMinute 持久化 polishReverted（模拟落槽路径）。
const sp: Step3Subpoint = {
  id: "body-1",
  content: "x",
  isCompleted: false,
  minutes: [],
  activeSlotIndex: 0,
};
const m = appendMinute(sp, "student", rawHeavy, {
  displayText: r2 || undefined,
  polishReverted: r2 === null ? true : undefined,
});
check("回退时 minute 带 polishReverted=true", m.polishReverted === true);
check("回退时 minute 无 displayText", m.displayText === undefined);
check("minute 原话保留（真相源）", m.text === rawHeavy);

// 5) 通过时 minute 带 displayText、无 polishReverted。
const sp2: Step3Subpoint = { id: "body-2", content: "y", isCompleted: false, minutes: [] };
const m2 = appendMinute(sp2, "student", rawLight, {
  displayText: r1 || undefined,
  polishReverted: r1 === null ? true : undefined,
});
check("通过时 minute 有 displayText", m2.displayText === polishedLight);
check("通过时无 polishReverted", !m2.polishReverted);

console.log(fail === 0 ? "\nALL P4 POLISH CASES PASS" : `\n${fail} CASE(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
