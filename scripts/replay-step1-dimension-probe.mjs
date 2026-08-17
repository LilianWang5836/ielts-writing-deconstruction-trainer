/**
 * Step1 probe v2 + B-lite replay.
 * Run: node --import tsx/esm scripts/replay-step1-dimension-probe.mjs
 */
import assert from 'node:assert/strict';
import {
  buildBareDimensionProbeAsk,
  countUnprobedStep1Dimensions,
  earliestUnprobedDimension,
  isStep1DimensionUnprobed,
  normalizeProbeVerdict,
  preserveStep1ProbeTags,
  resolvePendingProbeAnswer,
  stampUnprobedQualityPending,
  step1CapProbeComplete,
  stripIllegalSameTurnProbeTags,
  stripStep1StatusTags,
  hasStep1StatusTag,
  textLooksLikeProbeAskForDim,
  STEP1_PROBE_EXPANDABLE,
  STEP1_PROBE_PROBED,
  STEP1_PROBE_THIN,
  STEP1_PROBE_QUALITY_PENDING,
} from '../src/server/step1/dimension-probe.ts';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

check('strip same-turn self-reported expandable on NEW dims only', () => {
  const prior = ['科技网络普及（原因）（已探测）（可展开）'];
  const incoming = [
    '科技网络普及（原因）（已探测）（可展开）',
    '沟通效率（评价）（已探测）（可展开）',
    '商业与经济收益（评价）（已探测）（可展开）',
  ];
  const { dims, strippedCores } = stripIllegalSameTurnProbeTags(incoming, prior);
  assert.equal(dims[0], '科技网络普及（原因）（已探测）（可展开）');
  assert.equal(dims[1], '沟通效率（评价）');
  assert.equal(dims[2], '商业与经济收益（评价）');
  assert.ok(strippedCores.includes('沟通效率（评价）'));
  assert.ok(isStep1DimensionUnprobed(dims[1]));
});

check('6 bare labels stay unprobed (cap alone does NOT stamp)', () => {
  const dims = [
    'a（原因）',
    'b（原因）',
    'c（原因）',
    'd（评价）',
    'e（评价）',
    'f（评价）',
  ];
  assert.equal(countUnprobedStep1Dimensions(dims), 6);
  assert.equal(earliestUnprobedDimension(dims), 'a（原因）');
  assert.equal(step1CapProbeComplete(dims, 6), false);
});

check('cap+all-probed deadlock relief even with zero expandable', () => {
  const dims = [
    'a（原因）（已探测）（空标签）',
    'b（原因）（已探测）（质量待确认）',
    'c（原因）（已探测）（空标签）',
    'd（评价）（已探测）（空标签）',
    'e（评价）（已探测）（空标签）',
    'f（评价）（已探测）（质量待确认）',
  ];
  assert.equal(countUnprobedStep1Dimensions(dims), 0);
  assert.equal(step1CapProbeComplete(dims, 6), true);
});

check('B-lite: expandable verdict stamps 可展开 (strips self-tags)', () => {
  const dims = ['沟通效率（评价）（已探测）（空标签）'];
  const next = resolvePendingProbeAnswer(dims, '沟通效率（评价）', 'expandable');
  assert.ok(hasStep1StatusTag(next[0], STEP1_PROBE_PROBED));
  assert.ok(hasStep1StatusTag(next[0], STEP1_PROBE_EXPANDABLE));
  assert.ok(!hasStep1StatusTag(next[0], STEP1_PROBE_THIN));
  assert.equal(normalizeProbeVerdict('可展开'), 'expandable');
});

check('B-lite: missing verdict defaults to 空标签', () => {
  const dims = ['沟通效率（评价）'];
  const next = resolvePendingProbeAnswer(dims, '沟通效率（评价）', '');
  assert.ok(hasStep1StatusTag(next[0], STEP1_PROBE_PROBED));
  assert.ok(hasStep1StatusTag(next[0], STEP1_PROBE_THIN));
});

check('exhaust escape stamps 质量待确认 on bare labels', () => {
  const dims = [
    '沟通效率（评价）',
    '商业与经济收益（评价）（已探测）（可展开）',
  ];
  const next = stampUnprobedQualityPending(dims);
  assert.ok(hasStep1StatusTag(next[0], STEP1_PROBE_QUALITY_PENDING));
  assert.ok(hasStep1StatusTag(next[0], STEP1_PROBE_PROBED));
  assert.equal(countUnprobedStep1Dimensions(next), 0);
});

