/**
 * Step2 explore ask contract: side-first checklist authority.
 *
 * Confirm UI only for lock decisions (side 详略 / new parallel / stance).
 * Process advance, task labels, scaffolds, same-theme → never pendingSlotAdd.
 */
import {
  buildSameSlotDeepenAsk,
  buildSlotAddConfirmAsk,
  claimMatchCore,
  coachMessageDecisionPart,
  findPointIdByClaim,
  formatPendingSlotAddMarker,
  headsCompatible,
  isElaborationScaffoldLabel,
  isPointExpandedForWalk,
  isStep2ChecklistWalkDone,
  isTaskRoleLabel,
  listUnwalkedChecklistPoints,
  resolveNextSideWalkStep,
  resolveProposedClaimAgainstBoard,
  stripPendingSlotAddMarker,
  textLooksLikePrematureSideAdvance,
} from './planner-payload';
import {
  armNextProposal,
  buildAskFromProposal,
  buildSlotMergeFromBoardMeta,
  buildSlotMergeFromCoachText,
} from './proposal';

export function textLooksLikePrematureStanceAsk(text: string): boolean {
  const part = String(text || '');
  const p2 = part.includes('---')
    ? part.split('---').slice(1).join('---')
    : part;
  return (
    /带让步的立场|立场推荐|推荐你采用.*立场|你同意这个立场|核心立场/.test(p2) &&
    (/采纳|同意|本意|拒绝/.test(p2) || /虽然.*但是|利弊|消极发展/.test(p2))
  );
}

/** Per-point 详略 ask while the side still has thin slots — wrong timing. */
function textLooksLikePrematurePerPointRetention(text: string): boolean {
  const part = String(text || '');
  const p2 = part.includes('---')
    ? part.split('---').slice(1).join('---')
    : part;
  return (
    /这一条你更倾向.*详写.*略写|回复「详写」或「略写」即可/.test(p2) &&
    !/这一侧的材料都已展开|按各条信息量/.test(p2)
  );
}

/**
 * Coach asks about a theme not on the frozen board → must become pendingSlotAdd
 * (adopt first), never a silent deepen of an off-board angle.
 * Same-theme / process-advance / task-role proposals are NOT off-board.
 */
export function detectOffBoardCoachTheme(
  coachText: string,
  payload: any,
): string | null {
  if (!payload?.slotsLocked) return null;
  const part = coachMessageDecisionPart(coachText);
  if (!part) return null;
  if (/加入材料池|新的平行论点|待新增/.test(part)) return null;
  const locked = [
    ...(Array.isArray(payload.fixedClaims) ? payload.fixedClaims : []),
    ...(Array.isArray(payload.extraClaims) ? payload.extraClaims : []),
    ...(Array.isArray(payload.points)
      ? payload.points
          .filter((p: any) => p && !p.supersededBy)
          .map((p: any) => String(p.claim || ''))
      : []),
  ]
    .map((c) => claimMatchCore(String(c || '')))
    .filter((c) => c.length >= 2);

  const onBoard = (theme: string) => {
    if (isTaskRoleLabel(theme) || isElaborationScaffoldLabel(theme)) return true;
    const resolved = resolveProposedClaimAgainstBoard(
      payload.points || [],
      theme,
      coachText,
    );
    if (resolved.kind !== 'new_parallel') return true;
    const t = claimMatchCore(theme);
    if (t.length < 2) return true;
    if (
      locked.some(
        (c) =>
          c === t ||
          headsCompatible(c, t) ||
          c.includes(t) ||
          t.includes(c),
      )
    ) {
      return true;
    }
    return Boolean(findPointIdByClaim(payload.points || [], theme));
  };

  const candidates: string[] = [];
  for (const m of part.matchAll(/[「『]([^」』]{2,40})[」』]/g)) {
    candidates.push(String(m[1] || '').trim());
  }
  for (const m of part.matchAll(/\*\*([^*「」『』]{2,36})\*\*/g)) {
    candidates.push(String(m[1] || '').trim());
  }
  if (
    /身份认同|文化多样性|认同感|旅行体验/.test(part) &&
    /负面|消极|损失|危机|影响/.test(part)
  ) {
    candidates.push('文化多样性与身份认同');
  }

  for (const raw of candidates) {
    const theme = String(raw || '')
      .replace(/（[^）]*）/g, '')
      .replace(/\([^)]*\)/g, '')
      .trim();
    if (theme.length < 2) continue;
    if (/目前还偏薄|材料池|采纳|拒绝|详写|略写/.test(theme)) continue;
    if (isElaborationScaffoldLabel(theme) || isTaskRoleLabel(theme)) continue;
    if (!onBoard(theme)) return theme.slice(0, 28);
  }
  return null;
}

