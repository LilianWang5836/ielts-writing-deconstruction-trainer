/**
 * Step 3 logic-chain value quality helpers.
 * A step "value" only counts when it is a genuine student answer — not a
 * hidden kickoff instruction echoed back by the model or backfill logic.
 */

export function isKickoffOrInstructionText(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  return (
    /请基于这个已确立的主体段分论点直接开始/.test(t) ||
    /先判断这是单点还是多点论点/.test(t) ||
    /结构细节写入系统即可/.test(t) ||
    /不要在对话里提字段名/.test(t)
  );
}

export function isValidStep3StepValue(value: string): boolean {
  const v = String(value || "").trim();
  if (!v) return false;
  return !isKickoffOrInstructionText(v);
}

/**
 * Detects when the model echoed its own "例如：..." placeholder text back as
 * the step's "value" instead of writing the student's actual answer. This is
 * the dominant cause of Step 3 being declared complete while the dialogue
 * hasn't actually reached that step yet — the board LOOKS full but the
 * content was never said by the student.
 */
function normalizeForEchoCompare(text: string): string {
  return String(text || "")
    .replace(/^\s*(例如|e\.g\.?|eg)[:：,，]?\s*/i, "")
    .replace(/[\s，,。.！!？?；;：:""''「」【】\-—]/g, "")
    .toLowerCase();
}

export function isPlaceholderEchoValue(value: string, placeholder: string): boolean {
  const p = normalizeForEchoCompare(placeholder);
  if (!p) return false;
  const v = normalizeForEchoCompare(value);
  if (!v) return false;
  return v === p;
}

function isGenuineStep3StepValue(step: any): boolean {
  if (!step) return false;
  const v = String(step.value || "");
  if (!isValidStep3StepValue(v)) return false;
  if (isPlaceholderEchoValue(v, String(step.placeholder || ""))) return false;
  return true;
}

export function normalizeStep3Status(
  status: unknown,
): "" | "draft" | "confirmed" {
  const s = String(status || "").trim().toLowerCase();
  if (s === "confirmed") return "confirmed";
  if (s === "draft") return "draft";
  return "";
}

/** Confirmed = genuine content AND explicit confirmed status. */
export function isStep3Confirmed(step: any): boolean {
  return (
    isGenuineStep3StepValue(step) &&
    normalizeStep3Status(step?.status) === "confirmed"
  );
}

function ensureDraftStatus(step: any): void {
  if (!step || typeof step !== "object") return;
  if (!isGenuineStep3StepValue(step)) {
    step.status = "";
    return;
  }
  if (normalizeStep3Status(step.status) !== "confirmed") {
    step.status = "draft";
  }
}

export function isParagraphPlanQualityFilled(plan: any): boolean {
  if (!plan || !Array.isArray(plan.pointBlocks) || plan.pointBlocks.length === 0) {
    return false;
  }
  if (
    plan.mode === "total_then_points" &&
    String(plan.totalClaim || "").trim() &&
    !isValidStep3StepValue(String(plan.totalClaim))
  ) {
    return false;
  }
  if (
    plan.mode === "total_then_points" &&
    !isValidStep3StepValue(String(plan.totalClaim || ""))
  ) {
    return false;
  }
  return plan.pointBlocks.every(
    (block: any) =>
      Array.isArray(block?.steps) &&
      block.steps.length > 0 &&
      block.steps.every((step: any) => isStep3Confirmed(step)),
  );
}

/** Clear kickoff/instruction/placeholder-echo pollution from paragraphPlan step values in place. */
export function sanitizeParagraphPlanValues(plan: any): void {
  if (!plan || typeof plan !== "object") return;
  if (plan.totalClaim && !isValidStep3StepValue(String(plan.totalClaim))) {
    plan.totalClaim = "";
  }
  if (!Array.isArray(plan.pointBlocks)) return;
  for (const block of plan.pointBlocks) {
    if (!Array.isArray(block?.steps)) continue;
    for (const step of block.steps) {
      if (!isGenuineStep3StepValue(step)) {
        step.value = "";
        step.status = "";
      } else {
        ensureDraftStatus(step);
      }
    }
  }
}

