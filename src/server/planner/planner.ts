/**
 * Step 2.5 Planner — 材料驱动的结构推理
 *
 * 职责：
 * 1. 盘点 Step 2 plannerPayload.points（兼容旧 A面/B面 文本）
 * 2. 按题型选择最优论证策略
 * 3. 分配材料到 Body → 生成 ParagraphPlan
 *
 * 入口：buildPlannerRequest() + parsePlannerResponse() + runMechanicalQa()
 */

import type {
  PlannerInput,
  PlannerOutput,
  MechanicalQaResult,
  BodyPlan,
  Step2PlannerPayload,
} from '../../types';
import { buildPlannerPrompt } from '../prompts/planner-prompts';
import {
  demoteThemeHeadSubClaims,
  prefillClaimSlotsFromSubClaims,
} from '../../utils/step3ClaimPrefill';
import { toSkeleton } from '../../utils/step3Skeleton';
import { buildFallbackBodyPlans } from './planner-fallback';
import { parseAIResponse } from './planner-utils';
import {
  activePoints,
  appendMissingPointBlocks,
  applyRetentionRolesFromUserPoints,
  buildPlannerMaterialDigest,
  expandPackedDetailBodies,
  hydrateBodyPlansFromPayload,
  mergeBriefOnlyBodies,
  normalizeStep2PlannerPayload,
  resolvePointId,
} from '../step2/planner-payload';
import { isClaimSentence } from '../../utils/step3ClaimPrefill';

export {
  buildPendingDraftsFromFullSubClaims,
  demoteThemeHeadSubClaims,
  prefillClaimSlotsFromSubClaims,
} from '../../utils/step3ClaimPrefill';

/**
 * 构建 Planner 的 LLM 请求参数
 * 返回 Gemini generateContent 所需的 contents 和 config
 */
export function buildPlannerRequest(input: PlannerInput) {
  const prompt = buildPlannerPrompt(input);
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      temperature: 0.3,
      // 2–3 个 Body 的完整 paragraphPlan（中文 label/placeholder/subClaim +
      // rationale + plannerIntermediate）较大；Gemini 输出上限为 64K，
      // 取 32K 彻底消除截断风险（多余预算无副作用，模型生成完即停）。
      maxOutputTokens: 32768,
      responseMimeType: 'application/json',
    },
  };
}

/**
 * 从 Session 收集 Planner 输入（points-first，旧 A/B 文本兼容）。
 */
