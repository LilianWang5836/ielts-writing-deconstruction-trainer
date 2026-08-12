/**
 * Step2 → Planner material contract.
 *
 * Single source of truth for parallel points + stance + coverage buckets.
 * Paragraph layout stays in Step 2.5 Planner.
 */

import type {
  CoverageBucket,
  Step2PendingCapacityTrim,
  Step2PendingSlotAdd,
  Step2PendingStanceConfirm,
  Step2Point,
  Step2PlannerPayload,
  Step2RetentionRole,
  Step2StancePolarity,
  Step2StanceStrength,
} from '../../types';
import { isClaimSentence } from '../../utils/step3ClaimPrefill';
import {
  classifyStep2StudentTurnHeuristic,
  intentFromStructuredDecision,
  intentIsMetaProcess,
  intentMayMountContent,
  intentMayProposeNewSlot,
  type Step2StudentTurnIntent,
} from './student-turn-intent';

/** Marker in userPoints while a new slot awaits confirm. */
export const PENDING_SLOT_ADD_MARKER_RE =
  /［待新增：claim=([^］]+)］/;

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

/** Side / question bucket used for checklist + single-side capacity trim. */
const SIDE_BUCKET_PRIORITY: CoverageBucket[] = [
  'part_1',
  'part_2',
  'view_a',
  'view_b',
  'advantage',
  'disadvantage',
  'cause',
  'solution',
  'positive',
  'negative',
  'support_main',
  'oppose_or_qualify',
];

const SIDE_BUCKET_LABELS: Partial<Record<CoverageBucket | string, string>> = {
  part_1: '第一问',
  part_2: '第二问',
  view_a: '观点A',
  view_b: '观点B',
  advantage: '优点/利',
  disadvantage: '缺点/弊',
  cause: '原因/成因',
  solution: '解决措施',
  positive: '积极面',
  negative: '消极面',
  support_main: '支持面',
  oppose_or_qualify: '让步/对立面',
  general: '同侧材料',
};

export type ChecklistWalkReason = 'thin' | 'needs_retention';

export type ChecklistWalkItem = {
  id: string;
  claim: string;
  reason: ChecklistWalkReason;
  sideKey: string;
};

type DimDispositionLike = {
  dimension?: string;
  disposition?: string;
  mergedInto?: string;
  side?: string;
};

/** Primary task-side key for a point (one question / one paragraph cluster). */
export function pointSideKey(p: Step2Point): string {
  const tags = Array.isArray(p.leanTags) ? p.leanTags : [];
  for (const b of SIDE_BUCKET_PRIORITY) {
    if (tags.includes(b)) return b;
  }
  const blob = `${p.claim || ''} ${p.fromDimension || ''}`;
  if (/（\s*原因|（\s*成因|（\s*问题/.test(blob) || /原因|成因/.test(blob)) {
    return 'part_1';
  }
  if (/（\s*评价|（\s*利弊|（\s*影响|（\s*解决/.test(blob)) {
    return 'part_2';
  }
  if (tags.includes('general')) return 'general';
  return 'general';
}

export function sideKeyLabel(sideKey: string): string {
  return SIDE_BUCKET_LABELS[sideKey] || sideKey || '同侧材料';
}

function findDispositionForPoint(
  p: Step2Point,
  dispositions: DimDispositionLike[] | undefined,
): DimDispositionLike | undefined {
  if (!Array.isArray(dispositions) || !dispositions.length) return undefined;
  const claim = String(p.claim || '').trim();
  const from = String(p.fromDimension || '').trim();
  return dispositions.find((d) => {
    const dim = String(d?.dimension || '').trim();
    if (!dim) return false;
    return (
      headsCompatible(dim, claim) ||
      headsCompatible(dim, from) ||
      dim.includes(claim.slice(0, 6)) ||
      claim.includes(dim.replace(/（[^）]*）/g, '').slice(0, 6))
    );
  });
}

/** Retention already locked, or dimension explicitly dropped/merged. */
export function isPointRetentionSettled(p: Step2Point): boolean {
  const r = p.retentionRole;
  return r === 'detail' || r === 'brief' || r === 'dropped';
}

/**
 * Checklist "走过": 详/略/放弃已确认, or dimension dropped/merged.
 * Content alone does not finish the walk — retention must be settled.
 *
 * NOTE: a 'merged' disposition alone does NOT walk a still-active slot —
 * merges must be committed via a slot_merge proposal (which supersedes the
 * point, caught above). Model-narrated merges without confirm stay unwalked.
 */
export function isPointWalked(
  p: Step2Point,
  dispositions?: DimDispositionLike[],
): boolean {
  if (!p || p.supersededBy) return true;
  if (p.retentionRole === 'dropped') return true;
  const d = findDispositionForPoint(p, dispositions);
  const disp = String(d?.disposition || '').trim();
  if (disp === 'dropped') return true;
  return isPointRetentionSettled(p);
}

/**
 * Walk/explore content gate: substantive body that is NOT merely a Step1 seed.
 * Legacy points without seedOnly are treated as already expanded.
 */
export function isPointExpandedForWalk(p: Step2Point | null | undefined): boolean {
  if (!p || p.supersededBy) return false;
  if (p.seedOnly === true) return false;
  return pointHasSubstantiveContent(p);
}

/** Active slots that still need content and/or 详略 confirmation. */
export function listUnwalkedChecklistPoints(
  payload: Step2PlannerPayload | null | undefined,
  dispositions?: DimDispositionLike[],
): ChecklistWalkItem[] {
  const pts = activePoints(payload).filter((p) => p.retentionRole !== 'dropped');
  const out: ChecklistWalkItem[] = [];
  for (const p of pts) {
    if (isPointWalked(p, dispositions)) continue;
    const hasContent = isPointExpandedForWalk(p);
    out.push({
      id: p.id,
      claim: p.claim,
      reason: hasContent ? 'needs_retention' : 'thin',
      sideKey: pointSideKey(p),
    });
  }
  return out;
}

/**
 * Explore complete only when every checklist slot is walked
 * (not merely when coverage buckets part_1+part_2 are filled).
 */
export function isStep2ChecklistWalkDone(
  payload: Step2PlannerPayload | null | undefined,
  dispositions?: DimDispositionLike[],
  options?: { exhausted?: boolean },
): boolean {
  if (!payload) return false;
  const unwalked = listUnwalkedChecklistPoints(payload, dispositions);
  if (unwalked.length > 0) return false;

  // Pending Step1 dispositions with no matching walked point still block.
  if (Array.isArray(dispositions) && dispositions.length > 0) {
    const pts = activePoints(payload);
    const pendingOpen = dispositions.some((d) => {
      if (String(d?.disposition || '').trim() !== 'pending') return false;
      const dim = String(d?.dimension || '').trim();
      if (!dim) return false;
      const match = pts.find(
        (p) =>
          headsCompatible(p.claim, dim) ||
          headsCompatible(String(p.fromDimension || ''), dim),
      );
      if (!match) return true;
      return !isPointWalked(match, dispositions);
    });
    if (pendingOpen) return false;
  }

  const active = activePoints(payload).filter((p) => p.retentionRole !== 'dropped');
  if (active.length >= 2) return true;
  if (options?.exhausted && active.length >= 1) return true;
  if ((payload.fixedClaims?.length || 0) >= 1 && active.length >= 1) {
    return listUnwalkedChecklistPoints(payload, dispositions).length === 0;
  }
  return false;
}

export type SidePointGroup = {
  sideKey: string;
  sideLabel: string;
  points: Step2Point[];
};

/** Group active (non-dropped) points by single-question / single-side bucket. */
export function groupPointsBySide(
  payload: Step2PlannerPayload | null | undefined,
): SidePointGroup[] {
  const map = new Map<string, Step2Point[]>();
  for (const p of activePoints(payload)) {
    if (p.retentionRole === 'dropped') continue;
    const key = pointSideKey(p);
    const list = map.get(key) || [];
    list.push(p);
    map.set(key, list);
  }
  return [...map.entries()].map(([sideKey, points]) => ({
    sideKey,
    sideLabel: sideKeyLabel(sideKey),
    points,
  }));
}

/** Board order of side keys (first appearance in active points). */
export function listSideWalkOrder(
  payload: Step2PlannerPayload | null | undefined,
): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const p of activePoints(payload)) {
    if (p.retentionRole === 'dropped') continue;
    const k = pointSideKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    order.push(k);
  }
  return order;
}

export function pointsOnSide(
  payload: Step2PlannerPayload | null | undefined,
  sideKey: string,
): Step2Point[] {
  return activePoints(payload).filter(
    (p) => p.retentionRole !== 'dropped' && pointSideKey(p) === sideKey,
  );
}

/** Every non-dropped point on this side has walk-ready content (or already walked). */
export function isSideContentComplete(
  payload: Step2PlannerPayload | null | undefined,
  sideKey: string,
  dispositions?: DimDispositionLike[],
): boolean {
  const pts = pointsOnSide(payload, sideKey);
  if (!pts.length) return true;
  return pts.every(
    (p) => isPointWalked(p, dispositions) || isPointExpandedForWalk(p),
  );
}

export function isSideRetentionComplete(
  payload: Step2PlannerPayload | null | undefined,
  sideKey: string,
  dispositions?: DimDispositionLike[],
): boolean {
  const pts = pointsOnSide(payload, sideKey);
  if (!pts.length) return true;
  return pts.every((p) => isPointWalked(p, dispositions));
}

export type SideWalkNext =
  | { kind: 'expand'; sideKey: string; point: Step2Point }
  | { kind: 'side_retention'; sideKey: string; points: Step2Point[] }
  | { kind: 'done' };

/**
 * Side-first checklist:
 * 1) Expand every thin slot on the current side
 * 2) When side content is full → one side-level 详略 recommend
 * 3) After retention settled → next side
 */
export function resolveNextSideWalkStep(
  payload: Step2PlannerPayload | null | undefined,
  dispositions?: DimDispositionLike[],
): SideWalkNext {
  for (const sideKey of listSideWalkOrder(payload)) {
    const pts = pointsOnSide(payload, sideKey);
    if (!pts.length) continue;

    const thin = pts.find(
      (p) => !isPointWalked(p, dispositions) && !isPointExpandedForWalk(p),
    );
    if (thin) return { kind: 'expand', sideKey, point: thin };

    if (!isSideRetentionComplete(payload, sideKey, dispositions)) {
      const forScheme = pts.filter(
        (p) => isPointExpandedForWalk(p) || isPointWalked(p, dispositions),
      );
      return {
        kind: 'side_retention',
        sideKey,
        points: forScheme.length ? forScheme : pts,
      };
    }
  }
  return { kind: 'done' };
}

/** Rank by cleaned elaboration length (richer → prefer 详写). */
export function rankPointsByContentVolume(points: Step2Point[]): Step2Point[] {
  return [...points].sort((a, b) => {
    const ea = cleanElaboration(String(a.elaboration || '')).length;
    const eb = cleanElaboration(String(b.elaboration || '')).length;
    return eb - ea;
  });
}

export function buildSideRetentionAsk(
  sideKey: string,
  points: Step2Point[],
): string {
  const sideLabel = sideKeyLabel(sideKey);
  const ranked = rankPointsByContentVolume(
    points.filter((p) => isPointExpandedForWalk(p) || isPointRetentionSettled(p)),
  );
  const usable = ranked.length ? ranked : points;
  const list = usable
    .map((p, i) => `${i + 1}. ${claimMatchCore(p.claim) || p.claim}`)
    .join('\n');

  if (usable.length <= 1) {
    const only = usable[0];
    const label = only
      ? claimMatchCore(only.claim) || only.claim
      : '这一条';
    return (
      `「${sideLabel}」这一侧目前可写材料是：\n${list || label}\n\n` +
      `建议将「${label}」作为**详写**。请点击下方「采纳」或「拒绝」；也可回复「详写」/「略写」/「都详写」。`
    );
  }

  const detail = usable[0];
  const briefs = usable.slice(1);
  const detailLabel = claimMatchCore(detail.claim) || detail.claim;
  const briefLabels = briefs
    .map((p) => `『${claimMatchCore(p.claim) || p.claim}』`)
    .join('、');
  // One step: 详略 + 篇幅裁剪（略写/丢掉）— never a separate capacity-trim ask after this.
  const trimHint =
    usable.length >= 3
      ? `略写即控制单段篇幅；若不想保留某条，也可回复「丢掉③」等。`
      : `若不想保留某条略写，也可直接说「丢掉×」。`;
  return (
    `「${sideLabel}」这一侧的材料都已展开。按各条信息量，建议：**详写**『${detailLabel}』` +
    (briefLabels ? `，**略写**${briefLabels}` : '') +
    `。${trimHint}\n\n${list}\n\n` +
    `请点击下方「采纳」或「拒绝」；也可直接回复「都详写」或「①详写，②略写」。`
  );
}

export function formatSideRetentionPendingMarker(
  _sideKey: string,
  points: Step2Point[],
): string {
  const ranked = rankPointsByContentVolume(
    points.filter((p) => isPointExpandedForWalk(p)),
  );
  const usable = ranked.length ? ranked : points;
  const detail = claimMatchCore(usable[0]?.claim || '') || usable[0]?.claim || '';
  const brief = usable
    .slice(1)
    .map((p) => claimMatchCore(p.claim) || p.claim)
    .filter(Boolean)
    .join('、');
  // KEEP_MINOR: side scheme is 详+略 by content volume. Older markers used
  // 默认=SIDE:… which parse treated as null → EXPAND_BOTH, so「采纳」never locked.
  return `［待裁决：详=${detail}｜略=${brief || '（无）'}｜默认=KEEP_MINOR］`;
}

/** Labels from a 详= / 略= marker field (split + drop placeholders). */
export function splitSideRetentionSchemeLabels(raw: string): string[] {
  return String(raw || '')
    .split(/[、，,｜|/]/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= 2 &&
        s !== '（无）' &&
        s !== '(无)' &&
        s !== '无' &&
        s !== '其余点',
    );
}

function labelMatchesRetentionPoint(label: string, p: Step2Point): boolean {
  const core = claimMatchCore(label) || String(label || '').trim();
  if (core.length < 2) return false;
  const claim = claimMatchCore(p.claim) || String(p.claim || '');
  const from = claimMatchCore(String(p.fromDimension || '')) || '';
  return (
    headsCompatible(core, claim) ||
    headsCompatible(core, from) ||
    claim.includes(core.slice(0, Math.min(6, core.length))) ||
    core.includes(claim.slice(0, Math.min(6, claim.length)))
  );
}

/**
 * After student accepts a side-level 详略 scheme: stamp detail/brief roles and
 * drop same-side leftovers not in the scheme (e.g. empty「网络」slot).
 */
export function settleSideRetentionAfterAccept(params: {
  points: Step2Point[];
  developed: string;
  uncovered: string;
}): { points: Step2Point[]; droppedClaims: string[]; sideKey: string | null } {
  const detailLabels = splitSideRetentionSchemeLabels(params.developed);
  const briefLabels = splitSideRetentionSchemeLabels(params.uncovered);
  if (!detailLabels.length && !briefLabels.length) {
    return { points: params.points, droppedClaims: [], sideKey: null };
  }

  let sideKey: string | null = null;
  const matched = new Set<string>();
  const stamped = params.points.map((p) => {
    if (!p || p.supersededBy) return p;
    if (detailLabels.some((l) => labelMatchesRetentionPoint(l, p))) {
      matched.add(p.id);
      sideKey = sideKey || pointSideKey(p);
      return { ...p, retentionRole: 'detail' as Step2RetentionRole };
    }
    if (briefLabels.some((l) => labelMatchesRetentionPoint(l, p))) {
      matched.add(p.id);
      sideKey = sideKey || pointSideKey(p);
      return { ...p, retentionRole: 'brief' as Step2RetentionRole };
    }
    return p;
  });

  const droppedClaims: string[] = [];
  if (!sideKey) {
    return { points: stamped, droppedClaims, sideKey: null };
  }

  const points = stamped.map((p) => {
    if (!p || p.supersededBy) return p;
    if (matched.has(p.id)) return p;
    if (pointSideKey(p) !== sideKey) return p;
    // Same-side slot omitted from scheme (usually thin/empty) → treat as abandoned.
    droppedClaims.push(p.claim);
    return { ...p, retentionRole: 'dropped' as Step2RetentionRole };
  });

  return { points, droppedClaims, sideKey };
}

