/**
 * Phase1 replay: arm → soft/button accept → commit; explore leak; resettle.
 * Run: npx tsx scripts/replay-proposal-phase1.mjs
 */
import assert from 'node:assert/strict';
import {
  armNextProposal,
  buildAskFromProposal,
  commitProposal,
  reattachElaborationBetweenSlots,
  resolvePendingProposalDecision,
  sideReadyForSettle,
  stanceReady,
  textLooksLikeExploreDecisionLeak,
} from '../src/server/step2/proposal.ts';
import { resolveNextSideWalkStep } from '../src/server/step2/planner-payload.ts';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function pt(partial) {
  return {
    id: partial.id,
    claim: partial.claim,
    elaboration: partial.elaboration || '',
    leanTags: partial.leanTags || ['general'],
    quality: partial.quality || 'thin',
    retentionRole: partial.retentionRole,
    fromDimension: partial.fromDimension || partial.claim,
  };
}

function basePayload(points, extra = {}) {
  return {
    version: 1,
    status: 'draft',
    updatedAt: new Date().toISOString(),
    questionType: 'Two-part Question',
    requiresStance: true,
    slotsLocked: true,
    stance: { text: '', polarity: 'unknown', strength: 'unknown' },
    points,
    redirects: {},
    dimensionDispositions: [],
    coverage: {
      passed: false,
      requiredBuckets: ['part_1', 'part_2'],
      filledBuckets: [],
      missingBuckets: [],
      softMissingBuckets: [],
    },
    exitGate: {
      canComplete: false,
      canForceExit: false,
      forceExitUsed: false,
    },
    sideSettled: [],
    pendingProposal: null,
    ...extra,
  };
}

const causePoints = [
  pt({
    id: 'p1',
    claim: '主流文化冲击（原因）',
    leanTags: ['part_1'],
    elaboration: '影视剧潮流让年轻人追求新潮高级而冷落本土文化',
    quality: 'ready',
  }),
  pt({
    id: 'p2',
    claim: '网络与技术普及（原因）',
    leanTags: ['part_1'],
    elaboration: '数字网络高速传播让传统文化被跨国文化淹没',
    quality: 'ready',
  }),
  pt({
    id: 'p3',
    claim: '商业全球化与消费主义（原因）',
    leanTags: ['part_1'],
    elaboration: '圣诞节等商家消费推广推动西方节日流行',
    quality: 'ready',
  }),
  pt({
    id: 'p4',
    claim: '全球沟通（评价）',
    leanTags: ['part_2'],
    quality: 'thin',
  }),
];

console.log('\n[Phase1] proposal channel wiring\n');

check('arm side_settle when side ready; prefer coach scheme labels', () => {
  const payload = basePayload(causePoints);
  assert.equal(sideReadyForSettle(payload, 'part_1'), true);
  const coach = `
我推荐详写『网络与技术普及』，略写『主流文化冲击』、『商业全球化与消费主义』。
请点击「采纳」或「拒绝」。
`;
  const prop = armNextProposal({ payload, coachText: coach });
  assert.ok(prop);
  assert.equal(prop.kind, 'side_settle');
  const detail = prop.payload.assignments.find((a) => a.role === 'detail');
  assert.equal(detail?.slotId, 'p2');
  const ask = buildAskFromProposal(payload, prop);
  assert.match(ask, /网络与技术普及/);
  assert.match(ask, /采纳/);
});

check('soft「可以」accepts unique pending; no second trim/stance', () => {
  const payload = basePayload(causePoints);
  const prop = armNextProposal({ payload });
  assert.ok(prop);
  const pendingPayload = { ...payload, pendingProposal: prop };
  const soft = resolvePendingProposalDecision({
    prevPayload: pendingPayload,
    prevUserPoints: '',
    userMessage: '可以',
    decision: null,
  });
  assert.equal(soft.handled, true);
  assert.equal(soft.accepted, true);
  assert.equal(soft.result?.ok, true);
  assert.ok(soft.result.payload.sideSettled.includes('part_1'));
  assert.equal(soft.result.payload.pendingProposal, null);
  assert.equal(stanceReady(soft.result.payload), false);
  const next = resolveNextSideWalkStep(soft.result.payload, []);
  assert.equal(next.kind, 'expand');
  if (next.kind === 'expand') assert.equal(next.sideKey, 'part_2');
});

