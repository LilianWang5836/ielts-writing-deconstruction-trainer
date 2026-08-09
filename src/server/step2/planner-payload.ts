/**
 * Step2 → Planner material contract.
 *
 * Single source of truth for parallel points + stance + coverage buckets.
 * Paragraph layout stays in Step 2.5 Planner.
 */

import type {
  CoverageBucket,
  Step2Point,
  Step2PlannerPayload,
  Step2RetentionRole,
  Step2StancePolarity,
  Step2StanceStrength,
} from '../../types';
import { isClaimSentence } from '../../utils/step3ClaimPrefill';

const CLAIM_MIN = 8;

const ALL_BUCKETS: CoverageBucket[] = [
  'view_a',
  'view_b',
  'advantage',
  'disadvantage',
  'cause',
  'solution',
  'positive',
  'negative',
  'part_1',
  'part_2',
  'support_main',
  'oppose_or_qualify',
  'general',
];

function isBucket(v: string): v is CoverageBucket {
  return (ALL_BUCKETS as string[]).includes(v);
}

export function resolvePointId(
  id: string,
  redirects: Record<string, string>,
): string {
  let cur = String(id || '').trim();
  const seen = new Set<string>();
  while (cur && redirects[cur] && !seen.has(cur)) {
    seen.add(cur);
    cur = redirects[cur];
  }
  return cur;
}

export function activePoints(payload: Step2PlannerPayload | null | undefined): Step2Point[] {
  if (!payload?.points?.length) return [];
  return payload.points.filter((p) => !p.supersededBy);
}

export function scorePointQuality(
  claim: string,
  elaboration: string,
): 'thin' | 'ready' {
  const c = String(claim || '').trim();
  const e = String(elaboration || '').trim();
  if (!c) return 'thin';
  const hasCjk = /[\u4e00-\u9fff]/.test(c);
  // Short Chinese dimension heads (人际关系 / 环境保护) are OK when elaboration is solid
  if (c.length < (hasCjk ? 2 : CLAIM_MIN)) return 'thin';
  if (e.length >= 12) return 'ready';
  // Full claim sentence with causal/scene cues
  if (
    /(因为|所以|导致|使得|通过|例如|比如|当|如果|场景|机制|从而|提升|降低|提高|减少|改善)/.test(
      c,
    )
  ) {
    return 'ready';
  }
  // Longer standalone Chinese claim (≥14) counts as ready for brainstorming
  if (c.length >= 14) return 'ready';
  return 'thin';
}

export function requiredBucketsForType(
  questionType: string,
  requiresStance: boolean,
  polarity: Step2StancePolarity,
): { hard: CoverageBucket[]; soft: CoverageBucket[] } {
  const t = String(questionType || '').trim();
  if (t === 'Discuss Both Views') {
    return { hard: ['view_a', 'view_b'], soft: [] };
  }
  if (t === 'Advantages / Disadvantages') {
    return { hard: ['advantage', 'disadvantage'], soft: [] };
  }
  if (t === 'Problem / Solution') {
    return { hard: ['cause', 'solution'], soft: [] };
  }
  if (t === 'Two-part Question') {
    return { hard: ['part_1', 'part_2'], soft: [] };
  }
  if (t === 'Positive / Negative') {
    return { hard: ['positive', 'negative'], soft: [] };
  }
  if (t === 'Agree / Disagree') {
    const soft: CoverageBucket[] =
      polarity === 'partial' || polarity === 'unknown'
        ? ['oppose_or_qualify']
        : [];
    return { hard: [], soft };
  }
  // Other
  return { hard: [], soft: [] };
}

export function minReadyForType(questionType: string): number {
  const t = String(questionType || '').trim();
  if (t === 'Other') return 2;
  return 2;
}

export function inferStanceMeta(stanceText: string): {
  polarity: Step2StancePolarity;
  strength: Step2StanceStrength;
} {
  const t = String(stanceText || '').trim();
  if (!t) return { polarity: 'unknown', strength: 'unknown' };

  if (/不需要.*立场|概述|先解释|再提出|两问|两个任务/.test(t)) {
    return { polarity: 'not_required', strength: 'unknown' };
  }
  if (/利大于弊|优点胜过|利大于|outweigh.*advantage/i.test(t)) {
    return { polarity: 'outweigh_yes', strength: 'qualified' };
  }
  if (/弊大于利|缺点胜过|弊大于|outweigh.*disadvantage/i.test(t)) {
    return { polarity: 'outweigh_no', strength: 'qualified' };
  }
  if (/部分同意|有保留|在.*程度上同意|不完全同意|既.*又/.test(t)) {
    return { polarity: 'partial', strength: 'qualified' };
  }
  if (/完全不同意|强烈反对|坚决反对|完全反对/.test(t)) {
    return { polarity: 'disagree', strength: 'full' };
  }
  if (/完全同意|完全赞同|强烈同意|坚决支持|完全支持/.test(t)) {
    return { polarity: 'agree', strength: 'full' };
  }
  if (/不同意|反对|难以赞同/.test(t)) {
    return { polarity: 'disagree', strength: 'qualified' };
  }
  if (/同意|赞同|支持/.test(t)) {
    return { polarity: 'agree', strength: 'qualified' };
  }
  if (/积极|正面|利大于/.test(t) && /消极|负面|弊/.test(t)) {
    return { polarity: 'balanced', strength: 'qualified' };
  }
  if (/积极|正面为主|总体积极/.test(t)) {
    return { polarity: 'positive', strength: 'qualified' };
  }
  if (/消极|负面为主|总体消极/.test(t)) {
    return { polarity: 'negative', strength: 'qualified' };
  }
  return { polarity: 'unknown', strength: 'unknown' };
}

function defaultTagsForSide(
  questionType: string,
  side: 'A' | 'B' | '',
): CoverageBucket[] {
  const t = String(questionType || '').trim();
  if (side === 'A') {
    if (t === 'Discuss Both Views') return ['view_a'];
    if (t === 'Advantages / Disadvantages') return ['advantage'];
    if (t === 'Problem / Solution') return ['cause'];
    if (t === 'Two-part Question') return ['part_1'];
    if (t === 'Positive / Negative') return ['general'];
    if (t === 'Agree / Disagree') return ['support_main'];
    return ['general'];
  }
  if (side === 'B') {
    if (t === 'Discuss Both Views') return ['view_b'];
    if (t === 'Advantages / Disadvantages') return ['disadvantage'];
    if (t === 'Problem / Solution') return ['solution'];
    if (t === 'Two-part Question') return ['part_2'];
    if (t === 'Positive / Negative') return ['positive', 'negative'];
    if (t === 'Agree / Disagree') return ['oppose_or_qualify'];
    return ['general'];
  }
  return ['general'];
}

