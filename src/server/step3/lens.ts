/**
 * Step3 判断透镜（P2 — 判断漂移治理）
 *
 * 职责：
 * 1. 运营可编辑的配置：通用原则清单 + 题型结构约束表（按 chainType + slot semantic）
 * 2. 纯函数 `evaluateMinute`：对一次学生回答做确定性质量判断，
 *    输出 { verdict, reason }（ok / thin / off_target / duplicate）
 * 3. 供教练上下文注入"透镜锚点"（判断标准），让引导随学生回答变化（不套模板）
 *
 * 设计原则：
 * - 透镜只做"判断"（评估回答质量），不做"改结构"（结构归秘书）
 * - 保守策略：只拦确定性信号（太薄 / 明显跑题 / 复读），拿不准放行让教练引导
 * - 所有阈值集中在此文件，运营可编辑
 */

import type { Step3Minute, Step3Skeleton, Step3Slot, Step3SlotSemantic } from '../../types';
import { skeletonFlatSlots } from '../../utils/step3Skeleton';

// ============================================================
// 判断透镜配置（运营可编辑）
// ============================================================

/** 通用原则清单：对所有 Step3 回答生效。 */
export const LENS_GENERAL_RULES: { id: string; label: string; desc: string }[] = [
  {
    id: 'concrete',
    label: '具体性',
    desc: '回答要有具体机制/场景/对象/数据，不能只有抽象标签或口号。',
  },
  {
    id: 'on_slot',
    label: '贴槽',
    desc: '内容要贴合当前槽位的论证职能（分论点要完整主张句，原因要因果链…）。',
  },
  {
    id: 'non_duplicate',
    label: '不重复',
    desc: '与已确认的兄弟槽内容不得复读或高度近似。',
  },
  {
    id: 'causal',
    label: '因果闭合',
    desc: '链式槽（原因→机制→结果）之间要有可理解的递进，不能跳步或倒置。',
  },
];

/** 按槽语义的最小字数阈值（判定 thin）。 */
export const LENS_MIN_LEN: Record<Step3SlotSemantic, number> = {
  claim: 12,
  reason: 14,
  mechanism: 14,
  impact: 14,
  example: 12,
  scenario: 12,
  solution: 14,
};

/** 按槽语义的"跑题"信号（命中即 off_target 候选）。 */
export const LENS_OFF_SIGNAL: Partial<Record<Step3SlotSemantic, RegExp[]>> = {
  claim: [/展开原因|原因是|为什么会|理由是/, /举个例子|场景是|典型场景/],
  reason: [/分论点|核心观点是/, /解决措施|方案是/],
  mechanism: [/分论点|核心观点是/, /最终影响|结果是|带来的好处是/],
  impact: [/具体机制|怎么发生|操作|切成|配合|追踪|提醒/, /展开原因|为什么会/],
  example: [/展开原因|为什么会/, /核心观点是/],
  scenario: [/展开原因|为什么会/, /最终影响|结果是/],
  solution: [/展开原因|为什么会/, /最终影响|结果是/],
};

/** 按 chainType 的结构约束表（题型结构约束）。 */
export const LENS_CHAIN_CONSTRAINTS: Record<
  Step3Skeleton['chainType'],
  { requireBeat: Step3SlotSemantic[]; desc: string }
> = {
  cause_effect: {
    requireBeat: ['reason', 'mechanism', 'impact'],
    desc: '因果论证链：须覆盖 原因→机制→结果，链条要完整可理解。',
  },
  problem_solution: {
    requireBeat: ['mechanism', 'impact', 'solution'],
    desc: '问题解决链：须覆盖 现状/问题→影响→解决措施→预期效果。',
  },
  concession: {
    requireBeat: ['reason', 'impact'],
    desc: '让步论证：先承认对立面合理，再转折反驳，不能只站在一边。',
  },
  support: {
    requireBeat: ['reason', 'example'],
    desc: '支持论证：分论点后要有展开原因与具体支撑。',
  },
  compare: {
    requireBeat: ['reason', 'impact'],
    desc: '对比论证：两边→关键差异→孰优孰劣，不能只写一边。',
  },
  parallel: {
    requireBeat: ['reason', 'impact'],
    desc: '平行论证：多个分点各自独立展开，不能互相折叠。',
  },
};

// ============================================================
// 确定性评估纯函数
// ============================================================

export interface LensVerdict {
  /** ok=放行；thin=太薄需追问；off_target=贴错槽；duplicate=复读/近似；off_topic=完全跑题。 */
  verdict: 'ok' | 'thin' | 'off_target' | 'duplicate' | 'off_topic';
  reason: string;
  /** 建议给教练的追问方向（不作为模板，教练自由措辞）。 */
  hint?: string;
}

const OFF_SIGNAL_RE: Record<Step3SlotSemantic, RegExp[]> = {
  claim: LENS_OFF_SIGNAL.claim || [],
  reason: LENS_OFF_SIGNAL.reason || [],
  mechanism: LENS_OFF_SIGNAL.mechanism || [],
  impact: LENS_OFF_SIGNAL.impact || [],
  example: LENS_OFF_SIGNAL.example || [],
  scenario: LENS_OFF_SIGNAL.scenario || [],
  solution: LENS_OFF_SIGNAL.solution || [],
};

