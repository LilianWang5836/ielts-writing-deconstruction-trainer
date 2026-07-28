/**
 * Planner 降级策略 — 保守默认结构
 *
 * 当 Planner LLM 调用失败或 QA 连续失败时使用
 * 不调 LLM，纯代码返回通用结构
 */

import type { BodyPlan } from '../../types';

/**
 * 根据题型返回保守默认 bodyPlans
 * 所有 body 使用 single_point + mechanism→example→impact 结构
 */
export function buildFallbackBodyPlans(_questionType: string): BodyPlan[] {
  // 后续 PR-B 填充实现
  return [];
}
