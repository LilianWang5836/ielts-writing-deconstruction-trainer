/**
 * Phase0: structured proposal channel (validate / commit / readiness).
 *
 * Decision flow: LLM evaluates → validateProposal → pendingProposal →
 * user confirm → commitProposal → right board sync.
 * Chat text is display-only; never reverse-parse decisions from prose.
 */

import type {
  Step2PlannerPayload,
  Step2Point,
  Step2Proposal,
  Step2ProposalRole,
  Step2RetentionRole,
  Step2StancePolarity,
} from '../../types';
import {
  activePoints,
  claimMatchCore,
  headsCompatible,
  inferStanceMeta,
  isPointExpandedForWalk,
  parseSideRetentionSchemeFromCoachText,
  pointHasSubstantiveContent,
  pointSideKey,
  scorePointQuality,
  sideKeyLabel,
  stampRetentionTagOnUserPoints,
} from './planner-payload';

export type ProposalValidation =
  | { ok: true }
  | { ok: false; reason: string };

export type CommitProposalResult = {
  payload: Step2PlannerPayload;
  userPoints: string;
};

const FRAGMENT_CLAIM_RE =
  /[。！？!?]|从.{0,12}来看|这一维度|接下来|当人们|通用的语言|带来了什么|^[对的了呢吧啊哦嗯]+$/;

/** Claim looks like a board title (not a truncated sentence fragment). */
export function looksLikeClaimTitle(claim: string): boolean {
  const c = String(claim || '').trim();
  if (c.length < 2 || c.length > 40) return false;
  if (FRAGMENT_CLAIM_RE.test(c)) return false;
  // Mid-sentence slash / ellipsis junk
  if (/…|\.\.\.|，$|，$/.test(c) && c.length > 16) return false;
  return true;
}

function activeNonDropped(payload: Step2PlannerPayload | null | undefined): Step2Point[] {
  return activePoints(payload).filter((p) => p.retentionRole !== 'dropped');
}

function pointsOnSideKey(
  payload: Step2PlannerPayload | null | undefined,
  sideKey: string,
): Step2Point[] {
  return activeNonDropped(payload).filter((p) => pointSideKey(p) === sideKey);
}

/** True when board has no real side buckets (Agree/Disagree soft / single-side). */
export function isGeneralOnlyBoard(
  payload: Step2PlannerPayload | null | undefined,
): boolean {
  const pts = activeNonDropped(payload);
  if (!pts.length) return true;
  return pts.every((p) => pointSideKey(p) === 'general');
}

/**
 * Sides that must be settled before stance.
 * General-only boards → one synthetic side 「general」.
 */
export function listSettleSides(
  payload: Step2PlannerPayload | null | undefined,
): string[] {
  const pts = activeNonDropped(payload);
  if (!pts.length) return [];
  if (isGeneralOnlyBoard(payload)) return ['general'];
  const order: string[] = [];
  const seen = new Set<string>();
  for (const p of pts) {
    const k = pointSideKey(p);
    if (k === 'general') continue;
    if (seen.has(k)) continue;
    seen.add(k);
    order.push(k);
  }
  // Orphan general points (mixed board) — treat as their own settle group last
  if (pts.some((p) => pointSideKey(p) === 'general')) {
    order.push('general');
  }
  return order;
}

/**
 * Side ready for side_settle: every active slot on the side has substantive
 * body, OR student explicitly said 先这样/够了 (exhausted).
 */
export function sideReadyForSettle(
  payload: Step2PlannerPayload | null | undefined,
  sideKey: string,
  options?: { exhausted?: boolean },
): boolean {
  if (!payload) return false;
  const settled = new Set(payload.sideSettled || []);
  if (settled.has(sideKey)) return false;

  const pts =
    sideKey === 'general' && isGeneralOnlyBoard(payload)
      ? activeNonDropped(payload)
      : pointsOnSideKey(payload, sideKey);
  if (!pts.length) return false;

  if (options?.exhausted) return true;
  // seedOnly slots carry only Step1 sprouts — side is NOT ready until each
  // slot got a real Step2 expansion (prevents kickoff-turn 详略 proposals).
  return pts.every((p) => isPointExpandedForWalk(p));
}

/**
 * Stance ready only when every settle-side is in sideSettled
 * (or has no active points). requiresStance=false → never.
 */
export function stanceReady(
  payload: Step2PlannerPayload | null | undefined,
): boolean {
  if (!payload?.requiresStance) return false;
  if (String(payload.stance?.text || '').trim().length >= 4) return false;
  if (payload.stanceConfirmResolved) return false;
  const sides = listSettleSides(payload);
  if (!sides.length) return false;
  const settled = new Set(payload.sideSettled || []);
  return sides.every((s) => settled.has(s));
}

export function validateProposal(
  payload: Step2PlannerPayload | null | undefined,
  proposal: Step2Proposal | null | undefined,
): ProposalValidation {
  if (!payload) return { ok: false, reason: 'no_payload' };
  if (!proposal?.proposalId || !proposal.kind) {
    return { ok: false, reason: 'missing_proposal' };
  }

  if (proposal.kind === 'side_settle') {
    const side = String(proposal.payload?.side || '').trim();
    if (!side) return { ok: false, reason: 'missing_side' };
    const assignments = Array.isArray(proposal.payload?.assignments)
      ? proposal.payload.assignments
      : [];
    if (!assignments.length) return { ok: false, reason: 'empty_assignments' };

    const sidePts =
      side === 'general' && isGeneralOnlyBoard(payload)
        ? activeNonDropped(payload)
        : pointsOnSideKey(payload, side);
    if (!sidePts.length) return { ok: false, reason: 'empty_side' };

    const byId = new Map(sidePts.map((p) => [p.id, p]));
    const seen = new Set<string>();
    for (const a of assignments) {
      const id = String(a?.slotId || '').trim();
      const role = String(a?.role || '').trim() as Step2ProposalRole;
      if (!id || !byId.has(id)) {
        return { ok: false, reason: `unknown_slot:${id || '?'}` };
      }
      if (role !== 'detail' && role !== 'brief' && role !== 'dropped') {
        return { ok: false, reason: `bad_role:${id}` };
      }
      if (seen.has(id)) return { ok: false, reason: `dup_slot:${id}` };
      seen.add(id);
    }
    for (const p of sidePts) {
      if (!seen.has(p.id)) {
        return { ok: false, reason: `unassigned:${p.id}` };
      }
    }
    return { ok: true };
  }

  if (proposal.kind === 'slot_add') {
    const claim = String(proposal.payload?.claim || '').trim();
    if (!looksLikeClaimTitle(claim)) {
      return { ok: false, reason: 'bad_claim_title' };
    }
    const core = claimMatchCore(claim) || claim;
    const clash = activeNonDropped(payload).find((p) => {
      const pc = claimMatchCore(p.claim) || p.claim;
      return (
        pc === core ||
        headsCompatible(pc, core) ||
        (core.length >= 4 && pc.includes(core)) ||
        (pc.length >= 4 && core.includes(pc))
      );
    });
    if (clash) return { ok: false, reason: `duplicate_slot:${clash.id}` };
    return { ok: true };
  }

  if (proposal.kind === 'slot_merge') {
    const fromId = String(proposal.payload?.fromSlotId || '').trim();
    const intoId = String(proposal.payload?.intoSlotId || '').trim();
    if (!fromId || !intoId) return { ok: false, reason: 'missing_merge_ids' };
    if (fromId === intoId) return { ok: false, reason: 'merge_self' };
    const active = activeNonDropped(payload);
    const from = active.find((p) => p.id === fromId);
    const into = active.find((p) => p.id === intoId);
    if (!from) return { ok: false, reason: `unknown_slot:${fromId}` };
    if (!into) return { ok: false, reason: `unknown_slot:${intoId}` };
    if (pointSideKey(from) !== pointSideKey(into)) {
      return { ok: false, reason: 'merge_side_mismatch' };
    }
    return { ok: true };
  }

  if (proposal.kind === 'stance') {
    const text = String(proposal.payload?.text || '').trim();
    if (text.length < 4) return { ok: false, reason: 'thin_stance' };
    return { ok: true };
  }

  return { ok: false, reason: 'unknown_kind' };
}