/**
 * P3 切题预检：学生回答是否完全脱离本题 / 当前槽位（确定性强信号，只拦明确跑题）。
 *
 * 拦截条件（任一命中）：
 * 1. 明显在谈无关话题（如"我们去吃饭吧""这道题我不会""换个题目"…）
 * 2. 纯元对话（"你能再说一遍吗""什么意思""怎么操作"…）—— 这是请求澄清，不落槽
 *
 * 原则（护栏不充当模板校验器）：只拦 100% 确定的非内容回答；
 * 任何可能是有内容（哪怕偏薄/偏题）的回答一律放行，交给 lens/教练判断。
 */
const OFF_TOPIC_RE: RegExp[] = [
  // 无关话题 / 离开任务（容忍"我们/我先/要不"等口语前缀）
  /^(我们|我先|要不|那|咱们|我)?(去吃|去玩|去喝|去睡觉|今天天气|聊聊|换个话题|不谈这个|先不聊|算了不写|不想写了|放弃|不写了|换题|换个题目|跳过这题|下一题|别的题|无关|跑题了|你跑题|去吃饭|去逛街|去休息)/,
  // 纯元对话（请求澄清 / 反问过程）—— 不产生内容
  /^(什么意思|你说什么|没听懂|没明白|再说一遍|重复一下|举个例子说明你|怎么操作|怎么用|怎么弄|步骤是什么|能不能简单|为什么这么问|你问的什么)/,
  // 答非所问到荒谬（与任务完全无关的完整句）
  /^(我饿了|我困了|我累了|我要走了|今天先到这|明天再写)/,
];

/** 判定是否完全跑题（确定性；不命中一律放行）。 */
export function isOffTopic(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  for (const re of OFF_TOPIC_RE) {
    if (re.test(t)) return true;
  }
  return false;
}

/**
 * 评估一次学生回答的质量（确定性纯函数）。
 *
 * @param text        学生回答原文
 * @param slot        目标槽（含 semantic / label）
 * @param confirmed   该 subpoint 已 confirmed 的 minutes（用于 duplicate 判断）
 * @param chainType   当前 body 论证链类型（可选，用于结构约束提示）
 */
export function evaluateMinute(
  text: string,
  slot: Step3Slot,
  confirmed: Step3Minute[],
  chainType?: Step3Skeleton['chainType'],
): LensVerdict {
  const t = String(text || '').trim();

  // 1. 太短 / 空 → thin
  if (!t) {
    return { verdict: 'thin', reason: '回答为空', hint: '请用一两句话具体说说你的想法。' };
  }

  // 1.5 P3 切题预检：完全跑题 → off_topic（确定性强信号，只拦明确跑题）
  if (isOffTopic(t)) {
    return {
      verdict: 'off_topic',
      reason: '回答与当前写作任务完全无关',
      hint: '我们还在讨论这个主体段的论证。请回到这一步（当前槽），说一个具体想法。',
    };
  }

  // 2. 与已 confirmed 兄弟槽重复（子串包含 或 LCS 相似度≥0.6，与秘书 dup 一致）
  const norm = (s: string) => String(s).replace(/[\s，,。.！!？?；;：:""''「」【】\-—]/g, '').toLowerCase();
  const nt = norm(t);
  if (nt.length >= 6) {
    for (const m of confirmed) {
      const nm = norm(m.text);
      if (!nm || nm.length < 6) continue;
      if (nt.includes(nm) || nm.includes(nt)) {
        return { verdict: 'duplicate', reason: '与已确认内容重复', hint: '刚才这点已经记下了，换一个新的角度或环节说说。' };
      }
      const sim = lcsSimilarity(nt, nm);
      if (sim >= 0.6) {
        return {
          verdict: 'duplicate',
          reason: `与已确认内容高度近似（相似度 ${Math.round(sim * 100)}%）`,
          hint: '刚才这点已经记下了，换一个新的角度或环节说说。',
        };
      }
    }
  }

  // 3. 跑题：命中"其他槽语义"的强信号 → off_target
  const offSignals = OFF_SIGNAL_RE[slot.semantic] || [];
  for (const re of offSignals) {
    if (re.test(t)) {
      return {
        verdict: 'off_target',
        reason: `内容像是在答其他环节（命中「${re.source}」）`,
        hint: `这一步（${slot.label}）要说的是${slot.placeholder || '当前环节'}，我们回到这一步。`,
      };
    }
  }

  // 4. 太薄：短于阈值 或 无具体性信号
  const minLen = LENS_MIN_LEN[slot.semantic] || 12;
  if (nt.length < minLen) {
    return {
      verdict: 'thin',
      reason: `内容偏薄（${nt.length} 字 < 建议 ${minLen}）`,
      hint: `这一步（${slot.label}）可以再具体一点：补充场景、机制或对象。`,
    };
  }

  // 5. 具体性启发：抽空泛口号（无具体名词）
  const abstractOnly = /^(很|非常|非常地|特别|更|最)?(重要|好|大|明显|关键|显著|有效)(的|地)?(作用|影响|好处|意义|价值|提升|增强)?[。.!！?？]?$/.test(t);
  if (abstractOnly) {
    return {
      verdict: 'thin',
      reason: '内容为抽象口号，缺少具体支撑',
      hint: '这句话还比较空泛，能不能落到一个具体场景、对象或机制上？',
    };
  }

  return { verdict: 'ok', reason: '回答达标' };
}

