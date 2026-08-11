/**
 * Replay: checklist walk gate + single-side capacity trim (not whole-essay count).
 */
import assert from 'node:assert/strict';
import {
  activePoints,
  applyRetentionChoiceFromIntent,
  coachMessageIsContentAskNotDecision,
  coachMessageLooksLikeRetentionDecision,
  coachMessageLooksLikeSlotAddDecision,
  coachMessageLooksLikeStanceDecision,
  findOverloadedSide,
  findBestSemanticSlot,
  freezeLeanTags,
  inferRetentionRoleFromText,
  isElaborationScaffoldLabel,
  isNearDuplicateElaboration,
  isPointExpandedForWalk,
  isPointWalked,
  isProcessAdvanceProposal,
  isStep2ChecklistWalkDone,
  listUnwalkedChecklistPoints,
  cleanElaboration,
  pointHasSubstantiveContent,
  normalizeStep2PlannerPayload,
  pointSideKey,
  resolveProposedClaimAgainstBoard,
  resolveNextSideWalkStep,
  resolveSlotAddDecision,
  setCanonicalElaboration,
  scorePointQuality,
  settleSideRetentionAfterAccept,
  formatSideRetentionPendingMarker,
  parseSideRetentionSchemeFromCoachText,
  seedFixedSlotsFromDimensions,
  dropRedundantGeneral,
  isTaskRoleLabel,
  stampRetentionTagOnUserPoints,
  applyRetentionRolesFromUserPoints,
  textLooksLikePrematureSideAdvance,
  upsertPointsFromClaims,
  attachTextToPointId,
} from '../src/server/step2/planner-payload.ts';
import {
  classifyStep2StudentTurnHeuristic,
  isMetaProcessMessage,
  parseRetentionChoiceMessage,
  parseStep2StudentTurnIntentLlm,
} from '../src/server/step2/student-turn-intent.ts';
import {
  detectOffBoardCoachTheme,
  enforceStep2AskContract,
  textLooksLikePrematureStanceAsk,
} from '../src/server/step2/ask-contract.ts';

function pt(partial) {
  return {
    id: partial.id,
    claim: partial.claim,
    elaboration: partial.elaboration || '',
    leanTags: partial.leanTags || ['general'],
    quality: partial.quality || 'thin',
    retentionRole: partial.retentionRole,
    fromDimension: partial.fromDimension || partial.claim,
    seedOnly: partial.seedOnly,
  };
}

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`✓ ${name}`);
}

check('4 Step1 slots: 2 ready without retention → not done', () => {
  const payload = {
    slotsLocked: true,
    fixedClaims: ['西方文化', '数字化', '国际交流', '全球商业'],
    points: [
      pt({
        id: 'p1',
        claim: '西方文化',
        elaboration: '影视歌曲节日渗透年轻人生活',
        leanTags: ['part_1'],
        quality: 'ready',
      }),
      pt({
        id: 'p2',
        claim: '数字化',
        elaboration: '网络加速外来文化传播',
        leanTags: ['part_1'],
        quality: 'ready',
      }),
      pt({ id: 'p3', claim: '国际交流', leanTags: ['part_2'], quality: 'thin' }),
      pt({ id: 'p4', claim: '全球商业', leanTags: ['part_2'], quality: 'thin' }),
    ],
  };
  const unwalked = listUnwalkedChecklistPoints(payload, []);
  assert.equal(unwalked.length, 4);
  assert.equal(isStep2ChecklistWalkDone(payload, []), false);
});

check('all walked with retention → done; no premature stance on buckets alone', () => {
  const payload = {
    slotsLocked: true,
    fixedClaims: ['西方文化', '数字化', '国际交流', '全球商业'],
    coverage: {
      passed: true,
      requiredBuckets: ['part_1', 'part_2'],
      filledBuckets: ['part_1', 'part_2'],
      missingBuckets: [],
      softMissingBuckets: [],
    },
    points: [
      pt({
        id: 'p1',
        claim: '西方文化',
        elaboration: '影视歌曲节日渗透',
        leanTags: ['part_1'],
        quality: 'ready',
        retentionRole: 'detail',
      }),
      pt({
        id: 'p2',
        claim: '数字化',
        elaboration: '网络加速传播',
        leanTags: ['part_1'],
        quality: 'ready',
        retentionRole: 'brief',
      }),
      pt({
        id: 'p3',
        claim: '国际交流',
        elaboration: '通用语言便利跨国交流',
        leanTags: ['part_2'],
        quality: 'ready',
        retentionRole: 'detail',
      }),
      pt({
        id: 'p4',
        claim: '全球商业',
        elaboration: '跨国公司经营与就业',
        leanTags: ['part_2'],
        quality: 'ready',
        retentionRole: 'brief',
      }),
    ],
  };
  assert.equal(listUnwalkedChecklistPoints(payload, []).length, 0);
  assert.equal(isStep2ChecklistWalkDone(payload, []), true);
  // 2+2 sides — not overloaded
  assert.equal(findOverloadedSide(payload, []), null);
});

check('single side ≥3 developed+walked → overload (not total count)', () => {
  const payload = {
    points: [
      pt({
        id: 'a',
        claim: '原因甲',
        elaboration: '场景甲很长很长',
        leanTags: ['part_1'],
        quality: 'ready',
        retentionRole: 'detail',
      }),
      pt({
        id: 'b',
        claim: '原因乙',
        elaboration: '场景乙很长很长',
        leanTags: ['part_1'],
        quality: 'ready',
        retentionRole: 'brief',
      }),
      pt({
        id: 'c',
        claim: '原因丙',
        elaboration: '场景丙很长很长',
        leanTags: ['part_1'],
        quality: 'ready',
        retentionRole: 'brief',
      }),
      pt({
        id: 'd',
        claim: '评价丁',
        elaboration: '评价场景丁',
        leanTags: ['part_2'],
        quality: 'ready',
        retentionRole: 'detail',
      }),
    ],
  };
  const over = findOverloadedSide(payload, []);
  assert.ok(over);
  assert.equal(over.sideKey, 'part_1');
  assert.equal(over.points.length, 3);
  assert.equal(pointSideKey(payload.points[3]), 'part_2');
});

check('stampRetentionTagOnUserPoints + applyRetentionRoles', () => {
  let up = 'A面：西方文化（影视渗透）；数字化（网络加速）';
  up = stampRetentionTagOnUserPoints(up, '西方文化', 'detail');
  up = stampRetentionTagOnUserPoints(up, '数字化', 'brief');
  assert.match(up, /已选详写/);
  assert.match(up, /已选略写/);
  const points = applyRetentionRolesFromUserPoints(
    [
      pt({ id: '1', claim: '西方文化', quality: 'ready', elaboration: '影视' }),
      pt({ id: '2', claim: '数字化', quality: 'ready', elaboration: '网络' }),
    ],
    up,
  );
  assert.equal(points[0].retentionRole, 'detail');
  assert.equal(points[1].retentionRole, 'brief');
  assert.equal(isPointWalked(points[0], []), true);
});