export function collectPlannerInput(session: any, question: string, questionType: string): PlannerInput {
  const eval2 = session?.step2?.coachEvaluation || {};
  const eval1 = session?.step1?.coachEvaluation || {};
  const qType = questionType || eval1?.correctType || 'Agree / Disagree';
  const requiresStance =
    eval2?.requiresStance ?? eval1?.requiresStance ?? true;

  let plannerPayload: Step2PlannerPayload | null =
    eval2?.plannerPayload || session?.step2?.plannerPayload || null;

  if (!plannerPayload || !Array.isArray(plannerPayload.points) || !plannerPayload.points.length) {
    plannerPayload = normalizeStep2PlannerPayload({
      session,
      questionType: qType,
      requiresStance: Boolean(requiresStance),
    });
  }

  const userPoints = String(eval2.userPoints || session?.step2?.userPoints || '');
  // Coach often tags （详写）/（略写） in chat before userPoints is updated
  const chatTail = Array.isArray(session?.step2?.chatHistory)
    ? session.step2.chatHistory
        .slice(-8)
        .map((m: any) => String(m?.text || m?.content || ''))
        .join('\n')
    : '';
  const roleCorpus = [userPoints, chatTail].filter(Boolean).join('\n');

  // Re-stamp retentionRole so Planner sees 详写/略写 even if payload was stale
  if (plannerPayload?.points?.length && roleCorpus.trim()) {
    const stamped = applyRetentionRolesFromUserPoints(
      plannerPayload.points,
      roleCorpus,
    );
    plannerPayload = { ...plannerPayload, points: stamped };
  }

  const points = activePoints(plannerPayload);
  const aMatch = userPoints.match(/A面[^：:]*[：:]([\s\S]*?)(?=B面[^：:]*[：:]|$)/);
  const bMatch = userPoints.match(/B面[^：:]*[：:]([\s\S]*)$/);

  // Derive legacy aSide/bSide from tagged points when text protocol missing
  const tagJoin = (tags: string[]) =>
    points
      .filter((p) => (p.leanTags || []).some((t) => tags.includes(t)))
      .map((p) => p.claim)
      .join('；');

  const aSide =
    String(aMatch?.[1] || '').trim() ||
    tagJoin(['view_a', 'advantage', 'cause', 'part_1', 'support_main', 'positive']) ||
    eval2?.clustering?.clusters?.[0]?.content ||
    '';
  const bSide =
    String(bMatch?.[1] || '').trim() ||
    tagJoin(['view_b', 'disadvantage', 'solution', 'part_2', 'oppose_or_qualify', 'negative']) ||
    eval2?.clustering?.clusters?.[1]?.content ||
    '';

  const materialDigest = buildPlannerMaterialDigest(plannerPayload);

  return {
    question,
    questionType: qType,
    requiresStance: Boolean(requiresStance),
    plannerPayload,
    materials: {
      points,
      layoutPreference: plannerPayload?.layoutPreference,
      stance: String(
        plannerPayload.stance?.text ||
          eval2.blueprint?.position ||
          eval2.suggestedStance ||
          eval2.userStance ||
          session?.step2?.userStance ||
          '',
      ).trim(),
      stanceMeta: {
        polarity: plannerPayload.stance?.polarity,
        strength: plannerPayload.stance?.strength,
      },
      coverage: plannerPayload.coverage,
      materialDigest,
      aSide,
      bSide,
      clusters: eval2?.clustering?.clusters || [],
      userRawText: userPoints,
    },
  };
}

/**
 * 解析 Planner 的 LLM 响应。
 * 依次尝试：直接 JSON.parse → jsonrepair（截断/尾逗号/缺引号）→
 * 提取最外层 {...} 块后再 parse/repair（容忍前后多余文本）。
 */
export function parsePlannerResponse(rawText: string): PlannerOutput | null {
  const valid = (obj: any): obj is PlannerOutput =>
    !!obj &&
    Array.isArray(obj.bodyPlans) &&
    obj.bodyPlans.length >= 2 &&
    obj.bodyPlans.length <= 3;

  const tryParse = (text: string): PlannerOutput | null => {
    try {
      const parsed = JSON.parse(text);
      return valid(parsed) ? parsed : null;
    } catch {
      const repaired = parseAIResponse(text);
      return valid(repaired) ? repaired : null;
    }
  };

  const direct = tryParse(rawText);
  if (direct) return direct;

  // 容忍模型在 JSON 前后附加了说明文字：提取最外层 {...} 子串再尝试。
  const firstBrace = rawText.indexOf('{');
  const lastBrace = rawText.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const inner = rawText.slice(firstBrace, lastBrace + 1);
    const extracted = tryParse(inner);
    if (extracted) return extracted;
  }

  return null;
}

/**
 * Soft warn helper — brief-only body when bodyCount=3 (normalize will merge).
 * Exported for tests; wired into runMechanicalQa as warn-only.
 */
export function detectBriefOnlyBodyWarns(
  bodyPlans: BodyPlan[],
  plannerPayload?: Step2PlannerPayload | null,
): MechanicalQaResult['issues'] {
  if (!plannerPayload || bodyPlans.length < 3) return [];
  const byId = new Map(
    activePoints(plannerPayload).map((p) => [p.id, p] as const),
  );
  const issues: MechanicalQaResult['issues'] = [];
  for (const bp of bodyPlans) {
    const ids = Array.isArray(bp.mappedPointIds) ? bp.mappedPointIds : [];
    if (!ids.length) continue;
    const pts = ids.map((id) => byId.get(String(id))).filter(Boolean);
    if (pts.length && pts.every((p) => p!.retentionRole === 'brief')) {
      issues.push({
        severity: 'warn',
        field: `bodyPlans.${bp.id}.mappedPointIds`,
        reason: `Body 仅映射略写点（${ids.join(',')}）；normalize 将尝试并入详写段`,
      });
    }
  }
  return issues;
}

