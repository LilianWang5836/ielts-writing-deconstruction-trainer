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

export function isStep3AffirmativeConfirmation(msg: string): boolean {
  const t = String(msg || "").trim();
  return /^(对|是|是的|对的|好的|好|嗯|没问题|可以|确认|就是这个意思|符合我的意思|ok|okay|yes)[。.!！]?$/i.test(
    t,
  );
}

function isSubstantiveStep3AnswerLocal(msg: string): boolean {
  const t = String(msg || "").trim();
  if (t.length < 4) return false;
  if (isKickoffOrInstructionText(t)) return false;
  return !/^(对|是|是的|对的|好的|嗯|明白|好|继续|下一步|ok|okay|yes)$/i.test(t);
}

function isConfirmContentSubstantiveLocal(value: string): boolean {
  const t = String(value || "").trim();
  if (t.length < 8) return false;
  return isSubstantiveStep3AnswerLocal(t);
}

/**
 * Auto-promote a draft target the model itself never flipped to confirmed.
 * Two acceptance signals, either one is enough:
 *  A) the student explicitly affirms it ("对/可以/没问题"...), or
 *  B) the target's value is left untouched this turn AND the conversation
 *     genuinely advanced — a LATER step in the same block newly gained
 *     genuine content — implying nobody objected and work moved on.
 * Reuses the same substantive-content bar as resolveStep3StepConfirmation so
 * a thin/off-topic draft is never frozen just because the student moved on.
 */
export function promoteAcknowledgedStep3DraftTarget(
  plan: any,
  prevPlan: any,
  userMessage: string,
): number {
  if (!plan || !prevPlan || !Array.isArray(plan.pointBlocks)) return 0;
  const refs = collectStep3PlanRefs(prevPlan);
  let targetIdx = -1;
  for (let i = 0; i < refs.length; i++) {
    if (!isStep3RefFilled(prevPlan, refs[i])) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx < 0) return 0;
  const ref = refs[targetIdx];
  if (ref.kind !== "step") return 0;

  const prevStep = prevPlan.pointBlocks?.[ref.blockIndex]?.steps?.[ref.stepIndex];
  if (!isGenuineStep3StepValue(prevStep)) return 0;

  const block = plan.pointBlocks?.[ref.blockIndex];
  const nowStep = block?.steps?.[ref.stepIndex];
  if (!nowStep || isStep3Confirmed(nowStep) || !isGenuineStep3StepValue(nowStep)) {
    return 0;
  }

  const valueUnchanged =
    normalizeForEchoCompare(String(nowStep.value || "")) ===
    normalizeForEchoCompare(String(prevStep.value || ""));
  const studentAffirmed = isStep3AffirmativeConfirmation(userMessage);

  const prevSiblingSteps = Array.isArray(prevPlan.pointBlocks?.[ref.blockIndex]?.steps)
    ? prevPlan.pointBlocks[ref.blockIndex].steps
    : [];
  const nowSiblingSteps = Array.isArray(block?.steps) ? block.steps : [];
  let laterStepAdvanced = false;
  for (let i = ref.stepIndex + 1; i < nowSiblingSteps.length; i++) {
    if (
      !isGenuineStep3StepValue(prevSiblingSteps[i]) &&
      isGenuineStep3StepValue(nowSiblingSteps[i])
    ) {
      laterStepAdvanced = true;
      break;
    }
  }

  if (!studentAffirmed && !(valueUnchanged && laterStepAdvanced)) return 0;
  if (!isConfirmContentSubstantiveLocal(String(nowStep.value || ""))) return 0;

  nowStep.status = "confirmed";
  return 1;
}