function nextPointId(points: Step2Point[]): string {
  let max = 0;
  for (const p of points) {
    const m = /^p(\d+)$/.exec(String(p.id || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `p${max + 1}`;
}

function dualWriteRoles(
  userPoints: string,
  points: Step2Point[],
): string {
  let up = String(userPoints || '');
  for (const p of points) {
    if (p.supersededBy || !p.retentionRole) continue;
    if (
      p.retentionRole === 'detail' ||
      p.retentionRole === 'brief' ||
      p.retentionRole === 'dropped'
    ) {
      up = stampRetentionTagOnUserPoints(up, p.claim, p.retentionRole);
    }
  }
  return up;
}

/**
 * Commit a validated proposal into the ledger (+ dual-write userPoints tags).
 * Caller must validate first; invalid proposals are no-ops with reason.
 */
export function commitProposal(params: {
  payload: Step2PlannerPayload;
  proposal: Step2Proposal;
  userPoints?: string;
}): CommitProposalResult & { ok: boolean; reason?: string } {
  const check = validateProposal(params.payload, params.proposal);
  if (check.ok === false) {
    return {
      ok: false,
      reason: check.reason,
      payload: params.payload,
      userPoints: String(params.userPoints || ''),
    };
  }

  const proposal = params.proposal;
  let points = [...(params.payload.points || [])];
  let userPoints = String(params.userPoints || '');
  let sideSettled = [...(params.payload.sideSettled || [])];
  let stance = { ...params.payload.stance };
  let stanceConfirmResolved = Boolean(params.payload.stanceConfirmResolved);
  let extraClaims = [...(params.payload.extraClaims || [])];

  if (proposal.kind === 'side_settle') {
    const side = proposal.payload.side;
    const roleById = new Map(
      proposal.payload.assignments.map((a) => [a.slotId, a.role as Step2RetentionRole]),
    );
    points = points.map((p) => {
      if (p.supersededBy) return p;
      const role = roleById.get(p.id);
      if (!role) return p;
      return { ...p, retentionRole: role };
    });
    if (!sideSettled.includes(side)) sideSettled.push(side);
    // Capacity trim merged into settle — dismiss this side
    const capacityTrimDismissedSides = [
      ...new Set([
        ...(params.payload.capacityTrimDismissedSides || []),
        side,
      ]),
    ];
    userPoints = dualWriteRoles(userPoints, points);
    const next: Step2PlannerPayload = {
      ...params.payload,
      points,
      sideSettled,
      capacityTrimDismissedSides,
      pendingProposal: null,
      pendingCapacityTrim: null,
      settleAwaitingCustomSide:
        params.payload.settleAwaitingCustomSide === side
          ? null
          : params.payload.settleAwaitingCustomSide ?? null,
      updatedAt: new Date().toISOString(),
    };
    return { ok: true, payload: next, userPoints };
  }

  if (proposal.kind === 'slot_add') {
    const claim = String(proposal.payload.claim).trim();
    const body = String(proposal.payload.body || '').trim();
    const side = String(proposal.payload.side || 'general').trim() || 'general';
    const id = nextPointId(points);
    const leanTags =
      side === 'general'
        ? (['general'] as Step2Point['leanTags'])
        : ([side] as Step2Point['leanTags']);
    const np: Step2Point = {
      id,
      claim,
      elaboration: body,
      fromDimension: claim,
      leanTags,
      quality: scorePointQuality(claim, body),
    };
    points = [...points, np];
    if (!extraClaims.some((c) => c === claim || headsCompatible(c, claim))) {
      extraClaims = [...extraClaims, claim];
    }
    if (body) {
      userPoints = userPoints.trim()
        ? `${userPoints.trim()}；${claim}（${body}）`
        : `${claim}（${body}）`;
    } else {
      userPoints = userPoints.trim()
        ? `${userPoints.trim()}；${claim}`
        : claim;
    }
    // New slot re-opens side settle if that side was already settled
    sideSettled = sideSettled.filter((s) => s !== side);
    const next: Step2PlannerPayload = {
      ...params.payload,
      points,
      extraClaims,
      sideSettled,
      slotsLocked: true,
      pendingProposal: null,
      pendingSlotAdd: null,
      updatedAt: new Date().toISOString(),
    };
    return { ok: true, payload: next, userPoints };
  }

  if (proposal.kind === 'slot_merge') {
    const fromId = proposal.payload.fromSlotId;
    const intoId = proposal.payload.intoSlotId;
    const from = points.find((p) => p.id === fromId)!;
    const into = points.find((p) => p.id === intoId)!;
    // Never fold merge meta-narration（「已整合至X」）into the target's body —
    // it is bookkeeping, not content.
    const rawChunk = String(from.elaboration || '').trim();
    const chunk = /^已(?:整合|并入|合并|归入|折进)/.test(rawChunk)
      ? ''
      : rawChunk;
    points = points.map((p) => {
      if (p.id === fromId) {
        return { ...p, supersededBy: intoId };
      }
      if (p.id === intoId) {
        const mergedBody = [String(p.elaboration || '').trim(), chunk]
          .filter(Boolean)
          .join('；');
        return {
          ...p,
          elaboration: mergedBody,
          quality: scorePointQuality(p.claim, mergedBody),
          // Folding in student-expanded content upgrades the target too.
          seedOnly: chunk && from.seedOnly === false ? false : p.seedOnly,
        };
      }
      return p;
    });
    const redirects = { ...(params.payload.redirects || {}), [fromId]: intoId };
    const fromCore = claimMatchCore(from.claim) || from.claim;
    const intoCore = claimMatchCore(into.claim) || into.claim;
    const dimensionDispositions = (
      params.payload.dimensionDispositions || []
    ).map((d) => {
      const dc = claimMatchCore(String(d?.dimension || '')) || String(d?.dimension || '');
      if (dc && (dc === fromCore || headsCompatible(dc, fromCore))) {
        return {
          ...d,
          disposition: 'merged' as const,
          mergedInto: intoCore,
        };
      }
      return d;
    });
    // Merge changes the side's slot inventory → re-open its settle.
    const sideKey = pointSideKey(into);
    sideSettled = sideSettled.filter((s) => s !== sideKey);
    const next: Step2PlannerPayload = {
      ...params.payload,
      points,
      redirects,
      dimensionDispositions,
      sideSettled,
      pendingProposal: null,
      updatedAt: new Date().toISOString(),
    };
    return { ok: true, payload: next, userPoints };
  }

  // stance
  const text = String(proposal.payload.text).trim();
  const meta = inferStanceMeta(text);
  const polarity: Step2StancePolarity =
    proposal.payload.polarity && proposal.payload.polarity !== 'unknown'
      ? proposal.payload.polarity
      : meta.polarity === 'not_required'
        ? 'unknown'
        : meta.polarity;
  stance = {
    text,
    polarity,
    strength: meta.strength,
  };
  stanceConfirmResolved = true;
  const next: Step2PlannerPayload = {
    ...params.payload,
    stance,
    stanceConfirmResolved,
    stanceAwaitingCustom: false,
    pendingProposal: null,
    pendingStanceConfirm: null,
    updatedAt: new Date().toISOString(),
  };
  return { ok: true, payload: next, userPoints };
}

/** Human-readable side label for UI / coach brief. */
export function settleSideLabel(sideKey: string): string {
  return sideKeyLabel(sideKey);
}

/** Build a volume-based fallback side_settle when LLM proposal fails validation. */
export function buildFallbackSideSettleProposal(
  payload: Step2PlannerPayload,
  sideKey: string,
  proposalId?: string,
): Step2Proposal | null {
  const pts =
    sideKey === 'general' && isGeneralOnlyBoard(payload)
      ? activeNonDropped(payload)
      : pointsOnSideKey(payload, sideKey);
  if (!pts.length) return null;
  const ranked = [...pts].sort((a, b) => {
    const ea = String(a.elaboration || '').trim().length;
    const eb = String(b.elaboration || '').trim().length;
    return eb - ea;
  });
  const assignments = ranked.map((p, i) => ({
    slotId: p.id,
    role: (i === 0 ? 'detail' : 'brief') as Step2ProposalRole,
  }));
  return {
    proposalId: proposalId || `fallback-side-${sideKey}-${Date.now()}`,
    kind: 'side_settle',
    rationale: '按各条信息量生成的兜底方案',
    payload: { side: sideKey, assignments },
  };
}

function matchLabelToPoint(
  label: string,
  points: Step2Point[],
): Step2Point | undefined {
  const core = claimMatchCore(label) || String(label || '').trim();
  if (core.length < 2) return undefined;
  return (
    points.find((p) => {
      const pc = claimMatchCore(p.claim) || p.claim;
      return (
        pc === core ||
        headsCompatible(pc, core) ||
        pc.includes(core.slice(0, Math.min(6, core.length))) ||
        core.includes(pc.slice(0, Math.min(6, pc.length)))
      );
    }) || undefined
  );
}

/** Map coach/LLM 详= / 略= labels onto slotIds for a side. */
export function buildSideSettleFromLabels(params: {
  payload: Step2PlannerPayload;
  sideKey: string;
  detailLabels: string[];
  briefLabels: string[];
  dropLabels?: string[];
  proposalId?: string;
  rationale?: string;
}): Step2Proposal | null {
  const pts =
    params.sideKey === 'general' && isGeneralOnlyBoard(params.payload)
      ? activeNonDropped(params.payload)
      : pointsOnSideKey(params.payload, params.sideKey);
  if (!pts.length) return null;

  const assignments: Array<{ slotId: string; role: Step2ProposalRole }> = [];
  const used = new Set<string>();
  const push = (labels: string[], role: Step2ProposalRole) => {
    for (const lab of labels) {
      const hit = matchLabelToPoint(lab, pts);
      if (!hit || used.has(hit.id)) continue;
      used.add(hit.id);
      assignments.push({ slotId: hit.id, role });
    }
  };
  push(params.detailLabels, 'detail');
  push(params.briefLabels, 'brief');
  push(params.dropLabels || [], 'dropped');
  // Unmentioned side slots → brief (keep on board) unless empty/seed-only → dropped
  for (const p of pts) {
    if (used.has(p.id)) continue;
    assignments.push({
      slotId: p.id,
      role: isPointExpandedForWalk(p) ? 'brief' : 'dropped',
    });
  }
  if (!assignments.some((a) => a.role === 'detail') && assignments.length) {
    assignments[0] = { ...assignments[0], role: 'detail' };
  }
  const proposal: Step2Proposal = {
    proposalId:
      params.proposalId || `side-${params.sideKey}-${Date.now()}`,
    kind: 'side_settle',
    rationale: params.rationale,
    payload: { side: params.sideKey, assignments },
  };
  return validateProposal(params.payload, proposal).ok ? proposal : null;
}

export function buildSideSettleFromCoachText(
  payload: Step2PlannerPayload,
  sideKey: string,
  coachText: string,
): Step2Proposal | null {
  const scheme = parseSideRetentionSchemeFromCoachText(coachText);
  if (!scheme) return null;
  const details = scheme.developed
    .split(/[、，,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const briefs = scheme.uncovered
    .split(/[、，,]/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '（无）');
  return buildSideSettleFromLabels({
    payload,
    sideKey,
    detailLabels: details,
    briefLabels: briefs,
    rationale: '来自教练评估方案',
  });
}

/**
 * Detect coach prose narrating a slot merge（「把X并入Y」「X作为Y的例子合并进去」）
 * and turn it into an explicit slot_merge proposal. Returns null when the
 * labels don't resolve to two distinct active slots.
 */
export function buildSlotMergeFromCoachText(
  payload: Step2PlannerPayload,
  coachText: string,
): Step2Proposal | null {
  const text = String(coachText || '');
  if (!text) return null;
  const Q = '[『「"“]';
  const QE = '[』」"”]';
  const LABEL = `([^『」「』"“”，。：:\\n]{2,24})`;
  const patterns: Array<{ re: RegExp; fromFirst: boolean }> = [
    // 把X并入/合并进/归入Y
    {
      re: new RegExp(
        `${Q}?${LABEL}${QE}?[^。\\n]{0,12}(?:并入|合并进|合并到|归入|折进)[^『「"“]{0,6}${Q}?${LABEL}${QE}?`,
      ),
      fromFirst: true,
    },
    // X……作为Y的……例子/论据/补充……合并/并入/放进
    {
      re: new RegExp(
        `${Q}${LABEL}${QE}[^。\\n]{0,30}作为[^。\\n]{0,10}${Q}${LABEL}${QE}[^。\\n]{0,12}(?:例子|论据|补充|素材)[^。\\n]{0,15}(?:合并|并入|归入|放进|折进|带出)`,
      ),
      fromFirst: true,
    },
  ];
  const pts = activeNonDropped(payload);
  for (const { re, fromFirst } of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const fromLabel = fromFirst ? m[1] : m[2];
    const intoLabel = fromFirst ? m[2] : m[1];
    const from = matchLabelToPoint(fromLabel, pts);
    const into = matchLabelToPoint(intoLabel, pts);
    if (!from || !into || from.id === into.id) continue;
    const proposal: Step2Proposal = {
      proposalId: `merge-${from.id}-${into.id}`,
      kind: 'slot_merge',
      rationale: '教练建议合并以保持篇幅精炼',
      payload: { fromSlotId: from.id, intoSlotId: into.id },
    };
    if (mergeAlreadyRejected(payload, proposal.proposalId)) continue;
    if (validateProposal(payload, proposal).ok) return proposal;
  }
  return null;
}

function mergeAlreadyRejected(
  payload: Step2PlannerPayload,
  proposalId: string,
): boolean {
  return (payload.rejectedMergeIds || []).includes(proposalId);
}

/**
 * Resolve the INTO slot of a narrated merge from prose（「…合并入强势文化中…」）.
 * The captured run after the merge verb is usually longer than the slot label
 * (abbreviations + trailing prose), so try progressively shorter prefixes.
 */
export function resolveMergeIntoFromText(
  text: string,
  pts: Step2Point[],
  excludeId?: string,
): Step2Point | undefined {
  const t = String(text || '');
  if (!t) return undefined;
  const re =
    /(?:合并入|合并到|合并至|整合至|整合到|并入|折进|归入)\s*[『「"“]?([^『」「』"“”，。；;：:）)\n]{2,20})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const raw = m[1].trim();
    for (let len = Math.min(raw.length, 12); len >= 3; len -= 1) {
      const cand = raw.slice(0, len).replace(/[的中里内]$/, '');
      if (cand.length < 2) continue;
      const hit = matchLabelToPoint(cand, pts);
      if (hit && hit.id !== excludeId) return hit;
    }
  }
  return undefined;
}

/**
 * Detect a merge the model narrated ON THE BOARD instead of in prose —
 * a userPoints line like 「全球消费主义（原因）：已整合至强势文化冲击的商业案例中」
 * or 「全球消费主义（已整合至强势文化冲击）」. Such meta-text means a merge
 * happened without student confirmation; turn it into an explicit slot_merge
 * proposal so the turn stops for 采纳/拒绝.
 */
export function buildSlotMergeFromBoardMeta(
  payload: Step2PlannerPayload,
  userPoints: string,
): Step2Proposal | null {
  const text = String(userPoints || '');
  if (!text) return null;
  const MARK = /已(?:整合|并入|合并|归入|折进)\s*[至到入进]?\s*([^（）()\n；;，,。]{2,30})/;
  const pts = activeNonDropped(payload);
  for (const line of text.split(/\n/)) {
    const mm = MARK.exec(line);
    if (!mm) continue;
    const head = line
      .slice(0, mm.index)
      .replace(/^\s*(?:[-•]\s*)?(?:\d+[.、)）]\s*)?/, '');
    const fromLabel = (head.split(/[（(：:；;，,。]/)[0] || '').trim();
    const from = matchLabelToPoint(fromLabel, pts);
    const into = matchLabelToPoint(mm[1].trim(), pts);
    if (!from || !into || from.id === into.id) continue;
    const proposal: Step2Proposal = {
      proposalId: `merge-${from.id}-${into.id}`,
      kind: 'slot_merge',
      rationale: '教练在整理材料时把它并入了另一条，需要你确认',
      payload: { fromSlotId: from.id, intoSlotId: into.id },
    };
    if (mergeAlreadyRejected(payload, proposal.proposalId)) continue;
    if (validateProposal(payload, proposal).ok) return proposal;
  }
  return null;
}

/** Soft ack while a proposal is pending → accept. */
export function isProposalSoftAccept(msg: string): boolean {
  const t = String(msg || '').trim();
  return /^(好的?|好|可以|行|嗯+|哦|噢|ok|okay|yes|采纳|同意|就这样|按这个|这个方案)[。.!！？?\s]*$/i.test(
    t,
  );
}

export function isProposalSoftReject(msg: string): boolean {
  const t = String(msg || '').trim();
  return /^(不|否|拒绝|不要|换一个|不同意|先不定)[。.!！？?\s]*$/i.test(t);
}

export type ParsedRetentionScheme = {
  /** 「都详写」 — every slot detail. */
  allDetail?: boolean;
  /** Index-based assignments against the displayed numbered list (1-based). */
  assignments: Array<{ index: number; role: Step2ProposalRole }>;
};

const SCHEME_IDX_MAP: Record<string, number> = {
  '①': 1, '②': 2, '③': 3, '④': 4, '⑤': 5, '⑥': 6,
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6,
};

function extractSchemeIndices(chunk: string): number[] {
  const out: number[] = [];
  for (const ch of String(chunk || '')) {
    const n = SCHEME_IDX_MAP[ch];
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

const SCHEME_IDX_GROUP =
  '[①②③④⑤⑥1-6一二三四五六](?:\\s*[、,，和与\\s]\\s*[①②③④⑤⑥1-6一二三四五六])*';

/**
 * Parse a full/partial 详略 counter-scheme from a student message:
 * 「详写2，略写1和3」「①详写，②略写」「都详写」「丢掉③」.
 * Indices refer to the numbered list the coach displayed. Returns null when
 * the message carries no indexed assignment (falls back to legacy handling).
 */
export function parseRetentionSchemeMessage(
  msg: string,
): ParsedRetentionScheme | null {
  const t = String(msg || '').trim();
  if (!t || t.length > 40) return null;
  if (/都详写|都详细写|全部详写|全都详写|两条都详|都展开/.test(t)) {
    return { allDetail: true, assignments: [] };
  }

  const assignments: ParsedRetentionScheme['assignments'] = [];
  const seen = new Set<number>();
  const push = (idxs: number[], role: Step2ProposalRole) => {
    for (const i of idxs) {
      if (seen.has(i)) continue;
      seen.add(i);
      assignments.push({ index: i, role });
    }
  };
  const roleOfWord = (w: string): Step2ProposalRole =>
    /详|展开/.test(w) ? 'detail' : /略|简单|一带/.test(w) ? 'brief' : 'dropped';

  const roleFirst = new RegExp(
    `(详细写|详写|展开写|略写|简单写|一带而过|丢掉|去掉|删掉|放弃|不写)\\s*[第]?\\s*(${SCHEME_IDX_GROUP})`,
    'g',
  );
  for (const m of t.matchAll(roleFirst)) {
    push(extractSchemeIndices(m[2]), roleOfWord(m[1]));
  }
  const idxFirst = new RegExp(
    `(${SCHEME_IDX_GROUP})\\s*(详细写|详写|展开写|略写|简单写|一带而过|详|略)`,
    'g',
  );
  for (const m of t.matchAll(idxFirst)) {
    push(extractSchemeIndices(m[1]), roleOfWord(m[2]));
  }

  if (!assignments.length) return null;
  return { assignments };
}

/**
 * Materialize a student counter-scheme into a committable side_settle.
 * `orderedSlotIds` must match the numbered list the student saw (defaults to
 * board order). Unmentioned slots take `defaultRoles` (e.g. the pending
 * recommendation) when given; otherwise brief if the student named a detail,
 * detail if they only named briefs/drops. Out-of-range index → null.
 */
export function buildSideSettleFromScheme(params: {
  payload: Step2PlannerPayload;
  sideKey: string;
  scheme: ParsedRetentionScheme;
  orderedSlotIds?: string[];
  defaultRoles?: Map<string, Step2ProposalRole>;
  proposalId?: string;
}): Step2Proposal | null {
  const pts =
    params.sideKey === 'general' && isGeneralOnlyBoard(params.payload)
      ? activeNonDropped(params.payload)
      : pointsOnSideKey(params.payload, params.sideKey);
  if (!pts.length) return null;
  const boardIds = pts.map((p) => p.id);
  const order = params.orderedSlotIds?.length
    ? params.orderedSlotIds.filter((id) => boardIds.includes(id))
    : boardIds;
  if (order.length !== boardIds.length) return null;

  let assignments: Array<{ slotId: string; role: Step2ProposalRole }>;
  if (params.scheme.allDetail) {
    assignments = order.map((id) => ({ slotId: id, role: 'detail' as const }));
  } else {
    for (const a of params.scheme.assignments) {
      if (a.index < 1 || a.index > order.length) return null;
    }
    const explicit = new Map<string, Step2ProposalRole>();
    for (const a of params.scheme.assignments) {
      explicit.set(order[a.index - 1], a.role);
    }
    const namedDetail = params.scheme.assignments.some(
      (a) => a.role === 'detail',
    );
    assignments = order.map((id) => {
      const chosen = explicit.get(id);
      if (chosen) return { slotId: id, role: chosen };
      // Naming a detail REPLACES the recommendation's detail: unmentioned
      // slots demote to brief — a recommended detail must never survive a
      // scheme the student didn't repeat it in (「详写2」⇒ 其余略写).
      if (namedDetail) return { slotId: id, role: 'brief' as const };
      // Only briefs/drops named → fill the rest from the recommendation.
      return {
        slotId: id,
        role: params.defaultRoles?.get(id) ?? ('detail' as const),
      };
    });
  }
  const proposal: Step2Proposal = {
    proposalId:
      params.proposalId || `custom-${params.sideKey}-${Date.now()}`,
    kind: 'side_settle',
    rationale: '按你的方案',
    payload: { side: params.sideKey, assignments },
  };
  return validateProposal(params.payload, proposal).ok ? proposal : null;
}

/**
 * Label-based counter-scheme（「详细写强势文化冲击」「略写网络普及和消费主义」）:
 * the numeric parser only understands indices, so a scheme that names slots
 * by claim label must resolve here — otherwise the student's words are
 * silently dropped and the stale recommendation gets re-presented.
 */
export function buildSideSettleFromLabelMessage(params: {
  payload: Step2PlannerPayload;
  sideKey: string;
  userMessage: string;
  orderedSlotIds?: string[];
  defaultRoles?: Map<string, Step2ProposalRole>;
  proposalId?: string;
}): Step2Proposal | null {
  const t = String(params.userMessage || '').trim();
  if (!t || t.length > 60) return null;
  const pts =
    params.sideKey === 'general' && isGeneralOnlyBoard(params.payload)
      ? activeNonDropped(params.payload)
      : pointsOnSideKey(params.payload, params.sideKey);
  if (!pts.length) return null;
  const order = params.orderedSlotIds?.length
    ? params.orderedSlotIds.filter((id) => pts.some((p) => p.id === id))
    : pts.map((p) => p.id);

  const re =
    /(详细写|详写|展开写|略写|简单写|一带而过|丢掉|去掉|删掉|不写)\s*[『「"“]?([^『」「』"“”，。；;：:？?！!\s]{2,24})/g;
  const assignments: ParsedRetentionScheme['assignments'] = [];
  const seenIdx = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const raw = m[2].trim();
    // Pure index/conjunction tokens belong to the numeric parser.
    if (/^[第]?[0-9①②③④⑤⑥⑦⑧⑨⑩一二三四五六七八九十和与、及]+$/.test(raw)) {
      continue;
    }
    const role: Step2ProposalRole = /详|展开/.test(m[1])
      ? 'detail'
      : /略|简单|一带/.test(m[1])
        ? 'brief'
        : 'dropped';
    // The run may pack several labels（「略写A和B」）: prefer the conjunction
    // split when every part resolves; otherwise match the run as one label
    // (claims themselves may contain 与, e.g.「国际交流与经济利益」).
    const parts = raw
      .split(/以及|[和与及、]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    const splitHits =
      parts.length >= 2 ? parts.map((p) => matchLabelToPoint(p, pts)) : [];
    const targets = (
      splitHits.length >= 2 && splitHits.every(Boolean)
        ? splitHits
        : [matchLabelToPoint(raw, pts)]
    ).filter((p): p is Step2Point => Boolean(p));
    for (const hit of targets) {
      const idx = order.indexOf(hit.id);
      if (idx < 0 || seenIdx.has(idx + 1)) continue;
      seenIdx.add(idx + 1);
      assignments.push({ index: idx + 1, role });
    }
  }
  if (!assignments.length) return null;
  return buildSideSettleFromScheme({
    payload: params.payload,
    sideKey: params.sideKey,
    scheme: { assignments },
    orderedSlotIds: order,
    defaultRoles: params.defaultRoles,
    proposalId: params.proposalId,
  });
}

/**
 * Open scheme ask after the student rejected a side_settle: enumerate slots
 * in board order (the order `buildSideSettleFromScheme` resolves against)
 * and let the student dictate the scheme. No 采纳/拒绝 wording — this is not
 * a confirmable proposal.
 */
export function buildOpenRetentionSchemeAsk(
  payload: Step2PlannerPayload,
  sideKey: string,
): string {
  const pts =
    sideKey === 'general' && isGeneralOnlyBoard(payload)
      ? activeNonDropped(payload)
      : pointsOnSideKey(payload, sideKey);
  const lines = pts.map((p, i) => {
    const label = claimMatchCore(p.claim) || p.claim;
    return `${i + 1}. ${label}`;
  });
  return (
    `好的，那「${settleSideLabel(sideKey)}」这几条的详略由你来定：\n\n${lines.join('\n')}\n\n` +
    `你想怎么安排？直接回复方案即可（例如「①详写，②③略写」或「都详写」）；` +
    `也可以说「按你的建议」，我再给一版方案。`
  );
}

/** Student asks the coach to recommend again after a settle reject. */
export function userMessageAsksForSettleRecommendation(msg: string): boolean {
  const t = String(msg || '').trim();
  if (!t || t.length > 30) return false;
  return /按你的建议|按你说的|你推荐|你来定|你决定|听你的|给个方案|再给一版|你建议/.test(
    t,
  );
}

/** Explore-round leak: model self-initiated 详略 / 立场 / 新槽 without pending. */
export function textLooksLikeExploreDecisionLeak(text: string): boolean {
  const part = String(text || '');
  const p2 = part.includes('---')
    ? part.split('---').slice(1).join('---')
    : part;
  return (
    (/详写/.test(p2) && /略写/.test(p2) && /采纳|拒绝|合适吗|你觉得/.test(p2)) ||
    (/加入材料池|新的平行论点/.test(p2) && /采纳|拒绝/.test(p2)) ||
    (/立场推荐|基于你材料的立场|点击「采纳」锁定/.test(p2) &&
      /采纳|拒绝/.test(p2))
  );
}

export function decisionTypeForProposalKind(
  kind: Step2Proposal['kind'],
): 'retention' | 'slot_add' | 'slot_merge' | 'stance' {
  if (kind === 'side_settle') return 'retention';
  if (kind === 'slot_add') return 'slot_add';
  if (kind === 'slot_merge') return 'slot_merge';
  return 'stance';
}

export function buildAskFromProposal(
  payload: Step2PlannerPayload,
  proposal: Step2Proposal,
): string {
  if (proposal.kind === 'side_settle') {
    const sideLabel = settleSideLabel(proposal.payload.side);
    const byId = new Map(
      activePoints(payload).map((p) => [p.id, p] as const),
    );
    const lines: string[] = [];
    const details: string[] = [];
    const briefs: string[] = [];
    const drops: string[] = [];
    for (const a of proposal.payload.assignments) {
      const p = byId.get(a.slotId);
      const label = claimMatchCore(p?.claim || '') || p?.claim || a.slotId;
      lines.push(`${lines.length + 1}. ${label}`);
      if (a.role === 'detail') details.push(`『${label}』`);
      else if (a.role === 'brief') briefs.push(`『${label}』`);
      else drops.push(`『${label}』`);
    }
    const rationale = proposal.rationale
      ? `（${proposal.rationale}）`
      : '';
    return (
      `「${sideLabel}」这一侧的材料都已展开。建议：**详写**${details.join('、') || '（无）'}` +
      (briefs.length ? `，**略写**${briefs.join('、')}` : '') +
      (drops.length ? `，**放下**${drops.join('、')}` : '') +
      `。${rationale}略写即控制单段篇幅。\n\n${lines.join('\n')}\n\n` +
      `请点击下方「采纳」或「拒绝」；也可直接回复「都详写」或「①详写，②略写」。`
    );
  }
  if (proposal.kind === 'slot_add') {
    const c = proposal.payload.claim;
    return (
      `我建议把『${c}』作为一条新的平行论点加入材料池。` +
      `请点击下方「采纳」或「拒绝」（仅「采纳」会新增；其它回复视为拒绝）。`
    );
  }
  if (proposal.kind === 'slot_merge') {
    const byId = new Map(activePoints(payload).map((p) => [p.id, p] as const));
    const from = byId.get(proposal.payload.fromSlotId);
    const into = byId.get(proposal.payload.intoSlotId);
    const fromLabel =
      claimMatchCore(from?.claim || '') || from?.claim || proposal.payload.fromSlotId;
    const intoLabel =
      claimMatchCore(into?.claim || '') || into?.claim || proposal.payload.intoSlotId;
    return (
      `我建议把『${fromLabel}』并入『${intoLabel}』，作为它的例子/补充素材，不再单独成段。` +
      `请点击下方「采纳」或「拒绝」；拒绝后我们会单独展开『${fromLabel}』。`
    );
  }
  // stance — self-contained: the ask must carry the stance sentence itself,
  // never reference 「上面」 (part1 may have been overridden away).
  const stanceText = String(proposal.payload.text || '').trim();
  if (stanceText) {
    return (
      `基于你目前的材料，推荐立场：「${stanceText}」\n\n` +
      `请点击下方「采纳」锁定，或「拒绝」后告诉我你想改成哪种立场。`
    );
  }
  return (
    `上面是基于你材料的立场推荐。请点击「采纳」锁定，或「拒绝」后告诉我你想改成哪种立场。`
  );
}

export function proposalSummaryForUi(proposal: Step2Proposal): string {
  if (proposal.kind === 'side_settle') {
    const d = proposal.payload.assignments
      .filter((a) => a.role === 'detail')
      .map((a) => a.slotId)
      .join(',');
    const b = proposal.payload.assignments
      .filter((a) => a.role === 'brief')
      .map((a) => a.slotId)
      .join(',');
    return `详写槽 ${d || '—'} / 略写槽 ${b || '—'}`;
  }
  if (proposal.kind === 'slot_add') {
    return `是否将「${proposal.payload.claim}」加入材料池`;
  }
  if (proposal.kind === 'slot_merge') {
    return `是否将槽 ${proposal.payload.fromSlotId} 并入槽 ${proposal.payload.intoSlotId}`;
  }
  return `待确认立场：${proposal.payload.text.slice(0, 80)}`;
}

/** Move a content chunk from one slot to another (纠错). */
export function reattachElaborationBetweenSlots(params: {
  points: Step2Point[];
  fromId: string;
  toId: string;
  chunk?: string;
}): Step2Point[] {
  const from = params.points.find((p) => p.id === params.fromId);
  const to = params.points.find((p) => p.id === params.toId);
  if (!from || !to || from.id === to.id) return params.points;
  const chunk = String(params.chunk || from.elaboration || '').trim();
  if (!chunk) return params.points;
  return params.points.map((p) => {
    if (p.id === params.fromId) {
      const left = String(p.elaboration || '')
        .split(chunk)
        .join('')
        .replace(/[；;]\s*[；;]/g, '；')
        .trim();
      return {
        ...p,
        elaboration: left,
        quality: scorePointQuality(p.claim, left),
      };
    }
    if (p.id === params.toId) {
      const merged = [p.elaboration, chunk].filter(Boolean).join('；');
      return {
        ...p,
        elaboration: merged,
        quality: scorePointQuality(p.claim, merged),
      };
    }
    return p;
  });
}

export function userMessageRequestsResettle(msg: string): boolean {
  const t = String(msg || '').trim();
  return (
    /改成详写|改为详写|改成略写|改为略写|改详略|重新定详略|把.*改成详|把.*改成略|网络别丢|不要丢掉|恢复/.test(
      t,
    ) ||
    (/详写|略写/.test(t) && /改|换成|变成/.test(t))
  );
}

export function userMessageLooksLikeReattach(msg: string): boolean {
  return /这段是说|刚才那段是|记错了|挂错了|应该记到|是说「|是补充/.test(
    String(msg || ''),
  );
}

type ChannelDecision = {
  type?: string;
  action?: string;
  proposalId?: string;
  claim?: string;
} | null;

/**
 * Resolve accept/reject against the previous turn's pendingProposal.
 * Returns handled=true when the turn was a decision on that proposal.
 */
export function resolvePendingProposalDecision(params: {
  prevPayload: Step2PlannerPayload | null | undefined;
  prevUserPoints?: string;
  userMessage: string;
  decision?: ChannelDecision;
}): {
  handled: boolean;
  accepted?: boolean;
  rejected?: boolean;
  /** Accepted with a student counter-scheme instead of the recommendation. */
  modified?: boolean;
  result?: CommitProposalResult & { ok: boolean; reason?: string };
} {
  const pending = params.prevPayload?.pendingProposal;
  if (!pending?.proposalId) return { handled: false };

  const dtype = String(params.decision?.type || '').trim();
  const daction = String(params.decision?.action || '')
    .trim()
    .toLowerCase();
  const expectedType = decisionTypeForProposalKind(pending.kind);
  const typeMatches =
    !dtype || dtype === 'proposal' || dtype === expectedType;

  if (dtype === 'proposal' && params.decision?.proposalId) {
    if (params.decision.proposalId !== pending.proposalId) {
      return { handled: false };
    }
  }

  const accept =
    (typeMatches && daction === 'accept') ||
    ((!dtype || typeMatches) && isProposalSoftAccept(params.userMessage));
  const reject =
    (typeMatches && daction === 'reject') ||
    ((!dtype || typeMatches) && isProposalSoftReject(params.userMessage));

  if (accept && !reject) {
    const result = commitProposal({
      payload: params.prevPayload!,
      proposal: pending,
      userPoints: params.prevUserPoints,
    });
    return { handled: true, accepted: true, result };
  }
  if (reject && !accept) {
    const cleared: Step2PlannerPayload = {
      ...params.prevPayload!,
      pendingProposal: null,
      pendingSlotAdd:
        pending.kind === 'slot_add'
          ? null
          : params.prevPayload!.pendingSlotAdd,
      pendingStanceConfirm:
        pending.kind === 'stance'
          ? null
          : params.prevPayload!.pendingStanceConfirm,
      // Rejecting a settle hands the scheme to the student: no auto re-arm
      // of the same fallback for this side until they answer (or ask us).
      settleAwaitingCustomSide:
        pending.kind === 'side_settle'
          ? String(pending.payload.side || '') || null
          : params.prevPayload!.settleAwaitingCustomSide ?? null,
      // Rejected merges go on a ledger so a lingering 「已整合至…」 meta line
      // in userPoints can't re-arm the identical merge next turn.
      rejectedMergeIds:
        pending.kind === 'slot_merge'
          ? [
              ...(params.prevPayload!.rejectedMergeIds || []),
              pending.proposalId,
            ]
          : params.prevPayload!.rejectedMergeIds,
    };
    return {
      handled: true,
      rejected: true,
      result: {
        ok: true,
        payload: cleared,
        userPoints: String(params.prevUserPoints || ''),
      },
    };
  }

  // Counter-scheme on a pending side_settle（「详写2，略写1和3」「都详写」）:
  // modify-and-accept in one turn. Indices resolve against the numbered list
  // shown in the ask (assignment order); unmentioned slots keep the pending
  // recommendation's role.
  if (pending.kind === 'side_settle' && (!dtype || typeMatches)) {
    const orderedSlotIds = pending.payload.assignments.map((a) => a.slotId);
    const defaultRoles = new Map<string, Step2ProposalRole>(
      pending.payload.assignments.map((a) => [a.slotId, a.role]),
    );
    const scheme = parseRetentionSchemeMessage(params.userMessage);
    // Index scheme（「详写2」）first; label scheme（「详细写强势文化冲击」）
    // second. Both are modify-and-accept in one turn.
    const modified =
      (scheme
        ? buildSideSettleFromScheme({
            payload: params.prevPayload!,
            sideKey: String(pending.payload.side || ''),
            scheme,
            orderedSlotIds,
            defaultRoles,
            proposalId: `${pending.proposalId}-mod`,
          })
        : null) ||
      buildSideSettleFromLabelMessage({
        payload: params.prevPayload!,
        sideKey: String(pending.payload.side || ''),
        userMessage: params.userMessage,
        orderedSlotIds,
        defaultRoles,
        proposalId: `${pending.proposalId}-mod`,
      });
    if (modified) {
      const result = commitProposal({
        payload: params.prevPayload!,
        proposal: modified,
        userPoints: params.prevUserPoints,
      });
      if (result.ok) {
        return { handled: true, accepted: true, modified: true, result };
      }
    }
  }
  return { handled: false };
}

/**
 * Arm at most one pendingProposal from ledger readiness (+ optional coach scheme).
 * Prefer coach-evaluated labels when they validate; else volume fallback.
 */
export type RetentionSuggestionInput = {
  detail?: string[];
  brief?: string[];
  drop?: string[];
  reason?: string;
} | null;

/**
 * Clamp a model-provided rationale before it is inlined into the ask text.
 * LLMs occasionally degenerate into repetition loops inside this free-text
 * field — cut to the first sentence / 60 chars and discard low-entropy loops.
 */
export function sanitizeRetentionReason(raw: string): string {
  let t = String(raw || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!t) return '';
  const firstStop = t.search(/[。！!？?]/);
  if (firstStop >= 8) t = t.slice(0, firstStop);
  if (t.length > 60) {
    const cut = t.slice(0, 60);
    // Prefer ending on a clause boundary instead of mid-word.
    const clause = cut.match(/^[\s\S]*[；;，,、]/);
    t = clause && clause[0].length >= 20
      ? clause[0].replace(/[；;，,、]$/, '')
      : cut;
  }
  if (t.length >= 16) {
    const bigrams: string[] = [];
    for (let i = 0; i < t.length - 1; i++) bigrams.push(t.slice(i, i + 2));
    const distinctRatio = new Set(bigrams).size / bigrams.length;
    if (distinctRatio < 0.4) return '';
  }
  return t;
}

export function armNextProposal(params: {
  payload: Step2PlannerPayload;
  coachText?: string;
  suggestedStance?: string;
  exhausted?: boolean;
  studentWantsResettleSide?: string;
  /** Structured 详略 scheme from the LLM's step2Data this turn. */
  retentionSuggestion?: RetentionSuggestionInput;
}): Step2Proposal | null {
  const payload = params.payload;
  if (payload.pendingProposal?.proposalId) return payload.pendingProposal;

  // Explicit re-settle request for a side
  if (params.studentWantsResettleSide) {
    const side = params.studentWantsResettleSide;
    const fromCoach = params.coachText
      ? buildSideSettleFromCoachText(payload, side, params.coachText)
      : null;
    return (
      fromCoach ||
      buildFallbackSideSettleProposal(payload, side, `resettle-${side}`)
    );
  }

  // Multi-step split: a narrated merge must be confirmed FIRST (its own
  // proposal). Only after commit does the side re-qualify for 详略 settle.
  if (params.coachText) {
    const merge = buildSlotMergeFromCoachText(payload, params.coachText);
    if (merge) return merge;
  }

  for (const side of listSettleSides(payload)) {
    // Student rejected this side's settle and owns the scheme now — never
    // auto re-arm the same fallback until they answer or ask us to suggest.
    if (payload.settleAwaitingCustomSide === side) continue;
    if (
      !sideReadyForSettle(payload, side, { exhausted: params.exhausted })
    ) {
      continue;
    }
    // Priority 1: structured retentionSuggestion from the LLM's step2Data —
    // its actual judgment, no prose reverse-parsing. Only trusted when at
    // least one detail label resolves onto this side's slots.
    const sug = params.retentionSuggestion;
    let usedStructuredSuggestion = false;
    if (sug && Array.isArray(sug.detail) && sug.detail.length) {
      const sidePts =
        side === 'general' && isGeneralOnlyBoard(payload)
          ? activeNonDropped(payload)
          : pointsOnSideKey(payload, side);
      const detailOnSide = sug.detail.some((lab) =>
        matchLabelToPoint(String(lab || ''), sidePts),
      );
      if (detailOnSide) {
        let dropLabels = (sug.drop || []).map((s) => String(s || ''));
        let briefLabels = (sug.brief || []).map((s) => String(s || ''));
        // A drop of a slot WITH real content, narrated as「合并/并入」, must
        // become a slot_merge confirm FIRST — settle's drop only marks the
        // slot, it never folds content, so accepting would silently lose it.
        const mergeText = `${String(sug.reason || '')}\n${String(params.coachText || '')}`;
        const mergeNarrated = /合并|并入|折进|整合至|整合到|归入/.test(mergeText);
        const contentDrops = dropLabels
          .map((lab) => matchLabelToPoint(lab, sidePts))
          .filter(
            (p): p is Step2Point =>
              Boolean(p) && pointHasSubstantiveContent(p as Step2Point),
          );
        if (contentDrops.length && mergeNarrated) {
          const from = contentDrops[0];
          const into = resolveMergeIntoFromText(mergeText, sidePts, from.id);
          const merge: Step2Proposal | null = into
            ? {
                proposalId: `merge-${from.id}-${into.id}`,
                kind: 'slot_merge',
                rationale:
                  sanitizeRetentionReason(String(sug.reason || '')) ||
                  '教练建议将这条并入另一条，需要你确认',
                payload: { fromSlotId: from.id, intoSlotId: into.id },
              }
            : null;
          if (
            merge &&
            !mergeAlreadyRejected(payload, merge.proposalId) &&
            validateProposal(payload, merge).ok
          ) {
            usedStructuredSuggestion = true;
            return merge;
          }
          // Merge target unresolvable (or already rejected): never let real
          // content vanish under a「合并」narrative — demote those drops to
          // brief. An explicit student「丢掉X」still drops via its own channel.
          const demoteIds = new Set(contentDrops.map((p) => p.id));
          const demoted = dropLabels.filter((lab) => {
            const p = matchLabelToPoint(lab, sidePts);
            return p && demoteIds.has(p.id);
          });
          dropLabels = dropLabels.filter((lab) => !demoted.includes(lab));
          briefLabels = [...briefLabels, ...demoted];
        }
        const prop = buildSideSettleFromLabels({
          payload,
          sideKey: side,
          detailLabels: (sug.detail || []).map((s) => String(s || '')),
          briefLabels,
          dropLabels,
          rationale:
            sanitizeRetentionReason(String(sug.reason || '')) ||
            '来自教练评估方案',
          proposalId: `settle-${side}`,
        });
        if (prop && validateProposal(payload, prop).ok) {
          usedStructuredSuggestion = true;
          return prop;
        }
      }
    }
    // 显式降级（文档 item5-4）：结构化 retentionSuggestion 提供了但本侧不可用
    // （detail 为空 / 标签解析不到本侧槽位），将退回 prose/长度启发式——记录日志，
    // 避免"静默退回"。
    if (sug && !usedStructuredSuggestion) {
      console.warn(
        `[Step2Proposal] retentionSuggestion 退化未用（side=${side}），退回 prose/长度启发式：detail=${JSON.stringify(sug.detail || []).slice(0, 120)}`,
      );
    }
    // Priority 2: parse the coach's narrated scheme from prose (compat).
    const fromCoach = params.coachText
      ? buildSideSettleFromCoachText(payload, side, params.coachText)
      : null;
    // Priority 3: volume ranking fallback (longest elaboration → detail).
    const prop =
      fromCoach ||
      buildFallbackSideSettleProposal(payload, side, `settle-${side}`);
    if (prop && validateProposal(payload, prop).ok) return prop;
  }

  // Migrate legacy pendingStanceConfirm → stance proposal so the ask text
  // and the confirm buttons come from the same channel (no split-brain).
  const legacyStanceText = String(
    payload.pendingStanceConfirm?.text || '',
  ).trim();
  if (
    legacyStanceText.length >= 4 &&
    payload.requiresStance !== false &&
    !payload.stanceConfirmResolved &&
    !payload.stanceAwaitingCustom &&
    String(payload.stance?.text || '').trim().length < 4
  ) {
    const prop: Step2Proposal = {
      proposalId: `stance-${Date.now()}`,
      kind: 'stance',
      payload: { text: legacyStanceText },
    };
    if (validateProposal(payload, prop).ok) return prop;
  }

  if (stanceReady(payload)) {
    const text = String(params.suggestedStance || '').trim();
    if (text.length >= 4) {
      const prop: Step2Proposal = {
        proposalId: `stance-${Date.now()}`,
        kind: 'stance',
        payload: { text },
      };
      if (validateProposal(payload, prop).ok) return prop;
    }
  }

  // Migrate legacy pendingSlotAdd → proposal channel
  const legacy = payload.pendingSlotAdd?.claim;
  if (legacy && looksLikeClaimTitle(legacy)) {
    const prop: Step2Proposal = {
      proposalId: `slot-${Date.now()}`,
      kind: 'slot_add',
      payload: {
        claim: legacy,
        side: 'general',
        body: String(payload.pendingSlotAdd?.elaboration || ''),
      },
    };
    if (validateProposal(payload, prop).ok) return prop;
  }

  return null;
}
