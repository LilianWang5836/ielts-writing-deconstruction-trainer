/**
 * Step2 student-turn intent.
 *
 * Live path: LLM JSON classification (meaning), with a thin structured fallback
 * for UI decisions / offline tests — not a growing synonym dictionary.
 */
import { classifyStudentReply } from '../intent-router';

export type Step2TurnIntentKind =
  | 'content_elaboration'
  | 'retention_choice'
  | 'meta_process'
  | 'propose_new_parallel_claim'
  | 'accept_slot_add'
  | 'reject_slot_add'
  | 'confirm_ack'
  | 'stance_choice'
  | 'unknown';

export type Step2RetentionChoiceRole =
  | 'detail'
  | 'brief'
  | 'both_detail'
  | 'drop';

export interface Step2StudentTurnIntent {
  kind: Step2TurnIntentKind;
  /** When kind === retention_choice */
  retention?: {
    role: Step2RetentionChoiceRole;
    /** 1-based index from 「详细写1」/「①详写」 */
    targetIndex?: number;
    targetClaim?: string;
    /** When one point is picked as detail, mark other ready siblings brief */
    pairBriefOthers?: boolean;
  };
  /** Preferred mount / new-claim label when relevant */
  claimHint?: string;
  confidence: number;
  source: 'decision' | 'heuristic' | 'llm';
}

export function emptyStep2StudentTurnIntent(
  kind: Step2TurnIntentKind = 'unknown',
): Step2StudentTurnIntent {
  return { kind, confidence: 0, source: 'heuristic' };
}

/** UI structured decision wins over free-text. */
export function intentFromStructuredDecision(decision: {
  type?: string;
  action?: string;
  claim?: string;
} | null | undefined): Step2StudentTurnIntent | null {
  if (!decision?.type || !decision?.action) return null;
  const type = String(decision.type);
  const action = String(decision.action);
  if (type === 'slot_add') {
    if (action === 'accept') {
      return {
        kind: 'accept_slot_add',
        claimHint: decision.claim,
        confidence: 1,
        source: 'decision',
      };
    }
    if (action === 'reject') {
      return {
        kind: 'reject_slot_add',
        claimHint: decision.claim,
        confidence: 1,
        source: 'decision',
      };
    }
  }
  if (type === 'retention' && (action === 'accept' || action === 'reject')) {
    return {
      kind: action === 'accept' ? 'confirm_ack' : 'meta_process',
      confidence: 1,
      source: 'decision',
    };
  }
  if (type === 'stance' && (action === 'accept' || action === 'reject')) {
    return {
      kind: action === 'accept' ? 'stance_choice' : 'meta_process',
      confidence: 1,
      source: 'decision',
    };
  }
  // Phase1 unified proposal channel
  if (type === 'proposal' && (action === 'accept' || action === 'reject')) {
    return {
      kind: action === 'accept' ? 'confirm_ack' : 'meta_process',
      confidence: 1,
      source: 'decision',
    };
  }
  return null;
}

/**
 * Thin fallback when LLM is unavailable (tests / errors).
 * Prefers process / role structure over synonym lists.
 */