function inferTagsFromText(
  text: string,
  questionType: string,
  side: 'A' | 'B' | '',
): CoverageBucket[] {
  const t = String(text || '');
  const fromSide = defaultTagsForSide(questionType, side);
  const extras: CoverageBucket[] = [];
  if (/积极|正面|好处|益处/.test(t)) extras.push('positive', 'advantage');
  if (/消极|负面|坏处|弊端|危害/.test(t)) extras.push('negative', 'disadvantage');
  if (/原因|成因|导致/.test(t)) extras.push('cause');
  if (/解决|措施|办法|应对/.test(t)) extras.push('solution');
  const merged = [...fromSide, ...extras].filter(isBucket);
  return [...new Set(merged.length ? merged : (['general'] as CoverageBucket[]))];
}

/** Strip retention / process tags that must not become claim text. */
export function stripRetentionTags(text: string): string {
  let t = String(text || '');
  t = t.replace(/（\s*已选详写[^）]*）/g, '');
  t = t.replace(/（\s*已选略写[^）]*）/g, '');
  // Coach summary roles: （主/详写）（次/略写）（主）（次）等
  t = t.replace(/（\s*[主次]\s*[／/]\s*(?:详写|略写)\s*）/g, '');
  t = t.replace(/（\s*(?:详写|略写)\s*[／/]\s*[主次]\s*）/g, '');
  t = t.replace(/（\s*[主次]\s*）/g, '');
  t = t.replace(/（\s*详写[^）]*）/g, '');
  t = t.replace(/（\s*略写[^）]*）/g, '');
  t = t.replace(/（\s*已展开[^）]*）/g, '');
  t = t.replace(/（\s*保留-略写[^）]*）/g, '');
  t = t.replace(/（\s*用户放弃[^）]*）/g, '');
  t = t.replace(/（\s*待补例子[^）]*）/g, '');
  t = t.replace(/（\s*待展开详写[^）]*）/g, '');
  t = t.replace(/\(\s*已选详写[^)]*\)/g, '');
  t = t.replace(/\(\s*已选略写[^)]*\)/g, '');
  t = t.replace(/已选详写|已选略写|已展开|保留-略写|用户放弃/g, '');
  t = t.replace(/（\s*）/g, '');
  t = t.replace(/\(\s*\)/g, '');
  t = t.replace(/[；;，,]{2,}/g, '；');
  t = t.replace(/^[；;，,\s]+|[；;，,\s]+$/g, '');
  return t.trim();
}

/**
 * Split a free-text point into claim head + elaboration.
 * Handles coach formats like:
 *   人际关系（主/详写）：追求GDP……
 *   环境保护（将额外财富用于……）
 *   社会文化服务：财富投入图书馆……
 */
export function parseClaimElaboration(text: string): {
  claim: string;
  elaboration: string;
} {
  let raw = stripRetentionTags(String(text || '').trim());
  if (!raw) return { claim: '', elaboration: '' };

  // "head（role）：body" or "head：body" after role tags stripped
  const colon = raw.match(
    /^([\u4e00-\u9fffA-Za-z0-9·、]{2,24})\s*[：:]\s*([\s\S]+)$/,
  );
  if (colon) {
    return {
      claim: normalizeClaimLabel(colon[1]),
      elaboration: cleanElaboration(colon[2]),
    };
  }

  // "head（body…）" — body is content, not a process tag
  const paren = raw.match(
    /^([\u4e00-\u9fffA-Za-z0-9·、]{2,24})[（(]([\s\S]+?)[）\)](?:[。．；;\s]*)$/,
  );
  if (paren) {
    const inner = paren[2].trim();
    const isRoleOnly = /^[主次]?[／/]?(?:详写|略写)?$/.test(inner);
    if (!isRoleOnly && inner.length >= 4) {
      return {
        claim: normalizeClaimLabel(paren[1]),
        elaboration: cleanElaboration(inner),
      };
    }
  }

  const head = dimensionHead(raw);
  if (head && raw.length > head.length + 1) {
    // leftover after head (e.g. "人际关系 追求GDP…")
    const rest = cleanElaboration(raw.slice(head.length));
    if (rest.length >= 4) {
      return { claim: head, elaboration: rest };
    }
  }

  return { claim: normalizeClaimLabel(raw), elaboration: '' };
}

/** Prefer longer / more specific head when one is a prefix/core of the other. */
export function headsCompatible(a: string, b: string): boolean {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  // Avoid merging on tiny stems like "社会" / "文化"
  if (short.length < 3) return false;
  // 社会文化 ⊂ 社会文化服务 / 社会文化生活和服务
  if (long.startsWith(short)) return true;
  // Allow infix only for longer cores (≥4): 文化生活 ⊂ 社会文化生活和服务
  if (short.length >= 4 && long.includes(short)) return true;
  return false;
}

export function preferHead(a: string, b: string): string {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x) return y;
  if (!y) return x;
  if (x === y) return x;
  // Prefer longer specific label
  if (x.includes(y)) return x;
  if (y.includes(x)) return y;
  return x.length >= y.length ? x : y;
}

/** Clean elaboration: drop placeholders and duplicate punctuation. */
export function cleanElaboration(text: string): string {
  let t = stripRetentionTags(text);
  t = t.replace(/待定|待展开|待补例子|待裁决/g, '；');
  t = t.replace(/）\s*（/g, '；');
  t = t.replace(/\)\s*\(/g, '；');
  // Unwrap a single outer paren pair left by slice fallbacks: （图书馆）→图书馆
  if (/^（[^（）]+）$/.test(t) || /^\([^()]+\)$/.test(t)) {
    t = t.slice(1, -1).trim();
  }
  t = t.replace(/[；;，,]{2,}/g, '；');
  t = t.replace(/^[；;，,\s]+|[；;，,\s]+$/g, '');
  t = t.replace(/；{2,}/g, '；');
  t = t.trim();
  if (!t || t === '待展开' || t === '待定' || t === '待补例子') return '';
  // Dedupe near-identical segments (keep the longer one)
  const segs = t
    .split(/；|;/)
    .map((s) => s.trim())
    .filter(Boolean);
  const kept: string[] = [];
  for (const s of segs) {
    const idx = kept.findIndex(
      (k) => k === s || k.includes(s) || s.includes(k),
    );
    if (idx >= 0) {
      if (s.length > kept[idx].length) kept[idx] = s;
      continue;
    }
    kept.push(s);
  }
  return kept.join('；');
}

/** Normalize claim display: drop empty parens, keep dimension head. */
export function normalizeClaimLabel(text: string): string {
  const t = stripRetentionTags(text);
  const head = dimensionHead(t);
  if (head && (t === `${head}（）` || t === `${head}()` || t === head)) {
    return head;
  }
  if (head && t.startsWith(head) && /（\s*）\s*$/.test(t)) {
    return head;
  }
  if (head && t === head) return head;
  return t;
}