check('capacity trim dismiss after brief prevents re-ask', () => {
  const payload = {
    capacityTrimDismissedSides: ['part_1'],
    points: [
      pt({
        id: 'a',
        claim: '甲',
        elaboration: '很长很长内容甲',
        leanTags: ['part_1'],
        quality: 'ready',
        retentionRole: 'detail',
      }),
      pt({
        id: 'b',
        claim: '乙',
        elaboration: '很长很长内容乙',
        leanTags: ['part_1'],
        quality: 'ready',
        retentionRole: 'brief',
      }),
      pt({
        id: 'c',
        claim: '丙',
        elaboration: '很长很长内容丙',
        leanTags: ['part_1'],
        quality: 'ready',
        retentionRole: 'brief',
      }),
    ],
  };
  assert.equal(findOverloadedSide(payload), null);
  assert.equal(activePoints(payload).length, 3);
});

check('stance decision does not resolve pending slot-add', () => {
  assert.equal(
    resolveSlotAddDecision({
      userMessage: '采纳',
      decision: { type: 'stance', action: 'accept' },
      hasPending: true,
    }),
    null,
  );
  assert.equal(
    resolveSlotAddDecision({
      userMessage: '采纳',
      decision: { type: 'slot_add', action: 'accept' },
      hasPending: true,
    }),
    'accept',
  );
});

check('content ask is not a decision proposal', () => {
  const thin =
    '反馈……\n\n---\n\n「数字化与网络普及（原因）」目前还偏薄：请补 1–2 句具体场景、机制或受影响对象，方便写成可展开的论据。';
  assert.equal(coachMessageIsContentAskNotDecision(thin), true);
  assert.equal(coachMessageLooksLikeRetentionDecision(thin), false);
  assert.equal(coachMessageLooksLikeSlotAddDecision(thin), false);
  assert.equal(coachMessageLooksLikeStanceDecision(thin), false);

  const retention =
    '很好。\n\n---\n\n我建议：**详写**『西方文化』，**略写**『数字化』。请点击下方「采纳」或「拒绝」。';
  assert.equal(coachMessageIsContentAskNotDecision(retention), false);
  assert.equal(coachMessageLooksLikeRetentionDecision(retention), true);

  const slot =
    '好的。\n\n---\n\n我建议把『就业机会』作为一条新的平行论点加入材料池。请点击下方「采纳」或「拒绝」（仅「采纳」会新增；其它回复视为拒绝）。';
  assert.equal(coachMessageLooksLikeSlotAddDecision(slot), true);

  const expandWalk =
    '目前材料池有：\n① 西方\n② 数字化\n『数字化』还没展开到可写程度。请先补 1–2 句具体场景、机制或受影响对象；补完后再按各条可写量定详写/略写（不默认一详一略）。';
  assert.equal(coachMessageIsContentAskNotDecision(expandWalk), true);
  assert.equal(coachMessageLooksLikeRetentionDecision(expandWalk), false);
});

check('intent: meta / 详细写1 / no false slot-add', () => {
  assert.equal(isMetaProcessMessage('这个前面不是已经问过了'), true);
  assert.equal(
    classifyStep2StudentTurnHeuristic({
      userMessage: '这个前面不是已经问过了',
    }).kind,
    'meta_process',
  );
  const r = parseRetentionChoiceMessage('详细写1');
  assert.equal(r?.role, 'detail');
  assert.equal(r?.targetIndex, 1);
  assert.equal(r?.pairBriefOthers, false);

  const metaNorm = normalizeStep2PlannerPayload({
    session: {
      step1: {
        coachEvaluation: {
          suggestedDimensions: [
            '西方强势文化冲击（原因）（可展开）（已探测）',
            '数字化与网络普及（原因）（可展开）（已探测）',
          ],
        },
      },
      step2: {
        coachEvaluation: {
          plannerPayload: {
            slotsLocked: true,
            fixedClaims: ['西方强势文化冲击（原因）', '数字化与网络普及（原因）'],
            focusMode: 'none',
            points: [
              pt({
                id: 'p1',
                claim: '西方强势文化冲击（原因）',
                elaboration: '青年人偏爱迪士尼',
                quality: 'ready',
                leanTags: ['cause'],
              }),
              pt({
                id: 'p2',
                claim: '数字化与网络普及（原因）',
                elaboration: '网络传播快',
                quality: 'ready',
                leanTags: ['cause'],
              }),
            ],
          },
        },
      },
    },
    step2Data: {
      userPoints: 'A面：西方；数字化',
      plannerPayload: null,
    },
    questionType: 'Two-part Question',
    requiresStance: false,
    userMessage: '这个前面不是已经问过了',
    coachText: '「国际交流便利性」目前还偏薄：请补一句。',
    studentTurnIntent: {
      kind: 'meta_process',
      confidence: 1,
      source: 'heuristic',
    },
  });
  assert.equal(metaNorm.pendingSlotAdd, null);
  const west = metaNorm.points.find((p) => /西方/.test(p.claim) && !p.supersededBy);
  assert.doesNotMatch(String(west?.elaboration || ''), /前面不是已经问过/);

  const retNorm = normalizeStep2PlannerPayload({
    session: {
      step1: {
        coachEvaluation: {
          suggestedDimensions: [
            '西方强势文化冲击（原因）（可展开）（已探测）',
            '数字化与网络普及（原因）（可展开）（已探测）',
          ],
        },
      },
      step2: {
        coachEvaluation: {
          plannerPayload: {
            slotsLocked: true,
            fixedClaims: ['西方强势文化冲击（原因）', '数字化与网络普及（原因）'],
            points: [
              pt({
                id: 'p1',
                claim: '西方强势文化冲击（原因）',
                elaboration: '青年人偏爱迪士尼',
                quality: 'ready',
                leanTags: ['cause', 'part_1'],
              }),
              pt({
                id: 'p2',
                claim: '数字化与网络普及（原因）',
                elaboration: '网络传播快触达广',
                quality: 'ready',
                leanTags: ['cause', 'part_1'],
              }),
            ],
          },
        },
      },
    },
    step2Data: {
      userPoints:
        'A面：西方强势文化冲击：青年人偏爱迪士尼；数字化与网络普及：网络传播快触达广',
    },
    questionType: 'Two-part Question',
    requiresStance: false,
    userMessage: '详细写1',
    coachText:
      '你更倾向于把哪一条作为详写，哪一条作为略写？还是说你希望两条都详写？',
    studentTurnIntent: {
      kind: 'retention_choice',
      retention: { role: 'detail', targetIndex: 1, pairBriefOthers: false },
      confidence: 1,
      source: 'heuristic',
    },
  });
  const p1 = retNorm.points.find((p) => p.id === 'p1' || /西方/.test(p.claim));
  const p2 = retNorm.points.find((p) => p.id === 'p2' || /数字化/.test(p.claim));
  assert.equal(p1?.retentionRole, 'detail');
  // No silent pair-brief: sibling stays unsettled until student chooses
  assert.notEqual(p2?.retentionRole, 'brief');
  assert.equal(isPointWalked(p1), true);
  assert.equal(isPointWalked(p2), false);
});