export function classifyStep2StudentTurnHeuristic(args: {
  userMessage: string;
  hasPendingSlotAdd?: boolean;
  coachAsk?: string;
}): Step2StudentTurnIntent {
  const msg = String(args.userMessage || '').trim();
  if (!msg) return emptyStep2StudentTurnIntent('unknown');

  // V1.1：共享粗粒度意图路由先做一轮（非阻塞、只路由不拦）——
  //   - 待提案槽位：accept/短句 object 直接映射采纳/拒绝（object 排除增量表达）；
  //   - exhausted/skip：明确返回 unknown，防止长句“我暂时想不出别的角度了”被误判为内容；
  //   - accept：落到 confirm_ack（富集：没问题/可以啊/好嘞/对对/确认 等）。
  const coarse = classifyStudentReply(msg);
  if (args.hasPendingSlotAdd) {
    if (coarse === 'accept' && !/继续/.test(msg)) {
      return { kind: 'accept_slot_add', confidence: 0.85, source: 'heuristic' };
    }
    if (coarse === 'object' && msg.length <= 20 && !/还有一|补充一|再补/.test(msg)) {
      return { kind: 'reject_slot_add', confidence: 0.85, source: 'heuristic' };
    }
  }
  if (coarse === 'exhausted' || coarse === 'skip') {
    return emptyStep2StudentTurnIntent('unknown');
  }
  if (coarse === 'accept') {
    return { kind: 'confirm_ack', confidence: 0.8, source: 'heuristic' };
  }

  // Pending slot-add: bare accept/reject tokens
  if (args.hasPendingSlotAdd) {
    if (/^(采纳|接受|加入|加进去|同意|确认)[。.!！？?\s]*$/i.test(msg)) {
      return { kind: 'accept_slot_add', confidence: 0.95, source: 'heuristic' };
    }
    if (
      /^(拒绝|不用|不要|不加入|不需要|算了|否|别加|不加)[。.!！？?\s]*$/i.test(
        msg,
      )
    ) {
      return { kind: 'reject_slot_add', confidence: 0.95, source: 'heuristic' };
    }
  }

  // Meta / process critique about the coach — never board material
  if (isMetaProcessMessage(msg)) {
    return { kind: 'meta_process', confidence: 0.9, source: 'heuristic' };
  }

  // Retention role choice (incl. 详细写1 / ①详写)
  const retention = parseRetentionChoiceMessage(msg);
  if (retention) {
    return {
      kind: 'retention_choice',
      retention,
      confidence: 0.9,
      source: 'heuristic',
    };
  }

  if (
    /^(好的?|好|可以|行|嗯+|哦|噢|对|是|继续|就这样|ok|okay|yes)[。.!！？?\s]*$/i.test(
      msg,
    )
  ) {
    return { kind: 'confirm_ack', confidence: 0.85, source: 'heuristic' };
  }

  if (
    /^(弊大于利|利大于弊|积极|消极|正面|负面|同意|不同意|部分同意|完全同意|完全不同意)[。.!！？?\s]*$/i.test(
      msg,
    ) ||
    (msg.length <= 24 && /弊大于利|利大于弊|积极|消极|立场/.test(msg))
  ) {
    return { kind: 'stance_choice', confidence: 0.8, source: 'heuristic' };
  }

  // Default free-text in explore = content (unless coach just asked 详略 only)
  if (
    args.coachAsk &&
    /更倾向.*详写|回复「详写」或「略写」|详写\*\*还是\*\*略写/.test(
      args.coachAsk,
    ) &&
    msg.length <= 20
  ) {
    const again = parseRetentionChoiceMessage(msg);
    if (again) {
      return {
        kind: 'retention_choice',
        retention: again,
        confidence: 0.85,
        source: 'heuristic',
      };
    }
  }

  if (msg.length >= 8) {
    return {
      kind: 'content_elaboration',
      confidence: 0.7,
      source: 'heuristic',
    };
  }

  return emptyStep2StudentTurnIntent('unknown');
}

export function isMetaProcessMessage(msg: string): boolean {
  const t = String(msg || '').trim();
  if (!t) return false;
  // Questions / complaints about the tutoring process itself
  if (
    /前面.*(问过|说过|定过|已经)|不是已经问过|为什么又问|又问一遍|弄混了|搞混了|你搞错|答非所问|不是论证|不是论点|不要当成|别再问|重复问|搞笑|有病|什么鬼|离谱/.test(
      t,
    )
  ) {
    return true;
  }
  // Pure process question without claim content
  if (
    t.length <= 40 &&
    /[？?]$/.test(t) &&
    /问过|为什么|怎么又|不是/.test(t) &&
    !/因为|导致|使得|所以|比如|例如/.test(t)
  ) {
    return true;
  }
  return false;
}

