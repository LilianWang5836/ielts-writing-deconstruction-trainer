/**
 * Replay: P2a — merge 按 pointBlock id 对齐。
 * 验证：
 * 1) hydrateBodyPlansFromPayload 按位置绑定给每个 pointBlock 打 mappedPointId 戳
 *    （经 redirects 解析为最终 id）；
 * 2) mergeParagraphPlanPreserveBlocks 在 label 变化时仍保留 mappedPointId 稳定身份。
 * Run: npx tsx scripts/replay-merge-by-id.mjs
 */
import assert from 'node:assert/strict';
import { hydrateBodyPlansFromPayload } from '../src/server/step2/planner-payload.ts';
import { mergeParagraphPlanPreserveBlocks } from '../src/utils/step3Quality.ts';

const check = (name, fn) => {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    throw e;
  }
};

const payload = {
  points: [
    { id: 'p_online', claim: '线上学习的灵活性与资源可及性', retentionRole: 'detail' },
    { id: 'p_network', claim: '网络普及（原因）', retentionRole: 'detail' },
    { id: 'p_offline', claim: '线下课堂对低龄学生的监督作用', retentionRole: 'detail' },
    { id: 'p_merged', claim: '旧点（已并入）', retentionRole: 'detail', supersededBy: 'p_online' },
  ],
  redirects: { p_legacy: 'p_online' },
};

const bodyPlans = [
  {
    id: 'body-1',
    mappedPointIds: ['p_online', 'p_legacy'],
    paragraphPlan: {
      mode: 'direct_points',
      pointBlocks: [
        { id: 'pb1', label: '分论点 1', subClaim: '', role: 'major', steps: [] },
        { id: 'pb2', label: '分论点 2', subClaim: '', role: 'minor', steps: [] },
      ],
    },
  },
];

const hydrated = hydrateBodyPlansFromPayload(bodyPlans, payload);
const blocks = hydrated[0].paragraphPlan.pointBlocks;

check('水合按位置给块打 mappedPointId（pb1 ↔ p_online）', () => {
  assert.equal(blocks[0].mappedPointId, 'p_online');
});

check('水合经 redirects 解析后打 id（pb2 ↔ p_legacy→p_online）', () => {
  // p_legacy redirect 到 p_online：块绑定到最终解析 id
  assert.equal(blocks[1].mappedPointId, 'p_online');
});

check('水合同步 subClaim（claim 句）', () => {
  assert.equal(blocks[0].subClaim, '线上学习的灵活性与资源可及性');
});

// merge 保 id 身份：模型下一轮把 pb1 的 label 改写成更自然的分论点句，
// mappedPointId 必须保留（稳定身份），供框架守卫按 id 对齐。
const prevPlan = {
  mode: 'direct_points',
  pointBlocks: [
    {
      id: 'pb1',
      mappedPointId: 'p_online',
      label: '线上学习的灵活性与资源可及性',
      subClaim: '线上学习提供时间与空间灵活性',
      role: 'major',
      expansionStrategy: 'mechanism',
      steps: [
        { key: 'pb1_s1', label: '分论点', value: '线上学习时间灵活', status: 'confirmed' },
      ],
    },
  ],
};
const nextPlan = {
  mode: 'direct_points',
  pointBlocks: [
    {
      id: 'pb1',
      label: '线上学习帮在职人员省通勤时间', // label 被 reclass/确认改写
      subClaim: '线上学习提供时间与空间灵活性',
      role: 'major',
      expansionStrategy: 'mechanism',
      steps: [
        { key: 'pb1_s1', label: '分论点', value: '线上学习时间灵活', status: 'confirmed' },
      ],
    },
  ],
};
const merged = mergeParagraphPlanPreserveBlocks(prevPlan, nextPlan);

check('merge 后 mappedPointId 稳定身份保留', () => {
  assert.equal(merged.pointBlocks[0].mappedPointId, 'p_online');
  assert.equal(merged.pointBlocks[0].label, '线上学习帮在职人员省通勤时间');
});

check('merge 保留确认 value（骨架锁语义不回归）', () => {
  assert.equal(merged.pointBlocks[0].steps[0].value, '线上学习时间灵活');
  assert.equal(merged.pointBlocks[0].steps[0].status, 'confirmed');
});