/**
 * Parse coach 详略 scheme from Part2 text so verbal「可以」can lock without
 * re-emitting a different volume-based scheme.
 */
export function parseSideRetentionSchemeFromCoachText(
  text: string,
): { developed: string; uncovered: string } | null {
  const full = String(text || '');
  const part = coachMessageDecisionPart(full) || full;
  if (!part || !/详写/.test(part)) return null;

  const details: string[] = [];
  const briefs: string[] = [];
  for (const m of part.matchAll(/详写\s*[『「]([^』」]+)[』」]/g)) {
    const s = String(m[1] || '').trim();
    if (s.length >= 2) details.push(s);
  }
  for (const m of part.matchAll(/略写\s*[『「]([^』」]+)[』」]/g)) {
    const s = String(m[1] || '').trim();
    if (s.length >= 2) briefs.push(s);
  }

  // Numbered list (line-start only) +「详写①和②…③略写」
  if (!details.length) {
    const byNum = new Map<string, string>();
    const circMap: Record<string, number> = {
      '①': 1,
      '②': 2,
      '③': 3,
      '④': 4,
      '⑤': 5,
      '⑥': 6,
      '⑦': 7,
      '⑧': 8,
      '⑨': 9,
      '⑩': 10,
    };
    for (const m of full.matchAll(
      /(?:^|\n)\s*([①②③④⑤⑥⑦⑧⑨⑩])\s*([^\n]{2,60}?)(?=\n|$)/g,
    )) {
      const n = circMap[m[1]];
      const label = claimMatchCore(m[2]) || String(m[2] || '').trim();
      if (n && label.length >= 2) byNum.set(String(n), label);
    }
    for (const m of full.matchAll(
      /(?:^|\n)\s*([1-9])[.、．)]\s*([^\n]{2,60}?)(?=\n|$)/g,
    )) {
      const label = claimMatchCore(m[2]) || String(m[2] || '').trim();
      if (label.length >= 2) byNum.set(m[1], label);
    }
    if (byNum.size) {
      const toN = (s: string) =>
        circMap[s] || (/^[1-9]$/.test(s) ? Number(s) : 0);
      // 详写①和② / 详写①、②
      const detailChunk = part.match(
        /详写\s*([①②③④⑤⑥⑦⑧⑨⑩1-9](?:\s*[和与、,，]\s*[①②③④⑤⑥⑦⑧⑨⑩1-9])*)/,
      );
      if (detailChunk?.[1]) {
        for (const raw of detailChunk[1].match(/[①②③④⑤⑥⑦⑧⑨⑩1-9]/g) || []) {
          const label = byNum.get(String(toN(raw)));
          if (label) details.push(label);
        }
      }
      const briefChunk = part.match(
        /(?:将|把)\s*([①②③④⑤⑥⑦⑧⑨⑩1-9](?:\s*[和与、,，]\s*[①②③④⑤⑥⑦⑧⑨⑩1-9])*)\s*(?:[^。\n]{0,24})?(?:作为)?略写|略写\s*([①②③④⑤⑥⑦⑧⑨⑩1-9](?:\s*[和与、,，]\s*[①②③④⑤⑥⑦⑧⑨⑩1-9])*)/,
      );
      const briefRaw = briefChunk?.[1] || briefChunk?.[2] || '';
      for (const raw of briefRaw.match(/[①②③④⑤⑥⑦⑧⑨⑩1-9]/g) || []) {
        const label = byNum.get(String(toN(raw)));
        if (label) briefs.push(label);
      }
    }
  }

  if (!details.length) {
    const one = part.match(
      /建议将[「『]([^」』]{2,40})[」』].*详写|详写[「『]([^」』]{2,40})[」』]/,
    );
    const d = String(one?.[1] || one?.[2] || '').trim();
    if (d) details.push(d);
  }
  if (!details.length) return null;
  return {
    developed: [...new Set(details)].join('、'),
    uncovered: briefs.length ? [...new Set(briefs)].join('、') : '（无）',
  };
}

/** Coach jumped to the other side / 第二问 while current side unfinished. */
export function textLooksLikePrematureSideAdvance(text: string): boolean {
  const part = String(text || '');
  const p2 = part.includes('---')
    ? part.split('---').slice(1).join('---')
    : part;
  return (
    /进入第二问|接下来我们进入第二问|正式.*第二问|开始评价|评价这一问|利弊评估/.test(
      p2,
    ) ||
    (/积极的还是消极|是积极还是消极|好处或坏处|积极影响|消极影响/.test(p2) &&
      /第二问|接下来|结合这些|带来了什么/.test(p2))
  );
}

/**
 * First single side/question with ≥3 *developed* points (not whole-essay total).
 * Thin empty Step1 slots do not count — only ready / hung / retention-settled.
 * Skips sides the student already dismissed with 全部保留.
 */
export function findOverloadedSide(
  payload: Step2PlannerPayload | null | undefined,
  dismissedSides?: string[],
): SidePointGroup | null {
  const dismissed = new Set(
    (dismissedSides || payload?.capacityTrimDismissedSides || []).map((s) =>
      String(s || '').trim(),
    ),
  );
  const developed = (p: Step2Point) => {
    if (p.retentionRole === 'dropped') return false;
    const elab = String(p.elaboration || '').trim();
    return (
      p.quality === 'ready' ||
      elab.length >= 8 ||
      isPointRetentionSettled(p)
    );
  };
  const groups = groupPointsBySide(payload)
    .map((g) => ({
      ...g,
      points: g.points.filter(developed),
    }))
    .filter((g) => g.points.length >= 3);
  for (const g of groups) {
    if (dismissed.has(g.sideKey)) continue;
    return g;
  }
  return null;
}

export function buildCapacityTrimAsk(trim: Step2PendingCapacityTrim): string {
  const list = (trim.pointClaims || [])
    .map((c, i) => `${i + 1}. ${c}`)
    .join('\n');
  return (
    `「${trim.sideLabel}」这一问/这一侧已经有 ${trim.pointClaims.length} 个可写论点，单段篇幅容易挤。` +
    `请确认裁剪（不会自动改板）：丢掉其中一条、把其中一条定为略写，或全部保留。\n\n${list}`
  );
}

/**
 * Apply retention_choice intent onto board points.
 * 「详细写1」→ index 1 detail + other ready siblings brief when pairBriefOthers.
 */
export function applyRetentionChoiceFromIntent(
  points: Step2Point[],
  intent: Step2StudentTurnIntent,
  activePointId?: string,
): {
  points: Step2Point[];
  stamps: Array<{ claim: string; role: 'detail' | 'brief' | 'dropped' }>;
} {
  const stamps: Array<{ claim: string; role: 'detail' | 'brief' | 'dropped' }> =
    [];
  const ret = intent.retention;
  if (!ret) return { points, stamps };
  const active = points.filter((p) => !p.supersededBy);
  if (!active.length) return { points, stamps };

  const byIndex = (idx?: number) => {
    if (!idx || idx < 1 || idx > active.length) return undefined;
    return active[idx - 1];
  };
  const byActive =
    (activePointId &&
      active.find((p) => p.id === activePointId)) ||
    undefined;
  const byHint = intent.claimHint
    ? active.find(
        (p) =>
          claimMatchCore(p.claim) === claimMatchCore(intent.claimHint!) ||
          headsCompatible(claimMatchCore(p.claim), claimMatchCore(intent.claimHint!)),
      )
    : undefined;

  if (ret.role === 'both_detail') {
    const next = points.map((p) => {
      if (p.supersededBy) return p;
      const elab = String(p.elaboration || '').trim();
      if (p.quality !== 'ready' && elab.length < 8) return p;
      stamps.push({ claim: p.claim, role: 'detail' });
      return { ...p, retentionRole: 'detail' as Step2RetentionRole };
    });
    return { points: next, stamps };
  }

  let target =
    byIndex(ret.targetIndex) || byHint || byActive || active.find((p) => {
      const elab = String(p.elaboration || '').trim();
      return p.quality === 'ready' || elab.length >= 8;
    }) ||
    active[0];

  if (!target) return { points, stamps };

  const targetRole: Step2RetentionRole =
    ret.role === 'drop' ? 'dropped' : ret.role === 'brief' ? 'brief' : 'detail';
  const stampRole: 'detail' | 'brief' | 'dropped' =
    targetRole === 'dropped'
      ? 'dropped'
      : targetRole === 'brief'
        ? 'brief'
        : 'detail';

  // Only stamp the chosen point — never silently mark siblings 略写.
  // Other ready points stay needs_retention until the student chooses per side.
  const next = points.map((p) => {
    if (p.supersededBy) return p;
    if (p.id === target!.id) {
      stamps.push({ claim: p.claim, role: stampRole });
      return { ...p, retentionRole: targetRole };
    }
    return p;
  });
  return { points: next, stamps };
}

/** Stamp 已选略写 / 用户放弃 onto a claim chunk in userPoints. */
export function stampRetentionTagOnUserPoints(
  userPoints: string,
  claim: string,
  role: 'brief' | 'dropped' | 'detail',
): string {
  const head = String(claim || '').trim();
  if (head.length < 2) return String(userPoints || '');
  const tag =
    role === 'brief'
      ? '已选略写'
      : role === 'dropped'
        ? '用户放弃'
        : '已选详写';
  const base = String(userPoints || '').trim();
  const headRe = head.slice(0, Math.min(12, head.length)).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  const chunkRe = new RegExp(`([^；;\\n]*${headRe}[^；;\\n]*)`);
  const m = chunkRe.exec(base);
  if (!m) {
    return `${base}${base ? '；' : ''}${head}（${tag}）`;
  }
  const chunk = m[1];
  const cleaned = chunk
    .replace(/（\s*已选详写[^）]*）/g, '')
    .replace(/（\s*已选略写[^）]*）/g, '')
    .replace(/（\s*保留-略写\s*）/g, '')
    .replace(/（\s*用户放弃\s*）/g, '')
    .replace(/［待裁决：[^\］]*］/g, '')
    .trim();
  return base.replace(chunk, `${cleaned}（${tag}）`);
}

export function scorePointQuality(
  claim: string,
  elaboration: string,
): 'thin' | 'ready' {
  const c = String(claim || '').trim();
  const e = cleanElaboration(String(elaboration || ''));
  if (!c) return 'thin';
  // No real body → always thin (Step1 dimension labels must not look「可写」)
  if (!e || e.length < 4) return 'thin';
  const hasCjk = /[\u4e00-\u9fff]/.test(c);
  if (c.length < (hasCjk ? 2 : CLAIM_MIN)) return 'thin';
  if (e.length >= 12) return 'ready';
  // Short but real scene phrase on a valid claim
  if (e.length >= 4 && e !== c && claimMatchCore(e) !== claimMatchCore(c)) {
    return 'ready';
  }
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

/** Opposing side buckets — never accumulate both onto one frozen Step1 slot. */
const LEAN_TAG_MUTEX: CoverageBucket[][] = [
  ['part_1', 'part_2'],
  ['view_a', 'view_b'],
  ['advantage', 'disadvantage'],
  ['cause', 'solution'],
  ['positive', 'negative'],
  ['support_main', 'oppose_or_qualify'],
];

/** Merge leanTags without flipping the Step1 side bucket. */
export function freezeLeanTags(
  existing: CoverageBucket[] | undefined,
  incoming: CoverageBucket[] | undefined,
): CoverageBucket[] {
  const base = (existing || []).filter(isBucket);
  const add = (incoming || []).filter(isBucket);
  if (!base.length) {
    return dropRedundantGeneral([
      ...new Set(add.length ? add : (['general'] as CoverageBucket[])),
    ]);
  }
  const primary = SIDE_BUCKET_PRIORITY.find((b) => base.includes(b));
  const out = [...base];
  for (const t of add) {
    if (out.includes(t)) continue;
    if (primary && SIDE_BUCKET_PRIORITY.includes(t) && t !== primary) continue;
    const conflicts = LEAN_TAG_MUTEX.some(
      (group) =>
        group.includes(t) && group.some((g) => g !== t && out.includes(g)),
    );
    if (conflicts) continue;
    out.push(t);
  }
  return dropRedundantGeneral(out);
}

/** Once a real side bucket exists, drop leftover `general`. */
export function dropRedundantGeneral(tags: CoverageBucket[]): CoverageBucket[] {
  const cleaned = tags.filter(isBucket);
  if (cleaned.some((t) => t !== 'general' && SIDE_BUCKET_PRIORITY.includes(t))) {
    return cleaned.filter((t) => t !== 'general');
  }
  return [...new Set(cleaned)];
}

/** Infer side bucket from task-role paren on claim (原因/评价…). */
export function inferSideTagsFromClaim(claim: string): CoverageBucket[] {
  const blob = String(claim || '');
  if (/（\s*原因|（\s*成因|（\s*问题/.test(blob)) return ['part_1'];
  if (/（\s*评价|（\s*利弊|（\s*影响|（\s*解决/.test(blob)) return ['part_2'];
  if (/（\s*积极/.test(blob)) return ['positive'];
  if (/（\s*消极/.test(blob)) return ['negative'];
  return ['general'];
}

function inferTagsFromText(
  text: string,
  questionType: string,
  side: 'A' | 'B' | '',
): CoverageBucket[] {
  const fromSide = defaultTagsForSide(questionType, side);
  // Freeze by Step1 side — do not accumulate keyword buckets that flip sides.
  if (fromSide.length && fromSide[0] !== 'general') {
    return fromSide;
  }
  const t = String(text || '');
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
  // Full process markers first (never leave mangled ［；：详写］ in board text)
  t = t.replace(/［待裁决：[^\］]*］/g, '');
  t = t.replace(/［待新增：[^\］]*］/g, '');
  t = t.replace(/［[；;]\s*[:：]?[^\］]*］/g, '');
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

/** Strip leading list markers: ① / 1. / （1） / **bold** wrappers. */
export function stripListMarkerPrefix(text: string): string {
  let t = String(text || '').trim();
  // Markdown emphasis around a whole head
  t = t.replace(/^\*{1,2}([^*]+)\*{1,2}$/g, '$1').trim();
  // Bullet markers (board lines like "- 国际交流（评价）（…）")
  t = t.replace(/^[-–—•·*]\s*(?=[\u4e00-\u9fff「『（(])/u, '');
  t = t.replace(/^[-•*]\s+/, '');
  t = t.replace(
    /^(?:[①②③④⑤⑥⑦⑧⑨⑩⑫⑬⑭⑮]|[0-9]{1,2}|[一二三四五六七八九十])(?:[.、．)\]］]|[）)])\s*/u,
    '',
  );
  t = t.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/u, '');
  return t.trim();
}

/**
 * Core label for slot matching: drop list markers + task-role tags like（原因）.
 * Keeps Step1 process tags stripping via stripDimensionCore.
 */