export function parseRetentionChoiceMessage(msg: string): {
  role: Step2RetentionChoiceRole;
  targetIndex?: number;
  pairBriefOthers?: boolean;
} | null {
  const t = String(msg || '').trim();
  if (!t || t.length > 40) return null;

  if (/都详|都详细|两条都详|全部详写|都要详写|都展开/.test(t)) {
    return { role: 'both_detail' };
  }
  if (/^(放弃|不写|放下|用户放弃)[。.!！？?\s]*$/i.test(t)) {
    return { role: 'drop' };
  }

  const detailIdx =
    /(?:详细写|详写|展开写)\s*[第]?\s*([1-6一二三四五六①②③④⑤⑥])/.exec(t) ||
    /^([1-6①②③④⑤⑥])\s*(?:详细写|详写)/.exec(t) ||
    /([①②③④⑤⑥])\s*(?:详细写|详写|详)/.exec(t);
  if (detailIdx) {
    return {
      role: 'detail',
      targetIndex: parsePointIndexToken(detailIdx[1]),
      pairBriefOthers: false,
    };
  }

  const briefIdx =
    /(?:略写|简单写|一带而过)\s*[第]?\s*([1-6一二三四五六①②③④⑤⑥])/.exec(t) ||
    /^([1-6①②③④⑤⑥])\s*(?:略写|简单写)/.exec(t);
  if (briefIdx) {
    return {
      role: 'brief',
      targetIndex: parsePointIndexToken(briefIdx[1]),
      pairBriefOthers: false,
    };
  }

  if (/^(详写|详细写|展开写|详)[。.!！？?\s]*$/i.test(t)) {
    return { role: 'detail', pairBriefOthers: false };
  }
  if (/^(略写|简单写|一带而过|略)[。.!！？?\s]*$/i.test(t)) {
    return { role: 'brief' };
  }

  // 「详细写1」 glued
  const glued = /^(?:详细写|详写)([1-6])$/.exec(t);
  if (glued) {
    return {
      role: 'detail',
      targetIndex: Number(glued[1]),
      pairBriefOthers: false,
    };
  }

  return null;
}

function parsePointIndexToken(raw: string): number | undefined {
  const t = String(raw || '').trim();
  const circled: Record<string, number> = {
    '①': 1,
    '②': 2,
    '③': 3,
    '④': 4,
    '⑤': 5,
    '⑥': 6,
  };
  if (circled[t]) return circled[t];
  const cn: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
  };
  if (cn[t]) return cn[t];
  const n = Number(t);
  if (n >= 1 && n <= 6) return n;
  return undefined;
}

export function buildStep2StudentTurnIntentPrompt(args: {
  userMessage: string;
  coachAsk: string;
  boardClaims: string[];
  hasPendingSlotAdd: boolean;
  pendingSlotClaim?: string;
}): string {
  const board = args.boardClaims.filter(Boolean).slice(0, 8).join('、') || '（空）';
  return `你是 IELTS Step2 头脑风暴回合的意图分类器。只根据「意思」判断学生这句话在干什么，不要被字面同义词词典束缚。

【右侧已有论点（冻结槽）】
${board}

【教练上一问】
${args.coachAsk || '（无）'}

【是否有待确认的「新平行论点」】
${args.hasPendingSlotAdd ? `有：${args.pendingSlotClaim || ''}` : '无'}

【学生本轮消息】
${args.userMessage}

【可选 kind】
- content_elaboration: 在补充/展开某个已有论点的具体场景、机制、受影响对象（论证材料）
- retention_choice: 在选详写/略写/都详写/放弃某条（含「详细写1」「①详写」这类）
- meta_process: 抱怨流程、指出重复提问、纠正教练、非论证内容（如「前面不是已经问过了」）
- propose_new_parallel_claim: 学生明确提出一条「材料池里还没有的新平行论点」
- accept_slot_add / reject_slot_add: 对「是否把某条加入材料池」的采纳或拒绝
- confirm_ack: 短确认（好的/可以）但不是在给新论据
- stance_choice: 在选全文立场
- unknown: 无法判断

【硬规则】
1) 流程吐槽/纠正教练 → meta_process（绝不是 content，绝不是 propose_new_parallel_claim）
2) 只有学生明确在提「新的一条平行论点」且板上没有等价槽时，才用 propose_new_parallel_claim
3) 对已有维度的展开 → content_elaboration，并尽量填 mountClaim 为板上最接近的标签
4) retention_choice 时填写 retention.role；若指定第几条，填 targetIndex（1-based）。pairBriefOthers 必须为 false（详写一条时不要自动略写同侧其它条）

只输出 JSON：
{
  "kind": "...",
  "mountClaim": "板上标签或空字符串",
  "newClaim": "仅 propose_new_parallel_claim 时填写",
  "retention": {
    "role": "detail|brief|both_detail|drop",
    "targetIndex": 1,
    "pairBriefOthers": false
  } | null,
  "confidence": 0.0
}`;
}