/**
 * Coverage guard: every active non-dropped Step2 point must be mapped into
 * some body. A missing detail point fails QA (retry / fallback); a missing
 * brief point only warns — normalize auto-appends it as a minor block.
 */
export function detectPointCoverageIssues(
  bodyPlans: BodyPlan[],
  plannerPayload?: Step2PlannerPayload | null,
): MechanicalQaResult['issues'] {
  if (!plannerPayload) return [];
  const redirects = plannerPayload.redirects || {};
  const mapped = new Set<string>();
  for (const bp of bodyPlans) {
    const ids = Array.isArray(bp?.mappedPointIds) ? bp.mappedPointIds : [];
    for (const id of ids) {
      mapped.add(resolvePointId(String(id), redirects));
    }
  }
  const issues: MechanicalQaResult['issues'] = [];
  for (const p of activePoints(plannerPayload)) {
    if (p.retentionRole === 'dropped') continue;
    if (mapped.has(String(p.id))) continue;
    const isDetail = p.retentionRole === 'detail';
    issues.push({
      severity: isDetail ? 'fail' : 'warn',
      field: 'bodyPlans.mappedPointIds',
      reason: isDetail
        ? `详写点 ${p.id}（${p.claim}）未映射到任何 Body`
        : `略写点 ${p.id}（${p.claim}）未映射到任何 Body；normalize 将自动补入`,
    });
  }
  return issues;
}

/**
 * 机械 QA — 纯函数，不调 LLM
 */
export function runMechanicalQa(
  bodyPlans: BodyPlan[],
  plannerPayload?: Step2PlannerPayload | null,
): MechanicalQaResult {
  const issues: MechanicalQaResult['issues'] = [];

  // 1. bodyPlans 数量必须在 2-3
  if (![2, 3].includes(bodyPlans.length)) {
    issues.push({
      severity: 'fail',
      field: 'bodyPlans.length',
      reason: `必须为 2 或 3，当前 ${bodyPlans.length}`,
    });
  }

  // Soft: brief-only body at bodyCount=3 (does not fail; normalize merges)
  issues.push(...detectBriefOnlyBodyWarns(bodyPlans, plannerPayload));

  // Coverage: unmapped detail point → fail; unmapped brief → warn (auto-fixed)
  issues.push(...detectPointCoverageIssues(bodyPlans, plannerPayload));

  // 2. 每个 plan 的 step value 全空 + key 唯一
  const allKeys = new Set<string>();
  for (const bp of bodyPlans) {
    const plan = bp?.paragraphPlan;
    if (!plan || !Array.isArray(plan.pointBlocks)) {
      issues.push({
        severity: 'fail',
        field: `bodyPlans.${bp?.id || '?'}.paragraphPlan`,
        reason: 'paragraphPlan 或 pointBlocks 缺失',
      });
      continue;
    }

    for (const block of plan.pointBlocks) {
      if (!Array.isArray(block?.steps)) continue;
      for (const step of block.steps) {
        if (String(step?.value || '').trim()) {
          issues.push({
            severity: 'fail',
            field: `bodyPlans.${bp.id}.${block.id}.${step?.key || '?'}.value`,
            reason: 'Planner 输出的 value 必须为空字符串',
          });
        }
        const key = String(step?.key || '');
        if (key && allKeys.has(key)) {
          issues.push({
            severity: 'fail',
            field: `step.key`,
            reason: `重复的 key: ${key}`,
          });
        }
        if (key) allKeys.add(key);
      }
    }

    // 3. mode 合法性
    const validModes = ['single_point', 'total_then_points', 'direct_points'];
    if (!validModes.includes(plan.mode)) {
      issues.push({
        severity: 'fail',
        field: `bodyPlans.${bp.id}.mode`,
        reason: `非法 mode: ${plan.mode}`,
      });
    }
  }

  return {
    pass: issues.filter((i) => i.severity === 'fail').length === 0,
    issues,
  };
}