/** Flat-array counterpart of promoteAcknowledgedStep3DraftTarget (no paragraphPlan). */
export function promoteAcknowledgedFlatStep3Target(
  steps: any[],
  prevSteps: any[],
  userMessage: string,
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

  const key = String(steps[targetIdx]?.key || targetIdx);
  const prevStep = prevByKey[key] || (prevSteps || [])[targetIdx];
  if (!isGenuineStep3StepValue(prevStep)) return 0;

  const nowStep = steps[targetIdx];
  if (!nowStep || isStep3Confirmed(nowStep) || !isGenuineStep3StepValue(nowStep)) {
    return 0;
  }

  const valueUnchanged =
    normalizeForEchoCompare(String(nowStep.value || "")) ===
    normalizeForEchoCompare(String(prevStep.value || ""));
  const studentAffirmed = isStep3AffirmativeConfirmation(userMessage);

  let laterStepAdvanced = false;
  for (let i = targetIdx + 1; i < steps.length; i++) {
    const k = String(steps[i]?.key || i);
    const prevSib = prevByKey[k] || (prevSteps || [])[i];
    if (!isGenuineStep3StepValue(prevSib) && isGenuineStep3StepValue(steps[i])) {
      laterStepAdvanced = true;
      break;
    }
  }

  if (!studentAffirmed && !(valueUnchanged && laterStepAdvanced)) return 0;
  if (!isConfirmContentSubstantiveLocal(String(nowStep.value || ""))) return 0;

  steps[targetIdx] = { ...nowStep, status: "confirmed" };
  return 1;
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
    if (!Array.isArray(match.steps)) match.steps = [];
    const prevSteps = prevBlock.steps;
    const nextSteps = match.steps;
    prevSteps.forEach((prevStep: any, prevIndex: number) => {
      if (!prevStep?.key || !isStep3Confirmed(prevStep)) return;
      const nextStep = nextSteps.find((s: any) => String(s?.key) === String(prevStep.key));
      if (!nextStep) {
        // The model's new turn dropped this key entirely (e.g. flat-chain
        // re-wrap or a re-generated block). A confirmed slot must never
        // silently vanish — re-insert it at its previous position.
        const insertAt = Math.min(prevIndex, nextSteps.length);
        nextSteps.splice(insertAt, 0, { ...prevStep });
        restored += 1;
        return;
      }
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
    });
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

function frameworkLabelCore(text: string): string {
  return String(text || '')
    .replace(/[（(][^（）()]*[）)]/g, '')
    .replace(/详写|略写|放下|已选|保留-|用户放弃/g, '')
    .trim();
}

function frameworkLabelsMatch(a: string, b: string): boolean {
  const x = frameworkLabelCore(a);
  const y = frameworkLabelCore(b);
  if (x.length < 2 || y.length < 2) return false;
  return (
    x === y ||
    x.includes(y) ||
    y.includes(x) ||
    (x.length >= 4 && y.includes(x.slice(0, 4))) ||
    (y.length >= 4 && x.includes(y.slice(0, 4)))
  );
}

/**
 * The paragraph's framework (subpoint.points + pointRoles, planner-derived
 * ledger) is the block authority — the coach LLM may narrate a paragraph with
 * fewer angles (e.g. still believing its own "网络普及不独立成段" story from
 * Step2 prose) and emit a plan that silently drops a mapped point's block.
 * Append a synthesized block for every non-dropped framework point that no
 * block represents. Returns the labels appended.
 */
export function ensureParagraphPlanCoversFrameworkPoints(
  plan: any,
  subpoint: any,
): string[] {
  if (!plan || !Array.isArray(plan.pointBlocks) || !plan.pointBlocks.length) {
    return [];
  }
  const points: string[] = Array.isArray(subpoint?.points)
    ? subpoint.points.map((p: any) => String(p || '').trim()).filter(Boolean)
    : [];
  if (!points.length) return [];
  const roleOf = new Map<string, string>();
  (Array.isArray(subpoint?.pointRoles) ? subpoint.pointRoles : []).forEach(
    (r: any) => {
      const key = frameworkLabelCore(String(r?.point || ''));
      if (key) roleOf.set(key, String(r?.role || '').trim());
    },
  );

  const appended: string[] = [];
  for (const point of points) {
    const role = roleOf.get(frameworkLabelCore(point)) || '';
    if (role === 'dropped' || role === 'drop') continue;
    const represented = plan.pointBlocks.some(
      (b: any) =>
        frameworkLabelsMatch(String(b?.label || ''), point) ||
        frameworkLabelsMatch(String(b?.subClaim || ''), point),
    );
    if (represented) continue;
    const bid = `fw-${plan.pointBlocks.length + 1}-${frameworkLabelCore(point).slice(0, 6)}`;
    const isDetail = role === 'detail';
    plan.pointBlocks.push({
      id: bid,
      label: frameworkLabelCore(point) || point,
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
              placeholder: '用一两句带过此略写点',
              value: '',
            },
          ],
    });
    appended.push(frameworkLabelCore(point) || point);
  }
  return appended;
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