export function claimMatchCore(text: string): string {
  let t = stripListMarkerPrefix(stripRetentionTags(String(text || '')));
  t = stripDimensionCore(t);
  t = t
    .replace(
      /[（(]\s*(原因|成因|评价|利弊|影响|解决|问题|主|次|详写|略写)\s*[）)]/g,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  // If still "head：body", keep head only for matching
  const colon = t.match(
    /^([\u4e00-\u9fffA-Za-z0-9·、]{2,28})\s*[：:]\s*[\s\S]+$/,
  );
  if (colon) return colon[1].trim();
  return t;
}

/**
 * Split a free-text point into claim head + elaboration.
 * Handles coach formats like:
 *   人际关系（主/详写）：追求GDP……
 *   环境保护（将额外财富用于……）
 *   社会文化服务：财富投入图书馆……
 *   ① 西方强势文化冲击：青年人偏爱……
 */
export function parseClaimElaboration(text: string): {
  claim: string;
  elaboration: string;
} {
  let raw = stripListMarkerPrefix(stripRetentionTags(String(text || '').trim()));
  if (!raw) return { claim: '', elaboration: '' };

  // "head（原因/评价/详写）：body" — task-role tag between head and colon
  const roleColon = raw.match(
    /^([\u4e00-\u9fffA-Za-z0-9·、]{2,28})\s*[（(]\s*(原因|成因|评价|利弊|影响|解决|问题|主|次|详写|略写|主\s*[／/]\s*详写|次\s*[／/]\s*略写)\s*[）)]\s*[：:]\s*([\s\S]+)$/,
  );
  if (roleColon) {
    return {
      claim: normalizeClaimLabel(roleColon[1]),
      elaboration: cleanElaboration(roleColon[3]),
    };
  }

  // "head（role）：body" or "head：body" after role tags stripped
  const colon = raw.match(
    /^([\u4e00-\u9fffA-Za-z0-9·、]{2,28})\s*[：:]\s*([\s\S]+)$/,
  );
  if (colon) {
    return {
      claim: normalizeClaimLabel(colon[1]),
      elaboration: cleanElaboration(colon[2]),
    };
  }

  // "head（group1）（group2）…tail" — parse balanced paren groups one by one.
  // Never let regex backtracking swallow「（评价）（待加深）；其他头（原因）」
  // from the first （ to the last ）as a single elaboration blob.
  const parenHead = raw.match(/^([\u4e00-\u9fffA-Za-z0-9·、]{2,28})(?=[（(])/);
  if (parenHead) {
    const head = parenHead[1];
    let rest = raw.slice(head.length);
    const contents: string[] = [];
    let sawGroup = false;
    // Take the next balanced （…） group at the head of rest (nesting allowed).
    const takeGroup = (s: string): { inner: string; len: number } | null => {
      const t = s.match(/^\s*/)?.[0].length || 0;
      if (s[t] !== '（' && s[t] !== '(') return null;
      let depth = 0;
      for (let i = t; i < s.length; i++) {
        const ch = s[i];
        if (ch === '（' || ch === '(') depth += 1;
        else if (ch === '）' || ch === ')') {
          depth -= 1;
          if (depth === 0) {
            return { inner: s.slice(t + 1, i), len: i + 1 };
          }
        }
      }
      return null; // unbalanced — leave to fallback branches
    };
    for (;;) {
      const m = takeGroup(rest);
      if (!m) break;
      sawGroup = true;
      const inner = m.inner.trim();
      const isRoleOnly = /^[主次]?[／/]?(?:详写|略写)?$/.test(inner);
      const isTaskRole =
        /^(?:原因|成因|评价|利弊|影响|解决|问题|可展开|空标签|质量待确认|已探测|已询退出)$/.test(
          inner,
        );
      if (!isRoleOnly && !isTaskRole && inner.length >= 4) {
        contents.push(inner);
      }
      rest = rest.slice(m.len);
    }
    if (sawGroup) {
      // Leftover tail: fold into this claim only when attached by ：/，or
      // nothing. A ；/。 separator marks a SIBLING claim — never swallow it
      // (upstream paren-aware chunking is responsible for splitting those).
      const isSiblingTail = /^[\s]*[。．；;]/.test(rest);
      const tail = isSiblingTail
        ? ''
        : cleanElaboration(rest.replace(/^[\s：:，,]+/, '').trim());
      if (tail && tail.length >= 4) contents.push(tail);
      return {
        claim: normalizeClaimLabel(head),
        elaboration: cleanElaboration(contents.join('；')),
      };
    }
  }

  const head = dimensionHead(raw);
  if (head && raw.length > head.length + 1) {
    // leftover after head (e.g. "人际关系 追求GDP…") — drop leading task-role tags
    let rest = cleanElaboration(raw.slice(head.length));
    rest = rest
      .replace(
        /^[（(]\s*(?:原因|成因|评价|利弊|影响|解决|问题|主|次|详写|略写)\s*[）)]\s*[：:]?\s*/,
        '',
      )
      .trim();
    rest = cleanElaboration(rest);
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

/** Near-duplicate elaborations (substring / bigram / char overlap). */
export function isNearDuplicateElaboration(a: string, b: string): boolean {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const big = jaccard(cjkBigramSet(x), cjkBigramSet(y));
  if (big >= 0.34) return true;
  // Char-set overlap catches paraphrases that reshuffle wording
  const cx = new Set(x.replace(/\s+/g, '').split('').filter((ch) => /[\u4e00-\u9fff]/.test(ch)));
  const cy = new Set(y.replace(/\s+/g, '').split('').filter((ch) => /[\u4e00-\u9fff]/.test(ch)));
  const charJ = jaccard(cx, cy);
  return charJ >= 0.55 && Math.min(x.length, y.length) >= 12;
}

/**
 * One confirmed body per slot: replace / keep-richer, never pile paraphrases.
 * mode=replace → latest student content wins when not empty.
 * mode=fill → only write when slot empty or incoming is clearly richer non-dup.
 */
export function setCanonicalElaboration(
  prev: Step2Point,
  incoming: string,
  mode: 'replace' | 'fill' = 'replace',
): void {
  const next = cleanElaboration(incoming);
  if (!next) return;
  if (
    next === prev.claim ||
    next === prev.fromDimension ||
    /^(?:原因|成因|评价|利弊|影响|解决|问题|积极|消极)$/.test(next)
  ) {
    return;
  }
  const cur = cleanElaboration(prev.elaboration || '');
  // A Step1 seed placeholder must never block real content (fill included).
  if (!cur || prev.seedOnly === true) {
    prev.elaboration = next;
    prev.quality = scorePointQuality(prev.claim, prev.elaboration || '');
    return;
  }
  if (isNearDuplicateElaboration(cur, next)) {
    prev.elaboration = next.length >= cur.length ? next : cur;
    prev.quality = scorePointQuality(prev.claim, prev.elaboration || '');
    return;
  }
  if (mode === 'fill') {
    // Model/userPoints paraphrase of an already-filled slot → ignore
    return;
  }
  // Student content update: keep a single canonical version (latest)
  prev.elaboration = next;
  prev.quality = scorePointQuality(prev.claim, prev.elaboration || '');
}

/** Clean elaboration: drop placeholders and duplicate punctuation. */
export function cleanElaboration(text: string): string {
  let t = stripRetentionTags(text);
  // Strip full process markers before any keyword replace (avoids ［；：详写］)
  t = t.replace(/［待裁决：[^\］]*］/g, '');
  t = t.replace(/［待新增：[^\］]*］/g, '');
  t = t.replace(/［[；;]\s*[:：]?[^\］]*］/g, '');
  // Board pollution: （待裁决）/（待裁决：详写） without fullwidth brackets
  t = t.replace(/（\s*待裁决[^）]*）/g, '');
  t = t.replace(/\(\s*待裁决[^)]*\)/g, '');
  t = t.replace(/待裁决[：:][^\s；;]*/g, '');
  // Standalone placeholders only — never touch inside already-stripped markers
  t = t.replace(/(^|[；;\s])(待定|待展开|待补例子)(?=[；;\s]|$)/g, '$1；');
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
  // Drop task-role / placeholder debris that used to fatten the board
  t = t
    .replace(
      /(?:^|[；;])\s*(?:原因|成因|评价|利弊|影响|积极|消极|正面|负面)\s*[，,、]?\s*(?:待展开|待定|待补例子)?(?=[；;]|$)/g,
      '；',
    )
    .replace(/^[；;，,\s]+|[；;，,\s]+$/g, '')
    .trim();
  if (!t || t === '待展开' || t === '待定' || t === '待补例子' || t === '待裁决') {
    return '';
  }
  // Dedupe near-identical / paraphrase segments (keep the longer one)
  const segs = t
    .split(/；|;/)
    .map((s) => s.trim())
    .filter(Boolean);
  const kept: string[] = [];
  for (const s of segs) {
    const idx = kept.findIndex((k) => isNearDuplicateElaboration(k, s));
    if (idx >= 0) {
      if (s.length > kept[idx].length) kept[idx] = s;
      continue;
    }
    kept.push(s);
  }
  return kept.join('；');
}

/**
 * Safety net against cross-slot contamination: drop elaboration segments that
 * carry ANOTHER frozen slot's label (e.g.「强势文化冲击（原因）」ending up inside
 * 文化多样性's elaboration after a bad parse). Only segments bearing the
 * label-with-tag signature (or equal to a bare head) are removed — mere
 * mentions of another dimension inside real content are kept.
 */
export function scrubCrossSlotContamination(
  elaboration: string,
  ownHead: string,
  allHeads: string[],
): string {
  const elab = String(elaboration || '').trim();
  if (!elab) return elab;
  const own = String(ownHead || '').trim();
  const others = (allHeads || [])
    .map((h) => stripRetentionTags(String(h || '')).trim())
    .map((h) => dimensionHead(h) || h)
    .filter(
      (h) =>
        h.length >= 2 &&
        h !== own &&
        !headsCompatible(h, own) &&
        !headsCompatible(own, h),
    );
  if (!others.length) return elab;
  const segs = elab.split(/[；;]/);
  const kept = segs.filter((seg) => {
    const s = seg.trim();
    if (!s) return false;
    // Placeholder debris with stray parens from legacy bad parses（待加深）
    if (/^[（(]?(?:待加深|待展开|待定|待裁决)[）)]?$/.test(s)) return false;
    return !others.some(
      (h) =>
        s === h ||
        s.startsWith(`${h}（`) ||
        s.startsWith(`${h}(`) ||
        s.includes(`；${h}（`) ||
        s.includes(`${h}（原因）`) ||
        s.includes(`${h}（评价）`),
    );
  });
  const next = kept.join('；').trim();
  return next === elab ? elab : cleanElaboration(next);
}

/**
 * True when the point has real argument body (not claim-echo / 待裁决 junk).
 * Used by checklist walk — do not trust quality=ready alone if elab is empty after clean.
 */
export function pointHasSubstantiveContent(p: Step2Point): boolean {
  if (!p || p.supersededBy) return false;
  const elab = cleanElaboration(String(p.elaboration || ''));
  if (!elab) return false;
  const core = claimMatchCore(p.claim) || normalizeClaimLabel(p.claim);
  if (core && (elab === core || claimMatchCore(elab) === core)) return false;
  // Elaboration is only the label with trivial leftovers
  const withoutClaim = elab
    .split(core || '___')
    .join('')
    .replace(/[（）()\s；;，,：:]/g, '');
  if (core && withoutClaim.length < 2 && elab.length <= core.length + 8) {
    return false;
  }
  // Real body: long enough, or marked ready with a short but real scene phrase
  if (elab.length >= 8) return true;
  if (p.quality === 'ready' && elab.length >= 4) return true;
  return false;
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

/**
 * Split on ；/; and newlines that sit OUTSIDE （）() nesting.
 * A packed line like「文化多样性（评价）（待加深）；强势文化冲击（原因）」
 * splits at the outer ；, while「例子（促销；打折）」stays whole.
 */
export function splitOutsideParens(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  for (const ch of String(text || '')) {
    if (ch === '（' || ch === '(') depth += 1;
    else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === '\n' || ((ch === '；' || ch === ';') && depth === 0)) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
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

  // Split on numbered / circled markers even when glued after 。/；
  // (e.g. "…幸福感。2. 稳定收入…" / "…过时\n② 数字化…")
  const byNumber = withoutHeaders.split(
    /(?:^|[；;\n。．])\s*(?:[①②③④⑤⑥⑦⑧⑨⑩]|[0-9]{1,2})[.、．)\]]?\s*/u,
  );
  // Paren-aware secondary split: number-split chunks may still pack multiple
  // 「head（…）」groups on one line joined by ；(outside parens).
  let parts = (byNumber.length > 1 ? byNumber : [withoutHeaders]).flatMap(
    (p) => splitOutsideParens(String(p || '')),
  );

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
      // Keep full "head：body" chunks for parseClaimElaboration; strip list markers
      const cleaned = stripListMarkerPrefix(String(p || ''));
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
    prev.leanTags = freezeLeanTags(prev.leanTags, p.leanTags);
    prev.quality = scorePointQuality(prev.claim, prev.elaboration || '');
    p.supersededBy = prev.id;
    redirects[p.id] = prev.id;
  }

  const allHeads = points
    .filter((p) => !p.supersededBy)
    .map((p) => dimensionHead(p.claim) || p.claim);
  for (const p of points) {
    if (p.supersededBy) continue;
    p.claim = normalizeClaimLabel(p.claim);
    p.elaboration = cleanElaboration(p.elaboration || '');
    // Drop elaboration that is just a shorter alias of claim
    if (p.elaboration === p.claim) p.elaboration = '';
    p.elaboration = scrubCrossSlotContamination(
      p.elaboration,
      dimensionHead(p.claim) || p.claim,
      allHeads,
    );
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

function appendElaboration(
  prev: Step2Point,
  chunks: string[],
  mode: 'replace' | 'fill' = 'fill',
): void {
  const add = chunks
    .map((x) => cleanElaboration(String(x || '')))
    .filter(
      (x) =>
        x &&
        x !== prev.claim &&
        x !== prev.fromDimension &&
        !/^(?:原因|成因|评价|利弊|影响|解决|问题|积极|消极)$/.test(x),
    );
  if (!add.length) return;
  // Prefer the richest single chunk — never concatenate paraphrases
  const incoming = add.sort((a, b) => b.length - a.length)[0];
  setCanonicalElaboration(prev, incoming, mode);
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
    const n = claimMatchCore(needle) || normalizeClaimLabel(needle);
    if (n.length < 2) return;
    // Exact / compatible head (ignore （原因）/ list markers)
    for (const p of active) {
      if (used.has(p.id)) continue;
      const head = claimMatchCore(
        String(p.fromDimension || p.claim || '').trim(),
      );
      const claimCore = claimMatchCore(p.claim);
      if (
        head === n ||
        claimCore === n ||
        headsCompatible(head, n) ||
        headsCompatible(claimCore, n)
      ) {
        matched.push(p);
        used.add(p.id);
      }
    }
    // Substring either way (人际关系 ⊂ 人际关系损害；环保 ⊂ 复合标签)
    for (const p of active) {
      if (used.has(p.id)) continue;
      const head = claimMatchCore(
        String(p.fromDimension || p.claim || '').trim(),
      );
      const claimCore = claimMatchCore(p.claim);
      const rawCore = claimMatchCore(raw) || raw;
      if (
        head.length >= 2 &&
        (n.includes(head) ||
          head.includes(n) ||
          rawCore.includes(head) ||
          raw.includes(head) ||
          raw.includes(claimCore))
      ) {
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
    const head = claimMatchCore(p.claim);
    if (head.length >= 2 && (raw.includes(head) || claimMatchCore(raw).includes(head))) {
      matched.push(p);
      used.add(p.id);
    }
  }
  return matched;
}

/**
 * Theme families for soft semantic routing (student wording ≠ frozen Step1 label).
 * Keep groups tight — bare stems like「全球化」alone are too broad.
 */
const SEMANTIC_THEME_GROUPS: string[][] = [
  [
    '文化全球化',
    '强势文化',
    '文化冲击',
    '文化输入',
    '外来文化',
    '流行文化',
    '西方文化',
  ],
  [
    '文化认同',
    '身份认同',
    '文化多样性',
    '文化流失',
    '传统文化',
    '本土文化',
  ],
  [
    '互联网普及',
    '互联网',
    '网络普及',
    '技术与网络',
    '数字网络',
    '数字化',
    '数字普及',
    '网络和数字',
    '数字媒体',
    '社交媒体',
    '线上传播',
    '网络传播',
    '传播速度',
    '触达',
  ],
  [
    '消费主义',
    '商业化',
    '消费与品牌',
    '品牌全球化',
    '商业广告',
    '市场份额',
    '消费品牌',
  ],
  [
    '跨国交流',
    '跨境交流',
    '国际交流',
    '交流效率',
    '沟通便利',
    '跨境便利',
    '跨国合作',
    '国际合作',
    '跨境合作',
    '合作便利',
    '交流便利',
    '国际交流便利',
  ],
  [
    '经济效益',
    '商业效益',
    '经济与商业',
    '就业机会',
    '旅游收益',
  ],
];

function themeGroupBoost(blob: string, claim: string): number {
  const text = String(blob || '');
  const head = claimMatchCore(claim) || String(claim || '');
  if (!text || !head) return 0;
  let best = 0;
  for (const group of SEMANTIC_THEME_GROUPS) {
    const textHits = group.filter((g) => g.length >= 2 && text.includes(g));
    const claimHits = group.filter(
      (g) =>
        g.length >= 2 &&
        (head.includes(g) || g.includes(head) || headsCompatible(head, g)),
    );
    if (textHits.length && claimHits.length) {
      best = Math.max(best, 0.52 + 0.08 * Math.min(textHits.length, 3));
    }
  }
  return best;
}

function cjkBigramSet(text: string): Set<string> {
  const t = String(text || '').replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) {
    const a = t[i];
    const b = t[i + 1];
    if (/[\u4e00-\u9fff]/.test(a) && /[\u4e00-\u9fff]/.test(b)) {
      out.add(a + b);
    }
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Soft semantic score in [0, 1] between free text and a frozen slot.
 * Prefer theme families + CJK bigram overlap over brittle substring equality.
 */
export function scoreSemanticSlotMatch(
  text: string,
  slot: Step2Point,
): number {
  const blob = stripRetentionTags(String(text || '')).trim();
  const claim = String(slot?.claim || slot?.fromDimension || '').trim();
  if (blob.length < 2 || claim.length < 2) return 0;

  if (
    blob === claim ||
    headsCompatible(blob, claim) ||
    blob.includes(claim) ||
    claim.includes(normalizeClaimLabel(blob))
  ) {
    return 1;
  }

  const elab = String(slot.elaboration || '').trim();
  const slotBlob = `${claim} ${elab}`.trim();
  const bigram = jaccard(cjkBigramSet(blob), cjkBigramSet(slotBlob));
  const theme = themeGroupBoost(blob, claim);
  // Shared 2-char stem alone is weak; only nudge when theme also fires.
  const sharedStem =
    claim.length >= 2 && blob.includes(claim.slice(0, 2)) && theme > 0
      ? 0.12
      : 0;
  return Math.min(1, Math.max(theme, bigram * 0.9 + sharedStem, bigram));
}

/**
 * Best semantic slot when string match misses.
 * Requires clear winner (threshold + margin) to avoid dumping onto a wrong point.
 */
export function findBestSemanticSlot(
  points: Step2Point[],
  text: string,
): Step2Point | null {
  const active = points.filter((p) => !p.supersededBy);
  const blob = String(text || '').trim();
  if (!active.length || blob.length < 2) return null;

  const scored = active
    .map((p) => ({ p, score: scoreSemanticSlotMatch(blob, p) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1];
  if (!top || top.score < 0.45) return null;
  if (second && top.score - second.score < 0.08 && top.score < 0.72) {
    return null;
  }
  return top.p;
}

/**
 * Process / stage advance OR coaching scaffold — no new material to lock.
 * Structural: question stems, A-or-B task lines, and elaboration-probe labels
 * (渠道/场景/机制…) that are deepen asks, not parallel argument topics.
 */
export function isProcessAdvanceProposal(
  claim: string,
  coachText?: string,
): boolean {
  const raw = String(claim || '').trim();
  const core = claimMatchCore(raw) || raw;
  if (!core) return true;

  // Essay-task / stage questions are not parallel argument slots
  if (/[？?]/.test(raw) || /[？?]/.test(core)) return true;
  if (
    /还是/.test(core) &&
    /(积极|消极|利|弊|正面|负面|同意|反对)/.test(core)
  ) {
    return true;
  }

  // Elaboration scaffold — "how to fill a slot", not a new topic claim
  if (isElaborationScaffoldLabel(core)) return true;

  // Task / side role labels (原因/成因/评价…) — never new parallel slots
  if (isTaskRoleLabel(core)) return true;

  const ctx = coachMessageDecisionPart(String(coachText || ''));
  if (
    ctx &&
    /正式开始|第二问|第一问|接下来|开始为|积累材料|利弊评估|评价侧|原因分析|欢迎来到第二步|逐一充实/.test(
      ctx,
    ) &&
    /加入材料池|新的平行论点/.test(ctx) &&
    (isElaborationScaffoldLabel(core) ||
      isTaskRoleLabel(core) ||
      (core.length >= 8 && /(发展|评估|分析|现象|这一|这种)/.test(core)))
  ) {
    return true;
  }
  return false;
}

/**
 * True when the label is only a deepen probe (渠道/场景/机制…),
 * with no domain topic left after stripping scaffold words.
 */
export function isElaborationScaffoldLabel(claim: string): boolean {
  const t = String(claim || '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .trim();
  if (!t) return true;
  if (
    /^(具体)?(渠道|场景|机制|例子|例证|受影响对象|目标群体|受益对象|展开|论据|材料)([或／/与和、](具体)?(渠道|场景|机制|例子|例证|受影响对象|目标群体|受益对象|展开|论据|材料))*$/.test(
      t,
    )
  ) {
    return true;
  }
  const stripped = t
    .replace(
      /具体|渠道|场景|机制|例子|例证|受影响对象|目标群体|受益对象|展开方式|如何展开|或|与|和|、|／|\//g,
      '',
    )
    .trim();
  // e.g. 「具体渠道或场景」→ empty after strip
  if (stripped.length < 2) {
    return /渠道|场景|机制|例子|例证|受影响|目标群体|受益/.test(t);
  }
  return false;
}

/**
 * Essay-task / coverage-side labels — not material-pool argument topics.
 * e.g. 「原因/成因」「评价」「利弊」must never become pendingSlotAdd.
 */
export function isTaskRoleLabel(claim: string): boolean {
  const t = String(claim || '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (!t) return true;
  if (
    /^(原因|成因|评价|利弊|影响|解决|措施|问题|积极|消极|正面|负面|第一问|第二问|原因分析|利弊评估|评价侧|支持面|对立面|让步)([／/与和、或](原因|成因|评价|利弊|影响|解决|措施|问题|积极|消极|正面|负面|第一问|第二问|原因分析|利弊评估))?$/.test(
      t,
    )
  ) {
    return true;
  }
  // Bare task compounds like 原因/成因
  if (/^(原因|成因)[／/](原因|成因)$/.test(t)) return true;
  if (/^(积极|消极|正面|负面)[／/与和](积极|消极|正面|负面|发展)$/.test(t)) {
    return true;
  }
  return false;
}

export type ProposedClaimResolution =
  | { kind: 'process_advance' }
  | { kind: 'same_slot'; point: Step2Point }
  | { kind: 'new_parallel'; claim: string };

/**
 * Classify a coach-proposed 「claim」 against the frozen board:
 * - process_advance: stage/task push with no new material → no 采纳
 * - same_slot: near-synonym / same theme → deepen existing slot, no new row
 * - new_parallel: truly off-board angle → pendingSlotAdd confirm
 */
export function resolveProposedClaimAgainstBoard(
  points: Step2Point[] | undefined,
  claim: string,
  coachText?: string,
): ProposedClaimResolution {
  const raw = String(claim || '').trim();
  const core = claimMatchCore(raw) || normalizeClaimLabel(raw) || raw;
  if (!core || core.length < 2) return { kind: 'process_advance' };

  if (isProcessAdvanceProposal(raw, coachText)) {
    return { kind: 'process_advance' };
  }

  const active = (points || []).filter((p) => p && !p.supersededBy);
  if (!active.length) return { kind: 'new_parallel', claim: core };

  const byId =
    findPointIdByClaim(active, core) || findPointIdByClaim(active, raw);
  if (byId) {
    const hit = active.find((p) => p.id === byId);
    if (hit) return { kind: 'same_slot', point: hit };
  }

  const sem =
    findBestSemanticSlot(active, core) || findBestSemanticSlot(active, raw);
  if (sem) return { kind: 'same_slot', point: sem };

  return { kind: 'new_parallel', claim: core };
}

/** Content ask when a near-synonym was remapped onto an existing frozen slot. */
export function buildSameSlotDeepenAsk(point: Step2Point): string {
  const label = String(point.claim || '').trim() || '这条材料';
  return (
    `「${label}」与刚才提到的角度同属一条材料，不新开槽。` +
    `请补 1–2 句具体场景、机制或受影响对象，方便写成可展开的论据。`
  );
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
      leanTags: inferSideTagsFromClaim(claim),
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
        dest.leanTags = freezeLeanTags(dest.leanTags, old.leanTags);
      }
      // Preserve seed provenance across slot migration.
      if (old.seedOnly === true && dest.seedOnly !== false) {
        dest.seedOnly = true;
      } else if (old.seedOnly === false) {
        dest.seedOnly = false;
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
 * Mount order: string match → semantic best slot → fallbackPointId (current focus) →
 * onUnmatched callback (preserve text; never silent-drop substantive content).
 */
export function upsertPointsFromClaims(
  existing: Step2Point[],
  claims: Array<{
    claim: string;
    elaboration?: string;
    leanTags?: CoverageBucket[];
    fromDimension?: string;
  }>,
  opts?: {
    allowCreate?: boolean;
    /** Current discussion slot — used when string+semantic both miss. */
    fallbackPointId?: string;
    /**
     * Kickoff / system / meta rewrite: elaboration is Step1 seed context,
     * not a Step2 student expansion. Marks seedOnly on write.
     */
    seedContext?: boolean;
    /** Preserve unmatched substantive text (e.g. pendingSlotAdd). */
    onUnmatched?: (orphan: {
      claim: string;
      elaboration: string;
    }) => void;
  },
): Step2Point[] {
  const allowCreate = opts?.allowCreate !== false;
  const seedContext = opts?.seedContext === true;
  const points = existing.map((p) => ({ ...p, leanTags: [...(p.leanTags || [])] }));
  const locked = !allowCreate && points.some((p) => !p.supersededBy);
  const fallbackId = String(opts?.fallbackPointId || '').trim();

  const applySeedFlag = (
    prev: Step2Point,
    beforeElab: string,
    afterElab: string,
  ) => {
    if (beforeElab === afterElab) return;
    if (seedContext) {
      // Seed rewrite may only mark empty / already-seed slots — never re-seed
      // a slot the student already expanded (seedOnly === false).
      if (prev.seedOnly === false) return;
      if (afterElab) prev.seedOnly = true;
      return;
    }
    // Student-content turn: clear only on genuine new body (not near-dup length tweak).
    if (
      !beforeElab ||
      !isNearDuplicateElaboration(beforeElab, afterElab)
    ) {
      prev.seedOnly = false;
    }
  };

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

    // Semantic when string match misses (e.g. 强势文化 → 文化全球化)
    if (!targets.length) {
      const sem =
        findBestSemanticSlot(points, matchText) ||
        (elab ? findBestSemanticSlot(points, elab) : null) ||
        findBestSemanticSlot(points, rawClaim);
      if (sem) targets = [sem];
    }

    // Current-slot fallback — do not drop
    if (!targets.length && fallbackId) {
      const fb = points.find((p) => p.id === fallbackId && !p.supersededBy);
      if (fb) targets = [fb];
    }

    if (targets.length) {
      const extraAsElab =
        !targets.some(
          (t) => t.claim === rawClaim || headsCompatible(t.claim, rawClaim),
        ) && rawClaim.length >= 4
          ? rawClaim
          : '';
      for (const prev of targets) {
        const beforeElab = cleanElaboration(prev.elaboration || '');
        // Locked slots: never rename claim — only hang elaboration
        appendElaboration(prev, [elab, extraAsElab]);
        if (tags.length) {
          prev.leanTags = freezeLeanTags(prev.leanTags, tags);
        }
        prev.quality = scorePointQuality(prev.claim, prev.elaboration || '');
        applySeedFlag(
          prev,
          beforeElab,
          cleanElaboration(prev.elaboration || ''),
        );
      }
      continue;
    }

    if (locked || !allowCreate) {
      const blob = cleanElaboration([elab, rawClaim].filter(Boolean).join('；'));
      if (
        blob.length >= 4 &&
        isSubstantiveBrainstormContent(blob) &&
        typeof opts?.onUnmatched === 'function'
      ) {
        opts.onUnmatched({ claim: rawClaim, elaboration: elab });
      }
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
      ...(elab
        ? seedContext
          ? { seedOnly: true }
          : { seedOnly: false }
        : {}),
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
 * Infer 详写/略写 role for a claim from free-text userPoints.
 * Only locked tags（已选详写/已选略写/用户放弃）count — never coach「建议详写」copy.
 */
export function inferRetentionRoleFromText(
  claim: string,
  corpus: string,
): Step2RetentionRole | undefined {
  const head = String(claim || '').trim();
  if (head.length < 2 || !corpus) return undefined;
  const text = String(corpus);
  if (/［待裁决：/.test(text) && !/已选详写|已选略写|用户放弃/.test(text)) {
    return undefined;
  }

  // Only chunks that mention this claim / compatible head may carry its tag.
  // A corpus that never mentions the claim must NOT leak sibling tags onto it
  // (e.g. model rewrote userPoints with A面 only → B面 slots stay untagged).
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
      (/[①②③④⑤⑥\d]/.test(c) &&
        bareHead.length >= 3 &&
        head.includes(bareHead.slice(0, 3)))
    );
  });
  if (!relevant.length) return undefined;
  const scan = relevant.join('；');

  // Local window around the claim mention
  const idx = scan.indexOf(head);
  const window =
    idx >= 0
      ? scan.slice(Math.max(0, idx - 4), idx + head.length + 24)
      : scan;

  if (/用户放弃/.test(window) || /（\s*用户放弃\s*）/.test(window)) {
    return 'dropped';
  }
  if (/已选详写/.test(window)) return 'detail';
  if (/已选略写|保留-略写/.test(window)) return 'brief';
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

export type LockedRetentionRole = 'detail' | 'brief' | 'dropped';

/** True when the student is explicitly changing 详写/略写 (not system rewrite). */
export function userMessageRequestsRetentionChange(msg: string): boolean {
  const t = String(msg || '').trim();
  if (!t) return false;
  return (
    /都写|都要|都展开|两个都|全都|都详|都补充|都详细/i.test(t) ||
    /改成详写|改为详写|改详写|改成略写|改为略写|改略写|不要详写|改成不写|改为不写/i.test(
      t,
    ) ||
    /详写|略写|放弃|不写了|只写/.test(t)
  );
}

type RetentionLock = { head: string; role: LockedRetentionRole; tag: string };

/** Extract confirmed retention locks from userPoints chunks. */
export function extractRetentionLocksFromUserPoints(
  userPoints: string,
): RetentionLock[] {
  const chunks = String(userPoints || '')
    .split(/[；;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const locks: RetentionLock[] = [];
  for (const chunk of chunks) {
    let role: LockedRetentionRole | null = null;
    let tag = '';
    if (/（\s*用户放弃\s*）/.test(chunk) || /用户放弃/.test(chunk)) {
      role = 'dropped';
      tag = '用户放弃';
    } else if (/已选详写/.test(chunk)) {
      role = 'detail';
      tag = '已选详写';
    } else if (/已选略写|保留-略写/.test(chunk)) {
      role = 'brief';
      tag = /已选略写（待补一句）/.test(chunk)
        ? '已选略写（待补一句）'
        : '已选略写';
    }
    if (!role) continue;
    const head = chunk
      .replace(/^[AB]面[^：:]*[：:]/g, '')
      .replace(/（\s*已选详写[^）]*）/g, '')
      .replace(/（\s*已选略写[^）]*）/g, '')
      .replace(/（\s*保留-略写\s*）/g, '')
      .replace(/（\s*用户放弃\s*）/g, '')
      .replace(/［待裁决：[^\］]*］/g, '')
      .trim();
    const key = head.slice(0, Math.min(12, head.length));
    if (key.length < 2) continue;
    locks.push({ head: key, role, tag });
  }
  return locks;
}

/**
 * Anti-forgery for the locked-retention vocabulary（已选详写/已选略写/用户放弃/
 * 保留-略写）: these tags are stamped ONLY by the server after a confirmed
 * decision. A fresh model rewrite of userPoints may not mint new locks — any
 * lock in `next` without a matching (head, role) lock in `prev` is stripped
 * (tag text only; the chunk's body is kept). Legit server stamps happen after
 * this gate in the pipeline and enter `prev` by the next turn.
 */
export function stripForgedRetentionLocks(
  prevUserPoints: string,
  nextUserPoints: string,
): string {
  const next = String(nextUserPoints || '');
  if (!next.trim()) return next;
  if (!/已选详写|已选略写|保留-略写|用户放弃/.test(next)) return next;
  const allowed = extractRetentionLocksFromUserPoints(prevUserPoints || '');
  const headKey = (chunk: string) =>
    chunk
      .replace(/^[AB]面[^：:]*[：:]/g, '')
      .replace(/（\s*已选详写[^）]*）/g, '')
      .replace(/（\s*已选略写[^）]*）/g, '')
      .replace(/（\s*保留-略写\s*）/g, '')
      .replace(/（\s*用户放弃\s*）/g, '')
      .replace(/［待裁决：[^\］]*］/g, '')
      .trim();
  const isAllowed = (chunk: string, role: LockedRetentionRole) => {
    const head = headKey(chunk);
    const key = head.slice(0, Math.min(12, head.length));
    if (key.length < 2) return false;
    return allowed.some(
      (l) =>
        l.role === role &&
        (l.head === key ||
          headsCompatible(l.head, key) ||
          key.startsWith(l.head.slice(0, Math.min(4, l.head.length))) ||
          l.head.startsWith(key.slice(0, Math.min(4, key.length)))),
    );
  };
  // Rebuild chunk-wise (keep delimiters) so only forged tags are removed.
  const parts = next.split(/([；;\n]+)/);
  const out = parts.map((seg) => {
    if (!seg || /^[；;\n]+$/.test(seg)) return seg;
    const role: LockedRetentionRole | null = /用户放弃/.test(seg)
      ? 'dropped'
      : /已选详写/.test(seg)
        ? 'detail'
        : /已选略写|保留-略写/.test(seg)
          ? 'brief'
          : null;
    if (!role || isAllowed(seg, role)) return seg;
    return seg
      .replace(/（\s*已选详写[^）]*）/g, '')
      .replace(/（\s*已选略写[^）]*）/g, '')
      .replace(/（\s*保留-略写\s*）/g, '')
      .replace(/（\s*用户放弃\s*）/g, '')
      .replace(/已选详写|已选略写|保留-略写|用户放弃/g, '');
  });
  const joined = out.join('');
  if (joined !== next) {
    console.warn(
      '[Step2RetentionLock] Stripped model-forged retention lock tags',
    );
  }
  return joined;
}

/**
 * After user confirmed 详写/略写, keep those tags across model rewrites of userPoints.
 * Only allow changes when the student explicitly requests a retention change.
 */
export function preserveLockedRetentionInUserPoints(
  previousUserPoints: string,
  nextUserPoints: string,
  options?: { allowUserChange?: boolean },
): string {
  const prev = String(previousUserPoints || '').trim();
  const next = String(nextUserPoints || '').trim();
  if (!prev) return next;
  if (!next) return prev;
  if (options?.allowUserChange) return next;

  const locks = extractRetentionLocksFromUserPoints(prev);
  if (!locks.length) return next;

  let out = next.replace(/［待裁决：[^\］]*］/g, '').trim();
  for (const lock of locks) {
    const headRe = lock.head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const chunkRe = new RegExp(`([^；;\\n]*${headRe}[^；;\\n]*)`);
    const m = chunkRe.exec(out);
    if (!m) {
      // Model dropped the chunk — append a locked stub so the board keeps the tag.
      out = `${out}；${lock.head}（${lock.tag}）`.replace(/^；/, '');
      continue;
    }
    const chunk = m[1];
    const hasSame =
      (lock.role === 'detail' && /已选详写/.test(chunk)) ||
      (lock.role === 'brief' && /已选略写|保留-略写/.test(chunk)) ||
      (lock.role === 'dropped' && /用户放弃/.test(chunk));
    if (hasSame) continue;
    const cleaned = chunk
      .replace(/（\s*已选详写[^）]*）/g, '')
      .replace(/（\s*已选略写[^）]*）/g, '')
      .replace(/（\s*保留-略写\s*）/g, '')
      .replace(/（\s*用户放弃\s*）/g, '')
      .replace(/（\s*待展开详写\s*）/g, '')
      .replace(/（\s*已展开，作为主论点\s*）/g, '')
      .trim();
    out = out.replace(chunk, `${cleaned}（${lock.tag}）`);
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** Substantive brainstorm content (not filler / bare ack). */
export function isSubstantiveBrainstormContent(msg: string): boolean {
  const t = String(msg || '').trim();
  if (!t || t.length < 8) return false;
  if (isStep2SystemOrKickoffMessage(t)) return false;
  if (
    /^(好的?|好|可以|行|嗯+|哦|噢|对|是|继续|没有了?|想不到|先这样|就这样|同意|确认|ok|okay|yes)[。.!！？?\s]*$/i.test(
      t,
    )
  ) {
    return false;
  }
  if (
    /^(你觉得呢?|你定|你来定|老师定|你看着办|随便你|听你的)[。.!！？?\s]*$/i.test(
      t,
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Hidden Step2 opener / coach-instruction text — never mount onto the board.
 * Only student-confirmed material may hang on frozen slots.
 */
export function isStep2SystemOrKickoffMessage(msg: string): boolean {
  const t = String(msg || '').trim();
  if (!t) return false;
  return (
    /这是第二步的开场/.test(t) ||
    /我还没有说任何话/.test(t) ||
    /请不要假装在回应我说过的内容/.test(t) ||
    /直接进入\s*Explore-?[Aa]/.test(t) ||
    (/FORBIDDEN/.test(t) &&
      /禁止再问|禁止再确认题型|清单式问题/.test(t)) ||
    /给我一个高质量、有针对性的发散问题/.test(t)
  );
}

/** Drop kickoff/instruction pollution from an elaboration blob. */
export function scrubStep2KickoffPollution(text: string): string {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (isStep2SystemOrKickoffMessage(raw)) return '';
  // Embedded fragment (e.g. hung after a short real tip)
  if (/这是第二步的开场|请不要假装在回应我说过的内容/.test(raw)) {
    return '';
  }
  return raw;
}

/** Stance / retention / slot-add confirms — never hard-hang onto parallel points. */
export function isStanceOrConfirmOnlyMessage(msg: string): boolean {
  const t = String(msg || '').trim();
  if (!t) return true;
  if (isExplicitSlotAddConfirm(t)) return true;
  if (isExplicitSlotAddReject(t)) return true;
  if (/^(采纳|拒绝)[。.!！？?\s]*$/i.test(t)) return true;
  if (
    /^(好的?|好|可以|行|嗯+|哦|噢|对|是|继续|同意|确认|就这样|ok|okay|yes)[。.!！？?\s]*$/i.test(
      t,
    )
  ) {
    return true;
  }
  // Short stance picks
  if (
    /^(弊大于利|利大于弊|积极|消极|正面|负面|同意|不同意|部分同意|完全同意|完全不同意)[。.!！？?\s]*$/i.test(
      t,
    )
  ) {
    return true;
  }
  if (t.length <= 16 && /弊大于利|利大于弊|积极|消极/.test(t)) return true;
  return false;
}

/** Coach ask that is a single-point deepen (enables one-shot hard-hang). */
export function isDeepenFocusCoachAsk(text: string): boolean {
  return Boolean(extractFocusClaimFromCoachText(text));
}

/**
 * Coach moved to summary / multi-point pool / stance / retention — clear deepen focus.
 */
export function shouldClearStep2DeepenFocus(coachText: string): boolean {
  const t = String(coachText || '');
  if (!t.trim()) return false;
  if (isDeepenFocusCoachAsk(t)) return false;
  return (
    /目前材料池|我们已经收集到|平行论点|①|②|③/.test(t) ||
    /是否按这个方案定下来|详写|略写/.test(t) ||
    /积极还是消极|利大于弊|弊大于利|全文立场|整体立场/.test(t) ||
    /第二问|评价|积极|消极发展/.test(t) ||
    /加入材料池|新的平行论点/.test(t)
  );
}

/** Explicit confirm to add a proposed new board slot. Bare「可以/好的」do NOT count. */
export function isExplicitSlotAddConfirm(msg: string): boolean {
  const t = String(msg || '').trim();
  if (!t) return false;
  if (
    /^(好的?|好|可以|行|嗯+|哦|噢|ok|okay|yes)[。.!！？?\s]*$/i.test(t)
  ) {
    return false;
  }
  if (
    /^(你觉得呢?|你定|你来定|老师定|你看着办|随便你|听你的)[。.!！？?\s]*$/i.test(
      t,
    )
  ) {
    return false;
  }
  if (/^(采纳|接受|加入|加进去)[。.!！？?\s]*$/i.test(t)) return true;
  return (
    /就这样|加上这条|加入材料池|就加这条|新增这条|用这个点|就用这个|按这个加/i.test(
      t,
    ) ||
    /^(同意|确认)[。.!！？?\s]*$/i.test(t) ||
    (/同意/.test(t) && /加|新增|材料池|这条|这个点/.test(t))
  );
}

/** Explicit reject of a proposed new board slot. */
export function isExplicitSlotAddReject(msg: string): boolean {
  const t = String(msg || '').trim();
  if (!t) return false;
  if (isExplicitSlotAddConfirm(t)) return false;
  return (
    /^(不用|不要|不加入|不需要|拒绝|算了|否|别加|不加)[。.!！？?\s]*$/i.test(
      t,
    ) ||
    /不加入|不要加|不用加|别加这条|不要新增|拒绝加入|不用新增/i.test(t)
  );
}

export type SlotAddDecisionAction = 'accept' | 'reject';

/**
 * Resolve accept/reject for a pending new-slot proposal.
 * UI buttons pass decision; free text: only explicit accept counts —
 * any other reply while pending is reject (clears the confirm loop).
 */
export function resolveSlotAddDecision(args: {
  userMessage?: string;
  decision?: { type?: string; action?: string } | null;
  hasPending: boolean;
}): SlotAddDecisionAction | null {
  const decisionType = String(args.decision?.type || '').trim();
  // Explicit non-slot decisions must not resolve/reject a pending slot-add.
  if (
    decisionType &&
    decisionType !== 'slot_add'
  ) {
    return null;
  }
  const rawAction = String(args.decision?.action || '')
    .trim()
    .toLowerCase();
  if (rawAction === 'accept' || rawAction === 'reject') {
    return rawAction;
  }
  const msg = String(args.userMessage || '').trim();
  if (!args.hasPending || !msg) return null;
  if (isExplicitSlotAddConfirm(msg)) return 'accept';
  return 'reject';
}

export function extractPendingSlotAdd(
  userPoints: string,
  prev?: Step2PendingSlotAdd | null,
): Step2PendingSlotAdd | null {
  const m = PENDING_SLOT_ADD_MARKER_RE.exec(String(userPoints || ''));
  if (m?.[1]?.trim()) {
    return { claim: m[1].trim() };
  }
  if (prev?.claim?.trim()) {
    return {
      claim: String(prev.claim).trim(),
      elaboration: prev.elaboration
        ? String(prev.elaboration).trim()
        : undefined,
    };
  }
  return null;
}

export function formatPendingSlotAddMarker(pending: Step2PendingSlotAdd): string {
  return `［待新增：claim=${String(pending.claim || '').trim()}］`;
}

export function stripPendingSlotAddMarker(userPoints: string): string {
  return String(userPoints || '')
    .replace(PENDING_SLOT_ADD_MARKER_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Attach elaboration onto a focused point id (no claim rename). */
export function attachTextToPointId(
  points: Step2Point[],
  pointId: string,
  text: string,
  mode: 'replace' | 'fill' = 'replace',
): Step2Point[] {
  const id = String(pointId || '').trim();
  const chunk = scrubStep2KickoffPollution(
    cleanElaboration(String(text || '').trim()),
  );
  if (!id || chunk.length < 4) return points;
  return points.map((p) => {
    if (p.id !== id || p.supersededBy) return p;
    const next = { ...p, leanTags: [...(p.leanTags || [])] };
    const before = cleanElaboration(next.elaboration || '');
    appendElaboration(next, [chunk], mode);
    next.quality = scorePointQuality(next.claim, next.elaboration || '');
    const after = cleanElaboration(next.elaboration || '');
    // Student deepen / content hang — always clear seed provenance.
    if (after && after !== before) next.seedOnly = false;
    return next;
  });
}

/** Resolve point id from a claim label among active points. */
export function findPointIdByClaim(
  points: Step2Point[],
  claim: string,
): string | undefined {
  const c = claimMatchCore(claim) || normalizeClaimLabel(claim);
  if (c.length < 2) return undefined;
  const active = points.filter((p) => !p.supersededBy);
  const hit =
    active.find((p) => claimMatchCore(p.claim) === c || p.claim === c || p.id === c) ||
    active.find(
      (p) =>
        headsCompatible(claimMatchCore(p.claim), c) ||
        headsCompatible(p.claim, c) ||
        claimMatchCore(p.claim).includes(c) ||
        c.includes(claimMatchCore(p.claim)) ||
        p.claim.includes(c) ||
        c.includes(p.claim),
    );
  return hit?.id;
}

/**
 * Detect focus claim from coach ask text (thin-ask / 详写『…』).
 * Used when switching activePoint because the coach changed target.
 */
export function extractFocusClaimFromCoachText(text: string): string | null {
  const t = String(text || '');
  const patterns = [
    /「([^」]{2,40})」目前还偏薄/,
    // Momentum expand-ask template (seed quote) is a genuine deepen ask.
    /「([^」]{2,40})」在第一步你提到过/,
    // NOTE: a bare 详写『x』 is a retention SCHEME statement (receipt/proposal),
    // not an expand ask — it must NOT drive deepen focus. Only the explicit
    // ask templates below (我们详写…请补充 / 留作略写——) count.
    /我们详写『([^』]{2,40})』/,
    /留作略写——?『([^』]{2,40})』/,
    /补充.*?『([^』]{2,40})』/,
    /展开『([^』]{2,40})』/,
    // Explore ask that names one Step1 dimension (not a thin-ask template)
    /原因维度[——\-~]*\*{0,2}[「『]([^」』]{2,40})[」』]/,
    /维度[——\-~]*\*{0,2}[「『]([^」』]{2,40})[」』]/,
    /关于(?:你提到的)?(?:另外一个|另一个|这个)?(?:原因|评价)?维度[——\-~]*\*{0,2}[「『]([^」』]{2,40})[」』]/,
    /沿着你之前提到的\*{0,2}[「『]([^」』]{2,40})[」』]/,
    /结合你之前提到的\*{0,2}[「『]([^」』]{2,40})[」』]/,
    /点名.*?[「『]([^」』]{2,40})[」』]/,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (m?.[1]?.trim()) return stripListMarkerPrefix(m[1].trim());
  }
  return null;
}

export function buildSlotAddConfirmAsk(claim: string): string {
  const c = String(claim || '').trim() || '这个新角度';
  return `我建议把『${c}』作为一条新的平行论点加入材料池。请点击下方「采纳」或「拒绝」（仅「采纳」会新增；其它回复视为拒绝）。`;
}

/** Prefer Part 2 (after ---) when classifying coach turns. */
export function coachMessageDecisionPart(text: string): string {
  const t = String(text || '').trim();
  if (!t) return '';
  if (!t.includes('---')) return t;
  const parts = t
    .split('---')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts[parts.length - 1] || t;
}

/**
 * Content / deepen asks — NEVER show 采纳/拒绝.
 * Only coach proposals that need accept/reject may show those buttons.
 */
export function coachMessageIsContentAskNotDecision(text: string): boolean {
  const part = coachMessageDecisionPart(text);
  if (!part) return false;
  if (
    /目前还偏薄|请补\s*1\s*[–\-—-]?\s*2\s*句|方便写成可展开的论据/.test(part)
  ) {
    return true;
  }
  if (
    /还没展开到可写程度|不默认一详一略|补完后再按各条可写量/.test(part)
  ) {
    return true;
  }
  if (
    /还有维度尚未处理|请选一个展开|请再给出\s*1\s*个具体主张|请再补充\s*1\s*个/.test(
      part,
    )
  ) {
    return true;
  }
  // Free-choice 详写/略写 (type a reply) — not a coach方案采纳
  if (
    /你更倾向\*{0,2}详写\*{0,2}还是\*{0,2}略写|回复「详写」或「略写」/.test(part)
  ) {
    return true;
  }
  if (
    /请直接用一两句话写出你的整体立场|请直接说你的|补场景|机制或受影响对象/.test(
      part,
    ) &&
    !/请点击|采纳|拒绝|加入材料池|全部保留/.test(part)
  ) {
    return true;
  }
  return false;
}

/** Coach proposed a new slot — student must 采纳/拒绝. */
export function coachMessageLooksLikeSlotAddDecision(text: string): boolean {
  const part = coachMessageDecisionPart(text);
  return (
    /加入材料池|新的平行论点|是否将「/.test(part) &&
    /采纳|拒绝/.test(part)
  );
}

/** Coach proposed a 详写/略写 scheme — student must 采纳/拒绝. */
export function coachMessageLooksLikeRetentionDecision(text: string): boolean {
  const part = coachMessageDecisionPart(text);
  if (coachMessageIsContentAskNotDecision(part)) return false;
  const hasScheme =
    /建议.*详写|详写『|已选详写|详略搭配|默认建议|这一侧的材料都已展开|按各条信息量|推荐详写|定一下详略|为它们定一下详略/.test(
      part,
    ) ||
    (/详写/.test(part) && /略写/.test(part));
  if (!hasScheme) return false;
  return /采纳|拒绝|点击下方|合适吗|你觉得|这个方案/.test(part);
}

/** Coach proposed capacity trim — student must confirm. */
export function coachMessageLooksLikeCapacityTrimDecision(text: string): boolean {
  const part = coachMessageDecisionPart(text);
  return /确认裁剪|全部保留|丢掉其中|定为略写|单段篇幅容易挤/.test(part);
}

/** Coach recommended a stance — student must 采纳/拒绝. */
export function coachMessageLooksLikeStanceDecision(text: string): boolean {
  const part = coachMessageDecisionPart(text);
  if (coachMessageIsContentAskNotDecision(part)) return false;
  return (
    /立场推荐|点击「采纳」锁定|采纳」锁定|基于你材料的立场|带让步的立场|推荐你采用/.test(
      part,
    ) ||
    (/推荐.*(立场|双重|辩证|利大于|弊大于|部分同意)/.test(part) &&
      /采纳|拒绝|同意这个立场|右侧面板/.test(part)) ||
    (/你同意这个立场|符合你的本意吗/.test(part) && /立场|采纳|确认/.test(part))
  );
}

function dedupeClaimLabels(labels: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    const c = normalizeClaimLabel(raw);
    if (c.length < 2) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    if (out.some((x) => headsCompatible(x, c))) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Build / refresh plannerPayload from session + optional incoming step2Data.
 *
 * Slot rule: when Step1 dimensions exist, freeze right-board point count/labels.
 * New slots only after explicit student confirm of pendingSlotAdd.
 *
 * Mount order for elaborations (student material only — never kickoff/system):
 * 1) string / compatible label match
 * 2) semantic theme match (e.g. 强势文化 → 文化全球化)
 * 3) current discussion slot (deepen focus / activePointId)
 * 4) else pendingSlotAdd ONLY when studentTurnIntent = propose_new_parallel_claim
 * Hidden kickoff / meta_process / isHiddenKickoff userMessage is never mounted.
 * Each slot keeps one canonical elaboration (replace, not paraphrase pile-up).
 */
export function normalizeStep2PlannerPayload(args: {
  session: any;
  step2Data?: any;
  questionType: string;
  requiresStance: boolean;
  forceExitUsed?: boolean;
  userMessage?: string;
  coachText?: string;
  /** Hidden kickoff / system opener — must not mount onto the board. */
  isHiddenKickoff?: boolean;
  /** Structured UI decision (slot-add / capacity-trim / retention). */
  decision?: { type?: string; action?: string; claim?: string } | null;
  /**
   * Student-turn intent (LLM or heuristic). Drives mount / slot-add / retention.
   * When omitted, a thin heuristic is derived from userMessage + decision.
   */
  studentTurnIntent?: Step2StudentTurnIntent | null;
}): Step2PlannerPayload {
  const eval2 = args.session?.step2?.coachEvaluation || {};
  const step2 = args.step2Data || {};
  const prev: Step2PlannerPayload | null =
    step2.plannerPayload || eval2.plannerPayload || null;

  const redirects: Record<string, string> = {
    ...(prev?.redirects || {}),
  };

  const step1Claims = extractStep1DimensionCores(args.session);
  let extraClaims = dedupeClaimLabels([...(prev?.extraClaims || [])]);
  let declinedSlotClaims = dedupeClaimLabels([
    ...(prev?.declinedSlotClaims || []),
  ]);
  const userMessage = String(args.userMessage || '').trim();
  const coachText = String(args.coachText || step2._coachText || '').trim();
  const turnIntent: Step2StudentTurnIntent =
    args.studentTurnIntent ||
    intentFromStructuredDecision(args.decision) ||
    classifyStep2StudentTurnHeuristic({
      userMessage,
      hasPendingSlotAdd: Boolean(
        prev?.pendingSlotAdd?.claim ||
          extractPendingSlotAdd(
            String(step2.userPoints || eval2.userPoints || ''),
            prev?.pendingSlotAdd,
          )?.claim,
      ),
      coachAsk: coachText,
    });
  const skipMountUserMessage =
    Boolean(args.isHiddenKickoff) ||
    isStep2SystemOrKickoffMessage(userMessage) ||
    intentIsMetaProcess(turnIntent) ||
    !intentMayMountContent(turnIntent) ||
    turnIntent.kind === 'retention_choice' ||
    turnIntent.kind === 'confirm_ack' ||
    turnIntent.kind === 'accept_slot_add' ||
    turnIntent.kind === 'reject_slot_add' ||
    turnIntent.kind === 'stance_choice';

  // Confirm / reject pending new slot
  let pendingSlotAdd = extractPendingSlotAdd(
    String(step2.userPoints || eval2.userPoints || ''),
    prev?.pendingSlotAdd,
  );
  let confirmedNewClaim: string | null = null;
  let confirmedNewElab = '';
  let rejectedPendingClaim: string | null = null;
  let rejectedPendingElab = '';
  // Slot-add decision must still read accept/reject even when content mount is skipped
  const slotDecision =
    turnIntent.kind === 'accept_slot_add'
      ? 'accept'
      : turnIntent.kind === 'reject_slot_add'
        ? 'reject'
        : resolveSlotAddDecision({
            userMessage:
              Boolean(args.isHiddenKickoff) ||
              isStep2SystemOrKickoffMessage(userMessage)
                ? ''
                : userMessage,
            decision: args.decision,
            hasPending: Boolean(pendingSlotAdd?.claim),
          });
  if (pendingSlotAdd?.claim && slotDecision === 'accept') {
    confirmedNewClaim = normalizeClaimLabel(pendingSlotAdd.claim);
    confirmedNewElab = cleanElaboration(
      String(pendingSlotAdd.elaboration || '').trim(),
    );
    if (
      confirmedNewClaim &&
      !extraClaims.some(
        (c) => c === confirmedNewClaim || headsCompatible(c, confirmedNewClaim!),
      ) &&
      !step1Claims.some(
        (c) => c === confirmedNewClaim || headsCompatible(c, confirmedNewClaim!),
      )
    ) {
      extraClaims = dedupeClaimLabels([...extraClaims, confirmedNewClaim]);
    }
    pendingSlotAdd = null;
  } else if (pendingSlotAdd?.claim && slotDecision === 'reject') {
    rejectedPendingClaim = normalizeClaimLabel(pendingSlotAdd.claim);
    rejectedPendingElab = cleanElaboration(
      String(pendingSlotAdd.elaboration || '').trim(),
    );
    if (rejectedPendingClaim) {
      declinedSlotClaims = dedupeClaimLabels([
        ...declinedSlotClaims,
        rejectedPendingClaim,
      ]);
    }
    pendingSlotAdd = null;
  }

  // Slots merged away via a committed slot_merge (superseded, no active twin)
  // must NOT be re-seeded from the frozen Step1 claim list.
  const prevPtsForFixed = Array.isArray(prev?.points) ? prev!.points : [];
  const claimMergedAway = (c: string): boolean => {
    const activeMatch = prevPtsForFixed.some(
      (p) => !p.supersededBy && (p.claim === c || headsCompatible(p.claim, c)),
    );
    if (activeMatch) return false;
    return prevPtsForFixed.some(
      (p) => p.supersededBy && (p.claim === c || headsCompatible(p.claim, c)),
    );
  };
  // Union with prev.fixedClaims: a model turn that rewrites/shrinks Step1
  // suggestedDimensions must not vaporize already-frozen slots. Slots only
  // leave the frozen list through a committed merge (claimMergedAway).
  const fixedClaims = dedupeClaimLabels([
    ...step1Claims,
    ...extraClaims,
    ...(Array.isArray(prev?.fixedClaims) ? prev!.fixedClaims! : []),
  ]).filter((c) => !claimMergedAway(c));
  const wantLock =
    step1Claims.length > 0 ||
    extraClaims.length > 0 ||
    fixedClaims.length > 0;
  let slotsLocked = Boolean(prev?.slotsLocked) || wantLock;
  // One-shot: allow creating the confirmed new claim this turn only.
  const allowCreateConfirmed =
    Boolean(confirmedNewClaim) && slotsLocked;

  let points: Step2Point[] = Array.isArray(prev?.points)
    ? prev!.points.map((p) => ({
        ...p,
        claim: normalizeClaimLabel(p.claim),
        elaboration: scrubStep2KickoffPollution(
          cleanElaboration(p.elaboration || ''),
        ),
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

  const allowCreate = !slotsLocked || allowCreateConfirmed;

  // Resolve current-slot focus BEFORE mounting so miss can fall back (no drop).
  let activePointId = String(prev?.activePointId || '').trim() || undefined;
  let focusMode: 'deepen' | 'none' =
    prev?.focusMode === 'deepen' ? 'deepen' : 'none';
  // Only the current ask (Part 2 after ---) may drive deepen focus. A composite
  // reply's Part-1 receipt (e.g.「已锁定：详写『强势文化冲击』」) must never
  // steal focus from the actual question being asked below the divider.
  const focusSource = coachMessageDecisionPart(coachText);
  const fromPrevAsk = extractFocusClaimFromCoachText(focusSource);
  if (fromPrevAsk) {
    const askId = findPointIdByClaim(points, fromPrevAsk);
    if (askId) {
      activePointId = askId;
      focusMode = 'deepen';
    }
  } else if (shouldClearStep2DeepenFocus(focusSource)) {
    focusMode = 'none';
    activePointId = undefined;
  }
  const mountFallbackId =
    (focusMode === 'deepen' && activePointId) ||
    (activePointId &&
    points.some((p) => p.id === activePointId && !p.supersededBy)
      ? activePointId
      : undefined) ||
    undefined;

  // Declined "new parallel claim" was often really elaboration (受影响对象等) —
  // hang it onto the current/semantic slot instead of dropping.
  if (rejectedPendingClaim && rejectedPendingClaim.length >= 4) {
    const blob = cleanElaboration(
      [rejectedPendingElab, rejectedPendingClaim].filter(Boolean).join('；'),
    );
    const sem =
      findBestSemanticSlot(points, blob) ||
      (mountFallbackId
        ? points.find((p) => p.id === mountFallbackId && !p.supersededBy)
        : undefined) ||
      points.find((p) => !p.supersededBy);
    if (sem) {
      appendElaboration(sem, [rejectedPendingElab, rejectedPendingClaim]);
    }
  }

  const preserveUnmatched = (orphan: {
    claim: string;
    elaboration: string;
  }) => {
    const blob = cleanElaboration(
      [orphan.elaboration, orphan.claim].filter(Boolean).join('；'),
    );
    if (!blob || !isSubstantiveBrainstormContent(blob)) return;
    if (intentIsMetaProcess(turnIntent)) return;
    // Re-try string match after stripping ① / （原因） — often the "new" claim is an existing slot.
    const rematch =
      findMatchingSlots(points, orphan.claim)[0] ||
      findMatchingSlots(points, blob)[0] ||
      findBestSemanticSlot(points, blob);
    if (rematch) {
      appendElaboration(rematch, [orphan.elaboration, orphan.claim], 'fill');
      return;
    }
    if (mountFallbackId) {
      const fb = points.find(
        (p) => p.id === mountFallbackId && !p.supersededBy,
      );
      if (fb) {
        appendElaboration(fb, [orphan.elaboration, orphan.claim], 'replace');
        return;
      }
    }
    if (pendingSlotAdd?.claim && intentMayProposeNewSlot(turnIntent)) {
      pendingSlotAdd = {
        claim: pendingSlotAdd.claim,
        elaboration: cleanElaboration(
          orphan.elaboration || orphan.claim || pendingSlotAdd.elaboration || '',
        ),
      };
      return;
    }
    const label =
      claimMatchCore(orphan.claim).replace(/[。．；;].*$/, '').slice(0, 24) ||
      normalizeClaimLabel(orphan.claim).replace(/[。．；;].*$/, '').slice(0, 24) ||
      '补充角度';
    // Never park as "new slot" if label already equals a frozen Step1 claim.
    if (
      fixedClaims.some(
        (c) =>
          claimMatchCore(c) === claimMatchCore(label) ||
          headsCompatible(claimMatchCore(c), claimMatchCore(label)),
      ) ||
      findMatchingSlots(points, label)[0]
    ) {
      const dest =
        findMatchingSlots(points, label)[0] ||
        points.find((p) => !p.supersededBy);
      if (dest) appendElaboration(dest, [orphan.elaboration, orphan.claim], 'fill');
      return;
    }
    if (
      declinedSlotClaims.some(
        (c) => c === label || headsCompatible(c, label),
      )
    ) {
      const dest = points.find((p) => !p.supersededBy);
      if (dest) appendElaboration(dest, [orphan.elaboration, orphan.claim], 'fill');
      return;
    }
    // Intent gate: only explicit "new parallel claim" may open 采纳/拒绝.
    if (!intentMayProposeNewSlot(turnIntent)) {
      return;
    }
    pendingSlotAdd = {
      claim: turnIntent.claimHint || label,
      elaboration: cleanElaboration(
        orphan.elaboration ||
          (orphan.claim !== label ? orphan.claim : ''),
      ),
    };
  };

  const mountOpts = {
    allowCreate,
    fallbackPointId: mountFallbackId,
    // Kickoff / meta / confirm_ack: model-carried Step1 seeds, not student expand.
    seedContext: skipMountUserMessage,
    onUnmatched: preserveUnmatched,
  };

  // Incoming model points — attach only when locked (or one-shot confirm add)
  const incomingPoints = Array.isArray(step2.plannerPayload?.points)
    ? step2.plannerPayload.points
    : Array.isArray(step2.plannerPoints)
      ? step2.plannerPoints
      : [];
  if (incomingPoints.length) {
    // Unmatched new claims while locked → pending confirm, do not grow silently.
    if (slotsLocked && !allowCreateConfirmed) {
      for (const p of incomingPoints) {
        const rawClaim = normalizeClaimLabel(
          String(p?.claim || p?.text || '').trim(),
        );
        if (rawClaim.length < 2) continue;
        const elab = cleanElaboration(String(p?.elaboration || '').trim());
        const matched =
          findMatchingSlots(points, rawClaim)[0] ||
          findMatchingSlots(points, claimMatchCore(rawClaim))[0] ||
          findBestSemanticSlot(points, `${rawClaim} ${elab}`.trim());
        if (
          !matched &&
          !fixedClaims.some(
            (c) =>
              claimMatchCore(c) === claimMatchCore(rawClaim) ||
              headsCompatible(claimMatchCore(c), claimMatchCore(rawClaim)) ||
              c === rawClaim ||
              headsCompatible(c, rawClaim),
          )
        ) {
          if (
            !pendingSlotAdd?.claim &&
            intentMayProposeNewSlot(turnIntent)
          ) {
            pendingSlotAdd = {
              claim: claimMatchCore(rawClaim) || rawClaim,
              elaboration: elab,
            };
          }
        }
      }
    }
    const incomingForUpsert =
      allowCreateConfirmed && confirmedNewClaim
        ? [
            ...incomingPoints,
            {
              claim: confirmedNewClaim,
              elaboration: confirmedNewElab,
            },
          ]
        : incomingPoints;
    points = upsertPointsFromClaims(
      points,
      incomingForUpsert.map((p: any) => ({
        claim: String(p.claim || p.text || '').trim(),
        elaboration: String(p.elaboration || '').trim(),
        leanTags: Array.isArray(p.leanTags)
          ? p.leanTags.filter(isBucket)
          : undefined,
        fromDimension: p.fromDimension,
      })),
      mountOpts,
    );
  } else if (allowCreateConfirmed && confirmedNewClaim) {
    points = upsertPointsFromClaims(
      points,
      [
        {
          claim: confirmedNewClaim,
          elaboration: confirmedNewElab,
          fromDimension: confirmedNewClaim,
          leanTags: ['general'],
        },
      ],
      { allowCreate: true },
    );
  }

  const userPointsRaw = String(
    step2.userPoints || eval2.userPoints || args.session?.step2?.userPoints || '',
  );
  let userPoints = userPointsRaw;
  let capacityTrimDismissedSides = [
    ...(prev?.capacityTrimDismissedSides || []),
  ].map((s) => String(s || '').trim()).filter(Boolean);
  let pendingCapacityTrim: Step2PendingCapacityTrim | null =
    prev?.pendingCapacityTrim?.sideKey &&
    Array.isArray(prev.pendingCapacityTrim.pointClaims) &&
    prev.pendingCapacityTrim.pointClaims.length >= 3
      ? {
          sideKey: String(prev.pendingCapacityTrim.sideKey),
          sideLabel: String(
            prev.pendingCapacityTrim.sideLabel ||
              sideKeyLabel(prev.pendingCapacityTrim.sideKey),
          ),
          pointIds: [...(prev.pendingCapacityTrim.pointIds || [])],
          pointClaims: [...prev.pendingCapacityTrim.pointClaims],
        }
      : null;

  let pendingStanceConfirm: Step2PendingStanceConfirm | null =
    prev?.pendingStanceConfirm?.text
      ? { text: String(prev.pendingStanceConfirm.text).trim() }
      : null;
  let stanceConfirmResolved = Boolean(prev?.stanceConfirmResolved);
  let stanceAwaitingCustom = Boolean(
    (prev as any)?.stanceAwaitingCustom || step2.stanceAwaitingCustom,
  );

  // Capacity trim UI decision (single-side ≥3)
  const trimDecisionType = String(args.decision?.type || '').trim();
  const trimAction = String(args.decision?.action || '').trim();
  const trimClaim = String(args.decision?.claim || '').trim();
  if (
    trimDecisionType === 'capacity_trim' &&
    (pendingCapacityTrim || trimAction === 'keep_all')
  ) {
    const trimSideKey = pendingCapacityTrim?.sideKey;
    if (trimAction === 'keep_all' && pendingCapacityTrim) {
      capacityTrimDismissedSides = [
        ...new Set([
          ...capacityTrimDismissedSides,
          pendingCapacityTrim.sideKey,
        ]),
      ];
      pendingCapacityTrim = null;
    } else if (
      (trimAction === 'brief' || trimAction === 'drop') &&
      trimClaim &&
      pendingCapacityTrim
    ) {
      const role = trimAction === 'brief' ? 'brief' : 'dropped';
      userPoints = stampRetentionTagOnUserPoints(userPoints, trimClaim, role);
      step2.userPoints = userPoints;
      // One confirm per side — avoid re-asking after 略写 still leaves 3 points
      if (trimSideKey) {
        capacityTrimDismissedSides = [
          ...new Set([...capacityTrimDismissedSides, trimSideKey]),
        ];
      }
      const dims = Array.isArray(step2.dimensionDispositions)
        ? step2.dimensionDispositions
        : Array.isArray(eval2.dimensionDispositions)
          ? [...eval2.dimensionDispositions]
          : [];
      if (dims.length) {
        step2.dimensionDispositions = dims.map((d: any) => {
          const dim = String(d?.dimension || '').trim();
          if (!dim || !headsCompatible(dim, trimClaim)) return d;
          if (role === 'dropped') {
            return { ...d, disposition: 'dropped', note: 'capacity_trim' };
          }
          return {
            ...d,
            disposition: 'expanded',
            note: 'capacity_trim_brief',
          };
        });
      }
      pendingCapacityTrim = null;
    }
  }

  // Stance recommend UI decision (采纳 / 拒绝)
  const stanceDecisionType = String(args.decision?.type || '').trim();
  const stanceDecisionAction = String(args.decision?.action || '').trim();
  if (stanceDecisionType === 'stance' && pendingStanceConfirm?.text) {
    if (stanceDecisionAction === 'accept') {
      step2.userStance = pendingStanceConfirm.text;
      if (!step2.blueprint || typeof step2.blueprint !== 'object') {
        step2.blueprint = {};
      }
      step2.blueprint.position = pendingStanceConfirm.text;
      stanceConfirmResolved = true;
      stanceAwaitingCustom = false;
      pendingStanceConfirm = null;
    } else if (stanceDecisionAction === 'reject') {
      pendingStanceConfirm = null;
      stanceAwaitingCustom = true;
      stanceConfirmResolved = false;
      // Do not keep coach suggestion as locked stance
      if (
        String(step2.userStance || '').trim() ===
        String(prev?.pendingStanceConfirm?.text || '').trim()
      ) {
        step2.userStance = '';
      }
    }
  }

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
    if (isStep2SystemOrKickoffMessage(claim)) return;
    const { claim: c, elaboration: e } = parseClaimElaboration(claim);
    if (!c && !e) return;
    const elab = scrubStep2KickoffPollution(e);
    if (isStep2SystemOrKickoffMessage(c) && !elab) return;
    points = upsertPointsFromClaims(
      points,
      [
        {
          claim: c || claim,
          elaboration: elab,
          leanTags: inferTagsFromText(claim, questionType, side),
          fromDimension: dimensionHead(c) || c,
        },
      ],
      mountOpts,
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
        mountOpts,
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
  const slotHeads = points
    .filter((p) => !p.supersededBy)
    .map((p) => dimensionHead(p.claim) || p.claim)
    .concat(fixedClaims.map((c) => dimensionHead(c) || c));
  points = points.map((p) => {
    if (!p.supersededBy && fixedSet.length) {
      const canon =
        fixedSet.find((c) => c === p.claim || headsCompatible(c, p.claim)) ||
        p.claim;
      p.claim = canon;
      p.fromDimension = canon;
    }
    // Safety net: no slot may keep other frozen slots' label debris
    const scrubbed = p.supersededBy
      ? p.elaboration
      : scrubCrossSlotContamination(
          p.elaboration || '',
          dimensionHead(p.claim) || p.claim,
          slotHeads,
        );
    return {
      ...p,
      elaboration: scrubbed,
      quality: scorePointQuality(p.claim, scrubbed || ''),
      leanTags: (p.leanTags || []).filter(isBucket),
      retentionRole: p.retentionRole,
    };
  });

  // --- Deepen one-shot: hang raw userMessage when thin-ask armed ---
  // Chunk mounting above already used semantic → focus fallback → pending.
  if (confirmedNewClaim) {
    const newId = findPointIdByClaim(points, confirmedNewClaim);
    if (newId) activePointId = newId;
    // Confirming a new slot is not a deepen rescue.
    focusMode = 'none';
  }

  const allowDeepenHang =
    !skipMountUserMessage &&
    focusMode === 'deepen' &&
    Boolean(activePointId) &&
    isSubstantiveBrainstormContent(userMessage) &&
    !isStanceOrConfirmOnlyMessage(userMessage);

  if (allowDeepenHang && activePointId) {
    // The intent classifier's mount target beats a possibly stale deepen focus
    // (e.g. focus mis-bound to a Part-1 receipt while the student answers the
    // Part-2 question about a different slot).
    const hintMountId = turnIntent.claimHint
      ? findPointIdByClaim(points, turnIntent.claimHint)
      : undefined;
    const targetId =
      hintMountId &&
      hintMountId !== activePointId &&
      points.some((p) => p.id === hintMountId && !p.supersededBy)
        ? hintMountId
        : activePointId;
    if (!points.some((p) => p.id === targetId && !p.supersededBy)) {
      activePointId = undefined;
      focusMode = 'none';
    } else {
      points = attachTextToPointId(points, targetId, userMessage);
      // One-shot: consume deepen so later multi-point replies use chunk match only.
      focusMode = 'none';
    }
  } else if (
    !skipMountUserMessage &&
    isSubstantiveBrainstormContent(userMessage) &&
    !isStanceOrConfirmOnlyMessage(userMessage)
  ) {
    // Explicit new-parallel-claim intent → pending confirm only (do not hang on old slots).
    if (intentMayProposeNewSlot(turnIntent)) {
      preserveUnmatched({
        claim: turnIntent.claimHint || userMessage.slice(0, 24),
        elaboration: userMessage,
      });
    } else {
      // userMessage-only content: semantic → focus → (intent-gated) pending.
      const tip = userMessage.slice(0, 16);
      const alreadyHung = points.some(
        (p) =>
          !p.supersededBy &&
          ((tip.length >= 4 && String(p.elaboration || '').includes(tip)) ||
            isNearDuplicateElaboration(p.elaboration || '', userMessage)),
      );
      if (!alreadyHung) {
        const hintId = turnIntent.claimHint
          ? findPointIdByClaim(points, turnIntent.claimHint)
          : undefined;
        // Deepen focus wins: never semantic-dump onto a different side/slot.
        if (mountFallbackId && focusMode === 'deepen') {
          points = attachTextToPointId(
            points,
            mountFallbackId,
            userMessage,
            'replace',
          );
        } else {
          const sem =
            (hintId &&
              points.find((p) => p.id === hintId && !p.supersededBy)) ||
            findBestSemanticSlot(points, userMessage);
          if (sem) {
            points = attachTextToPointId(points, sem.id, userMessage, 'replace');
          } else if (mountFallbackId) {
            points = attachTextToPointId(
              points,
              mountFallbackId,
              userMessage,
              'replace',
            );
          } else {
            preserveUnmatched({
              claim: userMessage.slice(0, 24),
              elaboration: userMessage,
            });
          }
        }
      }
    }
  }

  // Intent: 详写/略写 (详细写1 etc.) → stamp retentionRole + userPoints tags
  if (turnIntent.kind === 'retention_choice' && turnIntent.retention) {
    const applied = applyRetentionChoiceFromIntent(
      points,
      turnIntent,
      activePointId,
    );
    points = applied.points;
    for (const stamp of applied.stamps) {
      userPoints = stampRetentionTagOnUserPoints(
        userPoints,
        stamp.claim,
        stamp.role,
      );
      step2.userPoints = userPoints;
    }
  }

  // Meta / non-propose: never keep a freshly invented pendingSlotAdd
  if (
    pendingSlotAdd?.claim &&
    !prev?.pendingSlotAdd?.claim &&
    !intentMayProposeNewSlot(turnIntent) &&
    turnIntent.kind !== 'accept_slot_add'
  ) {
    pendingSlotAdd = null;
  }

  // Outbound thin-ask this turn → arm deepen for the *next* student reply.
  const focusOutbound = String(step2.pendingFocusClaim || '').trim();
  if (focusOutbound) {
    const nextId = findPointIdByClaim(points, focusOutbound);
    if (nextId) {
      activePointId = nextId;
      focusMode = 'deepen';
    }
  }

  // Confirmed stance only — do NOT treat suggestedStance as locked until UI 采纳
  let stanceText = String(
    step2.userStance ||
      (stanceConfirmResolved
        ? step2.blueprint?.position ||
          eval2.userStance ||
          eval2.blueprint?.position ||
          args.session?.step2?.userStance ||
          ''
        : eval2.userStance || args.session?.step2?.userStance || '') ||
      '',
  ).trim();

  // After reject, a free-text stance reply can lock without another button round.
  // A stance_choice intent IS the student stating their stance — it must not be
  // blocked by the skipMount guard (which exists for kickoff/meta/button turns).
  if (
    args.requiresStance &&
    stanceAwaitingCustom &&
    !stanceConfirmResolved &&
    (!skipMountUserMessage || turnIntent.kind === 'stance_choice') &&
    userMessage.length >= 10 &&
    !/^(采纳|拒绝|同意|没有|好的?|嗯+)$/.test(userMessage) &&
    /(同意|不同意|利弊|辩证|双重|积极|消极|部分|完全|立场|认为|倾向于)/.test(
      userMessage,
    )
  ) {
    stanceText = userMessage.slice(0, 200);
    step2.userStance = stanceText;
    if (!step2.blueprint || typeof step2.blueprint !== 'object') {
      step2.blueprint = {};
    }
    step2.blueprint.position = stanceText;
    stanceConfirmResolved = true;
    stanceAwaitingCustom = false;
    pendingStanceConfirm = null;
  }

  // A stance may only lock through a confirmed channel（proposal 采纳 or the
  // student's own stance text above）. A model-written userStance while the
  // confirm is unresolved is a recommendation: park it for confirmation and
  // never adopt it as the locked stance (it used to unlock the next step).
  if (
    args.requiresStance &&
    !stanceConfirmResolved &&
    stanceText &&
    !(stanceDecisionType === 'stance' && stanceDecisionAction === 'accept')
  ) {
    if (!pendingStanceConfirm?.text) {
      pendingStanceConfirm = { text: stanceText };
    }
    stanceText = '';
    step2.userStance = '';
  }

  const suggestedStanceText = String(
    step2.suggestedStance || eval2.suggestedStance || '',
  ).trim();
  const stageNow = String(
    step2.currentStage || eval2.currentStage || 'explore_A',
  ).trim();

  // Arm pending stance confirm only after checklist walk is done.
  {
    const walkDispositions =
      step2.dimensionDispositions ||
      eval2.dimensionDispositions ||
      prev?.dimensionDispositions ||
      [];
    const checklistWalkDone = isStep2ChecklistWalkDone(
      { points, fixedClaims: prev?.fixedClaims } as Step2PlannerPayload,
      walkDispositions,
    );
    if (!checklistWalkDone) {
      pendingStanceConfirm = null;
      if (stageNow === 'stance') {
        // Model jumped stage early — stay in explore until eval side is walked.
        step2.currentStage =
          String(step2.currentStage || '') === 'stance'
            ? 'explore_B'
            : step2.currentStage;
      }
    } else if (
      args.requiresStance &&
      stageNow === 'stance' &&
      !stanceConfirmResolved &&
      !stanceAwaitingCustom &&
      !pendingCapacityTrim?.sideKey &&
      !pendingSlotAdd?.claim
    ) {
      const recommend = suggestedStanceText || pendingStanceConfirm?.text || '';
      if (recommend && !stanceText) {
        pendingStanceConfirm = { text: recommend };
      } else if (
        stanceText &&
        suggestedStanceText &&
        stanceText === suggestedStanceText &&
        !stanceConfirmResolved
      ) {
        // Model pre-filled userStance with suggestion — still require UI confirm
        pendingStanceConfirm = { text: suggestedStanceText };
        stanceText = '';
        step2.userStance = '';
      }
    }
  }
  if (stanceConfirmResolved) {
    pendingStanceConfirm = null;
    stanceAwaitingCustom = false;
  }

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

  // Final quality + retention after deepen hangs
  points = applyRetentionRolesFromUserPoints(points, userPoints);
  points = points.map((p) => ({
    ...p,
    quality: scorePointQuality(p.claim, p.elaboration || ''),
    leanTags: dropRedundantGeneral((p.leanTags || []).filter(isBucket)),
    retentionRole: p.retentionRole,
  }));

  // Capacity trim is merged into side-level 详略 confirm (略写/丢掉).
  // Never arm a second「请确认裁剪」after retention is settled on that side.
  {
    const draftPayload = {
      points,
      capacityTrimDismissedSides,
      pendingCapacityTrim,
    } as Step2PlannerPayload;
    const overloaded = findOverloadedSide(
      draftPayload,
      capacityTrimDismissedSides,
    );
    if (
      overloaded &&
      overloaded.points.length >= 3 &&
      overloaded.points.every((p) => isPointRetentionSettled(p))
    ) {
      capacityTrimDismissedSides = [
        ...new Set([...capacityTrimDismissedSides, overloaded.sideKey]),
      ];
      pendingCapacityTrim = null;
    } else {
      // Side-first walk: separate trim UI is retired; clear any stale pending.
      pendingCapacityTrim = null;
    }
  }

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
    extraClaims: extraClaims.length ? extraClaims : undefined,
    activePointId: focusMode === 'deepen' ? activePointId : undefined,
    focusMode,
    pendingSlotAdd: pendingSlotAdd?.claim ? pendingSlotAdd : null,
    declinedSlotClaims: declinedSlotClaims.length
      ? declinedSlotClaims
      : undefined,
    pendingCapacityTrim: pendingCapacityTrim?.sideKey
      ? pendingCapacityTrim
      : null,
    capacityTrimDismissedSides: capacityTrimDismissedSides.length
      ? capacityTrimDismissedSides
      : undefined,
    pendingStanceConfirm: pendingStanceConfirm?.text
      ? pendingStanceConfirm
      : null,
    stanceConfirmResolved: stanceConfirmResolved || undefined,
    stanceAwaitingCustom: stanceAwaitingCustom || undefined,
    // Phase1 proposal channel — preserve across normalize rebuilds
    settleAwaitingCustomSide: prev?.settleAwaitingCustomSide || null,
    rejectedMergeIds:
      Array.isArray(prev?.rejectedMergeIds) && prev.rejectedMergeIds.length
        ? [...prev.rejectedMergeIds]
        : undefined,
    pendingProposal: prev?.pendingProposal?.proposalId
      ? prev.pendingProposal
      : null,
    sideSettled: Array.isArray(prev?.sideSettled)
      ? [...prev.sideSettled]
      : undefined,
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

    if (ids.length && !resolved.length) {
      // Planner wrote unresolvable ids (names / wrong scheme) — the body keeps
      // model-written labels/theme untouched; make that visible in logs.
      console.warn(
        `[Planner] hydrate skipped: body=${String(bp?.id || '?')} mappedPointIds=[${ids
          .map(String)
          .join(',')}] resolved none`,
      );
    }

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
 * Coverage safety net: synthesize a block for every active non-dropped point
 * that no body maps (planner LLM under-mapping). Brief/unmarked points become
 * minor blocks on the best same-side body; a stray detail point becomes a
 * major block. Runs after hydrate so index alignment is not disturbed.
 */
export function appendMissingPointBlocks(
  bodyPlans: any[],
  payload: Step2PlannerPayload | null | undefined,
): any[] {
  if (!Array.isArray(bodyPlans) || !bodyPlans.length || !payload) {
    return bodyPlans;
  }
  const redirects = payload.redirects || {};
  const active = activePoints(payload).filter(
    (p) => p.retentionRole !== 'dropped',
  );
  const byId = new Map(active.map((p) => [String(p.id), p] as const));
  const mapped = new Set<string>();
  for (const bp of bodyPlans) {
    const ids = Array.isArray(bp?.mappedPointIds) ? bp.mappedPointIds : [];
    const blockCount = Array.isArray(bp?.paragraphPlan?.pointBlocks)
      ? bp.paragraphPlan.pointBlocks.length
      : 0;
    // Ids beyond the block count have no block representing them — treat as
    // unmapped so a synthesized block is appended for the point.
    ids.forEach((id: string, i: number) => {
      if (i < blockCount) mapped.add(resolvePointId(String(id), redirects));
    });
  }
  const missing = active.filter((p) => !mapped.has(String(p.id)));
  if (!missing.length) return bodyPlans;

  const resolvedPointsOf = (bp: any): Step2Point[] =>
    (Array.isArray(bp?.mappedPointIds) ? bp.mappedPointIds : [])
      .map((id: string) => byId.get(resolvePointId(String(id), redirects)))
      .filter(Boolean) as Step2Point[];

  for (const p of missing) {
    const side = pointSideKey(p);
    // Prefer a body holding a same-side detail point, then any same-side
    // body, then any detail body, then the last body.
    const target =
      bodyPlans.find((bp) =>
        resolvedPointsOf(bp).some(
          (q) => pointSideKey(q) === side && q.retentionRole === 'detail',
        ),
      ) ||
      bodyPlans.find((bp) =>
        resolvedPointsOf(bp).some((q) => pointSideKey(q) === side),
      ) ||
      bodyPlans.find((bp) =>
        resolvedPointsOf(bp).some((q) => q.retentionRole === 'detail'),
      ) ||
      bodyPlans[bodyPlans.length - 1];
    const plan = target?.paragraphPlan;
    if (!plan || !Array.isArray(plan.pointBlocks)) continue;

    const isDetail = p.retentionRole === 'detail';
    const bid = `${String(target.id || 'body')}_auto_${String(p.id)}`;
    const hint = cleanElaboration(String(p.elaboration || '')).slice(0, 40);
    plan.pointBlocks.push({
      id: bid,
      label: String(p.claim || '').trim(),
      subClaim: '',
      role: isDetail ? 'major' : 'minor',
      expansionStrategy: isDetail ? 'mechanism' : 'explanation',
      steps: isDetail
        ? [
            {
              key: `${bid}_s1`,
              label: '分论点',
              placeholder: '确认本段核心主张',
              value: '',
            },
            {
              key: `${bid}_s2`,
              label: '展开原因',
              placeholder: '解释这个主张为什么成立',
              value: '',
            },
            {
              key: `${bid}_s3`,
              label: '典型场景',
              placeholder: '举一个具体场景或例子',
              value: '',
            },
          ]
        : [
            {
              key: `${bid}_s1`,
              label: '补充点',
              placeholder: hint
                ? `用一两句带过（素材：${hint}）`
                : '用一两句带过此略写点',
              value: '',
            },
          ],
    });
    const existingIds = (
      Array.isArray(target.mappedPointIds) ? target.mappedPointIds : []
    ).map((x: string) => resolvePointId(String(x), redirects));
    if (!existingIds.includes(String(p.id))) {
      target.mappedPointIds = [
        ...(Array.isArray(target.mappedPointIds) ? target.mappedPointIds : []),
        String(p.id),
      ];
      if (Array.isArray(target.mappedPoints)) {
        target.mappedPoints = [...target.mappedPoints, String(p.claim || '')];
      }
    }
    if (!isDetail) target.paragraphDensity = 'dual_point';
    if (plan.mode === 'single_point') plan.mode = 'direct_points';
    const note = `槽位 ${p.id}（${p.claim}）未被规划映射，已自动补入本段`;
    plan.diagnosis = plan.diagnosis ? `${plan.diagnosis}；${note}` : note;
    console.warn(
      `[Planner] coverage fix: ${note} → ${String(target.id || '?')}`,
    );
  }
  return bodyPlans;
}

/**
 * Soft hint for Planner/fallback bodyCount from retentionRole + ready points.
 * Not a hard lock for the LLM path — used for digests and degraded fallback.
 */
export function suggestPlannerBodyCount(
  payload: Step2PlannerPayload | null | undefined,
): 2 | 3 {
  const active = activePoints(payload).filter((p) => p.retentionRole !== 'dropped');
  const detail = active.filter((p) => p.retentionRole === 'detail');
  const detailReady = detail.filter((p) => p.quality === 'ready');
  const ready = active.filter((p) => p.quality === 'ready');
  // 3+ confirmed detail lines → prefer 3 bodies
  if (detail.length >= 3 || detailReady.length >= 3) return 3;
  // 2 detail + another ready point (often the other side) → prefer 3
  if (detail.length >= 2 && ready.length >= 3) return 3;
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
    `软提示 bodyCount≈${hint}（按可展开主线动态判断；同侧多条详写+对侧有点时优先考虑3；勿默认利弊=2）`,
  ].join('；');
}

/**
 * Safety net: detail-tagged points must not stay as minor/supporting blocks.
 * When ≥2 detail points are packed into one dual_point body and total bodies < 3,
 * split the extra detail point into its own body.
 */
export function expandPackedDetailBodies(
  bodyPlans: any[],
  payload: Step2PlannerPayload | null | undefined,
): any[] {
  if (!Array.isArray(bodyPlans) || !payload) return bodyPlans;
  const byId = new Map<string, Step2Point>(
    activePoints(payload).map((p) => [String(p.id), p]),
  );
  const redirects = payload.redirects || {};
  const resolve = (id: string) => resolvePointId(String(id), redirects);
  const detailIds = new Set(
    activePoints(payload)
      .filter((p) => p.retentionRole === 'detail')
      .map((p) => String(p.id)),
  );

  const plans = bodyPlans.map((bp) => ({
    ...bp,
    mappedPointIds: Array.isArray(bp?.mappedPointIds)
      ? [...bp.mappedPointIds]
      : [],
    paragraphPlan: bp?.paragraphPlan
      ? {
          ...bp.paragraphPlan,
          pointBlocks: Array.isArray(bp.paragraphPlan.pointBlocks)
            ? bp.paragraphPlan.pointBlocks.map((b: any) => ({ ...b }))
            : [],
        }
      : bp?.paragraphPlan,
  }));

  // Promote detail-mapped blocks to major
  for (const bp of plans) {
    const blocks = bp.paragraphPlan?.pointBlocks || [];
    const ids = bp.mappedPointIds || [];
    for (let i = 0; i < blocks.length; i++) {
      const pid = resolve(String(ids[i] || ids[0] || ''));
      if (pid && detailIds.has(pid) && String(blocks[i]?.role || '') === 'minor') {
        blocks[i].role = 'major';
      }
    }
  }

  if (detailIds.size < 2 || plans.length >= 3) {
    return plans.map((bp, i) => ({
      ...bp,
      id: `body-${i + 1}`,
      targetBody: `Body Paragraph ${i + 1}`,
    }));
  }

  // Split one packed dual_point that holds 2+ detail ids
  for (let bi = 0; bi < plans.length && plans.length < 3; bi++) {
    const bp = plans[bi];
    const ids = (bp.mappedPointIds || []).map((id: string) => resolve(String(id)));
    const detailMapped = [...new Set(ids.filter((id: string) => detailIds.has(id)))];
    if (detailMapped.length < 2) continue;

    const keepId = String(detailMapped[0] || '');
    const splitId = String(detailMapped[1] || '');
    if (!keepId || !splitId) continue;
    const blocks = bp.paragraphPlan?.pointBlocks || [];
    let splitIdx = blocks.findIndex((_: any, i: number) => {
      const mapped = resolve(String((bp.mappedPointIds || [])[i] || ''));
      return mapped === splitId;
    });
    if (splitIdx < 0 && blocks.length >= 2) splitIdx = blocks.length - 1;
    if (splitIdx < 0) continue;

    const splitBlock = {
      ...blocks[splitIdx],
      role: 'major',
      id: `${blocks[splitIdx]?.id || 'pb'}_split`,
    };
    bp.paragraphPlan.pointBlocks = blocks.filter((_: any, i: number) => i !== splitIdx);
    bp.mappedPointIds = (bp.mappedPointIds || []).filter(
      (id: string) => resolve(String(id)) !== splitId,
    );
    if (!bp.mappedPointIds.includes(keepId)) bp.mappedPointIds = [keepId, ...bp.mappedPointIds];
    bp.paragraphDensity = 'single_point';
    if (bp.paragraphPlan.pointBlocks.length <= 1) {
      bp.paragraphPlan.mode = 'single_point';
    }

    const keepPoint = byId.get(keepId);
    const splitPoint = byId.get(splitId);
    plans.splice(bi + 1, 0, {
      id: `body-split-${splitId}`,
      targetBody: 'Body Paragraph X',
      role: bp.role,
      mappedPointIds: [splitId],
      mappedPoints: splitPoint ? [splitPoint.claim] : [],
      paragraphDensity: 'single_point',
      paragraphPlan: {
        mode: 'single_point',
        diagnosis: `详写点 ${splitId} 从并段中拆出（尊重 Step2 详写锁定）`,
        pointBlocks: [splitBlock],
        totalClaim: '',
        optionalShortClosing: '',
      },
      theme: splitPoint?.claim || keepPoint?.claim || '',
    });
    break;
  }

  return plans.map((bp, i) => ({
    ...bp,
    id: `body-${i + 1}`,
    targetBody: `Body Paragraph ${i + 1}`,
  }));
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