/** Split free text into claim-sized chunks (1 claim = 1 point). */
export function splitClaimChunks(text: string): string[] {
  const raw = String(text || '').trim();
  if (!raw) return [];

  // Strip side headers for chunking inside a section
  const withoutHeaders = raw
    .replace(/^[AB]面[^：:]*[：:]/gm, '')
    .replace(/A面[^：:]*[：:]/g, '\n')
    .replace(/B面[^：:]*[：:]/g, '\n');

  // Split on numbered markers even when glued after 。/； (e.g. "…幸福感。2. 稳定收入…")
  const byNumber = withoutHeaders.split(
    /(?:^|[；;\n。．])\s*\d+[.、．)\]]\s*/,
  );
  let parts =
    byNumber.length > 1
      ? byNumber
      : withoutHeaders.split(/[；;\n]+/);

  // Also split "….维度名（" glued after a full stop (expansion of an earlier dimension)
  const refined: string[] = [];
  for (const part of parts) {
    const sub = String(part || '').split(
      /(?<=[）)])\s*[。．]\s*(?=[\u4e00-\u9fff]{2,16}[（])/,
    );
    refined.push(...sub);
  }
  parts = refined;

  parts = parts
    .map((p) => {
      // Keep full "head：body" chunks for parseClaimElaboration; only strip numbering
      const cleaned = p.replace(/^\d+[.、．)\]]\s*/, '').trim();
      // If it's already a head：body line, don't strip role tags away from structure —
      // parseClaimElaboration handles that. Just light normalize empty shells.
      if (/[：:]/.test(cleaned) || /[（(]/.test(cleaned)) return cleaned;
      return normalizeClaimLabel(cleaned);
    })
    .filter((p) => p.length >= 2);

  // Dedup near-identical / same dimension head with empty body
  const out: string[] = [];
  const seenHeads = new Set<string>();
  for (const p of parts) {
    const head = dimensionHead(p) || claimKey(p);
    const isEmptyShell = Boolean(head && (p === head || p === `${head}（）`));
    if (isEmptyShell && head && seenHeads.has(head)) continue;
    if (out.some((x) => x === p || (x.includes(p) && p.length >= 12))) continue;
    if (head) seenHeads.add(head);
    out.push(p);
  }
  return out;
}

function extractSideSection(userPoints: string, side: 'A' | 'B'): string {
  const text = String(userPoints || '');
  if (!text.trim()) return '';
  const sideRe =
    side === 'A'
      ? /A面[^：:]*[：:]([\s\S]*?)(?=B面[^：:]*[：:]|$)/
      : /B面[^：:]*[：:]([\s\S]*)$/;
  return String(text.match(sideRe)?.[1] || '').trim();
}