export function extractStanceRecommendFromText(text: string): string {
  const t = String(text || '');
  const block = t.match(/虽然[^。\n]{8,120}。/);
  if (block?.[0]) return block[0].trim();
  const q = t.match(/[「"]([^」"]{12,160})[」"]/);
  if (q?.[1] && /虽然|但是|利|弊|积极|消极/.test(q[1])) return q[1].trim();
  return '';
}

export type AskContractDeps = {
  safeOverridePart1: (text: string) => string;
  buildContentAwareFallback: (session: any, step2: any) => string;
};

function forceSideWalkAsk(
  data: any,
  session: any,
  deps: AskContractDeps,
  part1: string,
  reason: string,
): void {
  const step2 = data.progressUpdate.step2Data;
  const payload = step2.plannerPayload;
  payload.pendingSlotAdd = null;
  payload.pendingStanceConfirm = null;
  payload.pendingCapacityTrim = null;
  step2.userPoints = stripPendingSlotAddMarker(String(step2.userPoints || ''));
  const next = resolveNextSideWalkStep(
    payload,
    step2.dimensionDispositions || payload.dimensionDispositions,
  );
  if (next.kind === 'expand' && next.point?.id) {
    payload.activePointId = next.point.id;
    payload.focusMode = 'deepen';
  }
  if (next.kind !== 'done') {
    step2.currentStage = /part_2|positive|negative|advantage|view_b|solution/.test(
      next.sideKey,
    )
      ? 'explore_B'
      : 'explore_A';
  }
  const ask = deps.buildContentAwareFallback(session, step2);
  data.text = `${part1}\n\n---\n\n${ask}`;
  if (data.progressUpdate) data.progressUpdate.isCompleted = false;
  console.warn(`[Step2AskContract] ${reason}`);
}

/**
 * Single explore contract:
 * - side expand-all → side 详略 → next side
 * - process / task-label / same-theme → never pendingSlotAdd
 * - true off-board only after checklist done
 * - stance only when checklist done
 */
export function enforceStep2AskContract(
  data: any,
  session: any,
  deps: AskContractDeps,
): void {
  const step2 = data?.progressUpdate?.step2Data;
  const payload = step2?.plannerPayload;
  if (!step2 || !payload || !data?.text) return;

  const dispositions =
    step2.dimensionDispositions || payload.dimensionDispositions;
  const checklistDone = isStep2ChecklistWalkDone(payload, dispositions);
  const unwalked = listUnwalkedChecklistPoints(payload, dispositions);
  const text = String(data.text || '');
  const part1 = deps.safeOverridePart1(text);
  const sideNext = resolveNextSideWalkStep(payload, dispositions);

  // Any-turn merge confirm: a merge narrated in coach prose OR written onto
  // the board as meta-text（「已整合至X」）must stop this turn for 采纳/拒绝 —
  // never a silent rhetorical merge that moves on to the next question.
  if (!payload.pendingProposal?.proposalId) {
    const narrated =
      buildSlotMergeFromCoachText(payload, text) ||
      buildSlotMergeFromBoardMeta(payload, String(step2.userPoints || ''));
    if (narrated?.proposalId) {
      payload.pendingProposal = narrated;
      data.text = `${part1}\n\n---\n\n${buildAskFromProposal(payload, narrated)}`;
      if (data.progressUpdate) data.progressUpdate.isCompleted = false;
      console.warn(
        `[Step2AskContract] Narrated merge → armed ${narrated.proposalId}, turn stops for confirm`,
      );
      return;
    }
  }

  // Scrub false slot-add while checklist unfinished
  if (!checklistDone && unwalked.length > 0 && payload.pendingSlotAdd?.claim) {
    forceSideWalkAsk(
      data,
      session,
      deps,
      part1,
      `Checklist gate scrubbed slot-add; next=${sideNext.kind}`,
    );
    return;
  }

  // Scrub false slot-add: process / task / same-theme
  if (payload.pendingSlotAdd?.claim) {
    const resolved = resolveProposedClaimAgainstBoard(
      payload.points || [],
      payload.pendingSlotAdd.claim,
      text,
    );
    if (resolved.kind === 'process_advance') {
      forceSideWalkAsk(
        data,
        session,
        deps,
        part1,
        'Scrubbed process/task-label false slot-add',
      );
      return;
    }
    if (resolved.kind === 'same_slot') {
      payload.pendingSlotAdd = null;
      step2.userPoints = stripPendingSlotAddMarker(
        String(step2.userPoints || ''),
      );
      payload.activePointId = resolved.point.id;
      payload.focusMode = 'deepen';
      data.text = `${part1}\n\n---\n\n${buildSameSlotDeepenAsk(resolved.point)}`;
      if (data.progressUpdate) data.progressUpdate.isCompleted = false;
      console.warn(
        `[Step2AskContract] Same-theme 「${resolved.point.claim}」 — no new slot`,
      );
      return;
    }
  }

  if (
    !checklistDone &&
    (textLooksLikePrematureStanceAsk(text) ||
      /材料池已经全部|材料池已经构建得极为饱满|全部收集完毕/.test(text))
  ) {
    forceSideWalkAsk(
      data,
      session,
      deps,
      part1,
      `Scrubbed premature stance/complete; unwalked=${unwalked.length}`,
    );
    return;
  }

  // Premature jump to 第二问 / per-point 详略 while side still expanding
  if (
    !checklistDone &&
    sideNext.kind !== 'done' &&
    (textLooksLikePrematureSideAdvance(text) ||
      (sideNext.kind === 'expand' &&
        textLooksLikePrematurePerPointRetention(text)) ||
      /加入材料池|新的平行论点/.test(text))
  ) {
    forceSideWalkAsk(
      data,
      session,
      deps,
      part1,
      `Side-walk gate → ${sideNext.kind}`,
    );
    return;
  }

  // Off-board coach theme → slot-add ONLY after checklist is done
  if (
    checklistDone &&
    !payload.pendingSlotAdd?.claim &&
    payload.slotsLocked
  ) {
    const off = detectOffBoardCoachTheme(text, payload);
    if (off && !/加入材料池/.test(text)) {
      const resolved = resolveProposedClaimAgainstBoard(
        payload.points || [],
        off,
        text,
      );
      if (resolved.kind === 'same_slot') {
        payload.activePointId = resolved.point.id;
        payload.focusMode = 'deepen';
        data.text = `${part1}\n\n---\n\n${buildSameSlotDeepenAsk(resolved.point)}`;
        console.warn(
          `[Step2AskContract] Off-board quote remapped to 「${resolved.point.claim}」`,
        );
        return;
      }
      if (resolved.kind === 'process_advance') {
        const ask = deps.buildContentAwareFallback(session, step2);
        data.text = `${part1}\n\n---\n\n${ask}`;
        console.warn('[Step2AskContract] Process-advance off-board ignored');
        return;
      }
      payload.pendingSlotAdd = { claim: off };
      const base = stripPendingSlotAddMarker(String(step2.userPoints || ''));
      step2.userPoints =
        `${base} ${formatPendingSlotAddMarker(payload.pendingSlotAdd)}`.trim();
      data.text = `${part1}\n\n---\n\n${buildSlotAddConfirmAsk(off)}`;
      if (data.progressUpdate) data.progressUpdate.isCompleted = false;
      console.warn(
        `[Step2AskContract] Off-board theme 「${off}」 → pendingSlotAdd first`,
      );
      return;
    }
  }

  // checklist done but coach still proposes task-label slot-add in text
  if (
    /加入材料池|新的平行论点/.test(text) &&
    /[「『]([^」』]{2,40})[」』]/.test(text)
  ) {
    const m = text.match(/[「『]([^」』]{2,40})[」』]/);
    const quoted = String(m?.[1] || '').trim();
    if (quoted && (isTaskRoleLabel(quoted) || isElaborationScaffoldLabel(quoted))) {
      payload.pendingSlotAdd = null;
      step2.userPoints = stripPendingSlotAddMarker(
        String(step2.userPoints || ''),
      );
      const ask = deps.buildContentAwareFallback(session, step2);
      data.text = `${part1}\n\n---\n\n${ask}`;
      console.warn(
        `[Step2AskContract] Scrubbed task-label slot-add 「${quoted}」`,
      );
      return;
    }
  }

  // Never leave a stance confirm armed while checklist (e.g. 评价) is unfinished.
  if (!checklistDone) {
    payload.pendingStanceConfirm = null;
    if (String(step2.currentStage || '') === 'stance') {
      step2.currentStage =
        sideNext.kind !== 'done' &&
        /part_2|positive|negative|advantage|view_b|solution/.test(
          sideNext.sideKey,
        )
          ? 'explore_B'
          : 'explore_A';
    }
  }

  // Phase1: side_settle / stance / slot_add arming moved to pendingProposal
  // channel (applyStep2ProposalChannelLate). Do not park ［待裁决］ or stance CTA here.
  if (payload.pendingCapacityTrim?.sideKey) {
    payload.pendingCapacityTrim = null;
  }
  // Clear stale marker residue so proposal channel is sole decision source.
  if (/［待裁决：/.test(String(step2.userPoints || ''))) {
    step2.userPoints = String(step2.userPoints || '')
      .replace(/［待裁决：[^\］]*］/g, '')
      .trim();
  }
  if (payload.stanceConfirmResolved) {
    payload.pendingStanceConfirm = null;
  }
  // Arm-first: a decision ask (详略/合并) may only be spoken when the proposal
  // channel actually arms a pendingProposal — text and buttons come from one
  // judgment, so "prose without buttons" cannot happen structurally.
  if (
    !checklistDone &&
    sideNext.kind === 'side_retention' &&
    !payload.pendingProposal?.proposalId
  ) {
    const armed = armNextProposal({
      payload,
      coachText: text,
      retentionSuggestion: step2.retentionSuggestion || null,
      dispositions,
    });
    if (armed?.proposalId) {
      payload.pendingProposal = armed;
      payload.pendingSlotAdd = null;
      payload.pendingStanceConfirm = null;
      payload.pendingCapacityTrim = null;
      data.text = `${part1}\n\n---\n\n${buildAskFromProposal(payload, armed)}`;
      if (data.progressUpdate) data.progressUpdate.isCompleted = false;
      console.warn(
        `[Step2AskContract] Armed ${armed.kind} at side-retention gate id=${armed.proposalId}`,
      );
      return;
    }
    // Channel refused → go back to expanding the blocking slot instead.
    const blocking = (sideNext.points || []).find(
      (p: any) => !isPointExpandedForWalk(p),
    );
    if (blocking?.id) {
      payload.activePointId = blocking.id;
      payload.focusMode = 'deepen';
      data.text = `${part1}\n\n---\n\n${buildSameSlotDeepenAsk(blocking)}`;
    } else {
      const ask = deps.buildContentAwareFallback(session, step2);
      data.text = `${part1}\n\n---\n\n${ask}`;
    }
    if (data.progressUpdate) data.progressUpdate.isCompleted = false;
    console.warn(
      '[Step2AskContract] Side-retention refused by proposal channel → expand fallback',
    );
  }
}