check('canonical elaboration: near-dup / fill ignores paraphrase pile-up', () => {
  const a =
    '青年人喜欢迪士尼电影，听欧美流行音乐等，外来文化被认为是新潮高级的文化，传统文化则是落后过时的';
  const b =
    '青少年喜爱迪士尼电影和欧美流行乐，将外来文化视作新潮与高级，而将传统文化贬为落后过时';
  assert.equal(isNearDuplicateElaboration(a, b), true);
  const point = pt({
    id: 'p1',
    claim: '西方强势文化冲击',
    elaboration: a,
    quality: 'ready',
  });
  setCanonicalElaboration(point, b, 'fill');
  assert.ok(!String(point.elaboration).includes('；'));
  // Single body only — richer paraphrase wins, no concatenation
  assert.equal(String(point.elaboration).split('；').length, 1);

  const other = pt({
    id: 'p2',
    claim: '数字化与网络普及',
    elaboration: '网络传播快',
    quality: 'ready',
  });
  setCanonicalElaboration(other, '完全无关的另一段话关于就业机会增加', 'fill');
  assert.equal(other.elaboration, '网络传播快');
});

check('off-board coach theme → detect; ask-contract arms pendingSlotAdd', () => {
  // detect still finds off-board labels
  const payload = {
    slotsLocked: true,
    fixedClaims: ['西方文化', '数字化', '国际交流', '全球商业'],
    points: [
      pt({ id: 'p1', claim: '西方文化', leanTags: ['part_1'], quality: 'ready', elaboration: '影视', retentionRole: 'detail' }),
      pt({ id: 'p2', claim: '数字化', leanTags: ['part_1'], quality: 'ready', elaboration: '网络', retentionRole: 'brief' }),
      pt({ id: 'p3', claim: '国际交流', leanTags: ['part_2'], quality: 'ready', elaboration: '交流便利', retentionRole: 'detail' }),
      pt({ id: 'p4', claim: '全球商业', leanTags: ['part_2'], quality: 'ready', elaboration: '跨国经营', retentionRole: 'brief' }),
    ],
  };
  assert.equal(isStep2ChecklistWalkDone(payload, []), true);
  const off = detectOffBoardCoachTheme(
    '好的。\n\n---\n\n从负面来看，这种同质化是否也会削弱「文化多样性与身份认同」？请补 1–2 句。',
    payload,
  );
  assert.ok(off);
  assert.match(off, /文化多样性|身份认同/);

  const data = {
    text: '记下了。\n\n---\n\n从负面来看，同质化是否削弱「文化多样性与身份认同」？',
    progressUpdate: {
      step2Data: {
        currentStage: 'explore_B',
        userPoints: 'A面：西方；数字化',
        plannerPayload: { ...payload, pendingSlotAdd: null },
      },
    },
  };
  enforceStep2AskContract(data, {}, {
    safeOverridePart1: (t) => String(t).split('---')[0].trim() || '好的。',
    buildContentAwareFallback: () => '请先展开「全球商业」。',
  });
  assert.ok(data.progressUpdate.step2Data.plannerPayload.pendingSlotAdd?.claim);
  assert.match(data.text, /加入材料池|采纳/);
});

check('checklist unfinished → coach slot-add for list item scrubbed to next walk', () => {
  const points = [
    pt({
      id: 'p1',
      claim: '西方强势文化冲击（原因）',
      leanTags: ['part_1'],
      quality: 'ready',
      elaboration: '影视剧潮流让年轻人追求新潮高级',
      retentionRole: 'detail',
    }),
    pt({
      id: 'p2',
      claim: '数字化与网络普及（原因）',
      leanTags: ['part_1'],
      quality: 'thin',
    }),
  ];
  const data = {
    text:
      '影视剧等潮流文化的传播机制非常具体！\n\n---\n\n我建议把『②网络与技术的普及』作为一条新的平行论点加入材料池。请点击下方「采纳」或「拒绝」。',
    progressUpdate: {
      step2Data: {
        currentStage: 'explore_A',
        userPoints: '西方…',
        plannerPayload: {
          slotsLocked: true,
          fixedClaims: [
            '西方强势文化冲击（原因）',
            '数字化与网络普及（原因）',
          ],
          points,
          pendingSlotAdd: { claim: '网络与技术的普及' },
        },
      },
    },
  };
  enforceStep2AskContract(data, {}, {
    safeOverridePart1: (t) => String(t).split('---')[0].trim() || '好的。',
    buildContentAwareFallback: (_s, step2) => {
      const u = listUnwalkedChecklistPoints(step2.plannerPayload, []);
      const claim = u[0]?.claim || '下一条';
      return `「${claim}」目前还偏薄：请补 1–2 句具体场景、机制或受影响对象，方便写成可展开的论据。`;
    },
  });
  assert.equal(
    data.progressUpdate.step2Data.plannerPayload.pendingSlotAdd,
    null,
  );
  assert.match(data.text, /数字化与网络普及|目前还偏薄/);
  assert.doesNotMatch(data.text, /请点击下方「采纳」|加入材料池/);
});

check('premature stance scrubbed while checklist incomplete', () => {
  const payload = {
    slotsLocked: true,
    fixedClaims: ['西方文化', '数字化', '国际交流', '全球商业'],
    points: [
      pt({
        id: 'p1',
        claim: '西方文化',
        leanTags: ['part_1'],
        quality: 'ready',
        elaboration: '影视渗透',
        retentionRole: 'detail',
      }),
      pt({ id: 'p2', claim: '数字化', leanTags: ['part_1'], quality: 'thin' }),
      pt({ id: 'p3', claim: '国际交流', leanTags: ['part_2'], quality: 'thin' }),
      pt({ id: 'p4', claim: '全球商业', leanTags: ['part_2'], quality: 'thin' }),
    ],
  };
  const stanceText =
    '材料齐了。\n\n---\n\n我更推荐带让步的立场：虽然文化交流便利，但消极影响更大。你同意这个立场吗？请采纳或拒绝。';
  assert.equal(textLooksLikePrematureStanceAsk(stanceText), true);
  const data = {
    text: stanceText,
    progressUpdate: {
      isCompleted: false,
      step2Data: {
        currentStage: 'stance',
        plannerPayload: { ...payload, pendingStanceConfirm: { text: 'x' } },
      },
    },
  };
  enforceStep2AskContract(data, {}, {
    safeOverridePart1: (t) => String(t).split('---')[0].trim() || '好的。',
    buildContentAwareFallback: () => '「数字化」目前还偏薄：请补 1–2 句。',
  });
  assert.equal(data.progressUpdate.step2Data.plannerPayload.pendingStanceConfirm, null);
  assert.match(data.text, /数字化|偏薄/);
  assert.notEqual(data.progressUpdate.step2Data.currentStage, 'stance');
});

check('stance CTA text is recognized as stance decision', () => {
  const cta =
    '好的。\n\n---\n\n上面是基于你材料的立场推荐。请点击「采纳」锁定，或「拒绝」后告诉我你想改成哪种立场。';
  assert.equal(coachMessageLooksLikeStanceDecision(cta), true);
});

check('no silent pairBrief + leanTags freeze by side', () => {
  const applied = applyRetentionChoiceFromIntent(
    [
      pt({
        id: 'p1',
        claim: '西方',
        quality: 'ready',
        elaboration: '影视',
        leanTags: ['part_1'],
      }),
      pt({
        id: 'p2',
        claim: '数字化',
        quality: 'ready',
        elaboration: '网络',
        leanTags: ['part_1'],
      }),
    ],
    {
      kind: 'retention_choice',
      retention: { role: 'detail', targetIndex: 1, pairBriefOthers: true },
      confidence: 1,
      source: 'heuristic',
    },
  );
  assert.equal(applied.points[0].retentionRole, 'detail');
  assert.notEqual(applied.points[1].retentionRole, 'brief');

  const tags = freezeLeanTags(['part_1'], ['part_2', 'negative', 'positive']);
  assert.ok(tags.includes('part_1'));
  assert.ok(!tags.includes('part_2'));
});