/** Required argument beats per Step-2 argumentRelation (design-time table). */
export const ARGUMENT_RELATION_BEATS: Record<string, string[]> = {
  supports: [],
  elaborates: [],
  concedes: [
    "承认反面确实存在",
    "说明为何该反面不足以推翻整体立场",
  ],
  compares: [
    "说明双方各自情况",
    "指出关键差异",
    "得出孰优孰劣",
  ],
  solves: [
    "说明问题或不足",
    "提出具体方案",
    "论证方案为何有效",
  ],
};

export function resolveArgumentRelation(frameworkOrSubpoint: any): string {
  const rel = String(
    frameworkOrSubpoint?.argumentRelation ||
      frameworkOrSubpoint?.stanceRelation ||
      "",
  ).trim();
  if (rel && Object.prototype.hasOwnProperty.call(ARGUMENT_RELATION_BEATS, rel)) {
    return rel;
  }
  return "";
}

export function getRequiredBeatsForRelation(relation: string): string[] {
  const key = String(relation || "").trim();
  if (!key) return [];
  return ARGUMENT_RELATION_BEATS[key] ? [...ARGUMENT_RELATION_BEATS[key]] : [];
}

/** Whole-essay fingerprint that invalidates Step 3 when Step 2 converge changes. */
export function computeEssayFrameworkSignature(session: any): string {
  const clustering =
    session?.step2?.coachEvaluation?.clustering || session?.step2?.clustering || {};
  const blueprint =
    session?.step2?.coachEvaluation?.blueprint || session?.step2?.blueprint || {};
  const stance = String(
    session?.step2?.coachEvaluation?.userStance ||
      session?.step2?.userStance ||
      blueprint?.position ||
      "",
  ).trim();
  const bodyCount = String(
    clustering?.bodyCount || blueprint?.bodyCount || "",
  ).trim();
  const layout = String(
    clustering?.layoutPattern || blueprint?.layoutPattern || "",
  ).trim();
  const clusterSig = (Array.isArray(clustering?.clusters) ? clustering.clusters : [])
    .map((c: any) =>
      [
        String(c?.targetBody || "").trim(),
        String(c?.paragraphDensity || "").trim(),
        resolveArgumentRelation(c),
        Array.isArray(c?.points)
          ? c.points.map((p: any) => String(p || "").trim()).filter(Boolean).join("|")
          : "",
      ].join("~"),
    )
    .join(";");
  return [stance, bodyCount, layout, clusterSig].join("::");
}

/**
 * Theme / structural key for framework fingerprinting.
 * Must NOT include confirmed claim sentences — those change during Step3 dialogue
 * (pending → affirm) and must not look like a Planner framework change.
 */
export function resolveFrameworkThemeKey(subpoint: any): string {
  const theme = String(subpoint?.theme || "").trim();
  if (theme) return theme;
  const content = String(subpoint?.content || "").trim();
  const placeholder = content.match(/^（主题：(.+?)，待确认论点句）$/);
  if (placeholder) return String(placeholder[1] || "").trim();
  // Bare short heads only; full claim sentences are runtime board state, not framework.
  if (
    content &&
    content.length <= 16 &&
    !/是|能|会|应该|因为|所以|导致|使得|牺牲|降低|提升/.test(content)
  ) {
    return content;
  }
  return "";
}

