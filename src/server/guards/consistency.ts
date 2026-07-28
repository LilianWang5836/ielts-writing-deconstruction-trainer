/**
 * 一致性断言 — 轻量校验，不修改数据
 *
 * 职责：
 * 校验 Coach Agent 和 Intent Agent 的输出是否一致
 * 不合规则返回 issues，由调用方决定是否重试 Intent Agent
 *
 * 与旧 guard 的关键区别：不做数据修正（旧 guard 会改写 LLM 输出），只做校验
 */

import type { CoachOutput, IntentOutput, ConsistencyResult } from '../../types';
import type { PracticeSession } from '../../types';

/**
 * 校验一轮对话的 Coach 和 Intent 输出是否一致
 * 返回 { valid, issues }
 */
export function validateTurnConsistency(
  _coachOutput: CoachOutput,
  _intentOutput: IntentOutput,
  _session: PracticeSession,
  _step: number,
): ConsistencyResult {
  // 后续 PR-F 填充实现
  return { valid: true, issues: [] };
}