check('truncated intent JSON still parses', () => {
  const parsed = parseStep2StudentTurnIntentLlm(
    '{"kind":"content_elaboration","mountClaim":"数字化","confidence":0.8',
  );
  assert.equal(parsed?.kind, 'content_elaboration');
  assert.equal(parsed?.claimHint, '数字化');
});

check('same-theme 跨国合作 → 国际交流 slot; process advance no confirm', () => {
  const points = [
    pt({
      id: 'p3',
      claim: '国际交流便利性（评价）',
      leanTags: ['part_2'],
      quality: 'thin',
    }),
    pt({
      id: 'p4',
      claim: '全球商业',
      leanTags: ['part_2'],
      quality: 'thin',
    }),
  ];
  const same = resolveProposedClaimAgainstBoard(points, '跨国合作');
  assert.equal(same.kind, 'same_slot');
  if (same.kind === 'same_slot') {
    assert.match(same.point.claim, /国际交流/);
  }
  const sem = findBestSemanticSlot(points, '跨国合作');
  assert.ok(sem);
  assert.match(sem.claim, /国际交流/);

  const task = '这一现象是积极的还是消极的发展？';
  assert.equal(isProcessAdvanceProposal(task), true);
  const proc = resolveProposedClaimAgainstBoard(
    points,
    task,
    '好的。\n\n---\n\n我建议把『这一现象是积极的还是消极的发展？』作为一条新的平行论点加入材料池。',
  );
  assert.equal(proc.kind, 'process_advance');

  // Truly new angle still new_parallel
  const neu = resolveProposedClaimAgainstBoard(points, '就业机会增加');
  assert.equal(neu.kind, 'new_parallel');
});

check('ask-contract: process advance + same-theme scrub pendingSlotAdd', () => {
  const points = [
    pt({
      id: 'p3',
      claim: '国际交流便利性',
      leanTags: ['part_2'],
      quality: 'thin',
    }),
  ];
  const dataProc = {
    text: '齐了。\n\n---\n\n我建议把『这一现象是积极的还是消极的发展？』加入材料池。请采纳。',
    progressUpdate: {
      step2Data: {
        currentStage: 'explore_B',
        userPoints: 'x',
        plannerPayload: {
          slotsLocked: true,
          fixedClaims: ['国际交流便利性'],
          points,
          pendingSlotAdd: { claim: '这一现象是积极的还是消极的发展？' },
        },
      },
    },
  };
  enforceStep2AskContract(dataProc, {}, {
    safeOverridePart1: (t) => String(t).split('---')[0].trim() || '好的。',
    buildContentAwareFallback: () => '请展开「国际交流便利性」。',
  });
  assert.equal(
    dataProc.progressUpdate.step2Data.plannerPayload.pendingSlotAdd,
    null,
  );
  assert.doesNotMatch(dataProc.text, /请点击下方「采纳」/);

  const dataSame = {
    text: '开始第二问。\n\n---\n\n我建议把『跨国合作』作为一条新的平行论点加入材料池。',
    progressUpdate: {
      step2Data: {
        currentStage: 'explore_B',
        userPoints: 'x',
        plannerPayload: {
          slotsLocked: true,
          fixedClaims: ['国际交流便利性'],
          points,
          pendingSlotAdd: { claim: '跨国合作' },
        },
      },
    },
  };
  enforceStep2AskContract(dataSame, {}, {
    safeOverridePart1: (t) => String(t).split('---')[0].trim() || '好的。',
    buildContentAwareFallback: (_s, step2) => {
      const u = listUnwalkedChecklistPoints(step2.plannerPayload, []);
      return `「${u[0]?.claim || '下一条'}」目前还偏薄：请补内容。`;
    },
  });
  assert.equal(
    dataSame.progressUpdate.step2Data.plannerPayload.pendingSlotAdd,
    null,
  );
  // Checklist unfinished → walk next frozen slot, not slot-add confirm
  assert.match(dataSame.text, /国际交流|还偏薄/);
  assert.doesNotMatch(dataSame.text, /请点击下方「采纳」/);
});

check('scaffold label 具体渠道或场景 is process — no slot-add confirm', () => {
  const scaffold = '具体渠道或场景';
  assert.equal(isElaborationScaffoldLabel(scaffold), true);
  assert.equal(isProcessAdvanceProposal(scaffold), true);
  const points = [
    pt({
      id: 'p1',
      claim: '西方强势文化冲击（原因）',
      leanTags: ['part_1'],
      quality: 'thin',
    }),
  ];
  const resolved = resolveProposedClaimAgainstBoard(
    points,
    scaffold,
    '欢迎来到第二步材料收集。\n\n---\n\n我建议把『具体渠道或场景』作为一条新的平行论点加入材料池。请点击下方「采纳」或「拒绝」。',
  );
  assert.equal(resolved.kind, 'process_advance');

  const data = {
    text: '欢迎来到第二步材料收集。\n\n---\n\n我建议把『具体渠道或场景』作为一条新的平行论点加入材料池。请点击下方「采纳」或「拒绝」。',
    progressUpdate: {
      step2Data: {
        currentStage: 'explore_A',
        userPoints: '',
        plannerPayload: {
          slotsLocked: true,
          fixedClaims: ['西方强势文化冲击（原因）'],
          points,
          pendingSlotAdd: { claim: scaffold },
        },
      },
    },
  };
  enforceStep2AskContract(data, {}, {
    safeOverridePart1: (t) => String(t).split('---')[0].trim() || '好的。',
    buildContentAwareFallback: () =>
      '「西方强势文化冲击」目前还偏薄：请补 1–2 句具体场景、机制或受影响对象。',
  });
  assert.equal(
    data.progressUpdate.step2Data.plannerPayload.pendingSlotAdd,
    null,
  );
  assert.match(data.text, /西方|偏薄|场景/);
  assert.doesNotMatch(data.text, /请点击下方「采纳」/);
});

check('board-order walk: cause1 done → next is cause2, not eval thin', () => {
  const payload = {
    slotsLocked: true,
    fixedClaims: [
      '主流文化冲击（原因）',
      '网络与技术普及（原因）',
      '商业全球化与消费主义（原因）',
      '全球沟通（评价）',
      '经济效益（评价）',
    ],
    points: [
      pt({
        id: 'p1',
        claim: '主流文化冲击（原因）',
        leanTags: ['part_1'],
        quality: 'ready',
        elaboration: '影视剧潮流让年轻人追求新潮高级而冷落本土',
        retentionRole: 'detail',
      }),
      pt({
        id: 'p2',
        claim: '网络与技术普及（原因）',
        leanTags: ['part_1'],
        elaboration: '网络与技术普及（待裁决）',
        quality: 'ready',
      }),
      pt({
        id: 'p3',
        claim: '商业全球化与消费主义（原因）',
        leanTags: ['part_1'],
        quality: 'thin',
      }),
      pt({
        id: 'p4',
        claim: '全球沟通（评价）',
        leanTags: ['part_2'],
        quality: 'thin',
      }),
      pt({
        id: 'p5',
        claim: '经济效益（评价）',
        leanTags: ['part_2'],
        quality: 'thin',
      }),
    ],
  };
  assert.equal(pointHasSubstantiveContent(payload.points[1]), false);
  assert.equal(scorePointQuality(payload.points[2].claim, ''), 'thin');
  const next = resolveNextSideWalkStep(payload, []);
  assert.equal(next.kind, 'expand');
  if (next.kind === 'expand') {
    assert.match(next.point.claim, /网络与技术普及/);
  }
});