export function sanitizeStructureStepsValues(steps: any[]): any[] {
  if (!Array.isArray(steps)) return steps;
  return steps.map((step) => {
    if (!step || typeof step !== "object") return step;
    if (!isGenuineStep3StepValue(step)) {
      return { ...step, value: "" };
    }
    return step;
  });
}

type Step3PlanStepRef = {
  kind: "totalClaim" | "step";
  blockIndex: number;
  stepIndex: number;
  key: string;
};

function collectStep3PlanRefs(plan: any): Step3PlanStepRef[] {
  const refs: Step3PlanStepRef[] = [];
  if (!plan || typeof plan !== "object") return refs;
  if (plan.mode === "total_then_points") {
    refs.push({
      kind: "totalClaim",
      blockIndex: -1,
      stepIndex: -1,
      key: "total_claim",
    });
  }
  const blocks = Array.isArray(plan.pointBlocks) ? plan.pointBlocks : [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const steps = Array.isArray(blocks[bi]?.steps) ? blocks[bi].steps : [];
    for (let si = 0; si < steps.length; si++) {
      refs.push({
        kind: "step",
        blockIndex: bi,
        stepIndex: si,
        key: String(steps[si]?.key || `${bi}:${si}`),
      });
    }
  }
  return refs;
}

function readStep3RefValue(plan: any, ref: Step3PlanStepRef): string {
  if (!plan || !ref) return "";
  if (ref.kind === "totalClaim") return String(plan.totalClaim || "");
  const step = plan.pointBlocks?.[ref.blockIndex]?.steps?.[ref.stepIndex];
  return String(step?.value || "");
}

function readStep3RefPlaceholder(plan: any, ref: Step3PlanStepRef): string {
  if (!plan || !ref || ref.kind === "totalClaim") return "";
  const step = plan.pointBlocks?.[ref.blockIndex]?.steps?.[ref.stepIndex];
  return String(step?.placeholder || "");
}

function isStep3RefFilled(plan: any, ref: Step3PlanStepRef): boolean {
  if (ref.kind === "totalClaim") {
    return isValidStep3StepValue(readStep3RefValue(plan, ref));
  }
  const step = plan.pointBlocks?.[ref.blockIndex]?.steps?.[ref.stepIndex];
  return isStep3Confirmed(step);
}

function clearStep3RefValue(plan: any, ref: Step3PlanStepRef): void {
  if (!plan || !ref) return;
  if (ref.kind === "totalClaim") {
    plan.totalClaim = "";
    return;
  }
  const step = plan.pointBlocks?.[ref.blockIndex]?.steps?.[ref.stepIndex];
  if (step) {
    step.value = "";
    step.status = "";
  }
}

/**
 * Provenance firewall: value may only newly fill / update the current target
 * (first NOT-confirmed step on previous board) + optional same-block adjacent
 * open step. Confirmed slots are frozen elsewhere; later empty slots must not
 * receive planning drafts in the same turn.
 */
