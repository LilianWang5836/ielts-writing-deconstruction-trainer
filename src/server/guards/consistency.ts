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
  coachOutput: CoachOutput,
  intentOutput: IntentOutput,
  session: PracticeSession,
  step: number,
): ConsistencyResult {
  const issues: string[] = [];

  // ==========================================
  // 规则 1：Intent 不能修改已确认的槽位
  // ==========================================
  if (step === 3 && intentOutput.slotUpdates?.length) {
    const subpoints = session.step3?.subpoints || [];
    const activeSp = subpoints.find(
      (sp: any) => sp.id === session.step3?.activeSubpointId,
    );

    if (activeSp?.paragraphPlan?.pointBlocks) {
      const confirmedKeys = new Set<string>();
      for (const block of activeSp.paragraphPlan.pointBlocks) {
        for (const s of block.steps || []) {
          if (s.status === 'confirmed') confirmedKeys.add(s.key);
        }
      }

      for (const update of intentOutput.slotUpdates) {
        if (confirmedKeys.has(update.key)) {
          issues.push(
            `[VIOLATION] 试图修改已确认槽位: ${update.key}（当前 action: ${update.action}）`,
          );
        }
      }
    }
  }

  // ==========================================
  // 规则 2：Intent 的 slotUpdate key 必须存在于 plan 中
  // ==========================================
  if (step === 3 && intentOutput.slotUpdates?.length) {
    const subpoints = session.step3?.subpoints || [];
    const activeSp = subpoints.find(
      (sp: any) => sp.id === session.step3?.activeSubpointId,
    );

    if (activeSp?.paragraphPlan?.pointBlocks) {
      const allKeys = new Set<string>();
      for (const block of activeSp.paragraphPlan.pointBlocks) {
        for (const s of block.steps || []) {
          allKeys.add(s.key);
        }
      }

      for (const update of intentOutput.slotUpdates) {
        if (!allKeys.has(update.key)) {
          issues.push(
            `[VIOLATION] slotUpdate 引用了不存在的 key: ${update.key}`,
          );
        }
      }
    }
  }

  // ==========================================
  // 规则 3：adaptations 不能跨 pointBlock merge
  // ==========================================
  if (intentOutput.adaptations?.length) {
    for (const adapt of intentOutput.adaptations) {
      if (adapt.op === 'merge' && adapt.fromKeys?.length) {
        if (adapt.fromKeys.length > 2) {
          issues.push(
            `[VIOLATION] merge fromKeys 数量超过 2: ${adapt.fromKeys.join(', ')}`,
          );
        }
      }
    }
  }

  // ==========================================
  // 规则 4：completionFlag 不能在没有 CTA 文本时设置
  // ==========================================
  if (intentOutput.completionFlag?.isCompleted) {
    const hasCTA = /进入下一步|进入第[二三四]步|点击下一步|完成|大功告成/.test(
      coachOutput.text,
    );
    if (!hasCTA) {
      issues.push(
        `[WARN] completionFlag=true 但 Coach 文本中没有明确的下一步引导`,
      );
    }
  }

  return {
    valid: issues.filter((i) => i.startsWith('[VIOLATION]')).length === 0,
    issues,
  };
}
