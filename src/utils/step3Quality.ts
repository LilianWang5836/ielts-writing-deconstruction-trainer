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
  return plan.pointBlocks.every(
    (block: any) =>
      Array.isArray(block?.steps) &&
      block.steps.length > 0 &&
      block.steps.every((step: any) => isGenuineStep3StepValue(step)),
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
  const value = readStep3RefValue(plan, ref);
  if (ref.kind === "totalClaim") return isValidStep3StepValue(value);
  return (
    isValidStep3StepValue(value) &&
    !isPlaceholderEchoValue(value, readStep3RefPlaceholder(plan, ref))
  );
}

function clearStep3RefValue(plan: any, ref: Step3PlanStepRef): void {
  if (!plan || !ref) return;
  if (ref.kind === "totalClaim") {
    plan.totalClaim = "";
    return;
  }
  const step = plan.pointBlocks?.[ref.blockIndex]?.steps?.[ref.stepIndex];
  if (step) step.value = "";
}

/**
 * Provenance firewall: value may only newly fill for the current target step
 * (first empty on previous board) + optional same-block adjacent next step.
 * Planning drafts must not leak into later empty steps in the same turn.
 */
export function guardStep3ValueProvenance(plan: any, prevPlan: any): number {
  if (!plan || !Array.isArray(plan.pointBlocks)) return 0;
  const refs = collectStep3PlanRefs(plan);
  if (refs.length === 0) return 0;

  let targetIdx = -1;
  for (let i = 0; i < refs.length; i++) {
    const wasFilled = prevPlan ? isStep3RefFilled(prevPlan, refs[i]) : false;
    if (!wasFilled) {
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
    const wasFilled = prevPlan ? isStep3RefFilled(prevPlan, ref) : false;
    const nowFilled = isStep3RefFilled(plan, ref);
    if (!wasFilled && nowFilled && !allowed.has(i)) {
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
    if (!isGenuineStep3StepValue(prev)) {
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
    const wasFilled = isGenuineStep3StepValue(prev);
    const nowFilled = isGenuineStep3StepValue(steps[i]);
    if (!wasFilled && nowFilled && !allowed.has(i)) {
      steps[i] = { ...steps[i], value: "" };
      cleared += 1;
    }
  }
  return cleared;
}

/**
 * Prefer the student's raw utterance for THIS turn's target step (first empty
 * on the previous board), overwriting any model paraphrase in that slot.
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
    const wasFilled = prevPlan ? isStep3RefFilled(prevPlan, refs[i]) : false;
    if (!wasFilled) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx < 0) return false;
  const ref = refs[targetIdx];
  if (ref.kind === "totalClaim") {
    plan.totalClaim = answer;
    return true;
  }
  const step = plan.pointBlocks?.[ref.blockIndex]?.steps?.[ref.stepIndex];
  if (!step) return false;
  step.value = answer;
  return true;
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

/** True only when this body has a quality-filled board (not a stale isCompleted flag). */
export function isSubpointQualityComplete(sp: any): boolean {
  if (!sp) return false;
  if (sp.paragraphPlan) return isParagraphPlanQualityFilled(sp.paragraphPlan);
  if (Array.isArray(sp.structureSteps) && sp.structureSteps.length > 0) {
    return sp.structureSteps.every((step: any) => isGenuineStep3StepValue(step));
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

/** Keep plan skeleton; wipe every confirmed value. */
export function clearAllStep3PlanValues(plan: any): void {
  if (!plan || typeof plan !== "object") return;
  plan.totalClaim = "";
  if (!Array.isArray(plan.pointBlocks)) return;
  for (const block of plan.pointBlocks) {
    if (!Array.isArray(block?.steps)) continue;
    for (const step of block.steps) {
      if (step && typeof step === "object") step.value = "";
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
