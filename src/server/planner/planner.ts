/**
 * Step 2.5 Planner — 材料驱动的结构推理
 *
 * 职责：
 * 1. 盘点 Step 2 原材料（A面/B面 强弱）
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
} from '../../types';
import { buildPlannerPrompt } from '../prompts/planner-prompts';
import { prefillClaimSlotsFromSubClaims } from '../../utils/step3ClaimPrefill';
import { buildFallbackBodyPlans } from './planner-fallback';
import { parseAIResponse } from './planner-utils';

export { prefillClaimSlotsFromSubClaims } from '../../utils/step3ClaimPrefill';

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
 * 从 PlannerInput 收集材料
 */
export function collectPlannerInput(session: any, question: string, questionType: string): PlannerInput {
  const eval2 = session?.step2?.coachEvaluation || {};
  const eval1 = session?.step1?.coachEvaluation || {};

  // 尝试从 Step 2 提取A面/B面
  const userPoints = String(eval2.userPoints || session?.step2?.userPoints || '');
  const aMatch = userPoints.match(/A面[^：:]*[：:]([\s\S]*?)(?=B面[^：:]*[：:]|$)/);
  const bMatch = userPoints.match(/B面[^：:]*[：:]([\s\S]*)$/);

  return {
    question,
    questionType: questionType || 'Agree / Disagree',
    requiresStance: eval1?.requiresStance ?? true,
    materials: {
      aSide: String(aMatch?.[1] || '').trim() || eval2?.clustering?.clusters?.[0]?.content || '',
      bSide: String(bMatch?.[1] || '').trim() || eval2?.clustering?.clusters?.[1]?.content || '',
      stance: String(eval2.blueprint?.position || eval2.suggestedStance || eval2.userStance || session?.step2?.userStance || '').trim(),
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
 * 机械 QA — 纯函数，不调 LLM
 */
export function runMechanicalQa(bodyPlans: BodyPlan[]): MechanicalQaResult {
  const issues: MechanicalQaResult['issues'] = [];

  // 1. bodyPlans 数量必须在 2-3
  if (![2, 3].includes(bodyPlans.length)) {
    issues.push({
      severity: 'fail',
      field: 'bodyPlans.length',
      reason: `必须为 2 或 3，当前 ${bodyPlans.length}`,
    });
  }

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
export function normalizePlannerBodyPlans(bodyPlans: BodyPlan[]): BodyPlan[] {
  for (const bp of bodyPlans) {
    prefillClaimSlotsFromSubClaims(bp?.paragraphPlan);
  }
  return bodyPlans;
}

export { buildFallbackBodyPlans };