check('probe ask detection matches named label', () => {
  const dim = '沟通效率（评价）';
  const ask = buildBareDimensionProbeAsk(dim);
  assert.ok(textLooksLikeProbeAskForDim(`很好。\n\n---\n\n${ask}`, dim));
  assert.ok(
    !textLooksLikeProbeAskForDim(
      '很好。\n\n---\n\n那我们来看第二个任务：评价角度有哪些？',
      dim,
    ),
  );
  assert.ok(ask.includes('「沟通效率（评价）」'));
  assert.ok(!ask.includes('苗头') && !ask.includes('信号'), `still robotic: ${ask}`);
});

check('probe-first order: causes before evaluation', () => {
  const dims = [
    '主流文化冲击（原因）',
    '网络普及（原因）',
    '沟通效率（评价）',
  ];
  assert.equal(
    stripStep1StatusTags(earliestUnprobedDimension(dims)),
    '主流文化冲击（原因）',
  );
});

check('natural model phrasing is detected (no server rewrite)', () => {
  const dim = '便利性';
  assert.ok(
    textLooksLikeProbeAskForDim(
      '「便利性」这个角度，你脑海里有没有浮现出具体的画面或例子？哪怕一两句话、说个大概就行。',
      dim,
    ),
  );
  assert.ok(
    textLooksLikeProbeAskForDim(
      '关于「便利性」，你想到过什么具体的情形吗？',
      dim,
    ),
  );
});

check('preserve: bare rewrite restores confirmed probe tags', () => {
  const prior = [
    '强势文化传播（原因）（已探测）（可展开）',
    '互联网普及（原因）',
  ];
  const incoming = ['强势文化传播（原因）', '互联网普及（原因）'];
  const { dims, restoredCores, reappendedCores } = preserveStep1ProbeTags(
    incoming,
    prior,
  );
  assert.ok(hasStep1StatusTag(dims[0], STEP1_PROBE_PROBED));
  assert.ok(hasStep1StatusTag(dims[0], STEP1_PROBE_EXPANDABLE));
  assert.ok(isStep1DimensionUnprobed(dims[1]));
  assert.ok(restoredCores.includes('强势文化传播（原因）'));
  assert.equal(reappendedCores.length, 0);
  assert.equal(earliestUnprobedDimension(dims), '互联网普及（原因）');
});

check('preserve: re-appends probed dim dropped by model', () => {
  const prior = [
    '强势文化传播（原因）（已探测）（可展开）',
    '互联网普及（原因）（已探测）（可展开）',
  ];
  const incoming = ['互联网普及（原因）'];
  const { dims, reappendedCores } = preserveStep1ProbeTags(incoming, prior);
  assert.ok(dims.some((d) => d.includes('强势文化传播（原因）')));
  assert.ok(reappendedCores.includes('强势文化传播（原因）'));
  assert.ok(
    hasStep1StatusTag(
      dims.find((d) => d.includes('强势文化传播')),
      STEP1_PROBE_EXPANDABLE,
    ),
  );
});

check('preserve: prior stamps win over model self-upgrade', () => {
  const prior = ['沟通效率（评价）（已探测）（空标签）'];
  const incoming = ['沟通效率（评价）（已探测）（可展开）'];
  const { dims, restoredCores } = preserveStep1ProbeTags(incoming, prior);
  assert.ok(hasStep1StatusTag(dims[0], STEP1_PROBE_THIN));
  assert.ok(!hasStep1StatusTag(dims[0], STEP1_PROBE_EXPANDABLE));
  assert.ok(restoredCores.includes('沟通效率（评价）'));
});

check('preserve then resolve: this-turn verdict still stamps', () => {
  const prior = ['强势文化传播（原因）（已探测）（可展开）', '互联网普及（原因）'];
  const incoming = ['强势文化传播（原因）', '互联网普及（原因）'];
  const preserved = preserveStep1ProbeTags(incoming, prior);
  const next = resolvePendingProbeAnswer(
    preserved.dims,
    '互联网普及（原因）',
    'expandable',
  );
  assert.ok(hasStep1StatusTag(next[0], STEP1_PROBE_EXPANDABLE));
  assert.ok(hasStep1StatusTag(next[1], STEP1_PROBE_EXPANDABLE));
  assert.equal(countUnprobedStep1Dimensions(next), 0);
});

console.log(`${passed} Step1 dimension-probe checks passed.`);