export function guardStep3ValueProvenance(plan: any, prevPlan: any): number {
  if (!plan || !Array.isArray(plan.pointBlocks)) return 0;
  const refs = collectStep3PlanRefs(plan);
  if (refs.length === 0) return 0;

  let targetIdx = -1;
  for (let i = 0; i < refs.length; i++) {
    const wasConfirmed = prevPlan ? isStep3RefFilled(prevPlan, refs[i]) : false;
    if (!wasConfirmed) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx < 0) return 0;

  const allowed = new Set<number>([targetIdx]);
  const target = refs[targetIdx];
  const next = refs[targetIdx + 1];
  if (
    next &&
    target.kind === "step" &&
    next.kind === "step" &&
    next.blockIndex === target.blockIndex &&
    next.stepIndex === target.stepIndex + 1
  ) {
    allowed.add(targetIdx + 1);
  }

  let cleared = 0;
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    const wasConfirmed = prevPlan ? isStep3RefFilled(prevPlan, refs[i]) : false;
    if (wasConfirmed) continue;
    const wasGenuine = prevPlan
      ? isGenuineStep3StepValue(
          prevPlan.pointBlocks?.[ref.blockIndex]?.steps?.[ref.stepIndex],
        )
      : false;
    const nowGenuine =
      ref.kind === "totalClaim"
        ? isValidStep3StepValue(readStep3RefValue(plan, ref))
        : isGenuineStep3StepValue(
            plan.pointBlocks?.[ref.blockIndex]?.steps?.[ref.stepIndex],
          );
    // Allow updating an already-draft target; only clear leaps into new slots.
    if (!wasGenuine && nowGenuine && !allowed.has(i)) {
      clearStep3RefValue(plan, ref);
      cleared += 1;
    }
  }
  return cleared;
}

export function guardFlatStep3ValueProvenance(
  steps: any[],
  prevSteps: any[],
): number {
  if (!Array.isArray(steps) || steps.length === 0) return 0;
  const prevByKey: Record<string, any> = {};
  (prevSteps || []).forEach((s: any, idx: number) => {
    prevByKey[String(s?.key || idx)] = s;
  });

  let targetIdx = -1;
  for (let i = 0; i < steps.length; i++) {
    const key = String(steps[i]?.key || i);
    const prev = prevByKey[key] || (prevSteps || [])[i];
    if (!isStep3Confirmed(prev)) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx < 0) return 0;

  const allowed = new Set<number>([targetIdx]);
  if (targetIdx + 1 < steps.length) allowed.add(targetIdx + 1);

  let cleared = 0;
  for (let i = 0; i < steps.length; i++) {
    const key = String(steps[i]?.key || i);
    const prev = prevByKey[key] || (prevSteps || [])[i];
    if (isStep3Confirmed(prev)) continue;
    const wasGenuine = isGenuineStep3StepValue(prev);
    const nowGenuine = isGenuineStep3StepValue(steps[i]);
    if (!wasGenuine && nowGenuine && !allowed.has(i)) {
      steps[i] = { ...steps[i], value: "", status: "" };
      cleared += 1;
    }
  }
  return cleared;
}

/**
 * Backfill only when the model left the target completely empty.
 * Do NOT overwrite a model rewrite of a draft slot — polish is allowed while
 * status is still draft; confirmation is gated separately.
 */
export function applyStudentAnswerToTargetStep(
  plan: any,
  prevPlan: any,
  userMessage: string,
): boolean {
  const answer = String(userMessage || "").trim();
  if (!plan || answer.length < 4) return false;
  if (isKickoffOrInstructionText(answer)) return false;
  const refs = collectStep3PlanRefs(plan);
  let targetIdx = -1;
  for (let i = 0; i < refs.length; i++) {
    const wasConfirmed = prevPlan ? isStep3RefFilled(prevPlan, refs[i]) : false;
    if (!wasConfirmed) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx < 0) return false;
  const ref = refs[targetIdx];
  if (ref.kind === "totalClaim") {
    if (isValidStep3StepValue(String(plan.totalClaim || ""))) return false;
    plan.totalClaim = answer;
    return true;
  }
  const step = plan.pointBlocks?.[ref.blockIndex]?.steps?.[ref.stepIndex];
  if (!step) return false;
  if (isGenuineStep3StepValue(step)) return false;
  step.value = answer;
  step.status = "draft";
  return true;
}

