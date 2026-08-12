/**
 * Phase0 replay: structured proposal channel (validate / commit / readiness).
 * Run: npx tsx scripts/replay-proposal-channel.mjs
 */
import assert from 'node:assert/strict';
import {
  armNextProposal,
  buildAskFromProposal,
  buildFallbackSideSettleProposal,
  buildOpenRetentionSchemeAsk,
  buildSideSettleFromLabelMessage,
  buildSideSettleFromScheme,
  buildSlotMergeFromBoardMeta,
  buildSlotMergeFromCoachText,
  commitProposal,
  isGeneralOnlyBoard,
  listSettleSides,
  looksLikeClaimTitle,
  parseRetentionSchemeMessage,
  resolvePendingProposalDecision,
  sanitizeRetentionReason,
  sideReadyForSettle,
  stanceReady,
  userMessageAsksForSettleRecommendation,
  validateProposal,
} from '../src/server/step2/proposal.ts';
import {
  isPointWalked,
  pointHasSubstantiveContent,
  resolveNextSideWalkStep,
  scorePointQuality,
  stripForgedRetentionLocks,
} from '../src/server/step2/planner-payload.ts';
import { enforceStep2AskContract } from '../src/server/step2/ask-contract.ts';

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
    ...(partial.seedOnly !== undefined ? { seedOnly: partial.seedOnly } : {}),
    ...(partial.supersededBy ? { supersededBy: partial.supersededBy } : {}),
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
      missingBuckets: ['part_1', 'part_2'],
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

console.log('\n[Phase0] proposal channel\n');

check('looksLikeClaimTitle rejects fragments', () => {
  assert.equal(looksLikeClaimTitle('主流文化冲击'), true);
  assert.equal(
    looksLikeClaimTitle(
      '这一维度。从正面来看，当人们使用更通用的语言和文化时，对',
    ),
    false,
  );
  assert.equal(looksLikeClaimTitle('短'), false);
});

check('sideReadyForSettle needs substantive body (not 4-char fluff)', () => {
  const payload = basePayload([
    pt({
      id: 'p1',
      claim: '主流文化冲击',
      leanTags: ['part_1'],
      elaboration: '影视',
      quality: 'thin',
    }),
    pt({
      id: 'p2',
      claim: '网络与技术普及',
      leanTags: ['part_1'],
      elaboration: '数字传播淹没传统文化的具体机制说明',
      quality: 'ready',
    }),
  ]);
  assert.equal(pointHasSubstantiveContent(payload.points[0]), false);
  assert.equal(sideReadyForSettle(payload, 'part_1'), false);
  assert.equal(sideReadyForSettle(payload, 'part_1', { exhausted: true }), true);

  payload.points[0].elaboration =
    '影视剧潮流让年轻人追求新潮高级而冷落本土文化';
  payload.points[0].quality = 'ready';
  assert.equal(sideReadyForSettle(payload, 'part_1'), true);
});

check('sideReadyForSettle: seedOnly Step1 sprouts do NOT arm settle', () => {
  const payload = basePayload([
    pt({
      id: 'p1',
      claim: '强势文化冲击（原因）',
      leanTags: ['part_1'],
      elaboration: '比如迪士尼，电影在不同国家发行',
      quality: 'ready',
    }),
    pt({
      id: 'p2',
      claim: '网络普及（原因）',
      leanTags: ['part_1'],
      elaboration: '通过facebook等平台大范围传播',
      quality: 'ready',
    }),
  ]);
  payload.points[0].seedOnly = true;
  payload.points[1].seedOnly = true;
  assert.equal(sideReadyForSettle(payload, 'part_1'), false);
  // Student exhausted still allows settle (explicit escape).
  assert.equal(sideReadyForSettle(payload, 'part_1', { exhausted: true }), true);

  // Student expands both slots → side becomes ready.
  payload.points[0].seedOnly = false;
  payload.points[1].seedOnly = false;
  assert.equal(sideReadyForSettle(payload, 'part_1'), true);
});

check('validate side_settle: invent slot id / unassigned rejected', () => {
  const payload = basePayload([
    pt({
      id: 'p1',
      claim: '主流文化冲击',
      leanTags: ['part_1'],
      elaboration: '影视剧潮流改变年轻人审美偏好',
      quality: 'ready',
    }),
    pt({
      id: 'p2',
      claim: '网络与技术普及',
      leanTags: ['part_1'],
      elaboration: '数字网络高速传播淹没传统文化',
      quality: 'ready',
    }),
  ]);
  const badId = {
    proposalId: 'x1',
    kind: 'side_settle',
    payload: {
      side: 'part_1',
      assignments: [
        { slotId: 'p1', role: 'detail' },
        { slotId: 'p99', role: 'brief' },
      ],
    },
  };
  assert.equal(validateProposal(payload, badId).ok, false);

  const missing = {
    proposalId: 'x2',
    kind: 'side_settle',
    payload: {
      side: 'part_1',
      assignments: [{ slotId: 'p1', role: 'detail' }],
    },
  };
  assert.equal(validateProposal(payload, missing).ok, false);
  assert.match(validateProposal(payload, missing).reason, /unassigned/);
});