check('button proposal accept with proposalId', () => {
  const payload = basePayload(causePoints);
  const prop = armNextProposal({ payload });
  const pendingPayload = { ...payload, pendingProposal: prop };
  const hit = resolvePendingProposalDecision({
    prevPayload: pendingPayload,
    userMessage: '采纳',
    decision: {
      type: 'proposal',
      action: 'accept',
      proposalId: prop.proposalId,
    },
  });
  assert.equal(hit.handled, true);
  const roles = hit.result.payload.points
    .filter((p) => p.leanTags?.includes('part_1'))
    .map((p) => p.retentionRole);
  assert.ok(roles.includes('detail'));
  assert.ok(roles.every((r) => r === 'detail' || r === 'brief' || r === 'dropped'));
  assert.ok(hit.result.payload.sideSettled.includes('part_1'));
});

check('reject clears pending without locking roles', () => {
  const payload = basePayload(causePoints);
  const prop = armNextProposal({ payload });
  const pendingPayload = { ...payload, pendingProposal: prop };
  const hit = resolvePendingProposalDecision({
    prevPayload: pendingPayload,
    userMessage: '拒绝',
    decision: { type: 'proposal', action: 'reject', proposalId: prop.proposalId },
  });
  assert.equal(hit.handled, true);
  assert.equal(hit.rejected, true);
  assert.equal(hit.result.payload.pendingProposal, null);
  assert.equal(
    hit.result.payload.points.every((p) => !p.retentionRole),
    true,
  );
});

check('explore decision leak detector', () => {
  assert.equal(
    textLooksLikeExploreDecisionLeak(
      '好的。\n\n---\n\n建议详写『网络』略写『主流』。请点击「采纳」或「拒绝」。',
    ),
    true,
  );
  assert.equal(
    textLooksLikeExploreDecisionLeak(
      '好的。\n\n---\n\n「全球沟通」目前还偏薄：请补 1–2 句具体场景。',
    ),
    false,
  );
});

check('reattach moves elaboration between slots', () => {
  const points = [
    pt({
      id: 'p1',
      claim: '网络',
      elaboration: '圣诞节商家推广推动节日流行',
      quality: 'ready',
      leanTags: ['part_1'],
    }),
    pt({
      id: 'p2',
      claim: '商业全球化',
      leanTags: ['part_1'],
      quality: 'thin',
    }),
  ];
  const next = reattachElaborationBetweenSlots({
    points,
    fromId: 'p1',
    toId: 'p2',
    chunk: '圣诞节商家推广推动节日流行',
  });
  assert.equal(String(next.find((p) => p.id === 'p1')?.elaboration || ''), '');
  assert.match(
    String(next.find((p) => p.id === 'p2')?.elaboration || ''),
    /圣诞节/,
  );
});

check('legacy slot_add migrates into pendingProposal', () => {
  const payload = basePayload(
    [
      pt({
        id: 'p1',
        claim: '主流文化冲击',
        leanTags: ['part_1'],
        elaboration: '影视剧改变审美偏好的具体场景',
        quality: 'ready',
        retentionRole: 'detail',
      }),
      pt({
        id: 'p2',
        claim: '全球沟通',
        leanTags: ['part_2'],
        elaboration: '共同语言降低跨境协作成本的机制',
        quality: 'ready',
        retentionRole: 'detail',
      }),
    ],
    {
      sideSettled: ['part_1', 'part_2'],
      pendingSlotAdd: { claim: '身份认同危机', elaboration: '年轻人失去归属感' },
      requiresStance: false,
    },
  );
  // With requiresStance false and sides settled, arm may pick slot_add
  const prop = armNextProposal({ payload });
  assert.ok(prop);
  assert.equal(prop.kind, 'slot_add');
  assert.equal(prop.payload.claim, '身份认同危机');
  const committed = commitProposal({
    payload: { ...payload, pendingProposal: prop },
    proposal: prop,
    userPoints: '',
  });
  assert.equal(committed.ok, true);
  assert.ok(
    committed.payload.points.some((p) => p.claim === '身份认同危机'),
  );
});

console.log(`\n${passed} Phase1 checks passed.\n`);
