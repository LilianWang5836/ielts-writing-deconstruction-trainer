/**
 * 会议秘书核心逻辑本地验证（无 LLM，纯确定性）
 * 运行：npx tsx scripts/verify-secretary.mjs
 */
import {
  appendMinute,
  landMinuteToSlot,
  commitPendingMinute,
  renderBoard,
  isSkeletonComplete,
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

const sp: any = { id: 'body-1', content: '在线学习更灵活', skeleton: toSkeleton(bodyPlan), minutes: [], activeSlotIndex: 0 };
if (!sp.skeleton) { console.error('FAIL: skeleton 生成失败'); process.exit(1); }
console.log('✓ skeleton 生成:', sp.skeleton.blocks.length, 'block,', sp.skeleton.blocks[0].slots.length, 'slots');

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };

// 1. 学生回答 claim → landed
let m1 = appendMinute(sp, 'student', '在线学习最大的好处是时间灵活，能利用碎片时间。');
let r1 = landMinuteToSlot(sp, m1);
check('claim 落槽', r1.ok && r1.slotKey === 'pb1_s1' && m1.status === 'landed');
check('claim 落 activeSlotIndex=0', sp.activeSlotIndex === 0);

// 2. 确认 → confirmed
commitPendingMinute(sp, m1);
check('claim confirmed', m1.status === 'confirmed');
check('confirmed 后 renderBoard 有内容', renderBoard(sp).blocks[0].slots[0].content.length > 0);

// 3. 学生回答 reason → landed
let m2 = appendMinute(sp, 'student', '因为通勤时间长，线下上课要花大量时间在路上。');
let r2 = landMinuteToSlot(sp, m2);
check('reason 落槽', r2.ok && r2.slotKey === 'pb1_s2' && m2.status === 'landed');

// 4. 重复内容 → rejected（与 confirmed 的 claim 真复读）
let mDup = appendMinute(sp, 'student', '在线学习最大的好处是时间灵活，能利用碎片时间。');
let rDup = landMinuteToSlot(sp, mDup);
check('dup 预检 rejected', !rDup.ok && mDup.status === 'rejected' && !!mDup.rejectReason);

// 5. 确认 reason
commitPendingMinute(sp, m2);
check('reason confirmed', m2.status === 'confirmed');

// 6. 填满剩余 → isSkeletonComplete
let m3 = appendMinute(sp, 'student', '平台把课程切成短课时，配合进度追踪和提醒，逐段完成。');
landMinuteToSlot(sp, m3); commitPendingMinute(sp, m3);
let m4 = appendMinute(sp, 'student', '长期坚持学习，职业技能提升，职业竞争力增强。');
landMinuteToSlot(sp, m4); commitPendingMinute(sp, m4);

const board = renderBoard(sp);
check('全部 4 槽 confirmed', board.filledSlots === 4 && board.totalSlots === 4);
check('isSkeletonComplete', isSkeletonComplete(sp) === true);
check('isComplete 投影', board.isComplete === true);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
console.log('全部通过 ✅');