check('three causes settle → roles lock, empty sibling drop path, next side', () => {
  const points = [
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
  const payload = basePayload(points);
  assert.equal(sideReadyForSettle(payload, 'part_1'), true);
  assert.equal(stanceReady(payload), false);

  const proposal = {
    proposalId: 'settle-1',
    kind: 'side_settle',
    rationale: '技术为载体，文化为内容',
    payload: {
      side: 'part_1',
      assignments: [
        { slotId: 'p2', role: 'detail' },
        { slotId: 'p1', role: 'brief' },
        { slotId: 'p3', role: 'brief' },
      ],
    },
  };
  assert.equal(validateProposal(payload, proposal).ok, true);

  const committed = commitProposal({
    payload,
    proposal,
    userPoints:
      '主流文化冲击（影视…）；网络与技术普及（数字…）；商业全球化与消费主义（圣诞…）',
  });
  assert.equal(committed.ok, true);
  assert.equal(committed.payload.pendingProposal, null);
  assert.ok(committed.payload.sideSettled.includes('part_1'));
  assert.equal(
    committed.payload.points.find((p) => p.id === 'p2')?.retentionRole,
    'detail',
  );
  assert.equal(
    committed.payload.points.find((p) => p.id === 'p1')?.retentionRole,
    'brief',
  );
  assert.match(committed.userPoints, /已选详写|网络/);
  assert.match(committed.userPoints, /已选略写|主流|商业/);

  const next = resolveNextSideWalkStep(committed.payload, []);
  assert.equal(next.kind, 'expand');
  if (next.kind === 'expand') {
    assert.equal(next.sideKey, 'part_2');
    assert.equal(next.point.id, 'p4');
  }
  assert.equal(stanceReady(committed.payload), false);
});

check('slot_add fragment rejected; clean claim commits new slot + body', () => {
  const payload = basePayload([
    pt({
      id: 'p1',
      claim: '主流文化冲击',
      leanTags: ['part_1'],
      elaboration: '影视剧改变年轻人审美',
      quality: 'ready',
      retentionRole: 'detail',
    }),
  ]);
  const frag = {
    proposalId: 'add-bad',
    kind: 'slot_add',
    payload: {
      claim: '这一维度。从正面来看，当人们使用更通用的语言和文化时，对',
      side: 'part_2',
      body: '通用语言便于交流',
    },
  };
  assert.equal(validateProposal(payload, frag).ok, false);

  const good = {
    proposalId: 'add-ok',
    kind: 'slot_add',
    payload: {
      claim: '全球沟通便利',
      side: 'part_2',
      body: '共同语言降低跨境协作成本',
    },
  };
  assert.equal(validateProposal(payload, good).ok, true);
  const committed = commitProposal({ payload, proposal: good, userPoints: '' });
  assert.equal(committed.ok, true);
  assert.equal(committed.payload.points.length, 2);
  const added = committed.payload.points.find((p) => p.claim === '全球沟通便利');
  assert.ok(added);
  assert.equal(added.leanTags[0], 'part_2');
  assert.ok(pointHasSubstantiveContent(added) || added.elaboration.length >= 8);
  assert.equal(scorePointQuality(added.claim, added.elaboration || ''), 'ready');
});

check('stanceReady only after all sides settled; stance commit clears pending', () => {
  const points = [
    pt({
      id: 'p1',
      claim: '原因A',
      leanTags: ['part_1'],
      elaboration: '原因A的具体机制已经写清楚了',
      quality: 'ready',
      retentionRole: 'detail',
    }),
    pt({
      id: 'p2',
      claim: '评价B',
      leanTags: ['part_2'],
      elaboration: '评价B的具体影响对象与场景',
      quality: 'ready',
      retentionRole: 'detail',
    }),
  ];
  let payload = basePayload(points, { sideSettled: ['part_1'] });
  assert.equal(stanceReady(payload), false);

  payload = { ...payload, sideSettled: ['part_1', 'part_2'] };
  assert.equal(stanceReady(payload), true);

  const stance = {
    proposalId: 'st1',
    kind: 'stance',
    payload: {
      text: '整体更偏消极，但承认沟通便利是附带好处',
      polarity: 'negative',
    },
  };
  assert.equal(validateProposal(payload, stance).ok, true);
  const committed = commitProposal({ payload, proposal: stance });
  assert.equal(committed.ok, true);
  assert.equal(committed.payload.stanceConfirmResolved, true);
  assert.match(committed.payload.stance.text, /消极/);
  assert.equal(committed.payload.pendingProposal, null);
  assert.equal(stanceReady(committed.payload), false);
});

check('general-only board: one settle side + fallback proposal', () => {
  const payload = basePayload(
    [
      pt({
        id: 'p1',
        claim: '环保',
        elaboration: '加密公交站点吸引车主改乘减少尾气',
        quality: 'ready',
      }),
      pt({
        id: 'p2',
        claim: '公平',
        elaboration: '偏远地区居民也能坐上便宜的公共交通',
        quality: 'ready',
      }),
    ],
    { questionType: 'Agree / Disagree', requiresStance: true },
  );
  assert.equal(isGeneralOnlyBoard(payload), true);
  assert.deepEqual(listSettleSides(payload), ['general']);
  assert.equal(sideReadyForSettle(payload, 'general'), true);

  const fb = buildFallbackSideSettleProposal(payload, 'general', 'fb1');
  assert.ok(fb);
  assert.equal(fb.kind, 'side_settle');
  assert.equal(validateProposal(payload, fb).ok, true);
  assert.equal(fb.payload.assignments.length, 2);
  assert.equal(
    fb.payload.assignments.filter((a) => a.role === 'detail').length,
    1,
  );
});

// ---------- slot_merge: 拆步执行（先确认合并，再确认详略） ----------

function mergeScenarioPayload() {
  return basePayload([
    pt({
      id: 'p1',
      claim: '强势文化冲击（原因）',
      leanTags: ['part_1'],
      elaboration: '好莱坞影视让年轻人觉得本土文化过时，逐渐弃用母语场景',
      quality: 'ready',
    }),
    pt({
      id: 'p2',
      claim: '网络普及（原因）',
      leanTags: ['part_1'],
      elaboration: '英语主导线上平台，年轻一代线上社交逐渐冷落母语',
      quality: 'ready',
    }),
    pt({
      id: 'p3',
      claim: '全球消费主义（原因）',
      leanTags: ['part_1'],
      elaboration: '圣诞节等节庆被商家包装成消费节日推广',
      quality: 'ready',
      seedOnly: true,
    }),
  ]);
}

const MERGE_NARRATION =
  '关于第三个「全球消费主义」，我们可以在后续写作中作为「强势文化冲击」的跨国品牌例子合并进去，从而保持篇幅精炼。';

check('merged disposition alone does NOT walk a still-active slot', () => {
  const payload = mergeScenarioPayload();
  const p3 = payload.points.find((p) => p.id === 'p3');
  const dispositions = [
    {
      dimension: '全球消费主义（原因）',
      disposition: 'merged',
      mergedInto: '强势文化冲击',
    },
  ];
  assert.equal(isPointWalked(p3, dispositions), false);
  // …but a committed merge (supersededBy) does walk it
  assert.equal(
    isPointWalked({ ...p3, supersededBy: 'p1' }, dispositions),
    true,
  );
});

check('coach merge narration → slot_merge proposal (armed before settle)', () => {
  const payload = mergeScenarioPayload();
  const prop = buildSlotMergeFromCoachText(payload, MERGE_NARRATION);
  assert.ok(prop, 'merge narration should resolve to a proposal');
  assert.equal(prop.kind, 'slot_merge');
  assert.equal(prop.payload.fromSlotId, 'p3');
  assert.equal(prop.payload.intoSlotId, 'p1');
  assert.equal(validateProposal(payload, prop).ok, true);

  const armed = armNextProposal({ payload, coachText: MERGE_NARRATION });
  assert.ok(armed);
  assert.equal(armed.kind, 'slot_merge', 'merge must arm before side_settle');
});

check('slot_merge validation: unknown slot / self / cross-side rejected', () => {
  const payload = mergeScenarioPayload();
  assert.equal(
    validateProposal(payload, {
      proposalId: 'm1',
      kind: 'slot_merge',
      payload: { fromSlotId: 'p9', intoSlotId: 'p1' },
    }).ok,
    false,
  );
  assert.equal(
    validateProposal(payload, {
      proposalId: 'm2',
      kind: 'slot_merge',
      payload: { fromSlotId: 'p1', intoSlotId: 'p1' },
    }).ok,
    false,
  );
  const mixed = basePayload([
    pt({ id: 'a', claim: '原因A', leanTags: ['part_1'], elaboration: 'x' }),
    pt({ id: 'b', claim: '评价B', leanTags: ['part_2'], elaboration: 'y' }),
  ]);
  assert.equal(
    validateProposal(mixed, {
      proposalId: 'm3',
      kind: 'slot_merge',
      payload: { fromSlotId: 'a', intoSlotId: 'b' },
    }).ok,
    false,
  );
});

check('slot_merge commit: supersede + fold body + redirects + reopen settle', () => {
  const payload = {
    ...mergeScenarioPayload(),
    sideSettled: ['part_1'],
    dimensionDispositions: [
      { dimension: '全球消费主义（原因）', disposition: 'pending' },
    ],
  };
  const prop = buildSlotMergeFromCoachText(payload, MERGE_NARRATION);
  const committed = commitProposal({ payload, proposal: prop });
  assert.equal(committed.ok, true);

  const from = committed.payload.points.find((p) => p.id === 'p3');
  const into = committed.payload.points.find((p) => p.id === 'p1');
  assert.equal(from.supersededBy, 'p1');
  assert.match(into.elaboration, /圣诞节/);
  assert.equal(committed.payload.redirects.p3, 'p1');
  assert.equal(committed.payload.pendingProposal, null);
  assert.equal(committed.payload.sideSettled.includes('part_1'), false);
  const disp = committed.payload.dimensionDispositions[0];
  assert.equal(disp.disposition, 'merged');
  assert.match(String(disp.mergedInto || ''), /强势文化冲击/);

  // Step 2 of the split flow: side is now ready for its own 详略 settle
  assert.equal(sideReadyForSettle(committed.payload, 'part_1'), true);
  const next = armNextProposal({ payload: committed.payload });
  assert.ok(next);
  assert.equal(next.kind, 'side_settle');
  assert.equal(next.payload.assignments.length, 2);
});

check('merge rejected → slot stays; walk gate asks to expand it', () => {
  const payload = mergeScenarioPayload();
  // Reject = pending cleared, no commit; p3 is seedOnly + unwalked
  assert.equal(sideReadyForSettle(payload, 'part_1'), false);
  const next = resolveNextSideWalkStep(payload, [
    {
      dimension: '全球消费主义（原因）',
      disposition: 'merged',
      mergedInto: '强势文化冲击',
    },
  ]);
  assert.equal(next.kind, 'expand');
  assert.equal(next.point.id, 'p3');
});

// --- Live incident regressions: counter-scheme / reject re-ask / stance ask ---

function settleScenarioPayload() {
  // Board order p1..p3; recommendation (assignment order) puts p3 first.
  const payload = basePayload([
    pt({
      id: 'p1',
      claim: '强势文化冲击（原因）',
      leanTags: ['part_1'],
      elaboration: '外来影视作品流行，使人们认为外来文化更新潮高级，冷落本土文化',
      quality: 'ready',
      seedOnly: false,
    }),
    pt({
      id: 'p2',
      claim: '网络普及（原因）',
      leanTags: ['part_1'],
      elaboration: '信息传播速度更快规模更大，传统文化易被跨国文化淹没',
      quality: 'ready',
      seedOnly: false,
    }),
    pt({
      id: 'p3',
      claim: '全球消费主义（原因）',
      leanTags: ['part_1'],
      elaboration: '圣诞节促销和礼物互动等商业活动盛行，引导生活习惯西化',
      quality: 'ready',
      seedOnly: false,
    }),
  ]);
  payload.pendingProposal = {
    proposalId: 'settle-part_1',
    kind: 'side_settle',
    payload: {
      side: 'part_1',
      assignments: [
        { slotId: 'p3', role: 'detail' },
        { slotId: 'p1', role: 'brief' },
        { slotId: 'p2', role: 'brief' },
      ],
    },
  };
  return payload;
}

check('parseRetentionSchemeMessage: multi-assignment / 都详写 / 丢掉', () => {
  const s1 = parseRetentionSchemeMessage('详写2，略写1和3');
  assert.deepEqual(s1.assignments, [
    { index: 2, role: 'detail' },
    { index: 1, role: 'brief' },
    { index: 3, role: 'brief' },
  ]);
  const s2 = parseRetentionSchemeMessage('①详写，②略写');
  assert.deepEqual(s2.assignments, [
    { index: 1, role: 'detail' },
    { index: 2, role: 'brief' },
  ]);
  assert.equal(parseRetentionSchemeMessage('都详写').allDetail, true);
  assert.deepEqual(parseRetentionSchemeMessage('丢掉③').assignments, [
    { index: 3, role: 'dropped' },
  ]);
  assert.equal(parseRetentionSchemeMessage('可以'), null);
  assert.equal(parseRetentionSchemeMessage('详写'), null);
});

check('counter-scheme on pending settle → modify-and-accept, user roles win', () => {
  const payload = settleScenarioPayload();
  // 「详写2」= second item of the DISPLAYED list (p1), not board index 2.
  const resolved = resolvePendingProposalDecision({
    prevPayload: payload,
    prevUserPoints: '',
    userMessage: '详写2，略写1和3',
  });
  assert.equal(resolved.handled, true);
  assert.equal(resolved.accepted, true);
  assert.equal(resolved.modified, true);
  const roles = Object.fromEntries(
    resolved.result.payload.points.map((p) => [p.id, p.retentionRole]),
  );
  // Displayed order was p3(1), p1(2), p2(3) → detail p1; brief p3, p2.
  assert.equal(roles.p1, 'detail');
  assert.equal(roles.p3, 'brief');
  assert.equal(roles.p2, 'brief');
  assert.equal(resolved.result.payload.pendingProposal, null);
  assert.equal(resolved.result.payload.sideSettled.includes('part_1'), true);
});

check('partial 「详细写2」: named detail demotes the recommended detail', () => {
  // Live incident: pending recommendation had detail on 全球消费主义 (p3,
  // displayed #1). Student replied 「详细写2，若写另外2个」— only 「详细写2」
  // parses. The recommended detail must NOT survive on the unmentioned slot.
  const payload = settleScenarioPayload();
  const resolved = resolvePendingProposalDecision({
    prevPayload: payload,
    prevUserPoints: '',
    userMessage: '详细写2，若写另外2个',
  });
  assert.equal(resolved.handled, true);
  assert.equal(resolved.modified, true);
  const roles = Object.fromEntries(
    resolved.result.payload.points.map((p) => [p.id, p.retentionRole]),
  );
  // Displayed order: p3(1), p1(2), p2(3) → 「详细写2」= p1 detail; the
  // recommendation's detail on p3 demotes to brief — exactly one detail.
  assert.equal(roles.p1, 'detail');
  assert.equal(roles.p3, 'brief');
  assert.equal(roles.p2, 'brief');
});

check('brief-only scheme keeps the recommended detail for the rest', () => {
  // 「略写3」 names no detail → recommendation roles fill unmentioned slots.
  const payload = settleScenarioPayload();
  const resolved = resolvePendingProposalDecision({
    prevPayload: payload,
    prevUserPoints: '',
    userMessage: '略写3',
  });
  assert.equal(resolved.handled, true);
  const roles = Object.fromEntries(
    resolved.result.payload.points.map((p) => [p.id, p.retentionRole]),
  );
  // Displayed #3 = p2 → brief (explicit); p3 keeps recommended detail,
  // p1 keeps recommended brief.
  assert.equal(roles.p2, 'brief');
  assert.equal(roles.p3, 'detail');
  assert.equal(roles.p1, 'brief');
});

check('counter-scheme 都详写 → every slot detail', () => {
  const payload = settleScenarioPayload();
  const resolved = resolvePendingProposalDecision({
    prevPayload: payload,
    prevUserPoints: '',
    userMessage: '都详写',
  });
  assert.equal(resolved.handled, true);
  assert.equal(resolved.modified, true);
  const active = resolved.result.payload.points.filter((p) => !p.supersededBy);
  assert.equal(active.every((p) => p.retentionRole === 'detail'), true);
});

check('settle reject → awaiting-custom side; fallback never re-arms same side', () => {
  const payload = settleScenarioPayload();
  const resolved = resolvePendingProposalDecision({
    prevPayload: payload,
    prevUserPoints: '',
    userMessage: '',
    decision: { type: 'retention', action: 'reject' },
  });
  assert.equal(resolved.rejected, true);
  const cleared = resolved.result.payload;
  assert.equal(cleared.settleAwaitingCustomSide, 'part_1');
  assert.equal(cleared.pendingProposal, null);
  // Same turn / next turn: the channel must NOT rebuild the same fallback.
  assert.equal(armNextProposal({ payload: cleared }), null);
  // Open ask lists the side's slots in board order, no 采纳/拒绝 wording.
  const ask = buildOpenRetentionSchemeAsk(cleared, 'part_1');
  assert.match(ask, /1\. 强势文化冲击/);
  assert.match(ask, /2\. 网络普及/);
  assert.match(ask, /3\. 全球消费主义/);
  assert.doesNotMatch(ask, /采纳|拒绝/);
});

check('awaiting-custom: student scheme commits (board order); flag clears', () => {
  const payload = settleScenarioPayload();
  payload.pendingProposal = null;
  payload.settleAwaitingCustomSide = 'part_1';
  const scheme = parseRetentionSchemeMessage('①详写，②③略写');
  const prop = buildSideSettleFromScheme({
    payload,
    sideKey: 'part_1',
    scheme,
  });
  assert.ok(prop);
  const committed = commitProposal({ payload, proposal: prop, userPoints: '' });
  assert.equal(committed.ok, true);
  const roles = Object.fromEntries(
    committed.payload.points.map((p) => [p.id, p.retentionRole]),
  );
  assert.equal(roles.p1, 'detail');
  assert.equal(roles.p2, 'brief');
  assert.equal(roles.p3, 'brief');
  assert.equal(committed.payload.settleAwaitingCustomSide, null);
  assert.equal(committed.payload.sideSettled.includes('part_1'), true);
  // 「按你的建议」 re-opens the recommendation path.
  assert.equal(userMessageAsksForSettleRecommendation('按你的建议'), true);
  assert.equal(userMessageAsksForSettleRecommendation('我觉得都详写'), false);
});

check('retentionSuggestion.reason is sanitized (repetition loop never reaches ask)', () => {
  // Normal short reason kept as-is.
  assert.equal(
    sanitizeRetentionReason('心理机制最具体，最能支撑核心论证'),
    '心理机制最具体，最能支撑核心论证',
  );
  // First sentence only.
  assert.equal(
    sanitizeRetentionReason('传播机制因果链完整。后面这些都不要了，还有更多。'),
    '传播机制因果链完整',
  );
  // Degenerate repetition loop (observed incident) → discarded entirely.
  const loop =
    '设计布局安排方案设想规划构想构思设想思路设计' .repeat(30);
  assert.equal(sanitizeRetentionReason(loop), '');
  // Long-but-real reason gets clipped near a clause boundary, bounded ≤60.
  const long =
    '强势文化与网络普及揭示了根本的文化与技术因果，适合详写；消费主义是商业表现，适合作为辅助略写支撑主旨发展影响分析设计布局安排方案';
  const clipped = sanitizeRetentionReason(long);
  assert.ok(clipped.length > 0 && clipped.length <= 60);
  assert.doesNotMatch(clipped, /方案$/);

  // Through the channel: degenerate reason falls back to the default rationale
  // and the ask text stays bounded.
  const payload = settleScenarioPayload();
  payload.pendingProposal = null;
  const armed = armNextProposal({
    payload,
    retentionSuggestion: {
      detail: ['网络普及'],
      brief: ['强势文化冲击', '全球消费主义'],
      reason: loop,
    },
  });
  assert.ok(armed);
  assert.equal(armed.rationale, '来自教练评估方案');
  const ask = buildAskFromProposal(payload, armed);
  assert.ok(ask.length < 600);
  assert.doesNotMatch(ask, /设计布局安排方案设想/);
});

check('structured retentionSuggestion wins over volume fallback', () => {
  const payload = settleScenarioPayload();
  payload.pendingProposal = null;
  // Volume fallback would pick p1 (longest elaboration). The model's
  // structured judgment picks p2 — quality over length.
  const armed = armNextProposal({
    payload,
    retentionSuggestion: {
      detail: ['网络普及'],
      brief: ['强势文化冲击', '全球消费主义'],
      reason: '传播机制的因果链最完整',
    },
  });
  assert.ok(armed);
  assert.equal(armed.kind, 'side_settle');
  const roles = Object.fromEntries(
    armed.payload.assignments.map((a) => [a.slotId, a.role]),
  );
  assert.equal(roles.p2, 'detail');
  assert.equal(roles.p1, 'brief');
  assert.equal(roles.p3, 'brief');
  assert.match(String(armed.rationale || ''), /因果链/);

  // Suggestion whose detail labels resolve to nothing on the side →
  // ignored; volume fallback picks the longest (p1).
  const fallback = armNextProposal({
    payload,
    retentionSuggestion: { detail: ['不存在的槽位'], brief: [], reason: '' },
  });
  assert.ok(fallback);
  const fbDetail = fallback.payload.assignments.find(
    (a) => a.role === 'detail',
  );
  assert.equal(fbDetail.slotId, 'p1');
  assert.match(String(fallback.rationale || ''), /按各条信息量/);
});

check('stance ask is self-contained; legacy pendingStanceConfirm migrates to channel', () => {
  const payload = basePayload(
    [
      pt({
        id: 'p1',
        claim: '强势文化冲击（原因）',
        leanTags: ['part_1'],
        elaboration: '外来影视作品流行，冷落本土文化的具体机制说明',
        quality: 'ready',
        retentionRole: 'detail',
        seedOnly: false,
      }),
      pt({
        id: 'p2',
        claim: '国际交流（评价）',
        leanTags: ['part_2'],
        elaboration: '共同语言消除沟通壁垒，跨国协作效率提升',
        quality: 'ready',
        retentionRole: 'detail',
        seedOnly: false,
      }),
    ],
    {
      sideSettled: ['part_1', 'part_2'],
      pendingStanceConfirm: {
        text: '虽然文化流失带来交流便利，但整体上是一个消极的发展。',
      },
    },
  );
  const armed = armNextProposal({ payload });
  assert.ok(armed);
  assert.equal(armed.kind, 'stance');
  assert.match(armed.payload.text, /消极的发展/);
  const ask = buildAskFromProposal(payload, armed);
  // The ask carries the stance sentence itself — never a dangling 「上面是…」.
  assert.match(ask, /推荐立场：「虽然文化流失带来交流便利/);
  assert.doesNotMatch(ask, /上面是/);
  // Accept commits stance and resolves confirm.
  const committed = commitProposal({ payload, proposal: armed, userPoints: '' });
  assert.equal(committed.ok, true);
  assert.match(committed.payload.stance.text, /消极的发展/);
  assert.equal(committed.payload.stanceConfirmResolved, true);
  assert.equal(committed.payload.pendingStanceConfirm, null);
});

// ---------------------------------------------------------------------------
// Label counter-scheme incident:「详细写强势文化冲击」names a slot by claim
// label, not index — must modify-and-accept this turn, never fall through to
// re-presenting the stale recommendation.
// ---------------------------------------------------------------------------

function labelIncidentPayload() {
  return basePayload([
    pt({
      id: 'p1',
      claim: '强势文化冲击（原因）',
      leanTags: ['part_1'],
      elaboration: '外来文化被视为更高级新潮，本土传统被视为落后过时',
      quality: 'ready',
      seedOnly: false,
    }),
    pt({
      id: 'p2',
      claim: '网络普及（原因）',
      leanTags: ['part_1'],
      elaboration: '信息传播速度更快规模更大，传统文化容易被跨国文化淹没',
      quality: 'ready',
      seedOnly: false,
    }),
    pt({
      id: 'p3',
      claim: '全球消费主义（原因）',
      leanTags: ['part_1'],
      elaboration: '圣诞节在非基督教国家也成重要节日，商场装扮促销重塑习惯',
      quality: 'ready',
      seedOnly: false,
    }),
  ]);
}

function labelIncidentPending() {
  return {
    proposalId: 'settle-part1-x',
    kind: 'side_settle',
    rationale: '按各条信息量生成的兜底方案',
    payload: {
      side: 'part_1',
      assignments: [
        { slotId: 'p3', role: 'detail' },
        { slotId: 'p1', role: 'brief' },
        { slotId: 'p2', role: 'brief' },
      ],
    },
  };
}

check('label counter-scheme 「详细写强势文化冲击」 → modify-and-accept this turn', () => {
  const payload = labelIncidentPayload();
  payload.pendingProposal = labelIncidentPending();
  const res = resolvePendingProposalDecision({
    prevPayload: payload,
    prevUserPoints: '',
    userMessage: '详细写强势文化冲击',
  });
  assert.equal(res.handled, true, 'label scheme must be handled, not dropped');
  assert.equal(res.accepted, true);
  assert.equal(res.modified, true);
  const roles = new Map(
    res.result.payload.points.map((p) => [p.id, p.retentionRole]),
  );
  // Named detail replaces the recommended detail; unmentioned demote to brief.
  assert.equal(roles.get('p1'), 'detail');
  assert.equal(roles.get('p2'), 'brief');
  assert.equal(roles.get('p3'), 'brief');
  assert.equal(res.result.payload.pendingProposal, null);
});

check('label brief-only 「略写网络普及和全球消费主义」 keeps recommended detail', () => {
  const payload = labelIncidentPayload();
  payload.pendingProposal = {
    ...labelIncidentPending(),
    payload: {
      side: 'part_1',
      assignments: [
        { slotId: 'p1', role: 'detail' },
        { slotId: 'p2', role: 'brief' },
        { slotId: 'p3', role: 'brief' },
      ],
    },
  };
  const res = resolvePendingProposalDecision({
    prevPayload: payload,
    prevUserPoints: '',
    userMessage: '略写网络普及和全球消费主义',
  });
  assert.equal(res.handled, true);
  assert.equal(res.modified, true);
  const roles = new Map(
    res.result.payload.points.map((p) => [p.id, p.retentionRole]),
  );
  assert.equal(roles.get('p1'), 'detail');
  assert.equal(roles.get('p2'), 'brief');
  assert.equal(roles.get('p3'), 'brief');
});

check('label parser ignores chatter; awaiting-custom board-order path works', () => {
  const payload = labelIncidentPayload();
  // Plain chat containing 略写 must not fabricate a scheme.
  assert.equal(
    buildSideSettleFromLabelMessage({
      payload,
      sideKey: 'part_1',
      userMessage: '略写是什么意思？',
    }),
    null,
  );
  // Board-order label scheme with no pending proposal (awaiting-custom path).
  const prop = buildSideSettleFromLabelMessage({
    payload,
    sideKey: 'part_1',
    userMessage: '详写网络普及',
  });
  assert.ok(prop);
  const roles = new Map(prop.payload.assignments.map((a) => [a.slotId, a.role]));
  assert.equal(roles.get('p2'), 'detail');
  assert.equal(roles.get('p1'), 'brief');
  assert.equal(roles.get('p3'), 'brief');
});

// ---------------------------------------------------------------------------
// 真合并 incident: merge narrated ONLY as board meta-text（已整合至X）must stop
// the turn for explicit 采纳/拒绝 — never a silent rhetorical merge.
// ---------------------------------------------------------------------------

function mergeIncidentPoints() {
  return [
    pt({
      id: 'p1',
      claim: '强势文化冲击（原因）',
      leanTags: ['part_1'],
      elaboration: '比如圣诞节，即使在非基督教国家，现在也普遍是一个重要的节日',
      quality: 'ready',
      retentionRole: 'detail',
      seedOnly: false,
    }),
    pt({
      id: 'p2',
      claim: '网络普及（原因）',
      leanTags: ['part_1'],
      elaboration: '信息传播速度更快规模更大，传统文化容易被跨国文化淹没',
      quality: 'ready',
      retentionRole: 'brief',
      seedOnly: false,
    }),
    pt({
      id: 'p3',
      claim: '全球消费主义（原因）',
      leanTags: ['part_1'],
      elaboration: '已整合至强势文化冲击的商业案例中',
      quality: 'thin',
      seedOnly: false,
    }),
  ];
}

const incidentUserPoints =
  'A面：1. 强势文化冲击（原因）：圣诞节案例；2. 网络普及（原因）：传播速度；\n3. 全球消费主义（原因）：已整合至强势文化冲击的商业案例中';

check('board meta 「已整合至X」 → slot_merge proposal (colon form)', () => {
  const payload = basePayload(mergeIncidentPoints());
  const merge = buildSlotMergeFromBoardMeta(payload, incidentUserPoints);
  assert.ok(merge, 'meta line must arm a merge');
  assert.equal(merge.kind, 'slot_merge');
  assert.equal(merge.payload.fromSlotId, 'p3');
  assert.equal(merge.payload.intoSlotId, 'p1');
});

check('board meta paren form 「X（已并入Y）」 also detected; clean board → null', () => {
  const payload = basePayload(mergeIncidentPoints());
  const merge = buildSlotMergeFromBoardMeta(
    payload,
    '3. 全球消费主义（已并入强势文化冲击）',
  );
  assert.ok(merge);
  assert.equal(merge.payload.fromSlotId, 'p3');
  assert.equal(merge.payload.intoSlotId, 'p1');
  assert.equal(
    buildSlotMergeFromBoardMeta(
      payload,
      'A面：1. 强势文化冲击（原因）：圣诞节案例；2. 网络普及（原因）：传播速度',
    ),
    null,
  );
});

check('ask-contract any-turn hook: narrated merge stops turn with 采纳/拒绝', () => {
  const payload = basePayload(mergeIncidentPoints());
  const data = {
    text: '好的，A面材料整理完毕。\n\n---\n\n接下来我们看第二问：你觉得这是积极还是消极的发展？',
    progressUpdate: {
      isCompleted: false,
      step2Data: {
        userPoints: incidentUserPoints,
        plannerPayload: payload,
      },
    },
  };
  enforceStep2AskContract(data, {}, {
    safeOverridePart1: (t) => String(t).split('---')[0].trim() || '好的。',
    buildContentAwareFallback: () => '兜底问题。',
  });
  const armed = data.progressUpdate.step2Data.plannerPayload.pendingProposal;
  assert.ok(armed?.proposalId, 'pendingProposal must be armed this turn');
  assert.equal(armed.kind, 'slot_merge');
  // Turn stops at merge confirm — the next-question part2 is replaced.
  assert.match(data.text, /合并|并入/);
  assert.match(data.text, /采纳/);
  assert.doesNotMatch(data.text, /第二问/);
});

check('reject merge → ledger blocks re-arm from lingering meta text', () => {
  const payload = basePayload(mergeIncidentPoints());
  const merge = buildSlotMergeFromBoardMeta(payload, incidentUserPoints);
  payload.pendingProposal = merge;
  const res = resolvePendingProposalDecision({
    prevPayload: payload,
    prevUserPoints: incidentUserPoints,
    userMessage: '拒绝',
    decision: { type: 'proposal', action: 'reject', proposalId: merge.proposalId },
  });
  assert.equal(res.handled, true);
  assert.equal(res.rejected, true);
  const cleared = res.result.payload;
  assert.ok(cleared.rejectedMergeIds.includes(merge.proposalId));
  // Meta text still on the board — but detection must now skip this pair.
  assert.equal(
    buildSlotMergeFromBoardMeta(
      { ...cleared, pendingProposal: null },
      incidentUserPoints,
    ),
    null,
  );
});

check('accept merge: meta-narration is NOT folded into target body', () => {
  const payload = basePayload(mergeIncidentPoints());
  const merge = buildSlotMergeFromBoardMeta(payload, incidentUserPoints);
  const committed = commitProposal({
    payload,
    proposal: merge,
    userPoints: incidentUserPoints,
  });
  assert.equal(committed.ok, true);
  const p1 = committed.payload.points.find((p) => p.id === 'p1');
  const p3 = committed.payload.points.find((p) => p.id === 'p3');
  assert.equal(p3.supersededBy, 'p1');
  assert.doesNotMatch(String(p1.elaboration), /已整合至/);
  assert.match(String(p1.elaboration), /圣诞节/);
});

// ---------------------------------------------------------------------------
// Anti-forgery: model may not mint locked 详写/略写/放弃 tags in userPoints.
// Incident: the recommend turn self-tagged ALL slots (B-side got 用户放弃).
// ---------------------------------------------------------------------------

check('forged retention locks stripped; legit prev locks survive; body kept', () => {
  const prev =
    'A面：强势文化冲击（原因）：外来影视流行（已选详写）；网络普及（原因）：传播快';
  const next =
    'A面：强势文化冲击（原因）：外来影视流行（已选详写）；网络普及（原因）：传播快（用户放弃）；全球消费主义（原因）：圣诞促销（已选略写）\nB面：国际交流（评价）：待加深（用户放弃）；文化多样性（评价）：本土被冷落（用户放弃）';
  const out = stripForgedRetentionLocks(prev, next);
  // Legit lock (existed in prev) survives.
  assert.match(out, /强势文化冲击[^；]*已选详写/);
  // Forged locks (freshly minted by the model) are all gone.
  assert.doesNotMatch(out, /用户放弃/);
  assert.doesNotMatch(out, /已选略写/);
  // Chunk bodies stay intact.
  assert.match(out, /网络普及（原因）：传播快/);
  assert.match(out, /文化多样性（评价）：本土被冷落/);
});

check('no prev locks (incident) → every model-minted lock stripped; clean text untouched', () => {
  const next =
    '强势文化冲击（已选详写）；网络普及（用户放弃）；全球消费主义（已选略写）';
  const out = stripForgedRetentionLocks('', next);
  assert.doesNotMatch(out, /已选详写|已选略写|用户放弃/);
  assert.match(out, /强势文化冲击/);
  const clean = '强势文化冲击：外来影视流行；网络普及：传播快';
  assert.equal(stripForgedRetentionLocks('', clean), clean);
});

// ---------------------------------------------------------------------------
// Drop narrated as merge: a content-bearing slot in retentionSuggestion.drop
// with「合并/并入」wording must arm slot_merge first — settle's drop never
// folds content. Unresolvable target → demote to brief, never silent loss.
// ---------------------------------------------------------------------------

check('drop-with-content + merge narration → slot_merge armed before settle', () => {
  const payload = settleScenarioPayload();
  payload.pendingProposal = null;
  const armed = armNextProposal({
    payload,
    retentionSuggestion: {
      detail: ['强势文化冲击'],
      brief: ['全球消费主义'],
      drop: ['网络普及'],
      reason:
        '强势文化和消费主义论据更具体，网络可作为传播渠道合并入强势文化中限制篇幅叙述性展开',
    },
  });
  assert.ok(armed);
  assert.equal(armed.kind, 'slot_merge');
  assert.equal(armed.payload.fromSlotId, 'p2');
  assert.equal(armed.payload.intoSlotId, 'p1');
});

check('merge target unresolvable → content drop demoted to brief in settle', () => {
  const payload = settleScenarioPayload();
  payload.pendingProposal = null;
  const armed = armNextProposal({
    payload,
    retentionSuggestion: {
      detail: ['强势文化冲击'],
      brief: ['全球消费主义'],
      drop: ['网络普及'],
      reason: '篇幅有限，网络这条可以合并叙述',
    },
  });
  assert.ok(armed);
  assert.equal(armed.kind, 'side_settle');
  const roles = Object.fromEntries(
    armed.payload.assignments.map((a) => [a.slotId, a.role]),
  );
  assert.equal(roles.p1, 'detail');
  assert.equal(roles.p2, 'brief');
  assert.equal(roles.p3, 'brief');
});

check('merge rejected earlier → settle demotes the drop instead of re-arming', () => {
  const payload = settleScenarioPayload();
  payload.pendingProposal = null;
  payload.rejectedMergeIds = ['merge-p2-p1'];
  const armed = armNextProposal({
    payload,
    retentionSuggestion: {
      detail: ['强势文化冲击'],
      brief: ['全球消费主义'],
      drop: ['网络普及'],
      reason: '网络可作为传播渠道合并入强势文化中',
    },
  });
  assert.ok(armed);
  assert.equal(armed.kind, 'side_settle');
  const roles = Object.fromEntries(
    armed.payload.assignments.map((a) => [a.slotId, a.role]),
  );
  assert.equal(roles.p2, 'brief');
});

check('content drop WITHOUT merge narration keeps the explicit drop', () => {
  const payload = settleScenarioPayload();
  payload.pendingProposal = null;
  const armed = armNextProposal({
    payload,
    retentionSuggestion: {
      detail: ['强势文化冲击'],
      brief: ['全球消费主义'],
      drop: ['网络普及'],
      reason: '网络这条信息量最少，建议放下',
    },
  });
  assert.ok(armed);
  assert.equal(armed.kind, 'side_settle');
  const roles = Object.fromEntries(
    armed.payload.assignments.map((a) => [a.slotId, a.role]),
  );
  assert.equal(roles.p2, 'dropped');
});

console.log(`\n${passed} Phase0 checks passed.\n`);