/** Once status=confirmed, value+status are frozen — later model rewrites ignored. */
function mergeStep3ValuePreserveConfirmed(prev: any, next: any): {
  value: string;
  status: "" | "draft" | "confirmed";
} {
  if (isStep3Confirmed(prev)) {
    return {
      value: String(prev.value || ""),
      status: "confirmed",
    };
  }
  const newVal = next && typeof next.value === "string" ? next.value : "";
  const newIsGenuine = isGenuineStep3StepValue({ ...next, value: newVal });
  if (!newIsGenuine) {
    const prevVal = prev && prev.value ? String(prev.value) : "";
    if (isGenuineStep3StepValue({ ...prev, value: prevVal })) {
      return {
        value: prevVal,
        status: normalizeStep3Status(prev?.status) || "draft",
      };
    }
    return { value: "", status: "" };
  }
  const nextStatus = normalizeStep3Status(next?.status);
  return {
    value: newVal,
    status: nextStatus === "confirmed" ? "confirmed" : "draft",
  };
}

function mergeFrozenPlanTopLevelString(prevVal: unknown, nextVal: unknown): string {
  const prev = String(prevVal || "").trim();
  const next = String(nextVal || "").trim();
  if (prev && isValidStep3StepValue(prev)) return prev;
  if (next && isValidStep3StepValue(next)) return next;
  return "";
}

/** Merge step values: freeze only confirmed slots; draft slots may update. */
export function mergeLogicStepValues(prevSteps: any[] = [], nextSteps: any[] = []): any[] {
  const prevByKey: Record<string, any> = {};
  prevSteps.forEach((s: any, idx: number) => {
    prevByKey[String(s?.key || idx)] = s;
  });
  return nextSteps.map((s: any, index: number) => {
    const key = String(s?.key || index);
    const prev = prevByKey[key] || prevSteps[index];
    const merged = mergeStep3ValuePreserveConfirmed(prev, s);
    return { ...prev, ...s, value: merged.value, status: merged.status };
  });
}

/** Safety net: restore confirmed values the model tried to rewrite this turn. */
export function restoreFrozenFlatSteps(steps: any[], prevSteps: any[]): number {
  if (!Array.isArray(steps) || steps.length === 0) return 0;
  const prevByKey: Record<string, any> = {};
  (prevSteps || []).forEach((s: any, idx: number) => {
    prevByKey[String(s?.key || idx)] = s;
  });
  let restored = 0;
  for (let i = 0; i < steps.length; i++) {
    const key = String(steps[i]?.key || i);
    const prev = prevByKey[key] || (prevSteps || [])[i];
    if (!isStep3Confirmed(prev)) continue;
    const prevVal = String(prev.value || "");
    const nowVal = String(steps[i]?.value || "");
    const statusChanged = normalizeStep3Status(steps[i]?.status) !== "confirmed";
    if (
      statusChanged ||
      (nowVal.trim() &&
        normalizeForEchoCompare(nowVal) !== normalizeForEchoCompare(prevVal))
    ) {
      steps[i] = { ...steps[i], value: prevVal, status: "confirmed" };
      restored += 1;
    }
  }
  return restored;
}

