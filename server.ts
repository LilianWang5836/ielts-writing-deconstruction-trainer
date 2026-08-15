import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { jsonrepair } from "jsonrepair";
import {
  isStep3Confirmed,
  computeEssayFrameworkSignature,
  resolveArgumentRelation,
  getRequiredBeatsForRelation,
  isStep3AffirmativeConfirmation,
} from "./src/utils/step3Quality.ts";
import { buildFallbackBodyPlans } from "./src/server/planner/planner-fallback";
import {
  buildPlannerRequest,
  collectPlannerInput,
  parsePlannerResponse,
  runMechanicalQa,
  normalizePlannerBodyPlans,
} from "./src/server/planner/planner";
import { isClaimSentence, CLAIM_SLOT_LABEL_RE } from "./src/utils/step3ClaimPrefill";
import {
  activePoints,
  buildSameSlotDeepenAsk,
  buildSlotAddConfirmAsk,
  claimMatchCore,
  coachMessageIsContentAskNotDecision,
  coachMessageLooksLikeStanceDecision,
  extractFocusClaimFromCoachText,
  findPointIdByClaim,
  formatPendingSlotAddMarker,
  applyRetentionRolesFromUserPoints,
  coachMessageLooksLikeRetentionDecision,
  formatSideRetentionPendingMarker,
  headsCompatible,
  isExplicitSlotAddConfirm,
  isPointExpandedForWalk,
  isStep2ChecklistWalkDone,
  listUnwalkedChecklistPoints,
  missingBucketCoachHint,
  normalizeStep2PlannerPayload,
  parseSideRetentionSchemeFromCoachText,
  plannerPayloadFingerprint,
  pointSideKey,
  preserveLockedRetentionInUserPoints,
  stripForgedRetentionLocks,
  resolveNextSideWalkStep,
  resolvePointId,
  resolveProposedClaimAgainstBoard,
  resolveSlotAddDecision,
  settleSideRetentionAfterAccept,
  shouldClearStep2DeepenFocus,
  stampRetentionTagOnUserPoints,
  stripPendingSlotAddMarker,
  textLooksLikePrematureSideAdvance,
  userMessageRequestsRetentionChange,
} from "./src/server/step2/planner-payload";
import {
  buildStep2StudentTurnIntentPrompt,
  classifyStep2StudentTurnHeuristic,
  intentFromStructuredDecision,
  parseRetentionChoiceMessage,
  parseStep2StudentTurnIntentLlm,
  type Step2StudentTurnIntent,
} from "./src/server/step2/student-turn-intent";
import {
  enforceStep2AskContract,
  extractStanceRecommendFromText,
  textLooksLikePrematureStanceAsk,
} from "./src/server/step2/ask-contract";
import {
  buildBareDimensionProbeAsk,
  countUnprobedStep1Dimensions,
  earliestUnprobedDimension,
  preserveStep1ProbeTags,
  resolvePendingProbeAnswer,
  stampUnprobedQualityPending,
  step1CapProbeComplete,
  stripIllegalSameTurnProbeTags,
  textLooksLikeProbeAskForDim,
} from "./src/server/step1/dimension-probe";
import {
  armNextProposal,
  buildAskFromProposal,
  buildOpenRetentionSchemeAsk,
  buildSideSettleFromLabelMessage,
  buildSideSettleFromScheme,
  commitProposal,
  parseRetentionSchemeMessage,
  reattachElaborationBetweenSlots,
  resolvePendingProposalDecision,
  textLooksLikeExploreDecisionLeak,
  userMessageAsksForSettleRecommendation,
  userMessageLooksLikeReattach,
  userMessageRequestsResettle,
} from "./src/server/step2/proposal";
import { buildCoachPrompt, parseCoachResponse } from "./src/server/coach/coach-agent";
import { buildIntentPrompt, parseIntentResponse } from "./src/server/coach/intent-agent";
import {
  appendMinute,
  landMinuteToSlot,
  commitPendingMinute,
  renderBoard,
  activeSlotLabel,
  isSkeletonComplete,
  detectStall,
} from "./src/server/step3/secretary";
import {
  evaluateMinute,
  findSlotDef,
  confirmedMinutes,
  formatLensAnchor,
} from "./src/server/step3/lens";
import { toSkeleton, planToSkeleton, skeletonFlatSlots } from "./src/utils/step3Skeleton";
import { log } from "./src/server/logger";

dotenv.config();
// 本地覆盖：.env.local 优先（便于本地测试时切换 LLM 提供商/Key，而不影响共享 .env）
dotenv.config({
  path: path.resolve(process.cwd(), ".env.local"),
  override: true,
});

// Lazy-initialize Gemini API client to avoid startup crashes if key is missing
let aiInstance: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    throw new Error(
      "GEMINI_API_KEY is not set or is still the default. Please add your real key in Settings > Secrets.",
    );
  }
  if (!aiInstance) {
    aiInstance = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiInstance;
}

function parseAIResponse(text: string | undefined, defaultData: any = {}): any {
  if (!text) return defaultData;
  let responseText = text.trim();
  if (responseText.startsWith("\`\`\`json")) {
    responseText = responseText
      .replace(/^\`\`\`json\n?/, "")
      .replace(/\n?\`\`\`$/, "");
  }
  try {
    return JSON.parse(responseText);
  } catch (e: any) {
    try {
      const repaired = jsonrepair(responseText);
      return JSON.parse(repaired);
    } catch (e2: any) {
      console.warn("JSON parsing completely failed, attempting regex salvage");
      const textMatch = responseText.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (textMatch) {
        return {
          ...defaultData,
          text: textMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'),
        };
      }
      // 纯文本兜底：DeepSeek 等 OpenAI 兼容端点偶发直接输出非 JSON 的教练文本。
      // 仅当调用方默认数据带 text 字段（面向文本的调用，如 coach）时，
      // 才把内容充实的原文作为教练消息，避免暴露 "Error parsing AI response."。
      if (defaultData && typeof defaultData.text === "string") {
        const prose = responseText.replace(/```/g, "").trim();
        if (prose.length >= 20) {
          return { ...defaultData, text: prose };
        }
      }
      return defaultData;
    }
  }
}

function splitTwoParts(
  text: string | undefined,
  minPart2Length: number = 6,
): {
  ok: boolean;
  part1: string;
  part2: string;
  reason: string;
} {
  const raw = String(text || "").trim();
  if (!raw) {
    return { ok: false, part1: "", part2: "", reason: "empty_text" };
  }
  const parts = raw.split(/\n\s*---\s*\n/);
  if (parts.length < 2) {
    return {
      ok: false,
      part1: raw,
      part2: "",
      reason: "missing_delimiter",
    };
  }
  const part1 = String(parts[0] || "").trim();
  const part2 = String(parts.slice(1).join("\n---\n") || "").trim();
  if (!part1) {
    return { ok: false, part1, part2, reason: "empty_part1" };
  }
  if (!part2) {
    return { ok: false, part1, part2, reason: "empty_part2" };
  }
  if (part2.replace(/\s+/g, "").length < minPart2Length) {
    return { ok: false, part1, part2, reason: "part2_too_short" };
  }
  return { ok: true, part1, part2, reason: "" };
}

/**
 * When a guard overrides a model's draft conclusion (e.g. reverting a premature
 * "summary" back to an explore stage), it must reuse ONLY the genuinely-separated
 * Part 1 feedback — never the raw, unsplit draft text. If the model's response is
 * missing the required "---" separator, `splitTwoParts` cannot isolate Part 1 from
 * Part 2, and the raw text may already contain a Part-2-style "we're done" / full
 * evaluation baked into one continuous block. Reusing it verbatim would carry that
 * stale conclusion into the corrected response, producing a self-contradictory
 * message. Fall back to a minimal, safe acknowledgment instead in that case —
 * confirmed state must be decided BEFORE text is assembled, never patched after.
 */
function safeOverridePart1(text: string): string {
  const split = splitTwoParts(text, 1);
  if (split.ok && String(split.part1 || "").trim()) return split.part1.trim();
  // Prefer a short leading paragraph over the old "记下了" dead phrase.
  const raw = String(text || "").trim();
  if (raw.length >= 4) {
    const head = raw.split(/\n\n+|---/)[0].trim();
    if (
      head.length >= 4 &&
      head.length <= 280 &&
      !/进入第三步|立即跳转|材料池已经全部/.test(head)
    ) {
      return head;
    }
  }
  return "好的。";
}

/**
 * Content-aware Step2 Part-2 fallback: walk checklist slots (content → 详略),
 * then single-side capacity trim, then stance — never skip unwalked Step1 slots.
 */
function buildStep2ContentAwareFallback(
  session: any,
  step2Data?: any,
): string {
  const eval2 = session?.step2?.coachEvaluation || {};
  const step2 = step2Data && typeof step2Data === "object" ? step2Data : {};
  const payload =
    step2.plannerPayload ||
    eval2.plannerPayload ||
    session?.step2?.plannerPayload ||
    null;
  const stage = String(
    step2.currentStage ||
      eval2.currentStage ||
      session?.step2?.currentStage ||
      "explore_A",
  ).trim();
  const missing: string[] = Array.isArray(payload?.coverage?.missingBuckets)
    ? payload.coverage.missingBuckets
    : [];
  const blockReason = String(payload?.exitGate?.blockReason || "").trim();
  const stanceText = String(
    payload?.stance?.text ||
      step2.userStance ||
      eval2.userStance ||
      session?.step2?.userStance ||
      "",
  ).trim();
  const requiresStance =
    step2.requiresStance !== false &&
    payload?.requiresStance !== false &&
    eval2.requiresStance !== false;
  const points = activePoints(payload);
  const ready = points.filter((p) => isPointExpandedForWalk(p));
  const dispositions =
    step2.dimensionDispositions ||
    eval2.dimensionDispositions ||
    payload?.dimensionDispositions ||
    [];
  const pendingDims = Array.isArray(dispositions)
    ? dispositions
        .filter((d: any) => String(d?.disposition || "").trim() === "pending")
        .map((d: any) =>
          String(d?.dimension || "")
            .replace(/（[^）]*）/g, "")
            .trim(),
        )
        .filter(Boolean)
    : [];
  const unwalked = listUnwalkedChecklistPoints(payload, dispositions);
  const checklistDone = isStep2ChecklistWalkDone(payload, dispositions);
  const pendingTrim = payload?.pendingCapacityTrim;

  // Phase1: structured pendingProposal is the only decision ask source.
  if (payload?.pendingProposal?.proposalId) {
    return buildAskFromProposal(payload, payload.pendingProposal);
  }

  // 1) Side-first checklist: expand all on side → one 详略 → next side
  const buildExpandAskForPoint = (point: any): string => {
    const claim = String(point?.claim || "").trim() || "这个论点";
    const seed = String(point?.elaboration || "").trim();
    if (step2 && typeof step2 === "object") {
      step2.pendingFocusClaim = claim;
      if (step2.plannerPayload && typeof step2.plannerPayload === "object") {
        step2.plannerPayload.activePointId = point.id;
        step2.plannerPayload.focusMode = "deepen";
      }
    }
    if (point?.seedOnly === true && seed.length >= 4) {
      const seedPreview = seed.length > 36 ? `${seed.slice(0, 36)}…` : seed;
      return (
        `「${claim}」在第一步你提到过「${seedPreview}」。` +
        `请再展开 1–2 句：具体场景、机制或受影响对象，方便写成可展开的论据。`
      );
    }
    return `「${claim}」目前还偏薄：请补 1–2 句具体场景、机制或受影响对象，方便写成可展开的论据。`;
  };
  const sideNext = resolveNextSideWalkStep(payload, dispositions);
  if (sideNext.kind === "expand") {
    return buildExpandAskForPoint(sideNext.point);
  }
  if (sideNext.kind === "side_retention") {
    // Do not park ［待裁决］ markers — Phase1 arms pendingProposal instead.
    if (step2 && typeof step2 === "object") {
      const cleaned = stripPendingSlotAddMarker(String(step2.userPoints || ""))
        .replace(/［待裁决：[^\］]*］/g, "")
        .trim();
      step2.userPoints = cleaned;
    }
    // Student rejected this side's settle → they own the scheme. Ask an open
    // question instead of re-proposing the same fallback.
    if (
      payload?.settleAwaitingCustomSide &&
      String(payload.settleAwaitingCustomSide) === String(sideNext.sideKey)
    ) {
      return buildOpenRetentionSchemeAsk(payload, sideNext.sideKey);
    }
    // Arm-first alignment: only speak a decision ask when the proposal channel
    // would actually arm one; otherwise expand the blocking slot instead of
    // emitting 详略 prose that will never grow buttons.
    const probe = armNextProposal({
      payload,
      retentionSuggestion: step2?.retentionSuggestion || null,
    });
    if (probe?.proposalId) {
      return buildAskFromProposal(payload, probe);
    }
    const blocking = (sideNext.points || []).find(
      (p: any) => !isPointExpandedForWalk(p),
    );
    if (blocking) {
      return buildExpandAskForPoint(blocking);
    }
    // Channel refused and nothing to expand (rare, e.g. side already settled
    // mid-rebuild) — fall through to generic content asks; never speak a
    // decision ask without a matching pendingProposal.
  }

  // 3) New-slot confirm ONLY after checklist is walked
  const pendingAdd = payload?.pendingSlotAdd;
  if (checklistDone && pendingAdd?.claim) {
    return buildSlotAddConfirmAsk(String(pendingAdd.claim));
  }

  // Capacity trim merged into side 详略 — do not ask a second裁剪 confirm.
  void pendingTrim;

  // 4) Pending Step1 dimensions with no board slot yet
  if (pendingDims.length > 0 && unwalked.length === 0 && !checklistDone) {
    const label = pendingDims.slice(0, 2).join("、");
    return `还有维度尚未处理（${label}）：请选一个展开成具体主张，或明确说「合并进已有点 / 放下不用」。`;
  }

  // 5) Soft: missing coverage buckets (does not unlock stance alone)
  if (missing.length > 0 && !checklistDone) {
    return missingBucketCoachHint(missing as any);
  }

  // 6) Need more ready points
  if (ready.length < 2 && !checklistDone) {
    if (blockReason) return `${blockReason}。请直接补充可写的具体主张。`;
    return "材料还不够写满两处论据：请再给出 1 个具体主张，并带上场景、机制或受影响对象。";
  }

  // 7) Stance recommend pending UI confirm (self-contained: carry the text)
  const pendingStance = String(payload?.pendingStanceConfirm?.text || "").trim();
  if (pendingStance && requiresStance) {
    return (
      `基于你目前的材料，推荐立场：「${pendingStance}」\n\n` +
      `请点击「采纳」锁定，或「拒绝」后告诉我你想改成哪种立场。`
    );
  }
  if (payload?.stanceAwaitingCustom && requiresStance && !stanceText) {
    return "好的，不采用刚才的推荐。请直接用一两句话写出你的整体立场（例如利弊参半 / 更偏积极 / 更偏消极）。";
  }

  // 8) Checklist done — stance / summary
  if (requiresStance && !stanceText) {
    return "各条论点已巡检完毕。结合已有论据强弱，你更倾向完全同意、部分同意（带让步），还是不同意？直接说一个即可。";
  }
  // A stance the student just accepted (locked/resolved) must not be re-confirmed.
  const stanceLocked = Boolean(
    payload?.stance?.locked ||
      payload?.stanceConfirmResolved ||
      step2.stanceConfirmResolved ||
      eval2.stanceConfirmResolved,
  );
  if (
    !stanceLocked &&
    (stage === "stance" || (requiresStance && stanceText && stage !== "summary"))
  ) {
    return `目前立场是「${stanceText}」。这个方向符合你的本意吗？确认后我们整理材料池并进入下一步。`;
  }
  if (stage === "summary" || stanceLocked || (stanceText && checklistDone)) {
    return "材料池和立场已经齐了。若没有要改的点，请确认进入下一步；若要改，直接指出要调整的论点或立场。";
  }

  if (blockReason) return `${blockReason}？`;
  return "请再补充 1 个具体可写主张（含场景、机制或受影响对象），或告诉我目前材料已经够用了。";
}

/**
 * Phase1 early: accept/reject previous pendingProposal before legacy guards.
 */
/**
 * Server-authored recap of the committed 详略 roles. On an accept turn the
 * model's own prose may echo an earlier unparsed counter-scheme and claim
 * roles that were never committed — the recap reads the committed payload.
 */
function buildSettleRecapAck(payload: any, sideKey: string): string {
  const pts = (Array.isArray(payload?.points) ? payload.points : []).filter(
    (p: any) =>
      p &&
      !p.supersededBy &&
      (sideKey === "general" ||
        (Array.isArray(p.leanTags) && p.leanTags.includes(sideKey))),
  );
  const label = (p: any) =>
    String(p?.claim || "")
      .replace(/[（(][^）)]*[）)]/g, "")
      .trim() || String(p?.claim || "");
  const details = pts
    .filter((p: any) => p?.retentionRole === "detail")
    .map(label);
  const briefs = pts
    .filter((p: any) => p?.retentionRole === "brief")
    .map(label);
  const parts: string[] = [];
  if (details.length) {
    parts.push(`详写${details.map((c: string) => `『${c}』`).join("、")}`);
  }
  if (briefs.length) {
    parts.push(`略写${briefs.map((c: string) => `『${c}』`).join("、")}`);
  }
  if (!parts.length) return "好的，这一侧的详略方案已锁定。";
  return `好的，已锁定这一侧详略：${parts.join("；")}。`;
}

function applyStep2ProposalChannelEarly(
  data: any,
  session: any,
  userMessage: string,
  decision?: { type?: string; action?: string; proposalId?: string } | null,
): {
  handled: boolean;
  accepted?: boolean;
  rejected?: boolean;
  committedPayload?: any;
  committedUserPoints?: string;
  kind?: string;
} {
  // 采纳/拒绝决策的状态在 session（prevPayload）里，与模型是否输出 step2Data 无关。
  // 模型回复（尤其 text_missing_delimiter 修复重试后）偶发缺失 step2Data——此时仍要
  // 处理决策，否则 pendingProposal 残留、下一轮重复武装同一提案（重复问答根因）。
  // 缺 step2Data 时创建一个空壳，让提交结果能写回并随 progressUpdate 下发。
  if (!data?.progressUpdate) {
    data.progressUpdate = { isCompleted: false };
  }
  if (!data.progressUpdate.step2Data) {
    data.progressUpdate.step2Data = {};
  }
  const prevPayload =
    session?.step2?.coachEvaluation?.plannerPayload ||
    session?.step2?.plannerPayload ||
    null;
  const prevUp = String(
    session?.step2?.coachEvaluation?.userPoints ||
      session?.step2?.userPoints ||
      "",
  );
  const resolved = resolvePendingProposalDecision({
    prevPayload,
    prevUserPoints: prevUp,
    userMessage,
    decision: decision || null,
  });
  if (!resolved.handled || !resolved.result) {
    // No pending proposal, but the student owns a rejected side's 详略 and
    // just supplied their scheme → commit it directly (indices in board order,
    // matching the open scheme ask).
    const awaitingSide = String(
      prevPayload?.settleAwaitingCustomSide || "",
    ).trim();
    if (awaitingSide && prevPayload && !prevPayload.pendingProposal?.proposalId) {
      const scheme = parseRetentionSchemeMessage(userMessage);
      const prop =
        (scheme
          ? buildSideSettleFromScheme({
              payload: prevPayload,
              sideKey: awaitingSide,
              scheme,
            })
          : null) ||
        // Label-named scheme（「详细写强势文化冲击」）— board order.
        buildSideSettleFromLabelMessage({
          payload: prevPayload,
          sideKey: awaitingSide,
          userMessage,
        });
      if (prop) {
        const result = commitProposal({
          payload: prevPayload,
          proposal: prop,
          userPoints: prevUp,
        });
        if (result.ok) {
          const step2 = data.progressUpdate.step2Data;
          step2.plannerPayload = result.payload;
          step2.userPoints = String(result.userPoints || "")
            .replace(/［待裁决：[^\］]*］/g, "")
            .replace(/［待新增：[^\］]*］/g, "")
            .trim();
          const part1raw = safeOverridePart1(String(data.text || ""));
          const part1 = /详写|略写/.test(part1raw) ? "好的。" : part1raw;
          const nextAsk = buildStep2ContentAwareFallback(session, step2);
          const recap = buildSettleRecapAck(result.payload, awaitingSide);
          data.text = `${part1}\n\n---\n\n${recap}${nextAsk}`;
          console.warn(
            "[Step2Proposal] Custom scheme committed side_settle (awaiting-custom)",
          );
          return {
            handled: true,
            accepted: true,
            committedPayload: result.payload,
            committedUserPoints: step2.userPoints,
            kind: "side_settle",
          };
        }
      }
    }
    return { handled: false };
  }

  const step2 = data.progressUpdate.step2Data;
  step2.plannerPayload = resolved.result.payload;
  step2.userPoints = String(resolved.result.userPoints || "")
    .replace(/［待裁决：[^\］]*］/g, "")
    .replace(/［待新增：[^\］]*］/g, "")
    .trim();
  if (resolved.accepted && resolved.result.payload.stance?.text) {
    step2.userStance = resolved.result.payload.stance.text;
    if (!step2.blueprint || typeof step2.blueprint !== "object") {
      step2.blueprint = {};
    }
    step2.blueprint.position = resolved.result.payload.stance.text;
  }

  const kind = String(prevPayload?.pendingProposal?.kind || "");
  let part1 = safeOverridePart1(String(data.text || ""));
  if (resolved.accepted) {
    let ack =
      kind === "slot_add"
        ? "好的，新的平行论点已加入材料池。"
        : kind === "slot_merge"
          ? "好的，已按方案合并，右侧材料池已同步。"
          : "好的，立场已锁定。";
    if (kind === "side_settle") {
      // Recap the roles that were ACTUALLY committed — and mute any 详写/略写
      // narration in the model's prose, which can echo an earlier unparsed
      // counter-scheme and contradict the board (incident: 「强势文化冲击设为
      // 详写」 while the committed detail was 全球消费主义).
      ack = buildSettleRecapAck(
        resolved.result.payload,
        String((prevPayload?.pendingProposal as any)?.payload?.side || ""),
      );
      if (/详写|略写/.test(part1)) part1 = "好的。";
    }
    const nextAsk = buildStep2ContentAwareFallback(session, step2);
    // Skip the ack when the model's own reply already states the same lock.
    const ackDup =
      kind === "stance" && /立场已锁定|立场已经锁定/.test(part1);
    data.text = `${part1}\n\n---\n\n${ackDup ? "" : ack}${nextAsk}`;
    console.warn(
      `[Step2Proposal] Accepted ${kind || "?"} → ledger committed`,
    );
    return {
      handled: true,
      accepted: true,
      committedPayload: resolved.result.payload,
      committedUserPoints: step2.userPoints,
      kind,
    };
  }

  const nextAsk = buildStep2ContentAwareFallback(session, step2);
  data.text = `${part1}\n\n---\n\n好的，这个方案先不定。${nextAsk}`;
  console.warn("[Step2Proposal] Rejected → pending cleared");
  return {
    handled: true,
    rejected: true,
    committedPayload: resolved.result.payload,
    committedUserPoints: step2.userPoints,
    kind,
  };
}

/** Re-apply roles / sideSettled / stance after normalize rebuilds the payload. */
function mergeCommittedProposalIntoPayload(
  step2: any,
  committed: any,
  committedUserPoints?: string,
): void {
  if (!step2 || !committed) return;
  const cur = step2.plannerPayload;
  if (!cur || typeof cur !== "object") {
    step2.plannerPayload = committed;
    if (committedUserPoints != null) step2.userPoints = committedUserPoints;
    return;
  }
  const committedById = new Map(
    (committed.points || []).map((p: any) => [p.id, p]),
  );
  cur.points = (cur.points || []).map((p: any) => {
    const cp: any = committedById.get(p.id);
    if (!cp) return p;
    let next = p;
    if (cp.retentionRole) next = { ...next, retentionRole: cp.retentionRole };
    // slot_merge: superseded flag must survive the normalize rebuild
    if (cp.supersededBy && !p.supersededBy) {
      next = { ...next, supersededBy: cp.supersededBy };
    }
    return next;
  });
  // slot_add may have appended a point only on committed
  for (const p of committed.points || []) {
    if (!(cur.points || []).some((x: any) => x.id === p.id)) {
      cur.points = [...(cur.points || []), p];
    }
  }
  // slot_merge: redirects + folded target body + merged dispositions
  const committedRedirects = committed.redirects || {};
  if (Object.keys(committedRedirects).length) {
    cur.redirects = { ...(cur.redirects || {}), ...committedRedirects };
    const intoIds = new Set(Object.values(committedRedirects).map(String));
    cur.points = (cur.points || []).map((p: any) => {
      if (!intoIds.has(p.id)) return p;
      const cp: any = committedById.get(p.id);
      if (!cp) return p;
      const curLen = String(p.elaboration || "").length;
      const cpLen = String(cp.elaboration || "").length;
      if (cpLen <= curLen) return p;
      return {
        ...p,
        elaboration: cp.elaboration,
        quality: cp.quality || p.quality,
        seedOnly: cp.seedOnly,
      };
    });
    const mergedDims = (committed.dimensionDispositions || []).filter(
      (d: any) => String(d?.disposition || "") === "merged",
    );
    if (mergedDims.length) {
      const byDim = new Map(
        mergedDims.map((d: any) => [String(d.dimension || ""), d]),
      );
      cur.dimensionDispositions = (cur.dimensionDispositions || []).map(
        (d: any) => {
          const hit: any = byDim.get(String(d?.dimension || ""));
          return hit
            ? { ...d, disposition: "merged", mergedInto: hit.mergedInto }
            : d;
        },
      );
    }
  }
  cur.sideSettled = [...(committed.sideSettled || [])];
  cur.extraClaims = [...(committed.extraClaims || cur.extraClaims || [])];
  cur.capacityTrimDismissedSides = [
    ...(committed.capacityTrimDismissedSides || []),
  ];
  // Settle reject/commit may set or clear the awaiting-custom side.
  cur.settleAwaitingCustomSide = committed.settleAwaitingCustomSide ?? null;
  // Merge reject appends to this ledger; preserve so detection skips it.
  if (Array.isArray(committed.rejectedMergeIds)) {
    cur.rejectedMergeIds = [...committed.rejectedMergeIds];
  }
  cur.pendingProposal = null;
  cur.pendingSlotAdd = null;
  cur.pendingStanceConfirm = null;
  cur.pendingCapacityTrim = null;
  if (committed.stance?.text) {
    cur.stance = { ...committed.stance };
    cur.stanceConfirmResolved = Boolean(committed.stanceConfirmResolved);
  }
  if (committedUserPoints != null) {
    step2.userPoints = String(committedUserPoints)
      .replace(/［待裁决：[^\］]*］/g, "")
      .replace(/［待新增：[^\］]*］/g, "")
      .trim();
  }
  step2.plannerPayload = cur;
}

/**
 * Phase1 late: arm pendingProposal, scrub explore leaks, decide-round purity.
 */
function applyStep2ProposalChannelLate(
  data: any,
  session: any,
  userMessage: string,
): void {
  const step2 = data?.progressUpdate?.step2Data;
  if (!step2 || typeof step2 !== "object") return;
  let payload = step2.plannerPayload;
  if (!payload || typeof payload !== "object") return;

  // Reattach: 「这段是说××的」
  if (userMessageLooksLikeReattach(userMessage)) {
    const m = String(userMessage).match(
      /(?:是说|记到|补充)\s*[「『]?([^」』，。\n]{2,28})/,
    );
    const targetHint = String(m?.[1] || "").trim();
    const fromId = String(payload.activePointId || "").trim();
    const toId = targetHint
      ? findPointIdByClaim(payload.points || [], targetHint)
      : undefined;
    if (fromId && toId && fromId !== toId) {
      payload = {
        ...payload,
        points: reattachElaborationBetweenSlots({
          points: payload.points || [],
          fromId,
          toId,
        }),
      };
      step2.plannerPayload = payload;
      const toClaim =
        (payload.points || []).find((p: any) => p.id === toId)?.claim ||
        targetHint;
      const tip = `已改记到「${claimMatchCore(toClaim) || toClaim}」。`;
      const part1 = safeOverridePart1(String(data.text || ""));
      data.text = `${part1}\n\n---\n\n${tip}${buildStep2ContentAwareFallback(session, step2)}`;
      console.warn(`[Step2Proposal] Reattached ${fromId} → ${toId}`);
      return;
    }
  }

  // Strip legacy markers while proposal channel is authoritative
  step2.userPoints = String(step2.userPoints || "")
    .replace(/［待裁决：[^\］]*］/g, "")
    .replace(/［待新增：[^\］]*］/g, "")
    .trim();

  const exhausted = /先这样|够了|没有更多|材料够了|先不定详略/.test(
    String(userMessage || ""),
  );
  // After a settle reject, 「按你的建议」 hands the scheme back to the coach:
  // clear the awaiting-custom flag so the fallback settle may re-arm.
  if (
    payload.settleAwaitingCustomSide &&
    userMessageAsksForSettleRecommendation(userMessage)
  ) {
    payload = { ...payload, settleAwaitingCustomSide: null };
    console.warn(
      "[Step2Proposal] Awaiting-custom cleared → student asked for a recommendation",
    );
  }
  let resettleSide: string | undefined;
  if (userMessageRequestsResettle(userMessage)) {
    const settled = payload.sideSettled || [];
    resettleSide = settled[settled.length - 1];
    if (resettleSide) {
      payload = {
        ...payload,
        sideSettled: settled.filter((s: string) => s !== resettleSide),
      };
    }
  }

  const suggested =
    String(step2.suggestedStance || "").trim() ||
    extractStanceRecommendFromText(String(data.text || ""));

  let pending = payload.pendingProposal;
  if (!pending?.proposalId) {
    pending = armNextProposal({
      payload,
      coachText: String(data.text || ""),
      suggestedStance: suggested,
      exhausted,
      studentWantsResettleSide: resettleSide,
      retentionSuggestion: step2.retentionSuggestion || null,
    });
  }

  if (pending?.proposalId) {
    payload = {
      ...payload,
      pendingProposal: pending,
      pendingSlotAdd: null,
      pendingStanceConfirm: null,
      pendingCapacityTrim: null,
    };
    step2.plannerPayload = payload;
    const ask = buildAskFromProposal(payload, pending);
    const part1 = safeOverridePart1(String(data.text || ""));
    data.text = `${part1}\n\n---\n\n${ask}`;
    if (data.progressUpdate) data.progressUpdate.isCompleted = false;
    console.warn(
      `[Step2Proposal] Armed ${pending.kind} id=${pending.proposalId}`,
    );
    return;
  }

  // Explore ban: scrub self-initiated decision prose when no pending
  if (textLooksLikeExploreDecisionLeak(String(data.text || ""))) {
    const part1 = safeOverridePart1(String(data.text || ""));
    const ask = buildStep2ContentAwareFallback(session, step2);
    data.text = `${part1}\n\n---\n\n${ask}`;
    console.warn("[Step2Proposal] Scrubbed explore decision leak");
  }

  // NOTE: the old 已记入：「X」 tip was removed — it read activePointId after the
  // next-ask refocus, so it named the UPCOMING slot instead of where the student's
  // content actually mounted, and it added no information over the coach's reply.

  step2.plannerPayload = payload;
}

function fallbackNextStep(
  stepNum: number,
  session: any,
  step2Data?: any,
): string {
  if (stepNum === 1) {
    const eval1 = session?.step1?.coachEvaluation || {};
    if (!eval1.correctType) {
      return "先完成题型识别：这道 Task 2 题属于哪一类（如 Agree/Disagree、Discussion、Advantages/Disadvantages）？请直接给出你的判断。";
    }
    if (!eval1.coreIssue) {
      return "请用一句话说出这道题真正要你完成的写作任务（不要直译或复述背景）？";
    }
    if (!Array.isArray(eval1.constraints) || eval1.constraints.length === 0) {
      return "再补一步：这道题有哪些关键限定词（人群、场景、程度、时间）必须在论证中回应？请列 1-3 个。";
    }
    return "很好。请把你的审题结论整合成一句写作任务说明：你准备如何回应题目、覆盖哪些限定并给出什么立场？";
  }

  if (stepNum === 2) {
    return buildStep2ContentAwareFallback(session, step2Data);
  }

  if (stepNum === 3) {
    const activeId = session?.step3?.activeSubpointId;
    const activeSubpoint = (session?.step3?.subpoints || []).find(
      (sp: any) => sp.id === activeId,
    );
    if (!activeSubpoint) {
      return "请先确认要推进的主体段分论点（当前没有激活分论点）。确认后我会直接做单点/多点诊断并给出 paragraphPlan。";
    }

    // 会议秘书：优先从冻结骨架 + minutes 投影当前槽位（与右侧看板一致）。
    const skeleton = activeSubpoint.skeleton;
    if (skeleton && Array.isArray(skeleton.blocks) && skeleton.blocks.length > 0) {
      const flat = skeletonFlatSlots(skeleton);
      const minutes = Array.isArray(activeSubpoint.minutes)
        ? activeSubpoint.minutes
        : [];
      const confirmedKeys = new Set(
        minutes
          .filter((m: any) => m.status === "confirmed" && m.slotKey)
          .map((m: any) => m.slotKey as string),
      );
      const firstEmpty = flat.find((f) => !confirmedKeys.has(f.slot.key));
      const landed = minutes.find((m: any) => m.status === "landed");
      if (landed) {
        return `好的，这一步已经记下了。请点击右侧【确认】把它写入看板，然后我们继续下一步。`;
      }
      if (firstEmpty) {
        return `继续推进这一步「${firstEmpty.slot.label}」：请用一两句话具体说说你的想法。`;
      }
      return "这个分论点的逻辑链已经完整。请确认完成后切换到下一个分论点（或完成第三步）。";
    }

    const plan = activeSubpoint.paragraphPlan;
    if (plan && Array.isArray(plan.pointBlocks)) {
      for (const block of plan.pointBlocks) {
        if (!Array.isArray(block?.steps)) continue;
        const pending = block.steps.find(
          (s: any) => !String(s?.value || "").trim(),
        );
        if (pending) {
          return `继续推进「${block.label || "分点"}」：请先回答这一步「${pending.label || "展开"}」的具体内容。`;
        }
      }
      return "这个分论点的关键步骤已基本齐全。要继续完善，我建议你补一句更有力度的收束句，或者告诉我现在切换到下一个分论点。";
    }

    if (Array.isArray(activeSubpoint.structureSteps)) {
      const pending = activeSubpoint.structureSteps.find(
        (s: any) => !String(s?.value || "").trim(),
      );
      if (pending) {
        return `我们继续当前链条：请完成「${pending.label || "下一步"}」这一步，用一句具体可论证的话表达。`;
      }
    }

    return "请基于这个分论点补充一个最关键的“为什么成立”的理由，我会据此继续向下一步（机制/举例/影响）推进。";
  }

  if (stepNum === 4) {
    return "请把你当前最薄弱的那一句先贴出来（主题句/解释句/例证句都可以），我先做一轮针对性升级。";
  }

  if (stepNum === 5) {
    return "请先选择你最想优先修正的一项（任务回应、逻辑连贯、词句准确性），我会按这一项给你可执行的改写动作。";
  }

  return "我们继续下一步：请基于当前内容补充一个最具体、最可展开的论证点。";
}

/** Extract A面/B面 section text from explore-stage userPoints. */
function extractStep2SideSection(userPoints: string, side: "A" | "B"): string {
  const text = String(userPoints || "");
  if (!text.trim()) return "";
  const sideRe =
    side === "A"
      ? /A面[^：:]*[：:]([\s\S]*?)(?=B面[^：:]*[：:]|$)/
      : /B面[^：:]*[：:]([\s\S]*)$/;
  return String(text.match(sideRe)?.[1] || "").trim();
}

/**
 * True when this explore side already has usable recorded content — so Momentum
 * must NOT keep asking for "尚未覆盖" points on an already-filled side.
 */
function sideHasSolidExploreContent(userPoints: string, side: "A" | "B"): boolean {
  const section = extractStep2SideSection(userPoints, side);
  if (!section) return false;
  if (/已选详写|已选略写|已展开|保留-略写/.test(section)) return true;
  const cleaned = section
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length >= 16) return true;
  const numbered = [
    ...section.matchAll(/(?:^|[；;\n])\s*\d+[.、．]\s*([^；;\n]+)/g),
  ]
    .map((m) => m[1].replace(/[（(][^）)]*[）)]/g, "").trim())
    .filter((s) => s.length >= 10);
  return numbered.length >= 1;
}

function isBlankString(v: any): boolean {
  return typeof v === "string" && v.trim() === "";
}

function isBlankStringArray(v: any): boolean {
  return Array.isArray(v) && v.every((item) => String(item || "").trim() === "");
}

function sanitizeProgressUpdateWithSession(
  progressUpdate: any,
  session: any,
): any {
  if (!progressUpdate || typeof progressUpdate !== "object") {
    return progressUpdate;
  }

  const step1New = progressUpdate?.step1Data;
  const step1Old = session?.step1?.coachEvaluation || {};
  const boardOverrides =
    session?.step1?.boardOverrides && typeof session.step1.boardOverrides === "object"
      ? session.step1.boardOverrides
      : {};
  if (step1New && typeof step1New === "object") {
    const step1StringKeys = [
      "correctType",
      "coreIssue",
      "critique",
      "writingTask",
      "keyQualifier",
    ];
    for (const key of step1StringKeys) {
      if (isBlankString(step1New[key]) && String(step1Old?.[key] || "").trim()) {
        delete step1New[key];
      }
    }
    const step1ArrayKeys = ["constraints", "suggestedDimensions"];
    for (const key of step1ArrayKeys) {
      if (
        isBlankStringArray(step1New[key]) &&
        Array.isArray(step1Old?.[key]) &&
        step1Old[key].length > 0
      ) {
        delete step1New[key];
      }
    }
    // User board edits always win over AI rewrites for the same fields.
    for (const [key, value] of Object.entries(boardOverrides)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && !String(value).trim()) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      step1New[key] = value;
    }
  }

  const step2New = progressUpdate?.step2Data;
  const step2Old = session?.step2?.coachEvaluation || {};
  if (step2New && typeof step2New === "object") {
    const step2StringKeys = [
      "currentStage",
      "userStance",
      "userPoints",
      "critique",
      "suggestedStance",
      "suggestedPoints",
      "positionCheckDesc",
      "coverageCheckDesc",
      "structureCheckDesc",
    ];
    for (const key of step2StringKeys) {
      if (isBlankString(step2New[key]) && String(step2Old?.[key] || "").trim()) {
        delete step2New[key];
      }
    }
    if (
      isBlankStringArray(step2New?.suggestions) &&
      Array.isArray(step2Old?.suggestions) &&
      step2Old.suggestions.length > 0
    ) {
      delete step2New.suggestions;
    }
  }

  return progressUpdate;
}

// Deterministic Step 1 constraint backfill (safety net for the slot-reuse skip rule).
// The "关键限定词" is a property of the essay QUESTION. When the student's answer
// echoes a scope qualifier that also exists in the question (e.g. answers coreIssue
// with "完全替代" while the prompt says "replace ... entirely"), we credit it into the
// constraints slot deterministically so the Coach never re-asks the qualifier question.
const STEP1_QUALIFIER_GROUPS: { label: string; zh: RegExp; en: RegExp }[] = [
  { label: "完全 (entirely)", zh: /完全|彻底|完整/, en: /\bentirely\b|\bcompletely\b|\bwholly\b/i },
  { label: "只/仅 (only)", zh: /仅|唯一/, en: /\bonly\b|\bsolely\b|\bexclusively\b/i },
  { label: "必须 (must)", zh: /必须|一定要/, en: /\bmust\b/i },
  { label: "始终 (always)", zh: /始终|一直|永远/, en: /\balways\b/i },
  { label: "所有 (all)", zh: /所有|全部|一切/, en: /\ball\b/i },
  { label: "从不 (never)", zh: /从不|绝不/, en: /\bnever\b/i },
];

/**
 * Scoped "all/所有" — bare "all" is noisy, but "all public places" / "所有公共场所"
 * is a real hard scope limit for IELTS Task 2.
 */
function questionHasScopedAll(question: string): boolean {
  const q = String(question || "");
  return (
    /\ball\s+(public\s+)?places?\b/i.test(q) ||
    /\ball\s+(public\s+)?(areas?|spaces?|venues?|buildings?|schools?|countries)\b/i.test(
      q,
    ) ||
    /所有[^。.\n]{0,16}(公共)?(场所|地方|空间|场合|建筑)/.test(q) ||
    /(公共)?(场所|地方|空间|场合)[^。.\n]{0,16}(所有|全部)/.test(q)
  );
}

type QuestionBrief = {
  questionType: string;
  writingDestination: string;
  taskMap: { explore_A: string; explore_B: string };
  hasHardQualifiers: boolean;
  hardQualifiers: string[];
  /** INTERNAL ONLY — neutral direction seeds for stuck follow-ups; never quote as preferred answers. */
  candidateDirectionSeeds: string[];
  /**
   * Whether this prompt asks for a personal stance / overall judgment.
   * false for pure what/why/how tasks (e.g. Problem/Solution, many Two-part).
   * When false, Step 2 skips the "stance" stage and goes explore_B → summary.
   */
  requiresStance: boolean;
};

/** Explicit opinion/judgment asks — not "what measures should" style wording. */
function hasExplicitStanceAsk(question: string): boolean {
  const q = String(question || "").toLowerCase();
  return (
    /to what extent|agree or disagree|do you agree|agree\/disagree|your opinion|your view|do you think/.test(
      q,
    ) ||
    /outweigh|positive or negative|positive.*negative|negative.*positive|is it a positive/.test(
      q,
    ) ||
    /同意|不同意|你的看法|利大于弊|弊大于利|积极还是消极|正面还是负面|你认为/.test(q)
  );
}

/**
 * Deterministic: does this essay require a personal stance / overall judgment?
 * Computed once in Step 1 via questionBrief; Step 2 must honor the skip.
 */
/** Canonicalize model/UI question-type labels (e.g. "Agree or Disagree"). */
function normalizeQuestionTypeLabel(raw: string): string {
  const t = String(raw || "").trim();
  if (!t) return "";
  const lower = t.toLowerCase().replace(/[／]/g, "/").replace(/\s+/g, " ");
  if (/^agree\s*(or|\/)\s*disagree$/.test(lower)) return "Agree / Disagree";
  if (/^discuss\s*both(\s*views)?$/.test(lower)) return "Discuss Both Views";
  if (/^positive\s*(or|\/)\s*negative$/.test(lower)) return "Positive / Negative";
  if (/^advantages?\s*(and|\/|&)\s*disadvantages?$/.test(lower)) {
    return "Advantages / Disadvantages";
  }
  if (/^problem\s*(and|\/|&|\+)\s*solution$/.test(lower)) return "Problem / Solution";
  if (/^two[-\s]?part(\s*question)?$/.test(lower)) return "Two-part Question";
  // Already canonical forms used in the codebase.
  if (
    t === "Agree / Disagree" ||
    t === "Discuss Both Views" ||
    t === "Positive / Negative" ||
    t === "Advantages / Disadvantages" ||
    t === "Problem / Solution" ||
    t === "Two-part Question" ||
    t === "Other"
  ) {
    return t;
  }
  return t;
}

function detectRequiresStance(question: string, questionType: string): boolean {
  const type = normalizeQuestionTypeLabel(questionType);
  if (type === "Agree / Disagree") return true;
  if (type === "Discuss Both Views") return true;
  if (type === "Positive / Negative") return true;
  if (type === "Advantages / Disadvantages") {
    // Pure "discuss advantages and disadvantages" → no forced stance;
    // outweigh / do you think → requires judgment.
    return hasExplicitStanceAsk(question);
  }
  if (type === "Problem / Solution") {
    return hasExplicitStanceAsk(question);
  }
  if (type === "Two-part Question" || type === "Other") {
    return hasExplicitStanceAsk(question);
  }
  // Unknown type: only ask stance if the prompt explicitly requests judgment.
  return hasExplicitStanceAsk(question);
}

function detectHardQualifiersInQuestion(question: string): string[] {
  const q = String(question || "");
  const labels: string[] = [];
  for (const group of STEP1_QUALIFIER_GROUPS) {
    if (group.label === "所有 (all)") {
      if (questionHasScopedAll(q)) labels.push(group.label);
      continue;
    }
    if (group.zh.test(q) || group.en.test(q)) labels.push(group.label);
  }
  return labels;
}

function inferQuestionTypeFromQuestion(question: string, knownType?: string): string {
  const known = normalizeQuestionTypeLabel(String(knownType || "").trim());
  if (known) return known;

  const q = String(question || "").toLowerCase();
  const hasCauses = /\bcauses?\b|\breasons?\b|\bwhy\b|原因|为何/.test(q);
  const hasSolutions =
    /\bsolutions?\b|\bmeasures?\b|\bhow (can|should|could)\b|解决|措施/.test(q);
  const hasPosNeg =
    /positive or negative|positive.*negative|negative.*positive|is it a positive|利弊|积极还是消极|正面还是负面/.test(
      q,
    );
  const hasAgree =
    /to what extent|agree or disagree|do you agree|agree\/disagree|同意/.test(q);
  const hasBothViews =
    /discuss both|both views|both sides|讨论双方|双方观点/.test(q);
  const hasAdvDis =
    /advantages? and disadvantages?|outweigh|利大于弊|优缺点/.test(q);
  const hasOther =
    /who should (fund|pay|be responsible)|whose responsibility|谁应该|谁来出资|谁负责/.test(
      q,
    );

  // Cause + solution is Problem/Solution (not Two-part).
  if (hasCauses && hasSolutions) return "Problem / Solution";
  // Cause + positive/negative (or pure P/N) maps to Positive / Negative for stage mapping.
  if (hasPosNeg) return "Positive / Negative";
  if (hasCauses && !hasSolutions && !hasPosNeg) return "Problem / Solution";
  if (hasAgree) return "Agree / Disagree";
  if (hasBothViews) return "Discuss Both Views";
  if (hasAdvDis) return "Advantages / Disadvantages";
  if (hasOther) return "Other";
  // Two distinct question marks / "and" dual tasks without the above → Two-part.
  const qMarks = (String(question || "").match(/\?/g) || []).length;
  if (qMarks >= 2) return "Two-part Question";
  return "Agree / Disagree";
}

function buildQuestionBrief(question: string, knownType?: string): QuestionBrief {
  const questionType = inferQuestionTypeFromQuestion(question, knownType);
  const hardQualifiers = detectHardQualifiersInQuestion(question);
  const hasHardQualifiers = hardQualifiers.length > 0;

  let writingDestination = "完成 Task 2 要求的立场与论证交付";
  let taskMap = {
    explore_A: "一方观点/论据",
    explore_B: "另一方观点/论据",
  };
  let candidateDirectionSeeds = [
    "具体场景/人群",
    "机制或因果链条",
  ];

  if (questionType === "Problem / Solution") {
    writingDestination = "解释问题成因，并提出对应解决措施";
    taskMap = { explore_A: "原因/成因", explore_B: "解决措施" };
    candidateDirectionSeeds = ["驱动机制（谁在推动、怎么发生）", "受影响的具体人群/场景"];
  } else if (questionType === "Positive / Negative") {
    const q = String(question || "").toLowerCase();
    const hasCauses = /\bcauses?\b|\breasons?\b|\bwhy\b|原因/.test(q);
    writingDestination = hasCauses
      ? "先解释现象成因，再对这一发展作出积极/消极判定"
      : "对这一现象/发展作出积极或消极判定，并给出可写的支撑";
    taskMap = {
      explore_A: hasCauses ? "原因/成因" : "现象分析（主任务）",
      explore_B: "评价侧：分别收集积极角度与消极角度",
    };
    candidateDirectionSeeds = [
      "积极面：具体受益者/场景",
      "消极面：具体受损者/场景",
    ];
  } else if (questionType === "Two-part Question") {
    writingDestination = "分别完成题目中的两个写作任务";
    taskMap = { explore_A: "第一问任务", explore_B: "第二问任务" };
  } else if (questionType === "Discuss Both Views") {
    writingDestination = "讨论双方观点，并给出自己的立场";
    taskMap = { explore_A: "观点A", explore_B: "观点B" };
  } else if (questionType === "Advantages / Disadvantages") {
    writingDestination = "分析利弊，并按题目要求给出权衡或结论";
    taskMap = { explore_A: "优点/利", explore_B: "缺点/弊" };
  } else if (questionType === "Agree / Disagree") {
    writingDestination = "明确同意/不同意程度，并用论据支撑";
    // explore_B = fill missing coverage buckets (not a forced opposing side)
    taskMap = {
      explore_A: "主论据平行展开",
      explore_B: "补齐缺失材料类别（若有）",
    };
  } else if (questionType === "Other") {
    writingDestination = "按题目实际设问完成写作任务（非标准题型）";
    taskMap = { explore_A: "第一核心任务", explore_B: "第二核心任务（若有）" };
  }

  const requiresStance = detectRequiresStance(question, questionType);

  return {
    questionType,
    writingDestination,
    taskMap,
    hasHardQualifiers,
    hardQualifiers,
    candidateDirectionSeeds,
    requiresStance,
  };
}

function formatQuestionBriefForPrompt(brief: QuestionBrief): string {
  return `=== INTERNAL questionBrief (NEVER quote, paraphrase, or reveal to the student) ===
questionType: ${brief.questionType}
writingDestination: ${brief.writingDestination}
taskMap.explore_A: ${brief.taskMap.explore_A}
taskMap.explore_B: ${brief.taskMap.explore_B}
hasHardQualifiers: ${brief.hasHardQualifiers ? "true" : "false"}
hardQualifiers: ${brief.hardQualifiers.length > 0 ? brief.hardQualifiers.join("; ") : "(none)"}
requiresStance: ${brief.requiresStance ? "true" : "false"}
candidateDirectionSeeds (INTERNAL ONLY — when student is stuck after one shallow answer, turn into TWO neutral candidate directions; NEVER present as preferred/better answers): ${brief.candidateDirectionSeeds.join(" | ")}
evalNote usage (INTERNAL): if the student's claim is already a direct result of the essay phenomenon, treat logicValid=true and only ask for a concrete scene when exampleReady=false. Never announce evaluative conclusions the student has not stated.
===============================================================================`;
}

function buildOverviewStance(brief: QuestionBrief): string {
  const a = brief.taskMap.explore_A || "第一任务";
  const b = brief.taskMap.explore_B || "第二任务";
  return `本文按题目两个任务展开：先写「${a}」，再写「${b}」。`;
}

// ---------------------------------------------------------------------------
// Cross-step memory digests (stable digest + sourceHash + invalidation)
// Rebuild ONLY when canonical source fields change. boardOverrides always
// participate in the Step1 hash so user board edits invalidate stale digests.
// questionBrief is intentionally NOT cached (cheap deterministic rules).
// ---------------------------------------------------------------------------

function stableHash(input: string): string {
  // djb2 — fast, deterministic, good enough for cache keys (not crypto).
  let h = 5381;
  const s = String(input || "");
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

function normalizeStringList(arr: any): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((d: any) => String(d || "").trim())
    .filter((d: string) => d.length > 0);
}

function getMergedStep1Eval(session: any): Record<string, any> {
  const eval1 = session?.step1?.coachEvaluation || {};
  const overrides =
    session?.step1?.boardOverrides && typeof session.step1.boardOverrides === "object"
      ? session.step1.boardOverrides
      : {};
  return { ...eval1, ...overrides };
}

function computeStep1SourceHash(session: any, question: string): string {
  const merged = getMergedStep1Eval(session);
  const payload = [
    String(question || "").trim(),
    String(merged.correctType || "").trim(),
    String(merged.coreIssue || "").trim(),
    normalizeStringList(merged.constraints).join("|"),
    normalizeStringList(merged.suggestedDimensions).join("|"),
    session?.step1?.isCompleted ? "1" : "0",
  ].join("\n");
  return stableHash(payload);
}

function buildStep1Digest(session: any, question: string): any {
  const merged = getMergedStep1Eval(session);
  const questionType = String(merged.correctType || "").trim();
  const coreIssue = String(merged.coreIssue || "").trim();
  const constraints = normalizeStringList(merged.constraints);
  const dimensions = normalizeStringList(merged.suggestedDimensions);
  const filled: string[] = [];
  const openGaps: string[] = [];
  if (questionType) filled.push("correctType");
  else openGaps.push("correctType");
  if (coreIssue) filled.push("coreIssue");
  else openGaps.push("coreIssue");
  if (
    isRealConstraintList(constraints) ||
    merged.constraintsSkipped === true
  ) {
    filled.push("constraints");
  } else {
    openGaps.push("constraints");
  }
  if (countEffectiveStep1Dimensions(dimensions) >= STEP1_DIM_MIN_EFFECTIVE) {
    filled.push("suggestedDimensions");
  } else {
    openGaps.push("suggestedDimensions");
  }

  return {
    sourceHash: computeStep1SourceHash(session, question),
    updatedAt: new Date().toISOString(),
    questionType,
    coreIssue,
    constraints,
    dimensions,
    openGaps,
    filled,
  };
}

function computeStep2SourceHash(session: any, question: string): string {
  const eval2 = session?.step2?.coachEvaluation || {};
  const blueprint = eval2.blueprint || session?.step2?.blueprint || {};
  const bodies = Array.isArray(blueprint.bodies) ? blueprint.bodies : [];
  const body1 = String(
    bodies[0]?.content || bodies[0]?.title || blueprint.body1 || "",
  ).trim();
  const body2 = String(
    bodies[1]?.content || bodies[1]?.title || blueprint.body2 || "",
  ).trim();
  const payloadFp = plannerPayloadFingerprint(eval2.plannerPayload);
  const payload = [
    String(question || "").trim(),
    String(eval2.currentStage || session?.step2?.currentStage || "").trim(),
    String(eval2.userStance || session?.step2?.userStance || "").trim(),
    String(eval2.userPoints || session?.step2?.userPoints || "").trim(),
    String(blueprint.position || eval2.suggestedStance || "").trim(),
    body1,
    body2,
    payloadFp,
    session?.step2?.isCompleted ? "1" : "0",
  ].join("\n");
  return stableHash(payload);
}

/**
 * Explore is finished only when there is enough parallel material (or student
 * signals exhaustion) AND no Step1 dimension is still pending.
 * Empty coverage buckets alone must NOT unlock stance.
 */
function isStep2ExploreDone(args: {
  payload: any;
  step2Data?: any;
  session?: any;
  userMessage?: string;
}): boolean {
  const exhausted =
    typeof args.userMessage === "string" &&
    studentSignalsExhausted(args.userMessage);

  const dispositions =
    args.step2Data?.dimensionDispositions ||
    args.session?.step2?.coachEvaluation?.dimensionDispositions ||
    args.payload?.dimensionDispositions ||
    [];

  // Primary gate: every checklist slot walked (content + 详略 / drop / merge).
  // Coverage buckets alone must NOT unlock stance.
  if (
    isStep2ChecklistWalkDone(args.payload, dispositions, { exhausted })
  ) {
    // Block while single-side capacity trim awaits confirm
    const trim = args.payload?.pendingCapacityTrim;
    if (
      trim?.sideKey &&
      Array.isArray(trim.pointClaims) &&
      trim.pointClaims.length >= 3
    ) {
      return false;
    }
    return true;
  }

  // No frozen slots yet: keep legacy floor (≥2 ready) so early explore can move.
  // seedOnly Step1 sprouts do not count as walk-ready.
  const readyCount = activePoints(args.payload).filter((p) =>
    isPointExpandedForWalk(p),
  ).length;
  const hasFixed =
    Boolean(args.payload?.slotsLocked) ||
    (Array.isArray(args.payload?.fixedClaims) &&
      args.payload.fixedClaims.length > 0);
  if (!hasFixed) {
    if (readyCount < 2 && !exhausted) return false;
    if (Array.isArray(dispositions) && dispositions.length > 0) {
      const pending = dispositions.some(
        (d: any) => String(d?.disposition || "").trim() === "pending",
      );
      if (pending) return false;
    }
    return readyCount >= 2 || exhausted;
  }

  return false;
}

/**
 * When checklist asks 详写/略写 and student replies with a short choice,
 * stamp tags (supports「详细写1」/ pair brief siblings). Prefer normalize intent path.
 */
function applyStep2InlineChecklistRetention(
  data: any,
  session: any,
  userMessage?: string,
): void {
  if (!data?.progressUpdate?.step2Data) return;
  const msg = String(userMessage || "").trim();
  if (!msg || msg.length > 40) return;
  const parsed = parseRetentionChoiceMessage(msg);
  if (!parsed) return;

  const step2 = data.progressUpdate.step2Data;
  const payload =
    step2.plannerPayload ||
    session?.step2?.coachEvaluation?.plannerPayload ||
    null;
  const dispositions =
    step2.dimensionDispositions ||
    session?.step2?.coachEvaluation?.dimensionDispositions ||
    payload?.dimensionDispositions ||
    [];
  const unwalked = listUnwalkedChecklistPoints(payload, dispositions).filter(
    (u) => u.reason === "needs_retention",
  );
  // Still allow stamping even if already partially settled (pair brief)
  const activePts = activePoints(payload);
  if (!activePts.length) return;

  const activeId = String(payload?.activePointId || "").trim();
  const target =
    (parsed.targetIndex
      ? activePts[parsed.targetIndex - 1]
      : undefined) ||
    (activeId ? activePts.find((p) => p.id === activeId) : undefined) ||
    (unwalked[0]
      ? activePts.find((p) => p.id === unwalked[0].id)
      : undefined) ||
    activePts.find((p) => p.quality === "ready") ||
    activePts[0];
  if (!target?.claim) return;

  let prevPoints = String(
    step2.userPoints ||
      session?.step2?.coachEvaluation?.userPoints ||
      "",
  );
  if (parsed.role === "both_detail") {
    for (const p of activePts) {
      if (p.quality !== "ready" && String(p.elaboration || "").trim().length < 8) {
        continue;
      }
      prevPoints = stampRetentionTagOnUserPoints(prevPoints, p.claim, "detail");
    }
    step2.userPoints = prevPoints;
    console.warn(`[Step2Checklist] Inline retention → both_detail`);
    return;
  }
  const role =
    parsed.role === "drop"
      ? "dropped"
      : parsed.role === "brief"
        ? "brief"
        : "detail";
  prevPoints = stampRetentionTagOnUserPoints(prevPoints, target.claim, role);
  // Do NOT silently brief siblings — remaining needs_retention points are asked next.
  step2.userPoints = prevPoints;
  if (Array.isArray(step2.dimensionDispositions)) {
    step2.dimensionDispositions = step2.dimensionDispositions.map((d: any) => {
      const dim = String(d?.dimension || "").trim();
      if (!dim || !headsCompatible(dim, target.claim)) return d;
      if (d.disposition === "pending") {
        return { ...d, disposition: "expanded", note: "inline_retention" };
      }
      return d;
    });
  }
  console.warn(
    `[Step2Checklist] Inline retention → ${role} on 「${target.claim}」 idx=${parsed.targetIndex || "-"}`,
  );
}

async function classifyStep2StudentTurnLive(args: {
  userMessage: string;
  coachAsk: string;
  boardClaims: string[];
  hasPendingSlotAdd: boolean;
  pendingSlotClaim?: string;
  decision?: { type?: string; action?: string; claim?: string } | null;
}): Promise<Step2StudentTurnIntent> {
  const fromDecision = intentFromStructuredDecision(args.decision);
  if (fromDecision) return fromDecision;

  const heuristic = classifyStep2StudentTurnHeuristic({
    userMessage: args.userMessage,
    hasPendingSlotAdd: args.hasPendingSlotAdd,
    coachAsk: args.coachAsk,
  });
  // High-confidence structural cases — skip LLM
  if (
    heuristic.kind === "meta_process" ||
    heuristic.kind === "retention_choice" ||
    heuristic.kind === "accept_slot_add" ||
    heuristic.kind === "reject_slot_add" ||
    heuristic.kind === "confirm_ack" ||
    heuristic.confidence >= 0.9
  ) {
    return heuristic;
  }

  const msg = String(args.userMessage || "").trim();
  if (!msg || msg.length < 4) return heuristic;

  try {
    const prompt = buildStep2StudentTurnIntentPrompt({
      userMessage: msg,
      coachAsk: args.coachAsk,
      boardClaims: args.boardClaims,
      hasPendingSlotAdd: args.hasPendingSlotAdd,
      pendingSlotClaim: args.pendingSlotClaim,
    });
    const response = await generateContentWithFallback({
      contents: prompt,
      config: {
        temperature: 0.1,
        maxOutputTokens: 1024,
        responseMimeType: "application/json",
      },
    });
    const parsed = parseStep2StudentTurnIntentLlm(String(response?.text || ""));
    if (parsed && parsed.kind !== "unknown") {
      console.log(
        `[Step2TurnIntent] llm kind=${parsed.kind} conf=${parsed.confidence}`,
      );
      return parsed;
    }
  } catch (err) {
    console.warn("[Step2TurnIntent] LLM classify failed; using heuristic", err);
  }
  return heuristic;
}

/**
 * Normalize Step2 → Planner payload every turn; stamp onto step2Data.
 * Advances stage only when checklist walk is done (not mere bucket coverage).
 * Hard rule: never enter stance/summary until explore is done.
 */
async function applyStep2PlannerPayloadNormalize(
  question: string,
  data: any,
  session: any,
  userMessage?: string,
  options?: {
    isHiddenKickoff?: boolean;
    decision?: { type?: string; action?: string; claim?: string } | null;
  },
): Promise<void> {
  if (!data?.progressUpdate || typeof data.progressUpdate !== "object") return;
  if (
    !data.progressUpdate.step2Data ||
    typeof data.progressUpdate.step2Data !== "object"
  ) {
    data.progressUpdate.step2Data = {};
  }
  const step2 = data.progressUpdate.step2Data;
  const knownType =
    String(session?.step1?.coachEvaluation?.correctType || "").trim() ||
    String(session?.step1?.boardOverrides?.questionType || "").trim() ||
    undefined;
  const brief = buildQuestionBrief(question, knownType);

  // Lock confirmed 详写/略写 tags across model userPoints rewrites unless student asks.
  const prevUserPoints = String(
    session?.step2?.coachEvaluation?.userPoints ||
      session?.step2?.userPoints ||
      "",
  );
  // Anti-forgery FIRST: the model may never mint locked 详写/略写/放弃 tags
  // itself — new locks only enter via server stamps after a confirmed
  // decision (which run later in this pipeline). Applies even when the user
  // requests a retention change: their change is stamped server-side too.
  const incomingUserPoints = stripForgedRetentionLocks(
    prevUserPoints,
    String(step2.userPoints || prevUserPoints || ""),
  );
  const allowRetentionChange =
    typeof userMessage === "string" &&
    userMessageRequestsRetentionChange(userMessage);
  const lockedUserPoints = preserveLockedRetentionInUserPoints(
    prevUserPoints,
    incomingUserPoints,
    { allowUserChange: allowRetentionChange },
  );
  if (lockedUserPoints && lockedUserPoints !== incomingUserPoints) {
    step2.userPoints = lockedUserPoints;
    console.warn(
      "[Step2RetentionLock] Restored confirmed 详写/略写 tags onto userPoints (system rewrite blocked).",
    );
  } else if (lockedUserPoints) {
    step2.userPoints = lockedUserPoints;
  }

  const exhausted =
    typeof userMessage === "string" && studentSignalsExhausted(userMessage);
  const forceExitUsed = Boolean(
    exhausted ||
      step2.plannerPayload?.exitGate?.forceExitUsed ||
      session?.step2?.coachEvaluation?.plannerPayload?.exitGate?.forceExitUsed,
  );

  const prevFp = plannerPayloadFingerprint(
    session?.step2?.coachEvaluation?.plannerPayload,
  );

  const lastCoachAsk = String(step2._lastCoachAsk || "").trim();
  const prevPayload = session?.step2?.coachEvaluation?.plannerPayload;
  const boardClaimRaw = [
    ...(Array.isArray(prevPayload?.fixedClaims) ? prevPayload.fixedClaims : []),
    ...(Array.isArray(prevPayload?.points)
      ? prevPayload.points
          .filter((p: any) => p && !p.supersededBy)
          .map((p: any) => String(p.claim || ""))
      : []),
  ].filter(Boolean);
  const boardClaims: string[] = [];
  const boardSeen = new Set<string>();
  for (const c of boardClaimRaw) {
    const key = claimMatchCore(c) || c;
    if (!key || boardSeen.has(key)) continue;
    if (boardClaims.some((x) => headsCompatible(claimMatchCore(x) || x, key))) {
      continue;
    }
    boardSeen.add(key);
    boardClaims.push(c);
  }

  let studentTurnIntent: Step2StudentTurnIntent;
  if (options?.isHiddenKickoff) {
    studentTurnIntent = {
      kind: "confirm_ack",
      confidence: 1,
      source: "heuristic",
    };
  } else {
    studentTurnIntent = await classifyStep2StudentTurnLive({
      userMessage: typeof userMessage === "string" ? userMessage : "",
      coachAsk: lastCoachAsk,
      boardClaims,
      hasPendingSlotAdd: Boolean(prevPayload?.pendingSlotAdd?.claim),
      pendingSlotClaim: prevPayload?.pendingSlotAdd?.claim,
      decision: options?.decision || null,
    });
  }
  if (studentTurnIntent.kind !== "unknown") {
    console.log(
      `[Step2TurnIntent] kind=${studentTurnIntent.kind} source=${studentTurnIntent.source}`,
    );
  }
  // Expose to post-process (block false slot-add after meta turns)
  (step2 as any)._studentTurnIntent = studentTurnIntent;

  const payload = normalizeStep2PlannerPayload({
    session: {
      ...session,
      step2: {
        ...session?.step2,
        coachEvaluation: {
          ...(session?.step2?.coachEvaluation || {}),
          ...step2,
        },
      },
    },
    step2Data: step2,
    questionType: brief.questionType,
    requiresStance: brief.requiresStance,
    forceExitUsed,
    userMessage: typeof userMessage === "string" ? userMessage : undefined,
    coachText: lastCoachAsk,
    isHiddenKickoff: Boolean(options?.isHiddenKickoff),
    decision: options?.decision || null,
    studentTurnIntent,
  });

  step2.plannerPayload = payload;
  // Keep pending new-slot marker in userPoints when awaiting confirm
  if (payload.pendingSlotAdd?.claim) {
    const base = stripPendingSlotAddMarker(
      String(step2.userPoints || prevUserPoints || ""),
    );
    step2.userPoints =
      `${base} ${formatPendingSlotAddMarker(payload.pendingSlotAdd)}`.trim();
  } else {
    // Accept or reject (or no pending) → strip marker
    const stripped = stripPendingSlotAddMarker(
      String(step2.userPoints || prevUserPoints || ""),
    );
    if (stripped !== String(step2.userPoints || "").trim()) {
      step2.userPoints = stripped;
    }
  }
  // Never keep English polished points in the material contract
  step2.suggestedPoints = "";
  // Mirror coverage into legacy check fields for UI
  if (payload.coverage) {
    step2.coverageCheckPassed = payload.coverage.passed;
    step2.coverageCheckDesc = payload.exitGate.blockReason
      ? payload.exitGate.blockReason
      : payload.coverage.passed
        ? "材料类别已覆盖题型硬性要求"
        : "材料类别尚未齐备";
  }

  let stage = String(
    step2.currentStage ||
      session?.step2?.coachEvaluation?.currentStage ||
      "explore_A",
  ).trim();

  const missing = payload.coverage?.missingBuckets || [];
  const readyCount = activePoints(payload).filter((p) =>
    isPointExpandedForWalk(p),
  ).length;
  const exploreDone = isStep2ExploreDone({
    payload,
    step2Data: step2,
    session,
    userMessage,
  });
  const unwalked = listUnwalkedChecklistPoints(
    payload,
    step2.dimensionDispositions || payload.dimensionDispositions,
  );

  // explore_A → explore_B when A-side walked or soft missing buckets remain.
  // Stance ONLY when checklist walk is done (not merely missingBuckets===[]).
  if (stage === "explore_A" && readyCount >= 1 && (missing.length > 0 || unwalked.some((u) => u.sideKey === "part_2" || u.sideKey === "view_b" || u.sideKey === "disadvantage" || u.sideKey === "solution" || u.sideKey === "negative"))) {
    stage = "explore_B";
    step2.currentStage = stage;
  } else if (
    (stage === "explore_A" || stage === "explore_B") &&
    exploreDone
  ) {
    stage = brief.requiresStance ? "stance" : "summary";
    step2.currentStage = stage;
    console.warn(
      `[Step2Payload] Checklist walk done → stage=${stage} (ready=${readyCount}, unwalked=${unwalked.length})`,
    );
  } else if (
    (stage === "stance" || stage === "summary") &&
    !exploreDone
  ) {
    // Model jumped ahead — clamp back until checklist finishes.
    stage = missing.length > 0 || unwalked.some((u) => /part_2|view_b|disadvantage|solution|negative/.test(u.sideKey))
      ? "explore_B"
      : "explore_A";
    step2.currentStage = stage;
    console.warn(
      `[Step2Payload] Blocked early stance/summary → clamped to ${stage} (ready=${readyCount}, unwalked=${unwalked.length})`,
    );
  }

  // Invalidate step2_5 when materials changed
  const nextFp = plannerPayloadFingerprint(payload);
  if (prevFp && nextFp && prevFp !== nextFp && session?.step2_5) {
    session.step2_5 = { ...session.step2_5, status: "stale" };
    console.warn("[Step2Payload] plannerPayload changed → step2_5 marked stale");
  }
}

function buildStep2Digest(session: any, question: string): any {
  const eval2 = session?.step2?.coachEvaluation || {};
  const blueprint = eval2.blueprint || session?.step2?.blueprint || {};
  const bodies = Array.isArray(blueprint.bodies) ? blueprint.bodies : [];
  const body1 = String(
    bodies[0]?.content || bodies[0]?.title || blueprint.body1 || "",
  ).trim();
  const body2 = String(
    bodies[1]?.content || bodies[1]?.title || blueprint.body2 || "",
  ).trim();
  const currentStage = String(
    eval2.currentStage || session?.step2?.currentStage || "explore_A",
  ).trim();
  const thesis = String(
    blueprint.position || eval2.suggestedStance || eval2.userStance || session?.step2?.userStance || "",
  ).trim();
  const userPoints = String(
    eval2.userPoints || session?.step2?.userPoints || "",
  ).trim();

  const filled: string[] = [];
  const openGaps: string[] = [];
  if (userPoints) filled.push("userPoints");
  else openGaps.push("userPoints");
  if (thesis) filled.push("thesis");
  else if (currentStage === "stance" || currentStage === "summary") {
    // Pure what/why tasks do not require a personal stance — skip thesis gap.
    const knownType =
      String(session?.step1?.coachEvaluation?.correctType || "").trim() ||
      undefined;
    const brief = buildQuestionBrief(question, knownType);
    if (brief.requiresStance) {
      openGaps.push("thesis");
    }
  }
  if (body1) filled.push("body1");
  if (body2) filled.push("body2");
  if (currentStage === "summary" && (!body1 || !body2)) {
    if (!body1) openGaps.push("body1");
    if (!body2) openGaps.push("body2");
  }

  return {
    sourceHash: computeStep2SourceHash(session, question),
    updatedAt: new Date().toISOString(),
    currentStage,
    thesis,
    userPoints,
    body1,
    body2,
    openGaps,
    filled,
  };
}

function computeStep3SourceHash(session: any, question: string): string {
  const subpoints = Array.isArray(session?.step3?.subpoints)
    ? session.step3.subpoints
    : [];
  const parts = subpoints.map((sp: any) => {
    const plan = sp?.paragraphPlan;
    const stepVals: string[] = [];
    if (plan?.totalClaim) stepVals.push(`tc:${String(plan.totalClaim).trim()}`);
    if (Array.isArray(plan?.pointBlocks)) {
      for (const block of plan.pointBlocks) {
        for (const step of block?.steps || []) {
          stepVals.push(
            `${String(step?.key || step?.label || "").trim()}=${String(step?.value || "").trim()}`,
          );
        }
      }
    } else if (Array.isArray(sp?.structureSteps)) {
      for (const step of sp.structureSteps) {
        stepVals.push(
          `${String(step?.key || step?.label || "").trim()}=${String(step?.value || "").trim()}`,
        );
      }
    }
    return [
      String(sp?.id || ""),
      String(sp?.content || "").trim(),
      String(plan?.mode || ""),
      sp?.isCompleted ? "1" : "0",
      stepVals.join(";"),
    ].join("|");
  });
  const payload = [
    String(question || "").trim(),
    String(session?.step3?.activeSubpointId || "").trim(),
    session?.step3?.isCompleted ? "1" : "0",
    parts.join("\n"),
  ].join("\n");
  return stableHash(payload);
}

function buildStep3Digest(session: any, question: string): any {
  const subpoints = Array.isArray(session?.step3?.subpoints)
    ? session.step3.subpoints
    : [];
  const activeId = String(session?.step3?.activeSubpointId || "").trim();
  const active =
    subpoints.find((sp: any) => sp.id === activeId) || subpoints[0] || null;
  const filled: string[] = [];
  const openGaps: string[] = [];
  let filledStepCount = 0;
  let totalStepCount = 0;

  const plan = active?.paragraphPlan;
  if (plan && Array.isArray(plan.pointBlocks)) {
    if (plan.mode === "total_then_points") {
      totalStepCount += 1;
      const tc = String(plan.totalClaim || "").trim();
      if (tc) {
        filledStepCount += 1;
        filled.push("totalClaim");
      } else {
        openGaps.push("totalClaim");
      }
    }
    for (const block of plan.pointBlocks) {
      const blockLabel = String(block?.subClaim || block?.label || "分点").trim();
      for (const step of block?.steps || []) {
        totalStepCount += 1;
        const label = String(step?.label || step?.key || "step").trim();
        if (isStep3Confirmed(step)) {
          filledStepCount += 1;
          filled.push(`${blockLabel}:${label}`);
        } else {
          openGaps.push(`${blockLabel}:${label}`);
        }
      }
    }
  } else if (Array.isArray(active?.structureSteps)) {
    for (const step of active.structureSteps) {
      totalStepCount += 1;
      const label = String(step?.label || step?.key || "step").trim();
      if (isStep3Confirmed(step)) {
        filledStepCount += 1;
        filled.push(label);
      } else {
        openGaps.push(label);
      }
    }
  }

  return {
    sourceHash: computeStep3SourceHash(session, question),
    updatedAt: new Date().toISOString(),
    activeSubpointId: activeId,
    filledStepCount,
    totalStepCount,
    openGaps,
    filled,
  };
}

/**
 * Resolve digests from session.memory when sourceHash still matches;
 * otherwise rebuild. Returns { memory, rebuilt: string[] }.
 */
function resolveSessionMemory(
  session: any,
  question: string,
): { memory: any; rebuilt: string[] } {
  const prev = session?.memory && typeof session.memory === "object" ? session.memory : {};
  const rebuilt: string[] = [];
  const memory: any = {};

  const s1Hash = computeStep1SourceHash(session, question);
  if (prev.step1?.sourceHash === s1Hash && prev.step1) {
    memory.step1 = prev.step1;
  } else {
    memory.step1 = buildStep1Digest(session, question);
    rebuilt.push("step1");
  }

  const s2Hash = computeStep2SourceHash(session, question);
  if (prev.step2?.sourceHash === s2Hash && prev.step2) {
    memory.step2 = prev.step2;
  } else {
    memory.step2 = buildStep2Digest(session, question);
    rebuilt.push("step2");
  }

  const s3Hash = computeStep3SourceHash(session, question);
  if (prev.step3?.sourceHash === s3Hash && prev.step3) {
    memory.step3 = prev.step3;
  } else {
    memory.step3 = buildStep3Digest(session, question);
    rebuilt.push("step3");
  }

  return { memory, rebuilt };
}

/**
 * After progressUpdate mutates step data, merge into a virtual session and
 * rebuild digests so the client persists a fresh memory snapshot.
 */
function refreshMemoryAfterProgress(
  session: any,
  question: string,
  progressUpdate: any,
): any {
  const virtual = {
    ...(session || {}),
    step1: { ...(session?.step1 || {}) },
    step2: { ...(session?.step2 || {}) },
    step3: { ...(session?.step3 || {}) },
    memory: session?.memory,
  };

  if (progressUpdate?.step1Data && typeof progressUpdate.step1Data === "object") {
    const boardOverrides = session?.step1?.boardOverrides || {};
    virtual.step1.coachEvaluation = {
      ...(session?.step1?.coachEvaluation || {}),
      ...progressUpdate.step1Data,
      ...boardOverrides,
    };
    if (progressUpdate.isCompleted === true) virtual.step1.isCompleted = true;
    if (progressUpdate.isCompleted === false) virtual.step1.isCompleted = false;
  }

  if (progressUpdate?.step2Data && typeof progressUpdate.step2Data === "object") {
    virtual.step2.coachEvaluation = {
      ...(session?.step2?.coachEvaluation || {}),
      ...progressUpdate.step2Data,
    };
    if (progressUpdate.step2Data.userStance) {
      virtual.step2.userStance = progressUpdate.step2Data.userStance;
    }
    if (progressUpdate.step2Data.userPoints) {
      virtual.step2.userPoints = progressUpdate.step2Data.userPoints;
    }
    if (progressUpdate.isCompleted === true) virtual.step2.isCompleted = true;
    if (progressUpdate.isCompleted === false) virtual.step2.isCompleted = false;
  }

  if (Number(progressUpdate?.step) === 3 || progressUpdate?.step3SecretarySubpoints) {
    // Step3 秘书路径：结构由服务器确定性落槽，LLM 不再输出 paragraphPlan /
    // step3SlotEval / step3SubpointSteps。虚拟 session 只需镜像服务器回传的
    // subpoints（含冻结骨架 + minutes + activeSlotIndex）。
    const activeId =
      session?.step3?.activeSubpointId ||
      (Array.isArray(session?.step3?.subpoints) && session.step3.subpoints[0]?.id) ||
      "";
    const subpoints = Array.isArray(progressUpdate.step3SecretarySubpoints)
      ? progressUpdate.step3SecretarySubpoints
      : Array.isArray(session?.step3?.subpoints)
        ? session.step3.subpoints.map((sp: any) => {
            if (sp.id !== activeId) return sp;
            const next = { ...sp };
            if (typeof progressUpdate.step3LastRejectCode === "string") {
              next.lastRejectCode = progressUpdate.step3LastRejectCode;
            }
            return next;
          })
        : [];
    virtual.step3 = {
      ...virtual.step3,
      subpoints,
      activeSubpointId: activeId,
      isCompleted:
        progressUpdate.isCompleted === true
          ? true
          : session?.step3?.isCompleted || false,
    };
  }

  // Force rebuild from virtual (ignore stale prev hashes for fields we just mutated).
  return {
    step1: buildStep1Digest(virtual, question),
    step2: buildStep2Digest(virtual, question),
    step3: buildStep3Digest(virtual, question),
  };
}

function formatMemoryDigestsForPrompt(memory: any): string {
  if (!memory || typeof memory !== "object") return "";
  const s1 = memory.step1;
  const s2 = memory.step2;
  const s3 = memory.step3;
  const lines: string[] = [
    "=== INTERNAL memory digests (stable; NEVER quote field names to the student) ===",
    "Use filled items as already-known — do NOT re-ask them. Ask ONLY about openGaps.",
  ];
  if (s1) {
    lines.push(
      `[step1Digest] type=${s1.questionType || "(empty)"} | coreIssue=${s1.coreIssue || "(empty)"} | constraints=${(s1.constraints || []).join("; ") || "(empty)"} | dimensions=${(s1.dimensions || []).join("; ") || "(empty)"}`,
    );
    lines.push(
      `  filled=[${(s1.filled || []).join(", ")}] openGaps=[${(s1.openGaps || []).join(", ")}]`,
    );
  }
  if (s2) {
    lines.push(
      `[step2Digest] stage=${s2.currentStage || "(empty)"} | thesis=${s2.thesis || "(empty)"} | body1=${s2.body1 || "(empty)"} | body2=${s2.body2 || "(empty)"}`,
    );
    lines.push(
      `  userPoints=${s2.userPoints || "(empty)"}`,
    );
    lines.push(
      `  filled=[${(s2.filled || []).join(", ")}] openGaps=[${(s2.openGaps || []).join(", ")}]`,
    );
  }
  if (s3) {
    lines.push(
      `[step3Digest] active=${s3.activeSubpointId || "(none)"} | steps=${s3.filledStepCount || 0}/${s3.totalStepCount || 0}`,
    );
    lines.push(
      `  filled=[${(s3.filled || []).join(", ")}] openGaps=[${(s3.openGaps || []).join(", ")}]`,
    );
  }
  lines.push("===============================================================================");
  return lines.join("\n");
}

const NO_HARD_QUALIFIER_MARKER = "无明显限定词";

function isNoHardQualifierMarker(value: any): boolean {
  return String(value || "").trim() === NO_HARD_QUALIFIER_MARKER;
}

/** True constraints only — the fake "无明显限定词" marker does not count. */
function isRealConstraintList(constraints: any): boolean {
  if (!Array.isArray(constraints)) return false;
  return constraints.some((c) => {
    const s = String(c || "").trim();
    return !!s && !isNoHardQualifierMarker(s);
  });
}

function detectEchoedQualifiers(question: string, userText: string): string[] {
  const q = String(question || "");
  const u = String(userText || "");
  const labels: string[] = [];
  const push = (label: string) => {
    if (label && !labels.includes(label)) labels.push(label);
  };

  for (const group of STEP1_QUALIFIER_GROUPS) {
    const inQuestion =
      group.label === "所有 (all)"
        ? questionHasScopedAll(q) || group.zh.test(q) || group.en.test(q)
        : group.zh.test(q) || group.en.test(q);
    const inUser = group.zh.test(u) || group.en.test(u);
    if (inQuestion && inUser) push(group.label);
  }

  // Cross-group: student says 完全/彻底 while question has scoped all.
  const qHasAll = questionHasScopedAll(q) || /\ball\b/i.test(q);
  const qHasEntirely =
    /完全|彻底|完整/.test(q) || /\bentirely\b|\bcompletely\b|\bwholly\b/i.test(q);
  const uHasEntirely = /完全|彻底/.test(u);
  const uHasAll = /所有|全部|一切/.test(u);
  if (uHasEntirely && (qHasAll || qHasEntirely)) {
    push("完全 (entirely)");
    if (qHasAll || questionHasScopedAll(q)) push("所有 (all)");
  }
  if (uHasAll && (qHasAll || qHasEntirely)) {
    push("所有 (all)");
  }

  return labels;
}

// Returns the labels backfilled (empty if nothing was filled).
function backfillStep1Constraints(
  question: string,
  userMessage: string,
  progressUpdate: any,
  session: any,
): string[] {
  if (!progressUpdate || typeof progressUpdate !== "object") return [];
  const step1New =
    progressUpdate.step1Data && typeof progressUpdate.step1Data === "object"
      ? progressUpdate.step1Data
      : null;
  const step1Old = session?.step1?.coachEvaluation || {};

  const newConstraints = step1New?.constraints;
  const oldConstraints = step1Old?.constraints;
  // Fake marker must not block real qualifier backfill.
  const alreadyFilled =
    isRealConstraintList(newConstraints) || isRealConstraintList(oldConstraints);
  if (alreadyFilled) return [];

  const effectiveCoreIssue = String(
    step1New?.coreIssue || step1Old?.coreIssue || "",
  );
  const scanText = `${userMessage} ${effectiveCoreIssue}`;
  const labels = detectEchoedQualifiers(question, scanText);
  if (labels.length === 0) return [];

  const target = step1New || {};
  target.constraints = labels;
  target.constraintsSkipped = false;
  if (isBlankString(target.keyQualifier) || target.keyQualifier === undefined) {
    if (!String(step1Old?.keyQualifier || "").trim()) {
      target.keyQualifier = labels[0];
    }
  }
  progressUpdate.step1Data = target;
  return labels;
}

/**
 * Deterministic safety net for questionBrief.hasHardQualifiers=false:
 * when the essay question has no hard scope qualifiers and coreIssue is already
 * filled, silently mark constraints as skipped (empty array) — NEVER write the
 * student-visible "无明显限定词" marker.
 * Returns true when the skip was applied this turn.
 */
function applyNoHardQualifierGate(
  question: string,
  progressUpdate: any,
  session: any,
): boolean {
  if (!progressUpdate || typeof progressUpdate !== "object") return false;

  const knownType =
    String(progressUpdate?.step1Data?.correctType || "").trim() ||
    String(session?.step1?.coachEvaluation?.correctType || "").trim() ||
    undefined;
  const brief = buildQuestionBrief(question, knownType);

  const step1New =
    progressUpdate.step1Data && typeof progressUpdate.step1Data === "object"
      ? progressUpdate.step1Data
      : null;
  const step1Old = session?.step1?.coachEvaluation || {};

  const coreIssue = String(step1New?.coreIssue || step1Old?.coreIssue || "").trim();
  if (!coreIssue) return false;

  // Prefer real echoed qualifiers even when brief missed them (e.g. all/完全).
  const scanText = `${coreIssue}`;
  const echoed = detectEchoedQualifiers(question, scanText);
  if (echoed.length > 0) {
    const target = step1New || {};
    if (!isRealConstraintList(target.constraints)) {
      target.constraints = echoed;
      target.constraintsSkipped = false;
      if (!String(target.keyQualifier || step1Old?.keyQualifier || "").trim()) {
        target.keyQualifier = echoed[0];
      }
      progressUpdate.step1Data = target;
    }
    return false;
  }

  if (brief.hasHardQualifiers) return false;

  if (isRealConstraintList(step1New?.constraints) || isRealConstraintList(step1Old?.constraints)) {
    return false;
  }
  if (step1New?.constraintsSkipped === true || step1Old?.constraintsSkipped === true) {
    return false;
  }

  const target = step1New || {};
  // Strip fake marker if the model wrote it; keep constraints empty + skipped.
  target.constraints = [];
  target.constraintsSkipped = true;
  progressUpdate.step1Data = target;
  return true;
}

/** Strip student-visible fake marker from constraints if the model still emits it. */
function sanitizeStep1ConstraintMarkers(progressUpdate: any): void {
  const step1 = progressUpdate?.step1Data;
  if (!step1 || !Array.isArray(step1.constraints)) return;
  const cleaned = step1.constraints
    .map((c: any) => String(c || "").trim())
    .filter((c: string) => c && !isNoHardQualifierMarker(c));
  if (cleaned.length !== step1.constraints.length) {
    step1.constraints = cleaned;
    if (cleaned.length === 0 && step1.constraintsSkipped !== false) {
      step1.constraintsSkipped = true;
    }
    console.warn(
      "[Step1Guard] Stripped student-visible '无明显限定词' marker from constraints.",
    );
  }
}

/** Stamp taskMap / requiresStance onto step2Data every Step 2 turn for the UI. */
function stampStep2TaskBrief(question: string, data: any, session: any): void {
  if (!data?.progressUpdate || typeof data.progressUpdate !== "object") return;
  const knownType =
    String(session?.step1?.coachEvaluation?.correctType || "").trim() ||
    String(session?.step1?.boardOverrides?.questionType || "").trim() ||
    undefined;
  const brief = buildQuestionBrief(question, knownType);
  if (
    !data.progressUpdate.step2Data ||
    typeof data.progressUpdate.step2Data !== "object"
  ) {
    data.progressUpdate.step2Data = {};
  }
  const step2 = data.progressUpdate.step2Data;
  step2.requiresStance = brief.requiresStance;
  step2.taskLabelA = brief.taskMap.explore_A;
  step2.taskLabelB = brief.taskMap.explore_B;
}

/**
 * Deterministic safety net for questionBrief.requiresStance=false:
 * when the essay does not ask for a personal stance, never linger in "stance".
 * Force explore_B → summary, auto-fill a neutral overview for blueprint.position,
 * and rewrite any accidental stance-choice question in Part 2.
 */
function applyNoStanceGate(
  question: string,
  data: any,
  session: any,
): boolean {
  if (!data?.progressUpdate || typeof data.progressUpdate !== "object") {
    return false;
  }
  const progressUpdate = data.progressUpdate;

  stampStep2TaskBrief(question, data, session);

  const knownType =
    String(session?.step1?.coachEvaluation?.correctType || "").trim() ||
    String(session?.step1?.boardOverrides?.questionType || "").trim() ||
    undefined;
  const brief = buildQuestionBrief(question, knownType);

  const step2New =
    progressUpdate.step2Data && typeof progressUpdate.step2Data === "object"
      ? progressUpdate.step2Data
      : null;
  if (!step2New) return false;

  if (brief.requiresStance) return false;

  const stage = String(
    step2New.currentStage ||
      session?.step2?.coachEvaluation?.currentStage ||
      "",
  ).trim();

  const overview = buildOverviewStance(brief);
  const existingStance = String(
    step2New.userStance ||
      session?.step2?.userStance ||
      session?.step2?.coachEvaluation?.userStance ||
      "",
  ).trim();

  let changed = false;

  // Skip stance stage entirely: explore_B / stance → summary.
  if (stage === "stance" || stage === "explore_B") {
    // Only auto-advance to summary when leaving explore_B if the model already
    // tried to enter stance, OR chat text is asking a stance-choice question.
    const chatAsksStance = looksLikeStanceChoiceQuestion(String(data.text || ""));
    if (stage === "stance" || chatAsksStance) {
      step2New.currentStage = "summary";
      changed = true;
    }
  }

  if (
    String(step2New.currentStage || "").trim() === "summary" ||
    stage === "stance"
  ) {
    if (!existingStance) {
      step2New.userStance = overview;
      changed = true;
    }
    if (!step2New.blueprint || typeof step2New.blueprint !== "object") {
      step2New.blueprint = {
        question: String(question || ""),
        position: existingStance || overview,
        bodies: [],
      };
      changed = true;
    } else if (!String(step2New.blueprint.position || "").trim()) {
      step2New.blueprint.position = existingStance || overview;
      changed = true;
    }
  }

  if (looksLikeStanceChoiceQuestion(String(data.text || ""))) {
    const split = splitTwoParts(String(data.text || ""), 1);
    const part1 = (split.part1 || "").trim();
    const repair =
      "两端论据已经够用了。这道题不需要单独选定一个「个人立场」，我们直接根据刚才的两点任务整理写作蓝图。";
    data.text = part1
      ? `${part1}\n\n---\n\n${repair}`
      : repair;
    if (String(step2New.currentStage || "").trim() !== "summary") {
      step2New.currentStage = "summary";
    }
    if (!String(step2New.userStance || "").trim()) {
      step2New.userStance = overview;
    }
    changed = true;
  }

  progressUpdate.step2Data = step2New;
  if (changed) {
    console.log(
      `[Step2NoStanceGate] requiresStance=false → stage=${step2New.currentStage}; overview filled=${!existingStance}`,
    );
  }
  return changed;
}

function looksLikeStanceChoiceQuestion(text: string): boolean {
  const t = String(text || "");
  if (!t.trim()) return false;
  // Numbered stance options / "确立你的整体立场" / "老师帮我推荐"
  return (
    /确立你的整体立场|最终更倾向于哪[一种种]立场|你最终更倾向于/.test(t) ||
    /老师帮我推荐一个/.test(t) ||
    (/①/.test(t) && /②/.test(t) && /立场/.test(t)) ||
    (/完全支持|完全同意|部分同意|完全不同意/.test(t) && /立场/.test(t))
  );
}

function looksLikeConstraintQuestion(part2: string): boolean {
  const t = String(part2 || "");
  return (
    /限制了讨论范围/.test(t) ||
    /限定词/.test(t) ||
    /(哪些词)[^。？?]{0,8}(限制|限定)/.test(t) ||
    /(限制|限定)[^。？?]{0,8}(讨论范围|范围)/.test(t)
  );
}

function mergeStep1Evaluation(progressUpdate: any, session: any): Record<string, any> {
  const newS1 =
    progressUpdate?.step1Data && typeof progressUpdate.step1Data === "object"
      ? progressUpdate.step1Data
      : {};
  const oldS1 = session?.step1?.coachEvaluation || {};
  return { ...oldS1, ...newS1 };
}

/** Shared: student signals they are done adding more material / want to advance. */
function studentSignalsExhausted(userMessage: string): boolean {
  const t = String(userMessage || "").trim();
  if (!t) return false;
  return /^(没有(更多|了)?|想不到(更多|了)?|想不出(更多|了)?|说完了|先这样|就这样|够了|可以了|先过|先跳过|先走|我不补充了|进入下一步|下一步|先进入下一步)[。.!！]?$/i.test(
    t,
  ) || /没有更多|想不出更多|想不到更多|说完了|先这样吧|就这些|没有别的了/.test(t);
}

const STEP1_DIM_EXPANDABLE_TAG = "可展开";
const STEP1_DIM_THIN_TAG = "空标签";
const STEP1_DIM_QUALITY_PENDING_TAG = "质量待确认";
const STEP1_DIM_PROBED_TAG = "已探测";
const STEP1_DIM_EXIT_OFFERED_TAG = "已询退出";
const STEP1_DIM_MAX = 6;
const STEP1_DIM_MIN_EFFECTIVE = 3;

/** Standalone status tags only — not mixed inside explanatory parentheses. */
const STEP1_DIM_STATUS_TAG_RE =
  /[（(]\s*(可展开|空标签|质量待确认|已探测|已询退出)\s*[）)]/g;

function stripStep1DimensionTags(dim: string): string {
  return String(dim || "")
    .replace(STEP1_DIM_STATUS_TAG_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasStandaloneStep1Tag(dim: string, tag: string): boolean {
  return new RegExp(`[（(]\\s*${tag}\\s*[）)]`).test(String(dim || ""));
}

/** Effective = probed AND explicitly tagged expandable (no legacy untagged shortcut). */
function isStep1DimensionExpandable(dim: string): boolean {
  const t = String(dim || "");
  if (!t.trim()) return false;
  if (hasStandaloneStep1Tag(t, STEP1_DIM_THIN_TAG)) return false;
  if (hasStandaloneStep1Tag(t, STEP1_DIM_QUALITY_PENDING_TAG)) return false;
  return (
    hasStandaloneStep1Tag(t, STEP1_DIM_EXPANDABLE_TAG) &&
    hasStandaloneStep1Tag(t, STEP1_DIM_PROBED_TAG)
  );
}

function countStep1DimensionLabels(dims: any): number {
  if (!Array.isArray(dims)) return 0;
  const seen = new Set<string>();
  for (const d of dims) {
    const core = stripStep1DimensionTags(String(d || "")).toLowerCase();
    if (core) seen.add(core);
  }
  return seen.size;
}

function countEffectiveStep1Dimensions(dims: any): number {
  if (!Array.isArray(dims)) return 0;
  const seen = new Set<string>();
  let n = 0;
  for (const d of dims) {
    const raw = String(d || "").trim();
    if (!raw) continue;
    if (!isStep1DimensionExpandable(raw)) continue;
    const core = stripStep1DimensionTags(raw).toLowerCase();
    if (!core || seen.has(core)) continue;
    seen.add(core);
    n += 1;
  }
  return n;
}

function step1DimsHaveExitOfferedTag(dims: any): boolean {
  if (!Array.isArray(dims)) return false;
  return dims.some((d) =>
    hasStandaloneStep1Tag(String(d || ""), STEP1_DIM_EXIT_OFFERED_TAG),
  );
}

function textOffersStep1Exit(text: string): boolean {
  const t = String(text || "");
  // Soft "continue or stop" ask — may mention Step 2 as an option, but is not
  // the hard completion CTA that unlocks the jump button alone.
  return /如果(暂时)?想不[到出]|如果没有(更多|别的|了)?|如果觉得足够|还能想到别的|还有别的角度吗|还有其他.{0,8}角度|没有了.*就.*第[二2]步|可以进入第[二2]步了|我们好进入下[一1]阶段/.test(
    t,
  );
}

function ensureStep1ExitOfferedFlag(step1Data: any, dims: any[]): void {
  if (!step1Data || typeof step1Data !== "object") return;
  step1Data.exitOffered = true;
  if (!Array.isArray(dims) || dims.length === 0) return;
  const last = String(dims[dims.length - 1] || "");
  if (!hasStandaloneStep1Tag(last, STEP1_DIM_EXIT_OFFERED_TAG)) {
    dims[dims.length - 1] = `${last}（${STEP1_DIM_EXIT_OFFERED_TAG}）`;
    step1Data.suggestedDimensions = dims;
  }
}

function isStep1ExitGateOpen(
  step1Eval: Record<string, any>,
  session: any,
  userMessage: string,
): boolean {
  if (step1Eval.exitOffered === true) return true;
  if (session?.step1?.coachEvaluation?.exitOffered === true) return true;
  if (step1DimsHaveExitOfferedTag(step1Eval.suggestedDimensions)) return true;
  if (studentSignalsExhausted(userMessage)) return true;
  if (countStep1DimensionLabels(step1Eval.suggestedDimensions) >= STEP1_DIM_MAX) {
    return true;
  }
  return false;
}

function collectStep1DimensionCores(dims: any): Set<string> {
  const seen = new Set<string>();
  if (!Array.isArray(dims)) return seen;
  for (const d of dims) {
    const core = stripStep1DimensionTags(String(d || "")).toLowerCase();
    if (core) seen.add(core);
  }
  return seen;
}

/** True when this turn introduced at least one new dimension label vs prior session. */
function step1HasNewlyIntroducedDimension(
  newDims: any,
  session: any,
): boolean {
  const oldCores = collectStep1DimensionCores(
    session?.step1?.coachEvaluation?.suggestedDimensions ||
      session?.step1?.boardOverrides?.suggestedDimensions,
  );
  const newCores = collectStep1DimensionCores(newDims);
  for (const c of newCores) {
    if (!oldCores.has(c)) return true;
  }
  return false;
}

function isStep1SlotsComplete(step1Eval: Record<string, any>): boolean {
  const hasType = String(step1Eval.correctType || "").trim().length > 0;
  const hasIssue = String(step1Eval.coreIssue || "").trim().length > 0;
  const hasConstraints =
    isRealConstraintList(step1Eval.constraints) ||
    step1Eval.constraintsSkipped === true;
  const dims = Array.isArray(step1Eval.suggestedDimensions)
    ? step1Eval.suggestedDimensions.map(String)
    : [];
  const effectiveCount = countEffectiveStep1Dimensions(dims);
  const capDone = step1CapProbeComplete(dims, STEP1_DIM_MAX);
  return (
    hasType &&
    hasIssue &&
    hasConstraints &&
    (effectiveCount >= STEP1_DIM_MIN_EFFECTIVE || capDone)
  );
}

/**
 * AI/server sufficiency: enough probed+expandable dimensions to stop diverging.
 * Cap-full + all probed is a deadlock relief even when effective < 3.
 */
function computeStep1DimensionsSufficient(step1Eval: Record<string, any>): boolean {
  const dims = Array.isArray(step1Eval?.suggestedDimensions)
    ? step1Eval.suggestedDimensions.map(String)
    : [];
  if (step1CapProbeComplete(dims, STEP1_DIM_MAX)) return true;
  const effective = countEffectiveStep1Dimensions(dims);
  if (effective < STEP1_DIM_MIN_EFFECTIVE) return false;
  if (step1Eval?.dimensionsSufficient === false) return false;
  return true;
}

function textSuggestsStep1Complete(text: string): boolean {
  const t = String(text || "");
  // Soft exit asks may say "就可以进入第二步了" — that is NOT the hard CTA.
  if (textOffersStep1Exit(t) && !/点击/.test(t)) {
    return false;
  }
  // Hard unlock: must tell student to click the next-step button.
  return (
    (/点击/.test(t) && /下一步/.test(t) && /进入第二步/.test(t)) ||
    (/点击/.test(t) && /下一步/.test(t) && /进入第二阶段/.test(t)) ||
    t.includes("恭喜通关审题") ||
    t.includes("四个审题要素都齐了")
  );
}

function textSuggestsStep2Complete(text: string): boolean {
  const t = String(text || "");
  return (
    t.includes("进入第三步") ||
    t.includes("进入第三阶段") ||
    t.includes("段落逻辑链构建") ||
    /进入\s*Step\s*3/i.test(t) ||
    t.includes("段落论证训练") ||
    t.includes("段落写作训练") ||
    (t.includes("下一步") && t.includes("第三步"))
  );
}

function textSuggestsStep3Complete(text: string): boolean {
  const t = String(text || "");
  // Hard whole-step CTAs (prompt-canonical).
  if (
    t.includes("第三步段落逻辑链构建已全部完成") ||
    t.includes("进入第四步：逐句写作练习") ||
    t.includes("进入第四阶段") ||
    t.includes("进入逐句写作") ||
    t.includes("进入逐句写作练习") ||
    (t.includes("进入第四步") && t.includes("写作"))
  ) {
    return true;
  }
  // Premature body/subpoint completion language the model often emits while
  // slots are still empty/draft, or while sibling bodies remain. Keep these
  // anchored to whole-chain / advance-CTA phrasing so mid-step confirms
  // ("我们完成了机制这一步") do not match.
  if (t.includes("大功告成")) return true;
  if (
    t.includes("点击下一步进入写作练习") ||
    t.includes("直接点击下一步进入写作练习") ||
    (t.includes("进入写作练习") &&
      (t.includes("下一步") || t.includes("点击")))
  ) {
    return true;
  }
  if (
    t.includes("切换到下一个主体段") ||
    t.includes("选项卡来切换到下一个主体段") ||
    (t.includes("选项卡") && t.includes("下一个主体段"))
  ) {
    return true;
  }
  if (
    (t.includes("完整逻辑链") || t.includes("逻辑链已经")) &&
    (t.includes("已经完成") ||
      t.includes("已完成") ||
      t.includes("完成了这个分论点") ||
      t.includes("完成了这个分论点的完整逻辑链") ||
      t.includes("补齐了") ||
      t.includes("补齐整"))
  ) {
    return true;
  }
  if (
    t.includes("这个分论点已经") &&
    (t.includes("完成") || t.includes("大功告成"))
  ) {
    return true;
  }
  if (
    t.includes("逻辑闭环诊断报告") &&
    (t.includes("完成") || t.includes("大功告成") || t.includes("下一步"))
  ) {
    return true;
  }
  // "逻辑链条/逻辑拼图...已经全部拼图完毕/拼好了" style claims — same premature
  // whole-chain completion signal as "大功告成", just phrased differently.
  if (
    (t.includes("逻辑链条") || t.includes("逻辑拼图")) &&
    (t.includes("拼图完毕") ||
      t.includes("拼好了") ||
      t.includes("拼完整") ||
      t.includes("全部拼图") ||
      t.includes("已经完成") ||
      t.includes("已完成"))
  ) {
    return true;
  }
  return false;
}

/**
 * When rewriting a premature-completion CTA, we normally keep the model's
 * own part1 (its acknowledgment/celebration) and only replace part2 (the
 * CTA) with a real ask. But if the false completion claim itself lives in
 * part1 (e.g. "这一段的逻辑链已经完全补齐了！" or "这句话已经填入右侧"),
 * keeping it verbatim would splice a corrected ask onto a still-contradictory
 * opener. Fall back to a neutral opener whenever part1 itself also reads
 * like a completion / already-written claim.
 */
function textSuggestsStep3SlotAlreadyWritten(text: string): boolean {
  const t = String(text || "");
  if (!t) return false;
  return (
    /填入右侧|写入右侧|已经写入|已写入|已填入|放到了右侧|右侧已经/.test(t) ||
    /已经作为【[^】]{1,20}】填入/.test(t) ||
    /这句话已经作为/.test(t) ||
    (/作为【/.test(t) && /填入/.test(t))
  );
}

function sanitizeStep3RewritePart1(part1: string, fallback: string): string {
  const t = String(part1 || "").trim();
  if (
    !t ||
    textSuggestsStep3Complete(t) ||
    textSuggestsStep3SlotAlreadyWritten(t)
  ) {
    return fallback;
  }
  return t;
}

function isSubstantiveStep3Answer(msg: string): boolean {
  const t = String(msg || "").trim();
  if (t.length < 4) return false;
  if (isKickoffOrInstructionText(t)) return false;
  return !/^(对|是|是的|对的|好的|嗯|明白|好|继续|下一步|ok|okay|yes)$/i.test(t);
}

/** Hidden kickoff / model-echoed instruction text must never count as a filled step. */
function isKickoffOrInstructionText(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  return (
    /请基于这个已确立的主体段分论点直接开始/.test(t) ||
    /先判断这是单点还是多点论点/.test(t) ||
    /结构细节写入系统即可/.test(t) ||
    /不要在对话里提字段名/.test(t)
  );
}

function isValidStep3StepValue(value: string): boolean {
  const v = String(value || "").trim();
  if (!v) return false;
  return !isKickoffOrInstructionText(v);
}

/**
 * Detects when the model echoed its own "例如：..." placeholder text back as
 * the step's "value" instead of writing the student's actual answer. This is
 * the dominant root cause of Step 3 being declared complete while the
 * dialogue hasn't actually reached that step — the board LOOKS full but the
 * content was never said by the student, just copied from the hint.
 */
function normalizeForEchoCompare(text: string): string {
  return String(text || "")
    .replace(/^\s*(例如|e\.g\.?|eg)[:：,，]?\s*/i, "")
    .replace(/[\s，,。.！!？?；;：:""''「」【】\-—]/g, "")
    .toLowerCase();
}

function isPlaceholderEchoValue(value: string, placeholder: string): boolean {
  const p = normalizeForEchoCompare(placeholder);
  if (!p) return false;
  const v = normalizeForEchoCompare(value);
  if (!v) return false;
  return v === p;
}

/** True when two step values are the same answer copied twice (model prefill leak). */
function areNearDuplicateStep3Values(a: string, b: string): boolean {
  const na = normalizeForEchoCompare(a);
  const nb = normalizeForEchoCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 12 && nb.length >= 12 && (na.includes(nb) || nb.includes(na))) {
    return true;
  }
  return false;
}

/**
 * True when a student's current answer substantially covers a model-authored
 * adjacent value. This is deliberately broader than exact duplicate detection:
 * it catches light paraphrases such as "跨时区消息不能及时回复" being written into
 * a second slot after the student's full sentence already said the same thing.
 */
function doesStep3AnswerCoverValue(answer: string, value: string): boolean {
  const a = normalizeForEchoCompare(answer);
  const v = normalizeForEchoCompare(value);
  if (a.length < 12 || v.length < 12) return false;
  if (a.includes(v) || v.includes(a)) return true;

  const bigrams = (text: string): Set<string> => {
    const result = new Set<string>();
    for (let i = 0; i < text.length - 1; i++) result.add(text.slice(i, i + 2));
    return result;
  };
  const answerBigrams = bigrams(a);
  const valueBigrams = bigrams(v);
  let shared = 0;
  for (const gram of valueBigrams) {
    if (answerBigrams.has(gram)) shared += 1;
  }
  const smaller = Math.min(answerBigrams.size, valueBigrams.size);
  return shared >= 8 && smaller > 0 && shared / smaller >= 0.4;
}

function isGenuineStep3StepValue(step: any): boolean {
  if (!step) return false;
  const v = String(step.value || "");
  if (!isValidStep3StepValue(v)) return false;
  if (isPlaceholderEchoValue(v, String(step.placeholder || ""))) return false;
  return true;
}

/**
 * If one student answer already covers two adjacent OPEN slots, collapse them
 * into one board slot instead of storing a paraphrase twice. The retained slot
 * keeps the first key so React and downstream progress remain stable.
 *
 * Confirmed slots are never merged. If the second slot adds distinct content,
 * it remains separate and the normal per-slot completion gate still applies.
 */

function isParagraphPlanFilled(plan: any): boolean {
  if (!plan || !Array.isArray(plan.pointBlocks) || plan.pointBlocks.length === 0) {
    return false;
  }
  if (plan.mode === "total_then_points") {
    if (!isValidStep3StepValue(String(plan.totalClaim || ""))) return false;
  }
  return plan.pointBlocks.every(
    (block: any) =>
      Array.isArray(block?.steps) &&
      block.steps.length > 0 &&
      block.steps.every((step: any) => isStep3Confirmed(step)),
  );
}

/** Board-quality gate for a Step 3 body. Never trust isCompleted alone. */
function isSubpointQualityComplete(sp: any): boolean {
  if (!sp) return false;
  // 会议秘书新路径：骨架填满 = 全部槽 confirmed（从 minutes 判定）
  if (Array.isArray(sp.skeleton?.blocks) && sp.skeleton.blocks.length > 0) {
    return isSkeletonComplete(sp);
  }
  if (sp.paragraphPlan) return isParagraphPlanFilled(sp.paragraphPlan);
  if (Array.isArray(sp.structureSteps) && sp.structureSteps.length > 0) {
    return sp.structureSteps.every((s: any) => isStep3Confirmed(s));
  }
  return false;
}

/** At least one real student utterance in this body's chat (not kickoff/filler). */
function subpointHasStudentDialogue(sp: any): boolean {
  // 会议秘书新路径：有已落槽/已确认的学生纪要即视为有对话
  if (Array.isArray(sp.skeleton?.blocks) && sp.skeleton.blocks.length > 0) {
    const mins = Array.isArray(sp.minutes) ? sp.minutes : [];
    return mins.some(
      (m: any) =>
        m?.role === "student" &&
        m?.slotKey &&
        (m.status === "landed" || m.status === "confirmed"),
    );
  }
  const hist = Array.isArray(sp?.chatHistory) ? sp.chatHistory : [];
  return hist.some((m: any) => {
    if (m?.sender !== "user") return false;
    const t = String(m?.text || "").trim();
    if (!t || isKickoffOrInstructionText(t)) return false;
    return isSubstantiveStep3Answer(t) || isStep3AffirmativeConfirmation(t);
  });
}

/**
 * Body is done only when the board is filled AND the student actually spoke
 * in this body's dialogue. Prevents kickoff/model-only boards from unlocking
 * Body 2 and then completing the whole Step 3.
 */
function isSubpointGenuinelyComplete(
  sp: any,
  options?: { currentUserMessage?: string; isHiddenKickoff?: boolean },
): boolean {
  if (!isSubpointQualityComplete(sp)) return false;
  if (options?.isHiddenKickoff) return false;
  if (subpointHasStudentDialogue(sp)) return true;
  const msg = String(options?.currentUserMessage || "").trim();
  return (
    !!msg &&
    (isSubstantiveStep3Answer(msg) || isStep3AffirmativeConfirmation(msg)) &&
    !isKickoffOrInstructionText(msg)
  );
}

/** Keep plan structure (mode/blocks/placeholders) but wipe every value/status. */

/** Real incomplete sibling body label, or null when none remain. Never invent "下一段". */

const STEP3_WHOLE_STEP_JUMP_CTA =
  "第三步段落逻辑链构建已全部完成！请点击左侧【立即跳转】进入第四步：逐句写作练习。";

function textLooksLikeStep3NextBodyAdvance(text: string): boolean {
  const t = String(text || "");
  return (
    t.includes("接下来我们写") ||
    t.includes("「下一段」") ||
    t.includes("这一段先告一段落") ||
    (t.includes("下一段") && t.includes("核心分论点"))
  );
}

/** Whole Step 3 done → jump CTA (never "next body"). */
function rewriteStep3WholeStepJumpCta(data: any): void {
  if (!data?.progressUpdate) return;
  data.progressUpdate.isCompleted = true;
  const split = splitTwoParts(String(data.text || ""), 3);
  const part1 = sanitizeStep3RewritePart1(
    split.part1,
    "这一段的论证链已经完整。",
  );
  data.text = `${part1}\n\n---\n\n${STEP3_WHOLE_STEP_JUMP_CTA}`;
}

/** Strip whole-step completion CTA when other bodies still need work. */

/**
 * After the ACTIVE body is quality-filled, decide whether the whole Step 3
 * can unlock. Never trust sibling isCompleted flags — re-check board quality.
 */

/**
 * Authoritative Step 3 UI progress for the client (dumb renderer).
 * Client must not recompute selectable / whole-step finished / next tab.
 */
function attachStep3UiProgress(
  data: any,
  session: any,
  activeId: string | undefined,
  options?: { currentUserMessage?: string; isHiddenKickoff?: boolean },
): void {
  if (!data?.progressUpdate) return;

  const subpoints = Array.isArray(session?.step3?.subpoints)
    ? session.step3.subpoints
    : [];
  const plan = data.progressUpdate.paragraphPlan;
  const flat = Array.isArray(data.progressUpdate.step3SubpointSteps)
    ? data.progressUpdate.step3SubpointSteps
    : null;

  const bodies = subpoints.map((sp: any) => {
    let isCompleted = false;
    if (sp?.id === activeId) {
      if (options?.isHiddenKickoff) {
        isCompleted = false;
      } else if (typeof data.progressUpdate.step3SubpointCompleted === "boolean") {
        isCompleted = !!data.progressUpdate.step3SubpointCompleted;
      } else {
        const mergedSp = {
          ...sp,
          ...(plan ? { paragraphPlan: plan } : {}),
          ...(flat ? { structureSteps: flat } : {}),
        };
        isCompleted = isSubpointGenuinelyComplete(mergedSp, {
          currentUserMessage: options?.currentUserMessage,
          isHiddenKickoff: options?.isHiddenKickoff,
        });
      }
    } else {
      isCompleted = isSubpointGenuinelyComplete(sp);
    }
    return { id: String(sp?.id || ""), isCompleted };
  });

  const bodiesWithSelectable = bodies.map((b: any, idx: number) => {
    let selectable = true;
    for (let i = 0; i < idx; i++) {
      if (!bodies[i].isCompleted) {
        selectable = false;
        break;
      }
    }
    return { ...b, selectable };
  });

  const expectedBodyCount = inferExpectedStep3BodyCount(session);
  const isStep3Finished =
    bodiesWithSelectable.length > 0 &&
    (expectedBodyCount <= 0 || bodiesWithSelectable.length >= expectedBodyCount) &&
    bodiesWithSelectable.every((b: any) => b.isCompleted);

  let nextActiveSubpointId = activeId || bodiesWithSelectable[0]?.id || "";
  const activeJustCompleted = bodiesWithSelectable.find(
    (b: any) => b.id === activeId,
  )?.isCompleted;
  if (activeJustCompleted && !isStep3Finished) {
    const nextIncomplete = bodiesWithSelectable.find((b: any) => !b.isCompleted);
    if (nextIncomplete) nextActiveSubpointId = nextIncomplete.id;
  }

  data.progressUpdate.step3Ui = {
    bodies: bodiesWithSelectable,
    isStep3Finished,
    nextActiveSubpointId,
  };
  if (process.env.STEP3_UI_DEBUG) {
    console.warn(
      `[Step3Ui] activeId=${activeId} next=${nextActiveSubpointId} bodies=${bodies
        .map((b) => `${b.id}:${b.isCompleted}`)
        .join(",")} finished=${isStep3Finished}`,
    );
  }
  // Keep whole-step flag aligned with the UI contract.
  data.progressUpdate.isCompleted = isStep3Finished;

  // Final authority for coach copy: finished board ⇒ jump CTA, never「下一段」.
  if (isStep3Finished) {
    const t = String(data.text || "");
    if (!textSuggestsStep3Complete(t) || textLooksLikeStep3NextBodyAdvance(t)) {
      rewriteStep3WholeStepJumpCta(data);
      console.warn(
        "[Step3Guard] isStep3Finished=true — normalized coach text to whole-step jump CTA.",
      );
    }
  }
}

/**
 * Ensure each pointBlock starts with a claim-type slot (分论点/核心观点).
 * Prevents kickoff firstEmpty from jumping to 展开原因 while 论点 never exists.
 */

/**
 * Confirm when the beat text is complete enough (not a thin slogan).
 * Default path: expand with Step2 material as question seed.
 * Student-utterance polish: lower bar; longer multi-clause chains are welcome.
 * Step2-only polish: still needs substance and low overlap with confirmed siblings.
 */

/** Ask text for the first unconfirmed step: confirm existing draft, or fill empty. */

type KickoffPendingDraft = {
  key: string;
  label: string;
  text: string;
  blockIndex: number;
  stepIndex: number;
};

function isBalancedParenText(text: string): boolean {
  let depth = 0;
  for (const ch of String(text || "")) {
    if (ch === "（" || ch === "(") depth += 1;
    if (ch === "）" || ch === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Step2 theme/cluster shorthand like「健康保护（室内密闭餐厅，通风差，危害大）」—
 * a keyword label, not a confirmable argument sentence.
 */
function lookLikeStep2ThemeLabel(text: string): boolean {
  const t = String(text || "")
    .trim()
    .replace(/[。.!！]+$/g, "");
  if (!t) return false;
  const m = t.match(/^([^（(]{2,12})[（(]([^）)]+)[）)]$/);
  if (!m) return false;
  const head = m[1].trim();
  const inner = m[2].trim();
  // Head should be a bare noun/theme, not a clause with predicate markers.
  if (/[是会能因为从而使得导致造成无法被迫积聚吸入，。；]/.test(head)) {
    return false;
  }
  const segs = inner
    .split(/[，,；;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.length >= 2 && segs.every((s) => s.length <= 14)) return true;
  if (segs.length === 1 && segs[0].length <= 16 && head.length <= 8) return true;
  return false;
}

/** Split on commas/semicolons only when not inside parentheses. */
function splitOutsideParens(text: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  for (const ch of String(text || "")) {
    if (ch === "（" || ch === "(") depth += 1;
    if (ch === "）" || ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /[，,；;]/.test(ch)) {
      if (buf.trim()) parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

/**
 * Kickoff confirm chat: show organized drafts in dialogue ONLY.
 * Slots stay empty until the student affirms.
 */

/** True when a kickoff draft is a complete enough sentence to confirm-and-write. */

/**
 * Beat-level depth gate — stricter than isKickoffDraftSubstantiveEnough.
 * A grammatically complete sentence can still be too shallow to argue with,
 * e.g. "室内通风较差" (bare adjective, no perceivable process/consequence) or
 * "顾客与员工会受到二手烟的严重危害" (states harm happened, no forced-exposure
 * mechanism). Only reason/mechanism/impact are gated; example/other pass
 * through unchanged. Callers must still run isKickoffDraftSubstantiveEnough.
 */

/** Combined kickoff confirm-write gate: complete sentence AND argument-deep. */

/**
 * Light paraphrase only — reorder / smooth wording using tokens already present.
 * Must NOT introduce new facts; caller re-checks grounding.
 * Returns "" when input is theme-label shorthand (expand-ask should fire).
 */

/** Reject / protest that content was already written — never treat as new slot fill. */

/** Normalize a step label for confirmed-slot matching across model key/label churn. */

/**
 * Confirmed-only board: wipe every slot, then restore prev confirmed values by
 * key first; if the key churned, restore by same blockId + normalized label.
 * Model prefill of unconfirmed slots is discarded (confirm-then-write).
 */

/** True when an empty step looks like a framework beat injection (keep it). */

/**
 * Drop empty (no genuine value / not confirmed) steps the model freely inserted
 * whose keys were not in prevPlan. Keeps framework beat injections
 * (`*_beat_N` or required argument-relation beat labels).
 * Optional keepKeys: protect confirm-path targets (one-shot reclass) from prune.
 */

/** True when targetKey is the immediate next empty step after firstEmpty. */

/**
 * One-shot semantic reclass (答非所问但合理 → 一次归对格):
 * Model targeted a new empty key instead of firstEmpty. Prefer preserving
 * firstEmpty key: copy the model's label onto firstEmpty, stage there, prune
 * the duplicate new empty.
 */

/** Unique write entry: pending → confirmed slots only on explicit affirm. */

/**
 * Server hard-reject firewall only (NOT narrative quality judgment).
 * Empty / theme-label / unbalanced parens / near-duplicate of confirmed siblings.
 */

type Step3SlotEvalPendingDraft = {
  activeKey: string;
  pendingText: string;
};

type Step3SlotEvalPayload = {
  activeKey: string;
  mode: "expand" | "confirm";
  qualified: boolean;
  pendingText?: string;
  /** ≥2 items → multi-slot batch confirm from firstEmpty consecutive empties. */
  pendingDrafts?: Step3SlotEvalPendingDraft[];
  rejectReason?: string;
};

/** Unconfirmed steps in board order (same walk as findFirstEmptyPlanStep). */

/**
 * Resolve multi-slot batch confirm: drafts must cover the first N consecutive
 * unconfirmed steps in the same pointBlock (starting at firstEmpty).
 */

/**
 * Pull numbered labeled confirm lines from coach text, e.g.
 * `1. **【赋能机制】**：……\n2. **【典型场景】**：……`
 */

/**
 * When chat lists ≥2 consecutive same-block slots and asks for one「对」,
 * but step3SlotEval only declared a single pendingText — rebuild pendingDrafts
 * from the numbered list so one affirm writes the whole batch.
 */

/** Only when text is empty / missing --- ; never long Socratic templates. */

/** Count confirmed nested steps on the current paragraphPlan. */

/** Count nested steps on the plan. */

/** Count narrative chain labels like「原因：…」「场景：…」「影响：…」in coach text. */

/**
 * Identity tokens for a pointBlock (label / short subClaim) used to detect
 * coach asks that jump to a later block while an earlier slot is still empty.
 */

/**
 * True when coach text advances into a later pointBlock while firstEmpty is
 * still in an earlier block. Empty slots must be filled (or deleted) first —
 * cross-block skip asks are forbidden regardless of slot role.
 *
 * Scope: prefer the ask half (Part2 after ---). Part1 may preview「次要方向」
 * as plan shape on kickoff without counting as a skip-ahead ask.
 */

/**
 * Illegal coach text that contradicts the board (dump / fake complete /
 * cross-block skip while earlier slots remain empty).
 * Returns a reject code or "" when text is acceptable.
 */

/** Soft firstEmpty ask — mid-dialogue veto fallback (not the rigid 谁/情况下 template). */

/** Whether coach ask text already targets the firstEmpty label. */

/**
 * Mid-dialogue soft salvage: strip illegal dumps; keep natural Part2 ask when it
 * already targets firstEmpty. Else soft short ask (not rigid 谁/情况下 boilerplate).
 */

/**
 * Kickoff-only: strip complete-then-confirm dump blocks from model text.
 * Does not invent a new Socratic question when a usable Part2 ask remains.
 */

/**
 * Kickoff-only salvage: prefer model's own question after dump strip.
 * Soft fallback ask — never the mid-dialogue veto template.
 */

/**
 * Kickoff-only: align expand state; sanitize dump; keep model ask when possible.
 * Never calls the mid-dialogue full veto template.
 */

/**
 * Full-text veto: board is truth. Prefer salvaging the model's ask when it
 * already targets firstEmpty; else a short soft ask. Aligns step3SlotEval to
 * expand. Does NOT invent argument prose.
 * Mid-dialogue only — kickoff uses prepareStep3KickoffCoachText instead.
 */

/**
 * Align step3SlotEval to firstEmpty expand without rewriting ask text
 * (happy path: LLM owns the question).
 */

/**
 * If coach text contradicts the board, veto (full replace). Otherwise align
 * state only and keep model text. Returns true when a veto fired.
 */

/** True when coach text is asking the student to affirm an organized sentence. */

/**
 * Pull a ready-made confirm sentence from post-affirm coach text
 * (e.g. **「例如，一个后端工程师…」** before 请回复「对」).
 */

/**
 * After affirming slot N, the model often organizes slot N+1 in the SAME turn
 * (chat asks「请回复对」) but forgets mode=confirm+pendingText — or declares
 * confirm while detectStep3IllegalCoachText would still veto the text
 * (e.g. cross-block preview). Resolve a pending draft for firstEmpty when
 * possible so the student's next「对」can commit.
 */

/**
 * Stage post-affirm next-slot confirm; keep model text; set step3SlotEval confirm.
 * Returns true when pending was staged.
 */

/** Model text claims earlier beats are done while the board has no confirmed steps. */

/** Strip process-meta phrases the model must not say (hygiene, not rewrite). */

/** Strip mid-dialogue English translation show-offs (Step 3 is Chinese coaching only). */

type SlotEvalResult = {
  qualified: boolean;
  text: string;
  hint: string;
};

/**
 * Legacy expand hint builder — demoted; MUST NOT drive student-facing Part2.
 * Kept for hard-check / logging helpers only.
 */

/**
 * Legacy continuous eval — demoted to hard-check helper only.
 * MUST NOT stage pending or own student-facing asks (LLM owns step3SlotEval).
 * Step2-only must not auto-qualify.
 */

/** Labeled edits: 「原因：…」or pending label → update that pending key only. */

/**
 * Pull the coach's reorganized confirm sentence from chat text
 * (e.g. 「我为你重新整理了这一步：**……**」).
 */

/**
 * When the student revises a pending slot, prefer the coach's polished
 * confirm sentence over the raw labeled-edit fragment (which used to leak
 * into kickoffPendingDrafts → right board → affirm write).
 */

/**
 * Confirm-turn text hard lock: after pending is staged, replace coach text with a
 * clean confirm CTA. Never keep a same-turn "next slot" ask (e.g. 具体场景).
 * Call ONLY after batch salvage / pending staging so batch commit data is intact.
 */

type Step3PlanStepRef = {
  kind: "totalClaim" | "step";
  blockIndex: number;
  stepIndex: number;
  key: string;
};

/**
 * Provenance firewall for Step 3 values.
 *
 * Internal planning fields (mode / diagnosis / subClaim / placeholder) may be
 * model-authored. But `value` is display/confirmation content and may only
 * advance from empty→filled for the CURRENT target step (first empty in the
 * previous board snapshot), plus at most the next adjacent step in the SAME
 * pointBlock (one-utterance covers two links). Any other empty→filled leap is
 * treated as model draft leakage and forced back to empty.
 */

/** Flat-chain provenance: only first not-confirmed + next adjacent may newly fill. */

/**
 * Backfill only when the model left the open target completely empty.
 * Do NOT overwrite a model rewrite of a draft slot — polish is allowed while
 * status is still draft; confirmation is gated by resolveStep3StepConfirmation.
 */

/**
 * Model may propose status=confirmed; server only demotes invalid proposals.
 * Never upgrades draft→confirmed on its own.
 * Option A on failure: keep value, force status back to draft.
 *
 * Exception: when confirmation is explicitly present, OR when the student gave
 * a substantive sentence that the model lightly polished on the same target
 * slot, accepting that polished sentence IS grounding — do not additionally
 * require raw lexical overlap against the whole corpus. Without this,
 * promoteAcknowledgedStep3DraftTarget can be undone in the same turn by the
 * corpus-coverage check, producing re-ask deadlocks.
 */

// 以下旧的 paragraphPlan mode-correction 链（ParagraphMode / overlap 工具 /
// computeParagraphModeSignals / recommendParagraphMode / applyParagraphModeCorrection /
// rebuildFlatStepsFromParagraphPlan）已在 P0 补完时删除：秘书架构不产生
// paragraphPlan，故整条链不可达。

function inferExpectedStep3BodyCount(session: any): number {
  const clusters = session?.step2?.coachEvaluation?.clustering?.clusters;
  if (Array.isArray(clusters) && clusters.length > 0) {
    return clusters.length;
  }

  const blueprint =
    session?.step2?.coachEvaluation?.blueprint || session?.step2?.blueprint || {};
  const bodies = Array.isArray(blueprint?.bodies)
    ? blueprint.bodies.filter((b: any) =>
        String(b?.content || b?.title || "").trim().length > 0,
      )
    : [];
  if (bodies.length > 0) return bodies.length;

  const body1 = String(blueprint?.body1 || "").trim();
  const body2 = String(blueprint?.body2 || "").trim();
  const bodyCount = (body1 ? 1 : 0) + (body2 ? 1 : 0);
  if (bodyCount > 0) return bodyCount;

  const userPoints = String(
    session?.step2?.coachEvaluation?.userPoints || session?.step2?.userPoints || "",
  );
  if (/A面[^：:]*[：:]/.test(userPoints) && /B面[^：:]*[：:]/.test(userPoints)) {
    return 2;
  }
  return 0;
}

/** Match Step 2 clustering cluster to an active Step 3 subpoint (internal contract). */
function resolveStep2BodyFrameworkForSubpoint(
  session: any,
  subpoint: any,
): Record<string, unknown> | null {
  const clustering =
    session?.step2?.coachEvaluation?.clustering || session?.step2?.clustering;
  const clusters = Array.isArray(clustering?.clusters) ? clustering.clusters : [];
  if (clusters.length === 0 || !subpoint) return null;

  const targetBody = String(subpoint.targetBody || "").trim();
  const idMatch = String(subpoint.id || "").match(/^body-(\d+)$/i);
  const bodyIdx = idMatch ? parseInt(idMatch[1], 10) - 1 : -1;

  let cluster = clusters.find(
    (c: any) =>
      targetBody &&
      String(c?.targetBody || "").trim().toLowerCase() === targetBody.toLowerCase(),
  );
  if (!cluster && bodyIdx >= 0 && bodyIdx < clusters.length) {
    cluster = clusters[bodyIdx];
  }
  if (!cluster) return null;

  const blueprint =
    session?.step2?.coachEvaluation?.blueprint || session?.step2?.blueprint || {};
  const argumentRelation =
    resolveArgumentRelation(cluster) ||
    String(cluster.argumentRelation || cluster.stanceRelation || "").trim();
  return {
    bodyCount:
      Number(clustering?.bodyCount) ||
      Number(blueprint?.bodyCount) ||
      clusters.length,
    layoutPattern: clustering?.layoutPattern || blueprint?.layoutPattern || "",
    paragraphDensity: cluster.paragraphDensity || "",
    pointRoles: Array.isArray(cluster.pointRoles) ? cluster.pointRoles : [],
    argumentRelation,
    // Compat mirror for older clients / digests.
    stanceRelation:
      argumentRelation === "concedes" || argumentRelation === "supports"
        ? argumentRelation
        : String(cluster.stanceRelation || "").trim(),
    layoutRationale: cluster.layoutRationale || "",
    mappedPoints: Array.isArray(cluster.points) ? cluster.points : [],
    theme: cluster.theme || "",
    essayFrameworkSignature: computeEssayFrameworkSignature(session),
  };
}

function formatStep2BodyFrameworkForPrompt(framework: Record<string, unknown> | null): string {
  if (!framework) return "Not provided (Step 3 may infer paragraph structure from the active claim only).";
  const density = String(framework.paragraphDensity || "").trim();
  const relation = resolveArgumentRelation(framework) ||
    String(framework.argumentRelation || framework.stanceRelation || "").trim();
  const beats = getRequiredBeatsForRelation(relation);
  const roles = Array.isArray(framework.pointRoles)
    ? (framework.pointRoles as any[])
        .map(
          (r) =>
            `${String(r?.point || "").trim()} (${String(r?.role || "major").trim()})`,
        )
        .filter(Boolean)
        .join("; ")
    : "";
  const mapped = Array.isArray(framework.mappedPoints)
    ? (framework.mappedPoints as string[]).map((p) => String(p || "").trim()).filter(Boolean).join("; ")
    : "";
  const lines = [
    `- Essay body count (Step 2): ${framework.bodyCount || "unknown"}`,
    `- Whole-essay layout pattern: ${framework.layoutPattern || "not set"}`,
    `- This body's paragraph density: ${density || "not set"} (single_point = one argument per body; dual_point = two mapped points in this body)`,
    `- Mapped brainstorm points: ${mapped || "not set"}`,
    `- Point roles (major/minor): ${roles || "not set"}`,
    `- Argument relation (Step 2 converge): ${relation || "not set"} (supports|concedes|compares|solves|elaborates)`,
    `- Required argument beats for this relation: ${beats.length > 0 ? beats.join(" → ") : "none (use ordinary causal chain)"}`,
  ];
  const rationale = String(framework.layoutRationale || "").trim();
  if (rationale) {
    lines.push(`- Internal layout rationale (DO NOT echo to student): ${rationale}`);
  }
  return lines.join("\n");
}

/** 基于秘书骨架 + 纪要投影当前 Step3 槽位光标（restructure 新架构）。
 * 旧实现读 paragraphPlan 槽位；新实现读冻结骨架 skeleton + minutes（真相源）。
 * 让教练 LLM 看到的槽位状态与右侧秘书看板完全一致，消灭双真相源。 */
function formatStep3SlotCursorForPrompt(activeSp: any): string {
  if (!activeSp) return "Not provided (no active subpoint).";
  const skeleton = activeSp.skeleton;
  if (!skeleton || !Array.isArray(skeleton.blocks) || skeleton.blocks.length === 0) {
    return "Not provided (no frozen skeleton yet — secretary initializes it on first Step3 turn).";
  }
  const minutes = Array.isArray(activeSp.minutes) ? activeSp.minutes : [];
  const flat = skeletonFlatSlots(skeleton);
  const confirmedKeys = new Set(
    minutes
      .filter((m: any) => m.status === "confirmed" && m.slotKey)
      .map((m: any) => m.slotKey as string),
  );
  const firstEmpty = flat.find((f) => !confirmedKeys.has(f.slot.key));
  const pending = minutes.find((m: any) => m.status === "landed");
  const siblings = firstEmpty
    ? flat
        .filter(
          (f) =>
            f.blockIndex === firstEmpty.blockIndex && confirmedKeys.has(f.slot.key),
        )
        .map((f) => {
          const m = minutes.find(
            (x: any) => x.slotKey === f.slot.key && x.status === "confirmed",
          );
          return m
            ? `${f.slot.label}: ${String(m.text || "").slice(0, 40)}`
            : "";
        })
        .filter(Boolean)
    : [];
  const lines = [
    `- firstEmpty key: ${firstEmpty ? firstEmpty.slot.key : "(none — body may be complete)"}`,
    `- firstEmpty label: ${firstEmpty ? firstEmpty.slot.label : "(none)"}`,
    `- firstEmpty placeholder: ${firstEmpty ? firstEmpty.slot.placeholder : "(none)"}`,
    `- confirmed sibling summaries: ${
      siblings.length ? siblings.join(" || ") : "(none)"
    }`,
    `- current pending (landed, awaiting「对」): ${
      pending
        ? `${String(pending.slotKey || "")}: ${String(pending.text || "").slice(0, 60)}`
        : "(none)"
    }`,
    `- skeleton completion: ${confirmedKeys.size}/${flat.length} slots confirmed`,
  ];
  return lines.join("\n");
}

/** P2 教练上下文瘦身：把整个 subpoints 数组压缩为每个 body 一行摘要
 *  （body 主题 + 已确认槽数 + 是否完成），不再把 minutes/旧字段全量塞给 LLM。 */
function formatStep3SubpointsBrief(subpoints: any[]): string {
  if (!Array.isArray(subpoints) || subpoints.length === 0) {
    return "Not provided";
  }
  const lines = subpoints.map((sp: any, i: number) => {
    const id = String(sp?.id || `body-${i + 1}`);
    const claim = String(sp?.content || sp?.theme || "").trim().slice(0, 40) || "未命名";
    const minutes = Array.isArray(sp?.minutes) ? sp.minutes : [];
    const confirmed = minutes.filter(
      (m: any) => m.status === "confirmed" && m.slotKey,
    ).length;
    const isDone = confirmed > 0 && sp?.isCompleted === true;
    return `  - Body ${id}: 「${claim}」 已确认 ${confirmed} 槽${isDone ? " ✅ 已完成" : ""}`;
  });
  return lines.join("\n");
}

/** P2 判断透镜：为当前 active subpoint 生成"当前槽期望"锚点（注入教练上下文）。 */
function formatLensAnchorForActiveSubpoint(activeSp: any): string {
  if (!activeSp || !Array.isArray(activeSp.skeleton?.blocks)) {
    return "Not provided (no active subpoint).";
  }
  const flat = skeletonFlatSlots(activeSp.skeleton);
  const minutes = Array.isArray(activeSp.minutes) ? activeSp.minutes : [];
  const confirmedKeys = new Set(
    minutes
      .filter((m: any) => m.status === "confirmed" && m.slotKey)
      .map((m: any) => m.slotKey as string),
  );
  const firstEmpty = flat.find((f) => !confirmedKeys.has(f.slot.key));
  if (!firstEmpty) return "(本主体段已完整，无待填槽)";
  return formatLensAnchor(firstEmpty.slot, activeSp.skeleton.chainType);
}

/** Body 1 ≈ A面 / supports; Body 2 ≈ B面 / concedes for side_by_side essays. */

/**
 * Clean a Step 2 point blob into student-facing draft prose.
 * Prefer the detailed content inside （已选详写：…） when present.
 */
function cleanStep2EvidenceSnippet(text: string): string {
  let t = String(text || "").trim();
  if (!t) return "";
  const detail = t.match(
    /[（(]\s*(?:已选详写|已选略写|详写|略写)\s*[:：]\s*([^）)]+?)[）)]/,
  );
  if (detail?.[1]?.trim()) {
    t = detail[1].trim();
  } else {
    t = t
      .replace(
        /[（(]\s*(?:已选详写|已选略写|待补例子|待展开|待裁决)[^）)]*[）)]/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
  }
  return t.length >= 4 ? t : "";
}

type Step3BeatKind = "reason" | "mechanism" | "impact" | "example" | "other";

/**
 * Narrow evidence for kickoff organization: student argument blobs only.
 * Exclude claim/theme/cluster summaries that pollute clause matching.
 */

type KickoffDraftBuildResult = {
  pending: KickoffPendingDraft[];
  /** When set, material is too thin — ask student to expand before confirm-write. */
  expandTarget: { label: string; hint: string } | null;
};

/**
 * Build kickoff pending drafts for chat confirmation — does NOT write slots.
 * Prefer grounded model field / full Step2 sentences; else clauses → paraphrase.
 * If a primary beat has Step2 signal but no substantive sentence, request expand.
 */

/**
 * Generic coverage check: for any argumentRelation, ensure plan steps cover
 * the required beats from the design-time table. Missing beats get an open
 * follow-up placeholder derived from the beat text — never a fixed template.
 */

/** @deprecated Use ensureArgumentRelationCoverage. */

function parseStep2SidePoints(userPoints: string): { A: string[]; B: string[] } {
  const text = String(userPoints || "").trim();
  if (!text) return { A: [], B: [] };

  const splitSide = (side: "A" | "B"): string[] => {
    const sideRe =
      side === "A"
        ? /A面[^：:]*[：:]([\s\S]*?)(?=B面[^：:]*[：:]|$)/
        : /B面[^：:]*[：:]([\s\S]*)$/;
    const sectionMatch = text.match(sideRe);
    const scope = (sectionMatch?.[1] || "").trim();
    if (!scope) return [];

    const numbered = [
      ...scope.matchAll(/(?:^|[；;\n])\s*\d+[.、．]\s*([^；;\n]+)/g),
    ]
      .map((m) => m[1].trim())
      .filter((s) => s.length >= 4);
    if (numbered.length > 0) return numbered;

    return scope
      .split(/[；;]/)
      .map((s) => s.replace(/^[A-Za-z]?面[^：:]*[：:]?\s*/, "").trim())
      .filter((s) => s.length >= 4 && !/待裁决/.test(s));
  };

  return { A: splitSide("A"), B: splitSide("B") };
}

function isThinStep2Point(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return true;
  if (/待补例子|待展开|素材不足/.test(t)) return true;
  const core = t
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[；;].*$/, "")
    .trim();
  return core.length < 12;
}

function isSolidStep2Point(text: string): boolean {
  return !isThinStep2Point(text);
}

function stanceSuggestsOutweighPro(stance: string): boolean {
  return /利大于弊|outweigh.*advant|advantages.*outweigh|倾向于支持|偏向支持/i.test(
    String(stance || ""),
  );
}

function stanceSuggestsOutweighCon(stance: string): boolean {
  return /弊大于利|disadvantages.*outweigh/i.test(String(stance || ""));
}

const STEP2_MATERIAL_CHECK_TAG = "材料校验已提示";

type DimensionDispositionKind = "expanded" | "merged" | "dropped" | "pending";

type DimensionDisposition = {
  dimension: string;
  disposition: DimensionDispositionKind;
  side?: "A" | "B" | "";
  mergedInto?: string;
  note?: string;
};

/** Step1 effective (probed+expandable) dimension cores that Step2 must dispose. */
function listStep1EffectiveDimensionCores(session: any): string[] {
  const dims =
    session?.step1?.boardOverrides?.suggestedDimensions ||
    session?.step1?.coachEvaluation?.suggestedDimensions ||
    [];
  if (!Array.isArray(dims)) return [];
  const cores: string[] = [];
  const seen = new Set<string>();
  for (const d of dims) {
    const raw = String(d || "");
    if (!isStep1DimensionExpandable(raw)) continue;
    const core = stripStep1DimensionTags(raw);
    const key = core.toLowerCase();
    if (!core || seen.has(key)) continue;
    seen.add(key);
    cores.push(core);
  }
  return cores;
}

/** Synonym bags so "监管/执法" can resolve Step1 label "政府管理成本". */
const STEP1_DIM_SYNONYM_BAGS: { coreHint: RegExp; evidence: RegExp }[] = [
  {
    coreHint: /政府|管理|成本|监管/,
    evidence: /监管|执法|配合度?|执行难度|人工成本|管理成本|工作量|难以执法|极难执法/,
  },
  {
    coreHint: /烟民|便利/,
    evidence: /烟民|便利|不便|吸烟区|找.*烟|特定吸烟/,
  },
  {
    coreHint: /健康/,
    evidence: /健康|二手烟|非吸烟|密闭|通风差?/,
  },
  {
    coreHint: /商业|经济|利益/,
    evidence: /商业|经济|营收|收入|营业额|旅游业?|餐厅生意/,
  },
];

function textMentionsDimensionCore(text: string, core: string): boolean {
  const t = String(text || "");
  const tLower = t.toLowerCase();
  const c = String(core || "").trim();
  const cLower = c.toLowerCase();
  if (!t || !c) return false;
  if (tLower.includes(cLower)) return true;
  // Short core / partial overlap (e.g. 烟民便利度 ↔ 烟民便利)
  if (c.length >= 2 && tLower.includes(cLower.slice(0, Math.min(c.length, 4)))) {
    const compact = cLower.replace(/[度性层面角度]/g, "");
    if (compact.length >= 2 && tLower.includes(compact)) return true;
  }
  for (const bag of STEP1_DIM_SYNONYM_BAGS) {
    if (bag.coreHint.test(c) && bag.evidence.test(t)) return true;
  }
  return false;
}

function collectStep2EvidenceCorpus(step2Data: any, session: any): string {
  const eval2 = session?.step2?.coachEvaluation || {};
  const parts: string[] = [
    String(step2Data?.userPoints || eval2.userPoints || session?.step2?.userPoints || ""),
    String(step2Data?.critique || eval2.critique || ""),
  ];
  const clustering = step2Data?.clustering || eval2.clustering;
  if (Array.isArray(clustering?.clusters)) {
    for (const c of clustering.clusters) {
      parts.push(String(c?.theme || ""), String(c?.content || ""));
      if (Array.isArray(c?.points)) {
        parts.push(c.points.map((p: any) => String(p || "")).join("；"));
      }
    }
  }
  if (Array.isArray(clustering?.outliers)) {
    for (const o of clustering.outliers) {
      parts.push(String(o?.point || ""), String(o?.suggestion || ""));
    }
  }
  const blueprint = step2Data?.blueprint || eval2.blueprint;
  if (blueprint && typeof blueprint === "object") {
    parts.push(String(blueprint.position || ""));
    const bodies = Array.isArray(blueprint.bodies) ? blueprint.bodies : [];
    for (const b of bodies) {
      parts.push(String(b?.title || ""), String(b?.content || ""));
    }
    parts.push(String(blueprint.body1 || ""), String(blueprint.body2 || ""));
  }
  return parts.join("\n");
}

function normalizeDispositionKind(raw: any): DimensionDispositionKind | null {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "expanded" || s === "展开" || s === "详写") return "expanded";
  if (s === "merged" || s === "整合" || s === "并入") return "merged";
  if (s === "dropped" || s === "放下" || s === "放弃" || s === "discarded") {
    return "dropped";
  }
  if (s === "pending" || s === "待处理") return "pending";
  return null;
}

/**
 * Merge AI-provided dispositions with deterministic inference from Step2 text.
 * Effective Step1 dims must end as expanded | merged | dropped — never silent.
 */
function syncStep2DimensionDispositions(
  session: any,
  step2Data: any,
): DimensionDisposition[] {
  const cores = listStep1EffectiveDimensionCores(session);
  if (cores.length === 0) return [];

  const byKey = new Map<string, DimensionDisposition>();
  for (const core of cores) {
    byKey.set(core.toLowerCase(), {
      dimension: core,
      disposition: "pending",
    });
  }

  const incoming = Array.isArray(step2Data?.dimensionDispositions)
    ? step2Data.dimensionDispositions
    : Array.isArray(session?.step2?.coachEvaluation?.dimensionDispositions)
      ? session.step2.coachEvaluation.dimensionDispositions
      : [];
  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") continue;
    const core = stripStep1DimensionTags(String(raw.dimension || "")).trim();
    if (!core) continue;
    const key = core.toLowerCase();
    if (!byKey.has(key)) continue;
    const kind = normalizeDispositionKind(raw.disposition);
    if (!kind) continue;
    byKey.set(key, {
      dimension: byKey.get(key)!.dimension,
      disposition: kind,
      side: raw.side === "A" || raw.side === "B" ? raw.side : "",
      mergedInto: String(raw.mergedInto || "").trim() || undefined,
      note: String(raw.note || "").trim() || undefined,
    });
  }

  const clustering =
    step2Data?.clustering || session?.step2?.coachEvaluation?.clustering;
  if (Array.isArray(clustering?.outliers)) {
    for (const o of clustering.outliers) {
      const point = stripStep1DimensionTags(String(o?.point || "")).trim();
      if (!point) continue;
      for (const [key, cur] of byKey) {
        if (cur.disposition !== "pending" && cur.disposition !== "expanded") {
          continue;
        }
        if (!textMentionsDimensionCore(point, cur.dimension)) continue;
        const oDisp = normalizeDispositionKind(o?.disposition);
        if (oDisp === "merged" || String(o?.mergedInto || "").trim()) {
          byKey.set(key, {
            ...cur,
            disposition: "merged",
            mergedInto:
              String(o?.mergedInto || cur.mergedInto || "").trim() || undefined,
            note: String(o?.suggestion || cur.note || "").trim() || undefined,
          });
        } else {
          byKey.set(key, {
            ...cur,
            disposition: "dropped",
            note: String(o?.suggestion || cur.note || "").trim() || undefined,
          });
        }
      }
    }
  }

  const corpus = collectStep2EvidenceCorpus(step2Data, session);
  for (const [key, cur] of byKey) {
    if (cur.disposition === "expanded") {
      // Require evidence in recorded points; otherwise treat as still pending.
      if (!textMentionsDimensionCore(corpus, cur.dimension)) {
        byKey.set(key, { ...cur, disposition: "pending" });
      }
      continue;
    }
    if (cur.disposition === "merged") {
      if (!String(cur.mergedInto || "").trim()) {
        byKey.set(key, { ...cur, disposition: "pending" });
      }
      continue;
    }
    if (cur.disposition === "dropped") {
      continue;
    }
    // pending → infer expanded if already in explore/summary corpus
    if (textMentionsDimensionCore(corpus, cur.dimension)) {
      byKey.set(key, { ...cur, disposition: "expanded" });
    }
  }

  return cores.map(
    (c) => byKey.get(c.toLowerCase()) || { dimension: c, disposition: "pending" },
  );
}

function listUnresolvedStep1Dimensions(
  dispositions: DimensionDisposition[],
): DimensionDisposition[] {
  return dispositions.filter((d) => {
    if (d.disposition === "pending") return true;
    if (d.disposition === "merged" && !String(d.mergedInto || "").trim()) {
      return true;
    }
    return false;
  });
}

/**
 * Soft guard: ensure Step 1 effective dimensions are accounted for before
 * Step 2 completion. Do NOT auto-expand pending while checklist slots remain
 * unwalked — that previously unlocked stance with thin Step1 dimensions.
 */
function enforceStep2DimensionDispositionGuard(
  data: any,
  session: any,
): void {
  if (!data?.progressUpdate?.step2Data) return;
  const step2 = data.progressUpdate.step2Data;
  const dispositions = syncStep2DimensionDispositions(session, step2);
  step2.dimensionDispositions = dispositions;

  const unresolved = listUnresolvedStep1Dimensions(dispositions);
  if (unresolved.length === 0) return;

  const stage = String(
    step2.currentStage ||
      session?.step2?.coachEvaluation?.currentStage ||
      "explore_A",
  ).trim();
  const ctaOk = textSuggestsStep2Complete(String(data.text || ""));
  const isCompletedFlag =
    !!data.progressUpdate.isCompleted || ctaOk;

  const payload =
    step2.plannerPayload ||
    session?.step2?.coachEvaluation?.plannerPayload ||
    null;
  const unwalked = listUnwalkedChecklistPoints(payload, dispositions);
  const checklistDone = isStep2ChecklistWalkDone(payload, dispositions);

  // Only hard-block during early exploration: the model is trying to jump
  // to completion without having even entered stance/summary stage.
  const earlyConverge = stage === "explore_A" || stage === "explore_B";
  if (!isCompletedFlag || !earlyConverge) {
    // Soft-pass ONLY when checklist is already walked — never paper-complete
    // pending dimensions while slots are still thin / missing 详略.
    if (unwalked.length > 0 || !checklistDone) {
      console.warn(
        `[Step2DimDispositionGuard] Soft-pass SKIPPED; unwalked=${unwalked.length} stage=${stage} labels=[${unresolved.map((d) => d.dimension).join("、")}]`,
      );
      return;
    }
    const finalDispositions = dispositions.map((d) => {
      if (d.disposition === "pending") {
        return { ...d, disposition: "expanded" as const };
      }
      return d;
    });
    step2.dimensionDispositions = finalDispositions;
    const labels = unresolved.map((d) => d.dimension).join("、");
    console.warn(
      `[Step2DimDispositionGuard] Soft-pass: auto-expanded pending dimensions [${labels}] in stage=${stage} (checklist done)`,
    );
    return;
  }

  // Hard block: model attempted completion during explore_A/B without
  // addressing all Step 1 dimensions.
  const labels = unresolved.map((d) => d.dimension).join("、");
  const oldStage = String(
    session?.step2?.coachEvaluation?.currentStage || "explore_B",
  ).trim();
  const revertStage =
    oldStage === "explore_A" || oldStage === "explore_B" ? oldStage : "explore_B";
  step2.currentStage = revertStage;
  data.progressUpdate.isCompleted = false;

  const split = splitTwoParts(String(data.text || ""), 1);
  const part1 = safeOverridePart1(
    split.part1 || "目前两边已经有一些可写的材料了。",
  );
  const ask =
    `第一步里还有这些可展开角度还没明确处理：${labels}。` +
    `请选一种方式（不能直接跳过）：①展开其中一个（补场景/机制）` +
    `②说明并入已有的哪一点（写清并入对象）` +
    `③明确放下并说原因。`;
  data.text = `${part1}\n\n---\n\n${ask}`;
  console.warn(
    `[Step2DimDispositionGuard] Blocked early converge; unresolved=[${labels}] revertStage=${revertStage}`,
  );
}

/**
 * Converge-stage only: before Step 2 can finalize stance/summary, ensure
 * collected points can support the chosen stance. Anti-loop via userPoints tag.
 * Does NOT re-block explore_A → explore_B transitions.
 */
function enforceStep2StanceMaterialGuard(
  data: any,
  session: any,
  userMessage = "",
): void {
  if (!data?.progressUpdate?.step2Data) return;

  const step2 = data.progressUpdate.step2Data;
  if (step2.requiresStance === false) return;

  let userPoints = String(
    step2.userPoints ||
      session?.step2?.coachEvaluation?.userPoints ||
      session?.step2?.userPoints ||
      "",
  ).trim();
  const stance = String(
    step2.userStance ||
      step2.blueprint?.position ||
      session?.step2?.userStance ||
      "",
  ).trim();
  const oldStage = String(
    session?.step2?.coachEvaluation?.currentStage ||
      session?.step2?.currentStage ||
      "explore_A",
  ).trim();
  const newStage = String(step2.currentStage || oldStage).trim();
  const sides = parseStep2SidePoints(userPoints);
  const layoutPattern = String(
    step2.clustering?.layoutPattern ||
      step2.blueprint?.layoutPattern ||
      "",
  ).trim();

  // Only at converge (stance / summary / completion), never mid-explore hops.
  const finishing =
    newStage === "summary" &&
    (data.progressUpdate.isCompleted || textSuggestsStep2Complete(String(data.text || "")));
  const inConverge =
    newStage === "stance" ||
    newStage === "summary" ||
    finishing ||
    (oldStage === "explore_B" && newStage === "stance") ||
    (oldStage === "explore_B" && newStage === "summary");
  if (!inConverge) return;

  // Anti-loop: already prompted once this session → allow through.
  if (userPoints.includes(STEP2_MATERIAL_CHECK_TAG)) {
    return;
  }

  const needsSupportSideBoost =
    stanceSuggestsOutweighPro(stance) || layoutPattern === "concession_then_support";
  const needsConcedeSideBoost = stanceSuggestsOutweighCon(stance);
  const exhausted = studentSignalsExhausted(userMessage);

  let blockReason = "";
  let revertStage = "";
  let ask = "";

  if (needsSupportSideBoost) {
    const solidSupport = sides.A.filter(isSolidStep2Point);
    if (solidSupport.length < 1) {
      blockReason = "outweigh-support-too-thin";
      revertStage = "explore_A";
      ask = exhausted
        ? "目前支持面还没有一个可展开的具体优点。我们就围绕你已有的这一点先写支持段，可以吗？如果可以，请用一句话把它说具体；如果还想再补一个，也可以直接补充。"
        : "目前支持面的材料还偏薄，暂时不足以支撑「利大于弊」。请再补充 1 个具体优点，或把现有优点展开到可写成一个完整主体段。若暂时想不出更多，也可以说「没有更多了」。";
    } else if (!exhausted && solidSupport.length === 1 && sides.A.length < 2) {
      // Soft nudge once only; if student already said they're done, accept 1 solid.
      blockReason = "outweigh-support-single-solid";
      revertStage = oldStage === "stance" || oldStage === "summary" ? oldStage : "stance";
      ask =
        "你目前有一个比较具体的优点。若还能想到另一个互补优点会更稳；如果没有更多了，我们就用这一点展开支持段。你还能想到另一个吗？或者直接说「没有更多了」。";
    }
  }

  if (!blockReason && needsConcedeSideBoost) {
    const solidConcede = sides.B.filter(isSolidStep2Point);
    if (solidConcede.length < 1) {
      blockReason = "outweigh-concede-too-thin";
      revertStage = "explore_B";
      ask = exhausted
        ? "目前让步面还没有一个可展开的具体点。我们就用你已有材料短写让步段，可以吗？请用一句话把它说具体，或补充一个缺点。"
        : "目前让步面的材料还偏薄，暂时不足以支撑「弊大于利」。请再补充 1 个具体缺点，或把现有缺点展开。若暂时想不出更多，也可以说「没有更多了」。";
    }
  }

  if (!blockReason) return;

  // Soft single-solid nudge: mark tag so we never ask again; stay in converge.
  if (blockReason === "outweigh-support-single-solid") {
    step2.userPoints = userPoints
      ? `${userPoints}（${STEP2_MATERIAL_CHECK_TAG}）`
      : `（${STEP2_MATERIAL_CHECK_TAG}）`;
    const split = splitTwoParts(String(data.text || ""), 2);
    const part1 = safeOverridePart1(split.part1 || "我们先确认一下材料够不够用。");
    data.text = `${part1}\n\n---\n\n${ask}`;
    data.progressUpdate.isCompleted = false;
    console.warn(
      `[Step2StanceMaterialGuard] Soft converge nudge (${blockReason}); tagged ${STEP2_MATERIAL_CHECK_TAG}.`,
    );
    return;
  }

  step2.currentStage = revertStage || oldStage;
  data.progressUpdate.isCompleted = false;
  step2.userPoints = userPoints
    ? `${userPoints}（${STEP2_MATERIAL_CHECK_TAG}）`
    : `（${STEP2_MATERIAL_CHECK_TAG}）`;

  const split = splitTwoParts(String(data.text || ""), 2);
  const part1 = safeOverridePart1(split.part1 || "我们先把这个面的材料补扎实。");
  data.text = `${part1}\n\n---\n\n${ask}`;
  console.warn(
    `[Step2StanceMaterialGuard] Blocked converge (${blockReason}); tagged ${STEP2_MATERIAL_CHECK_TAG}; stage=${step2.currentStage}.`,
  );
}

function enforceStep3LogicCompletion(
  data: any,
  session: any,
  userMessage: string,
  options?: { isHiddenKickoff?: boolean },
): void {
  // 秘书架构：LLM 可能只输出 text 而不输出 progressUpdate（结构由服务器接管）。
  // 必须兜底初始化 progressUpdate，否则秘书落槽/看板回传会被跳过 → 状态漂移死锁。
  if (!data) return;
  if (!data.progressUpdate) data.progressUpdate = {};

  const activeId = session?.step3?.activeSubpointId;
  const activeSp = (session?.step3?.subpoints || []).find(
    (sp: any) => sp.id === activeId,
  );

  // 会议秘书唯一路径：subpoint 带冻结骨架 → 秘书逻辑（纪要 + 确定性落槽）。
  // 旧整树 diff 路径（enforceStep3LogicCompletionInner）已删除；骨架由
  // ensureStep3SkeletonForSubpoints 在请求早期注入，正常情况下必然存在。
  if (activeSp && Array.isArray(activeSp.skeleton?.blocks) && activeSp.skeleton.blocks.length > 0) {
    try {
      enforceStep3SecretaryPath(data, session, activeSp, userMessage, options);
    } catch (e: any) {
      console.warn(`[Secretary] path error: ${e?.message || e}`);
    }
  }

  attachStep3UiProgress(data, session, activeId, {
    currentUserMessage: userMessage,
    isHiddenKickoff: options?.isHiddenKickoff,
  });
  // 会议秘书：把更新后的 subpoints（含冻结骨架 skeleton + minutes 纪要把 + activeSlotIndex）
  // 回传给客户端，客户端合并回 session —— 这是秘书状态跨请求持久化的唯一通道。
  if (Array.isArray(session?.step3?.subpoints)) {
    data.progressUpdate.step3SecretarySubpoints = session.step3.subpoints;
  }
}

/**
 * 会议秘书路径（restructure 新架构）。
 *
 * 学生说什么 → 记 minutes（真相源）→ 确定性落槽 → 确认写板。
 * 看板是 renderBoard 的投影，不再持久化任何槽位内容。
 *
 * 本路径在 activeSp 带冻结 skeleton 时启用（秘书唯一路径）。
 */
function enforceStep3SecretaryPath(
  data: any,
  session: any,
  activeSp: any,
  userMessage: string,
  options?: { isHiddenKickoff?: boolean },
): void {
  if (!data?.progressUpdate) return;
  const sp = activeSp;
  if (!sp || !Array.isArray(sp.skeleton?.blocks)) return;

  // 确保 minutes 数组存在
  if (!Array.isArray(sp.minutes)) sp.minutes = [];

  const msg = String(userMessage || "").trim();
  const isKickoff = !!options?.isHiddenKickoff;

  // ---- kickoff：记录教练开场，输出引导，不落槽 ----
  if (isKickoff) {
    appendMinute(sp, "coach", String(data?.text || "我们开始构建这个主体段。").split("\n---\n")[0]);
    data.progressUpdate.step3SubpointCompleted = false;
    data.progressUpdate.isCompleted = false;
    data.progressUpdate.secretaryBoard = renderBoard(sp);
    data.progressUpdate.secretaryActiveSlot = activeSlotLabel(sp);
    return;
  }

  // ---- 常规轮：分类学生发言 ----
  const isAff = /^(对|好|是|嗯|可以|同意|采纳|确认|行|就按|确认写入|点击确认|确认提交)[。.!！?？]?$/.test(msg) || /确认写入|点击确认/.test(msg);
  const isRej = /^(不对|不好|不是|重说|重写|换一个|去掉|不要|改一下|重新说)[。.!！?？]?$/.test(msg) || /拒绝|否决|撤销/.test(msg);

  // 找当前 landed 待确认纪要（若有）
  const landed = (sp.minutes || []).find((m: any) => m.status === "landed");

  if (isAff && landed) {
    // 确认 → 写板
    commitPendingMinute(sp, landed);
    data.progressUpdate.step3SubpointCompleted = isSkeletonComplete(sp);
    data.progressUpdate.isCompleted = data.progressUpdate.step3SubpointCompleted;
    data.progressUpdate.secretaryBoard = renderBoard(sp);
    data.progressUpdate.secretaryActiveSlot = activeSlotLabel(sp);
    console.warn(
      `[Secretary] AFFIRM minute=${landed.id} slotKey=${landed.slotKey} → complete=${data.progressUpdate.step3SubpointCompleted} confirmed=${(sp.minutes || []).filter((m: any) => m.status === "confirmed").length}`,
    );
    return;
  }

  if (isRej) {
    // 拒绝 → 该条 landed 回退为 recorded，不写板
    if (landed) {
      console.warn(
        `[Secretary] REJECT minute=${landed.id} slotKey=${landed.slotKey} → reverted to recorded`,
      );
      landed.status = "recorded";
      landed.slotKey = undefined;
    }
    data.progressUpdate.secretaryBoard = renderBoard(sp);
    data.progressUpdate.secretaryActiveSlot = activeSlotLabel(sp);
    return;
  }

  // 实质回答 → 记纪要并尝试落槽
  const minute = appendMinute(sp, "student", msg);
  const land = landMinuteToSlot(sp, minute);
  if (land.ok) {
    // 已落为 landed（draft），等学生确认
    data.progressUpdate.step3SubpointCompleted = false;
    console.warn(
      `[Secretary] LANDED minute=${minute.id} slotKey=${land.slotKey} activeSlotIndex=${sp.activeSlotIndex}`,
    );
  } else {
    // rejected / 无空槽 / 无骨架 → 记录但看板不变
    data.progressUpdate.step3SubpointCompleted = false;
    if (land.reason) {
      data.progressUpdate.secretaryRejectReason = land.reason;
      console.warn(
        `[Secretary] LANDED reject minute=${minute.id} reason=${land.reason}`,
      );
    }
  }

  // P2 判断透镜：对本次实质回答做确定性质量评估（审计 + 记录 LLM 评估）。
  try {
    const landedSlotKey = land.ok ? land.slotKey : minute.slotKey;
    const slotDef = findSlotDef(sp.skeleton, String(landedSlotKey || ""));
    if (slotDef) {
      const lens = evaluateMinute(
        msg,
        slotDef,
        confirmedMinutes(sp),
        sp.skeleton?.chainType,
      );
      const llmAssessment = data.step3Assessment &&
        typeof data.step3Assessment === "object" &&
        data.step3Assessment.slotKey === landedSlotKey
        ? data.step3Assessment
        : null;
      console.warn(
        `[Lens] minute=${minute.id} slotKey=${landedSlotKey} verdict=${lens.verdict} reason=${lens.reason}${llmAssessment ? ` | llm=${llmAssessment.verdict} (${String(llmAssessment.reason || '').slice(0, 30)})` : ""}`,
      );
      // 太薄 / 跑题：给教练一个可选的追问提示（不作为模板，由教练自由措辞）。
      if (lens.verdict === "thin" || lens.verdict === "off_target") {
        data.progressUpdate.secretaryLensHint = lens.hint || "";
      }
    }
  } catch (e: any) {
    console.warn(`[Lens] error: ${e?.message || e}`);
  }

  // P3 教练卡死检测：同一槽连续 landed 未 confirmed → 无进展报警（只拦确定性）。
  try {
    const stall = detectStall(sp);
    if (stall.stalled) {
      data.progressUpdate.secretaryStall = {
        slotKey: stall.slotKey,
        slotLabel: stall.slotLabel,
        attempts: stall.attempts,
        level: stall.level,
      };
      console.warn(
        `[StallGuard] ${stall.level} 卡死疑似：槽「${stall.slotLabel}」连续 ${stall.attempts} 次未确认（confirmed 未推进）。`,
      );
    }
  } catch (e: any) {
    console.warn(`[StallGuard] error: ${e?.message || e}`);
  }

  data.progressUpdate.secretaryBoard = renderBoard(sp);
  data.progressUpdate.secretaryActiveSlot = activeSlotLabel(sp);
}

/**
 * 骨架初始化（后端核心优先）：subpoint 尚无冻结骨架但 session 已有 Planner bodyPlans 时，
 * 由后端生成 skeleton 并初始化 minutes。这是新架构的真相源注入点。
 * 返回是否已初始化。
 */
function ensureStep3SkeletonForSubpoints(session: any): boolean {
  const step3 = session?.step3;
  if (!step3 || !Array.isArray(step3.subpoints) || step3.subpoints.length === 0) {
    return false;
  }
  const bodyPlans = session?.step2_5?.bodyPlans;
  if (!Array.isArray(bodyPlans) || bodyPlans.length === 0) return false;

  let initialized = false;
  step3.subpoints.forEach((sp: any) => {
    if (sp && Array.isArray(sp.skeleton?.blocks) && sp.skeleton.blocks.length > 0) {
      return; // 已有骨架，跳过
    }
    const bp = bodyPlans.find((b: any) => String(b?.id) === String(sp?.id));
    const skeleton = bp?.skeleton
      ? bp.skeleton
      : bp
        ? toSkeleton(bp)
        : sp?.paragraphPlan
          ? planToSkeleton(sp.paragraphPlan)
          : null;
    if (skeleton && skeleton.blocks.length > 0) {
      sp.skeleton = skeleton;
      if (!Array.isArray(sp.minutes)) sp.minutes = [];
      if (typeof sp.activeSlotIndex !== "number") sp.activeSlotIndex = 0;
      initialized = true;
    }
  });
  if (initialized) {
    console.warn(`[Secretary] Initialized frozen skeleton for ${step3.subpoints.length} subpoint(s).`);
  }
  return initialized;
}

/**
 * Planner-ledger (bodyPlans.mappedPointIds + plannerPayload.points[].retentionRole)
 * for the active body — the authoritative framework source for Step3 coverage.
 * Returns null when the planner ledger is unavailable (fall back to subpoint.points).
 */

/**
 * ③ 权威骨架：当前 active body 对应的 planner bodyPlans.paragraphPlan
 * （含 pointBlocks）。用于把教练回合返回的 plan 对齐到 planner 骨架。
 */

/**
 * Step 3 confirm-then-write state machine (LLM ask+eval / server write+flow):
 * 1) Freeze confirmed slots; clear all unconfirmed (ignore model prefill).
 * 2) Pending from validated step3SlotEval.pendingText (1 slot) or pendingDrafts
 *    (≥2 consecutive same-block). Material from Step2/Planner may be organized
 *    into pending for confirm (including kickoff) — NEVER silent-write slots.
 * 3) Affirm → commitPendingOnAffirm; keep model next ask unless illegal.
 * 4) Board is truth: illegal dump / fake-complete text is fully vetoed to a short
 *    firstEmpty ask (safety net — not the primary coach voice).
 */

function applyStepCompletionHeuristic(data: any, stepNum: number, session?: any): void {
  if (!data) return;

  let shouldForceComplete = false;

  if (stepNum === 1) {
    if (data.text && textSuggestsStep1Complete(data.text)) {
      shouldForceComplete = true;
    }
    // Anti-drift: Step 2 payload must not appear while Step 1 is active.
    if (
      data.progressUpdate?.step2Data &&
      typeof data.progressUpdate.step2Data === "object"
    ) {
      shouldForceComplete = true;
    }
  } else if (stepNum === 2) {
    const driftedToStep3 =
      !!data.progressUpdate?.paragraphPlan ||
      (Array.isArray(data.progressUpdate?.step3SubpointSteps) &&
        data.progressUpdate.step3SubpointSteps.length > 0);
    if (driftedToStep3) {
      shouldForceComplete = true;
    } else if (data.text && textSuggestsStep2Complete(data.text)) {
      // Only force-complete on CTA when already in summary (or this turn sets it).
      const stage = resolveStep2CurrentStage(data, session);
      if (stage === "summary") {
        shouldForceComplete = true;
      }
    }
  } else if (stepNum === 3) {
    // Do NOT force-complete Step 3 from CTA text alone.
    // enforceStep3LogicCompletion / finalizeStep3WholeStepCompletion is the
    // sole authority: every body must be quality-filled on the board.
    shouldForceComplete = false;
  } else if (data.text) {
    const t = data.text;
    if (
      t.includes("进入第二步") ||
      t.includes("进入第三步") ||
      t.includes("进入第四步") ||
      t.includes("进入下一阶")
    ) {
      shouldForceComplete = true;
    }
  }

  if (!shouldForceComplete) return;

  if (!data.progressUpdate) {
    data.progressUpdate = { isCompleted: true };
  } else {
    data.progressUpdate.isCompleted = true;
  }
}

/** Loose check: does this text end with (or contain near its end) a question mark? */
function looksLikeQuestionEnding(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  const tail = t.slice(-60);
  if (/[?？]/.test(tail)) return true;
  // Decision CTAs (采纳/拒绝 buttons) are valid endings even when phrased as a
  // statement — momentum must not replace a legitimate proposal ask.
  const ctaTail = t.slice(-160);
  return (
    /请点击[^。！!]{0,40}[「『]?采纳[」』]?/.test(ctaTail) ||
    /[「『]采纳[」』][^。！!]{0,40}[「『]拒绝[」』]/.test(ctaTail) ||
    /点击下方[^。！!]{0,40}采纳/.test(ctaTail)
  );
}

/**
 * Deterministic safety net for the "PROACTIVE MOMENTUM" prompt rule: Part 2
 * must always be a question or a completion CTA. If the model's response ends
 * with neither (pure praise/analysis and nothing else), the conversation stalls
 * and the student sees no forward action — swap in a rule-based fallback
 * question for the current stage/task instead of leaving it dangling.
 */
/**
 * Stance recommend confirm: ensure pendingStanceConfirm is armed for UI,
 * handle accept → summary, reject → ask for custom stance.
 */
function applyStep2StanceConfirmPostProcess(
  data: any,
  session: any,
  userMessage: string,
  options?: { decision?: { type?: string; action?: string } | null },
): void {
  const step2 = data?.progressUpdate?.step2Data;
  if (!step2 || typeof step2 !== "object") return;
  const payload = step2.plannerPayload;
  if (!payload || typeof payload !== "object") return;

  const decisionType = String(options?.decision?.type || "").trim();
  const decisionAction = String(options?.decision?.action || "").trim();
  const requiresStance = step2.requiresStance !== false && payload.requiresStance !== false;
  if (!requiresStance) {
    payload.pendingStanceConfirm = null;
    return;
  }

  // Sync flags onto step2 for session persistence via coachEvaluation merge
  step2.stanceConfirmResolved = Boolean(payload.stanceConfirmResolved);
  step2.stanceAwaitingCustom = Boolean(payload.stanceAwaitingCustom);

  if (decisionType === "stance" && decisionAction === "accept") {
    const locked = String(
      step2.userStance || payload.stance?.text || "",
    ).trim();
    if (locked) {
      step2.currentStage = "summary";
      payload.pendingStanceConfirm = null;
      payload.stanceConfirmResolved = true;
      step2.stanceConfirmResolved = true;
      if (data?.text) {
        const split = splitTwoParts(String(data.text), 1);
        data.text =
          `${safeOverridePart1(split.part1 || "好的，立场已锁定。")}\n\n---\n\n` +
          `立场已确认。若材料没有要改的地方，请确认进入下一步；若要改，直接指出要调整的论点。`;
      }
      console.warn("[Step2StanceConfirm] Accepted → summary");
    }
    return;
  }

  if (decisionType === "stance" && decisionAction === "reject") {
    payload.pendingStanceConfirm = null;
    payload.stanceAwaitingCustom = true;
    step2.stanceAwaitingCustom = true;
    step2.stanceConfirmResolved = false;
    payload.stanceConfirmResolved = false;
    if (data?.text) {
      const split = splitTwoParts(String(data.text), 1);
      data.text =
        `${safeOverridePart1(split.part1 || "好的，我们不用刚才的推荐。")}\n\n---\n\n` +
        `请直接用一两句话写出你的整体立场（例如利弊参半 / 更偏积极 / 更偏消极）。`;
    }
    console.warn("[Step2StanceConfirm] Rejected → awaiting custom stance");
    return;
  }

  // Never re-arm after resolve
  if (payload.stanceConfirmResolved) {
    payload.pendingStanceConfirm = null;
    return;
  }

  // Arm only when checklist walk is done (评价侧 thin → never stance CTA)
  const dispositions =
    step2.dimensionDispositions || payload.dimensionDispositions;
  const checklistDone = isStep2ChecklistWalkDone(payload, dispositions);
  const unwalkedStance = listUnwalkedChecklistPoints(payload, dispositions);
  const sideNextStance = resolveNextSideWalkStep(payload, dispositions);
  if (!checklistDone || unwalkedStance.length > 0 || sideNextStance.kind !== "done") {
    payload.pendingStanceConfirm = null;
    if (String(step2.currentStage || "") === "stance") {
      step2.currentStage = "explore_B";
    }
  }
  const stage = String(step2.currentStage || "").trim();
  const suggested = String(step2.suggestedStance || "").trim();
  if (
    checklistDone &&
    unwalkedStance.length === 0 &&
    sideNextStance.kind === "done" &&
    (stage === "stance" ||
      textLooksLikePrematureStanceAsk(String(data.text || "")) ||
      coachMessageLooksLikeStanceDecision(String(data.text || ""))) &&
    !payload.stanceAwaitingCustom &&
    !payload.pendingCapacityTrim?.sideKey &&
    !payload.pendingSlotAdd?.claim
  ) {
    step2.currentStage = "stance";
    const text =
      suggested ||
      String(payload.pendingStanceConfirm?.text || "").trim() ||
      extractStanceRecommendFromText(String(data.text || "")) ||
      String(step2.userStance || "").trim();
    if (text) {
      payload.pendingStanceConfirm = { text };
      if (!suggested) step2.suggestedStance = text;
      // No text rewrite here: applyStep2ProposalChannelLate migrates this
      // pendingStanceConfirm into a kind:'stance' pendingProposal and emits a
      // self-contained ask that carries the stance sentence itself. Rewriting
      // to 「上面是…立场推荐」 used to drop the recommendation body entirely.
      console.warn(
        `[Step2StanceConfirm] Armed pending 「${text.slice(0, 40)}」`,
      );
    }
  } else if (!checklistDone) {
    payload.pendingStanceConfirm = null;
  }
}

/** Persist pendingFocusClaim (thin-ask) as deepen focus for the next student reply. */
function stampStep2ActivePointFromPendingFocus(data: any): void {
  const step2 = data?.progressUpdate?.step2Data;
  const payload = step2?.plannerPayload;
  if (!step2 || !payload || typeof payload !== "object") return;
  const focusClaim = String(step2.pendingFocusClaim || "").trim();
  const outboundText = String(data?.text || "");

  if (focusClaim) {
    const id = findPointIdByClaim(payload.points || [], focusClaim);
    if (id) {
      payload.activePointId = id;
      payload.focusMode = "deepen";
      console.log(`[Step2Focus] deepen armed → ${id} (${focusClaim})`);
    }
    delete step2.pendingFocusClaim;
    return;
  }

  // Non-deepen coach turns (summary / stance / retention / multi-point) clear focus.
  if (
    shouldClearStep2DeepenFocus(outboundText) ||
    payload.focusMode !== "deepen"
  ) {
    if (payload.focusMode === "deepen" && shouldClearStep2DeepenFocus(outboundText)) {
      console.log("[Step2Focus] deepen cleared (coach left single-point ask)");
    }
    if (shouldClearStep2DeepenFocus(outboundText)) {
      payload.focusMode = "none";
      payload.activePointId = undefined;
    }
  }
}

/**
 * After normalize: (1) replace stale thin-ask if active point is now ready;
 * (2) detect coach-proposed new slot → pendingSlotAdd (UI 采纳/拒绝);
 * (3) never re-loop confirm ask after reject — only seed ask on first propose.
 */
function applyStep2FocusAndSlotAddPostProcess(
  data: any,
  session: any,
  userMessage: string,
  options?: { decision?: { type?: string; action?: string } | null },
): void {
  const step2 = data?.progressUpdate?.step2Data;
  const payload = step2?.plannerPayload;
  if (!step2 || !payload) return;

  const text = String(data.text || "");
  const split = splitTwoParts(text, 1);
  const prevPending = session?.step2?.coachEvaluation?.plannerPayload?.pendingSlotAdd;
  const hadPending = Boolean(prevPending?.claim);
  const slotDecision = resolveSlotAddDecision({
    userMessage,
    decision: options?.decision,
    hasPending: hadPending,
  });
  const declined = Array.isArray(payload.declinedSlotClaims)
    ? payload.declinedSlotClaims.map((c: string) => String(c || "").trim())
    : [];

  const turnIntentKind = String(
    (step2 as any)?._studentTurnIntent?.kind || "",
  ).trim();
  const dispositions =
    step2.dimensionDispositions || payload.dimensionDispositions;
  const unwalked = listUnwalkedChecklistPoints(payload, dispositions);
  const checklistDone = isStep2ChecklistWalkDone(payload, dispositions);

  // Meta / process critique must never leave a slot-add confirm UI.
  if (
    turnIntentKind === "meta_process" &&
    (payload.pendingSlotAdd?.claim ||
      /加入材料池|新的平行论点/.test(text))
  ) {
    payload.pendingSlotAdd = null;
    step2.userPoints = stripPendingSlotAddMarker(
      String(step2.userPoints || ""),
    );
    if (split.ok) {
      const ask = buildStep2ContentAwareFallback(session, step2);
      data.text = `${safeOverridePart1(text)}\n\n---\n\n好的，刚才那句是流程反馈，不算新论点。${ask}`;
      console.warn(
        "[Step2SlotAdd] Scrubbed false slot-add after meta_process turn",
      );
      return;
    }
  }

  // HARD GATE: checklist unfinished → never coach-arm slot-add; walk next slot.
  // Student accept of an already-pending add is still allowed mid-walk.
  if (!checklistDone && unwalked.length > 0 && slotDecision !== "accept") {
    const coachTriedSlotAdd =
      Boolean(payload.pendingSlotAdd?.claim) ||
      /加入材料池|新的平行论点|作为一条?新的|新增一条?论点/.test(text);
    if (coachTriedSlotAdd) {
      payload.pendingSlotAdd = null;
      step2.userPoints = stripPendingSlotAddMarker(
        String(step2.userPoints || ""),
      );
      const next = unwalked[0];
      if (next?.id) {
        payload.activePointId = next.id;
        payload.focusMode = "deepen";
        step2.pendingFocusClaim = next.claim;
      }
      if (split.ok || data?.text) {
        const ask = buildStep2ContentAwareFallback(session, step2);
        data.text = `${safeOverridePart1(text)}\n\n---\n\n${ask}`;
      }
      console.warn(
        `[Step2SlotAdd] Checklist gate — scrubbed slot-add; next「${next?.claim || ""}」(unwalked=${unwalked.length})`,
      );
      return;
    }
  }

  // Detect coach proposing a brand-new parallel point (not on locked board).
  // Only when checklist walk is done (or student already opened a propose path).
  // Process advance / same-theme near-synonym → no confirm UI.
  if (
    payload.slotsLocked &&
    checklistDone &&
    !payload.pendingSlotAdd?.claim &&
    slotDecision !== "reject" &&
    turnIntentKind !== "meta_process" &&
    turnIntentKind !== "retention_choice" &&
    turnIntentKind !== "confirm_ack" &&
    turnIntentKind !== "reject_slot_add" &&
    /加入材料池|新的平行论点|作为一条?新的|新增一条?论点/.test(text)
  ) {
    const quoted = [
      ...text.matchAll(/『([^』]{2,40})』/g),
      ...text.matchAll(/「([^」]{2,40})」/g),
    ]
      .map((m) => String(m[1] || "").trim())
      .filter((c) => c.length >= 2 && !/目前还偏薄|材料池|采纳|拒绝/.test(c));
    for (const q of quoted) {
      const qCore = claimMatchCore(q) || q;
      const wasDeclined = declined.some(
        (c) =>
          c === q ||
          c === qCore ||
          headsCompatible(c, q) ||
          headsCompatible(claimMatchCore(c), qCore),
      );
      if (wasDeclined) continue;

      const resolved = resolveProposedClaimAgainstBoard(
        payload.points || [],
        q,
        text,
      );
      if (resolved.kind === "process_advance") {
        console.warn(
          `[Step2SlotAdd] Process-advance 「${qCore}」 — no confirm`,
        );
        if (split.ok) {
          const ask = buildStep2ContentAwareFallback(session, step2);
          data.text = `${safeOverridePart1(text)}\n\n---\n\n${ask}`;
        }
        return;
      }
      if (resolved.kind === "same_slot") {
        payload.activePointId = resolved.point.id;
        payload.focusMode = "deepen";
        console.warn(
          `[Step2SlotAdd] Same-theme 「${qCore}」 → deepen 「${resolved.point.claim}」`,
        );
        if (split.ok) {
          data.text = `${safeOverridePart1(text)}\n\n---\n\n${buildSameSlotDeepenAsk(resolved.point)}`;
        }
        return;
      }
      // Truly new parallel material → arm confirm
      payload.pendingSlotAdd = { claim: resolved.claim };
      const base = stripPendingSlotAddMarker(String(step2.userPoints || ""));
      step2.userPoints =
        `${base} ${formatPendingSlotAddMarker(payload.pendingSlotAdd)}`.trim();
      console.warn(
        `[Step2SlotAdd] Pending new slot 「${resolved.claim}」 — awaiting 采纳/拒绝`,
      );
      break;
    }
  }

  // If pending was already set but is process/same-theme, scrub before CTA
  if (payload.pendingSlotAdd?.claim) {
    const resolved = resolveProposedClaimAgainstBoard(
      payload.points || [],
      payload.pendingSlotAdd.claim,
      text,
    );
    if (resolved.kind === "process_advance") {
      payload.pendingSlotAdd = null;
      step2.userPoints = stripPendingSlotAddMarker(
        String(step2.userPoints || ""),
      );
      if (split.ok) {
        data.text = `${safeOverridePart1(text)}\n\n---\n\n${buildStep2ContentAwareFallback(session, step2)}`;
      }
      console.warn("[Step2SlotAdd] Scrubbed process-advance pending");
      return;
    }
    if (resolved.kind === "same_slot") {
      payload.pendingSlotAdd = null;
      step2.userPoints = stripPendingSlotAddMarker(
        String(step2.userPoints || ""),
      );
      payload.activePointId = resolved.point.id;
      payload.focusMode = "deepen";
      if (split.ok) {
        data.text = `${safeOverridePart1(text)}\n\n---\n\n${buildSameSlotDeepenAsk(resolved.point)}`;
      }
      console.warn(
        `[Step2SlotAdd] Scrubbed same-theme pending → 「${resolved.point.claim}」`,
      );
      return;
    }
  }

  if (!split.ok) return;
  const part1 = split.part1;
  let part2 = split.part2;

  // Stale thin-ask after activePoint attach made the point ready.
  const thinAsk = /「([^」]+)」目前还偏薄/.exec(part2 || "");
  if (thinAsk) {
    const claim = thinAsk[1].trim();
    const pt = activePoints(payload).find(
      (p) =>
        p.claim === claim ||
        headsCompatible(p.claim, claim) ||
        p.claim.includes(claim) ||
        claim.includes(p.claim),
    );
    if (pt && pt.quality === "ready") {
      part2 = buildStep2ContentAwareFallback(session, step2);
      data.text = `${part1}\n\n---\n\n${part2}`;
      console.warn(
        `[Step2Focus] Cleared stale thin-ask for ready point 「${claim}」`,
      );
      return;
    }
  }

  // First-time propose only: seed Part2 confirm copy (UI shows 采纳/拒绝).
  // Do NOT re-force this ask on later turns — reject clears pending and continues.
  if (
    payload.pendingSlotAdd?.claim &&
    !hadPending &&
    slotDecision !== "accept" &&
    slotDecision !== "reject"
  ) {
    const ask = buildSlotAddConfirmAsk(payload.pendingSlotAdd.claim);
    data.text = `${safeOverridePart1(text)}\n\n---\n\n${ask}`;
    console.log(
      `[Step2SlotAdd] Part2 → decision ask for 「${payload.pendingSlotAdd.claim}」`,
    );
  } else if (slotDecision === "reject" && hadPending) {
    // Ensure coach text doesn't leave a stale "是否加入" as the only CTA.
    if (/是否加入|加上这条|加入材料池/.test(part2 || text)) {
      part2 = buildStep2ContentAwareFallback(session, step2);
      data.text = `${safeOverridePart1(text)}\n\n---\n\n${part2}`;
      console.log("[Step2SlotAdd] Rejected — cleared confirm loop, next ask");
    }
  }
}

function enforceStep2Momentum(
  data: any,
  session: any,
  opts?: { channelAuthoredText?: boolean },
): void {
  if (!data?.progressUpdate) return;
  const text = String(data.text || "");
  if (!text.trim()) return;
  if (data.progressUpdate.isCompleted) return;
  if (textSuggestsStep2Complete(text)) return;

  const oldStage = String(
    session?.step2?.coachEvaluation?.currentStage ||
      session?.step2?.currentStage ||
      "explore_A",
  ).trim();
  let stage = resolveStep2CurrentStage(data, session);

  if (
    !data.progressUpdate.step2Data ||
    typeof data.progressUpdate.step2Data !== "object"
  ) {
    data.progressUpdate.step2Data = {};
  }
  const step2 = data.progressUpdate.step2Data;
  const userPoints = String(
    step2.userPoints ||
      session?.step2?.coachEvaluation?.userPoints ||
      session?.step2?.userPoints ||
      "",
  );
  const requiresStance = step2.requiresStance !== false;
  const payload =
    step2.plannerPayload || session?.step2?.coachEvaluation?.plannerPayload;
  const missing: string[] = Array.isArray(payload?.coverage?.missingBuckets)
    ? payload.coverage.missingBuckets
    : [];
  const readyCount = activePoints(payload).filter((p) =>
    isPointExpandedForWalk(p),
  ).length;
  const exploreDone = isStep2ExploreDone({
    payload,
    step2Data: step2,
    session,
  });
  const unwalked = listUnwalkedChecklistPoints(
    payload,
    step2.dimensionDispositions || payload?.dimensionDispositions,
  );
  // Coverage-first; legacy A/B solid signals only as soft fallback.
  // When any seedOnly sprouts remain, ignore text-length solid (Step1 seeds
  // inflate userPoints without a Step2 expand).
  const hasSeedOnlySprouts = activePoints(payload).some(
    (p) => p.seedOnly === true,
  );
  const aExpanded = activePoints(payload).some(
    (p) =>
      isPointExpandedForWalk(p) &&
      /part_1|view_a|advantage|cause|positive|support_main/.test(
        pointSideKey(p),
      ),
  );
  const bExpanded = activePoints(payload).some(
    (p) =>
      isPointExpandedForWalk(p) &&
      /part_2|view_b|disadvantage|solution|negative|oppose_or_qualify/.test(
        pointSideKey(p),
      ),
  );
  const aSolid =
    aExpanded ||
    (!hasSeedOnlySprouts &&
      (readyCount >= 1 || sideHasSolidExploreContent(userPoints, "A")));
  const bSolid =
    missing.length === 0
      ? true
      : bExpanded ||
        (!hasSeedOnlySprouts && sideHasSolidExploreContent(userPoints, "B"));

  const afterExploreStage = () =>
    exploreDone
      ? requiresStance
        ? "stance"
        : "summary"
      : missing.length > 0 ||
          unwalked.some((u) =>
            /part_2|view_b|disadvantage|solution|negative/.test(u.sideKey),
          )
        ? "explore_B"
        : "explore_A";

  // Verbal advance: never jump to stance before exploreDone
  if (
    stage === oldStage &&
    (oldStage === "explore_A" || oldStage === "explore_B") &&
    textSuggestsExploreSideAdvance(text, oldStage)
  ) {
    if (oldStage === "explore_A") {
      stage = afterExploreStage() === "stance" || afterExploreStage() === "summary"
        ? afterExploreStage()
        : missing.length > 0
          ? "explore_B"
          : afterExploreStage();
    } else {
      stage = afterExploreStage();
    }
    step2.currentStage = stage;
    console.warn(
      `[Step2Momentum] Repaired verbal stage advance ${oldStage} -> ${stage} before fallback selection.`,
    );
  }

  // Checklist-aware advance — stance only after exploreDone (not bucket fill alone)
  if (stage === "explore_A" && aSolid && !exploreDone) {
    const next = afterExploreStage();
    if (next === "explore_B") {
      stage = "explore_B";
      step2.currentStage = stage;
      console.warn(
        `[Step2Momentum] explore_A solid → stage=${stage} (exploreDone=${exploreDone}, unwalked=${unwalked.length})`,
      );
    }
  } else if (
    (stage === "explore_A" || stage === "explore_B") &&
    exploreDone
  ) {
    stage = afterExploreStage();
    step2.currentStage = stage;
    console.warn(
      `[Step2Momentum] checklist done → stage=${stage}`,
    );
  } else if (stage === "explore_B" && bSolid && aSolid && exploreDone) {
    stage = afterExploreStage();
    step2.currentStage = stage;
  } else if (
    (stage === "stance" || stage === "summary") &&
    !exploreDone
  ) {
    stage = afterExploreStage();
    if (stage === "stance" || stage === "summary") stage = "explore_B";
    step2.currentStage = stage;
    console.warn(
      `[Step2Momentum] Clamped premature stance → ${stage} (unwalked=${unwalked.length})`,
    );
  }

  if (stage === "summary") return;

  // Text authored by the proposal channel this turn (accept ack + recap +
  // next ask) is final — stage repairs above still ran, but momentum must
  // not rewrite it (it was eating the server recap of committed roles).
  if (opts?.channelAuthoredText) return;

  const split = splitTwoParts(text, 2);
  if (!split.ok) return;
  if (looksLikeQuestionEnding(split.part2)) return;

  let fallbackStage = stage;
  if (fallbackStage === "explore_A" && aSolid && !exploreDone) {
    const next = afterExploreStage();
    if (next === "explore_B") {
      fallbackStage = "explore_B";
      step2.currentStage = fallbackStage;
    }
  }
  if (
    (fallbackStage === "explore_A" || fallbackStage === "explore_B") &&
    exploreDone
  ) {
    fallbackStage = afterExploreStage();
    if (fallbackStage === "summary") return;
    step2.currentStage = fallbackStage;
  }

  const fallback = buildStep2ContentAwareFallback(session, step2);
  // Keep genuine Part1; never replace with the dead "记下了" phrase.
  const keepP1 =
    String(split.part1 || "").trim() || safeOverridePart1(text) || "好的。";
  const stanceRecommendationAlreadyPresent =
    fallbackStage === "stance" &&
    /(我更推荐|我建议|推荐你|建议采用|更适合采用|最容易自洽|带让步的立场)/.test(
      text,
    );
  data.text = stanceRecommendationAlreadyPresent
    ? `${keepP1}\n\n---\n\n上面是基于你材料的立场推荐。请点击「采纳」锁定，或「拒绝」后告诉我你想改成哪种立场。`
    : `${keepP1}\n\n---\n\n${fallback}`;
  console.warn(
    `[Step2Momentum] Response ended without a question or CTA; appended content-aware prompt for resolved stage=${fallbackStage} (previous=${oldStage}, ready=${readyCount}, unwalked=${unwalked.length}).`,
  );
  scrubStep2StaleDecisionPendingOnContentAsk(data);
}

/**
 * When the visible coach ask is content/deepen (补薄等), clear stale
 * ［待裁决］ so UI does not keep showing 采纳/拒绝 on a non-decision turn.
 */
function scrubStep2StaleDecisionPendingOnContentAsk(data: any): void {
  const text = String(data?.text || "");
  if (!coachMessageIsContentAskNotDecision(text)) return;
  const step2 = data?.progressUpdate?.step2Data;
  if (!step2 || typeof step2 !== "object") return;
  const prevPoints = String(step2.userPoints || "");
  if (PENDING_RETENTION_MARKER_RE.test(prevPoints)) {
    step2.userPoints = prevPoints
      .replace(PENDING_RETENTION_MARKER_RE, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    console.warn(
      "[Step2DecisionUI] Cleared stale ［待裁决］ — current ask is content, not a proposal",
    );
  }
}

function resolveStep2CurrentStage(data: any, session?: any): string {
  return String(
    data?.progressUpdate?.step2Data?.currentStage ||
      session?.step2?.coachEvaluation?.currentStage ||
      session?.step2?.currentStage ||
      "explore_A",
  ).trim();
}

/** Count filled body slots from blueprint.bodies[] or legacy body1/body2. */
function countFilledStep2Bodies(blueprint: any): number {
  if (!blueprint || typeof blueprint !== "object") return 0;
  const bodies = Array.isArray(blueprint.bodies) ? blueprint.bodies : [];
  let count = 0;
  for (const b of bodies) {
    if (String(b?.content || b?.title || "").trim()) count += 1;
  }
  if (count > 0) return count;
  if (String(blueprint.body1 || "").trim()) count += 1;
  if (String(blueprint.body2 || "").trim()) count += 1;
  return count;
}

/**
 * Content gate for Step 2 unlock: stance/overview + at least 2 body paragraphs
 * (or 2 clustering themes). Used when the model emits a completion CTA but
 * forgets to flip currentStage to "summary" (e.g. stuck at "stance").
 */
function isStep2BlueprintContentComplete(
  progressUpdate: any,
  session: any,
): boolean {
  const step2New =
    progressUpdate?.step2Data && typeof progressUpdate.step2Data === "object"
      ? progressUpdate.step2Data
      : {};
  const evalOld = session?.step2?.coachEvaluation || {};
  const blueprint = step2New.blueprint || evalOld.blueprint || {};
  const payload =
    step2New.plannerPayload || evalOld.plannerPayload || null;

  // New contract: payload exitGate + stance
  if (payload?.exitGate?.canComplete) {
    const stanceFromPayload = String(payload.stance?.text || "").trim();
    if (stanceFromPayload || !payload.requiresStance) return true;
  }
  const readyCount = activePoints(payload).filter((p) =>
    isPointExpandedForWalk(p),
  ).length;
  if (readyCount >= 2) {
    const stance = String(
      step2New.userStance ||
        session?.step2?.userStance ||
        evalOld.userStance ||
        payload?.stance?.text ||
        blueprint.position ||
        "",
    ).trim();
    if (stance || payload?.requiresStance === false) return true;
  }

  const stance = String(
    step2New.userStance ||
      session?.step2?.userStance ||
      evalOld.userStance ||
      blueprint.position ||
      "",
  ).trim();
  if (!stance) return false;

  let bodyCount = countFilledStep2Bodies(blueprint);
  if (bodyCount < 2) {
    const clustering = step2New.clustering || evalOld.clustering;
    if (Array.isArray(clustering?.clusters)) {
      bodyCount = clustering.clusters.filter((c: any) =>
        String(c?.content || c?.theme || "").trim(),
      ).length;
    }
  }
  return bodyCount >= 2;
}

/**
 * Step 2 completion gate: unlock jump button on summary + CTA, OR on CTA +
 * substantive blueprint even when the model forgot to flip currentStage
 * (mirrors enforceStep1SlotCompletion's content-first spirit). Must run AFTER
 * applyStepCompletionHeuristic so a mid-explore "进入第三步" hallucination
 * without real blueprint content cannot stick.
 */
function enforceStep2Completion(data: any, session: any): void {
  if (!data?.progressUpdate) return;

  const stage = resolveStep2CurrentStage(data, session);
  const ctaOk = textSuggestsStep2Complete(String(data.text || ""));
  const contentOk = isStep2BlueprintContentComplete(
    data.progressUpdate,
    session,
  );
  const step2 = data.progressUpdate.step2Data || {};
  const payload = step2.plannerPayload || {};
  const checklistDone = isStep2ChecklistWalkDone(
    payload,
    step2.dimensionDispositions || payload.dimensionDispositions,
  );
  // Stance counts only when it went through a confirmed channel（采纳 button
  // or student's own text → stanceConfirmResolved）. A model-prefilled
  // userStance/stance.text must never unlock the next step by itself.
  const stanceOk =
    step2.requiresStance === false ||
    payload.requiresStance === false ||
    Boolean(payload.stanceConfirmResolved) ||
    Boolean(step2.stanceConfirmResolved);
  const materialReady = checklistDone && stanceOk;
  const driftedToStep3 =
    !!data.progressUpdate.paragraphPlan ||
    (Array.isArray(data.progressUpdate.step3SubpointSteps) &&
      data.progressUpdate.step3SubpointSteps.length > 0);

  // Material+stance locked + user/coach advancing → complete even if blueprint thin
  if (
    materialReady &&
    (stage === "summary" || stage === "stance") &&
    (ctaOk ||
      /进入下一步|进入第三步|立即跳转|没有要改/.test(String(data.text || "")))
  ) {
    data.progressUpdate.isCompleted = true;
    step2.currentStage = "summary";
    payload.pendingStanceConfirm = null;
    console.warn(
      "[Step2CompletionGuard] Material-ready unlock → completed summary",
    );
    return;
  }

  if (stage === "summary" && ctaOk && materialReady) {
    data.progressUpdate.isCompleted = true;
    return;
  }

  // Content-gate fallback: completion CTA + real blueprint already present, but
  // currentStage still stuck at explore/stance (classic text/field desync).
  if (ctaOk && contentOk && materialReady) {
    data.progressUpdate.isCompleted = true;
    if (
      !data.progressUpdate.step2Data ||
      typeof data.progressUpdate.step2Data !== "object"
    ) {
      data.progressUpdate.step2Data = {};
    }
    data.progressUpdate.step2Data.currentStage = "summary";
    console.warn(
      `[Step2CompletionGuard] Content-gate unlock: corrected stage ${stage} → summary (ctaOk=true, blueprint filled)`,
    );
    return;
  }

  // Anti-drift: model leaked Step 3 fields into a Step 2 response — keep complete.
  if (driftedToStep3 && materialReady) {
    data.progressUpdate.isCompleted = true;
    return;
  }

  if (data.progressUpdate.isCompleted && !materialReady) {
    data.progressUpdate.isCompleted = false;
    console.warn(
      `[Step2CompletionGuard] Cleared premature isCompleted (stage=${stage}, checklistDone=${checklistDone}, stanceOk=${stanceOk})`,
    );
  } else if (data.progressUpdate.isCompleted && !ctaOk && !materialReady) {
    data.progressUpdate.isCompleted = false;
    console.warn(
      `[Step2CompletionGuard] Cleared premature isCompleted (stage=${stage}, ctaOk=${ctaOk}, contentOk=${contentOk})`,
    );
  }
}

function ensureStep1DataBucket(data: any, merged: Record<string, any>): any {
  if (!data.progressUpdate.step1Data || typeof data.progressUpdate.step1Data !== "object") {
    data.progressUpdate.step1Data = { ...merged };
  }
  return data.progressUpdate.step1Data;
}

function enforceStep1SlotCompletion(
  data: any,
  session: any,
  userMessage = "",
): void {
  if (!data?.progressUpdate) return;

  sanitizeStep1ConstraintMarkers(data.progressUpdate);

  const merged = mergeStep1Evaluation(data.progressUpdate, session);
  let dims = Array.isArray(merged.suggestedDimensions)
    ? [...merged.suggestedDimensions]
    : [];

  // Confirmed probe stamps: prior session tags win over model rewrite.
  const priorDims =
    session?.step1?.coachEvaluation?.suggestedDimensions ||
    session?.step1?.boardOverrides?.suggestedDimensions ||
    [];
  const priorDimsList = Array.isArray(priorDims) ? priorDims.map(String) : [];
  const preserved = preserveStep1ProbeTags(dims.map(String), priorDimsList);
  if (
    preserved.restoredCores.length > 0 ||
    preserved.reappendedCores.length > 0
  ) {
    dims = preserved.dims;
    const target = ensureStep1DataBucket(data, merged);
    target.suggestedDimensions = dims;
    if (preserved.restoredCores.length > 0) {
      console.warn(
        `[Step1Guard] Restored probe tags for: ${preserved.restoredCores.join("、")}`,
      );
    }
    if (preserved.reappendedCores.length > 0) {
      console.warn(
        `[Step1Guard] Re-appended probed dims dropped by model: ${preserved.reappendedCores.join("、")}`,
      );
    }
  }

  // Phase A-1: strip same-turn self-reported probe/expandable tags on NEW labels.
  const stripped = stripIllegalSameTurnProbeTags(
    dims.map(String),
    priorDimsList,
  );
  if (stripped.strippedCores.length > 0) {
    dims = stripped.dims;
    const target = ensureStep1DataBucket(data, merged);
    target.suggestedDimensions = dims;
    console.warn(
      `[Step1Guard] Stripped same-turn probe tags on new dims: ${stripped.strippedCores.join("、")}`,
    );
  }

  // B-lite: resolve last turn's server-forced probe via probeVerdict (server stamps).
  const pendingProbeCore = String(
    session?.step1?.coachEvaluation?.pendingProbeCore ||
      merged.pendingProbeCore ||
      "",
  ).trim();
  if (pendingProbeCore && String(userMessage || "").trim()) {
    const verdict =
      data.progressUpdate?.step1Data?.probeVerdict ?? merged.probeVerdict;
    dims = resolvePendingProbeAnswer(
      dims.map(String),
      pendingProbeCore,
      verdict,
    );
    const target = ensureStep1DataBucket(data, merged);
    target.suggestedDimensions = dims;
    target.pendingProbeCore = "";
    target.probeVerdict = "";
    console.warn(
      `[Step1Guard] Resolved pending probe for「${pendingProbeCore}」verdict=${String(verdict || "thin/default")}`,
    );
  }

  // Escape: ONLY student exhausted → stamp remaining bare as 质量待确认.
  // Cap alone must NOT stamp (that aborted live probes when label count hit 6).
  const dimLabelCount = countStep1DimensionLabels(dims);
  const exhausted = studentSignalsExhausted(userMessage);
  if (exhausted) {
    const before = countUnprobedStep1Dimensions(dims);
    if (before > 0) {
      dims = stampUnprobedQualityPending(dims.map(String));
      const target = ensureStep1DataBucket(data, merged);
      target.suggestedDimensions = dims;
      target.pendingProbeCore = "";
      console.warn(
        `[Step1Guard] Escape hatch: stamped ${before} unprobed dim(s) as 质量待确认 (student exhausted)`,
      );
    }
  }

  const step1New =
    data.progressUpdate.step1Data &&
    typeof data.progressUpdate.step1Data === "object"
      ? data.progressUpdate.step1Data
      : null;
  // Keep merged view in sync for downstream counts.
  merged.suggestedDimensions = dims;
  if (step1New) step1New.suggestedDimensions = dims;

  const effectiveCount = countEffectiveStep1Dimensions(dims);
  const dimsSufficient = computeStep1DimensionsSufficient({
    ...merged,
    suggestedDimensions: dims,
  });
  if (step1New) {
    step1New.dimensionsSufficient = dimsSufficient;
  }
  const slotsOk = isStep1SlotsComplete({
    ...merged,
    suggestedDimensions: dims,
    dimensionsSufficient: dimsSufficient,
  });
  const text = String(data.text || "");
  const softExitAsk = textOffersStep1Exit(text);
  const ctaOk = textSuggestsStep1Complete(text);
  const unprobed = earliestUnprobedDimension(dims.map(String));

  // Soft exit round must never unlock the jump button.
  if (softExitAsk && !ctaOk) {
    data.progressUpdate.isCompleted = false;
  }

  // v2 probe-first: any bare label → Part2 must probe the earliest one
  // (blocks Task-B jump, soft exit, CTA, and model merge-probes).
  if (unprobed) {
    data.progressUpdate.isCompleted = false;
    const target = ensureStep1DataBucket(data, merged);
    target.suggestedDimensions = dims;
    target.exitOffered = false;
    // Do not claim sufficiency while bare labels remain.
    if (!step1CapProbeComplete(dims.map(String), STEP1_DIM_MAX)) {
      target.dimensionsSufficient = false;
    }
    target.pendingProbeCore = stripStep1DimensionTags(unprobed);
    const alreadyProbing = textLooksLikeProbeAskForDim(text, unprobed);
    if (!alreadyProbing) {
      const split = splitTwoParts(text, 1);
      const part1 = safeOverridePart1(
        split.part1 || "这个角度我先记下了。",
      );
      data.text = `${part1}\n\n---\n\n${buildBareDimensionProbeAsk(unprobed)}`;
      console.warn(
        `[Step1Guard] Probe-first: rewrote Part2 to probe「${target.pendingProbeCore}」(labels=${dimLabelCount}, unprobed=${countUnprobedStep1Dimensions(dims)})`,
      );
    } else {
      console.warn(
        `[Step1Guard] Probe-first: armed pendingProbeCore「${target.pendingProbeCore}」(model ask kept)`,
      );
    }
    return;
  }

  // Only stamp exitOffered when AI/server already judges dimensions sufficient
  // AND no unprobed bare labels remain.
  if (
    dimsSufficient &&
    !unprobed &&
    (softExitAsk || step1DimsHaveExitOfferedTag(dims))
  ) {
    const target = ensureStep1DataBucket(data, merged);
    target.dimensionsSufficient = true;
    ensureStep1ExitOfferedFlag(target, Array.isArray(target.suggestedDimensions)
      ? target.suggestedDimensions
      : dims);
  } else if (!dimsSufficient && softExitAsk) {
    // Model asked "enough?" too early — rewrite to keep collecting.
    data.progressUpdate.isCompleted = false;
    const target = ensureStep1DataBucket(data, merged);
    target.dimensionsSufficient = false;
    target.exitOffered = false;
    const split = splitTwoParts(text, 1);
    const part1 = safeOverridePart1(
      split.part1 || "目前可展开的角度还偏少。",
    );
    data.text = `${part1}\n\n---\n\n目前比较扎实的分析角度还不到 ${STEP1_DIM_MIN_EFFECTIVE} 个。请再补充一个不同的中性角度（不要和已有角度重复）。`;
    console.warn(
      `[Step1Guard] Soft exit asked before sufficiency (effective=${effectiveCount}); forcing more angles.`,
    );
    return;
  }

  const mergedAfter = mergeStep1Evaluation(data.progressUpdate, session);
  const exitOpen = isStep1ExitGateOpen(mergedAfter, session, userMessage);
  const newDimSameTurn = step1HasNewlyIntroducedDimension(
    mergedAfter.suggestedDimensions,
    session,
  );

  // Same-turn guard: cannot complete in the turn that first introduces a dimension
  // (probe/exit must happen before CTA).
  if ((ctaOk || data.progressUpdate.isCompleted) && newDimSameTurn) {
    data.progressUpdate.isCompleted = false;
    const target = ensureStep1DataBucket(data, mergedAfter);
    const bare =
      earliestUnprobedDimension(
        Array.isArray(target.suggestedDimensions)
          ? target.suggestedDimensions.map(String)
          : dims.map(String),
      ) || unprobed;
    const split = splitTwoParts(text, 1);
    const part1 = safeOverridePart1(
      split.part1 || "这个角度我先记下了。",
    );
    const ask = bare
      ? buildBareDimensionProbeAsk(bare)
      : "这个角度你脑子里已经有具体场景或例子的苗头了吗？有的话简单说一句信号即可；还没有的话我们再换一个角度。";
    if (bare) {
      target.pendingProbeCore = stripStep1DimensionTags(bare);
      target.exitOffered = false;
    }
    data.text = `${part1}\n\n---\n\n${ask}`;
    console.warn(
      "[Step1Guard] Blocked same-turn complete while new dimension introduced; requiring probe/exit offer.",
    );
    return;
  }

  // Soft-exit-only text must never set isCompleted even if model flipped the flag.
  if (softExitAsk && !ctaOk) {
    data.progressUpdate.isCompleted = false;
  }

  // Exit gate: sufficiency + exit offer / student stop / cap before hard CTA unlock.
  if ((ctaOk || data.progressUpdate.isCompleted) && slotsOk && dimsSufficient && !exitOpen) {
    data.progressUpdate.isCompleted = false;
    if (!data.progressUpdate.step1Data) {
      data.progressUpdate.step1Data = { ...mergedAfter };
    }
    ensureStep1ExitOfferedFlag(
      data.progressUpdate.step1Data,
      Array.isArray(data.progressUpdate.step1Data.suggestedDimensions)
        ? data.progressUpdate.step1Data.suggestedDimensions
        : dims,
    );
    const split = splitTwoParts(text, 1);
    const part1 = safeOverridePart1(
      split.part1 || "目前已经有几个可以展开的分析角度了。",
    );
    data.text = `${part1}\n\n---\n\n这几个角度已经可以支撑分析了。你还能想到别的中性角度吗？如果暂时想不到别的，告诉我，我们再进入第二步。`;
    console.warn(
      "[Step1Guard] Blocked premature Step1 completion; exit offer required after sufficiency.",
    );
    return;
  }

  // Strict tags / count: model claimed complete but slots or sufficiency short.
  if ((ctaOk || data.progressUpdate.isCompleted) && (!slotsOk || !dimsSufficient)) {
    data.progressUpdate.isCompleted = false;
    const split = splitTwoParts(text, 1);
    const part1 = safeOverridePart1(
      split.part1 || "我们先把讨论角度确认清楚。",
    );
    const ask =
      effectiveCount < STEP1_DIM_MIN_EFFECTIVE
        ? `目前可确认展开的角度是 ${effectiveCount} 个，还需要至少 ${STEP1_DIM_MIN_EFFECTIVE} 个。请再补充一个不同的中性角度，并说明有没有具体场景苗头。`
        : "请确认这些角度是否已有具体场景苗头；如果暂时想不到别的，告诉我，我们再进入第二步。";
    data.text = `${part1}\n\n---\n\n${ask}`;
    if (dimsSufficient) {
      if (!data.progressUpdate.step1Data) {
        data.progressUpdate.step1Data = { ...mergedAfter };
      }
      ensureStep1ExitOfferedFlag(
        data.progressUpdate.step1Data,
        Array.isArray(data.progressUpdate.step1Data.suggestedDimensions)
          ? data.progressUpdate.step1Data.suggestedDimensions
          : dims,
      );
    }
    console.warn(
      `[Step1Guard] Cleared completion; effectiveDims=${effectiveCount} sufficient=${dimsSufficient}.`,
    );
    return;
  }

  // Only unlock when slots filled, dimensions sufficient, exit gate open,
  // AND hard completion CTA (click next-step button) is present.
  if (slotsOk && ctaOk && exitOpen && dimsSufficient) {
    data.progressUpdate.isCompleted = true;
    if (data.progressUpdate.step1Data) {
      data.progressUpdate.step1Data.dimensionsSufficient = true;
    }
    if (data.progressUpdate.step2Data) {
      delete data.progressUpdate.step2Data;
    }
    return;
  }

  // Premature-completion guard: clear isCompleted if the model set it while
  // still asking a follow-up (no hard completion CTA in this turn's text).
  if (data.progressUpdate.isCompleted && !ctaOk) {
    data.progressUpdate.isCompleted = false;
  }
}

/** Network-level errors shared by every Gemini model — retrying other models is futile. */
function isNetworkLevelError(error: any): boolean {
  if (!error) return false;
  const msg = String(
    error?.message || error?.cause?.message || error?.toString?.() || "",
  );
  const causeCode = String(error?.cause?.code || "");
  return (
    msg.includes("fetch failed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("socket hang up") ||
    msg.includes("UND_ERR_CONNECT_TIMEOUT") ||
    msg.includes("UND_ERR_SOCKET") ||
    msg.includes("connect ETIMEDOUT") ||
    causeCode.startsWith("UND_ERR") ||
    causeCode === "ECONNREFUSED" ||
    causeCode === "ECONNRESET" ||
    causeCode === "ENOTFOUND" ||
    causeCode === "ETIMEDOUT"
  );
}

/** 当前 LLM 提供商：gemini（默认）| openai-compatible */
function getLLMProvider(): "gemini" | "openai-compatible" {
  const p = String(process.env.LLM_PROVIDER || "").trim().toLowerCase();
  return p === "openai" || p === "openai-compatible"
    ? "openai-compatible"
    : "gemini";
}

/** Gemini 模型列表（可用 GEMINI_MODELS=model1,model2 覆盖）。 */
function getGeminiModels(): string[] {
  const raw = String(process.env.GEMINI_MODELS || "").trim();
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [
    "gemini-3.5-flash",
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-2.5-pro",
  ];
}

/**
 * OpenAI 兼容提供商调用（DeepSeek / Kimi / OpenRouter / 本地 vLLM、Ollama 等）。
 * 通过环境变量配置：
 *   LLM_PROVIDER=openai-compatible
 *   OPENAI_API_KEY=<key>
 *   OPENAI_BASE_URL=<例如 https://api.deepseek.com/v1>
 *   OPENAI_MODEL=<例如 deepseek-chat>
 * 返回与 Gemini 相同的信封结构 { candidates: [{ content: { parts: [{ text }] } }] }，
 * 调用方无需改动。
 */
async function generateOpenAICompat(params: {
  contents: any;
  config?: any;
}): Promise<any> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "MY_OPENAI_API_KEY") {
    throw new Error(
      "OPENAI_API_KEY is not set (LLM_PROVIDER=openai-compatible). Add your key in .env or Settings > Secrets.",
    );
  }
  const baseUrl = (
    process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
  )
    .trim()
    .replace(/\/+$/, "");
  const model = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

  // Normalize Gemini-style contents → OpenAI messages.
  // contents 可能是字符串（多数 chat 路径直接传 prompt）或
  // [{ role, parts:[{text}] }]（buildCoachRequest/buildIntentRequest/buildPlannerRequest）。
  // 旧实现只处理数组，字符串会得到空 messages → DeepSeek 400 "Empty input messages"。
  const rawContents = params.contents;
  const messages: Array<{ role: string; content: string }> = [];
  if (typeof rawContents === "string") {
    const t = String(rawContents).trim();
    if (t) messages.push({ role: "user", content: t });
  } else if (Array.isArray(rawContents)) {
    for (const c of rawContents) {
      const parts = Array.isArray(c?.parts) ? c.parts : [];
      const text = parts
        .map((p: any) => String(p?.text || ""))
        .join("")
        .trim();
      if (!text) continue;
      const role =
        c?.role === "assistant" || c?.role === "model"
          ? "assistant"
          : "user";
      messages.push({ role, content: text });
    }
  }
  // Gemini-style systemInstruction → OpenAI system message（放最前）。
  const sys = String(params.config?.systemInstruction || "").trim();
  if (sys) {
    messages.unshift({ role: "system", content: sys });
  }
  if (!messages.length) {
    throw new Error(
      "OpenAI-compatible: empty contents — no message to send to LLM.",
    );
  }

  // max_tokens 上限：不同端点上限不同（DeepSeek deepseek-chat=8192，
  // OpenAI=16384）。调用方常传 32768（Gemini 用），超限会被端点 400 拒绝，
  // 故用 OPENAI_MAX_TOKENS 收敛（默认 8192）。
  const maxTokensCap = Number(process.env.OPENAI_MAX_TOKENS || 8192);
  const requested = params.config?.maxOutputTokens ?? maxTokensCap;
  const maxTokens =
    Number.isFinite(maxTokensCap) && maxTokensCap > 0
      ? Math.min(requested, maxTokensCap)
      : requested;
  const body: Record<string, any> = {
    model,
    messages,
    temperature:
      typeof params.config?.temperature === "number"
        ? params.config.temperature
        : 0.7,
    max_tokens: maxTokens,
  };
  if (params.config?.responseMimeType === "application/json") {
    body.response_format = { type: "json_object" };
  }

  const url = `${baseUrl}/chat/completions`;
  log.llmRequest(model, JSON.stringify(messages).slice(0, 300));
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(
      `OpenAI-compatible API error ${res.status}: ${errText.slice(0, 300)}`,
    ) as any;
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const content = String(
    data?.choices?.[0]?.message?.content || "",
  );
  return {
    // 顶层 text：多数调用方用 response.text（Gemini GenerateContentResponse
    // 自带 .text getter，OpenAI 兼容路径必须补上，否则 undefined）。
    text: content,
    candidates: [{ content: { parts: [{ text: content }] } }],
  };
}

/** OpenAI 兼容路径：单模型 + 3 次重试。 */
async function generateOpenAICompatWithRetry(params: {
  contents: any;
  config?: any;
}): Promise<any> {
  const model = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
  let lastError: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(
        `[LLM] Attempting generation via openai-compatible (${model}) attempt ${attempt}/3`,
      );
      const response = await generateOpenAICompat(params);
      const rawText =
        response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      log.llmResponse(model, rawText);
      return response;
    } catch (error: any) {
      lastError = error;
      console.warn(
        `[LLM] openai-compatible attempt ${attempt} failed:`,
        error.message || error,
      );
      log.llmError(model, error);
      if (
        error?.status === 401 ||
        error?.status === 403 ||
        isNetworkLevelError(error)
      ) {
        throw error;
      }
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
  }
  throw lastError || new Error("OpenAI-compatible LLM failed after retries.");
}

async function generateContentWithFallback(params: {
  contents: any;
  config?: any;
}): Promise<any> {
  // 多提供商分派：openai-compatible 走 OpenAI 兼容端点，其余走 Gemini。
  if (getLLMProvider() === "openai-compatible") {
    return generateOpenAICompatWithRetry(params);
  }

  const ai = getAI();
  const models = getGeminiModels();
  let lastError: any = null;

  for (const model of models) {
    let retries = 2;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(
          `[Gemini] Attempting generation with model: ${model} (attempt ${attempt}/${retries})`,
        );
        log.llmRequest(model, JSON.stringify(params.contents).slice(0, 300));
        const response = await ai.models.generateContent({
          model,
          contents: params.contents,
          config: params.config,
        });
        const rawText = response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        log.llmResponse(model, rawText);
        return response;
      } catch (error: any) {
        lastError = error;
        console.warn(
          `[Gemini] Model ${model} (attempt ${attempt}) failed. Error:`,
          error.message || error,
        );
        log.llmError(model, error);

        // Network-level failures (fetch failed / connect timeout / refused / DNS)
        // are shared by every model — trying the remaining models only wastes time
        // (each attempt can block ~10s+). Fast-fail so the caller can fall back
        // (e.g. Planner fallback, coach error) without a ~110s stall.
        if (isNetworkLevelError(error)) {
          console.warn(
            `[Gemini] Network-level failure — skipping remaining models (${models.length} models × 2 attempts avoided).`,
          );
          throw error;
        }

        if (
          error.message?.includes("API_KEY") ||
          error.message?.includes("not set") ||
          error.message?.includes("unauthorized") ||
          error.message?.includes("invalid") ||
          error.status === 401 ||
          error.status === 403
        ) {
          throw error;
        }

        if (error.status === 404) {
          // Model not found, skip to next model
          break;
        }

        if (error.status === 503) {
          // Model overloaded, immediately fall back to the next model.
          break;
        }

        if (error.status === 429) {
          // If quota exceeded, try to extract retry delay, default 5s
          const delayMatch = (error.message || "").match(
            /retry in ([\d\.]+)s/i,
          );
          const delaySec = delayMatch ? parseFloat(delayMatch[1]) : 5;
          if (delaySec > 10) {
            console.log(
              `[Gemini] Rate limited with long delay (${delaySec}s). Skipping to next model...`,
            );
            break;
          }
          if (attempt < retries) {
            const delayMs = delaySec * 1000 + 500; // add 500ms buffer
            console.log(
              `[Gemini] Rate limited. Waiting ${delayMs}ms before retry...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        } else if (attempt < retries) {
          const delay = attempt * 1000;
          console.log(`[Gemini] Waiting ${delay}ms before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }

  throw lastError || new Error("All fallback models failed.");
}

// Step 2 Dimension Coverage & Retention Guard.
//
// The prompt-only "Dimension Coverage & Retention Rule" is diluted by the huge
// multi-thousand-line Step 2 prompt and gets silently ignored by the model in
// practice (verified via isolated testing: the same check succeeds reliably in a
// small, narrow-scope prompt but fails inside the full prompt). This guard runs a
// SEPARATE, narrow-scope verification call only at the moment a Step 2 explore
// stage is about to transition, and corrects the response deterministically if an
// uncovered sibling dimension is found. State is persisted purely in
// progressUpdate.step2Data.userPoints (the only Layer-1 field available in real
// time during explore_A/explore_B) using a "［待裁决：...］" marker.
//
// Product rule (recommend → confirm → tag):
// Coach may recommend a 详写/略写 scheme, but MUST NOT lock tags until the student
// explicitly confirms (「同意」「就这样」「①详写、②③略写」…). Bounce-backs like
// 「你觉得呢」/「你定」are NOT confirmation — restate the proposal and ask to confirm.
// Merge-into-one-body is Planner's job; Step2 only tags each board slot.

// Marker format (new): ［待裁决：详=<developed>｜略=<uncovered>｜默认=<recommendation>］
// Legacy format still parsed: ［待裁决：<uncovered>｜<recommendation>］
const PENDING_RETENTION_MARKER_RE =
  /［待裁决：(?:详=([^｜］]+)｜略=([^｜］]+)｜默认=([^］]+)|([^｜］]+)(?:｜([^］]+))?)］/;

type RetentionRecommendation = "EXPAND_BOTH" | "KEEP_MINOR" | "DROP";

type PendingRetention = {
  developed: string;
  uncovered: string;
  recommendation: RetentionRecommendation | null;
};

function parseRetentionRecommendation(
  raw: string | undefined,
): RetentionRecommendation | null {
  const t = String(raw || "").trim();
  if (t === "KEEP_MINOR" || t === "DROP" || t === "EXPAND_BOTH") return t;
  // Legacy side-walk markers: 默认=SIDE:part_1 → treat as KEEP_MINOR (详+略 scheme).
  // Parsing as null used to fall through to EXPAND_BOTH and「采纳」never locked roles.
  if (/^SIDE:/i.test(t)) return "KEEP_MINOR";
  return null;
}

function isNoBriefUncoveredLabel(uncovered: string): boolean {
  const t = String(uncovered || "").trim();
  return !t || t === "（无）" || t === "(无)" || t === "无";
}

function extractPendingRetention(userPointsText: string): PendingRetention | null {
  const match = PENDING_RETENTION_MARKER_RE.exec(String(userPointsText || ""));
  if (!match) return null;
  // New format groups: 1=详, 2=略, 3=默认; legacy: 4=uncovered, 5=recommendation
  if (match[1] && match[2]) {
    return {
      developed: match[1].trim(),
      uncovered: match[2].trim(),
      recommendation: parseRetentionRecommendation(match[3]),
    };
  }
  const uncovered = String(match[4] || "").trim();
  if (!uncovered) return null;
  return {
    developed: "已展开的这一点",
    uncovered,
    recommendation: parseRetentionRecommendation(match[5]),
  };
}

function shortRetentionLabel(text: string): string {
  return String(text || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/（待补例子）|已展开.*?主论点|已选详写|已选略写|保留-略写|用户放弃|待展开.*$/g, "")
    .trim()
    .slice(0, 28);
}

function isThinRetentionLabel(point: string): boolean {
  const core = shortRetentionLabel(point);
  return core.length < 12;
}

// Soft DEFAULT for retention. Checklist product rule: walk every sibling with
// writable content first; do NOT default to 一详一略 (KEEP_MINOR).
// KEEP_MINOR remains only for explicit student schemes / legacy pending markers.
function decideStep2Retention(
  developedIsSolid: boolean,
  uncoveredRelevantToQuestion: boolean,
): { recommendation: RetentionRecommendation; reasonZh: string } {
  // Uncovered sibling that still matters → expand it first, then 详略 by content.
  if (uncoveredRelevantToQuestion) {
    return {
      recommendation: "EXPAND_BOTH",
      reasonZh: developedIsSolid
        ? "同侧还有未展开论点，先补可写内容再按各条内容量定详略（不默认一详一略）"
        : "已展开的点还不够具体，未展开的兄弟维度也需要先补内容",
    };
  }
  if (!developedIsSolid) {
    return {
      recommendation: "EXPAND_BOTH",
      reasonZh: "已展开的点还不够具体，两个维度都需要先补充内容",
    };
  }
  // Uncovered not relevant → suggest drop, never silent omit
  return {
    recommendation: "DROP",
    reasonZh: "另一点与题目关联较弱，建议先专注已展开的点；也可明确说要保留略写",
  };
}

type RetentionChoiceResult = {
  /** false = do not write tags; ask student to confirm the proposal first */
  applied: boolean;
  developedTag: string;
  uncoveredTag: string;
  needExpandDetail: string | null;
  expandMode: "detail" | "minor_brief" | null;
  allowTransition: boolean;
  summaryZh: string;
  proposalAsk?: string;
};

/** Student bounces the choice back to the coach — NOT a confirmation. */
function isRetentionDeferToCoach(msg: string): boolean {
  const t = String(msg || "").trim();
  if (!t) return false;
  if (
    /^(你觉得呢?|你定|你来定|老师定|你看着办|随便你|听你的|你决定)[。.!！？?\s]*$/i.test(
      t,
    )
  ) {
    return true;
  }
  return /你觉得呢|你来定一下|你帮我定|你定吧|老师定吧/.test(t);
}

/**
 * Soft ack while a ［待裁决］ confirm-ask is pending → accept the soft default.
 * 「你定/你觉得呢」still do NOT count (see isRetentionDeferToCoach).
 */
function isRetentionSoftAckConfirm(msg: string): boolean {
  const t = String(msg || "").trim();
  if (!t || isRetentionDeferToCoach(t)) return false;
  return /^(好的?|好|可以|行|嗯+|哦|噢|ok|okay|yes|采纳)[。.!！？?\s]*$/i.test(t);
}

/** Explicit accept of a recommended 详写/略写 scheme (同意 / 就这样 / …). */
function isRetentionExplicitConfirm(msg: string): boolean {
  const t = String(msg || "").trim();
  if (!t || isRetentionDeferToCoach(t)) return false;
  if (isRetentionSoftAckConfirm(t)) return false;
  return (
    /就这样|就按这个|按这个方案|按你说的|按老师说的|按你推荐|就按你的|同意这个|确认方案|没问题就这样/i.test(
      t,
    ) ||
    (/^(同意|确认)[。.!！？?\s]*$/i.test(t) )
  );
}

/** Pending confirm-ask: explicit OR soft ack both lock the recommended scheme. */
function isRetentionPendingConfirm(msg: string): boolean {
  return isRetentionExplicitConfirm(msg) || isRetentionSoftAckConfirm(msg);
}

function buildRetentionProposalAsk(
  developed: string,
  uncovered: string,
  rec: RetentionRecommendation | null,
): string {
  const dShort = shortRetentionLabel(developed) || "已展开的这一点";
  const uParts = splitRetentionLabels(uncovered);
  const uShort =
    uParts.map((p) => shortRetentionLabel(p)).filter(Boolean).join("、") ||
    shortRetentionLabel(uncovered) ||
    "其余点";
  if (rec === "EXPAND_BOTH") {
    // Content walk — NOT a 采纳/拒绝 详略 lock
    return (
      `『${uShort}』这一条还没展开到可写程度。请先补 1–2 句具体场景、机制或受影响对象；` +
      `补完后再按各条可写量分别定详写/略写（可以都详写，也可以一详一略——由内容量决定，不默认一详一略）。`
    );
  }
  if (rec === "DROP") {
    return `我建议详写『${dShort}』，『${uShort}』先放下不写。请点击下方「采纳」或「拒绝」（仅「采纳」会锁定；也可直接说出你的选择）。`;
  }
  // KEEP_MINOR: only when student/coach explicitly proposed a 详/略 scheme
  return `我建议：**详写**『${dShort}』，**略写**『${uShort}』（略写只表示详略标记，仍各占一条论点）。请点击下方「采纳」或「拒绝」（仅「采纳」会锁定方案；其它回复视为先不锁定）。`;
}

/** Reject the whole 详写/略写 proposal (UI 拒绝 or explicit decline). */
function isRetentionProposalReject(msg: string): boolean {
  const t = String(msg || "").trim();
  if (!t) return false;
  if (isRetentionPendingConfirm(t)) return false;
  return (
    /^(拒绝|不采纳|不同意|不用|不要|算了)[。.!！？?\s]*$/i.test(t) ||
    /不按这个方案|不同意这个方案|不要这个方案|换个方案|先不定/i.test(t)
  );
}

function splitRetentionLabels(label: string): string[] {
  return String(label || "")
    .split(/[、，,｜|/]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function stripRetentionDecisionTags(userPoints: string): string {
  return String(userPoints || "")
    .replace(/（\s*已选详写[^）]*）/g, "")
    .replace(/（\s*已选略写[^）]*）/g, "")
    .replace(/（\s*保留-略写\s*）/g, "")
    .replace(/（\s*用户放弃\s*）/g, "")
    .replace(/（\s*待展开详写\s*）/g, "")
    .replace(/（\s*已展开，作为主论点\s*）/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function userPointsGainedRetentionTags(prev: string, next: string): boolean {
  const prevHas = /已选详写|已选略写|用户放弃/.test(String(prev || ""));
  const nextHas = /已选详写|已选略写|用户放弃/.test(String(next || ""));
  return !prevHas && nextHas;
}

function formatPendingRetentionMarker(pending: PendingRetention): string {
  return `［待裁决：详=${pending.developed}｜略=${pending.uncovered}｜默认=${pending.recommendation || "EXPAND_BOTH"}］`;
}

/** Clear 详写/略写 pick in the message itself (not bounce-back). */
function messageIsClearRetentionChoice(msg: string): boolean {
  const t = String(msg || "").trim();
  if (!t || isRetentionDeferToCoach(t)) return false;
  if (isRetentionPendingConfirm(t)) return true;
  if (/都写|都要|都展开|两个都|全都|都详|都补充|都详细/i.test(t)) return true;
  if (
    /放弃|不要|不用|算了|只写一个/i.test(t) &&
    !/都写|都要|都展开/i.test(t)
  ) {
    return true;
  }
  if (/详写/.test(t) && /略写|不写|放弃/.test(t)) return true;
  if (/[①②③④⑤⑥]|第\s*[1-6一二三四五六]/.test(t) && /详写|略写/.test(t)) {
    return true;
  }
  return false;
}

function extractRetentionTaggedLabels(userPoints: string): {
  detail: string[];
  brief: string[];
} {
  const detail: string[] = [];
  const brief: string[] = [];
  const text = String(userPoints || "").replace(PENDING_RETENTION_MARKER_RE, "");
  for (const chunk of text.split(/[；;]/)) {
    const c = chunk.trim();
    if (!c) continue;
    const label = shortRetentionLabel(c);
    if (label.length < 2) continue;
    if (/已选详写/.test(c)) detail.push(label);
    else if (/已选略写|用户放弃|保留-略写/.test(c)) brief.push(label);
  }
  return { detail, brief };
}

function resolveRetentionUserChoice(params: {
  userMessage: string;
  developed: string;
  uncovered: string;
  defaultRec: RetentionRecommendation | null;
}): RetentionChoiceResult {
  const t = String(params.userMessage || "").trim();
  const developed = params.developed;
  const uncovered = params.uncovered;
  const dShort = shortRetentionLabel(developed);
  const uShort = shortRetentionLabel(uncovered);
  const rec = params.defaultRec || "EXPAND_BOTH";
  const awaiting = (summaryZh: string): RetentionChoiceResult => ({
    applied: false,
    developedTag: "",
    uncoveredTag: "",
    needExpandDetail: null,
    expandMode: null,
    allowTransition: false,
    summaryZh,
    proposalAsk: buildRetentionProposalAsk(developed, uncovered, rec),
  });

  if (isRetentionDeferToCoach(t)) {
    return awaiting("等确认：学生把选择交回老师");
  }

  const wantsBoth = /都写|都要|都展开|两个都|全都|都详|都补充|都详细/i.test(t);
  const wantsDropUncovered =
    /放弃|不要|不用|算了|只写一个/i.test(t) &&
    !/都写|都要|都展开/i.test(t) &&
    // Bare「不用/不要」= reject the proposal (UI path), not "drop uncovered point"
    !/^(不用|不要|算了)[。.!！？?\s]*$/i.test(t);
  const picksDeveloped =
    (dShort.length >= 2 &&
      (t.includes(dShort.slice(0, Math.min(4, dShort.length))) ||
        answerTouchesSibling(t, developed)) &&
      /详写|重点|主写|详细|第一个|第\s*1|就这个|这个详/i.test(t)) ||
    /第一个|第\s*1\s*个|详写第一个/i.test(t);
  const picksUncovered =
    (uShort.length >= 2 &&
      (t.includes(uShort.slice(0, Math.min(4, uShort.length))) ||
        answerTouchesSibling(t, uncovered)) &&
      /详写|重点|主写|详细|展开|补充|第二个|第\s*2/i.test(t)) ||
    /第二个|第\s*2\s*个|详写第二个/i.test(t);

  if (wantsBoth) {
    const uncoveredThin = isThinRetentionLabel(uncovered);
    const developedThin = isThinRetentionLabel(developed);
    const needExpand = developedThin
      ? developed
      : uncoveredThin
        ? uncovered
        : null;
    return {
      applied: true,
      developedTag: "已选详写",
      uncoveredTag: "已选详写",
      needExpandDetail: needExpand,
      expandMode: needExpand ? "detail" : null,
      allowTransition: !needExpand,
      summaryZh: "都详写",
    };
  }

  if (picksUncovered) {
    return {
      applied: true,
      developedTag: "已选略写",
      uncoveredTag: "已选详写",
      needExpandDetail: uncovered,
      expandMode: "detail",
      allowTransition: false,
      summaryZh: `详写『${uShort}』`,
    };
  }

  // 「①详写，②③略写」counts as an explicit scheme (same as picking developed=详写).
  const numberedDetailBriefScheme =
    /详写/.test(t) &&
    /略写|不写|放弃/.test(t) &&
    (/[①②③④⑤⑥]/.test(t) || /第\s*[1-6一二三四五六]/.test(t));

  if (picksDeveloped || numberedDetailBriefScheme) {
    const minorThin = splitRetentionLabels(uncovered).some((p) =>
      isThinRetentionLabel(p),
    );
    return {
      applied: true,
      developedTag: "已选详写",
      uncoveredTag: minorThin ? "已选略写（待补一句）" : "已选略写",
      needExpandDetail: minorThin
        ? splitRetentionLabels(uncovered).find((p) => isThinRetentionLabel(p)) ||
          uncovered
        : null,
      expandMode: minorThin ? "minor_brief" : null,
      allowTransition: !minorThin,
      summaryZh: `详写『${dShort}』、略写『${uShort}』`,
    };
  }

  if (wantsDropUncovered) {
    return {
      applied: true,
      developedTag: "已选详写",
      uncoveredTag: "用户放弃",
      needExpandDetail: null,
      expandMode: null,
      allowTransition: true,
      summaryZh: `只详写『${dShort}』`,
    };
  }

  // Confirm the coach proposal (同意 / 就这样 / 好 / 可以 …) → apply soft default.
  // Only reached while ［待裁决］ is pending; 「你定/你觉得呢」still await.
  if (isRetentionPendingConfirm(t)) {
    if (rec === "EXPAND_BOTH") {
      // Not a 详略 lock — treat as "continue walking the uncovered point"
      return {
        applied: false,
        developedTag: "",
        uncoveredTag: "",
        needExpandDetail: uncovered,
        expandMode: "detail",
        allowTransition: false,
        summaryZh: "继续补未展开点的可写内容（不定详略）",
        proposalAsk: buildRetentionProposalAsk(developed, uncovered, "EXPAND_BOTH"),
      };
    }
    if (rec === "DROP") {
      return {
        applied: true,
        developedTag: "已选详写",
        uncoveredTag: "用户放弃",
        needExpandDetail: null,
        expandMode: null,
        allowTransition: true,
        summaryZh: `确认：只详写『${dShort}』`,
      };
    }
    // KEEP_MINOR (incl. side-level 详+略 / legacy SIDE:* markers)
    if (isNoBriefUncoveredLabel(uncovered)) {
      return {
        applied: true,
        developedTag: "已选详写",
        uncoveredTag: "",
        needExpandDetail: null,
        expandMode: null,
        allowTransition: true,
        summaryZh: `确认：详写『${dShort}』`,
      };
    }
    const briefParts = splitRetentionLabels(uncovered).filter(
      (p) => !isNoBriefUncoveredLabel(p),
    );
    const minorThin = briefParts.some((p) => isThinRetentionLabel(p));
    return {
      applied: true,
      developedTag: "已选详写",
      uncoveredTag: minorThin ? "已选略写（待补一句）" : "已选略写",
      needExpandDetail: minorThin
        ? briefParts.find((p) => isThinRetentionLabel(p)) || uncovered
        : null,
      expandMode: minorThin ? "minor_brief" : null,
      allowTransition: !minorThin,
      summaryZh: `确认：详写『${dShort}』、略写『${uShort}』`,
    };
  }

  // Unclear → do NOT lock; ask to confirm the proposal.
  return awaiting("等确认：回复未构成明确详略选择");
}

/** Annotate developed/uncovered labels inside userPoints; fall back to append. */
function applyRetentionTagsToUserPoints(
  basePoints: string,
  developed: string,
  uncovered: string,
  developedTag: string,
  uncoveredTag: string,
): string {
  let text = String(basePoints || "")
    .replace(PENDING_RETENTION_MARKER_RE, "")
    .trim();

  const tagOne = (source: string, label: string, tag: string): string => {
    if (!tag || isNoBriefUncoveredLabel(label)) return source;
    const core = shortRetentionLabel(label);
    if (core.length < 2) return source;
    const re = new RegExp(
      `(${core.slice(0, Math.min(6, core.length)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^；;\\n］]*)`,
    );
    if (re.test(source)) {
      return source.replace(re, (m) => {
        const cleaned = m
          .replace(/（已选详写[^）]*）|（已选略写[^）]*）|（保留-略写）|（用户放弃）|（待展开详写）|（已展开，作为主论点）/g, "")
          .trim();
        return `${cleaned}（${tag}）`;
      });
    }
    // Do NOT append a new empty shell label — right-board slots are frozen;
    // unmatched tags stay off userPoints rather than creating duplicate points.
    return source;
  };

  text = tagOne(text, developed, developedTag);
  // Merged brief in chat ("②③略写") → tag EACH slot; do not collapse board rows.
  const briefLabels = splitRetentionLabels(uncovered);
  if (briefLabels.length > 1) {
    for (const label of briefLabels) {
      text = tagOne(text, label, uncoveredTag);
    }
  } else {
    text = tagOne(text, uncovered, uncoveredTag);
  }
  return text.replace(/\s{2,}/g, " ").trim();
}

/**
 * Extract the current recorded content for a point by label prefix (same
 * matching strategy as applyRetentionTagsToUserPoints' tagOne), so we can judge
 * sufficiency against what is ACTUALLY on record after this turn's update —
 * not just against the raw choice-picking message text.
 */
function extractPointContent(source: string, label: string): string {
  const core = shortRetentionLabel(label);
  if (core.length < 2) return "";
  const re = new RegExp(
    `${core.slice(0, Math.min(6, core.length)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^；;\\n］]*`,
  );
  const m = String(source || "").match(re);
  return m ? m[0] : "";
}

/** Is the point's on-record content already concrete enough that asking to
 *  "expand it further" would just repeat what the student already gave? */
function pointAlreadyHasConcreteContent(source: string, label: string): boolean {
  const content = extractPointContent(source, label);
  return !isThinRetentionLabel(content);
}

function findDevelopedSiblingLabel(params: {
  priorUserPoints: string;
  uncovered: string;
  oldStage: string;
  studentAnswer: string;
}): string {
  const side: "A" | "B" = params.oldStage === "explore_B" ? "B" : "A";
  const siblings = extractNumberedSiblingPoints(params.priorUserPoints, side);
  const uncovered = params.uncovered;
  if (siblings.length >= 2) {
    const uncoveredSibling =
      siblings.find(
        (s) =>
          s.includes(shortRetentionLabel(uncovered).slice(0, 4)) ||
          uncovered.includes(shortRetentionLabel(s).slice(0, 4)) ||
          answerTouchesSibling(uncovered, s),
      ) || null;
    const developed =
      siblings.find(
        (s) =>
          s !== uncoveredSibling &&
          answerTouchesSibling(params.studentAnswer, s),
      ) ||
      siblings.find((s) => s !== uncoveredSibling) ||
      siblings[0];
    return developed;
  }
  if (siblings.length === 1) return siblings[0];
  return "已展开的这一点";
}

// Legacy wrapper for verify-script / old call sites; prefer resolveRetentionUserChoice.
// Vague ack /「你定」no longer auto-accept — returns "等确认".

function extractLastCoachQuestion(messages: any[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.sender === "ai" && String(m.text || "").trim()) {
      return String(m.text).trim();
    }
  }
  return "";
}

/** Look back across recent coach turns so a later single-dimension scaffold
 *  does not erase sibling dimensions named earlier in the same explore stage. */
function extractCoachQuestionsWindow(
  messages: any[],
  maxCoachTurns: number = 4,
): string {
  if (!Array.isArray(messages) || maxCoachTurns <= 0) return "";
  const coachTexts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && coachTexts.length < maxCoachTurns; i--) {
    const m = messages[i];
    if (m && m.sender === "ai" && String(m.text || "").trim()) {
      coachTexts.push(String(m.text).trim());
    }
  }
  return coachTexts.reverse().join("\n\n---\n\n");
}

async function checkStep2DimensionCoverage(params: {
  question: string;
  lastCoachQuestion: string;
  coachQuestionsWindow?: string;
  studentAnswer: string;
  priorUserPoints?: string;
}): Promise<{
  hasMultipleDimensions: boolean;
  uncoveredDimension: string;
  developedIsSolid: boolean;
  uncoveredRelevantToQuestion: boolean;
} | null> {
  const essayQuestion = String(params.question || "").trim();
  const lastCoachQuestion = String(params.lastCoachQuestion || "").trim();
  const coachQuestionsWindow = String(
    params.coachQuestionsWindow || params.lastCoachQuestion || "",
  ).trim();
  const studentAnswer = String(params.studentAnswer || "").trim();
  const priorUserPoints = String(params.priorUserPoints || "").trim();
  if (!coachQuestionsWindow || !studentAnswer) return null;

  try {
    const prompt = `
You are checking ONE narrow fact about a single turn of an IELTS coaching dialogue. Do not do anything else, do not evaluate writing quality, do not generate coaching feedback.

The IELTS essay question being discussed:
"${essayQuestion}"

Recent coach questions in THIS explore stage (oldest → newest; the last one may be a narrowed scaffold of an earlier multi-dimension question):
"${coachQuestionsWindow}"

Most recent coach question alone (for reference):
"${lastCoachQuestion}"

Already recorded brainstorm points for this side (may be empty):
"${priorUserPoints || "(none)"}"

The student's CURRENT answer was:
"${studentAnswer}"

Task:
1. Set hasMultipleDimensions=true if EITHER of these is true:
   a) Across the RECENT COACH QUESTIONS WINDOW (not only the last message), the coach named TWO OR MORE distinct sub-dimensions/sub-angles/scenarios for the same side (e.g. joined by 与/和/、, listed as 『A』『B』, "A以及B", or asked as two numbered expansion prompts); OR
   b) Already-recorded brainstorm points (priorUserPoints) already list TWO OR MORE distinct points on the SAME side (e.g. "1. ...；2. ...", "A面：X；Y", or two semicolon-separated claims that are not synonyms). Student-named siblings in priorUserPoints count even when the latest coach question only scaffolds one of them.
2. IMPORTANT: If an earlier coach turn OR priorUserPoints named two dimensions, and a LATER turn only scaffolds ONE of them, still treat this as a multi-dimension case — the sibling dimension remains "named" for coverage purposes.
3. CRITICAL definition of "covered" vs "uncovered":
   - A named dimension is COVERED only if (i) the student's CURRENT answer develops it with concrete content, OR (ii) a prior student answer in this explore stage already expanded/confirmed it AFTER the coach specifically asked about that dimension.
   - Merely appearing as an item in priorUserPoints (e.g. "1. 塑料难降解…；2. 垃圾处理成本高…" from an initial dump) does NOT count as covered for a sibling that was never the focus of a later coach question and never expanded in a later student answer — even if that label already contains some mechanism words (焚烧/填埋 etc.).
   - Example: priorUserPoints lists two A-side points; coach then only asks for a concrete scene about point 1; student answers about fish poisoning → point 2 is STILL uncovered.
4. Combine the student's current answer WITH already-recorded brainstorm points under the definition above.
   - If hasMultipleDimensions=true and exactly ONE named sub-dimension is still uncovered, copy that uncovered dimension EXACTLY as a short Chinese phrase into "uncoveredDimension".
   - If all named dimensions are covered, or hasMultipleDimensions=false, set uncoveredDimension="".
5. ALWAYS judge whether the student's CURRENT answer for the DEVELOPED dimension is already "solid" (includes a concrete scenario/beneficiary/mechanism, could support a full IELTS body paragraph alone) vs "thin" (still vague/generic, one-liner, or only restates an abstract label like "身份认同变弱"). Set developedIsSolid accordingly — even when hasMultipleDimensions=false.
6. If uncoveredDimension is non-empty, judge whether it directly responds to a core qualifier/contrast in the essay question — set uncoveredRelevantToQuestion=true. Otherwise set uncoveredRelevantToQuestion=false.

Respond with JSON only, matching the schema.
`;
    const response = await generateContentWithFallback({
      contents: prompt,
      config: {
        maxOutputTokens: 512,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            hasMultipleDimensions: { type: Type.BOOLEAN },
            uncoveredDimension: { type: Type.STRING },
            developedIsSolid: { type: Type.BOOLEAN },
            uncoveredRelevantToQuestion: { type: Type.BOOLEAN },
          },
          required: [
            "hasMultipleDimensions",
            "uncoveredDimension",
            "developedIsSolid",
            "uncoveredRelevantToQuestion",
          ],
        },
      },
    });
    const parsed = parseAIResponse(response?.text, null);
    if (!parsed) {
      console.warn(
        "[Step2RetentionGuard][CALL_FAILED] verification response unparseable (fail-open)",
      );
      return null;
    }
    return {
      hasMultipleDimensions: !!parsed.hasMultipleDimensions,
      uncoveredDimension: String(parsed.uncoveredDimension || "").trim(),
      developedIsSolid: !!parsed.developedIsSolid,
      uncoveredRelevantToQuestion: !!parsed.uncoveredRelevantToQuestion,
    };
  } catch (e: any) {
    console.warn(
      "[Step2RetentionGuard][CALL_FAILED] verification call failed (fail-open, no correction applied):",
      e.message || e,
    );
    return null;
  }
}

/** Detect verbal side-advance in coach chat text even when currentStage was not flipped.
 *  Catches text/field desync where the model talks about B-side / stance while leaving
 *  progressUpdate.step2Data.currentStage unchanged. */
function textSuggestsExploreSideAdvance(
  coachText: string,
  oldStage: string,
): boolean {
  const t = String(coachText || "");
  if (!t.trim()) return false;
  if (oldStage === "explore_A") {
    return /接下来\s*(我们)?(来)?看.{0,24}(B面|第二[个项]?任务|措施|解决|另一面|对立面|让步)|我们来看你为\s*B面|进入\s*(B面|第二[个项]?任务|措施)|转向\s*(B面|措施|解决)/i.test(
      t,
    );
  }
  if (oldStage === "explore_B") {
    return /接下来\s*(我们)?(来)?(确定|讨论|看).{0,16}(立场|stance)|进入\s*(立场|stance|总结)|我们来确定.{0,8}立场/i.test(
      t,
    );
  }
  return false;
}

/**
 * Deterministic sibling extractor for the active explore side.
 * Prefer numbered "1. …；2. …" items inside A面/B面 sections.
 */
function extractNumberedSiblingPoints(
  userPoints: string,
  side: "A" | "B",
): string[] {
  const text = String(userPoints || "");
  if (!text.trim()) return [];
  const sideRe =
    side === "A"
      ? /A面[^：:]*[：:]([\s\S]*?)(?=B面[^：:]*[：:]|$)/
      : /B面[^：:]*[：:]([\s\S]*)$/;
  const sectionMatch = text.match(sideRe);
  const scope = (sectionMatch?.[1] || (side === "A" ? text : "")).trim();
  if (!scope) return [];

  const numbered = [
    ...scope.matchAll(/(?:^|[；;\n])\s*\d+[.、．]\s*([^；;\n]+)/g),
  ]
    .map((m) => m[1].trim())
    .filter((s) => s.length >= 4);
  if (numbered.length >= 2) return numbered;

  const parts = scope
    .split(/[；;]/)
    .map((s) => s.replace(/^[A-Za-z]?面[^：:]*[：:]?\s*/, "").trim())
    .filter((s) => s.length >= 4 && !/待裁决|待补例子/.test(s));
  return parts.length >= 2 ? parts : [];
}

/** Fingerprint overlap: does `haystack` develop the sibling label? */
function answerTouchesSibling(haystack: string, sibling: string): boolean {
  const h = String(haystack || "");
  const core = String(sibling || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .trim();
  if (core.length < 4 || !h.trim()) return false;

  const compact = core.replace(/[，,、；;。．\s\/]+/g, "");
  // Prefix / near-literal restatement.
  const needle = compact.slice(0, Math.min(8, compact.length));
  if (needle.length >= 4 && (h.includes(needle.slice(0, 4)) || h.includes(needle))) {
    return true;
  }

  // Chinese bigram/trigram overlap (handles paraphrase expansions).
  const grams = new Set<string>();
  for (let i = 0; i < compact.length - 1; i++) {
    grams.add(compact.slice(i, i + 2));
    if (i < compact.length - 2) grams.add(compact.slice(i, i + 3));
  }
  let hits = 0;
  for (const g of grams) {
    if (h.includes(g)) hits += 1;
  }
  return hits >= 2;
}

/**
 * When LLM coverage says "all covered" but userPoints still has numbered siblings
 * and the current answer only develops one of them, return the undeveloped sibling.
 */
function findUndevelopedNumberedSibling(params: {
  priorUserPoints: string;
  studentAnswer: string;
  oldStage: string;
  /** The coach's own last question — a much more reliable signal than lexical
   * overlap with the stored (possibly differently-worded) sibling label for
   * deciding which sibling THIS answer is actually responding to. */
  lastCoachQuestion?: string;
}): string | null {
  const side: "A" | "B" =
    params.oldStage === "explore_B" ? "B" : "A";
  const siblings = extractNumberedSiblingPoints(params.priorUserPoints, side);
  if (siblings.length < 2) return null;

  const answer = String(params.studentAnswer || "");
  const touched = siblings.filter((s) => answerTouchesSibling(answer, s));
  // Current answer develops exactly one sibling → the other is still uncovered.
  if (touched.length === 1) {
    const uncovered = siblings.find((s) => s !== touched[0]);
    return uncovered ? uncovered.replace(/（待补例子）/g, "").trim() : null;
  }
  // Current answer's wording doesn't lexically overlap with EITHER stored label
  // (common when the student paraphrases, e.g. "设置便民回收设施" vs a stored
  // "个人养成回收习惯" label). Before falling back to a blind positional guess,
  // check which sibling the coach's OWN last question was actually about — if
  // it clearly targeted one sibling, this answer is a direct reply to it, so
  // that sibling is now covered. Only the OTHER sibling can still be flagged,
  // and only if it is independently thin (no concrete content of its own yet).
  if (touched.length === 0 && answer.trim().length >= 12 && siblings.length >= 2) {
    const lastQ = String(params.lastCoachQuestion || "");
    const questionTargets = siblings.filter((s) => answerTouchesSibling(lastQ, s));
    if (questionTargets.length === 1) {
      const targeted = questionTargets[0];
      const other = siblings.find((s) => s !== targeted);
      if (other && isThinRetentionLabel(other)) {
        return other.replace(/（待补例子）/g, "").trim();
      }
      // Coach's question targeted `targeted`; this answer covers it, and the
      // other sibling already has its own solid content — nothing uncovered.
      return null;
    }
    // No reliable question-target signal — fall back to the old positional
    // guess only as a last resort (lower confidence than the checks above).
    return siblings[1].replace(/（待补例子）/g, "").trim();
  }
  return null;
}

// Applies the retention guard in-place on `data`. Fails open on any error so a
// verification-call failure never blocks the primary coaching response.
async function applyStep2RetentionGuard(
  data: any,
  session: any,
  userMessage: string,
  messages: any[],
  question: string,
  options?: { decision?: { type?: string; action?: string } | null },
): Promise<void> {
  if (!data?.progressUpdate?.step2Data) {
    console.log(
      "[Step2RetentionGuard][SKIP] no step2Data in progressUpdate",
    );
    return;
  }

  const oldStage = session?.step2?.coachEvaluation?.currentStage || "explore_A";
  const newStage = data.progressUpdate.step2Data.currentStage;
  const oldUserPoints = session?.step2?.coachEvaluation?.userPoints || "";
  const coachText = String(data.text || "");
  const decision = options?.decision || null;

  console.log(
    `[Step2RetentionGuard] enter oldStage=${oldStage} newStage=${newStage || "(unset)"} userPointsLen=${String(oldUserPoints).length}`,
  );

  let pending = extractPendingRetention(oldUserPoints);
  // Verbal「可以/采纳」after coach 详略 ask that forgot ［待裁决］→ synthesize from last coach.
  if (!pending) {
    const decisionType0 = String(decision?.type || "").trim();
    const decisionAction0 = String(decision?.action || "")
      .trim()
      .toLowerCase();
    const acceptLike =
      (decisionType0 === "retention" && decisionAction0 === "accept") ||
      ((!decisionType0 || decisionType0 === "retention") &&
        isRetentionPendingConfirm(userMessage));
    if (acceptLike) {
      const lastAi = [...(messages || [])]
        .reverse()
        .find(
          (m: any) =>
            m?.role === "assistant" ||
            m?.role === "model" ||
            m?.sender === "ai",
        );
      const lastAiText = String(
        lastAi?.parts?.[0]?.text || lastAi?.content || lastAi?.text || "",
      );
      if (coachMessageLooksLikeRetentionDecision(lastAiText)) {
        const scheme = parseSideRetentionSchemeFromCoachText(lastAiText);
        if (scheme) {
          pending = {
            developed: scheme.developed,
            uncovered: scheme.uncovered,
            recommendation: "KEEP_MINOR",
          };
          console.log(
            `[Step2RetentionGuard][SYNTH_PENDING] from last coach 详=${scheme.developed} 略=${scheme.uncovered}`,
          );
        }
      }
    }
  }
  if (pending) {
    const decisionType = String(decision?.type || "").trim();
    const decisionAction = String(decision?.action || "")
      .trim()
      .toLowerCase();
    const isRetentionDecision = decisionType === "retention";
    const foreignDecision =
      decisionType === "stance" ||
      decisionType === "slot_add" ||
      decisionType === "capacity_trim";
    const rejectProposal =
      (isRetentionDecision && decisionAction === "reject") ||
      (!foreignDecision &&
        (!decisionType || decisionType === "retention") &&
        isRetentionProposalReject(userMessage));
    const acceptProposal =
      (isRetentionDecision && decisionAction === "accept") ||
      (!foreignDecision &&
        (!decisionType || decisionType === "retention") &&
        isRetentionPendingConfirm(userMessage));

    // 拒绝：清掉待裁决，不打 已选详写/略写，进入下一步追问（禁止死循环）
    if (rejectProposal && !acceptProposal) {
      const cleaned = stripRetentionDecisionTags(
        String(
          data.progressUpdate.step2Data.userPoints || oldUserPoints || "",
        ).replace(PENDING_RETENTION_MARKER_RE, ""),
      ).trim();
      data.progressUpdate.step2Data.userPoints = cleaned;
      data.progressUpdate.step2Data.currentStage = oldStage;
      const part1 = safeOverridePart1(String(data.text || ""));
      const ask = buildStep2ContentAwareFallback(
        session,
        data.progressUpdate.step2Data,
      );
      data.text = `${part1}\n\n---\n\n好的，详略先不定。${ask}`;
      console.log(
        "[Step2RetentionGuard][PENDING_REJECTED] cleared 待裁决; no tags locked",
      );
      return;
    }

    // Student is answering the 详写/略写 choice asked last turn.
    const choice = resolveRetentionUserChoice({
      userMessage: acceptProposal && decisionAction === "accept" ? "同意" : userMessage,
      developed: pending.developed,
      uncovered: pending.uncovered,
      defaultRec: pending.recommendation,
    });
    const basePoints = String(
      data.progressUpdate.step2Data.userPoints || oldUserPoints || "",
    );

    // Recommend → confirm: bounce-back「你定/你觉得呢」do NOT lock tags yet.
    // Any other non-choice reply while pending = reject (same as UI「拒绝」) — no loop.
    if (!choice.applied) {
      // EXPAND_BOTH + soft ack /「同意」= continue content walk, not lock 详略.
      // Clear ［待裁决］ so UI does not show 采纳/拒绝 on a content ask.
      if (
        choice.needExpandDetail &&
        choice.expandMode === "detail" &&
        (acceptProposal || isRetentionPendingConfirm(userMessage))
      ) {
        const cleanedWalk = stripRetentionDecisionTags(
          String(basePoints).replace(PENDING_RETENTION_MARKER_RE, ""),
        ).trim();
        data.progressUpdate.step2Data.userPoints = cleanedWalk;
        data.progressUpdate.step2Data.currentStage = oldStage;
        data.progressUpdate.step2Data.pendingFocusClaim =
          shortRetentionLabel(choice.needExpandDetail) || pending.uncovered;
        const part1w = safeOverridePart1(String(data.text || ""));
        const askW =
          choice.proposalAsk ||
          buildRetentionProposalAsk(
            pending.developed,
            pending.uncovered,
            "EXPAND_BOTH",
          );
        data.text = `${part1w}\n\n---\n\n${askW}`;
        console.log(
          `[Step2RetentionGuard][PENDING_EXPAND_WALK] ${choice.summaryZh}; focus=${data.progressUpdate.step2Data.pendingFocusClaim}`,
        );
        return;
      }
      if (
        !isRetentionDeferToCoach(userMessage) &&
        String(userMessage || "").trim() &&
        !acceptProposal
      ) {
        const cleanedReject = stripRetentionDecisionTags(
          String(basePoints).replace(PENDING_RETENTION_MARKER_RE, ""),
        ).trim();
        data.progressUpdate.step2Data.userPoints = cleanedReject;
        data.progressUpdate.step2Data.currentStage = oldStage;
        const part1r = safeOverridePart1(String(data.text || ""));
        const askR = buildStep2ContentAwareFallback(
          session,
          data.progressUpdate.step2Data,
        );
        data.text = `${part1r}\n\n---\n\n好的，详略先不定。${askR}`;
        console.log(
          "[Step2RetentionGuard][PENDING_REJECTED] unclear reply; cleared 待裁决",
        );
        return;
      }
      // KEEP_MINOR / DROP still awaiting clear confirm — keep marker.
      // EXPAND_BOTH defer-to-coach: ask content walk WITHOUT re-parking 待裁决.
      const cleaned = stripRetentionDecisionTags(
        String(basePoints).replace(PENDING_RETENTION_MARKER_RE, ""),
      ).trim();
      const ask =
        choice.proposalAsk ||
        buildRetentionProposalAsk(
          pending.developed,
          pending.uncovered,
          pending.recommendation,
        );
      const keepMarker =
        pending.recommendation === "KEEP_MINOR" ||
        pending.recommendation === "DROP";
      data.progressUpdate.step2Data.userPoints = keepMarker
        ? `${cleaned} ${formatPendingRetentionMarker(pending)}`.trim()
        : cleaned;
      if (!keepMarker) {
        data.progressUpdate.step2Data.pendingFocusClaim =
          shortRetentionLabel(pending.uncovered) || pending.uncovered;
      }
      data.progressUpdate.step2Data.currentStage = oldStage;
      const part1 = safeOverridePart1(String(data.text || ""));
      data.text = `${part1}\n\n---\n\n${ask}`;
      console.log(
        `[Step2RetentionGuard][PENDING_AWAIT_CONFIRM] ${choice.summaryZh} keepMarker=${keepMarker}`,
      );
      return;
    }

    data.progressUpdate.step2Data.userPoints = applyRetentionTagsToUserPoints(
      basePoints,
      pending.developed,
      pending.uncovered,
      choice.developedTag,
      choice.uncoveredTag,
    );

    // Stamp planner retentionRole + drop same-side leftovers not in the scheme
    // (e.g. empty「网络」) so side walk advances and we do not re-ask 详略/裁剪.
    {
      const payload = data.progressUpdate.step2Data.plannerPayload;
      const pts = Array.isArray(payload?.points) ? payload.points : null;
      if (pts) {
        const settled = settleSideRetentionAfterAccept({
          points: pts,
          developed: pending.developed,
          uncovered: pending.uncovered,
        });
        let up = String(data.progressUpdate.step2Data.userPoints || "");
        for (const claim of settled.droppedClaims) {
          up = stampRetentionTagOnUserPoints(up, claim, "dropped");
        }
        data.progressUpdate.step2Data.userPoints = up;
        const dismissed = Array.isArray(payload?.capacityTrimDismissedSides)
          ? [...payload.capacityTrimDismissedSides]
          : [];
        if (settled.sideKey && !dismissed.includes(settled.sideKey)) {
          dismissed.push(settled.sideKey);
        }
        data.progressUpdate.step2Data.plannerPayload = {
          ...payload,
          points: applyRetentionRolesFromUserPoints(settled.points, up),
          pendingCapacityTrim: null,
          capacityTrimDismissedSides: dismissed,
          pendingStanceConfirm: null,
        };
        console.log(
          `[Step2RetentionGuard][SIDE_SETTLE] side=${settled.sideKey || "?"} dropped=${settled.droppedClaims.length} roles stamped; trim dismissed`,
        );
      }
    }

    if (choice.needExpandDetail && choice.expandMode) {
      // Before asking to "expand further", check whether this turn's own answer
      // (as reflected in the freshly-updated userPoints) already gave concrete
      // content for that point. If so, asking again would just repeat/contradict
      // the acknowledgment the model already gave in Part 1 — skip the ask.
      const alreadySolid = pointAlreadyHasConcreteContent(
        data.progressUpdate.step2Data.userPoints,
        choice.needExpandDetail,
      );
      if (alreadySolid) {
        console.log(
          `[Step2RetentionGuard][PENDING_RESOLVED] ${choice.summaryZh}; content already concrete — skipping redundant expand ask`,
        );
        return;
      }

      // Role chosen (or minor empty) → stay on this side and ask for content.
      data.progressUpdate.step2Data.currentStage = oldStage;
      const label = shortRetentionLabel(choice.needExpandDetail);
      const expandAsk =
        choice.expandMode === "minor_brief"
          ? `好的，『${label}』我们留作略写——用一两句话说说它大概是什么情况就行（不用展开成完整场景）。`
          : `好的，那我们详写『${label}』。请再补充 1-2 句具体场景 / 机制 / 受影响对象，把它写扎实。`;
      const part1 = safeOverridePart1(String(data.text || ""));
      data.text = `${part1}\n\n---\n\n${expandAsk}`;
      console.log(
        `[Step2RetentionGuard][PENDING_RESOLVED] ${choice.summaryZh}; needExpand=${label} mode=${choice.expandMode}`,
      );
      return;
    }

    // Choice settled and detail already solid → allow transition this turn.
    console.log(
      `[Step2RetentionGuard][PENDING_RESOLVED] ${choice.summaryZh}; allowTransition=${choice.allowTransition}`,
    );
    return;
  }

  // No pending marker, but model locked tags / student bounced choice back →
  // strip premature locks and ask for explicit confirm (do not advance).
  {
    const nextPoints = String(
      data.progressUpdate.step2Data.userPoints || oldUserPoints || "",
    );
    const prematureTags = userPointsGainedRetentionTags(oldUserPoints, nextPoints);
    const deferred = isRetentionDeferToCoach(userMessage);
    const clearPick = messageIsClearRetentionChoice(userMessage);
    if ((prematureTags && !clearPick) || (deferred && prematureTags)) {
      const tagged = extractRetentionTaggedLabels(nextPoints);
      const developed =
        tagged.detail[0] ||
        shortRetentionLabel(oldUserPoints) ||
        "已展开的这一点";
      const uncovered =
        tagged.brief.join("、") ||
        tagged.detail.slice(1).join("、") ||
        "其余点";
      const cleaned = stripRetentionDecisionTags(
        nextPoints.replace(PENDING_RETENTION_MARKER_RE, ""),
      ).trim();
      // Content walk — do NOT park ［待裁决］ (avoids 采纳/拒绝 on「请补内容」).
      data.progressUpdate.step2Data.userPoints = cleaned;
      data.progressUpdate.step2Data.pendingFocusClaim =
        shortRetentionLabel(uncovered) || uncovered;
      data.progressUpdate.step2Data.currentStage = oldStage;
      const part1 = safeOverridePart1(String(data.text || ""));
      data.text = `${part1}\n\n---\n\n${buildRetentionProposalAsk(
        developed,
        uncovered,
        "EXPAND_BOTH",
      )}`;
      console.warn(
        `[Step2RetentionGuard][PREMATURE_TAGS_STRIPPED] deferred=${deferred} prematureTags=${prematureTags}; expand-walk (no 待裁决)`,
      );
      return;
    }
  }

  const stageTransition =
    (oldStage === "explore_A" && newStage && newStage !== "explore_A") ||
    (oldStage === "explore_B" && newStage && newStage !== "explore_B");
  const verbalAdvance = !stageTransition && textSuggestsExploreSideAdvance(coachText, oldStage);
  const isExploreTransition = stageTransition || verbalAdvance;
  if (!isExploreTransition) {
    console.log(
      `[Step2RetentionGuard][NO_TRANSITION] oldStage=${oldStage} newStage=${newStage || "(unset)"} verbalAdvance=false — guard not applicable`,
    );
    return;
  }
  if (verbalAdvance) {
    console.warn(
      `[Step2RetentionGuard][VERBAL_ADVANCE] text suggests side advance while currentStage stayed ${oldStage} (newStage=${newStage || "(unset)"})`,
    );
  }

  const lastCoachQuestion = extractLastCoachQuestion(messages);
  const coachQuestionsWindow = extractCoachQuestionsWindow(messages, 4);
  if (!coachQuestionsWindow) {
    console.warn(
      "[Step2RetentionGuard][SKIP] coachQuestionsWindow empty — cannot verify coverage",
    );
    return;
  }

  const check = await checkStep2DimensionCoverage({
    question,
    lastCoachQuestion,
    coachQuestionsWindow,
    studentAnswer: userMessage,
    priorUserPoints: oldUserPoints,
  });

  // Deterministic fallback: LLM often treats "listed in userPoints" as covered.
  const heuristicUncovered = findUndevelopedNumberedSibling({
    priorUserPoints: oldUserPoints,
    studentAnswer: userMessage,
    oldStage,
    lastCoachQuestion,
  });

  let effectiveCheck = check;
  if (
    heuristicUncovered &&
    (!check || !check.hasMultipleDimensions || !check.uncoveredDimension)
  ) {
    console.warn(
      `[Step2RetentionGuard][HEURISTIC_UNCOVERED] LLM missed sibling; using "${heuristicUncovered}"`,
    );
    effectiveCheck = {
      hasMultipleDimensions: true,
      uncoveredDimension: heuristicUncovered,
      developedIsSolid: check ? check.developedIsSolid : true,
      uncoveredRelevantToQuestion: check
        ? check.uncoveredRelevantToQuestion
        : true,
    };
  }

  if (!effectiveCheck) {
    console.warn(
      "[Step2RetentionGuard][NO_TRIGGER] coverage check returned null (call failed or unparseable)",
    );
    return;
  }
  if (!effectiveCheck.hasMultipleDimensions || !effectiveCheck.uncoveredDimension) {
    // Tag thin developed points so summary does not claim "完整性极高".
    if (effectiveCheck.developedIsSolid === false) {
      const basePoints = String(
        data.progressUpdate.step2Data.userPoints || oldUserPoints || "",
      ).trim();
      if (basePoints && !basePoints.includes("待补例子")) {
        data.progressUpdate.step2Data.userPoints = `${basePoints}（待补例子）`;
      }
    }
    console.log(
      `[Step2RetentionGuard][NO_TRIGGER] hasMultipleDimensions=${effectiveCheck.hasMultipleDimensions} uncoveredDimension="${effectiveCheck.uncoveredDimension || ""}" developedIsSolid=${effectiveCheck.developedIsSolid}`,
    );
    return;
  }

  const { recommendation, reasonZh } = decideStep2Retention(
    effectiveCheck.developedIsSolid,
    effectiveCheck.uncoveredRelevantToQuestion,
  );

  const uncovered = effectiveCheck.uncoveredDimension;
  const developed = findDevelopedSiblingLabel({
    priorUserPoints: oldUserPoints,
    uncovered,
    oldStage,
    studentAnswer: userMessage,
  });
  const dShort = shortRetentionLabel(developed);
  const uShort = shortRetentionLabel(uncovered);

  // Revert the transition; ask the student to choose 详写/略写 (or expand both
  // when the developed point is still thin).
  data.progressUpdate.step2Data.currentStage = oldStage;
  const part1 = safeOverridePart1(String(data.text || ""));

  // Generic numbered list for the ask (prefer frozen Step1 slots when present)
  const payloadForList =
    data.progressUpdate.step2Data.plannerPayload ||
    session?.step2?.coachEvaluation?.plannerPayload;
  const listLabels: string[] = [];
  const pushUnique = (label: string) => {
    const t = shortRetentionLabel(label);
    if (t.length < 2) return;
    if (listLabels.some((x) => x === t || x.includes(t) || t.includes(x))) return;
    listLabels.push(t);
  };
  if (Array.isArray(payloadForList?.fixedClaims)) {
    for (const c of payloadForList.fixedClaims) pushUnique(String(c || ""));
  }
  if (!listLabels.length && Array.isArray(payloadForList?.points)) {
    for (const p of payloadForList.points) {
      if (p?.supersededBy) continue;
      pushUnique(String(p?.claim || ""));
    }
  }
  if (!listLabels.length) {
    pushUnique(dShort);
    pushUnique(uShort);
  }
  const circ = ["①", "②", "③", "④", "⑤", "⑥"];
  const listBlock = listLabels
    .map((l, i) => `${circ[i] || `${i + 1}.`} ${l}`)
    .join("\n");

  let retentionQuestion: string;
  if (recommendation === "EXPAND_BOTH") {
    retentionQuestion =
      `目前材料池有：\n${listBlock}\n` +
      `『${uShort}』还没展开到可写程度（${reasonZh}）。` +
      `请先补 1–2 句具体场景、机制或受影响对象；补完后再按各条可写量定详写/略写` +
      `（可以都详写，也可以一详一略——不默认一详一略）。`;
  } else if (recommendation === "DROP") {
    retentionQuestion =
      `目前材料池有：\n${listBlock}\n` +
      `我建议详写『${dShort}』，『${uShort}』先放下（${reasonZh}）。\n` +
      `请点击下方「采纳」或「拒绝」；也可直接说「保留略写」或「都展开」。`;
  } else {
    // Legacy KEEP_MINOR path (explicit scheme only)
    retentionQuestion =
      `目前材料池有：\n${listBlock}\n` +
      `我建议：详写『${dShort}』，略写『${uShort}』（${reasonZh}）。\n` +
      `是否按这个方案定下来？请回复「同意」「好」或直接说明你的详略选择。`;
  }
  data.text = `${part1}\n\n---\n\n${retentionQuestion}`;

  const basePoints = stripRetentionDecisionTags(
    String(
      data.progressUpdate.step2Data.userPoints || oldUserPoints || "",
    ).replace(PENDING_RETENTION_MARKER_RE, ""),
  ).trim();
  const thinTag = effectiveCheck.developedIsSolid ? "" : "（待补例子）";
  // EXPAND_BOTH = content walk: do NOT park ［待裁决］详略 marker (avoids 采纳/拒绝 UI).
  // DROP / KEEP_MINOR = proposal needing confirm → keep pending marker.
  if (recommendation === "EXPAND_BOTH") {
    data.progressUpdate.step2Data.userPoints = `${basePoints}${thinTag}`.trim();
    data.progressUpdate.step2Data.pendingFocusClaim = uShort || uncovered;
  } else {
    data.progressUpdate.step2Data.userPoints =
      `${basePoints}${thinTag} ${formatPendingRetentionMarker({
        developed,
        uncovered,
        recommendation,
      })}`.trim();
  }

  console.warn(
    `[Step2RetentionGuard][REVERTED] ${oldStage}->${newStage || "(verbal)"}; developed="${dShort}"; uncovered="${uShort}"; default=${recommendation}; via=${stageTransition ? "stage" : "verbal"}`,
  );
}

// Cross-step safety net: strip internal JSON field/enum names from user-facing chat
// text. The UI panels already render localized versions of progressUpdate; chat
// text should never echo raw implementation vocabulary (see NO INTERNAL JARGON rule).
const INTERNAL_JARGON_REPLACEMENTS: [RegExp, string][] = [
  // Step 3 paragraph-plan enums & fields
  [/['"“‘]?total_then_points['"”’]?\s*(模式|mode)?/gi, "先总起再分点的写法"],
  [/['"“‘]?direct_points['"”’]?\s*(模式|mode)?/gi, "直接分点展开的写法"],
  [/['"“‘]?single_point['"”’]?\s*(模式|mode)?/gi, "单点展开的写法"],
  [/\bparagraphPlan\b/gi, ""],
  [/\bpointBlock[s]?\b/gi, "分点"],
  [/\bstep3SubpointSteps\b/gi, ""],
  [/\bexpansionStrategy\b/gi, ""],
  [/\b(?:Multi-?point|multi-?point)\b/gi, "多点"],
  // Step 2 stage & retention enums
  [/\bexplore_[AB]\b/gi, ""],
  [/\bcurrentStage\b/gi, ""],
  [/\bKEEP_MINOR\b/g, "保留为略写"],
  [/\bEXPAND_BOTH\b/g, ""],
  [/\bDROP\b/g, ""],
  [/\bclustering\b/gi, ""],
  [/\boutliers\b/gi, ""],
  [/\bdimensionDispositions\b/gi, ""],
  [/\btaskLabel[AB]\b/gi, ""],
  [/\brequiresStance\b/gi, ""],
  // Step 1 slot & data fields
  [/\bcorrectType\b/gi, "题型"],
  [/\bcoreIssue\b/gi, "核心争议"],
  [/\bconstraints\b/gi, "关键限定"],
  [/\bsuggestedDimensions\b/gi, "讨论维度"],
  [/\bstep1Data\b/gi, ""],
  [/\bstep2Data\b/gi, ""],
  // Global implementation vocabulary
  [/\bprogressUpdate\b/gi, ""],
  [/\bisCompleted\b/gi, ""],
  [/\buserPoints\b/gi, ""],
  [/\bblueprint\b/gi, "文章蓝图"],
  // Memory digests (internal only)
  [/\bsourceHash\b/gi, ""],
  [/\bopenGaps\b/gi, ""],
  [/\bstep1Digest\b/gi, ""],
  [/\bstep2Digest\b/gi, ""],
  [/\bstep3Digest\b/gi, ""],
  // English role names -> Chinese (when leaked as raw words)
  [/\bmajor\b/gi, "详写"],
  [/\bminor\b/gi, "略写"],
];

function stripInternalJargonFromChatText(text: string): string {
  let cleaned = String(text || "");
  for (const [pattern, replacement] of INTERNAL_JARGON_REPLACEMENTS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  // Collapse whitespace left by stripped tokens; preserve paragraph breaks.
  cleaned = cleaned
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/gm, (m) => (m.includes("\n") ? m : m.trim()))
    .trim();
  return cleaned;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Log requests in dev
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  // 1. API - Health check
  app.get("/api/health", (req, res) => {
    const provider = getLLMProvider();
    const key =
      provider === "openai-compatible" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
    const val = process.env[key];
    res.json({
      status: "ok",
      provider,
      hasKey: !!val && val !== `MY_${key}`,
    });
  });

  // 1b. API - Step 2.5 Planner
  app.post("/api/planner/generate", async (req, res) => {
    try {
      const { session } = req.body;
      const question =
        String(session?.topic?.question || "").trim() ||
        String(req.body?.question || "").trim();
      const questionType =
        String(
          session?.step1?.coachEvaluation?.correctType ||
            session?.topic?.questionType ||
            "",
        ).trim() || "Agree / Disagree";

      // --- 首选：真实 Planner LLM（材料驱动的结构推理） ---
      // 解析/QA 失败时重试一次（LLM 输出有随机性，二次尝试常能成功）。
      let bodyPlans: any[] | null = null;
      let errorMessage = "";
      let degraded = false;
      let qaIssues: string[] = [];
      let request: any = null;
      let input: any = null;

      // collectPlannerInput / buildPlannerRequest 若抛错（session 结构异常等），
      // 直接走兜底，不返回 500（500 会让前端显示“重试”而不是降级出计划）。
      try {
        input = collectPlannerInput(session, question, questionType);
        request = buildPlannerRequest(input);
      } catch (ce: any) {
        errorMessage = String(ce?.message || "Planner 输入构造失败");
        console.warn(`[Planner] 输入构造失败：${errorMessage}`);
      }

      const MAX_PLANNER_ATTEMPTS = 2;

      for (
        let attempt = 1;
        attempt <= MAX_PLANNER_ATTEMPTS && !bodyPlans && request;
        attempt++
      ) {
        try {
          const response = await generateContentWithFallback(request);
          const rawText =
            response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
          const parsed = parsePlannerResponse(rawText);
          if (parsed && Array.isArray(parsed.bodyPlans)) {
            const qa = runMechanicalQa(
              parsed.bodyPlans,
              input?.plannerPayload || null,
            );
            if (qa.pass) {
              bodyPlans = parsed.bodyPlans;
              const warns = qa.issues
                .filter((i) => i.severity === "warn")
                .map((i) => i.reason);
              if (warns.length) {
                console.warn(`[Planner] soft QA warns: ${warns.join("；")}`);
              }
            } else {
              qaIssues = qa.issues
                .filter((i) => i.severity === "fail")
                .map((i) => i.reason);
              errorMessage = `Planner QA 未通过：${qaIssues.join("；")}`;
            }
          } else {
            // 诊断：记录解析失败原因与响应首尾，便于定位截断/格式问题
            let parseHint = "";
            try {
              JSON.parse(rawText);
              parseHint = "JSON 语法合法，但缺 bodyPlans 或非数组";
            } catch (pe: any) {
              parseHint = `JSON.parse: ${String(pe?.message || pe)}`;
            }
            const tail = rawText.slice(-600);
            console.warn(
              `[Planner] 解析失败。长度=${rawText.length}\n首200: ${rawText
                .slice(0, 200)
                .replace(/\n/g, "\\n")}\n尾600: ${tail.replace(/\n/g, "\\n")}\n${parseHint}`,
            );
            errorMessage = `Planner 响应无法解析为有效 bodyPlans（${parseHint}）`;
          }
        } catch (e: any) {
          errorMessage = String(e?.message || "Planner LLM 调用失败");
        }
        if (!bodyPlans && attempt < MAX_PLANNER_ATTEMPTS) {
          console.warn(
            `[Planner] Attempt ${attempt} failed (${errorMessage}) — retrying once...`,
          );
        }
      }

      // --- 兜底：数据感知的保守结构（携带 Step 2 subClaim） ---
      if (!bodyPlans) {
        degraded = true;
        bodyPlans = buildFallbackBodyPlans(questionType, input || undefined);
        console.warn(
          `[Planner] Degraded to programmatic fallback. Reason: ${errorMessage || "unknown"}`,
        );
      }

      // --- 规范化：按 payload mappedPointIds 水合 subClaim，再预填「分论点」槽 ---
      bodyPlans = normalizePlannerBodyPlans(
        bodyPlans,
        input?.plannerPayload || null,
      );

      // Observability: final body → point mapping (diagnose silent point loss)
      try {
        const mapLog = (bodyPlans || [])
          .map((bp: any) => {
            const ids = Array.isArray(bp?.mappedPointIds)
              ? bp.mappedPointIds.map(String)
              : [];
            const claims = (
              Array.isArray(bp?.mappedPoints) ? bp.mappedPoints : []
            ).map((c: any) => String(c || "").slice(0, 12));
            return `${bp?.id || "?"} → [${ids.join(",")}]（${claims.join("、") || "未水合"}）`;
          })
          .join("；");
        console.log(`[Planner] final mapping: ${mapLog}`);
      } catch {}

      // Material-insufficient degraded: both bodies lack real claims
      const claimsEmpty = (bodyPlans || []).every((bp: any) => {
        const sc = bp?.paragraphPlan?.pointBlocks?.[0]?.subClaim;
        return !String(sc || "").trim() || String(sc).trim().length < 8;
      });
      if (claimsEmpty) {
        degraded = true;
        errorMessage =
          errorMessage ||
          "Step2 可用论点不足，已降级出空主张骨架（请回到 Step2 补点）";
      }

      res.json({
        status: "passed",
        degraded,
        errorMessage: degraded ? errorMessage || undefined : undefined,
        step2_5: {
          status: "passed",
          startedAt: Date.now(),
          updatedAt: Date.now(),
          attempt: 1,
          planSignature: `sig-${Date.now()}`,
          bodyPlans,
          degraded,
          errorMessage: degraded ? errorMessage || undefined : undefined,
          // 目前仅执行机械 QA（value 空 / 2-3 body / key 唯一 / mode 合法）；
          // 完整自适应 QA（rubric + 忠实性 + 段内有效性）为后续 Phase C。
          qaDepth: "mechanical",
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Planner failed" });
    }
  });

  // 1c. API - 对话导出
  app.get("/api/log/session/:sessionId", (req, res) => {
    const { sessionId } = req.params;
    const markdown = log.exportSession(sessionId);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="session-${sessionId}.md"`);
    res.send(markdown);
  });

  app.get("/api/log/turn/:turnId", (req, res) => {
    const { turnId } = req.params;
    const markdown = log.exportTurn(turnId);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="turn-${turnId}.md"`);
    res.send(markdown);
  });

  // 2. API - Analyze Topic (Step 1)
  app.post("/api/analyze-topic", async (req, res) => {
    try {
      const { question, userSelectedType } = req.body;
      if (!question) {
        res.status(400).json({ error: "Missing question text" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an elite IELTS Writing Task 2 Examiner.
        Analyze the following IELTS Writing Task 2 prompt:
        "${question}"

        Determine the correct IELTS Task 2 Question Type from this exact list:
        - "Agree / Disagree"
        - "Discuss Both Views"
        - "Advantages / Disadvantages"
        - "Two-part Question"
        - "Problem / Solution"
        - "Positive / Negative"
        - "Other"

        Classification rules:
        - "Problem / Solution": asks for causes/reasons AND solutions/measures (NOT Two-part).
        - "Positive / Negative": asks whether something is a positive or negative development/effect/trend.
        - "Other": does not fit the above (e.g. who should fund, who is responsible).
        - "Two-part Question": two distinct sub-questions that are NOT cause+solution and NOT positive/negative evaluation.

        Extract:
        1. The primary core controversy/issue to discuss.
        2. Any key scope constraints (specific target groups, limiting conditions, or absolutist terms like "only", "always", "entirely").
        3. A brief, highly-academic explanation (1-2 sentences) of why it belongs to this category.

        If a userSelectedType is provided: "${userSelectedType || ""}", check if it matches the correct type. Set isCorrectType to true or false.

        Format your output strictly as a JSON object matching this schema:
        {
          "questionType": "string (the correct question type)",
          "isCorrectType": boolean,
          "correctType": "string (the correct question type)",
          "coreIssue": "string (succinctly state the central controversy)",
          "constraints": ["string (constraint 1)", "string (constraint 2)"],
          "explanation": "string (academic explanation)"
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              questionType: { type: Type.STRING },
              isCorrectType: { type: Type.BOOLEAN },
              correctType: { type: Type.STRING },
              coreIssue: { type: Type.STRING },
              constraints: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              explanation: { type: Type.STRING },
            },
            required: [
              "questionType",
              "isCorrectType",
              "correctType",
              "coreIssue",
              "constraints",
              "explanation",
            ],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/analyze-topic:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to analyze topic" });
    }
  });

  // 2b. API - Batch extract topic tags for import
  app.post("/api/extract-topic-tags", async (req, res) => {
    try {
      const rawQuestions = Array.isArray(req.body?.questions)
        ? req.body.questions
        : [];
      const questions = rawQuestions
        .map((q: unknown) => String(q || "").trim())
        .filter(Boolean);

      if (questions.length === 0) {
        res.status(400).json({ error: "Missing questions" });
        return;
      }
      if (questions.length > 10) {
        res.status(400).json({ error: "At most 10 questions per batch" });
        return;
      }

      const TOPIC_CATEGORIES = [
        "Education",
        "Technology",
        "Environment",
        "Government",
        "Health",
        "Media",
        "Crime",
        "Culture",
        "Work",
      ] as const;
      const QUESTION_TYPES = [
        "Agree / Disagree",
        "Discuss Both Views",
        "Advantages / Disadvantages",
        "Two-part Question",
        "Problem / Solution",
        "Positive / Negative",
        "Other",
      ] as const;
      const DIFFICULTIES = ["Easy", "Medium", "Hard"] as const;

      const normalizeTopic = (value: unknown): (typeof TOPIC_CATEGORIES)[number] => {
        const raw = String(value || "").trim().toLowerCase();
        const hit = TOPIC_CATEGORIES.find((c) => c.toLowerCase() === raw);
        if (hit) return hit;
        if (raw.includes("educat") || raw.includes("school") || raw.includes("student")) return "Education";
        if (raw.includes("tech") || raw.includes("ai") || raw.includes("internet")) return "Technology";
        if (raw.includes("environ") || raw.includes("climate") || raw.includes("pollut")) return "Environment";
        if (raw.includes("govern") || raw.includes("policy") || raw.includes("tax")) return "Government";
        if (raw.includes("health") || raw.includes("medical") || raw.includes("diet")) return "Health";
        if (raw.includes("media") || raw.includes("news") || raw.includes("advertis")) return "Media";
        if (raw.includes("crime") || raw.includes("prison") || raw.includes("punish")) return "Crime";
        if (raw.includes("cultur") || raw.includes("language") || raw.includes("tradition")) return "Culture";
        if (raw.includes("work") || raw.includes("job") || raw.includes("employ") || raw.includes("career")) return "Work";
        return "Education";
      };

      const normalizeQuestionType = (
        value: unknown,
      ): (typeof QUESTION_TYPES)[number] => {
        const raw = String(value || "").trim().toLowerCase();
        const hit = QUESTION_TYPES.find((t) => t.toLowerCase() === raw);
        if (hit) return hit;
        if (raw.includes("agree") || raw.includes("disagree") || raw.includes("extent")) {
          return "Agree / Disagree";
        }
        if (raw.includes("both") || raw.includes("discuss")) {
          return "Discuss Both Views";
        }
        if (raw.includes("advantage") || raw.includes("disadvantage") || raw.includes("outweigh")) {
          return "Advantages / Disadvantages";
        }
        if (raw.includes("problem") || raw.includes("solution") || raw.includes("cause")) {
          return "Problem / Solution";
        }
        if (raw.includes("positive") || raw.includes("negative")) {
          return "Positive / Negative";
        }
        if (
          raw.includes("other") ||
          raw.includes("fund") ||
          raw.includes("who should") ||
          raw.includes("responsible")
        ) {
          return "Other";
        }
        if (raw.includes("two") || raw.includes("part")) {
          return "Two-part Question";
        }
        return "Agree / Disagree";
      };

      const normalizeDifficulty = (
        value: unknown,
      ): (typeof DIFFICULTIES)[number] => {
        const raw = String(value || "").trim().toLowerCase();
        if (raw.includes("easy") || raw === "e") return "Easy";
        if (raw.includes("hard") || raw.includes("difficult") || raw === "h") return "Hard";
        return "Medium";
      };

      const prompt = `
        You are an IELTS Writing Task 2 classifier.
        For EACH question below, extract exactly three tags.

        Allowed topic values (pick ONE):
        ${TOPIC_CATEGORIES.map((c) => `"${c}"`).join(", ")}

        Allowed questionType values (pick ONE):
        ${QUESTION_TYPES.map((t) => `"${t}"`).join(", ")}

        Allowed difficulty values (pick ONE):
        ${DIFFICULTIES.map((d) => `"${d}"`).join(", ")}

        Difficulty guidance:
        - Easy: clear single focus, common vocabulary, straightforward structure
        - Medium: some abstraction or dual aspects, typical exam complexity
        - Hard: abstract concepts, nuanced stance, multi-layered or dense wording

        questionType classification rules:
        - "Problem / Solution": asks for causes/reasons AND solutions/measures. Do NOT label as Two-part.
        - "Positive / Negative": asks whether something is a positive or negative development/effect/trend.
        - "Other": does not fit standard types (e.g. who should fund, who is responsible).
        - "Two-part Question": two distinct sub-questions that are NOT cause+solution and NOT positive/negative.

        Questions (JSON array, keep the SAME order in your output):
        ${JSON.stringify(questions)}

        Return JSON:
        {
          "results": [
            {
              "topic": "string",
              "questionType": "string",
              "difficulty": "string"
            }
          ]
        }

        CRITICAL:
        - results.length MUST equal ${questions.length}
        - results[i] corresponds to questions[i]
        - Do NOT invent values outside the allowed lists
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              results: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    topic: { type: Type.STRING },
                    questionType: { type: Type.STRING },
                    difficulty: { type: Type.STRING },
                  },
                  required: ["topic", "questionType", "difficulty"],
                },
              },
            },
            required: ["results"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      const rawResults = Array.isArray(data?.results) ? data.results : [];

      const results = questions.map((question, idx) => {
        const item = rawResults[idx] || {};
        return {
          question,
          topic: normalizeTopic(item?.topic),
          questionType: normalizeQuestionType(item?.questionType),
          difficulty: normalizeDifficulty(item?.difficulty),
        };
      });

      res.json({ results });
    } catch (error: any) {
      console.error("Error in /api/extract-topic-tags:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to extract topic tags" });
    }
  });

  // Coach API - Dynamic Chat with AI Coach
  app.post("/api/coach/chat", async (req, res) => {
    try {
      const {
        question,
        step,
        messages,
        stepContext,
        session,
        userMessage,
        isHiddenKickoff,
      } = req.body;
      if (!question || !step || !userMessage) {
        res
          .status(400)
          .json({
            error:
              "Missing required parameters: question, step, or userMessage",
          });
        return;
      }

      const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      log.startTurn(turnId, Number(step), String(userMessage));

      const promptHistory = (messages || [])
        .slice(-15)
        .map((m: any) => {
          return `${m.sender === "user" ? "Student" : "IELTS AI Coach"}: ${m.text}`;
        })
        .join("\n");

      // Extract user inputs and coach evaluations from previous steps to make AI truly aware
      const step1Chat = session?.step1?.chatHistory || [];
      const step1ChatText = step1Chat
        .filter((m: any) => m.sender === "user")
        .map((m: any) => m.text.trim())
        .filter((t: string) => t.length > 0)
        .join(" | ");
      const step1UserNotes = session?.step1?.userAnalysisNotes?.trim() || "";
      let step1Notes = step1UserNotes;
      if (step1ChatText) {
        if (step1Notes) {
          if (step1Notes !== step1ChatText) {
            step1Notes = `${step1Notes} (Chat History: ${step1ChatText})`;
          }
        } else {
          step1Notes = step1ChatText;
        }
      }
      if (!step1Notes) {
        step1Notes = "Not provided";
      }

      const step1Eval = session?.step1?.coachEvaluation;

      const step2Chat = session?.step2?.chatHistory || [];
      const step2ChatText = step2Chat
        .filter((m: any) => m.sender === "user")
        .map((m: any) => m.text.trim())
        .filter((t: string) => t.length > 0)
        .join(" | ");
      const step2UserStance = session?.step2?.userStance || "";
      const step2UserPoints = session?.step2?.userPoints || "";
      let step2Stance = step2UserStance;
      let step2Points = step2UserPoints;
      if (step2ChatText) {
        if (step2Stance) {
          if (step2Stance !== step2ChatText) {
            step2Stance = `${step2Stance} (Chat Stance: ${step2ChatText})`;
          }
        } else {
          step2Stance = step2ChatText;
        }
        if (step2Points) {
          if (step2Points !== step2ChatText) {
            step2Points = `${step2Points} (Chat Points: ${step2ChatText})`;
          }
        } else {
          step2Points = step2ChatText;
        }
      }

      const step2Eval = session?.step2?.coachEvaluation;
      const step3Draft = session?.step3?.userDraft || "";
      const step3Subpoints = session?.step3?.subpoints || [];
      const activeStep3Subpoint = step3Subpoints.find(
        (sp: any) => sp.id === session?.step3?.activeSubpointId,
      );
      const activeStep3Claim = activeStep3Subpoint?.content?.trim?.() || "";
      const activeBodyFramework = resolveStep2BodyFrameworkForSubpoint(
        session,
        activeStep3Subpoint,
      );
      const activeFrameworkStr = formatStep2BodyFrameworkForPrompt(activeBodyFramework);
      const step3SlotCursorStr = formatStep3SlotCursorForPrompt(activeStep3Subpoint);

      // Top-down internal brief: drives ask/skip/sufficiency strategy only — never student-facing content.
      const knownQuestionType =
        String(step1Eval?.correctType || "").trim() ||
        String(req.body?.questionType || "").trim() ||
        undefined;
      const questionBrief = buildQuestionBrief(question, knownQuestionType);
      const questionBriefStr = formatQuestionBriefForPrompt(questionBrief);

      // Resolve cross-step digests: reuse when sourceHash matches, else rebuild.
      // boardOverrides are folded into Step1 hash via getMergedStep1Eval.
      const { memory: resolvedMemory, rebuilt: memoryRebuilt } = resolveSessionMemory(
        session,
        question,
      );
      if (memoryRebuilt.length > 0) {
        console.log(
          `[MemoryDigest] Rebuilt: ${memoryRebuilt.join(", ")} (sourceHash mismatch or first build)`,
        );
      }
      const memoryDigestStr = formatMemoryDigestsForPrompt(resolvedMemory);

      let contextStr = "No previous step data available yet.";
      if (session) {
        let step1Summary = "";
        // Prefer raw student words (chat + notes) as a separate, unprocessed block so
        // later steps can expand from the student's own phrasing, not only AI labels.
        if (step1Notes && step1Notes !== "Not provided") {
          step1Summary += `Student's own words from Step 1 (unprocessed — prefer these phrasings when expanding):\n"${step1Notes}"\n`;
        }
        if (step1Eval) {
          const step1Dims = (step1Eval.suggestedDimensions || [])
            .map((d: string) => d?.trim?.() || "")
            .filter((d: string) => d.length > 0);
          step1Summary += `Coach Evaluation:\n- Question Type: ${step1Eval.correctType}\n- Core Issue: ${step1Eval.coreIssue}\n- Constraints: ${(step1Eval.constraints || []).join(", ")}\n- Suggested Dimensions: ${step1Dims.length > 0 ? step1Dims.join(", ") : "Not provided"}\n- Critique: ${step1Eval.critique}`;
        }
        if (!step1Summary) {
          step1Summary = "Not provided";
        }

        let step2Summary = "";
        if (step2Stance || step2Points) {
          step2Summary += `User's Formulated Stance: "${step2Stance || "Not provided"}"\nUser's Formulated Points: "${step2Points || "Not provided"}"\n`;
        }
        if (step2Eval) {
          step2Summary += `Coach Evaluation:\n- Current Stage: ${step2Eval.currentStage || "explore_A"}\n- User Stance: ${step2Eval.userStance || step2Stance}\n- User Points: ${step2Eval.userPoints || step2Points}\n- Coach Critique: ${step2Eval.critique}\n- Recommended Stance: ${step2Eval.suggestedStance}\n- Recommended Points: ${step2Eval.suggestedPoints}`;
          const blueprint = step2Eval.blueprint || session?.step2?.blueprint;
          if (blueprint && typeof blueprint === "object") {
            const position = String(blueprint.position || "").trim();
            const bodies = Array.isArray(blueprint.bodies) ? blueprint.bodies : [];
            const body1 =
              String(bodies[0]?.content || bodies[0]?.title || blueprint.body1 || "").trim();
            const body2 =
              String(bodies[1]?.content || bodies[1]?.title || blueprint.body2 || "").trim();
            step2Summary += `\n- Overall Thesis/Position: ${position || "Not provided"}`;
            step2Summary += `\n- Planned Body Paragraphs:`;
            step2Summary += `\n  Body 1: ${body1 || "Not provided"}`;
            step2Summary += `\n  Body 2: ${body2 || "Not provided"}`;
          }
        }
        if (!step2Summary) {
          step2Summary = "Not provided";
        }

        contextStr = `
=== ContextSummary(CoachingState) ===
Question:
${question}

${questionBriefStr}

${memoryDigestStr}

Known user ideas & Coach Diagnostics:

[Step 1 (Question Analysis) Diagnosis]:
${step1Summary}

[Step 2 (Argument Formation) Diagnosis]:
${step2Summary}

[Step 3 (Drafting) Ideas]:
- Paragraph Drafts: ${step3Draft || "Not provided"}
- Body 摘要（各主体段主题 + 已确认槽数；不展开 minutes）:
${formatStep3SubpointsBrief(step3Subpoints)}
- Active Subpoint (= starting claim for this turn): ${activeStep3Claim || "Not selected / not provided"}
- Active Subpoint belongs to: ${activeStep3Subpoint?.targetBody || "Unknown"}
- Step 2 Body Framework for Active Subpoint (INTERNAL — the frozen skeleton for this body; do not echo field names to student):
${activeFrameworkStr}
- Step 3 slot cursor (INTERNAL — firstEmpty / confirmed siblings / pending; do not echo to student):
${step3SlotCursorStr}
- Step 3 judgment lens (INTERNAL — what "good enough" means for the current slot; use it to decide thin/off_target/duplicate, but phrase your question naturally, never read the lens to the student):
${formatLensAnchorForActiveSubpoint(activeStep3Subpoint)}
- Step 2 mapped brainstorm points are QUESTION CUES only for this body's coaching: use them to shape the firstEmpty Socratic ask. FORBIDDEN: organizing them into multi-slot draft values / a confirm bundle / mode=confirm on kickoff or before the student has spoken this beat in Step 3.
- Rule for this turn: If Active Subpoint exists, treat it as the student's already-approved claim. The server (meeting secretary) owns the skeleton and slot landing — you only produce dialogue. Start by asking the first still-missing slot (see slot cursor). Ask clarification only if this claim is empty, too vague, or bundles unclear mixed points.
- Mode hint: structure is already frozen by the server; do NOT propose paragraph modes / paragraphPlan / direct_points in Step 3. Just coach the current slot conversationally.

Current objective:
Review the context above and the current step's instructions. Organize and develop the existing ideas. Keep full consistency with the established positions. Prefer memory digests' filled/openGaps over re-deriving what is already known.
=====================================
`;
      } else {
        contextStr = `
=== ContextSummary(CoachingState) ===
Question:
${question}

${questionBriefStr}

${memoryDigestStr}
=====================================
`;
      }

      let stepGuidelines = "";
      if (Number(step) === 1) {
        stepGuidelines = `
- Step 1: Topic Analysis (审题与题目拆解)
  Current State: ANALYSIS
  Role: You are a Socratic Question Analyst.
  Objective: Complete Step 1 using SLOT-based progression (not rigid fixed sequence).

  ## Step 1 Slot Checklist (按缺口推进，不重复提问)
  Required slots:
  1) correctType (题型)
  2) coreIssue (核心议题/写作任务焦点)
  3) constraints (关键限定词/范围约束)
  4) suggestedDimensions (建议讨论维度：发散收集，有效维度至少 3 个、最多 6 个)

  You MUST process each turn in this order:
  A. Scan all available evidence (current message + chat history + context summary).
  B. Fill as many slots as possible in this turn.
  C. Ask ONLY the first still-missing slot.
  D. Completion is NOT allowed merely because effective dimensions >= 3. Follow Dimension quality & exit rules: probe → tag → offer exit → only then emit Step-2 CTA after student stops or chooses to proceed.

  Correction-first rule (CRITICAL):
  - If the student's answer is off-target for the current slot, FIRST name the mismatch in one short sentence, THEN guide the correction. Do NOT open with empty praise like "非常准确/精准地抓住了/完美".
  - Example: student restates background as coreIssue -> "你说的是题目背景现象，还不是写作任务焦点。请改成：这道题真正要你回答的是什么？"

  Board-authority rule (CRITICAL — right-side diagnosis board may be user-edited):
  - The Coach Evaluation values in ContextSummary (Question Type / Core Issue / Constraints / Suggested Dimensions) are the SOURCE OF TRUTH for already-filled slots, including any student edits on the board.
  - When a slot already has a non-empty value in ContextSummary, treat it as filled. Do NOT overwrite it in progressUpdate with a different AI-preferred wording unless the student explicitly asks to change it in chat.
  - If the student edited dimensions on the board (ContextSummary already lists them), continue from those labels; do not silently replace or "improve" them.
  Per-slot feedback — no spoiler (CRITICAL):
  - When validating ONE filled slot while the NEXT slot is still missing, Part 1 must confirm ONLY what the student just answered for that slot (≤1 short sentence). Part 2 asks the first still-missing slot.
  - correctType filled, coreIssue missing -> confirm the type label only (e.g. "**Two-part**，判断正确。"). FORBIDDEN in Part 1: enumerating sub-questions ("第一…第二…"), paraphrasing the essay prompt, stating causes/evaluation/stance tasks, or previewing questionBrief writingDestination/taskMap content. Treat "explaining what the two parts ask" as coreIssue content — the student must say it in Q2 first; you may echo it briefly only AFTER they answer coreIssue.
  - coreIssue filled, constraints missing -> confirm their coreIssue wording only; do NOT list suggested dimensions or preview the essay structure.
  - coreIssue filled, constraints auto-skipped (hasHardQualifiers=false) -> same as above: Part 1 confirms coreIssue only (≤1 sentence). Silently set constraints=[] and constraintsSkipped=true; do NOT mention skipping, absent qualifiers, or "无明显限定词" in chat or in constraints.
  - constraints filled, suggestedDimensions missing -> confirm constraints only; do NOT suggest dimension names for them.
  - Task A dimensions given, Task B dimensions missing (compound type) -> confirm Task A's dimension(s) only; do NOT preview what Task B's evaluation/analysis will conclude, do NOT say positive/negative content ahead of time.
  - BAD (Q1 correct, coreIssue still missing): "它包含两个任务：分析原因 + 判断积极消极。"
  - BAD (coreIssue correct, auto-skip constraints): "由于题目中没有 entirely/only 等绝对限定词，我们不需要去极端化思考，可以直接从多个维度切入。"
  - GOOD (Q1 correct): "Two-part，判断正确。"
  - GOOD (Q2 after student answer): "核心议题抓对了。"
  - GOOD (Q2 → dimensions, no hard qualifiers): Part 1 "核心议题抓对了。" / Part 2 missing suggestedDimensions template only.

  coreIssue definition by question type:
  - Agree / Disagree, Discuss Both Views, Advantages / Disadvantages, Positive / Negative: state the central controversy/judgment the writer must make.
  - Problem / Solution: state the problem object + what must be explained (causes and/or solutions), NOT a fake "debate".
  - Two-part Question / Other: state the writing tasks the two (or more) questions require, in one sentence.
  - Never accept a pure background paraphrase as coreIssue.

  suggestedDimensions boundary (CRITICAL):
  - Dimensions must be NEUTRAL analytical angles (e.g. 身份认同、文化多样性、经济发展), NOT evaluative conclusions.
  - If the student already gives evaluative conclusions (e.g. "身份认同会变弱，但能促进经济"), extract the dimension nouns only, and leave the positive/negative judgment for Step 2 stance. Do NOT lock a stance in Step 1.

  Granularity calibration (CRITICAL — Step 1 collects ENTRY POINTS, not content; do not drift into Step 2's job):
  - A suggestedDimensions entry is an ABSTRACT LABEL that can be expanded LATER — think "经济、身份认同、社会结构", not a worked-out mechanism, causal chain, scenario, beneficiary, or impact/positive-negative judgment. Any of the latter belongs to Step 2 (brainstorm/explore) or Step 3 (paragraph logic), NOT Step 1.
  - If the student's answer is ALREADY a full causal chain or concrete scenario (e.g. "人们为了有更多的工作机会，会重点学习主流语言，母语会被忽略"), do NOT chase it deeper and do NOT ask what its impact/effect is. Instead, ABSTRACT it UP into ONE short dimension label (e.g. "就业/经济需求") and move on — the detailed reasoning stays for the student to reconstruct in Step 2.
  - Do NOT ask "这会带来什么影响" / "这是好事还是坏事" / "举个例子" while still in the suggestedDimensions slot — those are Step 2 questions (explore/stance), not Step 1. Step 1's only job here is naming enough neutral angles to analyze from.
  - This is the mirror-image of the global FILLED_SHALLOW follow-up rule: there, thin answers get ONE depth follow-up; here, answers that are ALREADY too deep get pulled back up to a label, never pushed deeper.

  suggestedDimensions anti-fabrication rule (CRITICAL — do not pad to hit the count):
  - Every dimension you write into progressUpdate MUST be extractable from the student's own words (this turn or earlier). You MUST NOT invent an ADDITIONAL dimension the student never mentioned or implied just to reach a target count.
  - Causal-chain vs parallel-angles test (CRITICAL — decide split vs collapse BEFORE writing labels):
    - Ask: if I remove factor A, does factor B still stand alone as an independent cause/angle that could support its own paragraph? If YES -> may record 2 labels. If NO (B is only A's consequence, middle step, restatement, or the next link in the same narrative) -> collapse into ONE abstract label covering the whole chain.
    - Parallel OK example: student says "一是经济发展，二是教育制度偏向主流语言" — two independent causes -> 2 labels (e.g. "经济发展" + "教育制度").
    - VIOLATION (do NOT do this): student says "经济文化交流增多之后，强势文化流入，对本国文化的冲击". This is ONE causal chain (A→B→C), NOT two parallel angles. Record ONE label (e.g. "经济全球化冲击" / "强势文化冲击"); do NOT split into "经济角度" + "强势文化角度", and do NOT praise it as "两个角度".
    - Fabrication VIOLATION (do NOT do this): student's message only describes ONE causal chain — economic development -> communication convenience -> people learn the dominant language -> native language de-emphasized. Collapsing that chain into ONE label (e.g. "经济与沟通便利驱动") is correct; ALSO adding "文化身份认同" (never mentioned) as an extra dimension to look more thorough is FABRICATION and FORBIDDEN.
  - Feedback proportionality: Part 1's confirmation must match what was ACTUALLY given. Do NOT describe a single causal chain as if the student did rich "多维度分析". State plainly what was recorded, nothing more.

  Dimension quality & exit rules (CRITICAL — Step 1 is divergent brainstorm with light quality filter; server enforces tags + exit gate):
  - Cap: never keep more than 6 dimension labels. At 6, stop asking for more angles and you MAY emit the hard Step-2 CTA.
  - Tag format (STRICT): write status tags as SEPARATE parentheses after the label. Correct: "公众健康（已探测）（可展开）". Incorrect / ignored by server: "公众健康（二手烟危害 - 可展开）", untagged "公众健康", or mixing explanation inside the status parentheses.
  - Confirmed dimension LOCK (CRITICAL): once a dimension already carries server probe stamps （已探测）/（可展开）/（空标签）/（质量待确认）, copy that entry VERBATIM (same core label + same status tags) into suggestedDimensions every turn. You may APPEND new bare labels at the end. FORBIDDEN: stripping status tags, rewriting a confirmed label's tags, or dropping a confirmed dimension unless the student explicitly asks to remove/rename it. Server restores confirmed stamps if the model rewrites them.
  - Light expandability probe (ONCE per new dimension, REQUIRED before quality tags) — SERVER OWNS THE LOOP:
    1) First record the raw label WITHOUT （可展开）/（空标签）/（已探测）. FORBIDDEN: tagging status on the introduce turn.
    2) While ANY unprobed (bare) label remains: Part 2 MUST be a ONE-dimension probe ask for the earliest bare label (e.g. "『××』这个角度你脑子里已经有具体场景或例子的苗头了吗？"). FORBIDDEN: jumping to the next task (e.g. Task B / 评价) while Task A / earlier labels are still unprobed. FORBIDDEN: merge-probing two labels in one ask. FORBIDDEN: re-probing a dimension that already has （已探测）.
    3) On the student's NEXT answer to a probe: set progressUpdate.step1Data.probeVerdict to "expandable" (any concrete cue) or "thin" (no/不清楚/vague). Do NOT self-stamp （可展开）/（空标签） — the server stamps from probeVerdict. Ambiguous → "thin".
  - FORBIDDEN: emitting hard completion CTA or soft exit while unprobed labels remain.
  - Probe anti-loop: each dimension gets at most ONE probe. If it fails (thin), do NOT deepen that same dimension — invite a DIFFERENT new angle instead (only when no bare labels remain).
  - Effective count (server enforces): ONLY dimensions that have BOTH standalone tags （已探测） AND （可展开） count. Untagged labels, （空标签）, and （质量待确认） do NOT count toward sufficiency.
  - AI sufficiency first (CRITICAL): YOU judge whether the angle set is enough BEFORE asking the student. Set progressUpdate.step1Data.dimensionsSufficient=true only when ALL hold: (a) effective dimensions >= 3; (b) angles are non-duplicate and cover enough entry points for this question type (for Agree/Disagree prefer both support-side and oppose-side angles when the student has material for both); (c) thin/质量待确认 labels are not treated as "enough"; (d) no bare/unprobed labels remain. If not sufficient, keep probing bare labels or ask for another NEW angle — do NOT ask "够用了吗".
  - Soft exit offer ONLY after dimensionsSufficient=true and no bare labels: ask whether they want to add more; set exitOffered=true and tag （已询退出）. Soft ask MUST NOT include "点击【下一步】". Example soft ask: "这几个角度已经可以支撑分析了。还能想到别的吗？如果暂时想不到别的，告诉我，我们再进入第二步。"
  - Hard completion CTA ONLY after soft exit was offered AND student confirms stop / says "没有更多了" / "先这样", OR (cap=6 AND every label already probed): Part 2 MUST include both "点击" + "【下一步】" (or "下一步") AND "进入第二步", then set isCompleted:true.
  - Cap=6 means stop asking for MORE new angles. It does NOT skip probes on existing bare labels. Student exhausted with bare labels still open → server may stamp （质量待确认）.

  Per-task dimension flow (CRITICAL — ONLY for compound question types where questionBrief.taskMap names 2 distinct tasks: Two-part Question, Problem / Solution, Positive / Negative, multi-task Other):
  - Do NOT ask ONE generic "list 2-4 dimensions" question for these types. Split into two sequential, task-scoped questions, but phrase BOTH as natural, direct ANGLE-level questions — never as a meta/procedural question about the analysis method itself, and never as a Step-2-style content/evaluation question (see Granularity calibration above — you are still only collecting entry-point LABELS here, not impacts or judgments):
    1) Task A dimensions (ask first, while no dimension is recorded yet): ask directly what angles explain questionBrief.taskMap.explore_A (e.g. the causes/first task). Keep it plain and concrete, not "请列出维度名称" jargon-flavored. Prefer collecting 2 angles for Task A before moving to Task B (see Per-task sufficiency below).
    2) Task B dimensions (ask second, ONLY after Task A has enough angles per Per-task sufficiency below) — this question's GOAL is to elicit Task B's ANGLES (what lenses to evaluate from), and it MUST read as a natural continuation of the conversation (referencing the phenomenon/topic just discussed, not restating "以上维度"), NOT a fresh isolated question and NOT a question about whether the prior angles are "reusable/applicable":
       - FORBIDDEN framing: asking the student to judge whether their Task A angles "同样适用/是否可复用" — this exposes internal bookkeeping logic as if it were the substance of the question, and reads stiffly. That check is YOUR silent internal task, not the student's.
       - FORBIDDEN framing (Granularity — CRITICAL): do NOT ask "这会带来什么影响" / "是好事还是坏事" / "举个例子" — that asks for Step 2 content (impact + polarity), not a Step 1 angle label. Ask for the ANGLE/lens to evaluate FROM, e.g. (for a causes+evaluation question) "那评估这种变化好不好，你觉得可以从哪些方面来看？比如身份认同、社会结构，只是举例，你可以换别的角度。" Do not force this exact wording — restate the topic in your own natural words, continuing from what was just discussed, but keep the ASK at the angle/label level.
       - Whatever the student answers, even if they slip in evaluative language ("这会让身份认同变弱"), extract ONLY the neutral noun ("身份认同") as the dimension; do NOT lock a stance in Step 1 (apply the suggestedDimensions boundary rule above) and do NOT chase the evaluative claim further here.
       - Do NOT invent the Task B dimension yourself — it must come from what the student actually said.
  - Single-task question types (Agree / Disagree, Discuss Both Views, Advantages / Disadvantages) keep the existing single generic "list 2-4 dimensions" question — do NOT split these; they only have one task to analyze.
  - Tag each recorded dimension with which task(s) it covers using a short natural-language suffix so Step 2 can anchor correctly later, e.g. "经济发展（原因+评价均适用）" or "身份认同（评价）". Do not use raw field/stage names (taskMap, explore_A/B) as the tag text — and never expose this tagging logic to the student either.
  - Per-task sufficiency (CRITICAL — prefer collecting per-task, not just a pooled total): for EACH task (A and B), prefer at least 2 distinct angles before moving to the next task/slot. HARD: do NOT ask Task B while any Task A label is still unprobed — finish light probes on Task A first (server will rewrite Part 2 if you jump early). If a task only has 1 angle after the first ask, ask ONE follow-up scoped to THAT SAME task (e.g. "除了[已给角度]，这方面还有别的角度吗？") before moving on. Anti-loop: at most ONE such follow-up per task; if the student still only gives 1, accept it and move on (do not fabricate a 2nd to force the count).
  - Sequencing with Dimension quality & exit rules above: after BOTH tasks have been asked AND all collected labels are probed (each following Per-task sufficiency + probe-first), if the TOTAL EFFECTIVE dimension count is still below 3, ask for one more NEW angle (no exit option yet); do not fabricate to skip this.
  - Continuation-signal routing (CRITICAL — student may still be finishing the previous task after you already asked the next one):
    - If your previous question already moved to Task B (or the next slot), but the student's CURRENT message signals they are still continuing the previous task — e.g. "还没说完" / "我接着说" / "继续刚才" / "等一下" / "先补充一下" / "还有一个原因" / or they clearly keep elaborating causes when you just asked for evaluation angles — then route this turn's content into the PREVIOUS task/slot (Task A / prior slot). Do NOT treat it as an answer to the new question.
    - Silently merge the continuation into the correct prior slot's suggestedDimensions (apply the causal-chain vs parallel-angles test). Do NOT scold, do NOT re-ask the already-advanced question in the same turn, and do NOT pretend they answered Task B.
    - After recording the continuation, you MAY briefly acknowledge and then either stay on the prior task (if still under-filled per Per-task sufficiency) or re-ask the next-task question once.

  Critical skip rule (Step1-specific example of slot reuse):
  - A scope qualifier (entirely / completely / only / always / all / 完全 / 彻底 / 所有 / 只 / 仅 / 必须 / 始终) that appears in the coreIssue answer OR the question IS the constraint. Recognizing it verbally in your feedback is NOT enough.
  - If the student's coreIssue answer (or current message) contains such a qualifier that matches the question (including: student says 完全 while question has all/entirely/completely), you MUST in the SAME turn copy real labels into progressUpdate.step1Data.constraints (e.g. ["所有 (all)", "完全 (entirely)"]) AND skip the constraints question, moving directly to suggestedDimensions.
  - VIOLATION (do NOT do this): filing the qualifier only into coreIssue, leaving constraints empty, writing "无明显限定词", or asking "题目里有没有哪些词，限制了讨论范围？" after the student already echoed a qualifier.
  - Example: question has "all public places"; student answers coreIssue with "是否要在公共场所完全禁止吸烟". You MUST set constraints including "所有 (all)" and/or "完全 (entirely)" this turn — NEVER "无明显限定词".
  - Note: the server also backfills constraints from question-echoed qualifiers as a safety net, but you must not rely on it — do the copy-and-skip yourself.
  - When speaking to the student, say "关键限定" / "讨论维度" / "题型" — never quote raw slot/field names like "constraints" or "correctType", and never mention progressUpdate paths.

  Hard-qualifier gate (from INTERNAL questionBrief — CRITICAL):
  - If questionBrief.hasHardQualifiers=false AND the student did not echo any qualifier: do NOT ask the constraints question. When coreIssue is filled, set constraints=[] and constraintsSkipped=true silently, then move to suggestedDimensions.
  - FORBIDDEN in constraints array and in chat: the string "无明显限定词". Never write it to the board.
  - Student-facing silence on skip (CRITICAL): never explain this gate in chat. FORBIDDEN: citing absent qualifiers, "去极端化", "跳过这一步". Just confirm coreIssue briefly and ask the dimensions question.
  - If questionBrief.hasHardQualifiers=true OR the student echoed all/完全/entirely/etc.: fill real constraint labels; ask the constraints question ONLY when the constraints slot is still empty.
  - NEVER invent fake scope limits that are not in the question.

  Missing-slot question templates (use only when that slot is truly missing):
  - missing correctType -> "这道题属于哪一种 Task 2 题型？"
  - missing coreIssue -> "请用一句话说：这道题真正要你完成的写作任务是什么？不要翻译或复述背景。"
  - missing constraints -> "题目里有没有哪些词，限制了讨论范围？请列 1~3 个。" (ONLY when hasHardQualifiers=true)
  - missing suggestedDimensions, single-task type -> "为了回答这道题，我们需要比较哪些方面？请列出 2~4 个中性维度名称即可（先不要下利弊结论）。"
  - missing suggestedDimensions, compound type, Task A not yet answered -> use the Per-task dimension flow above, Task A question.
  - Task A answered, Task B not yet answered (compound type) -> use the Per-task dimension flow above, Task B question (guided by Task A's answer).
  - suggestedDimensions has fewer than 3 effective dimensions so far -> ask for another NEW angle with no exit option yet (per Dimension quality & exit rules); do not fabricate labels.

  Completion output (ONLY after dimensionsSufficient + exit offered + student confirmed stop, or cap=6):
  - Part 1: ONE short confirmation + compact structured summary (题型、核心议题、关键限定、建议维度). No long restatement. You MAY briefly echo writingDestination in structural terms only.
  - Part 2: HARD CTA — must tell the student to click the 【下一步】 button AND include the phrase "进入第二步" (both required). Soft exit asks must NOT set isCompleted.
  - Structural preview ONLY (optional, one short clause): e.g. "下面我们按：原因段 → 评价段 来梳理" — using taskMap labels, NEVER attach a recommended stance or preferred conclusion (FORBIDDEN: "建议弊大于利" / "多数稳妥路径是…").
  - CRITICAL: In the SAME response when you emit the HARD completion CTA above, you MUST set progressUpdate.isCompleted: true.
  - FORBIDDEN: Do NOT set isCompleted: true while still asking dimension questions, soft exit ("够用了吗"), or any other missing-slot question.
  - FORBIDDEN after Step 1 completion: Do NOT ask Step 2 questions (stance, blueprint, body paragraphs, thesis) while still in Step 1. Those belong only in Step 2.
  - Do NOT populate progressUpdate.step2Data while step=1.
`;
      } else if (Number(step) === 2) {
        stepGuidelines = `
- Step 2: Parallel Points + Stance (材料池 / 立场 — NOT paragraph layout)
  Current State: MATERIAL_POOL
  Role: Socratic Logical Coach for brainstorming.
  Objective: Guide the student to expand PARALLEL concrete points, then choose a stance. Do NOT assign Body Paragraph 1/2 here — Step 2.5 Planner owns paragraph layout after Step2 completes.

  ## Question-type stage mapping (CRITICAL)
  Step2 produces PARALLEL points + stance for the Planner; do NOT finalize paragraph layout here.
  Map explore_A / explore_B using INTERNAL questionBrief.taskMap — but explore_B means "fill missing coverage buckets", NOT "always dig the opposing side":
  - explore_A = expand concrete claims under Step1 dimensions (parallel points: claim + scene/mechanism).
  - explore_B = ONLY ask for missing material buckets required by the question type. If no hard buckets are missing, SKIP explore_B and go to stance (or summary when requiresStance=false).
  - Agree / Disagree: do NOT force an opposing/concession point when the student is fully agree/disagree. Opposing material is optional (soft) unless they choose partial agreement.
  - Discuss Both Views: hard buckets view_a + view_b — both required before leaving explore_B.
  - Advantages / Disadvantages: hard buckets advantage + disadvantage.
  - Problem / Solution: hard buckets cause + solution.
  - Positive / Negative: collect both positive and negative evaluation angles before leaving explore_B.
  - Two-part: hard buckets part_1 + part_2.
  - Prefer questionBrief.taskMap labels for student-facing wording. Internal userPoints may still use "A面：" / "B面：" delimiters for compatibility; the server normalizes into plannerPayload.points.

  ## Current Stage Logic (current_stage / 引入状态和状态变化)
  The student progresses through four distinct stages. You MUST strictly obey the rules of the active stage, determine the next stage based on user inputs, and output the correct 'currentStage' inside progressUpdate.step2Data:

  Cross-stage extraction rule (CRITICAL):
  - Before you ask any stage question, check whether the student's CURRENT message already contains content from later stages.
  - If the current message already includes both A-side and B-side points, do NOT force another explore question; move directly toward stance (or summary when requiresStance=false).
  - When INTERNAL questionBrief.requiresStance=true: you may skip forward to "stance" when evidence is sufficient. Do NOT jump directly to "summary" unless stance is also explicit and blueprint-ready.
  - When INTERNAL questionBrief.requiresStance=false: NEVER enter "stance". After explore_B is sufficient, go directly to "summary". Do NOT ask the student to choose a personal stance / agree-disagree option — the essay does not require one (typical what/why/how / Problem-Solution / many Two-part prompts). For blueprint.position / userStance, write a neutral overview sentence that names the two tasks (e.g. "本文先解释禁用必要性，再提出其他减塑措施"), NOT an agree/disagree judgment.

  Stance-skip rule (CRITICAL — driven by questionBrief.requiresStance):
  - requiresStance=true (Agree/Disagree, Discuss Both Views, Positive/Negative, outweigh-style Adv/Dis): explore_A → (explore_B only if coverage buckets missing) → stance → summary.
  - requiresStance=false (Problem/Solution, pure what/why Two-part, discuss-only Adv/Dis without judgment ask): explore_A → (explore_B if buckets missing) → summary. Skip stage "stance" entirely. FORBIDDEN: inventing agree/disagree options, "老师帮我推荐一个", or asking "你最终更倾向于哪种立场" when the prompt never asked for a personal opinion.
  - Paragraph layout / body assignment is NOT Step2's job — Step 2.5 Planner consumes plannerPayload.points after Step2 completes.
  - Explore-before-stance (HARD): Do NOT enter stage "stance" and do NOT write a locked userStance until explore is done (enough concrete points expanded under Step1 dimensions, or student says they have no more). Empty opposing-side buckets for Agree/Disagree do NOT mean explore is finished — keep expanding in explore_A. FORBIDDEN in explore stages: announcing "你倾向于同意/不同意" as if stance were already chosen; Step1 issue wording is not a stance selection.

  Dimension-aware questioning rule (CRITICAL):
  - If Step 1 already provides suggestedDimensions in context, your question must explicitly anchor to those dimensions first, then ask for concrete expansion (场景 / 机制 / 受益或受影响对象).
  - Prefer "沿着你刚才的这个维度，我们把它展开到具体场景/人群/机制" over generic repeats.
  - Use generic fallback only when no relevant dimension exists in context.
  - Student-facing side labels: use questionBrief.taskMap.explore_A / explore_B wording (also stamped as taskLabelA / taskLabelB). Do NOT always say "A面优势/B面不可替代". Internal userPoints markers may still use "A面：" / "B面：" as stable delimiters.
  - FORBIDDEN when suggestedDimensions is non-empty in ContextSummary (Step1 already converged these):
    1) Re-asking a dimension inventory: "可以从哪些角度切入" / "有哪些方面" / "请列出维度" / "还可以从哪些角度".
    2) Re-confirming question type / correctType (e.g. "这是什么题型").
    3) Re-confirming coreIssue / writing task (e.g. "这道题真正要你回答的是什么").
    Step 2 only expands concrete content under known dimensions; it must NOT re-open Step 1's convergence slots.

  Step1 dimension disposition ledger (CRITICAL — no silent drop):
  - Every Step1 dimension tagged （已探测）（可展开） MUST receive an explicit disposition before stance/summary completion.
  - Allowed dispositions only: expanded (展开进 userPoints) | merged (整合进另一点，must set mergedInto) | dropped (明确放下，must set note/reason).
  - FORBIDDEN: finishing Step 2 while any effective Step1 dimension is still pending / never mentioned.
  - Keep progressUpdate.step2Data.dimensionDispositions as an array of { dimension, disposition, side?, mergedInto?, note? } covering ALL effective Step1 dimensions.
  - When converging, also mirror dropped/merged items into clustering.outliers with disposition "dropped"|"merged" and mergedInto when relevant.
  - If a high-quality Step1 angle was never explored, ask the student to expand / merge / drop it — do not invent content for them and do not ignore it.

  Dual readiness check (CRITICAL — do not conflate):
  - logicValid: the claim itself is a valid result/judgment for the question (e.g. "身份认同变弱" can already be a valid negative impact of cultural loss). Do NOT force deeper abstract philosophy.
  - exampleReady: there is at least one concrete scene/beneficiary/mechanism that can support ~90-110 words.
  - A point may be logicValid=true but exampleReady=false. In that case, ask for a concrete example/scene, NOT a deeper "why".
  - Only treat a body as fully ready when BOTH are true, OR the student explicitly chooses to keep a thin point and you tag it "（待补例子）" in userPoints.

  Depth follow-up style (CRITICAL — this is a RESCUE mechanism, NOT the default first-ask style):
  - Scope: the "two concrete candidate directions" technique below applies ONLY on the SECOND ask for the SAME point/slot — i.e. only after the student has already given one shallow/stuck answer for THIS specific point. It is a fallback, not how you should phrase your first question about any new dimension/sub-point.
  - First ask for a NEW dimension/sub-point (CRITICAL — anti-spoiler): ask an OPEN, direction-only question naming the dimension itself (e.g. "政府层面具体可以通过什么方式来管控企业？"). Do NOT append example answers/mechanisms in the same question ("比如，是对A征税，还是推广B" is FORBIDDEN here) — that pre-fills near-final answers before the student has tried. Concrete "比如 X / Y" examples are reserved for the follow-up-after-stuck case below.
  - FORBIDDEN open prompt after the student says they don't know how to expand: "请谈谈你的看法 / 请用一两句话展开".
  - REQUIRED (only at this follow-up point, after one shallow answer): offer exactly TWO concrete candidate directions (场景 / 后果 / 受益对象) and let the student pick or fill one. Do NOT write a full ready-made sentence for them.
  - Candidate directions MUST be neutral: do NOT imply which direction is easier, safer, or higher-scoring. You may privately consult questionBrief.candidateDirectionSeeds, but never present them as preferred answers.
  - If the student's claim is already a direct result of the essay phenomenon (e.g. cultural loss → weaker identity), acknowledge logicValid=true, then only ask for a scene if exampleReady is still false.

  Compact feedback rule (CRITICAL, explore stages — a CONSTRAINT, not a literal template; see INTENT CLASSIFICATION BEFORE FORMAT above for which intent this applies to):
  - When intent = NEW CONTENT: Part 1 must be ONE short, natural-sounding acknowledgment of what the student gave — brief, not a data-dump confirmation. Wording may vary; "很好，目前我们记录到：..." is one example phrasing among many, not a mandatory opener.
  - No-spoiler acknowledgment (CRITICAL): Part 1 may name WHICH dimension/point the student's answer belongs to, but must NOT explain WHY it works, walk through its causal mechanism, or spell out the reasoning chain on the student's behalf (e.g. FORBIDDEN: "...能有效倒逼企业从源头上减少塑料的使用" / "...极大增强了措施的可操作性" as an added analysis the student never said). That reasoning is the student's own thinking-practice, not something to hand them pre-packaged. Keep the acknowledgment to confirming receipt + which slot it fills; save analysis for your own internal evaluation, not the chat text.
  - FORBIDDEN regardless of phrasing: renumbering, bold restating, or multi-bullet paraphrase of what the student just said.
  - Do NOT invent empty numbered list items (never output a bare "1." with no content).
  - When intent = ASKING FOR YOUR JUDGMENT/OPINION (see INTENT CLASSIFICATION rule): do NOT use this confirmation shape at all — answer directly as a recommendation instead.

  Dimension Coverage & Retention Rule (CRITICAL — prevents silently dropping sibling dimensions):
  - MANDATORY FIRST STEP before you decide anything else about transitioning: re-read ALL of your own coach questions in the CURRENT explore stage in "Previous Conversation Logs" (not only the last line). If an earlier turn named TWO OR MORE dimensions and a later turn only scaffolds one of them, the sibling dimension is STILL named and must be checked for coverage.
  - Also check progressUpdate.step2Data.userPoints / prior user messages on this side for any dimension the student already named but has not developed. Student-named siblings in userPoints (e.g. "1. 塑料难降解…；2. 垃圾处理成本高") count as multi-dimension even if your latest question only asked about one of them.
  - Listing a point in userPoints ≠ confirming/expanding that point. A sibling that was only dumped in an initial list and never individually asked about remains uncovered.
  - Sibling confirmation before leave (CRITICAL): before leaving the current explore stage, every distinct point already recorded in userPoints for THIS side must have been individually addressed in at least one coach turn (depth follow-up OR brief confirmation ask). If userPoints lists "1. X；2. Y" and you only followed up on X, you MUST NOT transition yet — next ask about Y (or apply the retention question for Y), even if Y's label already contains some mechanism words.
  - If YES to multi-dimension naming, and the student's current answer (+ recorded points) only develops ONE of those named sub-dimensions, this is an "uncovered dimension" case. This check runs BEFORE the sufficiency gate below and BEFORE any depth follow-up decision.
  - If NO (only one dimension was ever named, or the "other" one is just a synonym of the developed one), skip this rule entirely and proceed with the normal sufficiency-gated transition below.
  - Priority when BOTH an uncovered dimension AND insufficient depth exist: ask the depth follow-up first (existing Content-completeness boundary rule); do NOT ask about the uncovered dimension in that same turn. Only apply the retention question in a later turn once the developed point becomes sufficient OR is tagged （待补例子）.
  - Anti-loop vs retention precedence (CRITICAL): the "at most ONE depth follow-up per point" anti-loop rule caps follow-ups WITHIN a single developed point. It does NOT authorize skipping a sibling named dimension, and it does NOT override this Retention Rule. After accepting a thin developed point (with （待补例子） if needed), you MUST still check for uncovered siblings before transitioning; if one remains, ask the retention question and keep currentStage unchanged.
  - When an uncovered dimension IS found and the developed point is already sufficient: do NOT silently drop it, do NOT silently assign 详写/略写 for the student, and do NOT advance currentStage yet. In THIS turn, keep currentStage UNCHANGED and WALK the uncovered sibling first:
    - Present the current material-pool points as a numbered list (①②③…; use plannerPayload.fixedClaims / points when available).
    - Ask the student to补 1–2 句 concrete scene/mechanism for the uncovered point. FORBIDDEN as soft default: automatically recommending「详写①、略写②」just because there are two points.
    - After BOTH (or all) sibling points have writable content, THEN ask 详略 based on content volume (可以都详写，也可以一详一略——由可写量决定). Only then may you present a numbered 详略 scheme for confirm (UI「采纳/拒绝」).
    - Student may reply「都详写」/「①详写，②略写」/「放弃某条」. FORBIDDEN: treating「你觉得呢」/「你定」as confirmation.
    - Example (uncovered still thin): "目前材料池有：\n① 西方文化冲击（已有场景）\n② 数字化网络（尚未展开）\n请先给②补 1–2 句机制；补完后再定详略。"
    - Example (both have content, then 详略): "两条都有可写内容了。按内容量，你更想详写哪一条、略写哪一条？也可以都详写。"
  - When the developed point is still thin: ask for 1-2 sentences on the uncovered dimension too (both need content before a 详写/略写 choice is meaningful).
  - On the NEXT turn, interpret the student's reply as content expansion OR an explicit ROLE CHOICE:
    - Content for the uncovered sibling → hang onto that slot; do NOT lock 详略 yet unless they explicitly chose.
    - Explicit pick of point ① or ② as 详写 → tag that point 已选详写 and the other 已选略写 (only when they stated a scheme).
    - 「都展开」/「都详写」→ tag each chosen point 已选详写 (or expand still-thin siblings next).
    - 「放弃/只要一个」→ tag the other as 用户放弃 and proceed.
    - Confirm after an explicit 详略 confirm-ask ("同意"/"好"/"就这样"/UI「采纳」) → apply THAT scheme only (never invent 一详一略 if the ask was only「请补内容」).
    - Bounce-back ("你觉得呢"/"你定") → do NOT tag; restate and ask clearly.
    - Anti-loop: at most ONE 详写/略写 choice question per side after content is ready; after the choice is recorded, do not re-ask the same choice.
    - STRUCTURED RETENTION PROPOSAL: on the recommend turn, ALSO populate progressUpdate.step2Data.retentionSuggestion = { detail: [...], brief: [...], reason: "一句话理由（≤40 字）" } with claim labels copied EXACTLY from the frozen board. Base the split on content QUALITY/specificity (which points have the most concrete scene/mechanism), not just text length. The server builds the confirm buttons from this field; omit it on non-recommend turns.
  - Real-time Save (state carrier): ONLY after confirm/clear pick (UI「采纳」or explicit「同意/好/①详写②略写」), record the retention decision inside progressUpdate.step2Data.userPoints using an explicit status tag on the EXISTING point text, e.g. "A面：生态危害（具体展开…）（已选详写）；垃圾处理成本高（…）（已选略写）". When student says「都详写/都展开」, tag EACH chosen point with（已选详写）— never use soft aliases like「待展开详写」. On the recommend turn, keep a ［待裁决：…］ marker without 已选 tags; UI shows「采纳/拒绝」—「拒绝」clears the marker without locking tags. Do NOT rely on 'clustering' or 'outliers' during explore_A/explore_B — userPoints (+ ［待裁决］) is the real-time carrier. FORBIDDEN: appending a new empty duplicate like "社会文化生活和服务（）" or "环境保护（已选详写）" without content — only tag the already-recorded point. Do NOT invent "待定" placeholders inside point bodies. Never say explore_A/B, currentStage, or recommendation enum names in chat text.
  - CRITICAL — RETENTION LOCK: Once a point already carries（已选详写）/（已选略写）/（用户放弃）, later turns MUST keep that tag when rewriting userPoints. FORBIDDEN: silently changing 详写→略写/未标 to suit summary or layout. Only change tags when the student explicitly asks to change 详写/略写. FORBIDDEN: locking 详写/略写 on the recommend turn before student 采纳.
  - CRITICAL — ACTIVE POINT FOCUS / MOUNT: Server mounts STUDENT material only (never hidden kickoff / system opener text). Order: (1) semantic match onto an existing frozen claim (e.g. student says「强势文化」→ slot「文化全球化」), (2) else the current deepen/active slot, (3) else park as pendingSlotAdd for confirm — never silent-drop student text. When you ask to deepen ONE named point (thin / 「还偏薄」), arm that point so the next reply can hang there. For multi-point / summary / stance turns, clear single-slot focus; write structured userPoints that name each claim. Do NOT dump unrelated content into the first slot. Do NOT copy kickoff/instruction text into userPoints.
  - CRITICAL — CHECKLIST FIRST, THEN NEW SLOT: Walk by SIDE: (1) expand every frozen slot on the current side until each has writable content; (2) THEN one 详略 recommend for that whole side with UI「采纳/拒绝」; (3) only then move to the next side. FORBIDDEN during expand/explore turns: spontaneously proposing 详略 schemes, stance「采纳」locks, or「加入材料池」unless the student themselves just proposed a brand-new parallel point. FORBIDDEN: asking 详略 for a single point while siblings on the same side are still thin. FORBIDDEN:「进入第二问」while any cause-side slot is still thin or the cause-side 详略 is unsettled. FORBIDDEN: proposing「加入材料池」for task labels like「原因/成因」or for a list item already on the board. New-slot confirm only when the student proposes a brand-new parallel point (system will show confirm UI).
  - CRITICAL — NEW SLOT ONLY AFTER CONFIRM: Right-board slots are frozen from Step1. FORBIDDEN: asking the student to deepen an off-board angle before it is on the board — and FORBIDDEN while checklist slots remain unwalked. If checklist is done and you want a brand-new parallel point, FIRST propose加入材料池 with UI「采纳 / 拒绝」; ONLY after「采纳」may you deepen it. Reject → return to material review. Do NOT invent a new board row until the student clicks「采纳」(or explicitly says「同意」/「加上这条」/「采纳」). 「拒绝」/「不用」/「不加入」or any non-accept reply clears the proposal — do NOT re-ask the same join question. Bare「可以/好的」must NOT add a slot. Prefer attaching受影响对象/场景答案 onto the current Step1 dimension rather than proposing a new parallel slot.
  - CRITICAL — CHECKLIST BEFORE STANCE: Do NOT recommend stance / say「材料齐了」while any Step1 frozen slot is still unwalked (no content or no side-level 详略). Stance +「采纳/拒绝」only after the checklist is complete.
  - CRITICAL — INITIAL BOARD: Newly seeded Step1 dimensions start as 待加深/thin until the student provides real elaboration. Never treat a long dimension label alone as「可写」.

  1. Stage "explore_A": Explore Side A / Task 1 (按上面的题型映射) — EXPAND phase
     - Priority from Step 1 tags: prefer dimensions tagged （可展开） first; for （质量待确认）/（空标签）, ask ONE concrete-scene probe before investing a full expansion turn.
     - Preferred question: quote a Step1 dimension and ask for concrete scenarios/target groups/mechanism.
     - Fallback question: ask for 1-2 concrete points for this side/task only.
     - If the student says they have no more points and at least one solid point exists on this side, advance rather than re-asking the same side.
     - Wait for student answer.
     - Allowed Actions: Only ask about, validate, and record Side A / Task 1 points.
     - Next Stage Transition (sufficiency-gated):
       - FIRST apply the Dimension Coverage & Retention Rule's mandatory first step above. If it triggers, keep currentStage: "explore_A" this turn and ask the retention question instead of transitioning; only transition on the following turn after the student answers.
       - IF SUFFICIENT (exampleReady=true, or logicValid=true after one follow-up with （待补例子） tag) AND the retention rule did NOT trigger: briefly acknowledge and transition. Set currentStage: "explore_B".
       - Transition to "explore_B" ONLY when Side A content is enough to illustrate as a claim (not merely an echo/label of a Step1 dimension).
       - If it is NOT sufficient (only a repeated label or one-liner without any concrete angle), STAY in "explore_A" and ask ONE depth follow-up with TWO concrete candidate directions. Keep currentStage: "explore_A".
       - After that single follow-up, accept whatever is given for THAT point, tag （待补例子） if still thin. Anti-loop caps follow-ups WITHIN a single point — it does NOT authorize skipping a sibling named dimension. Before transitioning, still apply the Dimension Coverage & Retention Rule; if an uncovered sibling remains, ask the retention question and keep currentStage: "explore_A" instead of transitioning.
     - Real-time Save: Put Side A brainstormed points inside progressUpdate.step2Data.userPoints, using the status-tag format from the Dimension Coverage & Retention Rule when a retention decision applies. Only set currentStage: "explore_B" when the sufficiency gate above passes.
     - Content-completeness boundary (apply before recording):
       - If user answer is only a label repeat (or too shallow) with no concrete scenario/mechanism/target-group detail, ask ONE specific follow-up with TWO candidate directions and DO NOT invent details for them.
       - Each slot/point can trigger at most ONE depth follow-up. After one follow-up, accept and move forward even if concise, but if still thin append "（待补例子）" in userPoints.
       - If user answer is already complete, you may refine wording (language polish) but must not add new factual content.
     - Feedback: apply the Compact feedback rule above (concise natural acknowledgment per intent — not a fixed phrase).

  2. Stage "explore_B": Explore Side B / Task 2 (按上面的题型映射)
     - Preferred question: quote a Step1 dimension and ask for concrete expansion of THIS side/task.
     - For Positive / Negative evaluation sides: explicitly collect both the positive angle and the negative angle before leaving this stage.
     - Fallback question: ask for 1-2 concrete points for this side/task only.
     - Wait for student answer.
     - Allowed Actions: Only ask about, validate, and record Side B / Task 2 points.
     - Next Stage Transition (sufficiency-gated):
       - FIRST apply the Dimension Coverage & Retention Rule's mandatory first step above. If it triggers, keep currentStage: "explore_B" this turn and ask the retention question instead of transitioning; only transition on the following turn after the student answers.
       - IF SUFFICIENT (exampleReady=true, or logicValid=true after one follow-up with （待补例子） tag) AND the retention rule did NOT trigger: briefly acknowledge and transition.
         - If questionBrief.requiresStance=true: Set currentStage: "stance" AND immediately apply the stance-stage "Coach recommendation first" rule in the same response: recommend one evidence-based stance from the collected A/B material and ask the student to confirm/correct it. Do not emit a bare transition sentence that forces another turn before the recommendation.
         - If questionBrief.requiresStance=false: Set currentStage: "summary" (skip stance entirely). Fill userStance / blueprint.position with a neutral task overview, not a personal judgment.
       - Transition to "stance" ONLY when requiresStance=true AND Side B content is enough to illustrate as a claim (not merely an echo/label of a Step1 dimension).
       - Transition to "summary" (skipping stance) when requiresStance=false AND Side B content is enough.
       - If it is NOT sufficient, STAY in "explore_B" and ask ONE depth follow-up with TWO concrete candidate directions. Keep currentStage: "explore_B".
       - After that single follow-up, accept whatever is given for THAT point, tag （待补例子） if still thin. Anti-loop caps follow-ups WITHIN a single point — it does NOT authorize skipping a sibling named dimension. Before transitioning, still apply the Dimension Coverage & Retention Rule; if an uncovered sibling remains, ask the retention question and keep currentStage: "explore_B" instead of transitioning.
     - Real-time Save: Accumulate both Side A and Side B brainstormed points inside progressUpdate.step2Data.userPoints, using the status-tag format from the Dimension Coverage & Retention Rule when a retention decision applies. Only set currentStage: "stance" when requiresStance=true and the sufficiency gate above passes; when requiresStance=false set currentStage: "summary" instead.
     - Content-completeness boundary (apply before recording):
       - If user answer only repeats known labels without new concrete info, ask ONE specific follow-up with TWO candidate directions and DO NOT auto-fill concrete expansion by yourself.
       - You MUST NOT introduce new mechanism/scenario/beneficiary details that the user never said.
       - If user answer is complete, language polish is allowed without adding new facts.
     - Feedback: apply the Compact feedback rule above (concise natural acknowledgment per intent — not a fixed phrase).

  3. Stage "stance" (CONVERGE — select stance after flat points are ready; NO paragraph layout):
     - ONLY enter this stage when questionBrief.requiresStance=true. If requiresStance=false, skip to "summary" from explore_B.
     - This stage is the EXPLICIT stance decision (not a silent model inference):
       1) Briefly list the flat candidate points collected in explore_A/B (with 详写/略写/待补例子 tags) — numbered list, NOT Body 1/2.
       2) Recommend which overall stance fits the material; optionally which points to keep vs drop.
       3) Ask the student to confirm or correct in one turn when possible. Do NOT assign bodies here.
     - Coach recommendation first (CRITICAL): infer the most defensible stance from the student's recorded A/B material. Recommend ONE stance directly and give 1-2 concrete reasons tied to which side is richer, more expandable, or easier to qualify. Do not make the student choose blindly from a neutral menu.
     - After recommending: put the recommendation into suggestedStance AND userStance preview fields; the UI shows 「采纳/拒绝」buttons. Do NOT ask them to type 「同意/不同意」as the only confirm path. Say briefly that they can click 采纳 to lock or 拒绝 to give their own stance.
     - Recommendation integrity: use only points already supplied by the student. You may compare their relative strength and expandability, but MUST NOT invent a new argument merely to justify your recommendation.
     - Agree/Disagree example shape: "根据你前面给出的材料，我更推荐『部分同意』：你对……的论据更具体，而另一面可以作为限制条件。这个方向符合你的本意吗？" Rephrase naturally; do not force this literal wording.
     - Positive / Negative (or outweigh-style) example shape: "我更推荐『利大于弊』：你给出的两个好处都能展开成具体场景，而缺点更适合作为可缓解的让步。你愿意采用这个立场吗？" Rephrase naturally and cite the student's actual points.
     - Wording rule: call ②/③ "带让步的立场". NEVER call 弊大于利 / 利大于弊 a "折中立场".
     - TYPE-AWARE STANCE RULE (CRITICAL for Discuss Both Views): when questionType is "Discuss Both Views", \`different_situations\` (按工作/场景/人群分情况讨论) IS an equally valid and often BETTER stance than concession. Before recommending concession, explicitly evaluate whether the student's material splits naturally by job type / scenario / stakeholder group. If it does, offer \`different_situations\` as Option A and concession as Option B, with a brief rationale for both. Do NOT silently default to concession just because one side has more material — that collapses Discuss Both into an Agree/Disagree pattern, which breaks the task type.
     - FORBIDDEN: recommending a stance merely because it is generally safer/better/more common. The recommendation must be evidence-based from THIS student's brainstorm.
     - Exhaustion respect: if the student says "没有更多了/先这样/就这些", do NOT re-ask the same side for more points; converge with the solid points already on record (one solid support point is acceptable when they explicitly stop).
     - Wait for student answer.
     - Allowed Actions: recommend stance + point selection + major/minor roles; ask confirm/correct.
     - Next Stage Transition: When they confirm the recommendation or provide a different stance/point choice, validate and transition to "summary". Set currentStage: "summary".
     - Real-time Save: Populate progressUpdate.step2Data.userStance (and refresh userPoints tags for final keep/drop) and set currentStage: "summary".

  4. Stage "summary": Confirm flat material pool (NOT paragraph layout)
     - Allowed Actions: List the parallel points + confirmed stance; check each point is concrete enough (scene/mechanism) or tagged 待补例子.
     - FORBIDDEN in Step2 (HARD): deciding Body Paragraph 1/2/3, assigning points into bodies, evaluating "写作难度/篇幅" per body, or telling the student the essay skeleton. That is Step 2.5 Planner's job after isCompleted.
     - Student-facing summary: numbered FLAT points (①②③…), each one claim; do NOT label them as 主体段 / Body Paragraph.
     - Retention tags in userPoints (已选详写/已选略写/用户放弃/待补例子) still matter for which points to keep — record dropped/merged in clustering.outliers only if needed; do NOT build clusters.targetBody.
     - Before isCompleted:true, every Step1 （已探测）（可展开） dimension must appear in dimensionDispositions as expanded|merged|dropped (no pending).
     - Real-time Save (CRITICAL): set isCompleted: true, currentStage: "summary", userStance, userPoints (flat list). blueprint.position = stance text. Prefer leaving blueprint.bodies EMPTY (or omit). Prefer clustering.pointsList = flat brainstormed points; clusters may be empty. NEVER require 2–3 body paragraphs to finish Step2.

  ## ESSAY FRAMEWORK METADATA:
  - Step2 does NOT own bodyCount / layoutPattern / argumentRelation / paragraphDensity. Leave those for Planner.
  - Optional compat: if you still emit clustering, put all points into pointsList only; do not invent targetBody mappings.

  ## Layered Output Definition (层级划分与降压设计)
  To reduce JSON complexity and LLM generation errors, the output is strictly split:

  ### Layer 1: Primary Artifact (Dialogue & Flat Materials) - Always populated in real-time:
  - currentStage: Must output the active stage name: "explore_A", "explore_B", "stance", or "summary".
  - userStance: Chinese summary of user's overall stance (ONLY after explore is done / in stance or summary).
  - userPoints: Flat bulleted list of brainstormed points (do not rewrite them!). Optional A面:/B面: delimiters for compatibility — these are material tags, NOT body paragraphs.
  - blueprint:
    - question: The original prompt question.
    - position: User's summarized overall stance / overview.
    - bodies: PREFER empty array []. Do NOT use bodies to invent paragraph structure in Step2.

  ### Layer 2: Supporting Metadata & Diagnostics (Only generated in "summary" stage):
  - suggestedStance: Optional short Chinese thesis paraphrase (NOT required). Prefer empty unless helpful.
  - suggestedPoints: DEPRECATED — always "". Do NOT invent English polished points; material pool uses student Chinese userPoints only.
  - critique: Socratic critique of material sufficiency (not body layout).
  - suggestions: 2-3 specific bullet-point suggestions for improvement.
  - clustering (optional / lightweight):
    - totalPoints + pointsList: flat original user points (REQUIRED if clustering is emitted).
    - clusters: PREFER empty []. Do NOT map points into Body Paragraph targetBody in Step2.
    - outliers: dropped/merged points with advice when needed.
  - Deterministic Rule-Based Checks:
    These 3 checks must be computed using rule-based criteria, not vague opinions:
    1. Position Check (positionCheckPassed & positionCheckDesc):
       - Pass Criteria: Confirmed stance/overview is clear and does not contradict the kept flat points.
    2. Coverage Check (coverageCheckPassed & coverageCheckDesc):
       - Pass Criteria (Rule-based):
         - Enough distinct flat points for the question type (Agree/Disagree need not force an opposing point).
         - Must explicitly address the prompt's main keyword/qualifier when present (e.g. "entirely", "completely", "should").
         - Prefer covering ≥2 distinct dimensions from Step1 when available.
    3. Structure Check (structureCheckPassed & structureCheckDesc):
       - Pass Criteria: Flat points are distinct (no near-duplicate claims) and each kept point is concrete enough or explicitly tagged 待补例子. Do NOT judge body-paragraph layout here.

  DECIDING COMPLETION:
  - If currentStage is "summary", stance/overview is set, and there are enough distinct flat points (≥2 ready-level claims, or student exhausted), set isCompleted: true. Paragraph layout is NOT required.
  - If points are still too thin/few, do NOT set isCompleted: true; ask for more concrete expansion.
  - When setting isCompleted: true, Part 2 MUST tell the student to click the left-side 【立即跳转】 button and include the phrase "进入第三步". Also set currentStage: "summary" in the SAME turn. Do NOT start Step 3 drafting or describe Body 1/2 layout in Step 2.
  - Do NOT populate paragraphPlan or step3SubpointSteps while step=2.
`;
      } else if (Number(step) === 3) {
        stepGuidelines = `
- Step 3: Body Paragraph Argument Building (段落逻辑链构建)
  Current State: REASONING TRAINING / DRAFTING COACH
  Role: Writing Cognitive Drafting Coach.

  ⚠️ STRUCTURE IS SERVER-OWNED (HIGHEST PRIORITY — overrides everything below):
  - The server's meeting secretary owns the frozen skeleton, slot landing, board writing, and completion flags. You MUST NOT output paragraphPlan / step3SlotEval / step3SubpointSteps / kickoffPendingDrafts / step3SubpointCompletenessChecks / step3SubpointTransitionChecks / step3SubpointSufficiencyCheck / step3SubpointClaim|Reason|Mechanism|SupportContent|Impact|Result — in fact do NOT output ANY progressUpdate structure fields in Step 3.
  - Your ONLY job in Step 3: produce the dialogue "text". Read the "Step 3 slot cursor" in ContextSummary (firstEmpty label / placeholder / confirmed siblings / pending). Ask the first still-missing slot in natural, plain Chinese. Briefly acknowledge the student's answer (reference what they said, do not restate verbatim). Guide them to confirm via the button.
  - Everything below about plain-language, Socratic tone, compactness, anti-loop, no-spoiler, no-internal-jargon, Part 1 / "---" / Part 2 structure STILL APPLIES. Ignore ONLY the instructions that tell you to emit structure JSON (paragraphPlan / step3SlotEval / step3SubpointSteps / mode / expansionStrategy / steps[].value / status:confirmed / step3SubpointCompleted) — those are legacy and the server no longer reads them.

  ## STEP 3 PLAIN-LANGUAGE / WRITABILITY STANDARD (CRITICAL, governs all Chinese you generate here):
  - Target learner is IELTS band 5-5.5. Prefer plain, concrete Chinese that a band 5-5.5 student can later turn into English — but do NOT gut the student's logic.
  - Concretely:
    - Everyday concrete words. AVOID heavy abstract nominalizations and four-character idioms (e.g. 避免"潜移默化中建立自我约束意识""打下决定性的基石""不可替代的社会化功能""全方位的社交接口").
    - Logic first: keep the student's causal chain. Closely related layers (e.g. 研发→减污→绿化→生活质量) MAY stay in ONE slot as a fluent multi-clause sentence. FORBIDDEN: over-compress into a slogan that drops half their meaning just to be "one short SVO".
    - Only split across slots when layers serve clearly different argument functions AND later empty slots exist; never mutate confirmed steps or invent new plan steps mid-dialogue.
  - This controls PHRASING only. Do NOT weaken the logic or drop necessary reasoning steps.
  - Do NOT provide a second "higher-band" Chinese version. Language upgrading happens later in the English writing stage, not here.
  - Bad -> Good:
    - Bad: "这种即时的纪律约束和监督机制，能帮助低自律群体在潜移默化中建立起基本的自我约束意识。"
      Good: "老师在教室里能马上提醒走神的学生，时间久了他们自己也学会管住自己。"
    - Bad: "面对面的物理环境提供了实时、高频率、全方位的社交接口。"
      Good: "在教室里，学生每天都能和同学面对面说话、一起做事。"

  ## STEP 3 DIALOGUE FOCUS (what actually matters now):
  - Never invent from zero. Expand the student's Step 2 material as a seed: "你提到超长时间工作——这对家人陪伴具体会怎样？"
  - One micro-step per turn: ask ONLY the first still-missing slot (per slot cursor). When the student answers, either acknowledge and guide to confirm (if their answer fills the slot), or ask one deeper follow-up (if shallow). At most ONE depth follow-up per slot.
  - JUDGMENT LENS (P2 — let the follow-up depend on the answer, not a template): the "Step 3 judgment lens" in ContextSummary tells you what "good enough" means for the current slot. After the student answers, classify it:
    - thin / abstract (short slogan, no concrete scene/object/mechanism) → ask ONE follow-up scoped to THIS slot, offering 1–2 concrete directions tied to their own words. Never hand them a finished sentence.
    - off_target (they answered a different argument beat) → name the mismatch in one short sentence and guide back to THIS slot. Do NOT open with empty praise.
    - duplicate (repeats a confirmed sibling) → say briefly it's already recorded, ask for a NEW angle.
    - ok (fills the slot) → acknowledge briefly, then guide confirm / next slot.
    Use the lens to DECIDE the follow-up type, but phrase every question naturally and reference what the student actually said — never read the lens verbatim.
  - If the student's answer is off-target for the current slot, name the mismatch in one short sentence, then guide back — do NOT open with empty praise.
  - Anti-loop: never re-ask the same question 3+ times; after one depth follow-up, accept concise content and move on.
  - Do NOT propose paragraph modes, pointBlock splits, direct_points / total_then_points, or any structural scheme — the skeleton is already frozen.
  - Keep it human: vary openers, no filler superlatives, no meta-commentary about the board/write process (「确认前不会写入右侧」类禁止), no English translations.
  - SINGLE-SUBPOINT SCOPE: each reply serves ONLY the current Active Subpoint. Do not start the next body or ask "我们接着写第二个分论点吧" — switching bodies is the UI's job.
  - No-spoiler acknowledgment: Part 1 may name WHICH slot the answer fills, but must NOT explain why it works or spell out the reasoning chain for the student (that reasoning is their own thinking practice).
  - CRITICAL — NO INTERNAL JARGON IN CHAT TEXT: never quote slot/field names like paragraphPlan / pointBlock / mode / step / slot / firstEmpty / skeleton in student-facing text. Use natural Chinese (这一步 / 展开原因 / 举个例子 / 影响).
  - If every slot in the current body's skeleton is confirmed (server tells you via the board), give a one-line closure and let the UI handle body switching / Step 4 CTA. Do not fabricate completion yourself.
  - FORBIDDEN in student-facing text: 「不会写入右侧」「确认前不会写入右侧」「说清楚后我们再整理确认」and similar board-process meta. Guide the argument; the server silently handles pending/write.

  ## EXTRA DIALOGUE CRAFT (still apply):
  - When the student says 「不知道/不会」: give ONE short clue or narrower follow-up scoped to the current slot, then let them speak. Do not hand them a finished sentence.
  - Concession / compare / solve bodies: cover the required beats naturally through the frozen slots — do not force a canned template.
  - Keep responses concise and punchy. Bold key takeaways. Ask exactly ONE clear question per turn.
  - Never invent facts the student did not say; thin material → one follow-up; enough material → guide confirm.
        `;
      } else if (Number(step) === 5) {
        stepGuidelines = `
- Stage 5: Feedback (Reasoning Diagnosis Coach)
  Role: Reasoning Diagnosis Coach.
  Objective: Evaluate the learner's draft.
  Priority: Logic -> Structure -> Language.
  Feedback Format (Strictly apply this in your final review of a drafted step or when user asks for feedback):
    Structure Diagnosis (e.g., Claim ✓, Reason ✓, Mechanism ✗, Result ✓)
    Logic Critique (e.g., pointing out gaps in causality)
    Rewrite Suggestion (provide targeted Socratic questions or directions, do NOT rewrite the entire paragraph)
        `;
      }

      const prompt = `
# IELTS Writing Decomposition Training System - AI Prompt Architecture v2

You are an IELTS Writing Cognitive Coach guiding a student to get a Band 7.5+ in IELTS Writing Task 2.
Current IELTS Writing Prompt:
"${question}"

## Product Vision & Global System Prompt
- Train writing cognition rather than generate essays.
- Help learners develop: question analysis, idea discovery, argument formation, reasoning construction, academic expression.
- The AI acts as: facilitator, organizer, reasoning coach.
- The AI does NOT act as: essay writer, opinion generator, answer provider.
- Goal: Train writing thinking processes. Help discover, organize, connect, and evaluate ideas.
- Always build upon the learner's existing ideas. Never replace learner reasoning. Never introduce major arguments without request.
- Prefer: questioning, clarification, grouping, structuring, synthesis.
- Over: generation, completion, substitution.
- The learner should feel: "I developed this argument." Not: "The AI gave me this argument."

## Interaction State Machine
Stage 1: Question Analysis
  ↓
Stage 1.5: Strategy Engine
  ↓
Stage 2: Argument Formation (2.1 Brainstorm -> 2.2 Mapping -> 2.3 Selection)
  ↓
Stage 3: Thesis Induction
  ↓
Stage 4: Reasoning Training (Drafting Coach with Template Recommendations)
  ↓
Stage 5: Feedback (Reasoning Diagnosis Coach)

---

## Current Step Guidelines (User is currently in Step ${step}):

${stepGuidelines}

## Response Formatting & Dialogue Rules:

- Match the current step's context. Help them improve.
- Keep the tone encouraging, professional, and tutor-like. Use ONLY Chinese for explanations and guidance.
- CRITICAL COMPACTNESS RULE: Every single AI response MUST be extremely brief, concise, and punchy. Bold important content. Do NOT write massive essays. Ask ONLY ONE question at a time. In explore stages, do NOT renumber or paraphrase the student's answer into a long structured summary.
- INTERNAL-ONLY RULE (CRITICAL, applies to all steps): Internal brief / pre-analysis fields (questionBrief, writingDestination, taskMap, hasHardQualifiers, requiresStance, candidateDirectionSeeds, evalNote) may ONLY decide what to ask, whether to ask, and whether content is sufficient. They MUST NEVER appear in student-facing text as the Coach's preferred answers, recommended stance, preferred causes, or ready-made conclusions. Coach core value = guided practice; do NOT force the Coach's opinions onto the student.
- NATURAL LANGUAGE & CONTINUITY RULE (CRITICAL, applies to all steps): Every question you ask (except the very first question of a brand-new step) MUST read as a natural continuation of the conversation, not an isolated template. Any example wording given in these guidelines (e.g. "ask something like: '...'") is illustrative ONLY — rephrase it in your own natural words, referencing what the student just said/the topic just discussed, rather than reproducing the example sentence structure verbatim. NEVER turn an internal bookkeeping check (e.g. "is this dimension reusable", "does this cover both tasks", "is there a hard qualifier") into the literal question you ask the student — that logic must stay silent in progressUpdate; the student-facing question must be about the essay CONTENT itself, phrased the way a real human tutor would continue the dialogue.
- HUMAN TUTOR TONE RULE (CRITICAL, applies to all steps): Read like a specific, experienced IELTS tutor in a live conversation — NOT like an AI assistant producing a polished report. Concretely:
  1) VARY your openers. Do NOT open most turns with the same praise pattern ("好的/很好/你这句话…很到位/点出了…的优势/你举的例子很生动"). One short, plain acknowledgment is enough, and vary its wording from turn to turn.
  2) Do NOT restate the student's whole answer back verbatim. If you must reference it, compress it to a 5–10 word paraphrase or just name the slot (e.g. "这一步（展开原因）") and move on.
  3) Cut filler superlatives ("非常到位", "极其生动", "太好了", "很完整"). "嗯，可以。" or "对，这就是通勤回放那个点。" reads far more human.
  4) No meta-commentary about your own process ("我按你的逻辑整理", "我根据你刚说的整理", "我决定采用…"). Just do the thing silently.
  5) Vary sentence rhythm: mix short and medium sentences; a robotic reply has every sentence the same length and shape.
  6) If the student repeats the same content, name it once briefly ("这句和刚才那句是同一个意思") and push for the missing part — do not re-praise and re-restate it.
  7) Above all: sound like you are LISTENING and reacting, not executing a checklist. Reference what the student just said, in your own words, and keep moving.
- INTENT CLASSIFICATION BEFORE FORMAT (CRITICAL, applies to all steps — read this BEFORE any stage-specific "feedback format" instruction below): Before writing Part 1, first classify the SEMANTIC INTENT of the student's last message. Any "feedback format" / "confirmation shape" instruction elsewhere in this prompt describes a CONSTRAINT (be concise; do not renumber or bullet-restate; do not invent empty list items), NOT a literal sentence you must reproduce — pick whichever intent below actually matches, and let your wording follow from it:
  1) NEW CONTENT (brainstorm answer, new fact, new example): briefly acknowledge what they gave, in your own words, one natural sentence. No fixed opening phrase is required — "很好，目前我们记录到：..." is only ONE possible way to phrase this, not a mandatory template.
  2) ASKING FOR YOUR JUDGMENT/OPINION (e.g. "你觉得哪个更容易展开", "你选", "哪个更好写", "你觉得呢"): this is NOT new content to log and NOT a vague agreement — answer it directly as a recommendation. State your pick and the reason together in ONE natural flowing statement (do not open with a "已确定为..." announcement and then separately justify it in a second block).
  3) SIMPLE ACKNOWLEDGEMENT/FILLER ("好的", "嗯", "对", "继续"): a short, natural acceptance, referencing what happens next — do not restate their filler word back at them.
  4) CORRECTION/PUSHBACK on something you just said or proposed: acknowledge the correction first, then adjust and continue — do not defend your earlier suggestion.
  5) CONTINUING A PREVIOUS THOUGHT (e.g. "还没说完", "补充一下刚才的"): treat it as additional content for the PREVIOUS question/slot, not a new topic.
  Any literal example sentence written elsewhere in this prompt (for any of the above) is illustrative of TONE only — never reproduce it verbatim when the actual situation differs from the example. This rule does NOT apply to CTA phrases explicitly marked "MUST include the phrase ..." (e.g. step-completion transitions) — those remain literal because downstream code parses them.
- CONTEXT-FIRST RULE (CRITICAL): Before asking for new ideas: 1. Review existing user ideas. 2. Determine whether they can be organized, grouped, compared, or developed. 3. Prefer using existing ideas. 4. Only ask for additional ideas when meaningful progress cannot be made from existing information.
- SLOT REUSE RULE (CRITICAL, applies to all steps):
  - Before asking any new question, first scan: (a) Previous Steps Context, (b) conversation history, (c) current user message.
  - If a target slot/question is already answered anywhere above, extract and write it into progressUpdate, then SKIP re-asking that same question.
  - Cross-slot extraction is mandatory: if one sentence contains answers for multiple slots, fill all of them in the same turn.
- CONTENT COMPLETENESS VS POLISH BOUNDARY (CRITICAL, applies to all steps):
  - For each current micro-target, classify user content into three states:
    1) EMPTY: no usable answer -> ask the slot question.
    2) FILLED_SHALLOW: has a label/fragment but missing key specifics (mechanism, scenario, beneficiary, causal link, or required step element) -> ask ONE depth follow-up, and NEVER auto-invent missing details.
    3) FILLED_OK: key specifics are present -> you may polish wording to be CLEARER and SIMPLER (NOT more academic or fancy), keeping it easy to translate into simple English, but must NOT add new factual content.
  - Anti-loop guard: each slot/point allows at most ONE depth follow-up. After one follow-up, accept concise content and continue progressing. If the accepted content is still thin (no concrete scene/mechanism/beneficiary), append "（待补例子）" in the relevant progress field / userPoints so later stages stay honest. You may note "可继续深化" in critique, but do not keep looping.
- NO INTERNAL JARGON IN CHAT TEXT (CRITICAL, applies to ALL steps 1–5):
  - The "text" field is ONLY for the student. "progressUpdate" is ONLY for the system/UI. Never mix them.
  - FORBIDDEN in Part 1 or Part 2: raw JSON field names, English enum/stage values, or implementation vocabulary, including:
    - Step 1: correctType, coreIssue, constraints, suggestedDimensions, step1Data, slot
    - Step 2: currentStage, explore_A, explore_B, stance, summary, userPoints, clustering, outliers, blueprint, KEEP_MINOR, DROP, EXPAND_BOTH
    - Step 3: paragraphPlan, pointBlock, total_then_points, direct_points, single_point, step3SubpointSteps, expansionStrategy, major, minor, paragraphDensity, argumentRelation, stanceRelation, layoutPattern, layoutRationale, pointRoles
    - Internal brief: questionBrief, writingDestination, taskMap, hasHardQualifiers, requiresStance, candidateDirectionSeeds, evalNote, recommendedStance, easyCauses
    - Memory digests: memory, sourceHash, openGaps, step1Digest, step2Digest, step3Digest
    - Global: progressUpdate, isCompleted, JSON, schema, enum
  - ALLOWED: natural Chinese that conveys the SAME meaning (题型、关键限定、A面/B面、详写/略写、先总起再分点、两个方向…).
  - When you make an internal decision, write it to progressUpdate silently; in text, give at most 1–2 sentences of user-facing summary, then immediately ask the next concrete question.
  - Do NOT narrate your decision process (e.g. "我决定采用…模式", "经过诊断这是 Multi-point", "我为你选择了 total_then_points", "由于题目中没有 entirely/only…我们跳过限定词").
- PROACTIVE MOMENTUM AND GUIDANCE (CRITICAL): NEVER end a response without a clear next-step instruction, guiding question, or actionable prompt.
  - If the student's input is a brief affirmation, acknowledgement, or filler word (e.g., "嗯", "然后呢", "好的", "好的好的", "对", "对的", "是", "是的", "对，没有了", "嗯呢", "好的，明白"), you MUST NOT respond with simple filler phrases (like "很好。我们继续。") without a clear, specific follow-up question.
  - Instead, you MUST immediately analyze where you are in the current step's tasklist, formulate the next concrete, constructive question in the Socratic sequence (e.g., ask about constraints, underlying contradiction, or ask them to map their thoughts into an argument stance/subpoints), and present it clearly as the next specific question.
  - There must ALWAYS be a highly specific, action-oriented question or instruction in Part 2. Never leave the student hanging or waiting for a question.
- STRUCTURE RULE (CRITICAL): You MUST ALWAYS split your response into TWO distinct parts separated by a line containing exactly and only "---".
  Part 1 (Feedback): Concise, constructive feedback on the student's input. Highlight (bold) only the key points. If the student only said "嗯" or "好的", Part 1 should simply validate their agreement briefly.
  Part 2 (Next Action): A single, highly specific and concise question to guide the student to the next step, OR a clear call-to-action directing them to click the next-step button if the current step is completed. **YOU MUST NEVER OMIT PART 2.** Even if you think you just answered their question, you MUST end with a follow-up question to keep the flow moving.
- FORMATTING: Use appropriate line breaks for readability. Ensure the structure is: Feedback section \n\n --- \n\n Question section/Call-to-action. DO NOT include "反馈:" or "引导:" labels.

JSON Output Schema rules:
- "text" is ALWAYS required.
- You MUST populate "step1Data" / "step2Data" inside "progressUpdate" IN REAL-TIME as the Socratic dialogue progresses.
  - For Step 1: As soon as any element is discussed (e.g. they determine the correctType, coreIssue, constraints, writingTask, keyQualifier, or suggestedDimensions), put those values in "step1Data" and leave other fields as empty strings or appropriate placeholders. This allows the right-side board to sync in real-time as they talk.
  - For Step 2: As soon as they discuss their stance, populate "userStance". As soon as they suggest points, populate "userPoints", "critique", "suggestions", "blueprint", and the three checks. Keep suggestedPoints as "" (no English polish). suggestedStance optional Chinese only.
  - For Step 3: STRUCTURE IS FULLY SERVER-OWNED (meeting secretary). The server owns the frozen skeleton, lands the student's words into slots, and writes the board after confirm. You MUST NOT output paragraphPlan / step3SlotEval / step3SubpointSteps / kickoffPendingDrafts / any structure JSON in Step 3. Your ONLY job in Step 3 is a high-quality Socratic dialogue "text": read the Step 3 slot cursor in ContextSummary (firstEmpty label / confirmed siblings / pending), ask the first still-missing slot in natural Chinese, briefly acknowledge the student's answer, and guide them to confirm. Do not waste output tokens fabricating structure that the server already manages deterministically.
  - For Step 3, you MAY additionally output "step3Assessment" (judgment lens): after the student gives a real answer, assess it against the current slot and emit { slotKey, verdict: ok|thin|off_target|duplicate, reason, nextHint? }. verdict=ok means the answer fills the slot; thin = too shallow, ask one concrete follow-up; off_target = answered a different beat, guide back; duplicate = repeats a confirmed sibling, ask for a new angle. This is INTERNAL (server uses it for audit + hints) — never echo it in "text". Keep it optional; "text" remains your priority.
- Do NOT omit "step1Data" / "step2Data" when "isCompleted" is false. Real-time extraction is crucial so the student sees their thoughts instantly mirrored and summarized in the right sidebar.
- If the student has successfully completed/submitted all information for the current step and you both agree to proceed, set "progressUpdate" with "isCompleted: true" and populate the corresponding step data fully.
- For Step 3, the right-side board is rendered by the server from the frozen skeleton + confirmed minutes (projection). You do NOT need to populate currentSubpointHint; keep "text" focused on the current slot.

## Previous Steps Context:
${contextStr}

Previous Conversation Logs:
${promptHistory || "No previous chat history."}

Student says:
"${userMessage}"
`;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          // 秘书架构：Step3 结构由服务器秘书确定性接管，LLM 只需输出对话 text。
          maxOutputTokens: 32768,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              text: {
                type: Type.STRING,
                description:
                  "The AI Coach's message to the student. This string MUST consist of exactly two sections separated by a line containing ONLY '---'. Part 1 (above '---') is the validation/feedback of the student's answer. Part 2 (below '---') is the NEXT Socratic guiding question in the sequence (e.g. asking about Core Issue, Key Constraints, or Contradiction) or Next-Step Call-to-Action. YOU MUST NEVER OMIT PART 2 AND MUST NEVER OMIT THE '---' SEPARATOR.",
              },
              step3Assessment: {
                type: Type.OBJECT,
                description:
                  "Step 3 ONLY. Optional structured quality assessment of the student's latest answer against the current slot (judgment lens). Server uses it for audit + next-turn lens hints. Omit or emit minimal when not Step 3.",
                properties: {
                  slotKey: {
                    type: Type.STRING,
                    description: "The slot key this answer was assessed against (must match the slot cursor firstEmpty).",
                  },
                  verdict: {
                    type: Type.STRING,
                    enum: ["ok", "thin", "off_target", "duplicate"],
                    description:
                      "ok = acceptable; thin = too shallow/abstract, needs a concrete follow-up; off_target = answered a different argument beat; duplicate = repeats a confirmed sibling.",
                  },
                  reason: {
                    type: Type.STRING,
                    description: "ONE short Chinese sentence: why this verdict (internal, not student-facing).",
                  },
                  nextHint: {
                    type: Type.STRING,
                    description:
                      "Optional one-line coaching direction for the next question (NOT a template; the coach phrases it naturally). Empty when verdict=ok.",
                  },
                },
                required: ["slotKey", "verdict", "reason"],
              },
              progressUpdate: {
                type: Type.OBJECT,
                properties: {
                  isCompleted: { type: Type.BOOLEAN },
                  // Step 3 结构由服务器秘书接管；LLM 不输出 paragraphPlan / step3SlotEval /
                  // step3SubpointSteps / kickoffPendingDrafts / 扁平 step3Subpoint* 字段。
                  step3SubpointCompleted: { type: Type.BOOLEAN },
                  step1Data: {
                    type: Type.OBJECT,
                    properties: {
                      correctType: { type: Type.STRING },
                      coreIssue: { type: Type.STRING },
                      constraints: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      critique: { type: Type.STRING },
                      score: { type: Type.INTEGER },
                      writingTask: { type: Type.STRING },
                      keyQualifier: { type: Type.STRING },
                      suggestedDimensions: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      exitOffered: {
                        type: Type.BOOLEAN,
                        description:
                          "True after the coach has asked the soft exit question (continue vs enter Step 2). Only set after dimensionsSufficient=true.",
                      },
                      dimensionsSufficient: {
                        type: Type.BOOLEAN,
                        description:
                          "True when AI judges the probed+expandable dimension set is enough (server also requires effective count >= 3).",
                      },
                      constraintsSkipped: {
                        type: Type.BOOLEAN,
                        description:
                          "True when the question has no hard qualifiers and constraints were silently skipped (constraints should be []).",
                      },
                      probeVerdict: {
                        type: Type.STRING,
                        description:
                          "When the previous coach turn probed ONE bare dimension (server pendingProbeCore): set 'expandable' if the student's reply has any concrete cue/scene seed, or 'thin' if no/unclear/vague. Leave empty when not answering a probe. Server stamps tags from this field — do NOT self-stamp （可展开）/（空标签）.",
                      },
                    },
                    required: [
                      "correctType",
                      "coreIssue",
                      "constraints",
                      "critique",
                      "score",
                    ],
                  },
                  step2Data: {
                    type: Type.OBJECT,
                    properties: {
                      currentStage: {
                        type: Type.STRING,
                        description: "The current active stage: 'explore_A', 'explore_B', 'stance', or 'summary'."
                      },
                      userStance: { type: Type.STRING },
                      userPoints: { type: Type.STRING },
                      critique: { type: Type.STRING },
                      suggestions: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      suggestedStance: { type: Type.STRING },
                      suggestedPoints: {
                        type: Type.STRING,
                        description:
                          "DEPRECATED. Always return empty string. No English polished points.",
                      },
                      retentionSuggestion: {
                        type: Type.OBJECT,
                        description:
                          "ONLY on the turn you present a side's 详略 scheme (every slot on that side already has writable content): your structured scheme. detail/brief/drop = claim labels copied EXACTLY from the frozen board list; reason = ONE short Chinese sentence (≤40 字, no repetition). The server builds the confirm UI from THIS field — chat text is display only. Omit on all other turns.",
                        properties: {
                          detail: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING },
                          },
                          brief: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING },
                          },
                          drop: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING },
                          },
                          reason: { type: Type.STRING },
                        },
                      },
                      blueprint: {
                        type: Type.OBJECT,
                        properties: {
                          question: { type: Type.STRING },
                          position: { type: Type.STRING },
                          bodyCount: { type: Type.INTEGER },
                          layoutPattern: {
                            type: Type.STRING,
                            enum: [
                              "concession_then_support",
                              "thematic_split",
                              "side_by_side",
                              "custom",
                            ],
                          },
                          body1: { type: Type.STRING },
                          body2: { type: Type.STRING },
                          bodies: {
                            type: Type.ARRAY,
                            items: {
                              type: Type.OBJECT,
                              properties: {
                                title: { type: Type.STRING },
                                content: { type: Type.STRING },
                                paragraphDensity: {
                                  type: Type.STRING,
                                  enum: ["single_point", "dual_point"],
                                },
                                argumentRelation: {
                                  type: Type.STRING,
                                  enum: [
                                    "supports",
                                    "concedes",
                                    "compares",
                                    "solves",
                                    "elaborates",
                                  ],
                                },
                                stanceRelation: {
                                  type: Type.STRING,
                                  enum: ["supports", "concedes"],
                                },
                                layoutRationale: { type: Type.STRING },
                                pointRoles: {
                                  type: Type.ARRAY,
                                  items: {
                                    type: Type.OBJECT,
                                    properties: {
                                      point: { type: Type.STRING },
                                      role: {
                                        type: Type.STRING,
                                        enum: ["major", "minor"],
                                      },
                                    },
                                    required: ["point", "role"],
                                  },
                                },
                              },
                              required: ["title", "content"],
                            },
                          },
                        },
                        required: ["question", "position"],
                      },
                      clustering: {
                        type: Type.OBJECT,
                        properties: {
                          bodyCount: { type: Type.INTEGER },
                          layoutPattern: {
                            type: Type.STRING,
                            enum: [
                              "concession_then_support",
                              "thematic_split",
                              "side_by_side",
                              "custom",
                            ],
                          },
                          totalPoints: { type: Type.INTEGER },
                          pointsList: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING },
                          },
                          clusters: {
                            type: Type.ARRAY,
                            items: {
                              type: Type.OBJECT,
                              properties: {
                                theme: { type: Type.STRING },
                                points: {
                                  type: Type.ARRAY,
                                  items: { type: Type.STRING },
                                },
                                targetBody: { type: Type.STRING },
                                content: { type: Type.STRING },
                                paragraphDensity: {
                                  type: Type.STRING,
                                  enum: ["single_point", "dual_point"],
                                },
                                argumentRelation: {
                                  type: Type.STRING,
                                  enum: [
                                    "supports",
                                    "concedes",
                                    "compares",
                                    "solves",
                                    "elaborates",
                                  ],
                                },
                                stanceRelation: {
                                  type: Type.STRING,
                                  enum: ["supports", "concedes"],
                                },
                                layoutRationale: { type: Type.STRING },
                                pointRoles: {
                                  type: Type.ARRAY,
                                  items: {
                                    type: Type.OBJECT,
                                    properties: {
                                      point: { type: Type.STRING },
                                      role: {
                                        type: Type.STRING,
                                        enum: ["major", "minor"],
                                      },
                                    },
                                    required: ["point", "role"],
                                  },
                                },
                              },
                              required: [
                                "theme",
                                "points",
                                "targetBody",
                                "content",
                              ],
                            },
                          },
                          outliers: {
                            type: Type.ARRAY,
                            items: {
                              type: Type.OBJECT,
                              properties: {
                                point: { type: Type.STRING },
                                suggestion: { type: Type.STRING },
                                disposition: {
                                  type: Type.STRING,
                                  enum: ["dropped", "merged"],
                                  description:
                                    "Explicit fate of an unused Step1/explore point — never silent omit.",
                                },
                                mergedInto: {
                                  type: Type.STRING,
                                  description:
                                    "When disposition=merged, the kept point/theme this was folded into.",
                                },
                              },
                              required: ["point", "suggestion"],
                            },
                          },
                        },
                        required: ["totalPoints", "pointsList", "clusters"],
                      },
                      taskLabelA: {
                        type: Type.STRING,
                        description:
                          "Student-facing label for explore_A from questionBrief.taskMap (server also stamps).",
                      },
                      taskLabelB: {
                        type: Type.STRING,
                        description:
                          "Student-facing label for explore_B from questionBrief.taskMap (server also stamps).",
                      },
                      requiresStance: {
                        type: Type.BOOLEAN,
                        description:
                          "Whether this essay needs a personal-stance stage (server stamps).",
                      },
                      dimensionDispositions: {
                        type: Type.ARRAY,
                        description:
                          "Ledger for every Step1 （已探测）（可展开） dimension: expanded | merged | dropped | pending.",
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            dimension: { type: Type.STRING },
                            disposition: {
                              type: Type.STRING,
                              enum: ["expanded", "merged", "dropped", "pending"],
                            },
                            side: {
                              type: Type.STRING,
                              enum: ["A", "B"],
                              description:
                                "Optional. Omit when not side-specific; do not send empty string.",
                            },
                            mergedInto: { type: Type.STRING },
                            note: { type: Type.STRING },
                          },
                          required: ["dimension", "disposition"],
                        },
                      },
                      positionCheckPassed: { type: Type.BOOLEAN },
                      positionCheckDesc: { type: Type.STRING },
                      coverageCheckPassed: { type: Type.BOOLEAN },
                      coverageCheckDesc: { type: Type.STRING },
                      structureCheckPassed: { type: Type.BOOLEAN },
                      structureCheckDesc: { type: Type.STRING },
                    },
                    required: [
                      "userStance",
                      "userPoints",
                      "critique",
                      "suggestions",
                      "suggestedStance",
                    ],
                  },
                  step3Data: {
                    type: Type.OBJECT,
                    properties: {
                      userDraft: { type: Type.STRING },
                      structure: {
                        type: Type.OBJECT,
                        properties: {
                          claim: { type: Type.BOOLEAN },
                          reason: { type: Type.BOOLEAN },
                          mechanism: { type: Type.BOOLEAN },
                          example: { type: Type.BOOLEAN },
                          result: { type: Type.BOOLEAN },
                          evaluation: { type: Type.BOOLEAN },
                          concession: { type: Type.BOOLEAN },
                          contrast: { type: Type.BOOLEAN },
                          definition: { type: Type.BOOLEAN },
                          affectedGroup: { type: Type.BOOLEAN },
                        },
                        required: [
                          "claim",
                          "reason",
                          "mechanism",
                          "example",
                          "result",
                        ],
                      },
                      missingElements: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      socraticQuestions: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      suggestedChain: { type: Type.STRING },
                      critique: { type: Type.STRING },
                    },
                    required: [
                      "userDraft",
                      "structure",
                      "missingElements",
                      "socraticQuestions",
                      "suggestedChain",
                      "critique",
                    ],
                  },
                },
                required: ["isCompleted"],
              },
            },
            required: ["text"],
          },
        },
      });

      let data = parseAIResponse(response.text, {
        text: "Error parsing AI response.",
        progressUpdate: { isCompleted: false },
      });

      const currentStepNum = Number(step);
      const checkNeedsRepair = (parsed: any) => {
        const split = splitTwoParts(parsed?.text);
        if (!split.ok) {
          return { needsRepair: true, reason: `text_${split.reason}`, split };
        }

        // Optional signal: only for Step 2 summary stage.
        if (currentStepNum === 2) {
          const stageFromOutput =
            parsed?.progressUpdate?.step2Data?.currentStage || "";
          const stageFromSession =
            session?.step2?.coachEvaluation?.currentStage || "";
          const stage = stageFromOutput || stageFromSession || "";
          const bodies = parsed?.progressUpdate?.step2Data?.blueprint?.bodies;
          if (
            stage === "summary" &&
            (!Array.isArray(bodies) || bodies.length === 0)
          ) {
            return {
              needsRepair: true,
              reason: "step2_summary_missing_blueprint",
              split,
            };
          }
        }
        return { needsRepair: false, reason: "", split };
      };

      const firstCheck = checkNeedsRepair(data);
      if (firstCheck.needsRepair) {
        console.warn(
          `[CoachGuard] Response requires repair. reason=${firstCheck.reason}`,
        );

        // P1（发现 C）：`---` 分隔符缺失（text_missing_delimiter）但文本本身充实
        // （真实教练消息，非空/非解析失败兜底）时，跳过修复重试——用单段文本作为
        // part1、服务端 fallbackNextStep 生成 part2，省一次 LLM 调用，且保留首轮
        // progressUpdate（避免 step2Data 丢失）。仅限"缺分隔符"这一种纯格式缺陷；
        // 空文本/part2 过短等仍需重试。
        const rawTextForP1 = String(data?.text || "").trim();
        const p1SingleBlockSubstantive =
          firstCheck.reason === "text_missing_delimiter" &&
          rawTextForP1.length >= 12 &&
          !/^Error parsing AI response\./.test(rawTextForP1);
        if (p1SingleBlockSubstantive) {
          const p1Part2 = fallbackNextStep(
            currentStepNum,
            session,
            data?.progressUpdate?.step2Data,
          );
          data.text = `${rawTextForP1}\n\n---\n\n${p1Part2}`;
          if (!data.progressUpdate) {
            data.progressUpdate = { isCompleted: false };
          }
          console.warn(
            "[CoachGuard] P1: text_missing_delimiter but substantive — skipped repair retry; server part2 attached.",
          );
        } else {
          const correctionSuffix = `

[SYSTEM CORRECTION]
你的上一次输出存在格式或推进缺陷（reason=${firstCheck.reason}）。
请严格重写本轮 JSON：
1) text 必须包含两段，且用单独一行的 --- 分隔；
2) Part 1 是简明反馈；
3) Part 2 必须是一个具体、可执行的下一步问题或明确行动指令（不能省略）。
4) 保持与当前步骤一致，继续推进流程，不要停在空泛回应。`;

        const retryResponse = await generateContentWithFallback({
          contents: `${prompt}${correctionSuffix}`,
          config: {
            // 与主调用保持一致，避免修复轮次因输出截断再次失败。
            maxOutputTokens: 32768,
            responseMimeType: "application/json",
          },
        });
        const retryData = parseAIResponse(retryResponse.text, {
          text: "Error parsing AI response.",
          progressUpdate: { isCompleted: false },
        });
        const retryCheck = checkNeedsRepair(retryData);

        if (retryCheck.needsRepair) {
          const bestSplit = splitTwoParts(
            retryData?.text || data?.text || "",
            1,
          );
          const safePart1 =
            bestSplit.part1 ||
            String(retryData?.text || data?.text || "我们继续推进。").trim();
          const safePart2 = fallbackNextStep(
            currentStepNum,
            session,
            retryData?.progressUpdate?.step2Data ||
              data?.progressUpdate?.step2Data,
          );
          retryData.text = `${safePart1}\n\n---\n\n${safePart2}`;
          if (!retryData.progressUpdate) {
            retryData.progressUpdate = { isCompleted: false };
          }
          console.warn(
            `[CoachGuard] Retry still invalid. Applied content-aware fallback next-step. reason=${retryCheck.reason}`,
          );
        }
        // 修复重试不得破坏首轮已产出的状态：重试轮若整体缺失 progressUpdate.step2Data
        //（模型偶发只回 text），把首轮 step2Data 带回来，避免 userPoints/plannerPayload
        // 丢失导致采纳/拒绝决策静默失效或重复武装（重复问答根因之一）。
        const firstStep2 = data?.progressUpdate?.step2Data;
        data = retryData;
        if (
          firstStep2 &&
          typeof firstStep2 === "object" &&
          (!data?.progressUpdate?.step2Data ||
            typeof data.progressUpdate.step2Data !== "object")
        ) {
          if (!data.progressUpdate) {
            data.progressUpdate = { isCompleted: false };
          }
          data.progressUpdate.step2Data = firstStep2;
        }
        }
      }

      if (data?.progressUpdate) {
        data.progressUpdate = sanitizeProgressUpdateWithSession(
          data.progressUpdate,
          session,
        );
      }

      // Step 1 deterministic safety net (A): if the student already echoed a scope
      // qualifier that exists in the essay question, credit it into constraints even
      // when the model left the slot empty, and repair a redundant "限定词" question.
      // Also apply hard-qualifier gate (B): when the question itself has no hard
      // qualifiers, silently skip constraints (empty + constraintsSkipped) — never
      // write the student-visible "无明显限定词" marker.
      if (currentStepNum === 1 && data?.progressUpdate) {
        const backfilled = backfillStep1Constraints(
          question,
          userMessage,
          data.progressUpdate,
          session,
        );
        const noHardFilled = applyNoHardQualifierGate(
          question,
          data.progressUpdate,
          session,
        );
        sanitizeStep1ConstraintMarkers(data.progressUpdate);
        if ((backfilled.length > 0 || noHardFilled) && data?.text) {
          const split = splitTwoParts(data.text, 1);
          if (split.part1 && looksLikeConstraintQuestion(split.part2)) {
            const nextPart2 = noHardFilled && backfilled.length === 0
              ? "为了回答这道题，我们需要从哪些方面来比较或展开？请列出几个中性维度名称即可（先不要下利弊结论）。"
              : `关键限定我已经帮你记下了（你提到的「${backfilled.join("、")}」）。那我们直接看下一步：为了回答这道题，需要从哪些方面来比较或展开？请列出几个讨论维度。`;
            data.text = `${split.part1.trim()}\n\n---\n\n${nextPart2}`;
            data.progressUpdate.isCompleted = false;
            console.warn(
              `[Step1Guard] Filled constraints=${JSON.stringify(backfilled)} noHardSkipped=${noHardFilled}; repaired redundant qualifier question.`,
            );
          }
        }

        enforceStep1SlotCompletion(data, session, userMessage);
      }

      // Step 2 Dimension Coverage & Retention Guard: a narrow, separate verification
      // call that catches cases where the prompt-only rule gets diluted by the large
      // Step 2 prompt and the model silently drops an uncovered sibling dimension.
      if (currentStepNum === 2 && data?.progressUpdate) {
        const proposalEarly = applyStep2ProposalChannelEarly(
          data,
          session,
          userMessage,
          req.body?.decision || null,
        );
        // Legacy retention marker path only when proposal channel did not handle.
        if (!proposalEarly.handled) {
          await applyStep2RetentionGuard(
            data,
            session,
            userMessage,
            messages,
            question,
            { decision: req.body?.decision || null },
          );
        }
        applyNoStanceGate(question, data, session);
        enforceStep2DimensionDispositionGuard(data, session);
        enforceStep2StanceMaterialGuard(data, session, userMessage);
        if (
          !data.progressUpdate.step2Data ||
          typeof data.progressUpdate.step2Data !== "object"
        ) {
          data.progressUpdate.step2Data = {};
        }
        // Previous coach ask → recover activePoint when payload focus was never stamped.
        data.progressUpdate.step2Data._lastCoachAsk =
          extractLastCoachQuestion(messages);
        // Inline retention stamps only when the proposal channel did not
        // already resolve this turn (avoids double/conflicting stamps).
        if (!proposalEarly.handled) {
          applyStep2InlineChecklistRetention(data, session, userMessage);
        }
        await applyStep2PlannerPayloadNormalize(
          question,
          data,
          session,
          userMessage,
          {
            isHiddenKickoff: Boolean(isHiddenKickoff),
            decision: req.body?.decision || null,
          },
        );
        if (proposalEarly.handled && proposalEarly.committedPayload) {
          mergeCommittedProposalIntoPayload(
            data.progressUpdate.step2Data,
            proposalEarly.committedPayload,
            proposalEarly.committedUserPoints,
          );
        }
        applyStep2FocusAndSlotAddPostProcess(data, session, userMessage, {
          decision: req.body?.decision || null,
        });
        enforceStep2Momentum(data, session, {
          channelAuthoredText: Boolean(proposalEarly.handled),
        });
        // Momentum / thin-ask may stamp pendingFocusClaim — persist onto activePointId.
        stampStep2ActivePointFromPendingFocus(data);
        // Capacity trim merged into side 详略 — never force a second裁剪 ask.
        {
          const step2 = data.progressUpdate?.step2Data;
          if (step2?.plannerPayload?.pendingCapacityTrim) {
            step2.plannerPayload.pendingCapacityTrim = null;
          }
        }
        enforceStep2AskContract(data, session, {
          safeOverridePart1,
          buildContentAwareFallback: buildStep2ContentAwareFallback,
        });
        // Stance/slot legacy post-process only if proposal channel idle.
        if (!data.progressUpdate.step2Data?.plannerPayload?.pendingProposal) {
          applyStep2StanceConfirmPostProcess(data, session, userMessage, {
            decision: req.body?.decision || null,
          });
        }
        scrubStep2StaleDecisionPendingOnContentAsk(data);
        applyStep2ProposalChannelLate(data, session, userMessage);
      }

      // Heuristic + anti-drift completion (runs AFTER backfill text repair & slot check)
      applyStepCompletionHeuristic(data, currentStepNum, session);

      // Step 2 completion gate MUST run after the heuristic so mid-explore
      // isCompleted:true (model or CTA hallucination) cannot unlock the jump button.
      if (currentStepNum === 2 && data?.progressUpdate) {
        enforceStep2Completion(data, session);
      }

      // Step 3 projection guard removed (P0 补完): 秘书架构下 LLM 不输出
      // paragraphPlan / step3SubpointSteps，结构由服务器冻结 skeleton + minutes
      // 接管；旧的 flat-wrap 与投影 guard 是惰性兼容，已删除。

      // Step 3 mode correction removed alongside: applyParagraphModeCorrection
      // 只处理 paragraphPlan.mode，秘书路径不产生 paragraphPlan，故不可达。

      // Step 3 completion safety net

      // 会议秘书：若 subpoint 尚无冻结骨架，后端从 Planner bodyPlans 初始化骨架 + minutes。
      if (currentStepNum === 3) {
        ensureStep3SkeletonForSubpoints(session);
      }

      // Step 3 completion safety net: merge prior values, backfill a missed last
      // step from the user message, and clear premature completion CTA / flags
      // while any required step value is still empty.
      // 会议秘书：LLM 可能只输出 text 而不输出 progressUpdate（结构由服务器接管），
      // 因此这里必须无条件进入（函数内部会兜底初始化 progressUpdate），否则秘书
      // 落槽/看板回传被跳过 → 学生内容永远无法落槽 → 状态漂移死锁。
      if (currentStepNum === 3) {
        enforceStep3LogicCompletion(data, session, userMessage, {
          isHiddenKickoff: Boolean(isHiddenKickoff),
        });
      }

      if (typeof data?.text === "string") {
        const cleanedText = stripInternalJargonFromChatText(data.text);
        if (cleanedText !== data.text) {
          console.warn(
            `[JargonGuard] Stripped internal terms from step ${step} chat text.`,
          );
          data.text = cleanedText;
        }
      }

      // Persist refreshed digests after all guards mutated progressUpdate.
      // Client merges progressUpdate.memory into session.memory.
      if (!data.progressUpdate || typeof data.progressUpdate !== "object") {
        data.progressUpdate = {};
      }
      data.progressUpdate.memory = refreshMemoryAfterProgress(
        session,
        question,
        data.progressUpdate,
      );

      log.endTurn(turnId, String(data.text || ''), data.progressUpdate);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/coach/chat:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to generate chat response" });
    }
  });

  // Coach API - Evaluate Step 1 (User Topic Analysis Notes)
  app.post("/api/coach/evaluate-step1", async (req, res) => {
    try {
      const { question, userAnalysisText } = req.body;
      if (!question || !userAnalysisText) {
        res
          .status(400)
          .json({ error: "Missing question or user analysis text" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an elite IELTS Writing AI Coach.
        Evaluate the user's self-written Topic Analysis Notes for the following IELTS Task 2 prompt:
        "${question}"

        User's Analysis Notes:
        "${userAnalysisText}"

        Analyze the question yourself first:
        1. Determine the correct IELTS Question Type (Agree / Disagree, Discuss Both Views, Advantages / Disadvantages, Two-part Question, Problem / Solution, Positive / Negative, or Other).
        2. Identify the central core issue/controversy.
        3. Identify any critical scope constraints (e.g. "entirely", "only", "always", specific target groups).

        Then, evaluate the user's analysis:
        - Did they identify the correct question type or structure?
        - Did they correctly capture the core issue/debate?
        - Did they notice the constraints?
        - Provide an encouraging, academic, and sharp coaching critique (3-4 sentences in Chinese, but citing English academic terms as needed). Give practical advice. Avoid exposing any internal raw thought blocks or XML elements.
        - Give a qualitative score from 1 to 10 for their analysis.

        Format your output strictly as a JSON object matching this schema:
        {
          "correctType": "string",
          "coreIssue": "string",
          "constraints": ["string"],
          "critique": "string",
          "score": number
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              correctType: { type: Type.STRING },
              coreIssue: { type: Type.STRING },
              constraints: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              critique: { type: Type.STRING },
              score: { type: Type.INTEGER },
            },
            required: [
              "correctType",
              "coreIssue",
              "constraints",
              "critique",
              "score",
            ],
          },
        },
      });

      const data = parseAIResponse(response.text, {
        correctType: "",
        coreIssue: "",
        constraints: [],
        critique: "Failed to generate evaluation due to output format error.",
        score: 0,
      });
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/coach/evaluate-step1:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to evaluate step 1" });
    }
  });

  // Coach API - Evaluate Step 2 (User Stance & Subpoints)
  app.post("/api/coach/evaluate-step2", async (req, res) => {
    try {
      const { question, questionType, userStance, userPoints } = req.body;
      if (!question || !userStance || !userPoints) {
        res
          .status(400)
          .json({ error: "Missing required stance/points or question" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an elite IELTS Writing AI Coach.
        Evaluate the user's overall stance and paragraph sub-arguments for the following IELTS Task 2 prompt:
        "${question}"
        (Question Type: ${questionType || "Standard Task 2"})

        User's Full-Text Overall Stance (全文立场):
        "${userStance}"

        User's Paragraph Sub-arguments/Points (段落分论点):
        "${userPoints}"

        Your tasks:
        1. Evaluate the Overall Stance: Is it clear, academically strong, and directly answering all parts of the question?
        2. Evaluate the Sub-arguments: Are there 2 distinct, logical sub-points? Do they support the stance without overlapping or repeating?
        3. Provide an encouraging, analytical, and highly professional critique (in Chinese, 3-4 sentences). Do NOT output any XML tags or internal thinking steps.
        4. Give 2-3 specific bullet-point suggestions for improvement.
        5. Optionally give a short Chinese paraphrase of their stance (no English polish, no rewritten English points).

        Format your output strictly as a JSON object matching this schema:
        {
          "critique": "string (coaching review in Chinese)",
          "suggestions": ["string (suggestion 1)", "string (suggestion 2)"],
          "suggestedStance": "string (optional Chinese stance paraphrase)",
          "suggestedPoints": ""
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              critique: { type: Type.STRING },
              suggestions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              suggestedStance: { type: Type.STRING },
              suggestedPoints: {
                type: Type.STRING,
                description: "Deprecated. Always empty string.",
              },
            },
            required: [
              "critique",
              "suggestions",
              "suggestedStance",
            ],
          },
        },
      });

      const data = parseAIResponse(response.text, {
        critique: "Failed to generate evaluation due to format error.",
        suggestions: [],
        suggestedStance: "",
        suggestedPoints: "",
      });
      data.suggestedPoints = "";
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/coach/evaluate-step2:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to evaluate step 2" });
    }
  });

  // Coach API - Evaluate Step 3 (User Paragraph Structure Breakdown)
  app.post("/api/coach/evaluate-step3", async (req, res) => {
    try {
      const { question, draftText } = req.body;
      if (!draftText) {
        res.status(400).json({ error: "Draft text is empty" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are a Feedback Coach focusing purely on "Reasoning Diagnosis" (Logic > Structure > Language) rather than academic tone/clarity.
        Analyze the user's drafted paragraph:
        "${draftText}"

        Based on the IELTS Topic Question: "${question || ""}"

        Analyze if the paragraph satisfies the logical reasoning chain (Claim -> Reason -> Mechanism -> Example -> Result).

        Evaluate:
        - Structure Diagnosis: Which elements are present? Map the sentences from the user's paragraph to these categories.
        - List any missing or weak elements.
        - Formulate 1-2 sharp Socratic questions prodding the user to think deeper about their missing logic. (Keep questions in Chinese, e.g., "为什么线上教育能够节省时间？节省的时间如何转化为更高的学习效率？").
        - Rewrite Suggestion / Possible Direction: Provide a suggested direction (in Chinese) for the missing parts (e.g., "Possible direction: time flexibility / self-paced learning / fewer interruptions").
        - Logic Critique: Provide a constructive, professional logical critique (in Chinese, 2-3 sentences). Focus on gaps in reasoning. For example: "你直接从原因跳到了结果，中间的具体机制（过程）没有解释清楚。". Do NOT critique vocabulary or grammar.

        Format output as a JSON object matching this schema:
        {
          "structure": {
            "topicSentence": boolean,
            "explanation": boolean,
            "example": boolean,
            "concludingSentence": boolean
          },
          "sentenceMapping": {
            "topicSentence": "string (user's sentence matching this, or 'Missing')",
            "explanation": "string (user's sentence matching this, or 'Missing')",
            "example": "string (user's sentence matching this, or 'Missing')",
            "concludingSentence": "string (user's sentence matching this, or 'Missing')"
          },
          "missingElements": ["string"],
          "socraticQuestions": ["string"],
          "suggestedChain": "string (Possible direction or rewrite suggestion in Chinese)",
          "critique": "string (Logic Critique in Chinese)"
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              structure: {
                type: Type.OBJECT,
                properties: {
                  topicSentence: { type: Type.BOOLEAN },
                  explanation: { type: Type.BOOLEAN },
                  example: { type: Type.BOOLEAN },
                  concludingSentence: { type: Type.BOOLEAN },
                },
                required: [
                  "topicSentence",
                  "explanation",
                  "example",
                  "concludingSentence",
                ],
              },
              sentenceMapping: {
                type: Type.OBJECT,
                properties: {
                  topicSentence: { type: Type.STRING },
                  explanation: { type: Type.STRING },
                  example: { type: Type.STRING },
                  concludingSentence: { type: Type.STRING },
                },
                required: [
                  "topicSentence",
                  "explanation",
                  "example",
                  "concludingSentence",
                ],
              },
              missingElements: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              socraticQuestions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              suggestedChain: { type: Type.STRING },
              critique: { type: Type.STRING },
            },
            required: [
              "structure",
              "sentenceMapping",
              "missingElements",
              "socraticQuestions",
              "suggestedChain",
              "critique",
            ],
          },
        },
      });

      const data = parseAIResponse(response.text, {
        structure: {
          topicSentence: false,
          explanation: false,
          example: false,
          concludingSentence: false,
        },
        sentenceMapping: {
          topicSentence: "",
          explanation: "",
          example: "",
          concludingSentence: "",
        },
        missingElements: [],
        socraticQuestions: [],
        suggestedChain: "",
        critique: "Failed to generate evaluation due to format error.",
      });
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/coach/evaluate-step3:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to evaluate step 3" });
    }
  });

  // 3. API - Brainstorm Dimensions (Step 2 - 3.1)
  app.post("/api/brainstorm-dimensions", async (req, res) => {
    try {
      const { question, questionType, userNotes, suggestedDimensions } = req.body;
      if (!question) {
        res.status(400).json({ error: "Missing question text" });
        return;
      }

      const ai = getAI();
      let userNotesInstructions = "";
      if (userNotes && userNotes.trim().length > 0) {
        userNotesInstructions = `
        The student has already expressed their initial perspective / stance during the previous step: "${userNotes}".
        You MUST custom-tailor these Thinking Dimensions to align directly with or expand on the student's perspective. For example:
        - If they suggested that online and traditional education are complementary and satisfy different needs, make sure the dimensions facilitate exploring how they complement each other, what distinct needs they meet, or why they cannot completely replace each other.
        - Ensure at least 2 dimensions are directly related to exploring the specific themes or vocabulary words in their perspective (e.g. "mutual complementarity", "distinct demands", "socializing needs", "discipline").
        `;
      }
      const approvedDimensions = Array.isArray(suggestedDimensions)
        ? suggestedDimensions
            .map((d: any) => (typeof d === "string" ? d.trim() : ""))
            .filter((d: string) => d.length > 0)
        : [];
      const approvedDimensionInstructions =
        approvedDimensions.length > 0
          ? `
        Step 1 already surfaced these approved analytical angles:
        ${approvedDimensions.map((d: string, idx: number) => `${idx + 1}. ${d}`).join("\n")}
        You MUST treat them as baseline thinking directions.
        Keep the generated dimensions aligned with, deepening, or refining these angles.
        Avoid duplicates or near-duplicates of these baseline dimensions.
        `
          : "";

      const prompt = `
        You are an IELTS Writing Coach.
        For this IELTS Writing prompt:
        "${question}"
        (Question Type: ${questionType || "Standard Task 2"})
        ${userNotesInstructions}
        ${approvedDimensionInstructions}

        Brainstorm 4 to 5 "Thinking Dimensions" (critical angles / analytical entry points) to analyze the issue.
        Each dimension must be concise and represented as: "dimension_name (short explanation of scope/meaning)".
        For example:
        - "accessibility (who can access)"
        - "efficiency (learning speed)"
        - "motivation (student engagement)"
        - "inequality (gap between groups)"
        - "financial cost (affordability)"

        Limit dimensions strictly to high-quality nouns + short <= 5 words explanations.
        Do NOT write full arguments or complete sentences.

        Format output as a JSON object containing an array of dimensions:
        {
          "dimensions": [
            {
              "id": "string (unique code e.g. d1, d2...)",
              "name": "string (dimension name, e.g., 'accessibility')",
              "prompt": "string (e.g., 'accessibility (who can access)')"
            }
          ]
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              dimensions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    name: { type: Type.STRING },
                    prompt: { type: Type.STRING },
                  },
                  required: ["id", "name", "prompt"],
                },
              },
            },
            required: ["dimensions"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/brainstorm-dimensions:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to brainstorm dimensions" });
    }
  });

  // 4. API - Generate Argument Seeds (Step 2 - 3.2 Mapping)
  app.post("/api/generate-seeds", async (req, res) => {
    try {
      const { question, questionType, selectedDimensions } = req.body;
      if (!question || !selectedDimensions || !selectedDimensions.length) {
        res
          .status(400)
          .json({ error: "Missing question or selected dimensions" });
        return;
      }

      const ai = getAI();
      const dimensionListStr = selectedDimensions
        .map((d: any) => d.prompt)
        .join(", ");
      const prompt = `
        You are an IELTS Coach.
        Given the IELTS Writing topic: "${question}"
        And these selected thinking dimensions: [${dimensionListStr}]

        Create exactly ONE "Argument Seed" (semi-structured argument snippet) for each selected dimension.
        An Argument Seed is a logical precursor, NOT a full sentence. It consists of:
        1. Direction: Either "SUPPORT" (agree/pro/advantages) or "AGAINST" (disagree/con/disadvantages) or "MIXED".
        2. Mechanism: A short active phrase explaining HOW/WHY it works (e.g. "more rural students reach education").
        3. Scope: Optional group, time, or constraint affected (e.g. "removes distance constraint").

        Strict Constraints:
        - NO full sentences.
        - NO thesis statement.
        - Strictly concise and logical.

        Format output as a JSON object:
        {
          "seeds": [
            {
              "id": "string (unique code, e.g. s1, s2)",
              "dimension": "string (the matching dimension name)",
              "direction": "SUPPORT" | "AGAINST" | "MIXED",
              "mechanism": "string (short mechanism phrase, <=8 words)",
              "scope": "string (short scope phrase, <=5 words)"
            }
          ]
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              seeds: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    dimension: { type: Type.STRING },
                    direction: { type: Type.STRING },
                    mechanism: { type: Type.STRING },
                    scope: { type: Type.STRING },
                  },
                  required: [
                    "id",
                    "dimension",
                    "direction",
                    "mechanism",
                    "scope",
                  ],
                },
              },
            },
            required: ["seeds"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/generate-seeds:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to generate seeds" });
    }
  });

  // 5. API - Induce Thesis & Bundles (Step 2 - 3.3 & Step 4 Hook)
  app.post("/api/induce-thesis", async (req, res) => {
    try {
      const { question, questionType, seeds } = req.body;
      if (!question || !seeds || !seeds.length) {
        res.status(400).json({ error: "Missing topic or seeds" });
        return;
      }

      const ai = getAI();
      const seedsStr = JSON.stringify(seeds);
      const prompt = `
        You are an IELTS Writing Tutor.
        Topic: "${question}"
        Question Type: ${questionType}
        Input Argument Seeds: ${seedsStr}

        Task:
        1. Formulate exactly 3 distinct "Argument Bundles" (combinations of 1 to 3 seeds) that represent different reasoning tracks or logical stances (e.g. Option A: Pure Pro-impact, Option B: Mixed-impact, Option C: Critical/Con-impact).
        2. For each bundle, induce a high-scoring IELTS Thesis Statement (under 2 sentences) that perfectly summarizes the position of those seeds, requiring minimal extra assumptions.
        3. Rate each thesis option's structural and logical strength ("Strong" | "Balanced" | "Weak") and describe its logical flow (e.g. "Acknowledges minor drawback before asserting main benefit").

        Format output as a JSON object:
        {
          "bundles": [
            {
              "id": "string (b1, b2, b3)",
              "name": "string (e.g. 'Option A: Positive Stance')",
              "seeds": [
                {
                  "id": "string (seed id matching inputs)",
                  "dimension": "string",
                  "direction": "string",
                  "mechanism": "string",
                  "scope": "string"
                }
              ],
              "implicitImpact": "string (e.g., 'Positive Impact' or 'Mixed Position')"
            }
          ],
          "thesisOptions": [
            {
              "id": "string (t1, t2, t3 matching bundles b1, b2, b3)",
              "thesis": "string (the inferred formal high-scoring thesis statement)",
              "strength": "Strong" | "Balanced" | "Weak",
              "logicFlow": "string (short description of the argumentative flow)"
            }
          ]
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              bundles: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    name: { type: Type.STRING },
                    seeds: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          id: { type: Type.STRING },
                          dimension: { type: Type.STRING },
                          direction: { type: Type.STRING },
                          mechanism: { type: Type.STRING },
                          scope: { type: Type.STRING },
                        },
                      },
                    },
                    implicitImpact: { type: Type.STRING },
                  },
                  required: ["id", "name", "seeds", "implicitImpact"],
                },
              },
              thesisOptions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    thesis: { type: Type.STRING },
                    strength: { type: Type.STRING },
                    logicFlow: { type: Type.STRING },
                  },
                  required: ["id", "thesis", "strength", "logicFlow"],
                },
              },
            },
            required: ["bundles", "thesisOptions"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/induce-thesis:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to induce thesis options" });
    }
  });

  // 6. API - Recommend Template & Keywords (Step 3 论证)
  app.post("/api/recommend-template", async (req, res) => {
    try {
      const { question, questionType, selectedThesis, selectedBundle } =
        req.body;
      if (!question || !selectedThesis) {
        res.status(400).json({ error: "Missing topic or thesis" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an IELTS Writing Specialist.
        Analyzing the IELTS Topic: "${question}" (Type: ${questionType})
        With the chosen Thesis: "${selectedThesis}"

        Recommend the absolute best argumentation template from these 6 standardized structures:
        - Template A: Claim -> Reason -> Mechanism -> Result (Ideal for pure causal or process links, remote work, automation, etc.)
        - Template B: Claim -> Reason -> Example -> Result (Ideal for broad social or behavioral trends with easy illustrative group examples)
        - Template C: Claim -> Contrast -> Reason -> Example (Ideal for comparison or alternative choice prompts e.g. online vs offline)
        - Template D: Claim -> Concession -> Reason -> Result (Ideal for complex debate, acknowledging opposite limits before countering)
        - Template E: Claim -> Reason -> Example -> Result -> Evaluation (Ideal for 7+ deep critical assessment of social impact)
        - Template F: Claim -> Reason -> Affected Group -> Result -> Evaluation (Ideal for government policy, public transport, bans)

        Recommend the template ID ("A", "B", "C", "D", "E", or "F") that best matches.
        Provide:
        1. 4-5 high-scoring lexical Keywords (useful verbs/phrases) appropriate for this argument.
        2. A structured breakdown of what each template element would say based on this thesis.

        Format output as JSON:
        {
          "templateId": "A" | "B" | "C" | "D" | "E" | "F",
          "keywords": ["string", "string"],
          "sampleElements": {
            "claim": "string",
            "reason": "string",
            "mechanism": "string (optional)",
            "example": "string (optional)",
            "result": "string (optional)",
            "contrast": "string (optional)",
            "concession": "string (optional)",
            "definition": "string (optional)",
            "affectedGroup": "string (optional)",
            "evaluation": "string (optional)"
          }
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              templateId: { type: Type.STRING },
              keywords: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              sampleElements: {
                type: Type.OBJECT,
                properties: {
                  claim: { type: Type.STRING },
                  reason: { type: Type.STRING },
                  mechanism: { type: Type.STRING },
                  example: { type: Type.STRING },
                  result: { type: Type.STRING },
                  contrast: { type: Type.STRING },
                  concession: { type: Type.STRING },
                  definition: { type: Type.STRING },
                  affectedGroup: { type: Type.STRING },
                  evaluation: { type: Type.STRING },
                },
                required: ["claim", "reason"],
              },
            },
            required: ["templateId", "keywords", "sampleElements"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/recommend-template:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to recommend template" });
    }
  });

  // 7. API - Analyze Paragraph Argumentation (Step 3 & 5 Feedback)
  app.post("/api/analyze-argumentation", async (req, res) => {
    try {
      const { question, templateId, draftText } = req.body;
      if (!draftText) {
        res.status(400).json({ error: "Draft text is empty" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an IELTS Writing Tutor specializing in logical coherence.
        Analyze this user's drafted paragraph:
        "${draftText}"

        Based on IELTS Topic: "${question || ""}"
        We are testing against Argumentation Template ID: "${templateId || "A"}"

        Analyze which template elements are present or absent:
        - Claim (Main assertion)
        - Reason (Underlying cause)
        - Mechanism (How it works precisely / causal chain)
        - Example (Illustrative fact or case study)
        - Result (Ultimate consequence)
        - Evaluation (Significance / moral upgrade)
        - Concession (Acknowledging opposite side)
        - Contrast (Alternative stance comparison)

        Task:
        1. Identify true/false for each element's presence.
        2. Detail missing elements.
        3. Formulate 1-2 sharp Socratic questions prodding the user to think deeper about the missing or weak logical link. Do NOT give them the answer; ask a question that guides them (e.g., "While you state that remote work reduces distractions, what exact aspects of the office environment are avoided?").
        4. Reconstruct a "Suggested Logical Chain" showing how this paragraph would look with a highly cohesive structure following the exact template.
        5. Provide a critical, professional critique (2-3 sentences) on logic, flow, and structural integrity.

        Format output as a JSON object:
        {
          "structure": {
            "claim": boolean,
            "reason": boolean,
            "mechanism": boolean,
            "example": boolean,
            "result": boolean,
            "evaluation": boolean,
            "concession": boolean,
            "contrast": boolean,
            "definition": boolean,
            "affectedGroup": boolean
          },
          "missingElements": ["string", "string"],
          "socraticQuestions": ["string"],
          "suggestedChain": {
            "claim": "string",
            "reason": "string",
            "mechanism": "string (optional)",
            "example": "string (optional)",
            "result": "string (optional)",
            "evaluation": "string (optional)",
            "concession": "string (optional)",
            "contrast": "string (optional)",
            "definition": "string (optional)",
            "affectedGroup": "string (optional)"
          },
          "critique": "string (professional logical critique)"
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              structure: {
                type: Type.OBJECT,
                properties: {
                  claim: { type: Type.BOOLEAN },
                  reason: { type: Type.BOOLEAN },
                  mechanism: { type: Type.BOOLEAN },
                  example: { type: Type.BOOLEAN },
                  result: { type: Type.BOOLEAN },
                  evaluation: { type: Type.BOOLEAN },
                  concession: { type: Type.BOOLEAN },
                  contrast: { type: Type.BOOLEAN },
                  definition: { type: Type.BOOLEAN },
                  affectedGroup: { type: Type.BOOLEAN },
                },
                required: ["claim", "reason", "mechanism", "example", "result"],
              },
              missingElements: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              socraticQuestions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              suggestedChain: {
                type: Type.OBJECT,
                properties: {
                  claim: { type: Type.STRING },
                  reason: { type: Type.STRING },
                  mechanism: { type: Type.STRING },
                  example: { type: Type.STRING },
                  result: { type: Type.STRING },
                  evaluation: { type: Type.STRING },
                  concession: { type: Type.STRING },
                  contrast: { type: Type.STRING },
                  definition: { type: Type.STRING },
                  affectedGroup: { type: Type.STRING },
                },
                required: ["claim", "reason"],
              },
              critique: { type: Type.STRING },
            },
            required: [
              "structure",
              "missingElements",
              "socraticQuestions",
              "suggestedChain",
              "critique",
            ],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/analyze-argumentation:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to analyze paragraph" });
    }
  });

  // 8. API - Floating Action Bar Text Helpers
  app.post("/api/inline-action", async (req, res) => {
    try {
      const { sentence, action, contextTopic } = req.body;
      if (!sentence || !action) {
        res.status(400).json({ error: "Missing sentence or action" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an elite IELTS Writing Editor.
        Optimize this selected sentence from an essay draft:
        "${sentence}"

        Task: Apply the action "${action}" to improve the sentence.
        Actions defined:
        - "clarity": Eliminate wordiness, improve flow, and make the meaning crystal clear.
        - "mechanism": Embed a logical/causal step or mechanism directly into the sentence (how/why).
        - "formal": Upgrade vocabulary and style to be highly academic and formal (appropriate for band 8.0+).
        - "grammar": Fix any grammatical, tense, concord, or spelling errors.
        - "extend": Add a logical extension, consequence, or illustrative detail to support the claim.

        Context topic (if any): "${contextTopic || ""}"

        Provide the improved sentence and a brief, professional 1-sentence explanation of the change.

        Format output as a JSON object:
        {
          "improved": "string (the improved sentence)",
          "explanation": "string (the brief explanation of the change)"
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              improved: { type: Type.STRING },
              explanation: { type: Type.STRING },
            },
            required: ["improved", "explanation"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      res.json(data);
    } catch (error: any) {
      console.error("Error in /api/inline-action:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to perform action" });
    }
  });

  // 9. API - Generate Sentence Practice Tasks (Step 4)
  app.post("/api/generate-sentence-tasks", async (req, res) => {
    try {
      const { question, selectedThesis, subpoints } = req.body;
      if (!question) {
        res.status(400).json({ error: "Missing topic question" });
        return;
      }

      const normalizeText = (value: unknown): string =>
        typeof value === "string" ? value.trim() : "";

      const dedupeOrdered = (items: string[]) => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const item of items) {
          const normalized = item.trim();
          if (!normalized) continue;
          if (seen.has(normalized)) continue;
          seen.add(normalized);
          result.push(normalized);
        }
        return result;
      };

      const inferSection = (taskId: string): string => {
        if (taskId.startsWith("intro-")) return "intro";
        if (taskId.startsWith("conclusion")) return "conclusion";
        const bodyMatch = taskId.match(/^body(\d+)-/i);
        if (bodyMatch) return `body${bodyMatch[1]}`;
        return "body1";
      };

      const claimRegex = /(?:^|_)(subclaim|claim)$/i;
      const claimLabelRegex = /分论点|核心观点|核心主张|主张|论点|观点|claim/i;
      const extractBodySentences = (plan: any): string[] => {
        if (!plan || typeof plan !== "object") return [];

        const sentences: string[] = [];
        const totalClaim = normalizeText(plan.totalClaim);
        if (totalClaim) sentences.push(totalClaim);

        const pointBlocks = Array.isArray(plan.pointBlocks) ? plan.pointBlocks : [];
        pointBlocks.forEach((block: any) => {
          const blockSubClaim = normalizeText(block?.subClaim);
          const steps = Array.isArray(block?.steps) ? block.steps : [];

          let claimStepIndex = -1;
          for (let i = 0; i < steps.length; i += 1) {
            const key = normalizeText(steps[i]?.key);
            const label = normalizeText(steps[i]?.label);
            const value = normalizeText(steps[i]?.value);
            if (
              value &&
              (claimRegex.test(key) || claimLabelRegex.test(label))
            ) {
              claimStepIndex = i;
              break;
            }
          }

          if (claimStepIndex >= 0) {
            sentences.push(normalizeText(steps[claimStepIndex]?.value));
          } else if (blockSubClaim) {
            sentences.push(blockSubClaim);
          }

          steps.forEach((step: any, index: number) => {
            if (index === claimStepIndex) return;
            const value = normalizeText(step?.value);
            if (value) sentences.push(value);
          });
        });

        const shortClosing = normalizeText(plan.optionalShortClosing);
        if (shortClosing) sentences.push(shortClosing);

        return dedupeOrdered(sentences);
      };

      /** Short direction labels for intro/conclusion foreshadow (not full claim copy). */
      const extractBodyClaimContext = (plan: any, sp?: any): string => {
        const theme = normalizeText(sp?.theme || sp?.label);
        if (!plan || typeof plan !== "object") return theme;

        const totalClaim = normalizeText(plan.totalClaim);
        const pointBlocks = Array.isArray(plan.pointBlocks) ? plan.pointBlocks : [];
        const fromSteps: string[] = [];
        for (const block of pointBlocks) {
          const label = normalizeText(block?.label);
          const sub = normalizeText(block?.subClaim);
          const steps = Array.isArray(block?.steps) ? block.steps : [];
          let claimVal = "";
          for (const step of steps) {
            const key = normalizeText(step?.key);
            const stepLabel = normalizeText(step?.label);
            const value = normalizeText(step?.value);
            if (
              value &&
              (claimRegex.test(key) || claimLabelRegex.test(stepLabel))
            ) {
              claimVal = value;
              break;
            }
          }
          const head = label || theme;
          // Prefer theme/label; if only a long claim exists, keep a short head
          if (head) {
            fromSteps.push(head);
          } else if (claimVal) {
            fromSteps.push(
              claimVal.length > 28 ? `${claimVal.slice(0, 28)}…` : claimVal,
            );
          } else if (sub) {
            fromSteps.push(sub.length > 28 ? `${sub.slice(0, 28)}…` : sub);
          }
        }
        const joined = dedupeOrdered(fromSteps).join("；");
        if (joined) return joined;
        if (totalClaim) {
          return totalClaim.length > 36
            ? `${totalClaim.slice(0, 36)}…`
            : totalClaim;
        }
        return theme;
      };

      const bodyIndexFromSubpoint = (sp: any, fallback: number): number => {
        const target = normalizeText(sp?.targetBody);
        const mTarget = target.match(/(\d+)/);
        if (mTarget) return Math.max(1, parseInt(mTarget[1], 10));
        const id = normalizeText(sp?.id);
        const mId = id.match(/(\d+)/);
        if (mId) return Math.max(1, parseInt(mId[1], 10));
        return fallback;
      };

      const allSubpoints = Array.isArray(subpoints) ? subpoints : [];
      const seenBodyIds = new Set<string>();
      const orderedBodies = allSubpoints
        .filter((sp: any) => {
          const id = normalizeText(sp?.id) || JSON.stringify(sp?.targetBody || "");
          if (!id || seenBodyIds.has(id)) return false;
          seenBodyIds.add(id);
          return true;
        })
        .sort((a: any, b: any) => {
          return (
            bodyIndexFromSubpoint(a, 99) - bodyIndexFromSubpoint(b, 99)
          );
        });

      // Prefer actual Step3 bodies in order; fall back to index 1..n
      const bodyEntries = orderedBodies.map((sp: any, idx: number) => {
        const bodyNum = idx + 1;
        const plan = sp?.paragraphPlan;
        return {
          bodyNum,
          sp,
          sentences: extractBodySentences(plan),
          claimContext: extractBodyClaimContext(plan, sp),
        };
      });

      const stance = normalizeText(selectedThesis) || "需要结合题干进行立场表达";
      const bodyCount = Math.max(bodyEntries.length, 1);
      const bodyContextBlock = bodyEntries.length
        ? bodyEntries
            .map(
              (b) =>
                `Body ${b.bodyNum} direction (theme/label only):\n"${b.claimContext || "（缺失）"}"`,
            )
            .join("\n\n")
        : `Body 1 direction (theme/label only):\n"（缺失）"`;

      const inputElements: {
        id: string;
        type: string;
        chineseText: string;
        label: string;
      }[] = [];
      const introConclusionPrompt = `
You are an IELTS Writing coach creating Chinese sentence-level semantic targets for translation practice.

Topic question:
"${question}"

Full stance (for YOUR reference only — do NOT copy it nearly verbatim into introStance/conclusion):
"${stance}"

There are ${bodyCount} body paragraph(s). Direction cues (themes / short labels — NOT full argument chains):
${bodyContextBlock}

Generate exactly three Chinese outputs:
1) introParaphrase: A concise paraphrase of the original topic sentence. Topic restatement only.
2) introStance: One sentence stating the overall position and lightly foreshadowing the ${bodyCount} body direction(s) by theme words only.
3) conclusion: One sentence summarizing the final position with brief nod to those body directions. Must not copy introStance wording.

CRITICAL — REDUCE OVERLAP / EASE PARAPHRASE (introStance + conclusion):
- Moderately SUMMARIZE / GENERALIZE. Do NOT paste the full stance sentence or full body claim sentences.
- Prefer short judgment + direction nouns (e.g. 就业、社会安定、政府投入), not long causal chains already practiced in Body tasks.
- Keep lexical overlap with the Full stance string LOW (avoid reusing long identical chunks).
- Each of the three fields remains ONE Chinese sentence.
- Do NOT include bullets, numbering, or explanation text.
- Output a JSON object with exactly the keys introParaphrase, introStance, conclusion (the JSON must be valid and contain no other text).
      `;

      const introConclusionResponse = await generateContentWithFallback({
        contents: introConclusionPrompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              introParaphrase: { type: Type.STRING },
              introStance: { type: Type.STRING },
              conclusion: { type: Type.STRING },
            },
            required: ["introParaphrase", "introStance", "conclusion"],
          },
        },
      });

      const introConclusionData = parseAIResponse(introConclusionResponse.text);
      const introParaphrase =
        normalizeText(introConclusionData?.introParaphrase) ||
        "该题围绕一个公共议题展开讨论，需要比较不同路径并作出判断。";
      const introStance =
        normalizeText(introConclusionData?.introStance) ||
        `本文持明确立场，并将从${bodyCount}个方面展开论证。`;
      const conclusion =
        normalizeText(introConclusionData?.conclusion) ||
        `综上所述，上述${bodyCount}个方面共同支撑了这一立场。`;

      inputElements.push({
        id: "intro-1",
        type: "intro_paraphrase",
        chineseText: introParaphrase,
        label: "第一段：题干改写",
      });
      inputElements.push({
        id: "intro-2",
        type: "intro_stance",
        chineseText: introStance,
        label: "第一段：总立场句",
      });

      bodyEntries.forEach((body) => {
        body.sentences.forEach((sentence, index) => {
          inputElements.push({
            id: `body${body.bodyNum}-${index + 1}`,
            type: `body${body.bodyNum}_sentence`,
            chineseText: sentence,
            label: `Body ${body.bodyNum} 句子 ${index + 1}`,
          });
        });
      });

      inputElements.push({
        id: "conclusion-1",
        type: "conclusion_summary",
        chineseText: conclusion,
        label: "结尾：总结立场",
      });

      if (inputElements.length === 0) {
        res.status(400).json({ error: "Missing step4 task source sentences" });
        return;
      }

      const elementsList = inputElements
        .map((el, idx) => {
          return `${idx + 1}. [Task ID: ${el.id}] [Category: ${el.label}] Target Chinese Sentence: "${el.chineseText}"`;
        })
        .join("\n");

      const prompt = `
      You are an expert IELTS Lexical Resource Tutor.
      For this IELTS topic: "${question}"
      Chosen position/thesis: "${selectedThesis || ""}"

      The user has completed structured drafting and we have segmented the writing flow sentence-by-sentence.
      
      YOUR TASK:
      You MUST generate exactly ${inputElements.length} sentence-level expression exercises (tasks) in the output.
      Each task corresponds directly and sequentially to one of the target Chinese sentences provided below.
      
      Here are the target Chinese sentences to translate:
      ${elementsList}

      CRITICAL RULES:
      1. For each task, set the "id" to the respective "Task ID" provided.
      2. Set the "concept" to the EXACT "Target Chinese Sentence" text provided in the input. Do NOT change any character and do NOT output English in "concept".
      3. For each task, provide exactly 3 different prompts. Each prompt teaches ONE structural dimension only:
         - Prompt 1: subject-verb / clause skeleton (where the main subject and predicate go)
         - Prompt 2: modifier placement (adverbials, prepositional phrases, non-finite clauses)
         - Prompt 3: logical connector (cause/result/contrast linking)
      4. ANTI-SPOILER RULE (MUST OBEY):
         - The English side MUST use ONLY "..." as placeholders. NEVER use square brackets like [Online learning] or [convenience].
         - NEVER fill in nouns, verbs, or adjectives from the Chinese concept on the English side.
         - Do NOT output a near-complete English translation. The student must supply all content words.
         BAD: "[Online learning] is characterized by [its high level of convenience], thereby catering to the needs of [diverse demographic groups]"
         BAD: "Online learning is characterized by convenience -> ..."
         GOOD: "... is characterized by ..., thereby catering to the needs of ... -> 主语放论述对象；characterized by 后接抽象名词短语；thereby 引出结果"
         GOOD: "It is widely acknowledged that... -> 形式主语 It 引出客观陈述，主语从句放真正主语"
      5. Each prompt MUST strictly follow this single-line format:
         "English academic pattern with ... only -> Chinese explanation of structure (主谓/修饰/连接，不要写具体译词)"
      6. Also provide "highlights": an array of Chinese substrings to mark in the concept for learner scaffolding:
         - Mark EVERY subject-verb-(object) set you can identify (not only the main clause).
         - Do NOT mark conjunctions / logical linkers (尽管/但/由于/通过… etc.) — only S/V/O content words.
         - Each item: { "text": exact substring of concept, "role": "S"|"V"|"O", "tier": "core"|"subordinate" }
         - tier=core: the ONE logical main-clause S/V/O set (brightest + underline in UI). Prefer the half after 但/但是/然而 or after 从长远来看/总体上 when present.
         - tier=subordinate: S/V/O belonging to other clauses (e.g. inside 尽管…).
         - Do NOT invent words; every "text" MUST appear verbatim in concept. Keep spans short (words/phrases, not whole clauses).

      Format output as JSON:
      {
        "tasks": [
          {
            "id": "string (matching Task ID)",
            "concept": "string (EXACT matching Target Chinese Sentence)",
            "prompts": ["string", "string", "string"],
            "highlights": [
              { "text": "string", "role": "S|V|O", "tier": "core|subordinate" }
            ]
          }
        ]
      }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          systemInstruction:
            "You are an expert IELTS Lexical Resource Tutor. All output properties called 'concept' MUST be written strictly and entirely in Chinese. For 'prompts', English patterns must use ONLY '...' placeholders—never square brackets, never filled-in content words from the concept. Each prompt must contain '->' followed by Chinese structural guidance (主谓/修饰/连接). For 'highlights', every text must be an exact Chinese substring of concept; mark all S/V/O sets only (no conjunctions); main-clause set uses tier=core.",
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              tasks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    concept: { type: Type.STRING },
                    prompts: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    highlights: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          text: { type: Type.STRING },
                          role: { type: Type.STRING },
                          tier: { type: Type.STRING },
                        },
                        required: ["text", "role", "tier"],
                      },
                    },
                  },
                  required: ["id", "concept", "prompts", "highlights"],
                },
              },
            },
            required: ["tasks"],
          },
        },
      });

      const llmData = parseAIResponse(response.text);
      const llmTasks = Array.isArray(llmData?.tasks) ? llmData.tasks : [];

      const DEFAULT_PROMPTS = [
        "... is characterized by ... -> 主谓框架：主语位置放核心论述对象，系表结构 + by 后接抽象名词短语表达特征",
        "..., thereby ... / ..., which ... -> 修饰与扩展：逗号后用 thereby/which 等非谓语或从句补充结果，注意修饰成分挂靠位置",
        "This is largely because ... / As a result, ... -> 逻辑连接：用因果或结果连接词组织句间逻辑，避免按中文语序硬译",
      ];

      const isValidPromptLine = (line: string): boolean => {
        const trimmed = normalizeText(line);
        if (!trimmed) return false;
        if (!trimmed.includes("->")) return false;
        if (!trimmed.includes("...")) return false;
        if (/\[[^\]]+\]/.test(trimmed)) return false;

        const englishPart = trimmed.split("->")[0]?.trim() || "";
        const englishWords = englishPart
          .replace(/\.\.\./g, " ")
          .split(/\s+/)
          .map((w) => w.replace(/[^a-zA-Z'-]/g, ""))
          .filter((w) => w.length > 2);
        // Reject near-complete sentences: too many content words outside placeholders
        if (englishWords.length > 10) return false;

        return true;
      };

      const sanitizePrompts = (rawPrompts: string[]): string[] => {
        const valid = rawPrompts.filter(isValidPromptLine);
        const result = [...valid];
        for (let i = 0; result.length < 3; i += 1) {
          result.push(DEFAULT_PROMPTS[i % DEFAULT_PROMPTS.length]);
        }
        return result.slice(0, 3);
      };

      type HighlightRole = "S" | "V" | "O";
      type HighlightTier = "core" | "subordinate";
      type ConceptHighlight = {
        start: number;
        end: number;
        role: HighlightRole;
        tier: HighlightTier;
      };

      const sanitizeHighlights = (
        concept: string,
        raw: unknown,
      ): ConceptHighlight[] => {
        if (!Array.isArray(raw) || !concept) return [];
        const occupied: boolean[] = Array(concept.length).fill(false);
        const out: ConceptHighlight[] = [];
        const tierRank = (t: HighlightTier) => (t === "core" ? 0 : 1);

        const candidates = raw
          .map((item: any) => {
            const text = String(item?.text || "").trim();
            const roleRaw = String(item?.role || "")
              .trim()
              .toUpperCase();
            const tierRaw = String(item?.tier || "")
              .trim()
              .toLowerCase();
            let role: HighlightRole | null = null;
            if (roleRaw === "S" || roleRaw === "SUBJECT") role = "S";
            else if (roleRaw === "V" || roleRaw === "VERB" || roleRaw === "PREDICATE")
              role = "V";
            else if (roleRaw === "O" || roleRaw === "OBJECT") role = "O";
            // Drop conjunction / connector roles entirely.
            if (
              roleRaw === "CONJ" ||
              roleRaw === "CONNECTOR" ||
              roleRaw === "LINK"
            ) {
              return null;
            }
            let tier: HighlightTier | null = null;
            if (tierRaw === "core" || tierRaw === "main") tier = "core";
            else if (
              tierRaw === "subordinate" ||
              tierRaw === "sub" ||
              tierRaw === "secondary"
            ) {
              tier = "subordinate";
            }
            // Ignore connector tier from older model outputs.
            if (
              tierRaw === "connector" ||
              tierRaw === "conj" ||
              tierRaw === "linker"
            ) {
              return null;
            }
            if (!text || !role || !tier) return null;
            if (text.length > Math.min(24, concept.length)) return null;
            return { text, role, tier };
          })
          .filter(Boolean) as Array<{
          text: string;
          role: HighlightRole;
          tier: HighlightTier;
        }>;

        // Resolve core first so main-clause spans win overlapping claims.
        candidates.sort((a, b) => tierRank(a.tier) - tierRank(b.tier));

        for (const c of candidates) {
          let from = 0;
          let placed = false;
          while (from <= concept.length - c.text.length) {
            const idx = concept.indexOf(c.text, from);
            if (idx < 0) break;
            const end = idx + c.text.length;
            let overlap = false;
            for (let i = idx; i < end; i += 1) {
              if (occupied[i]) {
                overlap = true;
                break;
              }
            }
            if (!overlap) {
              for (let i = idx; i < end; i += 1) occupied[i] = true;
              out.push({ start: idx, end, role: c.role, tier: c.tier });
              placed = true;
              break;
            }
            from = idx + 1;
          }
          if (!placed) continue;
        }

        out.sort((a, b) => a.start - b.start || a.end - b.end);
        return out;
      };

      const promptsById = new Map<string, string[]>();
      const highlightsById = new Map<string, unknown>();
      llmTasks.forEach((task: any, index: number) => {
        const id = normalizeText(task?.id);
        const prompts = Array.isArray(task?.prompts)
          ? task.prompts.map((p: unknown) => normalizeText(p)).filter(Boolean)
          : [];
        if (id && prompts.length > 0) {
          promptsById.set(id, prompts);
        }
        if (prompts.length > 0 && !promptsById.has(`__index_${index}`)) {
          promptsById.set(`__index_${index}`, prompts);
        }
        if (id) highlightsById.set(id, task?.highlights);
        if (!highlightsById.has(`__index_${index}`)) {
          highlightsById.set(`__index_${index}`, task?.highlights);
        }
      });

      const mergedTasks = inputElements.map((el, index) => {
        const matchedPrompts =
          promptsById.get(el.id) ||
          promptsById.get(`__index_${index}`) ||
          [];
        const prompts = sanitizePrompts(matchedPrompts);
        const highlights = sanitizeHighlights(
          el.chineseText,
          highlightsById.get(el.id) ?? highlightsById.get(`__index_${index}`),
        );

        return {
          id: el.id,
          concept: el.chineseText,
          section: inferSection(el.id),
          prompts,
          highlights,
          confirmed: false,
          confirmedSentence: "",
        };
      });

      const rejectedPromptCount = llmTasks.reduce((count: number, task: any) => {
        const raw = Array.isArray(task?.prompts) ? task.prompts : [];
        const valid = raw.filter((p: unknown) => isValidPromptLine(normalizeText(p)));
        return count + Math.max(0, raw.length - valid.length);
      }, 0);

      console.log("[generate-sentence-tasks]", {
        subpointsCount: allSubpoints.length,
        bodyCount: bodyEntries.length,
        bodySentenceCounts: bodyEntries.map((b) => ({
          body: b.bodyNum,
          sentences: b.sentences.length,
        })),
        inputElementIds: inputElements.map((el) => el.id),
        mergedTaskIds: mergedTasks.map((task) => `${task.id}:${task.section}`),
        llmTaskCount: llmTasks.length,
        rejectedPromptCount,
      });

      res.json({ tasks: mergedTasks });
    } catch (error: any) {
      console.error("Error in /api/generate-sentence-tasks:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to generate tasks" });
    }
  });

  // 10. API - Check Sentence Practice Draft (Step 4 Evaluation)
  app.post("/api/evaluate-sentence-practice", async (req, res) => {
    try {
      const { concept, prompts, userDraft } = req.body;
      if (!userDraft) {
        res.status(400).json({ error: "Draft is empty" });
        return;
      }

      const ai = getAI();
      const prompt = `
        You are an expert IELTS Writing Tutor.
        Analyze the user's sentence and return precise inline annotations for errors.

        User's Draft: "${userDraft}"
        Target Idea (Concept): "${concept}"
        Given lexical prompts: ${JSON.stringify(prompts)}

        CRITICAL INSTRUCTIONS:
        1. DO NOT rewrite the sentence.
        2. DO NOT provide an improved or corrected sentence.
        3. Return only issue annotations that can be highlighted directly on the original sentence.
        4. For each annotation, "text" MUST be an exact substring copied from the user's draft.
        5. Explanations MUST be in plain Chinese with beginner-friendly wording (IELTS 5-5.5 level). Avoid heavy grammar jargon.
        6. If you need to mention the problematic phrase, quote the original English words but explain in Chinese.
        7. Also evaluate meaning alignment against the Chinese concept:
           - aligned: core meaning is fully and correctly conveyed.
           - partial: core direction is right but some key points are missing/weak.
           - mismatched: major meaning is wrong, opposite, or largely unrelated.
           IMPORTANT: Allow natural paraphrasing. Do NOT require literal word-by-word translation.
        8. If the sentence is already natural and correct, return an empty annotations array.

        Allowed categories:
        - "grammar"
        - "lexical"
        - "wordOrder"
        - "meaning"

        Format output as JSON:
        {
          "annotations": [
            {
              "text": "string (exact substring from user's draft)",
              "category": "grammar | lexical | wordOrder | meaning",
              "explanation": "string (brief explanation of issue and guidance)"
            }
          ],
          "contentAlignment": {
            "status": "aligned | partial | mismatched",
            "summary": "string (plain Chinese summary)",
            "coveredPoints": ["string"],
            "missingPoints": ["string"],
            "extraPoints": ["string"]
          }
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              annotations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    text: { type: Type.STRING },
                    category: { type: Type.STRING },
                    explanation: { type: Type.STRING },
                  },
                  required: ["text", "category", "explanation"],
                },
              },
              contentAlignment: {
                type: Type.OBJECT,
                properties: {
                  status: { type: Type.STRING },
                  summary: { type: Type.STRING },
                  coveredPoints: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  missingPoints: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  extraPoints: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: [
                  "status",
                  "summary",
                  "coveredPoints",
                  "missingPoints",
                  "extraPoints",
                ],
              },
            },
            required: ["annotations", "contentAlignment"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      const rawAnnotations = Array.isArray(data?.annotations)
        ? data.annotations
        : [];

      const normalizeCategory = (
        category: unknown,
      ): "grammar" | "lexical" | "wordOrder" | "meaning" => {
        const normalized = String(category || "")
          .trim()
          .toLowerCase();
        if (
          normalized.includes("meaning") ||
          normalized.includes("semantic") ||
          normalized.includes("content")
        ) {
          return "meaning";
        }
        if (
          normalized.includes("lex") ||
          normalized.includes("vocab") ||
          normalized.includes("word choice")
        ) {
          return "lexical";
        }
        if (
          normalized.includes("order") ||
          normalized.includes("syntax") ||
          normalized.includes("position")
        ) {
          return "wordOrder";
        }
        return "grammar";
      };

      const sanitizedAnnotations = rawAnnotations
        .map((item: any) => {
          const text = String(item?.text || "").trim();
          const explanation = String(item?.explanation || "").trim();
          if (!text || !explanation) return null;
          if (!String(userDraft).includes(text)) return null;
          return {
            text,
            category: normalizeCategory(item?.category),
            explanation,
          };
        })
        .filter(Boolean);

      const rawAlignment = data?.contentAlignment || {};
      const normalizedStatus = String(rawAlignment?.status || "")
        .trim()
        .toLowerCase();
      const status: "aligned" | "partial" | "mismatched" =
        normalizedStatus.includes("mismatch") || normalizedStatus.includes("wrong")
          ? "mismatched"
          : normalizedStatus.includes("partial") || normalizedStatus.includes("some")
            ? "partial"
            : "aligned";

      const normalizeStringList = (value: unknown): string[] =>
        Array.isArray(value)
          ? value
              .map((item) => String(item || "").trim())
              .filter(Boolean)
          : [];

      res.json({
        annotations: sanitizedAnnotations,
        contentAlignment: {
          status,
          summary: String(rawAlignment?.summary || "").trim(),
          coveredPoints: normalizeStringList(rawAlignment?.coveredPoints),
          missingPoints: normalizeStringList(rawAlignment?.missingPoints),
          extraPoints: normalizeStringList(rawAlignment?.extraPoints),
        },
      });
    } catch (error: any) {
      console.error("Error in /api/evaluate-sentence-practice:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to evaluate sentence" });
    }
  });

  // 11. API - Inline guidance (selected text or whole sentence)
  app.post("/api/inline-guidance", async (req, res) => {
    try {
      const {
        scopeText,
        fullDraft,
        concept,
        prompts,
        intent,
        questionText,
        guidanceHistory,
        highlights,
      } = req.body;
      const normalizedScopeText = String(scopeText || "").trim();
      const normalizedFullDraft = String(fullDraft || "").trim();
      const normalizedIntent = String(intent || "").trim();
      const normalizedQuestionText = String(questionText || "").trim();
      if (!normalizedScopeText && !normalizedFullDraft) {
        // Allow empty draft guidance, but we still need concept context.
        if (!String(concept || "").trim()) {
          res.status(400).json({ error: "Missing concept for empty draft guidance" });
          return;
        }
      }
      if (!String(concept || "").trim()) {
        res.status(400).json({ error: "Missing concept" });
        return;
      }

      const ai = getAI();
      const isStartSentence = normalizedIntent === "start_sentence";
      const isLeftQuickAsk =
        !normalizedScopeText &&
        (normalizedIntent === "find_word" || isStartSentence);

      const historyLines = Array.isArray(guidanceHistory)
        ? guidanceHistory
            .slice(-12)
            .map((item: any) => {
              const role = String(item?.role || "").trim() || "user";
              const text = String(
                item?.text || item?.hint || item?.label || item?.issue || "",
              ).trim();
              if (!text) return "";
              return `${role}: ${text}`;
            })
            .filter(Boolean)
            .join("\n")
        : "";

      const highlightSummary = Array.isArray(highlights)
        ? highlights
            .slice(0, 24)
            .map((h: any) => {
              const text =
                String(h?.text || "").trim() ||
                (typeof h?.start === "number" &&
                typeof h?.end === "number" &&
                String(concept || "").slice(h.start, h.end));
              const role = String(h?.role || "").trim();
              const tier = String(h?.tier || "").trim();
              if (!text) return "";
              return `${tier}/${role}:"${text}"`;
            })
            .filter(Boolean)
            .join("; ")
        : "";

      const prompt = `
        You are an IELTS writing coach.
        The student is drafting ONE sentence in Step 4.

        Chinese target concept:
        "${String(concept || "")}"

        Current full draft sentence:
        "${normalizedFullDraft}"

        User-selected text scope (can be empty):
        "${normalizedScopeText}"

        User-selected help intent tag (can be empty):
        "${normalizedIntent}"

        User free-text question (can be empty):
        "${normalizedQuestionText}"

        Suggested structural patterns:
        ${JSON.stringify(Array.isArray(prompts) ? prompts : [])}

        Concept highlights already shown in UI (tier/role:"text"):
        ${highlightSummary || "(none)"}

        Prior guidance thread for THIS sentence (oldest → newest; can be empty):
        ${historyLines || "(empty)"}

        Classify the user's help need into one of:
        - "vocabulary"
        - "grammar"
        - "wordOrder"
        - "expression"

        Classification rules:
        - If intent tag is provided, use it as the primary signal:
          selected_vocabulary/find_word -> vocabulary
          selected_grammar -> grammar
          selected_wordOrder -> wordOrder
          selected_expression/start_sentence -> expression
        - If selected scope is non-empty, focus diagnosis on that selected fragment first.
        - If selected scope is empty and full draft exists, do NOT perform full-sentence "check"; focus on the student's stated blocker from intent/question and provide targeted guidance.
        - If both selected scope and full draft are empty, classify as "expression" and guide how to start this sentence from the concept.

        CRITICAL INSTRUCTIONS:
        1. For "grammar", "wordOrder", and "expression", give guidance only and do NOT rewrite any part of the sentence.
        2. Exception for "vocabulary": if the student clearly does not know which word/phrase to use, you MAY suggest 1-3 concrete candidate words or short phrases, with brief Chinese notes about nuance/register/collocation differences.
        3. Even for "vocabulary", do NOT provide a ready-made full sentence, polished sentence, or full translated answer.
        4. issue/hint MUST be plain Chinese with learner-friendly wording (IELTS 5-5.5 level), avoid heavy grammar jargon.
        5. Keep it short and practical.
${
  isLeftQuickAsk && !isStartSentence
    ? `
        EXTRA — LEFT-PANEL QUICK ASK (intent is find_word, no selected scope):
        - ULTRA COMPACT. No greetings, no restating the Chinese concept, no "你可以试试", no filler.
        - issue: leave as "" OR one short clause (≤12 Chinese characters). Prefer "".
        - hint: ONLY the actionable core.
          * find_word / vocabulary: list 1-3 candidates like \`word\` 短注; max ~40 Chinese chars total notes.
        - Do NOT write diagnosis essays. Density over politeness.
`
    : ""
}
${
  isStartSentence
    ? `
        EXTRA — 「我不会起步」SOCRATIC START SCAFFOLD (intent=start_sentence):
        Run a 3-step startup scaffold. Use the prior guidance thread to infer the current step; advance one step per turn. Ask EXACTLY ONE question per turn.
        Steps:
        1) 拆部分: Help the student see the Chinese concept as 2–3 parts (main assertion vs concession / means / time). Point at the UI highlights if useful (core = brightest underlined main S/V/O; lighter = other clauses). Do NOT translate the whole sentence.
        2) 先写哪部分: Tell them to write ONLY the core main-clause idea first (the brightest highlighted set). Defer concession/means/time.
        3) 怎么选结构: For the part they should write NOW, give ONE English shell with "..." placeholders only, and ask them to fill the subject or verb first. No full sample sentence.
        Rules:
        - category MUST be "expression".
        - issue: "" or ≤12 Chinese chars progress tag like "先定主句".
        - hint: 2–4 short Chinese sentences max; end with ONE clear question.
        - Never output a complete English translation of the concept.
        - If the current draft already covers the main clause, skip ahead to attaching the next part (e.g. by / Although).
        - If this is the first turn (empty history), start at step 1.
`
    : ""
}

        Return JSON:
        {
          "category": "vocabulary | grammar | wordOrder | expression",
          "issue": "string (what is problematic now)",
          "hint": "string (for vocabulary: may include 1-3 candidate words/phrases with brief nuance notes; for other categories: guidance only, no direct rewrite)"
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              category: { type: Type.STRING },
              issue: { type: Type.STRING },
              hint: { type: Type.STRING },
            },
            required: ["category", "issue", "hint"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      const forcedCategoryFromIntent = (() => {
        const intentLower = normalizedIntent.toLowerCase();
        if (!intentLower) return null;
        if (intentLower.includes("vocabulary") || intentLower === "find_word") {
          return "vocabulary" as const;
        }
        if (intentLower.includes("grammar")) {
          return "grammar" as const;
        }
        if (intentLower.includes("wordorder") || intentLower.includes("word_order")) {
          return "wordOrder" as const;
        }
        if (intentLower.includes("expression") || intentLower === "start_sentence") {
          return "expression" as const;
        }
        return null;
      })();
      const normalizedCategory = String(data?.category || "")
        .trim()
        .toLowerCase();
      let category: "vocabulary" | "grammar" | "wordOrder" | "expression" = "expression";
      if (forcedCategoryFromIntent) {
        category = forcedCategoryFromIntent;
      } else if (normalizedCategory.includes("vocab") || normalizedCategory.includes("lex")) {
        category = "vocabulary";
      } else if (normalizedCategory.includes("order") || normalizedCategory.includes("syntax")) {
        category = "wordOrder";
      } else if (normalizedCategory.includes("gram")) {
        category = "grammar";
      }

      res.json({
        category,
        issue: String(data?.issue || "").trim(),
        hint: String(data?.hint || "").trim(),
      });
    } catch (error: any) {
      console.error("Error in /api/inline-guidance:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to get inline guidance" });
    }
  });

  // 12. API - Match user draft to sentence task
  app.post("/api/match-sentence-task", async (req, res) => {
    try {
      const { userDraft, candidates } = req.body;
      const normalizedDraft = String(userDraft || "").trim();
      const normalizedCandidates = Array.isArray(candidates)
        ? candidates
            .map((item: any) => ({
              id: String(item?.id || "").trim(),
              concept: String(item?.concept || "").trim(),
            }))
            .filter((item) => item.id && item.concept)
        : [];

      if (!normalizedDraft) {
        res.status(400).json({ error: "Missing userDraft" });
        return;
      }
      if (normalizedCandidates.length === 0) {
        res.status(400).json({ error: "Missing candidates" });
        return;
      }
      if (normalizedCandidates.length === 1) {
        res.json({
          matchedTaskId: normalizedCandidates[0].id,
          confidence: "high",
          reason: "只有一个候选句子，直接匹配。",
        });
        return;
      }

      const prompt = `
        You are matching one English sentence draft to one Chinese target concept.
        Choose the BEST matching candidate by meaning.

        English draft:
        "${normalizedDraft}"

        Candidate concepts (JSON):
        ${JSON.stringify(normalizedCandidates)}

        Rules:
        1. Return exactly one matchedTaskId from the candidates.
        2. Use semantic meaning, not literal word overlap.
        3. Allow paraphrasing; do NOT require word-by-word translation.
        4. If two candidates are close, still pick one but lower confidence.
        5. reason MUST be concise plain Chinese.

        Return JSON:
        {
          "matchedTaskId": "string",
          "confidence": "high | medium | low",
          "reason": "string"
        }
      `;

      const response = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              matchedTaskId: { type: Type.STRING },
              confidence: { type: Type.STRING },
              reason: { type: Type.STRING },
            },
            required: ["matchedTaskId", "confidence", "reason"],
          },
        },
      });

      const data = parseAIResponse(response.text);
      const candidateIds = new Set(normalizedCandidates.map((item) => item.id));
      let matchedTaskId = String(data?.matchedTaskId || "").trim();
      if (!candidateIds.has(matchedTaskId)) {
        matchedTaskId = normalizedCandidates[0].id;
      }
      const normalizedConfidence = String(data?.confidence || "")
        .trim()
        .toLowerCase();
      const confidence: "high" | "medium" | "low" =
        normalizedConfidence.includes("high")
          ? "high"
          : normalizedConfidence.includes("low")
            ? "low"
            : "medium";

      res.json({
        matchedTaskId,
        confidence,
        reason: String(data?.reason || "").trim(),
      });
    } catch (error: any) {
      console.error("Error in /api/match-sentence-task:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to match sentence task" });
    }
  });

  // Serve frontend files in development or production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