function tryParseJsonObject(raw: string): any | null {
  let text = String(raw || '').trim();
  if (!text) return null;
  if (text.startsWith('```')) {
    text = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    /* try extract / soft-repair truncated JSON */
  }
  const start = text.indexOf('{');
  if (start < 0) return null;
  let frag = text.slice(start);
  try {
    return JSON.parse(frag);
  } catch {
    /* continue */
  }
  // Truncated object: close open braces / strip trailing comma
  frag = frag.replace(/,\s*$/, '');
  const opens = (frag.match(/\{/g) || []).length;
  const closes = (frag.match(/\}/g) || []).length;
  if (opens > closes) frag += '}'.repeat(opens - closes);
  try {
    return JSON.parse(frag);
  } catch {
    return null;
  }
}

export function parseStep2StudentTurnIntentLlm(
  rawText: string,
): Step2StudentTurnIntent | null {
  try {
    const data = tryParseJsonObject(rawText);
    if (!data || typeof data !== 'object') return null;
    const kind = String(data?.kind || '').trim() as Step2TurnIntentKind;
    const allowed: Step2TurnIntentKind[] = [
      'content_elaboration',
      'retention_choice',
      'meta_process',
      'propose_new_parallel_claim',
      'accept_slot_add',
      'reject_slot_add',
      'confirm_ack',
      'stance_choice',
      'unknown',
    ];
    if (!allowed.includes(kind)) return null;
    const out: Step2StudentTurnIntent = {
      kind,
      claimHint: String(data?.mountClaim || data?.newClaim || '').trim() || undefined,
      confidence: Math.max(0, Math.min(1, Number(data?.confidence) || 0.7)),
      source: 'llm',
    };
    if (kind === 'retention_choice' && data?.retention?.role) {
      out.retention = {
        role: String(data.retention.role) as Step2RetentionChoiceRole,
        targetIndex:
          typeof data.retention.targetIndex === 'number'
            ? data.retention.targetIndex
            : undefined,
        // Never silent-pair-brief siblings from LLM
        pairBriefOthers: false,
      };
    }
    return out;
  } catch {
    return null;
  }
}

/** Whether this intent may write student text onto the board. */
export function intentMayMountContent(intent: Step2StudentTurnIntent | null | undefined): boolean {
  if (!intent) return true; // legacy default
  return (
    intent.kind === 'content_elaboration' ||
    intent.kind === 'propose_new_parallel_claim' ||
    intent.kind === 'unknown'
  );
}

/** Whether unmatched text may become pendingSlotAdd. */
export function intentMayProposeNewSlot(
  intent: Step2StudentTurnIntent | null | undefined,
): boolean {
  return intent?.kind === 'propose_new_parallel_claim';
}

export function intentIsMetaProcess(
  intent: Step2StudentTurnIntent | null | undefined,
): boolean {
  return intent?.kind === 'meta_process';
}