/** Safety net: restore confirmed paragraphPlan values after merge/guard. */
export function restoreFrozenParagraphPlanValues(plan: any, prevPlan: any): number {
  if (!plan || !prevPlan || typeof plan !== "object") return 0;
  let restored = 0;

  const prevTc = String(prevPlan.totalClaim || "").trim();
  if (prevTc && isValidStep3StepValue(prevTc)) {
    const nowTc = String(plan.totalClaim || "").trim();
    if (nowTc && normalizeForEchoCompare(nowTc) !== normalizeForEchoCompare(prevTc)) {
      plan.totalClaim = prevTc;
      restored += 1;
    }
  }

  const prevClosing = String(prevPlan.optionalShortClosing || "").trim();
  if (prevClosing && isValidStep3StepValue(prevClosing)) {
    const nowClosing = String(plan.optionalShortClosing || "").trim();
    if (
      nowClosing &&
      normalizeForEchoCompare(nowClosing) !== normalizeForEchoCompare(prevClosing)
    ) {
      plan.optionalShortClosing = prevClosing;
      restored += 1;
    }
  }

  const prevBlocks = Array.isArray(prevPlan.pointBlocks) ? prevPlan.pointBlocks : [];
  const nextBlocks = Array.isArray(plan.pointBlocks) ? plan.pointBlocks : [];
  for (const prevBlock of prevBlocks) {
    const match = nextBlocks.find(
      (b: any) => b?.id && prevBlock?.id && String(b.id) === String(prevBlock.id),
    );
    if (!match || !Array.isArray(prevBlock.steps)) continue;
    const prevSteps = prevBlock.steps;
    const nextSteps = Array.isArray(match.steps) ? match.steps : [];
    for (const prevStep of prevSteps) {
      if (!prevStep?.key || !isStep3Confirmed(prevStep)) continue;
      const nextStep = nextSteps.find((s: any) => String(s?.key) === String(prevStep.key));
      if (!nextStep) continue;
      const prevVal = String(prevStep.value || "");
      const nowVal = String(nextStep.value || "");
      const statusChanged = normalizeStep3Status(nextStep.status) !== "confirmed";
      if (
        statusChanged ||
        (nowVal.trim() &&
          normalizeForEchoCompare(nowVal) !== normalizeForEchoCompare(prevVal))
      ) {
        nextStep.value = prevVal;
        nextStep.status = "confirmed";
        restored += 1;
      }
    }
  }

  if (restored > 0 && typeof console !== "undefined") {
    console.warn(
      `[Step3Guard] Restored ${restored} frozen confirmed value(s) the model attempted to rewrite.`,
    );
  }
  return restored;
}

/**
 * Union-merge paragraphPlan.pointBlocks: update blocks present in nextPlan,
 * but preserve prev blocks the model omitted this turn (prevents multi-point
 * Body 1 from shrinking to one block and falsely completing early).
 */
export function mergeParagraphPlanPreserveBlocks(prevPlan: any, nextPlan: any): any {
  if (!nextPlan || !Array.isArray(nextPlan.pointBlocks)) {
    return prevPlan || nextPlan;
  }

  const prevBlocks = Array.isArray(prevPlan?.pointBlocks) ? prevPlan.pointBlocks : [];
  const prevById: Record<string, any> = {};
  prevBlocks.forEach((b: any) => {
    if (b?.id) prevById[String(b.id)] = b;
  });

  const usedPrevIndices = new Set<number>();
  const mergedFromNext = nextPlan.pointBlocks.map((block: any, index: number) => {
    let prev: any;
    let prevIndex = -1;
    if (block?.id && prevById[String(block.id)]) {
      prev = prevById[String(block.id)];
      prevIndex = prevBlocks.findIndex(
        (b: any) => b && String(b.id) === String(block.id),
      );
    } else if (prevBlocks[index] && !usedPrevIndices.has(index)) {
      prev = prevBlocks[index];
      prevIndex = index;
    }
    if (prevIndex >= 0) usedPrevIndices.add(prevIndex);

    return {
      ...prev,
      ...block,
      steps: mergeLogicStepValues(prev?.steps || [], block?.steps || []),
    };
  });

  const preservedTail: any[] = [];
  prevBlocks.forEach((block: any, index: number) => {
    if (usedPrevIndices.has(index)) return;
    preservedTail.push({
      ...block,
      steps: Array.isArray(block?.steps)
        ? block.steps.map((s: any) => ({ ...s }))
        : [],
    });
  });

  if (preservedTail.length > 0 && typeof console !== "undefined") {
    console.warn(
      `[Step3PlanMerge] Preserved ${preservedTail.length} pointBlock(s) omitted from model turn`,
    );
  }

  return {
    ...prevPlan,
    ...nextPlan,
    totalClaim: mergeFrozenPlanTopLevelString(
      prevPlan?.totalClaim,
      nextPlan.totalClaim,
    ),
    optionalShortClosing: mergeFrozenPlanTopLevelString(
      prevPlan?.optionalShortClosing,
      nextPlan.optionalShortClosing,
    ),
    pointBlocks: [...mergedFromNext, ...preservedTail],
  };
}

