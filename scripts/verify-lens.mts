/**
 * P2 判断透镜 — 确定性评估单测（无 LLM）
 * 运行：npx tsx scripts/verify-lens.mts
 */
import {
  evaluateMinute,
  findSlotDef,
  formatLensAnchor,
  LENS_CHAIN_CONSTRAINTS,
  LENS_GENERAL_RULES,
} from '../src/server/step3/lens.ts';
import { toSkeleton } from '../src/utils/step3Skeleton.ts';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name} ${detail}`));
};

const bodyPlan: any = {
  id: 'body-1', targetBody: 'Body 1', role: 'major', argumentRelation: 'supports',
  paragraphPlan: { mode: 'single_point', diagnosis: 'test', pointBlocks: [
    { id: 'pb1', label: '分论点 1', subClaim: '在线学习更灵活', role: 'major', expansionStrategy: 'mechanism', steps: [
      { key: 'pb1_s1', label: '分论点', placeholder: '完整主张句', value: '' },
      { key: 'pb1_s2', label: '展开原因', placeholder: '因果链', value: '' },
      { key: 'pb1_s3', label: '具体机制', placeholder: '可操作的链条', value: '' },
      { key: 'pb1_s4', label: '结果/影响', placeholder: '可感知的结果', value: '' },
    ] },
  ] },
};
const skeleton = toSkeleton(bodyPlan)!;
const confirmed: any[] = [];

// 空回答 → thin
check('空回答 thin', evaluateMinute('', skeleton.blocks[0].slots[0], confirmed).verdict === 'thin');

// claim 槽：完整主张 → ok
check(
  'claim 完整主张 ok',
  evaluateMinute('在线学习最大的好处是时间灵活，能利用碎片时间随时学习。', skeleton.blocks[0].slots[0], confirmed).verdict === 'ok',
);

// claim 槽：含因果主张句 → ok（不是 off_target，完整主张可含原因）
check(
  'claim 因果主张句 ok',
  evaluateMinute('因为通勤时间长，所以线下上课很费时间，而线上更高效。', skeleton.blocks[0].slots[0], confirmed).verdict === 'ok',
);

// reason 槽：太短 → thin
check(
  'reason 太短 thin',
  evaluateMinute('因为方便。', skeleton.blocks[0].slots[1], confirmed).verdict === 'thin',
);

// mechanism 槽：与 confirmed 重复 → duplicate
const c1: any = { status: 'confirmed', slotKey: 'pb1_s1', text: '在线学习最大的好处是时间灵活，能利用碎片时间随时学习。' };
check(
  'mechanism 复读 duplicate',
  evaluateMinute('在线学习最大好处就是时间灵活，能利用碎片时间随时学习。', skeleton.blocks[0].slots[2], [c1]).verdict === 'duplicate',
);

// impact 槽：答成机制 → off_target
check(
  'impact 答成机制 off_target',
  evaluateMinute('平台把课程切成短课时，配合进度追踪自动提醒。', skeleton.blocks[0].slots[3], confirmed).verdict === 'off_target',
);

// impact 槽：可感知的结果 → ok
check(
  'impact 可感知结果 ok',
  evaluateMinute('长期坚持学习，职业技能提升，职业竞争力明显增强。', skeleton.blocks[0].slots[3], confirmed).verdict === 'ok',
);

// 具体机制回答 → ok
check(
  'mechanism 具体 ok',
  evaluateMinute('平台把课程切成短课时，配合进度追踪和自动提醒，逐段完成学习。', skeleton.blocks[0].slots[2], confirmed).verdict === 'ok',
);

// 抽象口号 → thin
check(
  '抽象口号 thin',
  evaluateMinute('这样很好，很重要。', skeleton.blocks[0].slots[1], confirmed).verdict === 'thin',
);

// findSlotDef
check('findSlotDef 命中', findSlotDef(skeleton, 'pb1_s3')?.label === '具体机制');
check('findSlotDef 未命中', findSlotDef(skeleton, 'nope') === null);

// formatLensAnchor 非空
check('formatLensAnchor 含期望', formatLensAnchor(skeleton.blocks[0].slots[0], 'support').includes('期望'));

// 配置可编辑存在性
check('通用原则 ≥4 条', LENS_GENERAL_RULES.length >= 4);
check('链型约束覆盖 6 类', Object.keys(LENS_CHAIN_CONSTRAINTS).length === 6);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
console.log('全部通过 ✅');