/** Stable fingerprint for Step 2 → Step 3 body framework handoff. */
export function computeSubpointFrameworkSignature(
  subpoint: any,
  session?: any,
): string {
  if (!subpoint) return "";
  const roles = Array.isArray(subpoint.pointRoles)
    ? subpoint.pointRoles
        .map(
          (r: any) =>
            `${String(r?.point || "").trim()}:${String(r?.role || "").trim()}`,
        )
        .filter(Boolean)
        .join(";")
    : "";
  const points = Array.isArray(subpoint.points)
    ? subpoint.points.map((p: any) => String(p || "").trim()).filter(Boolean).join("|")
    : "";
  const essaySig = session ? computeEssayFrameworkSignature(session) : "";
  return [
    String(subpoint.id || "").trim(),
    resolveFrameworkThemeKey(subpoint),
    String(subpoint.targetBody || "").trim(),
    String(subpoint.paragraphDensity || "").trim(),
    resolveArgumentRelation(subpoint),
    String(subpoint.stanceRelation || "").trim(),
    roles,
    points,
    essaySig,
  ].join("::");
}

/** @deprecated Prefer beat coverage via ARGUMENT_RELATION_BEATS; kept for label heuristics. */
export function isConcessionStepLabel(label: string): boolean {
  const t = String(label || "").trim();
  if (!t) return false;
  return /让步|限制|缓解|削弱|反驳|转折|局限|可克服|可缓解|concession|rebuttal|limitation|mitig/i.test(
    t,
  );
}

/** Whether a step label/value covers a required argument beat (semantic fuzzy match). */
export function stepCoversArgumentBeat(
  step: { label?: string; key?: string; value?: string; placeholder?: string },
  beat: string,
): boolean {
  const beatText = String(beat || "").trim();
  if (!beatText) return false;
  const hay = [
    step?.label,
    step?.key,
    step?.value,
    step?.placeholder,
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .join(" ");
  if (!hay) return false;

  const beatNorm = beatText.replace(/\s+/g, "").toLowerCase();
  const hayNorm = hay.replace(/\s+/g, "").toLowerCase();
  if (hayNorm.includes(beatNorm) || beatNorm.includes(hayNorm)) return true;

  // Keyword families per known beat (generic, not concession-only).
  const families: Array<{ beatRe: RegExp; stepRe: RegExp }> = [
    {
      beatRe: /承认|反面|对立|确实存在/,
      stepRe: /承认|让步|反面|对立|确实|存在|对方|另一面/,
    },
    {
      beatRe: /不足以|推翻|整体立场|削弱|限制|缓解/,
      stepRe: /不足以|推翻|削弱|限制|缓解|局限|可克服|转折|反驳|mitig|limit|rebut/i,
    },
    {
      beatRe: /双方|对比|各自/,
      stepRe: /双方|对比|比较|各自|对照|compare/i,
    },
    {
      beatRe: /差异|差别/,
      stepRe: /差异|差别|不同|区别|difference/i,
    },
    {
      beatRe: /孰优|孰劣|更优|更好|结论/,
      stepRe: /孰优|孰劣|更优|更好|结论|综合|权衡|prefer/i,
    },
    {
      beatRe: /问题|不足/,
      stepRe: /问题|不足|缺陷|痛点|problem|gap/i,
    },
    {
      beatRe: /方案|措施|解决/,
      stepRe: /方案|措施|解决|对策|solution|remed/i,
    },
    {
      beatRe: /为何有效|有效性|论证方案/,
      stepRe: /有效|为何|可行性|效果|work|effect/i,
    },
  ];
  for (const f of families) {
    if (f.beatRe.test(beatText) && f.stepRe.test(hay)) return true;
  }
  return false;
}