check('side walk: expand all causes then one retention; task label no slot-add', () => {
  assert.equal(isTaskRoleLabel('原因/成因'), true);
  assert.equal(
    resolveProposedClaimAgainstBoard([], '原因/成因').kind,
    'process_advance',
  );

  const payload = {
    slotsLocked: true,
    points: [
      pt({
        id: 'p1',
        claim: '主流文化冲击（原因）',
        leanTags: ['part_1'],
        quality: 'ready',
        elaboration: '影视剧潮流让年轻人追求新潮高级而冷落本土文化',
      }),
      pt({
        id: 'p2',
        claim: '网络与技术普及（原因）',
        leanTags: ['part_1'],
        quality: 'ready',
        elaboration: '数字网络高速传播让传统文化被跨国文化淹没',
      }),
      pt({
        id: 'p3',
        claim: '商业全球化与消费主义（原因）',
        leanTags: ['part_1'],
        quality: 'ready',
        elaboration: '跨国品牌广告挤占传统生活方式的生存空间',
      }),
      pt({
        id: 'p4',
        claim: '全球沟通（评价）',
        leanTags: ['part_2'],
        quality: 'thin',
      }),
    ],
  };
  const next = resolveNextSideWalkStep(payload, []);
  assert.equal(next.kind, 'side_retention');
  if (next.kind === 'side_retention') {
    assert.equal(next.sideKey, 'part_1');
    assert.equal(next.points.length, 3);
  }

  const jump =
    '至此两个原因很扎实。\n\n---\n\n接下来我们进入第二问：积极的还是消极的发展？';
  assert.equal(textLooksLikePrematureSideAdvance(jump), true);

  const data = {
    text: jump,
    progressUpdate: {
      step2Data: {
        currentStage: 'explore_B',
        userPoints: '',
        plannerPayload: { ...payload, pendingSlotAdd: null },
      },
    },
  };
  enforceStep2AskContract(data, {}, {
    safeOverridePart1: (t) => String(t).split('---')[0].trim() || '好的。',
    buildContentAwareFallback: () =>
      '「第一问」这一侧的材料都已展开。按信息量建议详写……请点击「采纳」或「拒绝」。',
  });
  assert.match(data.text, /采纳|详写|第一问|材料都已展开/);
  assert.doesNotMatch(data.text, /进入第二问/);

  const dataTask = {
    text: '好的。\n\n---\n\n我建议把『原因/成因』作为一条新的平行论点加入材料池。请点击下方「采纳」或「拒绝」。',
    progressUpdate: {
      step2Data: {
        currentStage: 'summary',
        userPoints: '',
        plannerPayload: {
          slotsLocked: true,
          points: payload.points.map((p) => ({
            ...p,
            retentionRole: 'detail',
          })),
          pendingSlotAdd: { claim: '原因/成因' },
        },
      },
    },
  };
  enforceStep2AskContract(dataTask, {}, {
    safeOverridePart1: (t) => String(t).split('---')[0].trim() || '好的。',
    buildContentAwareFallback: () => '请继续。',
  });
  assert.equal(
    dataTask.progressUpdate.step2Data.plannerPayload.pendingSlotAdd,
    null,
  );
});

check('side retention accept: lock roles, drop empty sibling, advance side', () => {
  const points = [
    {
      id: 'p1',
      claim: '主流文化冲击（原因）',
      leanTags: ['part_1'],
      quality: 'ready',
      elaboration: '影视剧潮流让年轻人追求新潮高级而冷落本土文化',
    },
    {
      id: 'p2',
      claim: '网络与技术普及（原因）',
      leanTags: ['part_1'],
      quality: 'thin',
      elaboration: '',
    },
    {
      id: 'p3',
      claim: '商业全球化与消费主义（原因）',
      leanTags: ['part_1'],
      quality: 'ready',
      elaboration: '跨国品牌广告挤占传统生活方式的生存空间',
    },
    {
      id: 'p4',
      claim: '全球沟通（评价）',
      leanTags: ['part_2'],
      quality: 'thin',
      elaboration: '',
    },
  ];

  const marker = formatSideRetentionPendingMarker('part_1', [
    points[0],
    points[2],
  ]);
  assert.match(marker, /默认=KEEP_MINOR/);
  assert.doesNotMatch(marker, /默认=SIDE:/);

  // Empty sibling still blocks side_retention until settled/dropped.
  const blocked = resolveNextSideWalkStep({ points }, []);
  assert.equal(blocked.kind, 'expand');
  if (blocked.kind === 'expand') assert.equal(blocked.point.id, 'p2');

  // Accept 主流详 + 商业略 → stamp roles and drop empty「网络」so walk advances.
  const settled = settleSideRetentionAfterAccept({
    points,
    developed: '主流文化冲击',
    uncovered: '商业全球化与消费主义',
  });
  assert.equal(
    settled.points.find((p) => p.id === 'p1')?.retentionRole,
    'detail',
  );
  assert.equal(
    settled.points.find((p) => p.id === 'p3')?.retentionRole,
    'brief',
  );
  assert.equal(
    settled.points.find((p) => p.id === 'p2')?.retentionRole,
    'dropped',
  );
  assert.ok(settled.droppedClaims.some((c) => /网络/.test(c)));

  const after = resolveNextSideWalkStep({ points: settled.points }, []);
  assert.equal(after.kind, 'expand');
  if (after.kind === 'expand') {
    assert.equal(after.sideKey, 'part_2');
    assert.equal(after.point.id, 'p4');
  }

  // Also: student verbally drops a filled sibling by omitting it from the scheme.
  const withNet = points.map((p) =>
    p.id === 'p2'
      ? {
          ...p,
          quality: 'ready',
          elaboration: '数字网络高速传播让传统文化被淹没',
        }
      : p,
  );
  const sideAsk = resolveNextSideWalkStep({ points: withNet }, []);
  assert.equal(sideAsk.kind, 'side_retention');
  const dropFilled = settleSideRetentionAfterAccept({
    points: withNet,
    developed: '主流文化冲击',
    uncovered: '商业全球化与消费主义',
  });
  assert.equal(
    dropFilled.points.find((p) => p.id === 'p2')?.retentionRole,
    'dropped',
  );
  const nextSide = resolveNextSideWalkStep({ points: dropFilled.points }, []);
  assert.equal(nextSide.kind, 'expand');
  if (nextSide.kind === 'expand') assert.equal(nextSide.sideKey, 'part_2');
});