/**
 * 处理 Planner 的 LLM 输出（纯函数）
 * 返回解析 + 校验结果
 */
export function processPlannerOutput(rawText: string): {
  success: boolean;
  output?: PlannerOutput;
  qaResult: MechanicalQaResult;
} {
  const parsed = parsePlannerResponse(rawText);
  if (!parsed || !Array.isArray(parsed.bodyPlans)) {
    return {
      success: false,
      qaResult: {
        pass: false,
        issues: [
          { severity: 'fail', field: 'response', reason: '无法解析 Planner 响应为有效 JSON' },
        ],
      },
    };
  }

  const qaResult = runMechanicalQa(parsed.bodyPlans);

  return {
    success: qaResult.pass,
    output: qaResult.pass ? parsed : undefined,
    qaResult,
  };
}

/**
 * 规范化 Planner 产出的 bodyPlans（LLM 或 fallback 共用）：
 *
 * 1. 把 pointBlock.subClaim（Step 2 已确认的完整主张句）预填/确认为该块第一个
 *    空「分论点」槽 → 修复 Step 3 重复问「分论点是什么」。
 *    仅当 subClaim 是完整句（≥ 8 字）且首槽为空、首槽 label 属于主张类时生效。
 * 2. 其余槽位保持空（等待 affirm 写入），符合「value 空直到 server commit」契约。
 */
export function normalizePlannerBodyPlans(
  bodyPlans: BodyPlan[],
  plannerPayload?: Step2PlannerPayload | null,
): BodyPlan[] {
  // Soft fix: 3 bodies where one is brief-only → merge into nearest detail body
  const merged = mergeBriefOnlyBodies(bodyPlans, plannerPayload || null);
  // Respect Step2 detail locks: don't leave detail points as minor / packed dual_point
  const expanded = expandPackedDetailBodies(merged, plannerPayload || null);
  const hydrated = hydrateBodyPlansFromPayload(expanded, plannerPayload || null);
  // Coverage safety net: points the planner forgot get a synthesized block
  appendMissingPointBlocks(hydrated, plannerPayload || null);
  for (const bp of hydrated) {
    // Theme heads (环境保护) must not sit in subClaim as fake 论点句.
    // Full claim sentences stay in subClaim as planning hints only —
    // Step3 stages them as pending for confirm (no silent board write).
    demoteThemeHeadSubClaims(bp?.paragraphPlan, bp);
    prefillClaimSlotsFromSubClaims(bp?.paragraphPlan); // no-op by design

    // Body theme must reflect the blocks actually in this body — never a
    // model-written leftover naming a point that lives elsewhere (or nowhere).
    const blocks = Array.isArray(bp?.paragraphPlan?.pointBlocks)
      ? bp.paragraphPlan.pointBlocks
      : [];
    const majorLabel = String(
      (blocks.find((b: any) => String(b?.role || '') === 'major') || blocks[0])
        ?.label || '',
    ).trim();
    const isGenericLabel =
      /^(?:分论点|分点|略写补充|补充点)\s*\d*$/.test(majorLabel);
    if (majorLabel && !isGenericLabel && !isClaimSentence(majorLabel)) {
      bp.theme = majorLabel;
    }

    // 冻结骨架：Planner 产出即生成并附加到 bodyPlan，之后任何环节不得修改。
    // 这样 Step3 的 ensureStep3SkeletonForSubpoints 可直接复用 bp.skeleton，
    // 骨架在 Planner 阶段就冻结（消灭结构漂移的根源）。
    bp.skeleton = toSkeleton(bp);
  }
  return hydrated;
}

export { buildFallbackBodyPlans };