function nextPointId(points: Step2Point[]): string {
  let max = 0;
  for (const p of points) {
    const m = /^p(\d+)$/.exec(String(p.id || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `p${max + 1}`;
}

function claimKey(claim: string): string {
  return String(claim || '')
    .replace(/（\s*）/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, '')
    .slice(0, 40);
}

/** Short dimension / topic head for merge (e.g. 人际关系). */
export function dimensionHead(text: string): string {
  const t = stripRetentionTags(String(text || '').trim());
  const paren = t.match(/^([\u4e00-\u9fffA-Za-z0-9·、]{2,20})[（(]/);
  if (paren) return paren[1].trim();
  // Bare head or head with trailing empty already stripped
  const bare = t.match(/^([\u4e00-\u9fff·、]{2,20})$/);
  if (bare) return bare[1].trim();
  const short = t.match(/^([\u4e00-\u9fff·、]{2,16})/);
  return short ? short[1].trim() : '';
}

/**
 * Merge expansions that share the same (or nested) dimension head into one point
 * (claim stays the preferred head; longer text becomes elaboration).
 * Returns redirects for superseded ids.
 */
export function mergePointsByDimensionHead(points: Step2Point[]): {
  points: Step2Point[];
  redirects: Record<string, string>;
} {
  const active = points.filter((p) => !p.supersededBy);
  const groups: Step2Point[] = [];
  const redirects: Record<string, string> = {};

  const findGroup = (head: string): Step2Point | undefined => {
    for (const g of groups) {
      const gh =
        String(g.fromDimension || '').trim() ||
        dimensionHead(g.claim) ||
        g.claim;
      if (headsCompatible(gh, head)) return g;
    }
    return undefined;
  };

  for (const p of active) {
    // Re-parse claim in case expansion was stored as a single blob
    const parsed = parseClaimElaboration(
      p.elaboration
        ? `${p.claim}：${p.elaboration}`
        : p.claim,
    );
    if (parsed.claim) p.claim = parsed.claim;
    if (parsed.elaboration) {
      p.elaboration = cleanElaboration(
        [p.elaboration, parsed.elaboration]
          .filter(Boolean)
          .join('；'),
      );
      // Avoid claim===full sentence duplication
      if (p.elaboration.includes(p.claim) && p.claim.length > 12) {
        /* keep */
      }
    }

    const head =
      String(p.fromDimension || '').trim() ||
      dimensionHead(p.claim) ||
      claimKey(p.claim);
    if (!head) continue;

    const prev = findGroup(head);
    if (!prev) {
      const h = dimensionHead(p.claim) || head;
      p.claim = preferHead(h, head);
      p.fromDimension = p.claim;
      p.elaboration = cleanElaboration(p.elaboration || '');
      groups.push(p);
      continue;
    }

    const mergedHead = preferHead(
      String(prev.fromDimension || prev.claim),
      head,
    );
    const incomingElab = [p.elaboration, p.claim !== prev.claim ? p.claim : '']
      .map((x) => cleanElaboration(String(x || '')))
      .filter(
        (x) =>
          x &&
          x !== prev.claim &&
          x !== mergedHead &&
          x !== head &&
          !String(prev.elaboration || '').includes(x),
      );
    for (const chunk of incomingElab) {
      prev.elaboration = cleanElaboration(
        [prev.elaboration, chunk].filter(Boolean).join('；'),
      );
    }
    prev.claim = mergedHead;
    prev.fromDimension = mergedHead;
    prev.leanTags = [
      ...new Set([...(prev.leanTags || []), ...(p.leanTags || [])]),
    ];
    prev.quality = scorePointQuality(prev.claim, prev.elaboration || '');
    p.supersededBy = prev.id;
    redirects[p.id] = prev.id;
  }

  for (const p of points) {
    if (p.supersededBy) continue;
    p.claim = normalizeClaimLabel(p.claim);
    p.elaboration = cleanElaboration(p.elaboration || '');
    // Drop elaboration that is just a shorter alias of claim
    if (p.elaboration === p.claim) p.elaboration = '';
    p.quality = scorePointQuality(p.claim, p.elaboration || '');
  }
  return { points, redirects };
}

const STEP1_DIM_TAG_RE =
  /[（(]\s*(可展开|空标签|质量待确认|已探测|已询退出)\s*[）)]/g;

/** Strip Step1 status tags → dimension core label. */
export function stripDimensionCore(dim: string): string {
  return String(dim || '')
    .replace(STEP1_DIM_TAG_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Step1 dimension cores that freeze Step2 right-board slots.
 * Prefer （已探测）（可展开）; fall back to all unique cores.
 */
export function extractStep1DimensionCores(session: any): string[] {
  const raw =
    session?.step1?.boardOverrides?.suggestedDimensions ||
    session?.step1?.coachEvaluation?.suggestedDimensions ||
    [];
  if (!Array.isArray(raw)) return [];

  const expandable: string[] = [];
  const all: string[] = [];
  const seenExp = new Set<string>();
  const seenAll = new Set<string>();

  for (const d of raw) {
    const text = String(d || '').trim();
    if (!text) continue;
    const core = stripDimensionCore(text);
    if (core.length < 2) continue;
    const key = core.toLowerCase();
    if (!seenAll.has(key)) {
      seenAll.add(key);
      all.push(core);
    }
    const isExp =
      /[（(]\s*可展开\s*[）)]/.test(text) &&
      /[（(]\s*已探测\s*[）)]/.test(text) &&
      !/[（(]\s*空标签\s*[）)]/.test(text);
    if (isExp && !seenExp.has(key)) {
      seenExp.add(key);
      expandable.push(core);
    }
  }
  return expandable.length ? expandable : all;
}

/** Split compound coach labels: 环境保护与社会文化服务 → [环保…, 社文…] */
export function splitCompoundClaimParts(text: string): string[] {
  const t = stripRetentionTags(String(text || '').trim());
  if (!t) return [];
  const parts = t
    .split(/\s*(?:与|和|、|／|\/|以及)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  return parts.length > 1 ? parts : [t];
}

function appendElaboration(prev: Step2Point, chunks: string[]): void {
  const add = chunks
    .map((x) => cleanElaboration(String(x || '')))
    .filter(
      (x) =>
        x &&
        x !== prev.claim &&
        x !== prev.fromDimension &&
        !String(prev.elaboration || '').includes(x),
    );
  if (!add.length) return;
  prev.elaboration = cleanElaboration(
    [...(prev.elaboration ? [prev.elaboration] : []), ...add].join('；'),
  );
  prev.quality = scorePointQuality(prev.claim, prev.elaboration || '');
}

/** Find locked slots that match a free-text claim / compound label. */
export function findMatchingSlots(
  points: Step2Point[],
  text: string,
): Step2Point[] {
  const active = points.filter((p) => !p.supersededBy);
  if (!active.length) return [];
  const raw = String(text || '').trim();
  if (!raw) return [];

  const parts = splitCompoundClaimParts(raw);
  const matched: Step2Point[] = [];
  const used = new Set<string>();

  const tryMatch = (needle: string) => {
    const n = normalizeClaimLabel(needle);
    if (n.length < 2) return;
    // Exact / compatible head
    for (const p of active) {
      if (used.has(p.id)) continue;
      const head = String(p.fromDimension || p.claim || '').trim();
      if (
        head === n ||
        p.claim === n ||
        headsCompatible(head, n) ||
        headsCompatible(p.claim, n)
      ) {
        matched.push(p);
        used.add(p.id);
      }
    }
    // Substring either way (人际关系 ⊂ 人际关系损害；环保 ⊂ 复合标签)
    for (const p of active) {
      if (used.has(p.id)) continue;
      const head = String(p.fromDimension || p.claim || '').trim();
      if (head.length >= 2 && (n.includes(head) || head.includes(n))) {
        matched.push(p);
        used.add(p.id);
      }
    }
  };

  for (const part of parts) tryMatch(part);
  tryMatch(raw);

  if (matched.length) return matched;

  // Content-only line: pick the slot whose claim appears in the blob
  for (const p of active) {
    const head = String(p.claim || '').trim();
    if (head.length >= 2 && raw.includes(head)) {
      matched.push(p);
      used.add(p.id);
    }
  }
  return matched;
}

export function seedFixedSlotsFromDimensions(dims: string[]): Step2Point[] {
  const points: Step2Point[] = [];
  for (const dim of dims) {
    const claim = stripDimensionCore(dim);
    if (claim.length < 2) continue;
    if (points.some((p) => p.claim === claim || headsCompatible(p.claim, claim))) {
      continue;
    }
    points.push({
      id: `p${points.length + 1}`,
      claim,
      elaboration: '',
      fromDimension: claim,
      leanTags: ['general'],
      quality: 'thin',
    });
  }
  return points;
}

/**
 * Migrate legacy free-grown points onto fixed Step1 slots.
 * Slot count = dims.length; extras are superseded; elaborations are kept.
 */
export function migrateToFixedSlots(
  dims: string[],
  existing: Step2Point[],
): { points: Step2Point[]; redirects: Record<string, string> } {
  const redirects: Record<string, string> = {};
  const slots = seedFixedSlotsFromDimensions(dims);
  const oldActive = existing.filter((p) => !p.supersededBy);

  for (const old of oldActive) {
    const targets = findMatchingSlots(slots, old.claim);
    const destList =
      targets.length > 0
        ? targets
        : findMatchingSlots(
            slots,
            [old.claim, old.elaboration, old.fromDimension]
              .filter(Boolean)
              .join(' '),
          );
    if (!destList.length) {
      // Orphan content: attach to first thin slot as last resort only if elab-like
      const elab = cleanElaboration(
        [old.elaboration, old.claim !== old.fromDimension ? old.claim : '']
          .filter(Boolean)
          .join('；'),
      );
      if (elab && slots[0]) {
        appendElaboration(slots[0], [elab]);
        if (old.id !== slots[0].id) {
          old.supersededBy = slots[0].id;
          redirects[old.id] = slots[0].id;
        }
      }
      continue;
    }
    const elabChunks = [
      old.elaboration || '',
      // If old claim was a long sentence (not a slot head), keep as elaboration
      destList.some((d) => d.claim === old.claim || headsCompatible(d.claim, old.claim))
        ? ''
        : old.claim,
    ];
    for (const dest of destList) {
      appendElaboration(dest, elabChunks);
      if (Array.isArray(old.leanTags) && old.leanTags.length) {
        dest.leanTags = [
          ...new Set([...(dest.leanTags || []), ...old.leanTags]),
        ];
      }
      if (old.id !== dest.id) {
        redirects[old.id] = dest.id;
      }
    }
    // Preserve original id on first matching slot when possible
    const primary = destList[0];
    if (old.id && !slots.some((s) => s.id === old.id)) {
      // Keep slot ids stable as p1..pn; just redirect old → primary
      redirects[old.id] = primary.id;
    }
  }

  // Keep superseded old rows for redirect history
  const superseded = oldActive
    .filter((p) => redirects[p.id] && !slots.some((s) => s.id === p.id))
    .map((p) => ({
      ...p,
      supersededBy: redirects[p.id],
      leanTags: [...(p.leanTags || [])],
    }));

  return { points: [...slots, ...superseded], redirects };
}

/**
 * Attach candidate text onto existing points.
 * When allowCreate=false (locked slots), never push new points; claim labels stay frozen.
 */
export function upsertPointsFromClaims(
  existing: Step2Point[],
  claims: Array<{
    claim: string;
    elaboration?: string;
    leanTags?: CoverageBucket[];
    fromDimension?: string;
  }>,
  opts?: { allowCreate?: boolean },
): Step2Point[] {
  const allowCreate = opts?.allowCreate !== false;
  const points = existing.map((p) => ({ ...p, leanTags: [...(p.leanTags || [])] }));
  const locked = !allowCreate && points.some((p) => !p.supersededBy);

  for (const c of claims) {
    const parsed = parseClaimElaboration(
      c.elaboration
        ? `${String(c.claim || '').trim()}：${String(c.elaboration || '').trim()}`
        : String(c.claim || '').trim(),
    );
    const rawClaim = parsed.claim || normalizeClaimLabel(String(c.claim || '').trim());
    if (rawClaim.length < 2 && !parsed.elaboration) continue;

    const elab = cleanElaboration(
      parsed.elaboration || String(c.elaboration || '').trim(),
    );
    const tags = (c.leanTags || []).filter(isBucket);
    const dim = String(
      c.fromDimension || dimensionHead(rawClaim) || '',
    ).trim();

    const matchText = [dim, rawClaim, elab].filter(Boolean).join(' ');
    let targets = findMatchingSlots(points, matchText);
    if (!targets.length && dim) targets = findMatchingSlots(points, dim);
    if (!targets.length) targets = findMatchingSlots(points, rawClaim);

    if (targets.length) {
      const extraAsElab =
        !targets.some(
          (t) => t.claim === rawClaim || headsCompatible(t.claim, rawClaim),
        ) && rawClaim.length >= 4
          ? rawClaim
          : '';
      for (const prev of targets) {
        // Locked slots: never rename claim — only hang elaboration
        appendElaboration(prev, [elab, extraAsElab]);
        if (tags.length) {
          prev.leanTags = [...new Set([...(prev.leanTags || []), ...tags])];
        }
        prev.quality = scorePointQuality(prev.claim, prev.elaboration || '');
      }
      continue;
    }

    if (locked || !allowCreate) {
      // No matching slot — drop rather than grow the board
      continue;
    }

    if (!elab && dim && rawClaim === dim) continue; // empty shell
    const minLen = /[\u4e00-\u9fff]/.test(rawClaim) ? 2 : CLAIM_MIN;
    const claim = dim || rawClaim;
    if (claim.length < minLen) continue;
    const id = nextPointId(points);
    const point: Step2Point = {
      id,
      claim,
      elaboration: elab || '',
      fromDimension: dim || claim,
      leanTags: tags.length ? tags : ['general'],
      quality: scorePointQuality(claim, elab || ''),
    };
    points.push(point);
  }
  return points;
}

export function computeCoverage(
  points: Step2Point[],
  questionType: string,
  requiresStance: boolean,
  polarity: Step2StancePolarity,
  stanceText: string,
  forceExitUsed: boolean,
): Step2PlannerPayload['coverage'] & {
  exitGate: Step2PlannerPayload['exitGate'];
} {
  const active = points.filter((p) => !p.supersededBy);
  const ready = active.filter((p) => p.quality === 'ready');
  const { hard, soft } = requiredBucketsForType(
    questionType,
    requiresStance,
    polarity,
  );

  const filled = new Set<CoverageBucket>();
  for (const p of ready) {
    for (const tag of p.leanTags || []) {
      if (isBucket(tag)) filled.add(tag);
    }
  }

  const missingBuckets = hard.filter((b) => !filled.has(b));
  const softMissingBuckets = soft.filter((b) => !filled.has(b));
  const filledBuckets = [...filled];
  const minReady = minReadyForType(questionType);

  const stanceOk =
    !requiresStance ||
    (String(stanceText || '').trim().length >= 4 &&
      polarity !== 'unknown');

  // outweigh-style: require judgment polarity when Adv/Dis + requiresStance
  const outweighOk =
    String(questionType || '') !== 'Advantages / Disadvantages' ||
    !requiresStance ||
    polarity === 'outweigh_yes' ||
    polarity === 'outweigh_no' ||
    polarity === 'balanced' ||
    polarity === 'partial' ||
    // allow agree-like wording filled into stance
    String(stanceText || '').trim().length >= 8;

  const coveragePassed =
    missingBuckets.length === 0 && ready.length >= minReady;

  const canComplete =
    (coveragePassed && stanceOk && outweighOk) || forceExitUsed;

  let blockReason: string | undefined;
  if (!canComplete) {
    if (missingBuckets.length) {
      blockReason = `还缺可写材料：${missingBuckets.map(bucketLabel).join('、')}`;
    } else if (ready.length < minReady) {
      blockReason = `请至少再展开 ${minReady - ready.length} 个具体论点（主张句+场景/机制）`;
    } else if (!stanceOk) {
      blockReason = '请先确认你的整体立场';
    } else if (!outweighOk) {
      blockReason = '请明确利弊权衡结论（哪一边更重）';
    }
  }

  return {
    passed: coveragePassed,
    requiredBuckets: hard,
    filledBuckets,
    missingBuckets,
    softMissingBuckets,
    exitGate: {
      canComplete,
      canForceExit: !canComplete,
      forceExitUsed,
      blockReason,
    },
  };
}

export function bucketLabel(b: CoverageBucket): string {
  const map: Record<CoverageBucket, string> = {
    view_a: '观点A',
    view_b: '观点B',
    advantage: '优点/利',
    disadvantage: '缺点/弊',
    cause: '原因/成因',
    solution: '解决措施',
    positive: '积极角度',
    negative: '消极角度',
    part_1: '第一问',
    part_2: '第二问',
    support_main: '主向论据',
    oppose_or_qualify: '对立/保留向论据',
    general: '可写论点',
  };
  return map[b] || b;
}

export function missingBucketCoachHint(missing: CoverageBucket[]): string {
  if (!missing.length) {
    return '材料类别已经齐了。若立场已明确，我们可以整理写作蓝图。';
  }
  const labels = missing.map(bucketLabel).join('、');
  return `接下来只补真正缺失的材料类别（${labels}）：请给出至少 1 个具体主张，并带上场景或机制。`;
}

/**
 * Infer 详写/略写 role for a claim from free-text userPoints / coach summary.
 * Matches: （已选详写）（详写）（主/详写）/ 人际关系（详写）：…
 */
export function inferRetentionRoleFromText(
  claim: string,
  corpus: string,
): Step2RetentionRole | undefined {
  const head = String(claim || '').trim();
  if (head.length < 2 || !corpus) return undefined;
  const text = String(corpus);

  // Prefer a chunk that mentions this claim / compatible head
  const chunks = text.split(/[；;\n]+/).map((s) => s.trim()).filter(Boolean);
  const prefix = head.slice(0, Math.min(4, head.length));
  const relevant = chunks.filter((c) => {
    const bare = stripRetentionTags(c);
    const bareHead = dimensionHead(bare) || bare.slice(0, 16);
    return (
      bare.includes(head) ||
      head.includes(bareHead) ||
      headsCompatible(head, bareHead) ||
      (prefix.length >= 3 && bare.includes(prefix)) ||
      /[①②③④⑤⑥\d]/.test(c) && bareHead.length >= 3 && head.includes(bareHead.slice(0, 3))
    );
  });
  const scan = relevant.length ? relevant.join('；') : text;

  // Local window around the claim mention
  const idx = scan.indexOf(head);
  const window =
    idx >= 0
      ? scan.slice(Math.max(0, idx - 4), idx + head.length + 24)
      : scan;

  if (
    /用户放弃/.test(window) ||
    /（\s*用户放弃\s*）/.test(window)
  ) {
    return 'dropped';
  }
  if (
    /已选详写|主\s*[／/]\s*详写|（\s*详写\s*）|详写\s*）|（详写）/.test(window) ||
    new RegExp(
      `${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n；;]{0,12}详写`,
    ).test(scan)
  ) {
    // Avoid treating 略写 as 详写 when both appear (e.g. wrong window)
    if (/已选略写|次\s*[／/]\s*略写|（\s*略写\s*）/.test(window) && !/已选详写|（\s*详写\s*）|主\s*[／/]\s*详写/.test(window)) {
      return 'brief';
    }
    return 'detail';
  }
  if (
    /已选略写|次\s*[／/]\s*略写|保留-略写|（\s*略写\s*）/.test(window) ||
    new RegExp(
      `${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n；;]{0,12}略写`,
    ).test(scan)
  ) {
    return 'brief';
  }
  return undefined;
}

/** Stamp retentionRole onto active points from userPoints (+ optional chat-like text). */
export function applyRetentionRolesFromUserPoints(
  points: Step2Point[],
  userPoints: string,
): Step2Point[] {
  const corpus = String(userPoints || '');
  if (!corpus.trim()) return points;
  return points.map((p) => {
    if (p.supersededBy) return p;
    const role = inferRetentionRoleFromText(
      p.claim,
      corpus,
    ) || inferRetentionRoleFromText(String(p.fromDimension || ''), corpus);
    if (!role) return p;
    return { ...p, retentionRole: role };
  });
}

/**
 * Build / refresh plannerPayload from session + optional incoming step2Data.
 *
 * Slot rule: when Step1 dimensions exist, freeze right-board point count/labels.
 * Later turns only attach elaborations onto those slots — never append new points.
 */
export function normalizeStep2PlannerPayload(args: {
  session: any;
  step2Data?: any;
  questionType: string;
  requiresStance: boolean;
  forceExitUsed?: boolean;
}): Step2PlannerPayload {
  const eval2 = args.session?.step2?.coachEvaluation || {};
  const step2 = args.step2Data || {};
  const prev: Step2PlannerPayload | null =
    step2.plannerPayload || eval2.plannerPayload || null;

  const redirects: Record<string, string> = {
    ...(prev?.redirects || {}),
  };

  const fixedClaims = extractStep1DimensionCores(args.session);
  const wantLock = fixedClaims.length > 0;
  let slotsLocked = Boolean(prev?.slotsLocked) || wantLock;

  let points: Step2Point[] = Array.isArray(prev?.points)
    ? prev!.points.map((p) => ({
        ...p,
        claim: normalizeClaimLabel(p.claim),
        elaboration: cleanElaboration(p.elaboration || ''),
        leanTags: [...(p.leanTags || [])],
      }))
    : [];

  // Freeze / migrate onto Step1 dimension slots
  if (wantLock) {
    const active = points.filter((p) => !p.supersededBy);
    const alreadyAligned =
      Boolean(prev?.slotsLocked) &&
      Array.isArray(prev?.fixedClaims) &&
      prev!.fixedClaims!.length === fixedClaims.length &&
      active.length === fixedClaims.length &&
      fixedClaims.every((c) =>
        active.some((p) => p.claim === c || headsCompatible(p.claim, c)),
      );

    if (!points.length) {
      points = seedFixedSlotsFromDimensions(fixedClaims);
      slotsLocked = true;
    } else if (!alreadyAligned) {
      const migrated = migrateToFixedSlots(fixedClaims, points);
      points = migrated.points;
      Object.assign(redirects, migrated.redirects);
      slotsLocked = true;
    } else {
      // Keep frozen claims exactly as fixedClaims order
      const byMatch = [...active];
      const ordered: Step2Point[] = [];
      for (const c of fixedClaims) {
        const hit =
          byMatch.find((p) => p.claim === c) ||
          byMatch.find((p) => headsCompatible(p.claim, c));
        if (hit) {
          hit.claim = c;
          hit.fromDimension = c;
          ordered.push(hit);
          byMatch.splice(byMatch.indexOf(hit), 1);
        } else {
          ordered.push({
            id: nextPointId([...points, ...ordered]),
            claim: c,
            elaboration: '',
            fromDimension: c,
            leanTags: ['general'],
            quality: 'thin',
          });
        }
      }
      // Supersede leftovers into best slot
      for (const orphan of byMatch) {
        const dest =
          findMatchingSlots(ordered, orphan.claim)[0] || ordered[0];
        if (dest) {
          appendElaboration(dest, [orphan.elaboration || '', orphan.claim]);
          orphan.supersededBy = dest.id;
          redirects[orphan.id] = dest.id;
        }
      }
      const superseded = points.filter((p) => p.supersededBy);
      points = [...ordered, ...superseded];
      slotsLocked = true;
    }
  }

  const allowCreate = !slotsLocked;

  // Incoming model points — attach only when locked
  const incomingPoints = Array.isArray(step2.plannerPayload?.points)
    ? step2.plannerPayload.points
    : Array.isArray(step2.plannerPoints)
      ? step2.plannerPoints
      : [];
  if (incomingPoints.length) {
    points = upsertPointsFromClaims(
      points,
      incomingPoints.map((p: any) => ({
        claim: String(p.claim || p.text || '').trim(),
        elaboration: String(p.elaboration || '').trim(),
        leanTags: Array.isArray(p.leanTags)
          ? p.leanTags.filter(isBucket)
          : undefined,
        fromDimension: p.fromDimension,
      })),
      { allowCreate },
    );
  }

  const userPoints = String(
    step2.userPoints || eval2.userPoints || args.session?.step2?.userPoints || '',
  );
  const questionType = args.questionType;

  /** Student-facing material pool: Chinese / student text only — no EN polish. */
  const isStudentMaterialClaim = (text: string): boolean => {
    const t = String(text || '').trim();
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    if (cjk >= 2 && t.length >= 2) {
      if (letters > cjk * 3) return false;
      return true;
    }
    if (t.length < CLAIM_MIN) return false;
    if (letters >= 20 && cjk === 0) return false;
    if (letters > cjk * 2 && cjk < 4) return false;
    return true;
  };

  const attachChunk = (
    claim: string,
    side: 'A' | 'B' | '',
  ) => {
    if (!isStudentMaterialClaim(claim)) return;
    const { claim: c, elaboration: e } = parseClaimElaboration(claim);
    if (!c && !e) return;
    points = upsertPointsFromClaims(
      points,
      [
        {
          claim: c || claim,
          elaboration: e,
          leanTags: inferTagsFromText(claim, questionType, side),
          fromDimension: dimensionHead(c) || c,
        },
      ],
      { allowCreate },
    );
  };

  for (const side of ['A', 'B'] as const) {
    const section = extractSideSection(userPoints, side);
    for (const claim of splitClaimChunks(section)) {
      attachChunk(claim, side);
    }
  }

  const aSec = extractSideSection(userPoints, 'A');
  const bSec = extractSideSection(userPoints, 'B');
  const unsectioned =
    !aSec && !bSec
      ? userPoints
      : userPoints
          .replace(/A面[^：:]*[：:][\s\S]*?(?=B面[^：:]*[：:]|$)/, '')
          .replace(/B面[^：:]*[：:][\s\S]*$/, '');

  for (const claim of splitClaimChunks(unsectioned)) {
    attachChunk(claim, '');
  }

  // Clustering: attach only (never grow when locked)
  const clustering = step2.clustering || eval2.clustering;
  const clusters = Array.isArray(clustering?.clusters) ? clustering.clusters : [];
  for (let i = 0; i < clusters.length; i++) {
    const cl = clusters[i];
    const side: 'A' | 'B' | '' = i === 0 ? 'A' : i === 1 ? 'B' : '';
    const content = String(cl?.content || '').trim();
    const theme = String(cl?.theme || '').trim();
    const list = Array.isArray(cl?.points) ? cl.points : [];
    const candidates = [
      ...list.map((x: any) => String(x || '').trim()),
      content,
      theme,
    ].filter(Boolean);
    for (const claim of candidates) {
      if (!isStudentMaterialClaim(claim)) continue;
      points = upsertPointsFromClaims(
        points,
        [
          {
            claim:
              theme && isStudentMaterialClaim(theme)
                ? theme.slice(0, 40)
                : claim.slice(0, 80),
            elaboration:
              content && content !== theme && isStudentMaterialClaim(content)
                ? content
                : claim !== theme
                  ? claim
                  : '',
            leanTags: inferTagsFromText(claim + content, questionType, side),
            fromDimension: theme || undefined,
          },
        ],
        { allowCreate },
      );
    }
  }

  // Only merge near-duplicates when slots are NOT locked from Step1
  if (!slotsLocked) {
    const merged = mergePointsByDimensionHead(points);
    points = merged.points;
    Object.assign(redirects, merged.redirects);
  }

  points = points.filter(
    (p) => p.supersededBy || isStudentMaterialClaim(p.claim),
  );

  // Stamp 详写/略写 from userPoints onto slots (display + planner hint)
  points = applyRetentionRolesFromUserPoints(points, userPoints);

  // Re-score; when locked, restore frozen claim labels
  const fixedSet = wantLock ? fixedClaims : [];
  points = points.map((p) => {
    if (!p.supersededBy && fixedSet.length) {
      const canon =
        fixedSet.find((c) => c === p.claim || headsCompatible(c, p.claim)) ||
        p.claim;
      p.claim = canon;
      p.fromDimension = canon;
    }
    return {
      ...p,
      quality: scorePointQuality(p.claim, p.elaboration || ''),
      leanTags: (p.leanTags || []).filter(isBucket),
      retentionRole: p.retentionRole,
    };
  });

  const stanceText = String(
    step2.userStance ||
      step2.blueprint?.position ||
      eval2.userStance ||
      eval2.blueprint?.position ||
      eval2.suggestedStance ||
      args.session?.step2?.userStance ||
      '',
  ).trim();

  const inferred = inferStanceMeta(stanceText);
  const polarity: Step2StancePolarity = args.requiresStance
    ? inferred.polarity === 'not_required'
      ? 'unknown'
      : inferred.polarity
    : 'not_required';
  const strength: Step2StanceStrength =
    polarity === 'not_required' ? 'unknown' : inferred.strength;

  const forceExitUsed = Boolean(
    args.forceExitUsed ||
      step2.plannerPayload?.exitGate?.forceExitUsed ||
      prev?.exitGate?.forceExitUsed,
  );

  const cov = computeCoverage(
    points,
    questionType,
    args.requiresStance,
    polarity,
    stanceText,
    forceExitUsed,
  );

  const dispositions =
    step2.dimensionDispositions ||
    eval2.dimensionDispositions ||
    prev?.dimensionDispositions ||
    [];

  const status: Step2PlannerPayload['status'] = cov.exitGate.canComplete
    ? 'ready'
    : points.some((p) => !p.supersededBy)
      ? 'draft'
      : 'invalid';

  return {
    version: 1,
    status,
    updatedAt: new Date().toISOString(),
    questionType,
    requiresStance: args.requiresStance,
    slotsLocked,
    fixedClaims: wantLock ? fixedClaims : prev?.fixedClaims,
    stance: {
      text: stanceText,
      polarity,
      strength,
    },
    points,
    redirects,
    dimensionDispositions: Array.isArray(dispositions) ? dispositions : [],
    coverage: {
      passed: cov.passed,
      requiredBuckets: cov.requiredBuckets,
      filledBuckets: cov.filledBuckets,
      missingBuckets: cov.missingBuckets,
      softMissingBuckets: cov.softMissingBuckets,
    },
    exitGate: cov.exitGate,
  };
}

/** Stable fingerprint for sourceHash / stale detection. */
export function plannerPayloadFingerprint(payload: Step2PlannerPayload | null | undefined): string {
  if (!payload) return '';
  const pts = activePoints(payload)
    .map(
      (p) =>
        `${p.id}|${p.claim}|${p.elaboration || ''}|${(p.leanTags || []).join(',')}|${p.quality}`,
    )
    .join('||');
  return [
    payload.stance?.text || '',
    payload.stance?.polarity || '',
    payload.stance?.strength || '',
    pts,
    (payload.coverage?.missingBuckets || []).join(','),
  ].join('::');
}

export function hydrateBodyPlansFromPayload(
  bodyPlans: any[],
  payload: Step2PlannerPayload | null | undefined,
): any[] {
  if (!Array.isArray(bodyPlans) || !payload) return bodyPlans;
  const byId = new Map(
    activePoints(payload).map((p) => [p.id, p] as const),
  );

  for (const bp of bodyPlans) {
    const ids: string[] = Array.isArray(bp.mappedPointIds)
      ? bp.mappedPointIds
      : [];
    const resolved = ids
      .map((id) => resolvePointId(String(id), payload.redirects || {}))
      .map((id) => byId.get(id))
      .filter(Boolean) as Step2Point[];

    if (resolved.length) {
      const claims = resolved.map((p) => p.claim);
      bp.mappedPoints = claims;
      const plan = bp.paragraphPlan;
      if (plan?.pointBlocks?.length) {
        for (let i = 0; i < plan.pointBlocks.length; i++) {
          const block = plan.pointBlocks[i];
          const claim = String(claims[i] || claims[0] || '').trim();
          if (!claim) continue;
          if (isClaimSentence(claim)) {
            // Full Step2 claim sentence → 论点句
            block.subClaim = claim;
          } else {
            // Dimension head (环境保护) → theme label only; Step3 must confirm 论点句
            const label = String(block.label || '').trim();
            if (!label || label === claim || !isClaimSentence(label)) {
              block.label = claim;
            }
            if (!isClaimSentence(String(block.subClaim || ''))) {
              block.subClaim = '';
            }
            if (!bp.theme || !isClaimSentence(String(bp.theme))) {
              bp.theme = claim;
            }
          }
        }
      } else if (!bp.theme) {
        const head = String(claims[0] || '').trim();
        if (head && !isClaimSentence(head)) bp.theme = head;
      }
    }
  }
  return bodyPlans;
}

/**
 * Soft normalize: when bodyCount≥3 and a body maps only to brief points,
 * merge those bodies into the last detail/ready body. Keeps ≥2 bodies.
 * Does nothing if merge would leave fewer than 2 bodies.
 */
export function mergeBriefOnlyBodies(
  bodyPlans: any[],
  payload: Step2PlannerPayload | null | undefined,
): any[] {
  if (!Array.isArray(bodyPlans) || bodyPlans.length < 3 || !payload) {
    return bodyPlans;
  }
  const byId = new Map(
    activePoints(payload).map((p) => [p.id, p] as const),
  );
  const redirects = payload.redirects || {};

  const resolvedFor = (bp: any): Step2Point[] => {
    const ids: string[] = Array.isArray(bp?.mappedPointIds)
      ? bp.mappedPointIds
      : [];
    return ids
      .map((id) => resolvePointId(String(id), redirects))
      .map((id) => byId.get(id))
      .filter(Boolean) as Step2Point[];
  };

  const isBriefOnly = (bp: any): boolean => {
    const pts = resolvedFor(bp);
    if (!pts.length) return false;
    return pts.every((p) => p.retentionRole === 'brief');
  };

  const briefIdx: number[] = [];
  const keepIdx: number[] = [];
  bodyPlans.forEach((bp, i) => {
    if (isBriefOnly(bp)) briefIdx.push(i);
    else keepIdx.push(i);
  });

  if (!briefIdx.length || keepIdx.length < 2) return bodyPlans;

  const keep = keepIdx.map((i) => bodyPlans[i]);
  const target = keep[keep.length - 1];
  if (!target) return bodyPlans;

  for (const bi of briefIdx) {
    const brief = bodyPlans[bi];
    const bidIds: string[] = Array.isArray(brief?.mappedPointIds)
      ? brief.mappedPointIds.map(String)
      : [];
    const existing = new Set(
      (Array.isArray(target.mappedPointIds)
        ? target.mappedPointIds
        : []
      ).map(String),
    );
    target.mappedPointIds = [
      ...(Array.isArray(target.mappedPointIds) ? target.mappedPointIds : []),
      ...bidIds.filter((id) => !existing.has(id)),
    ];
    target.paragraphDensity = 'dual_point';
    const tPlan = target.paragraphPlan;
    const bPlan = brief?.paragraphPlan;
    if (tPlan && Array.isArray(tPlan.pointBlocks) && bPlan?.pointBlocks?.length) {
      for (const block of bPlan.pointBlocks) {
        tPlan.pointBlocks.push({
          ...block,
          id: `${block.id || 'pb'}_brief`,
          role: block.role === 'major' ? 'minor' : block.role || 'minor',
        });
      }
      if (tPlan.mode === 'single_point') {
        tPlan.mode = 'direct_points';
      }
      const note = '略写点已并入本段（避免仅为略写开独立 Body）';
      tPlan.diagnosis = tPlan.diagnosis
        ? `${tPlan.diagnosis}；${note}`
        : note;
    }
  }

  return keep.map((bp, i) => ({
    ...bp,
    id: `body-${i + 1}`,
    targetBody: `Body Paragraph ${i + 1}`,
  }));
}

/**
 * Soft hint for Planner/fallback bodyCount from retentionRole + ready points.
 * Not a hard lock for the LLM path — used for digests and degraded fallback.
 */
export function suggestPlannerBodyCount(
  payload: Step2PlannerPayload | null | undefined,
): 2 | 3 {
  const active = activePoints(payload).filter((p) => p.retentionRole !== 'dropped');
  const detailReady = active.filter(
    (p) => p.retentionRole === 'detail' && p.quality === 'ready',
  );
  const ready = active.filter((p) => p.quality === 'ready');
  const independent = detailReady.length > 0 ? detailReady : ready;
  return independent.length >= 3 ? 3 : 2;
}

/** One-line digest for Planner prompt (dynamic bodyCount signals). */
export function buildPlannerMaterialDigest(
  payload: Step2PlannerPayload | null | undefined,
): string {
  const active = activePoints(payload).filter((p) => p.retentionRole !== 'dropped');
  if (!active.length) return '无可用平行论点';
  const detail = active.filter((p) => p.retentionRole === 'detail');
  const brief = active.filter((p) => p.retentionRole === 'brief');
  const unmarked = active.filter((p) => !p.retentionRole);
  const ready = active.filter((p) => p.quality === 'ready');
  const hint = suggestPlannerBodyCount(payload);
  return [
    `槽位=${active.length}`,
    `详写=${detail.length}（${detail.map((p) => p.id).join(',') || '无'}）`,
    `略写=${brief.length}（${brief.map((p) => p.id).join(',') || '无'}）`,
    `未标详略=${unmarked.length}`,
    `ready=${ready.length}`,
    `软提示 bodyCount≈${hint}（LLM 仍须按材料独立判断；2详写+1略写通常为2）`,
  ].join('；');
}

/**
 * Pick points for fallback bodyPlans: prefer detail+ready, then ready.
 * Count follows suggestPlannerBodyCount (2 or 3). Brief points are not
 * primary picks (they may be merged onto the last body by caller).
 */
export function pickReadyPointsForFallback(
  payload: Step2PlannerPayload | null | undefined,
): Step2Point[] {
  const active = activePoints(payload).filter((p) => p.retentionRole !== 'dropped');
  const detailReady = active.filter(
    (p) => p.retentionRole === 'detail' && p.quality === 'ready',
  );
  const ready = active.filter((p) => p.quality === 'ready');
  const pool =
    detailReady.length > 0
      ? detailReady
      : ready.length
        ? ready
        : active.filter((p) => {
            const c = String(p.claim || '').trim();
            const minLen = /[\u4e00-\u9fff]/.test(c) ? 2 : CLAIM_MIN;
            return c.length >= minLen;
          });

  const target = suggestPlannerBodyCount(payload);
  const picked: Step2Point[] = [];
  const used = new Set<string>();
  const missingPreferred = payload?.coverage?.requiredBuckets || [];

  for (const bucket of missingPreferred) {
    const hit = pool.find(
      (p) => !used.has(p.id) && (p.leanTags || []).includes(bucket),
    );
    if (hit) {
      picked.push(hit);
      used.add(hit.id);
    }
    if (picked.length >= target) break;
  }

  for (const p of pool) {
    if (picked.length >= target) break;
    if (!used.has(p.id)) {
      picked.push(p);
      used.add(p.id);
    }
  }
  return picked.slice(0, target);
}

/** Brief points not already used as primary body anchors. */
export function leftoverBriefPoints(
  payload: Step2PlannerPayload | null | undefined,
  usedIds: Set<string>,
): Step2Point[] {
  return activePoints(payload).filter(
    (p) =>
      p.retentionRole === 'brief' &&
      !usedIds.has(p.id) &&
      String(p.claim || '').trim().length >= 2,
  );
}