check('unified side confirm: parse coach ①②详/③略; no false ready; no premature stance', () => {
  const coach = `
目前关于「成因」的材料已经全部补齐。为了保证文章结构主次分明，我们需要为它们定一下详略：

① 主流文化冲击（影视潮流改变年轻人审美）
② 网络与技术普及（数字技术使跨国文化淹没传统文化）
③ 商业全球化（圣诞节等商家的消费主义包装）

我推荐详写①和②，而将③作为略写。你觉得这个方案合适吗？
`;
  assert.equal(coachMessageLooksLikeRetentionDecision(coach), true);
  const scheme = parseSideRetentionSchemeFromCoachText(coach);
  assert.ok(scheme);
  assert.match(scheme.developed, /主流文化冲击/);
  assert.match(scheme.developed, /网络与技术普及/);
  assert.match(scheme.uncovered, /商业全球化/);

  assert.equal(scorePointQuality('主流文化冲击（原因）', ''), 'thin');
  assert.equal(
    scorePointQuality('主流文化冲击（原因）', '主流文化冲击'),
    'thin',
  );
  assert.deepEqual(
    dropRedundantGeneral(['general', 'part_1']),
    ['part_1'],
  );
  const seeded = seedFixedSlotsFromDimensions([
    '主流文化冲击（原因）',
    '全球沟通（评价）',
  ]);
  assert.deepEqual(seeded[0].leanTags, ['part_1']);
  assert.deepEqual(seeded[1].leanTags, ['part_2']);
  assert.equal(seeded[0].quality, 'thin');

  const points = [
    pt({
      id: 'p1',
      claim: '主流文化冲击（原因）',
      leanTags: ['part_1'],
      quality: 'ready',
      elaboration: '影视潮流改变审美',
      retentionRole: 'detail',
    }),
    pt({
      id: 'p2',
      claim: '网络与技术普及（原因）',
      leanTags: ['part_1'],
      quality: 'ready',
      elaboration: '数字传播淹没传统',
      retentionRole: 'detail',
    }),
    pt({
      id: 'p3',
      claim: '商业全球化（原因）',
      leanTags: ['part_1'],
      quality: 'ready',
      elaboration: '圣诞节商家推广',
      retentionRole: 'brief',
    }),
    pt({
      id: 'p4',
      claim: '全球沟通（评价）',
      leanTags: ['part_2'],
      quality: 'thin',
    }),
  ];
  assert.equal(isStep2ChecklistWalkDone({ points }, []), false);
  assert.equal(resolveNextSideWalkStep({ points }, []).kind, 'expand');

  const data = {
    text:
      '好的，详略已锁定。\n\n---\n\n上面是基于你材料的立场推荐。请点击「采纳」锁定，或「拒绝」后告诉我你想改成哪种立场。',
    progressUpdate: {
      step2Data: {
        currentStage: 'stance',
        userPoints: '',
        plannerPayload: {
          points,
          pendingStanceConfirm: { text: '假立场' },
          pendingCapacityTrim: {
            sideKey: 'part_1',
            sideLabel: '第一问',
            pointIds: ['p1', 'p2', 'p3'],
            pointClaims: ['主流', '网络', '商业'],
          },
        },
      },
    },
  };
  enforceStep2AskContract(data, {}, {
    safeOverridePart1: (t) => String(t).split('---')[0].trim() || '好的。',
    buildContentAwareFallback: () =>
      '「全球沟通（评价）」目前还偏薄：请补 1–2 句具体场景。',
  });
  assert.equal(
    data.progressUpdate.step2Data.plannerPayload.pendingStanceConfirm,
    null,
  );
  assert.equal(
    data.progressUpdate.step2Data.plannerPayload.pendingCapacityTrim,
    null,
  );
  assert.doesNotMatch(data.text, /立场推荐/);
});

check('seedOnly Step1 sprouts → expand, not side_retention', () => {
  const payload = {
    slotsLocked: true,
    fixedClaims: [
      '强势文化冲击（原因）',
      '网络普及（原因）',
      '全球消费主义（原因）',
    ],
    points: [
      pt({
        id: 'p1',
        claim: '强势文化冲击（原因）',
        elaboration: '比如迪士尼，电影在不同国家发行',
        leanTags: ['part_1'],
        quality: 'ready',
        seedOnly: true,
      }),
      pt({
        id: 'p2',
        claim: '网络普及（原因）',
        elaboration: '通过facebook等平台传播',
        leanTags: ['part_1'],
        quality: 'ready',
        seedOnly: true,
      }),
      pt({
        id: 'p3',
        claim: '全球消费主义（原因）',
        elaboration: '圣诞节商家促销推广',
        leanTags: ['part_1'],
        quality: 'ready',
        seedOnly: true,
      }),
    ],
  };
  assert.equal(isPointExpandedForWalk(payload.points[0]), false);
  assert.ok(pointHasSubstantiveContent(payload.points[0]));
  const next = resolveNextSideWalkStep(payload, []);
  assert.equal(next.kind, 'expand');
  assert.equal(next.point.id, 'p1');
  const unwalked = listUnwalkedChecklistPoints(payload, []);
  assert.equal(unwalked.length, 3);
  assert.ok(unwalked.every((u) => u.reason === 'thin'));
  assert.equal(isStep2ChecklistWalkDone(payload, []), false);
});

check('seedContext mount marks seedOnly; student deepen clears it', () => {
  const slots = seedFixedSlotsFromDimensions([
    '强势文化冲击（原因）',
    '网络普及（原因）',
  ]);
  const seeded = upsertPointsFromClaims(
    slots,
    [
      {
        claim: '强势文化冲击（原因）',
        elaboration: '比如迪士尼，电影在不同国家发行',
      },
      {
        claim: '网络普及（原因）',
        elaboration: '通过facebook等平台传播',
      },
    ],
    { allowCreate: false, seedContext: true },
  );
  assert.equal(seeded.find((p) => p.id === 'p1')?.seedOnly, true);
  assert.equal(seeded.find((p) => p.id === 'p2')?.seedOnly, true);
  assert.equal(
    resolveNextSideWalkStep({ points: seeded, slotsLocked: true }, []).kind,
    'expand',
  );

  const afterStudent = attachTextToPointId(
    seeded,
    'p1',
    '年轻人把好莱坞当作潮流，冷落本土节日与语言',
    'replace',
  );
  assert.equal(afterStudent.find((p) => p.id === 'p1')?.seedOnly, false);
  assert.equal(afterStudent.find((p) => p.id === 'p2')?.seedOnly, true);
  assert.ok(isPointExpandedForWalk(afterStudent.find((p) => p.id === 'p1')));
  assert.equal(
    isPointExpandedForWalk(afterStudent.find((p) => p.id === 'p2')),
    false,
  );
});

