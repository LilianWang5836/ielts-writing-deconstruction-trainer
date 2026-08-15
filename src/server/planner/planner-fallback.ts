/**
 * Planner 降级策略 — 数据感知的保守默认结构
 *
 * 当 Planner LLM 调用失败或 QA 连续失败时使用
 * 不调 LLM，纯代码返回通用结构
 *
 * 优先使用 Step2 plannerPayload.points；材料不足时显式 degraded，
 * 禁止写入「（论点一）」占位 claim。
 * bodyCount 按 retentionRole / ready 动态取 2 或 3；略写并入末段。
 */

import type {
  BodyPlan,
  ParagraphPointBlock,
  PlannerInput,
  Step2Point,
} from '../../types';
import {
  leftoverBriefPoints,
  pickReadyPointsForFallback,
} from '../step2/planner-payload';

function claimOk(claim: string): boolean {
  const c = String(claim || '').trim();
  if (!c) return false;
  const minLen = /[\u4e00-\u9fff]/.test(c) ? 2 : 8;
  return c.length >= minLen;
}

function makeBody(
  index: number,
  point: Step2Point | null,
  degradedNote: string,
  extraBriefs: Step2Point[] = [],
): BodyPlan {
  const claim = point && claimOk(point.claim) ? point.claim.trim() : '';
  const hasClaim = Boolean(claim);
  const id = `body-${index}`;
  const pb = `pb${index}`;
  const expansion: 'mechanism' | 'example' | 'impact' =
    index === 1 ? 'mechanism' : index === 2 ? 'example' : 'impact';

  const briefClaims = extraBriefs
    .map((p) => p.claim.trim())
    .filter((c) => claimOk(c));
  const mappedIds = [
    ...(point ? [point.id] : []),
    ...extraBriefs.map((p) => p.id),
  ];
  const mappedPoints = [
    ...(hasClaim ? [claim] : []),
    ...briefClaims,
  ];

  const majorBlock: ParagraphPointBlock = {
    id: pb,
    label: `分论点 ${index}`,
    subClaim: claim,
    role: 'major',
    expansionStrategy: expansion,
    // P2a：稳定身份——绑定到 primary point id（label 变化后仍可按 id 对齐）
    mappedPointId: point?.id || '',
    steps:
      index === 1
        ? [
            {
              key: `${pb}_s1`,
              label: '分论点',
              placeholder: hasClaim
                ? '确认或微调本段核心主张'
                : '回到 Step2 补充一条完整主张句',
              value: '',
            },
            {
              key: `${pb}_s2`,
              label: '展开原因',
              placeholder: '解释这个主张为什么成立',
              value: '',
            },
            {
              key: `${pb}_s3`,
              label: '具体机制',
              placeholder: '这个原因是通过什么链条起作用的',
              value: '',
            },
            {
              key: `${pb}_s4`,
              label: '典型场景',
              placeholder: '举一个具体场景或例子',
              value: '',
            },
          ]
        : [
            {
              key: `${pb}_s1`,
              label: '分论点',
              placeholder: hasClaim
                ? '确认或微调本段核心主张'
                : `回到 Step2 补充第 ${index} 条完整主张句`,
              value: '',
            },
            {
              key: `${pb}_s2`,
              label: '具体实例',
              placeholder: '举一个具体日常场景',
              value: '',
            },
            {
              key: `${pb}_s3`,
              label: '危害后果',
              placeholder: '说明如果不处理会带来什么后果',
              value: '',
            },
            {
              key: `${pb}_s4`,
              label: '干预必要性',
              placeholder: '总结为什么需要针对性回应',
              value: '',
            },
          ],
  };

  const supportingBlocks: ParagraphPointBlock[] = briefClaims.map((bc, i) => {
    const bid = `${pb}_brief${i + 1}`;
    return {
      id: bid,
      label: `略写补充 ${i + 1}`,
      subClaim: bc,
      role: 'minor',
      expansionStrategy: 'explanation',
      // P2a：绑定到对应 brief point id（稳定身份）
      mappedPointId: extraBriefs[i]?.id || '',
      steps: [
        {
          key: `${bid}_s1`,
          label: '补充点',
          placeholder: '用一两句带过此略写点',
          value: '',
        },
      ],
    };
  });

  const hasBrief = supportingBlocks.length > 0;
  const briefNote = hasBrief
    ? `；略写点 ${extraBriefs.map((p) => p.id).join(',')} 已并入本段`
    : '';

  return {
    id,
    targetBody: `Body Paragraph ${index}`,
    role: 'main_argument',
    theme: hasClaim ? claim.slice(0, 24) : `分论点 ${index}`,
    paragraphDensity: hasBrief ? 'dual_point' : 'single_point',
    argumentRelation: 'supports',
    mappedPointIds: mappedIds,
    mappedPoints,
    paragraphPlan: {
      mode: hasBrief ? 'direct_points' : 'single_point',
      diagnosis: hasClaim
        ? `[fallback] ${degradedNote}；Body${index} 使用 Step2 point ${point!.id}${briefNote}`
        : `[fallback] 材料不足 — ${degradedNote}；Body${index} 无可用主张，需回到 Step2 补点`,
      pointBlocks: [majorBlock, ...supportingBlocks],
    },
  };
}

/**
 * 根据材料动态返回 2 或 3 个 bodyPlans；略写并入最后一段。
 */
export function buildFallbackBodyPlans(
  _questionType: string,
  input?: PlannerInput,
): BodyPlan[] {
  const payload = input?.plannerPayload || null;
  const picked = pickReadyPointsForFallback(payload);
  const points: Array<Step2Point | null> = [...picked];

  // Legacy fallback if payload empty but aSide/bSide text exists
  if (!points[0]) {
    const a = String(input?.materials?.aSide || '').trim();
    if (claimOk(a)) {
      points[0] = {
        id: 'legacy-a',
        claim: a.slice(0, 120),
        leanTags: ['general'],
        quality: 'ready',
        retentionRole: 'detail',
      };
    }
  }
  if (!points[1]) {
    const b = String(input?.materials?.bSide || '').trim();
    if (claimOk(b)) {
      points[1] = {
        id: 'legacy-b',
        claim: b.slice(0, 120),
        leanTags: ['general'],
        quality: 'ready',
        retentionRole: 'detail',
      };
    }
  }

  // Ensure at least 2 body slots (may be empty claims → degraded skeleton)
  while (points.length < 2) points.push(null);
  // Cap at 3
  const primary = points.slice(0, 3);

  const usedIds = new Set(
    primary.filter(Boolean).map((p) => (p as Step2Point).id),
  );
  const briefs = leftoverBriefPoints(payload, usedIds);

  const note = payload
    ? 'Planner LLM 未成功，使用 payload points'
    : 'Planner LLM 未成功，使用兼容材料';

  const bodies: BodyPlan[] = primary.map((p, i) => {
    const isLast = i === primary.length - 1;
    return makeBody(i + 1, p, note, isLast ? briefs : []);
  });

  return bodies;
}
