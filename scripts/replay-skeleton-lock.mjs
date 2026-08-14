/**
 * Replay: ③ 骨架硬传承 — enforceStep3SkeletonLock。
 * 验证：教练回合返回的 plan 被对齐到 planner 骨架（块级结构冻结），
 * 结构性 diff（增/删/改序/改角色）被拒收；value 级修改被保留。
 * Run: npx tsx scripts/replay-skeleton-lock.mjs
 */
import assert from 'node:assert/strict';
import { enforceStep3SkeletonLock } from '../src/utils/step3Quality.ts';

// Planner 骨架：2 个点（对应两个 mapped point）。
const skeleton = {
  mode: 'direct_points',
  diagnosis: '',
  pointBlocks: [
    {
      id: 'pb1',
      label: '网络普及',
      subClaim: '',
      role: 'major',
      expansionStrategy: 'mechanism',
      steps: [
        { key: 'pb1_s1', label: '分论点', value: '', status: '' },
        { key: 'pb1_s2', label: '展开原因', value: '', status: '' },
        { key: 'pb1_s3', label: '典型场景', value: '', status: '' },
      ],
    },
    {
      id: 'pb2',
      label: '文化多样性',
      subClaim: '',
      role: 'minor',
      expansionStrategy: 'explanation',
      steps: [{ key: 'pb2_s1', label: '补充点', value: '', status: '' }],
    },
  ],
};

const check = (name, fn) => {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    throw e;
  }
};

check('模型新增块 → 拒收，骨架保留', () => {
  const plan = JSON.parse(JSON.stringify(skeleton));
  plan.pointBlocks.push({
    id: 'pb_EXTRA',
    label: '模型发明的第三个点',
    role: 'minor',
    steps: [{ key: 'pb_EXTRA_s1', label: '补充', value: 'x', status: 'draft' }],
  });
  const rejected = enforceStep3SkeletonLock(plan, skeleton);
  assert.equal(rejected, 1, '应拒收 1 个模型块');
  assert.equal(plan.pointBlocks.length, 2, '骨架块数保留');
  assert.ok(!plan.pointBlocks.some((b) => b.id === 'pb_EXTRA'));
});

check('模型删块 → 骨架块补回', () => {
  const plan = JSON.parse(JSON.stringify(skeleton));
  plan.pointBlocks = [plan.pointBlocks[0]]; // 模型丢掉了 pb2
  const rejected = enforceStep3SkeletonLock(plan, skeleton);
  assert.equal(plan.pointBlocks.length, 2, 'pb2 应被补回');
  assert.ok(plan.pointBlocks.some((b) => b.id === 'pb2'));
});

check('模型改块顺序/角色 → 按骨架恢复', () => {
  const plan = JSON.parse(JSON.stringify(skeleton));
  plan.pointBlocks.reverse(); // pb2 在前
  plan.pointBlocks.forEach((b) => {
    b.role = 'major';
    b.label = '被改的标签';
  });
  enforceStep3SkeletonLock(plan, skeleton);
  assert.equal(plan.pointBlocks[0].id, 'pb1', '顺序恢复');
  assert.equal(plan.pointBlocks[0].role, 'major');
  assert.equal(plan.pointBlocks[0].label, '网络普及', '标签恢复为骨架');
  assert.equal(plan.pointBlocks[1].role, 'minor');
});

check('模型填 value → 保留（value 级修改允许）', () => {
  const plan = JSON.parse(JSON.stringify(skeleton));
  plan.pointBlocks[0].steps[1].value = '因为网络普及降低门槛';
  plan.pointBlocks[0].steps[1].status = 'draft';
  enforceStep3SkeletonLock(plan, skeleton);
  assert.equal(plan.pointBlocks[0].steps[1].value, '因为网络普及降低门槛');
  assert.equal(plan.pointBlocks[0].steps[1].status, 'draft');
  // 未触碰的 step 仍在
  assert.equal(plan.pointBlocks[0].steps.length, 3);
});

check('模型在块内新增 step key → 允许追加（槽内 reclass/合并）', () => {
  const plan = JSON.parse(JSON.stringify(skeleton));
  plan.pointBlocks[0].steps.push({
    key: 'pb1_reclass',
    label: '归对的角色',
    value: 'v',
    status: 'draft',
  });
  enforceStep3SkeletonLock(plan, skeleton);
  assert.ok(
    plan.pointBlocks[0].steps.some((s) => s.key === 'pb1_reclass'),
    '块内新 key 保留',
  );
});