/** Body N is selectable only when all prior bodies are genuinely completed. */
export function canSelectSubpoint(subpoints: any[], targetId: string): boolean {
  const idx = subpoints.findIndex((sp) => sp.id === targetId);
  if (idx <= 0) return true;
  for (let i = 0; i < idx; i++) {
    if (!isSubpointGenuinelyComplete(subpoints[i])) return false;
  }
  return true;
}

export function firstIncompleteSubpointIndex(subpoints: any[]): number {
  const idx = subpoints.findIndex((sp) => !isSubpointGenuinelyComplete(sp));
  return idx >= 0 ? idx : subpoints.length;
}

/** True only when this body has all slots confirmed (not merely non-empty). */
export function isSubpointQualityComplete(sp: any): boolean {
  if (!sp) return false;
  if (sp.paragraphPlan) return isParagraphPlanQualityFilled(sp.paragraphPlan);
  if (Array.isArray(sp.structureSteps) && sp.structureSteps.length > 0) {
    return sp.structureSteps.every((step: any) => isStep3Confirmed(step));
  }
  return false;
}

function isSubstantiveStudentChatText(text: string): boolean {
  const t = String(text || "").trim();
  if (t.length < 4) return false;
  if (isKickoffOrInstructionText(t)) return false;
  return !/^(对|是|是的|对的|好的|嗯|明白|好|继续|下一步|ok|okay|yes)$/i.test(t);
}

/** At least one real student utterance in this body's own chatHistory. */
export function subpointHasStudentDialogue(sp: any): boolean {
  const hist = Array.isArray(sp?.chatHistory) ? sp.chatHistory : [];
  return hist.some(
    (m: any) =>
      m?.sender === "user" && isSubstantiveStudentChatText(String(m?.text || "")),
  );
}

/**
 * Body unlock / completion requires BOTH a quality-filled board AND real
 * student dialogue in that body. Prevents kickoff-only / model-only boards
 * from unlocking Body 2 and completing Step 3.
 */
export function isSubpointGenuinelyComplete(
  sp: any,
  options?: { currentUserMessage?: string; isHiddenKickoff?: boolean },
): boolean {
  if (!isSubpointQualityComplete(sp)) return false;
  if (options?.isHiddenKickoff) return false;
  if (subpointHasStudentDialogue(sp)) return true;
  const msg = String(options?.currentUserMessage || "").trim();
  return isSubstantiveStudentChatText(msg);
}

/** Keep plan skeleton; wipe every confirmed value and status. */
export function clearAllStep3PlanValues(plan: any): void {
  if (!plan || typeof plan !== "object") return;
  plan.totalClaim = "";
  if (!Array.isArray(plan.pointBlocks)) return;
  for (const block of plan.pointBlocks) {
    if (!Array.isArray(block?.steps)) continue;
    for (const step of block.steps) {
      if (step && typeof step === "object") {
        step.value = "";
        step.status = "";
      }
    }
  }
}

/**
 * Infer how many Step 3 bodies Step 2 planned. Prefer clusters → bodies[] →
 * body1/body2 → A面/B面 markers.
 */
export function inferExpectedStep3BodyCount(session: any): number {
  const clusters = session?.step2?.coachEvaluation?.clustering?.clusters;
  if (Array.isArray(clusters) && clusters.length > 0) return clusters.length;

  const blueprint =
    session?.step2?.coachEvaluation?.blueprint || session?.step2?.blueprint || {};
  const bodies = Array.isArray(blueprint?.bodies)
    ? blueprint.bodies.filter(
        (b: any) => String(b?.content || b?.title || "").trim().length > 0,
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

/** Whole Step 3 unlock: enough bodies AND every body quality-filled with dialogue. */
export function isStep3FullyComplete(session: any, subpoints: any[]): boolean {
  if (!Array.isArray(subpoints) || subpoints.length === 0) return false;
  const expected = inferExpectedStep3BodyCount(session);
  if (expected > 0 && subpoints.length < expected) return false;
  return subpoints.every((sp) => isSubpointGenuinelyComplete(sp));
}