check('model rewrite of userPoints must not wash seedOnly on untouched slots', () => {
  const points = [
    pt({
      id: 'p1',
      claim: '强势文化冲击（原因）',
      elaboration: '年轻人冷落本土节日与语言',
      leanTags: ['part_1'],
      quality: 'ready',
      seedOnly: false,
    }),
    pt({
      id: 'p2',
      claim: '网络普及（原因）',
      elaboration: '通过facebook等平台传播',
      leanTags: ['part_1'],
      quality: 'ready',
      seedOnly: true,
    }),
  ];
  // Kickoff-style remount of same seeds (seedContext) must not re-seed p1.
  const remountSeed = upsertPointsFromClaims(
    points,
    [
      {
        claim: '强势文化冲击（原因）',
        elaboration: '比如迪士尼，电影在不同国家发行',
      },
      {
        claim: '网络普及（原因）',
        elaboration: '通过facebook等平台传播更多',
      },
    ],
    { allowCreate: false, seedContext: true },
  );
  assert.equal(remountSeed.find((p) => p.id === 'p1')?.seedOnly, false);
  assert.equal(remountSeed.find((p) => p.id === 'p2')?.seedOnly, true);

  // Student-turn remount of near-dup seed text must not clear p2.
  const remountStudent = upsertPointsFromClaims(
    remountSeed,
    [
      {
        claim: '网络普及（原因）',
        elaboration: '通过facebook等平台传播更多',
      },
    ],
    { allowCreate: false, seedContext: false },
  );
  assert.equal(remountStudent.find((p) => p.id === 'p2')?.seedOnly, true);
});

check('A-side all student-expanded → side_retention', () => {
  const payload = {
    slotsLocked: true,
    fixedClaims: ['强势文化冲击（原因）', '网络普及（原因）'],
    points: [
      pt({
        id: 'p1',
        claim: '强势文化冲击（原因）',
        elaboration: '年轻人冷落本土节日与语言，视好莱坞为潮流',
        leanTags: ['part_1'],
        quality: 'ready',
        seedOnly: false,
      }),
      pt({
        id: 'p2',
        claim: '网络普及（原因）',
        elaboration: '社交媒体让西方文化触达面骤增，本土话语被淹没',
        leanTags: ['part_1'],
        quality: 'ready',
        seedOnly: false,
      }),
    ],
  };
  const next = resolveNextSideWalkStep(payload, []);
  assert.equal(next.kind, 'side_retention');
  assert.equal(next.sideKey, 'part_1');
});

check('arm-first: ask-contract arms side_settle before speaking 详略', () => {
  const payload = {
    slotsLocked: true,
    fixedClaims: ['强势文化冲击（原因）', '网络普及（原因）'],
    points: [
      pt({
        id: 'p1',
        claim: '强势文化冲击（原因）',
        elaboration: '年轻人冷落本土节日与语言，视好莱坞为潮流',
        leanTags: ['part_1'],
        quality: 'ready',
        seedOnly: false,
      }),
      pt({
        id: 'p2',
        claim: '网络普及（原因）',
        elaboration: '社交媒体让西方文化触达面骤增，本土话语被淹没',
        leanTags: ['part_1'],
        quality: 'ready',
        seedOnly: false,
      }),
    ],
    sideSettled: [],
    pendingProposal: null,
  };
  const data = {
    text: '很好，两条成因都已展开。\n\n---\n\n接下来我们看看评价部分。',
    progressUpdate: {
      step2Data: {
        currentStage: 'explore_A',
        userPoints: '',
        plannerPayload: payload,
      },
    },
  };
  enforceStep2AskContract(data, {}, {
    safeOverridePart1: (t) => String(t).split('---')[0].trim() || '好的。',
    buildContentAwareFallback: () => '请继续。',
  });
  const armed = data.progressUpdate.step2Data.plannerPayload.pendingProposal;
  assert.ok(armed?.proposalId, 'pendingProposal must be armed with the ask');
  assert.equal(armed.kind, 'side_settle');
  assert.match(data.text, /详写|采纳/);
});

check('arm-first: channel refuses (walked-but-seedOnly slot) → expand ask, no 详略 prose', () => {
  const payload = {
    slotsLocked: true,
    fixedClaims: ['强势文化冲击（原因）', '网络普及（原因）'],
    points: [
      pt({
        id: 'p1',
        claim: '强势文化冲击（原因）',
        elaboration: '年轻人冷落本土节日与语言，视好莱坞为潮流',
        leanTags: ['part_1'],
        quality: 'ready',
        seedOnly: false,
      }),
      pt({
        id: 'p2',
        claim: '网络普及（原因）',
        elaboration: '比如facebook之类的社交媒体传播西方文化',
        leanTags: ['part_1'],
        quality: 'ready',
        // Role stamped by legacy tag sync but still a Step1 seed →
        // walk gate says side_retention, sideReadyForSettle says not ready.
        seedOnly: true,
        retentionRole: 'brief',
      }),
    ],
    sideSettled: [],
    pendingProposal: null,
  };
  // Precondition of the split-brain shape this guards against:
  const walkNext = resolveNextSideWalkStep(payload, []);
  assert.equal(walkNext.kind, 'side_retention');

  const data = {
    text: '很好。\n\n---\n\n接下来我们定详略。',
    progressUpdate: {
      step2Data: {
        currentStage: 'explore_A',
        userPoints: '',
        plannerPayload: payload,
      },
    },
  };
  enforceStep2AskContract(data, {}, {
    safeOverridePart1: (t) => String(t).split('---')[0].trim() || '好的。',
    buildContentAwareFallback: () => '「网络普及」目前还偏薄：请补 1–2 句。',
  });
  const pending = data.progressUpdate.step2Data.plannerPayload.pendingProposal;
  assert.equal(pending, null, 'channel refused → nothing may be armed');
  // No button-less decision prose; falls back to expanding the seed slot.
  assert.doesNotMatch(data.text, /请点击下方「采纳」/);
  assert.doesNotMatch(data.text, /材料都已展开/);
  assert.match(data.text, /网络普及/);
});

// --- Live incident: A-side accept must not swallow the B side ---

const incidentPoints = () => [
  pt({
    id: 'p1',
    claim: '强势文化冲击（原因）',
    elaboration: '外来影视作品流行，使人们认为外来文化更新潮高级，从而冷落本土传统文化',
    leanTags: ['part_1'],
    quality: 'ready',
    seedOnly: false,
    retentionRole: 'brief',
  }),
  pt({
    id: 'p2',
    claim: '网络普及（原因）',
    elaboration: '信息的传播速度更快，规模更大，传统文化很容易被跨国文化淹没',
    leanTags: ['part_1'],
    quality: 'ready',
    seedOnly: false,
    retentionRole: 'brief',
  }),
  pt({
    id: 'p3',
    claim: '全球消费主义（原因）',
    elaboration: '圣诞节促销和礼物互动等商业活动盛行，引导人们生活习惯西化',
    leanTags: ['part_1'],
    quality: 'ready',
    seedOnly: false,
    retentionRole: 'detail',
  }),
  pt({ id: 'p4', claim: '国际交流（评价）', leanTags: ['part_2'], quality: 'thin' }),
  pt({ id: 'p5', claim: '文化多样性（评价）', leanTags: ['part_2'], quality: 'thin' }),
  pt({ id: 'p6', claim: '商业发展（评价）', leanTags: ['part_2'], quality: 'thin' }),
];
const incidentPrev = (points) => ({
  slotsLocked: true,
  fixedClaims: [
    '强势文化冲击（原因）',
    '网络普及（原因）',
    '全球消费主义（原因）',
    '国际交流（评价）',
    '文化多样性（评价）',
    '商业发展（评价）',
  ],
  points,
  redirects: {},
  dimensionDispositions: [],
  sideSettled: ['part_1'],
  pendingProposal: null,
});
// Model rewrote userPoints to A面-only, with retention tags on A claims.
const incidentUserPoints =
  'A面：\n1. 全球消费主义：圣诞促销等商业活动盛行（已选详写）\n2. 强势文化冲击：外来影视作品流行（已选略写）\n3. 网络普及：信息传播更快更广（已选略写）';

