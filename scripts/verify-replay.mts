/**
 * P1 可审计落槽 — 重放一致性验证（无 LLM，纯确定性）
 *
 * 运行：npx tsx scripts/verify-replay.mts
 *
 * 验证目标：给定相同的 skeleton + 相同学生消息序列，
 * replayLanding 必须复现与运行时完全一致的落槽结果
 * （slotKey / status / rejectReason）。
 *
 * 场景覆盖：
 * 1. 正常四槽流程（claim→reason→mechanism→impact，逐步确认）
 * 2. duplicate_sibling 拦截（与已确认兄弟槽高度近似）
 * 3. 重放后 renderBoard 与运行时一致
 */
import {
  appendMinute,
  landMinuteToSlot,
  commitPendingMinute,
  renderBoard,
  replayLanding,
} from '../src/server/step3/secretary.ts';
import { toSkeleton } from '../src/utils/step3Skeleton.ts';

const bodyPlan: any = {
  id: 'body-1',
  targetBody: 'Body Paragraph 1',
  role: 'main_argument',
  argumentRelation: 'supports',
  paragraphPlan: {
    mode: 'single_point',
    diagnosis: 'test',
    pointBlocks: [
      {
        id: 'pb1',
        label: '分论点 1',
        subClaim: '在线学习更灵活',
        role: 'major',
        expansionStrategy: 'mechanism',
        steps: [
          { key: 'pb1_s1', label: '分论点', placeholder: '主张', value: '' },
          { key: 'pb1_s2', label: '展开原因', placeholder: '原因', value: '' },
          { key: 'pb1_s3', label: '具体机制', placeholder: '机制', value: '' },
          { key: 'pb1_s4', label: '结果/影响', placeholder: '影响', value: '' },
        ],
      },
    ],
  },
};

const skeleton = toSkeleton(bodyPlan);
if (!skeleton) {
  console.error('FAIL: skeleton 生成失败');
  process.exit(1);
}

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name} ${detail}`));
};

// ---- 构造一个真实的运行时落槽流程 ----
const run: any = { id: 'body-1', content: '在线学习更灵活', skeleton, minutes: [], activeSlotIndex: 0 };

const m1 = appendMinute(run, 'student', '在线学习最大的好处是时间灵活，能利用碎片时间随时学习。');
landMinuteToSlot(run, m1);
commitPendingMinute(run, m1); // pb1_s1 confirmed

const m2 = appendMinute(run, 'student', '因为通勤时间长，线下上课要花大量时间在路上。');
landMinuteToSlot(run, m2);
commitPendingMinute(run, m2); // pb1_s2 confirmed

// dup：与已确认 claim 高度近似 → rejected
const mDup = appendMinute(run, 'student', '在线学习最大好处就是时间灵活，能利用碎片时间随时学习。');
const rDup = landMinuteToSlot(run, mDup);
check('运行时 dup 拦截', !rDup.ok && mDup.status === 'rejected' && !!mDup.rejectReason);

const m3 = appendMinute(run, 'student', '平台把课程切成短课时，配合进度追踪和自动提醒，逐段完成。');
landMinuteToSlot(run, m3);
commitPendingMinute(run, m3); // pb1_s3 confirmed

const m4 = appendMinute(run, 'student', '长期坚持学习，职业技能提升，职业竞争力增强。');
landMinuteToSlot(run, m4);
commitPendingMinute(run, m4); // pb1_s4 confirmed

const runBoard = renderBoard(run);
check('运行时四槽全 confirmed', runBoard.filledSlots === 4 && runBoard.isComplete);

// ---- 审计日志驱动重放（P1：landingLog 已由落槽/确认函数记录）----
check('运行时已生成 landingLog', Array.isArray(run.landingLog) && (run.landingLog as any[]).length >= 8);
const report = replayLanding(run);

check('重放 auditDriven=true', report.auditDriven === true);
check('重放行数 = 学生消息数（含 rejected）', report.rows.length === 5);
check('重放全部一致', report.allConsistent, JSON.stringify(report.rows));

// 逐条核对关键落槽
const byText = (t: string) => report.rows.find((r) => r.text.startsWith(t));
const rClaim = byText('在线学习最大的好处');
const rReason = byText('因为通勤时间长');
const rDupRow = byText('在线学习最大好处就是');
const rMech = byText('平台把课程切成');
const rImpact = byText('长期坚持学习');
check('重放 claim → pb1_s1 confirmed', rClaim?.replayed.status === 'confirmed' && rClaim?.replayed.slotKey === 'pb1_s1');
check('重放 reason → pb1_s2 confirmed', rReason?.replayed.status === 'confirmed' && rReason?.replayed.slotKey === 'pb1_s2');
check('重放 dup → rejected 且 reason 一致', rDupRow?.replayed.status === 'rejected' && !!rDupRow?.replayed.rejectReason);
check('重放 mechanism → pb1_s3 confirmed', rMech?.replayed.status === 'confirmed' && rMech?.replayed.slotKey === 'pb1_s3');
check('重放 impact → pb1_s4 confirmed', rImpact?.replayed.status === 'confirmed' && rImpact?.replayed.slotKey === 'pb1_s4');

// 重放看板 = 运行时看板
check('重放 board.isComplete 一致', report.board.isComplete === runBoard.isComplete);
check('重放 board.filledSlots 一致', report.board.filledSlots === runBoard.filledSlots);

// ---- 边界：空 minutes / 无骨架 ----
const emptyReport = replayLanding({ ...run, minutes: [] });
check('空 minutes 重放一致', emptyReport.allConsistent && emptyReport.rows.length === 0);

// ---- 边界：landed 未确认（审计日志驱动，精确还原 reject/landed 时序）----
const partial: any = { id: 'body-1', content: 'x', skeleton, minutes: [], activeSlotIndex: 0 };
const pm1 = appendMinute(partial, 'student', '第一个论点：核心观点A。');
landMinuteToSlot(partial, pm1); // pb1_s1 landed
const pmDup = appendMinute(partial, 'student', '第一个论点：核心观点A。');
landMinuteToSlot(partial, pmDup); // pb1_s1 重复（pm1 未确认，不拦 → landed）
commitPendingMinute(partial, pm1); // pb1_s1 confirmed
const partialReport = replayLanding(partial);
check('部分流程审计重放一致', partialReport.auditDriven && partialReport.allConsistent, JSON.stringify(partialReport.rows));

// ---- minutes 推断回退（清空 landingLog 模拟旧 session）----
const noLog = { ...run, landingLog: undefined as any };
const fallbackReport = replayLanding(noLog);
check('无 landingLog 回退 minutes 推断一致', fallbackReport.auditDriven === false && fallbackReport.allConsistent, JSON.stringify(fallbackReport.rows.filter((r) => !r.consistent)));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
console.log('全部通过 ✅');
