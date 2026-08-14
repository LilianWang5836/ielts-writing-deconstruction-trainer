/**
 * Replay: Step3 framework coverage guard reads the planner ledger
 * (bodyPlans.mappedPointIds + plannerPayload.points[].retentionRole), so
 * dimension-phrase mapped points are NOT dropped. Previously the guard read
 * subpoint.points which the client filtered by isClaimSentence → empty →
 * guard silently exited → Step3 lost mapped points ("网络普及" incident).
 * Run: npx tsx scripts/replay-framework-coverage.mjs
 */
import assert from 'node:assert/strict';
import { ensureParagraphPlanCoversFrameworkPoints } from '../src/utils/step3Quality.ts';

const makePlan = () => ({
  mode: 'direct_points',
  diagnosis: '',
  pointBlocks: [
    {
      id: 'pb1',
      label: '文化多样性（跨文化交流）',
      subClaim: '',
      role: 'major',
      steps: [{ key: 'pb1_s1', label: '分论点', value: '' }],
    },
  ],
});

const check = (name, fn) => {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}`);
    throw e;
  }
};

check('ledger 维度短语被补块（不再静默退出）', () => {
  const plan = makePlan();
  const appended = ensureParagraphPlanCoversFrameworkPoints(
    plan,
    { id: 'body-1', points: [], pointRoles: [] }, // 旧 bug：客户端过滤后为空
    [{ label: '网络普及（原因）', role: 'detail' }],
  );
  assert.equal(appended.length, 1, '应补 1 个块');
  assert.ok(appended[0].includes('网络普及'), `补块标签=${appended[0]}`);
  assert.ok(plan.pointBlocks.some((b) => b.label.includes('网络普及')));
});

check('detail → major 3 步', () => {
  const plan = makePlan();
  ensureParagraphPlanCoversFrameworkPoints(
    plan,
    { points: [] },
    [{ label: '网络普及（原因）', role: 'detail' }],
  );
  const b = plan.pointBlocks.find((x) => x.label.includes('网络普及'));
  assert.ok(b, '应存在补出的块');
  assert.equal(b.role, 'major');
  assert.equal(b.steps.length, 3);
});

check('brief → minor 1 步', () => {
  const plan = makePlan();
  ensureParagraphPlanCoversFrameworkPoints(
    plan,
    { points: [] },
    [{ label: '全球消费主义', role: 'brief' }],
  );
  const b = plan.pointBlocks.find((x) => x.label.includes('全球消费主义'));
  assert.ok(b, '应存在补出的块');
  assert.equal(b.role, 'minor');
  assert.equal(b.steps.length, 1);
});

check('dropped 不补块', () => {
  const plan = makePlan();
  const appended = ensureParagraphPlanCoversFrameworkPoints(
    plan,
    { points: [] },
    [{ label: '被放下的点', role: 'dropped' }],
  );
  assert.equal(appended.length, 0);
});

check('已覆盖的点不重复补', () => {
  const plan = makePlan();
  const appended = ensureParagraphPlanCoversFrameworkPoints(
    plan,
    { points: [] },
    [{ label: '文化多样性（跨文化交流）', role: 'detail' }],
  );
  assert.equal(appended.length, 0, '已表示的点不补');
});

check('无 ledger 回退 subpoint.points（向后兼容）', () => {
  const plan = makePlan();
  const appended = ensureParagraphPlanCoversFrameworkPoints(
    plan,
    { points: [], pointRoles: [] },
  );
  assert.equal(appended.length, 0, '空 points 静默返回，不崩');

  const plan2 = makePlan();
  const appended2 = ensureParagraphPlanCoversFrameworkPoints(plan2, {
    points: ['文化多样性（跨文化交流）'],
    pointRoles: [{ point: '文化多样性（跨文化交流）', role: 'major' }],
  });
  assert.equal(appended2.length, 0, '旧路径已表示的点不补');
});