check('role infection: A面-only userPoints rewrite leaves unmentioned B slots untagged', () => {
  // Unit level: a corpus that never mentions the claim yields no role.
  assert.equal(
    inferRetentionRoleFromText('国际交流（评价）', incidentUserPoints),
    undefined,
  );
  assert.equal(
    inferRetentionRoleFromText('文化多样性（评价）', incidentUserPoints),
    undefined,
  );
  // Mentioned claims still resolve.
  assert.equal(
    inferRetentionRoleFromText('全球消费主义（原因）', incidentUserPoints),
    'detail',
  );

  // End to end: normalize after the A-side accept turn.
  const out = normalizeStep2PlannerPayload({
    session: {
      step1: {
        coachEvaluation: {
          suggestedDimensions: incidentPrev(incidentPoints()).fixedClaims.map(
            (c) => `${c}（已探测）（可展开）`,
          ),
        },
      },
    },
    step2Data: {
      currentStage: 'explore_B',
      userPoints: incidentUserPoints,
      plannerPayload: incidentPrev(incidentPoints()),
    },
    userMessage: '采纳',
    coachText: '',
  });
  const payload = out?.payload || out;
  const bSlots = (payload.points || []).filter(
    (p) => !p.supersededBy && /评价/.test(p.claim),
  );
  assert.equal(bSlots.length, 3, 'B slots must survive');
  for (const p of bSlots) {
    assert.equal(p.retentionRole, undefined, `${p.claim} must not inherit a role`);
  }
  const unwalked = listUnwalkedChecklistPoints(payload, []);
  assert.equal(unwalked.length, 3);
  assert.equal(isStep2ChecklistWalkDone(payload, []), false);
});

check('step1 dims washed to A-only: fixedClaims union keeps all frozen slots', () => {
  const out = normalizeStep2PlannerPayload({
    session: {
      step1: {
        coachEvaluation: {
          // Model rewrote suggestedDimensions down to the 3 A-side dims.
          suggestedDimensions: [
            '强势文化冲击（原因）（已探测）（可展开）',
            '网络普及（原因）（已探测）（可展开）',
            '全球消费主义（原因）（已探测）（可展开）',
          ],
        },
      },
    },
    step2Data: {
      currentStage: 'explore_B',
      userPoints: incidentUserPoints,
      plannerPayload: incidentPrev(incidentPoints()),
    },
    userMessage: '采纳',
    coachText: '',
  });
  const payload = out?.payload || out;
  assert.equal(payload.fixedClaims.length, 6, 'union must retain all 6 frozen claims');
  const active = (payload.points || []).filter((p) => !p.supersededBy);
  assert.equal(active.filter((p) => /评价/.test(p.claim)).length, 3);
  assert.equal(isStep2ChecklistWalkDone(payload, []), false);
});

// --- Stance lock: only via confirmed channel, never model prefill ---

const stanceIncidentPrev = () => ({
  slotsLocked: true,
  requiresStance: true,
  fixedClaims: [
    '强势文化冲击（原因）',
    '国际交流（评价）',
    '文化多样性（评价）',
  ],
  points: [
    pt({
      id: 'p1',
      claim: '强势文化冲击（原因）',
      elaboration: '外来影视流行使本土文化被视为过时，年轻人转向外来文化',
      leanTags: ['part_1'],
      quality: 'ready',
      retentionRole: 'detail',
      seedOnly: false,
    }),
    pt({
      id: 'p2',
      claim: '国际交流（评价）',
      elaboration: '共同语言消除沟通壁垒，跨国协作与商业效率提升',
      leanTags: ['part_2'],
      quality: 'ready',
      retentionRole: 'brief',
      seedOnly: false,
    }),
    pt({
      id: 'p3',
      claim: '文化多样性（评价）',
      elaboration: '习惯趋同令年轻一代失去民族身份与文化根基的认同感',
      leanTags: ['part_2'],
      quality: 'ready',
      retentionRole: 'detail',
      seedOnly: false,
    }),
  ],
  redirects: {},
  dimensionDispositions: [],
  sideSettled: ['part_1', 'part_2'],
  pendingProposal: null,
});

check('model-prefilled userStance while unresolved → parked, never locked', () => {
  const prefill =
    '虽然全球文化统一便利了经济与日常交流，但文化多样性缺失长远看危害更深，属于消极发展。';
  const out = normalizeStep2PlannerPayload({
    session: {
      step2: { coachEvaluation: { plannerPayload: stanceIncidentPrev() } },
    },
    step2Data: {
      currentStage: 'stance',
      userStance: prefill,
      userPoints: '',
      plannerPayload: stanceIncidentPrev(),
    },
    questionType: 'Two-part Question',
    requiresStance: true,
    userMessage: '详写2，略写1和3',
    coachText: '',
  });
  const payload = out?.payload || out;
  assert.equal(String(payload.stance?.text || ''), '', 'stance must not lock');
  assert.equal(Boolean(payload.stanceConfirmResolved), false);
  assert.equal(
    String(payload.pendingStanceConfirm?.text || ''),
    prefill,
    'prefill parked as pendingStanceConfirm for 采纳',
  );
});

check('stance accept decision still locks; student custom text still locks', () => {
  const text = '虽然带来便利，但整体是消极发展。';
  const accepted = normalizeStep2PlannerPayload({
    session: {
      step2: {
        coachEvaluation: {
          plannerPayload: {
            ...stanceIncidentPrev(),
            pendingStanceConfirm: { text },
          },
        },
      },
    },
    step2Data: {
      currentStage: 'stance',
      userStance: '',
      userPoints: '',
      plannerPayload: {
        ...stanceIncidentPrev(),
        pendingStanceConfirm: { text },
      },
    },
    questionType: 'Two-part Question',
    requiresStance: true,
    userMessage: '采纳',
    coachText: '',
    decision: { type: 'stance', action: 'accept' },
  });
  const p1 = accepted?.payload || accepted;
  assert.equal(String(p1.stance?.text || ''), text);
  assert.equal(Boolean(p1.stanceConfirmResolved), true);

  const custom = normalizeStep2PlannerPayload({
    session: {
      step2: {
        coachEvaluation: {
          plannerPayload: {
            ...stanceIncidentPrev(),
            stanceAwaitingCustom: true,
          },
        },
      },
    },
    step2Data: {
      currentStage: 'stance',
      userStance: '',
      userPoints: '',
      plannerPayload: { ...stanceIncidentPrev(), stanceAwaitingCustom: true },
    },
    questionType: 'Two-part Question',
    requiresStance: true,
    userMessage: '我认为整体上是消极的发展，虽然有一定的商业便利。',
    coachText: '',
  });
  const p2 = custom?.payload || custom;
  assert.match(String(p2.stance?.text || ''), /消极的发展/);
  assert.equal(Boolean(p2.stanceConfirmResolved), true);
});

console.log(`\n${checks} checks passed.`);