/** 最长公共子串长度占较长者比例（0-1），用于近似重复检测。 */
function lcsSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const longer = a.length >= b.length ? a : b;
  const shorter = a === longer ? b : a;
  if (longer.length === 0) return 0;
  let best = 0;
  for (let i = 0; i < shorter.length; i++) {
    for (let j = i + 1; j <= shorter.length; j++) {
      const sub = shorter.slice(i, j);
      if (longer.includes(sub)) {
        if (sub.length > best) best = sub.length;
      } else {
        break;
      }
    }
  }
  return best / longer.length;
}

/** 从 skeleton + minutes 找出给定槽对应的 Step3Slot 定义。 */
export function findSlotDef(
  skeleton: Step3Skeleton | null | undefined,
  slotKey: string,
): Step3Slot | null {
  if (!skeleton) return null;
  for (const f of skeletonFlatSlots(skeleton)) {
    if (f.slot.key === slotKey) return f.slot;
  }
  return null;
}

// ------------------------------------------------------------
// P0 质量门控：LLM 评估优先、确定性透镜兜底 → 落槽动作
// ------------------------------------------------------------

export interface LandingGate {
  /** land=落槽；hold=暂不落槽（thin/off_target/off_topic）；reject=拒绝（duplicate）。 */
  action: 'land' | 'hold' | 'reject';
  verdict: string;
  reason: string;
  hint: string;
}

/**
 * 质量门控决策（纯函数，可测试）。thin 的"至多 1 次追问后放行"由调用方按
 * countHeldForSlot 处理——本函数只判定本条回答本身该 land/hold/reject。
 *
 * @param llmVerdict   LLM step3Assessment.verdict（仅当 slotKey 匹配当前槽时传入）
 * @param llmReason    LLM reason（内部，不进学生文本）
 * @param llmHint      LLM nextHint（给教练的追问方向，非模板）
 */
export function resolveLandingGate(params: {
  text: string;
  slot: Step3Slot | null;
  confirmed: Step3Minute[];
  chainType?: Step3Skeleton['chainType'];
  llmVerdict?: string;
  llmReason?: string;
  llmHint?: string;
}): LandingGate {
  const { text, slot, confirmed, chainType, llmVerdict, llmReason, llmHint } = params;
  if (!slot) {
    // 无槽（骨架缺失/已满）：放行交 landMinuteToSlot 处理（no_slots / all_slots_filled 等）。
    return { action: 'land', verdict: 'ok', reason: 'no_slot', hint: '' };
  }
  const lens = evaluateMinute(text, slot, confirmed, chainType);
  const verdict = llmVerdict && slot ? llmVerdict : lens.verdict;
  const reason = String(llmReason || lens.reason || '');
  const hint = String(llmHint || lens.hint || '');
  if (verdict === 'duplicate') {
    return { action: 'reject', verdict, reason, hint };
  }
  if (verdict === 'off_target' || verdict === 'off_topic' || verdict === 'thin') {
    return { action: 'hold', verdict, reason, hint };
  }
  return { action: 'land', verdict, reason, hint };
}

/** 汇总某 subpoint 已 confirmed 的 minutes。 */
export function confirmedMinutes(subpoint: any): Step3Minute[] {
  return Array.isArray(subpoint?.minutes)
    ? (subpoint.minutes as Step3Minute[]).filter((m) => m.status === 'confirmed' && m.slotKey)
    : [];
}

/** 生成给教练的"透镜锚点"文本（注入 Step3 上下文）。 */
export function formatLensAnchor(
  slot: Step3Slot | null,
  chainType?: Step3Skeleton['chainType'],
): string {
  if (!slot) return '（当前无活动槽）';
  const lines: string[] = [
    `- 当前槽「${slot.label}」的判断透镜（内部，勿照抄给学生）：`,
    `  · 期望：${slot.placeholder || '具体、贴题、可论证的实质内容'}`,
    `  · 贴槽判定：内容应落在「${slot.label}」的论证职能上，不答其他环节`,
    `  · 太薄判定：少于约 ${LENS_MIN_LEN[slot.semantic] || 12} 字，或纯抽象口号无具体对象`,
    `  · 复读判定：与已确认内容重复/近似时，引导换角度`,
  ];
  if (chainType && LENS_CHAIN_CONSTRAINTS[chainType]) {
    lines.push(
      `  · 本段链型约束（${chainType}）：${LENS_CHAIN_CONSTRAINTS[chainType].desc}`,
    );
  }
  return lines.join('\n');
}
