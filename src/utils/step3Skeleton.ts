/**
 * Step3 会议秘书骨架工具（restructure 新架构）
 *
 * 职责：
 * 1. `toSkeleton`：把 Planner 产出的 bodyPlan.paragraphPlan（旧结构）转换为
 *    冻结骨架 `Step3Skeleton`——只保留结构（blocks/slots/semantic），
 *    丢弃 value/status 等"内容"字段（内容归 minutes 管）。
 * 2. `skeletonFlatSlots`：把骨架展开为有序槽列表（供落槽索引）。
 */

import type {
  BodyPlan,
  ParagraphPlan,
  Step3Skeleton,
  Step3SkeletonBlock,
  Step3Slot,
  Step3SlotSemantic,
} from '../types';

/** 由 label 推断槽的语义类型（判断透镜锚点）。 */
export function inferSlotSemantic(label: string): Step3SlotSemantic {
  const l = String(label || '').trim();
  if (/分论点|核心观点|论点|主张|观点句|claim/i.test(l)) return 'claim';
  if (/展开原因|原因|为什么|起因|成因/i.test(l)) return 'reason';
  if (/机制|过程|怎么发生|链条|操作|实现|途径/i.test(l)) return 'mechanism';
  if (/结果|影响|后果|好处|作用|效果/i.test(l)) return 'impact';
  if (/场景|例子|举例|典型|人群|案例/i.test(l)) return 'scenario';
  if (/解决|措施|方案|对策/i.test(l)) return 'solution';
  return 'claim';
}

/** 由 body 的 argumentRelation / role 推导论证链类型。 */
export function inferChainType(
  relation?: string,
  role?: string,
): Step3Skeleton['chainType'] {
  const r = String(relation || '').trim();
  const ro = String(role || '').trim();
  if (/solv/i.test(r) || /solution/i.test(ro)) return 'problem_solution';
  if (/conced|concession/i.test(r)) return 'concession';
  if (/compar|side_by_side/i.test(r)) return 'compare';
  if (/parallel/i.test(r)) return 'parallel';
  if (/causal|cause/i.test(r)) return 'cause_effect';
  return 'support';
}

/** 把单个 pointBlock 转成骨架 block。 */
function blockToSkeleton(block: any, fallbackLabel: string): Step3SkeletonBlock {
  const slots: Step3Slot[] = Array.isArray(block?.steps)
    ? block.steps
        .filter((s: any) => s && typeof s === 'object')
        .map((s: any) => ({
          key: String(s.key || ''),
          label: String(s.label || s.placeholder || '步骤'),
          placeholder: String(s.placeholder || s.label || ''),
          semantic: inferSlotSemantic(String(s.label || s.placeholder || '')),
        }))
    : [];
  return {
    id: String(block?.id || 'pb'),
    label: String(block?.label || fallbackLabel),
    subClaim: String(block?.subClaim || ''),
    role: block?.role === 'minor' ? 'minor' : 'major',
    slots,
  };
}

/** 把 paragraphPlan 转成冻结骨架。 */
export function planToSkeleton(
  plan: ParagraphPlan | null | undefined,
  opts?: { fallbackLabel?: string },
): Step3Skeleton | null {
  if (!plan || !Array.isArray(plan.pointBlocks) || plan.pointBlocks.length === 0) {
    return null;
  }
  const fallback = opts?.fallbackLabel || '分点';
  const blocks = plan.pointBlocks.map((b: any, i: number) =>
    blockToSkeleton(b, `${fallback} ${i + 1}`),
  );
  return { blocks, chainType: 'support' };
}

/** 把 BodyPlan（含 paragraphPlan）转成冻结骨架。 */
export function toSkeleton(bodyPlan: BodyPlan | null | undefined): Step3Skeleton | null {
  if (!bodyPlan) return null;
  const plan = bodyPlan.paragraphPlan;
  if (!plan || !Array.isArray(plan.pointBlocks) || plan.pointBlocks.length === 0) {
    return null;
  }
  const blocks = plan.pointBlocks.map((b: any, i: number) =>
    blockToSkeleton(b, `${bodyPlan.theme || '分点'} ${i + 1}`),
  );
  return {
    blocks,
    chainType: inferChainType(bodyPlan.argumentRelation, bodyPlan.role),
  };
}

/** 把骨架展开为有序槽列表（全局下标），供 activeSlotIndex 落槽索引。 */
export function skeletonFlatSlots(
  skeleton: Step3Skeleton | null | undefined,
): { blockIndex: number; slot: Step3Slot }[] {
  if (!skeleton) return [];
  const out: { blockIndex: number; slot: Step3Slot }[] = [];
  skeleton.blocks.forEach((b, bi) => {
    b.slots.forEach((s) => out.push({ blockIndex: bi, slot: s }));
  });
  return out;
}

/** 骨架槽总数。 */
export function skeletonSlotCount(
  skeleton: Step3Skeleton | null | undefined,
): number {
  return skeletonFlatSlots(skeleton).length;
}
