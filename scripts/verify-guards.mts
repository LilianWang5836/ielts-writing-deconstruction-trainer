/**
 * P3 判断护栏 — 确定性护栏单测（无 LLM）
 *
 * 运行：npx tsx scripts/verify-guards.mts
 *
 * 覆盖：
 * 1. 切题预检（isOffTopic / evaluateMinute off_topic）
 * 2. 教练卡死检测（detectStall）
 * 3. 护栏不充当模板校验器（不误伤内容性回答）
 */
import {
  evaluateMinute,
  isOffTopic,
} from '../src/server/step3/lens.ts';
import {
  appendMinute,
  landMinuteToSlot,
  commitPendingMinute,
  detectStall,
} from '../src/server/step3/secretary.ts';
import { toSkeleton } from '../src/utils/step3Skeleton.ts';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name} ${detail}`));
};

const bodyPlan: any = {
  id: 'body-1', targetBody: 'Body 1', role: 'major', argumentRelation: 'supports',
  paragraphPlan: { mode: 'single_point', diagnosis: 't', pointBlocks: [
    { id: 'pb1', label: '分论点 1', subClaim: '在线学习更灵活', role: 'major', expansionStrategy: 'mechanism', steps: [
      { key: 'pb1_s1', label: '分论点', placeholder: '主张', value: '' },
      { key: 'pb1_s2', label: '展开原因', placeholder: '原因', value: '' },
      { key: 'pb1_s3', label: '具体机制', placeholder: '机制', value: '' },
      { key: 'pb1_s4', label: '结果/影响', placeholder: '影响', value: '' },
    ] },
  ] },
};
const skeleton = toSkeleton(bodyPlan)!;
const slot0 = skeleton.blocks[0].slots[0];

// ===== 1. 切题预检 =====
console.log('--- 切题预检 (P3) ---');
check('完全跑题 → off_topic', evaluateMinute('我们去吃饭吧', slot0, []).verdict === 'off_topic');
check('离开任务 → off_topic', evaluateMinute('换个题目吧', slot0, []).verdict === 'off_topic');
check('请求澄清 → off_topic', evaluateMinute('没听懂你说的意思', slot0, []).verdict === 'off_topic');
check('纯元对话 → off_topic', evaluateMinute('怎么操作？', slot0, []).verdict === 'off_topic');

// 不误伤：内容性回答即使短/偏薄也不判 off_topic
check('内容性回答不误判 off_topic', evaluateMinute('在线学习时间灵活是优势', slot0, []).verdict !== 'off_topic');
check('表达困难不误判 off_topic', evaluateMinute('这道题我不太会', slot0, []).verdict !== 'off_topic');
check('isOffTopic 纯函数', isOffTopic('我们去吃饭吧') === true && isOffTopic('在线学习灵活') === false);

// ===== 2. 教练卡死检测 =====
console.log('--- 教练卡死检测 (P3) ---');
const sp: any = { id: 'body-1', content: '在线学习更灵活', skeleton, minutes: [], activeSlotIndex: 0 };

// 正常：同一槽 1 次 landed → 不卡死
let m1 = appendMinute(sp, 'student', '在线学习最大的好处是时间灵活，能利用碎片时间随时学习。');
landMinuteToSlot(sp, m1);
let s1 = detectStall(sp);
check('单次 landed 不卡死', s1.stalled === false, JSON.stringify(s1));

// 正常：确认后推进 → 不卡死
commitPendingMinute(sp, m1);
check('确认后不卡死', detectStall(sp).stalled === false);

// 异常：同一槽反复 landed 从未确认（连续 4 次）→ 卡死
// 注意：pb1_s1 已确认，后续 landed 应落在 pb1_s2（下一空槽）
for (let i = 0; i < 4; i++) {
  const m = appendMinute(sp, 'student', `换一个说法试试第${i + 2}遍的在线学习优势描述。`);
  landMinuteToSlot(sp, m);
}
const stall = detectStall(sp);
check('连续 landed 未确认 → 卡死', stall.stalled === true, JSON.stringify(stall));
check('卡死槽 = pb1_s2', stall.slotKey === 'pb1_s2');
check('卡死槽 label 正确', stall.slotLabel === '展开原因');
check('attempts ≥ 4', stall.attempts >= 4);

// 卡死阈值：3 次 → 未卡死，4 次 → warn，6 次 → hard
const sp2: any = { id: 'body-1', content: 'x', skeleton, minutes: [], activeSlotIndex: 0 };
for (let i = 0; i < 3; i++) {
  const m = appendMinute(sp2, 'student', `第${i + 1}遍在线学习的好处描述。`);
  landMinuteToSlot(sp2, m);
}
check('3 次 → 未卡死（阈值 4）', detectStall(sp2).stalled === false);
const sp2b: any = { id: 'body-1', content: 'x', skeleton, minutes: [], activeSlotIndex: 0 };
for (let i = 0; i < 4; i++) {
  const m = appendMinute(sp2b, 'student', `第${i + 1}遍在线学习的好处描述。`);
  landMinuteToSlot(sp2b, m);
}
check('4 次 → warn', detectStall(sp2b).stalled === true && detectStall(sp2b).level === 'warn');
const sp3: any = { id: 'body-1', content: 'x', skeleton, minutes: [], activeSlotIndex: 0 };
for (let i = 0; i < 6; i++) {
  const m = appendMinute(sp3, 'student', `第${i + 1}遍在线学习的好处描述。`);
  landMinuteToSlot(sp3, m);
}
check('6 次 → hard', detectStall(sp3).stalled === true && detectStall(sp3).level === 'hard');

// 空 minutes → 不卡死
const spEmpty: any = { id: 'body-1', content: 'x', skeleton, minutes: [], activeSlotIndex: 0 };
check('空 minutes 不卡死', detectStall(spEmpty).stalled === false);

// ===== 3. 护栏不充当模板校验器 =====
console.log('--- 护栏不充当模板校验器 (P3) ---');
// detectStall 只报警不改结构：卡死后 skeleton 结构不变
const skeletonBefore = JSON.stringify(sp.skeleton);
detectStall(sp);
check('卡死检测不改 skeleton 结构', JSON.stringify(sp.skeleton) === skeletonBefore);
// 卡死检测不改 activeSlotIndex（结构推进仍由秘书决定）
const idxBefore = sp.activeSlotIndex;
detectStall(sp);
check('卡死检测不改 activeSlotIndex', sp.activeSlotIndex === idxBefore);
// evaluateMinute 不改 minutes
const minutesBefore = sp.minutes.length;
evaluateMinute('测试', slot0, []);
check('评估不改 minutes', sp.minutes.length === minutesBefore);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
console.log('全部通过 ✅');
