export interface Topic {
  id: string;
  question: string;
  topic: 'Education' | 'Technology' | 'Environment' | 'Government' | 'Health' | 'Media' | 'Crime' | 'Culture' | 'Work';
  questionType: 'Agree / Disagree' | 'Discuss Both Views' | 'Advantages / Disadvantages' | 'Two-part Question' | 'Problem / Solution' | 'Positive / Negative' | 'Other';
  difficulty: 'Easy' | 'Medium' | 'Hard';
}

export interface TopicAnalysis {
  questionType: string;
  isCorrectType: boolean;
  correctType: string;
  coreIssue: string;
  constraints: string[];
  explanation: string;
}

export interface Dimension {
  id: string;
  name: string;
  prompt: string; // e.g. "accessibility (who can access)"
  selected: boolean;
  isCustom?: boolean;
}

export interface ArgumentSeed {
  id: string;
  dimension: string;
  direction: 'SUPPORT' | 'AGAINST' | 'MIXED';
  mechanism: string; // e.g. "more rural students reach education"
  scope: string; // e.g. "removes distance constraint"
}

export interface ArgumentBundle {
  id: string;
  name: string; // e.g. "Option A"
  seeds: ArgumentSeed[];
  implicitImpact: string; // e.g. "positive impact"
}

export interface ThesisOption {
  id: string;
  thesis: string;
  strength: string; // "Strong" | "Balanced" | "Weak"
  logicFlow: string;
}

export interface Template {
  id: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  name: string;
  structure: string; // e.g. "Claim -> Reason -> Mechanism -> Result"
  description: string;
  exampleTopic: string;
  exampleElements: {
    claim: string;
    reason: string;
    mechanism?: string;
    example?: string;
    result?: string;
    contrast?: string;
    concession?: string;
    definition?: string;
    affectedGroup?: string;
    evaluation?: string;
  };
  keywords: string[];
}

export interface ArgumentationFeedback {
  structure: {
    claim: boolean;
    reason: boolean;
    mechanism: boolean;
    example: boolean;
    result: boolean;
    evaluation: boolean;
    concession: boolean;
    contrast: boolean;
    definition: boolean;
    affectedGroup: boolean;
  };
  missingElements: string[];
  socraticQuestions: string[];
  suggestedChain: {
    claim: string;
    reason: string;
    mechanism?: string;
    example?: string;
    result?: string;
    evaluation?: string;
    concession?: string;
    contrast?: string;
    definition?: string;
    affectedGroup?: string;
  };
  critique: string;
}

/** Span highlight on Step4 Chinese concept (S/V/O sets only). */
export interface ConceptHighlightSpan {
  /** Inclusive start index in `concept`. */
  start: number;
  /** Exclusive end index in `concept`. */
  end: number;
  /** Grammatical role within a clause. */
  role: 'S' | 'V' | 'O';
  /**
   * Display priority:
   * - core: logical main-clause S/V/O (brightest + underline)
   * - subordinate: other clause S/V/O
   */
  tier: 'core' | 'subordinate';
}

export interface SentencePracticeTask {
  id: string;
  concept: string; // e.g. "Students have the flexibility to manage their study schedules"
  /** e.g. intro | body1 | body2 | body3 | … | conclusion */
  section: string;
  prompts: string[]; // Lexical cues: "have the flexibility to...", "manage study schedules"
  /** Optional concept highlights for S/V/O + conjunctions (generated with tasks). */
  highlights?: ConceptHighlightSpan[];
  userDraft?: string;
  confirmedSentence?: string;
  confirmed?: boolean;
  hasBeenChecked?: boolean;
  contentAlignment?: {
    status: 'aligned' | 'partial' | 'mismatched';
    summary: string;
    coveredPoints: string[];
    missingPoints: string[];
    extraPoints: string[];
  };
  annotations?: {
    text: string;
    category: 'grammar' | 'lexical' | 'wordOrder' | 'expression' | 'meaning';
    explanation: string;
  }[];
}

export interface InlineGuidanceResult {
  category: 'vocabulary' | 'grammar' | 'wordOrder' | 'expression';
  issue: string;
  hint: string;
}

export interface ChatMessage {
  id: string;
  sender: 'ai' | 'user';
  text: string;
  timestamp: string;
  isSplit?: boolean;
}

export interface LogicStep {
  key: string;
  label: string;
  placeholder: string;
  value?: string;
  /** draft = written but still updatable; confirmed = argument-ready and frozen. */
  status?: "draft" | "confirmed";
  /** True when the value was inherited from Step 2 (subClaim prefill), not a new student utterance. */
  inheritedFromStep2?: boolean;
}

/**
 * Step 3 LLM-owned slot quality judgment (unique eval source).
 * Server may only hard-reject staging/write; it must not re-judge narrative quality.
 */
export interface Step3SlotEval {
  activeKey: string;
  mode: "expand" | "confirm";
  qualified: boolean;
  /** Required when mode=confirm (single-slot) — polished draft awaiting student affirm. */
  pendingText?: string;
  /**
   * Optional multi-slot batch confirm: consecutive empty slots from firstEmpty
   * covered by the student's current utterance. When length ≥ 2, server stages
   * all of them; student「对」writes the whole batch. Single-slot may omit this
   * and use pendingText only.
   */
  pendingDrafts?: { activeKey: string; pendingText: string }[];
  rejectReason?: string;
}

export interface ParagraphPointBlock {
  id: string;
  label: string;
  subClaim: string;
  role: 'major' | 'minor';
  expansionStrategy: 'explanation' | 'example' | 'mechanism' | 'impact' | 'contrast' | 'hybrid';
  steps: LogicStep[];
  /**
   * P2a（merge 按 pointBlock id 对齐）：块绑定到的 Step2 mapped point id
   * （水合时按位置绑定）。稳定身份——label 被 reclass/确认改写后仍可对齐回原
   * mapped point，框架守卫/merge 优先按 id 匹配，label 文本降为兜底。
   */
  mappedPointId?: string;
}

export interface ParagraphPlan {
  mode: 'single_point' | 'total_then_points' | 'direct_points';
  diagnosis: string;
  totalClaim?: string;
  pointBlocks: ParagraphPointBlock[];
  optionalShortClosing?: string;
}

/** Internal Step 2 → Step 3 contract; never shown in student-facing UI. */
export type BodyParagraphDensity = 'single_point' | 'dual_point';
/** @deprecated Prefer ArgumentRelation; kept for older sessions. */
export type BodyStanceRelation = 'supports' | 'concedes';
/** Per-body argument relation chosen in Step 2 converge; drives Step 3 coverage beats. */
export type ArgumentRelation =
  | 'supports'
  | 'concedes'
  | 'compares'
  | 'solves'
  | 'elaborates';
export type EssayLayoutPattern =
  | 'concession_then_support'
  | 'thematic_split'
  | 'side_by_side'
  | 'custom';

export interface BodyPointRole {
  point: string;
  role: 'major' | 'minor';
}

/** Per-body essay skeleton from Step 2 summary (coach/internal only). */
export interface EssayBodyFramework {
  paragraphDensity?: BodyParagraphDensity;
  pointRoles?: BodyPointRole[];
  /** Preferred: relation type for required argument beats in Step 3. */
  argumentRelation?: ArgumentRelation;
  /** @deprecated Prefer argumentRelation. */
  stanceRelation?: BodyStanceRelation;
  /** Internal planning note — do not echo to students. */
  layoutRationale?: string;
}

export interface PracticeSession {
  id: string;
  topic: Topic;
  currentStep: number; // 1 to 4
  step1: {
    selectedType?: string;
    userCoreIssue?: string;
    analysis?: TopicAnalysis;
    userAnalysisNotes?: string; // User self-written analysis
    coachEvaluation?: {
      correctType: string;
      coreIssue: string;
      constraints: string[];
      critique: string;
      score: number;
      writingTask?: string;
      keyQualifier?: string;
      suggestedDimensions?: string[];
      /** Soft exit ask already offered (continue vs enter Step 2). */
      exitOffered?: boolean;
      /** AI/server: enough effective dimensions to offer exit. */
      dimensionsSufficient?: boolean;
      /** Silently skipped constraints when question has no hard qualifiers. */
      constraintsSkipped?: boolean;
      /**
       * Server-forced probe target (dimension core). Cleared after the next
       * student reply is resolved to at least （已探测）.
       */
      pendingProbeCore?: string;
      /**
       * LLM verdict for the pending probe target only: expandable | thin.
       * Server stamps tags from this; cleared after resolve.
       */
      probeVerdict?: string;
    };
    /** User edits on the right-side board; always win over later AI progressUpdate merges. */
    boardOverrides?: {
      correctType?: string;
      coreIssue?: string;
      writingTask?: string;
      keyQualifier?: string;
      constraints?: string[];
      suggestedDimensions?: string[];
    };
    isCompleted: boolean;
    chatHistory?: ChatMessage[];
  };
  step2: {
    dimensions: Dimension[];
    seeds: ArgumentSeed[];
    bundles: ArgumentBundle[];
    selectedBundleId?: string;
    thesisOptions: ThesisOption[];
    selectedThesis?: string;
    userStance?: string; // User self-written overall stance
    userPoints?: string; // User self-written sub-arguments
    currentStage?: 'explore_A' | 'explore_B' | 'stance' | 'summary';
    coachEvaluation?: {
      userStance: string;
      userPoints: string;
      currentStage?: 'explore_A' | 'explore_B' | 'stance' | 'summary';
      critique: string;
      suggestions: string[];
      suggestedStance: string;
      suggestedPoints: string;
      /**
       * Structured 详略 scheme from the LLM on the recommend turn (labels
       * copied from the frozen board). Transient — consumed by the proposal
       * channel; prose parsing / volume ranking are fallbacks only.
       */
      retentionSuggestion?: {
        detail?: string[];
        brief?: string[];
        drop?: string[];
        reason?: string;
      } | null;
      /**
       * Step2 → Planner material contract (single source of truth).
       * Parallel points + stance + coverage; no paragraph layout.
       */
      plannerPayload?: Step2PlannerPayload;
      /** From questionBrief.taskMap.explore_A — student-facing explore label. */
      taskLabelA?: string;
      /** From questionBrief.taskMap.explore_B — student-facing explore label. */
      taskLabelB?: string;
      /** Whether this essay needs the stance stage (server-stamped). */
      requiresStance?: boolean;
      /**
       * Ledger for Step1 （已探测）（可展开） dimensions:
       * expanded | merged | dropped | pending — silent omit forbidden.
       */
      dimensionDispositions?: {
        dimension: string;
        disposition: 'expanded' | 'merged' | 'dropped' | 'pending';
        side?: 'A' | 'B' | '';
        mergedInto?: string;
        note?: string;
      }[];
      blueprint?: {
        question: string;
        position: string;
        body1?: string;
        body2?: string;
        /** Internal: planned body count (2 or 3). */
        bodyCount?: number;
        /** Internal: whole-essay layout pattern. */
        layoutPattern?: EssayLayoutPattern;
        bodies?: (EssayBodyFramework & { title: string; content: string })[];
      };
      clustering?: {
        totalPoints: number;
        pointsList: string[];
        /** Internal: mirrors clusters.length; whole-essay layout. */
        bodyCount?: number;
        layoutPattern?: EssayLayoutPattern;
        clusters: (EssayBodyFramework & {
          theme: string;
          points: string[];
          targetBody: string;
          content: string;
        })[];
        outliers?: {
          point: string;
          suggestion: string;
          disposition?: 'dropped' | 'merged';
          mergedInto?: string;
        }[];
      };
      onlinePros?: string[];
      offlinePros?: string[];
      positionCheckPassed?: boolean;
      positionCheckDesc?: string;
      coverageCheckPassed?: boolean;
      coverageCheckDesc?: string;
      structureCheckPassed?: boolean;
      structureCheckDesc?: string;
    };
    isCompleted: boolean;
    chatHistory?: ChatMessage[];
  };
  step3: {
    selectedTemplateId?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
    userDraft?: string;
    subpoints: {
      id: string;
      content: string;
      points?: string[];
      targetBody?: string;
      theme?: string;
      /** Carried from Step 2 clustering; internal, not rendered in UI. */
      paragraphDensity?: BodyParagraphDensity;
      pointRoles?: BodyPointRole[];
      argumentRelation?: ArgumentRelation;
      stanceRelation?: BodyStanceRelation;
      layoutRationale?: string;
      /** Fingerprint of Step 2 framework handoff; used to invalidate stale plans. */
      frameworkSignature?: string;
      draft?: string;
      hint?: string;
      isCompleted: boolean;
      /** Server-authored: whether this body tab may be selected (sequential lock). */
      selectable?: boolean;
      claim?: string;
      mechanism?: string;
      result?: string;
      reason?: string;
      supportType?: 'example' | 'mechanism' | 'scenario';
      supportContent?: string;
      impact?: string;
      completenessChecks?: { label: string; passed: boolean; desc: string }[];
      transitionChecks?: { label: string; passed: boolean; desc: string }[];
      sufficiencyCheck?: { label: string; passed: boolean; desc: string };
      paragraphPlan?: ParagraphPlan;
      structureSteps?: LogicStep[];
      /**
       * Confirm-then-write pending drafts (chat-only). Server-synced from
       * validated step3SlotEval.pendingText; written only on student affirm.
       * Persisted across turns on this subpoint (including body switches).
       */
      kickoffPendingDrafts?: {
        key: string;
        label: string;
        text: string;
        blockIndex: number;
        stepIndex: number;
      }[];
      /** Last server hard-reject code (empty/theme_label/duplicate_sibling/…). */
      lastRejectCode?: string;
      /** Last model slot eval echoed for debugging / next-turn context. */
      step3SlotEval?: Step3SlotEval;
      chatHistory?: ChatMessage[];
    }[];
    activeSubpointId?: string;
    isCompleted: boolean;
    chatHistory?: ChatMessage[];
  };
  step4: {
    tasks: SentencePracticeTask[];
    isCompleted: boolean;
    chatHistory?: ChatMessage[];
  };
  /** Step 2.5 Planner 状态与产出 */
  step2_5?: Step2_5State;
  /**
   * Cross-step stable digests. Rebuilt only when sourceHash mismatches
   * (canonical fields changed, including boardOverrides). Never student-facing.
   */
  memory?: SessionMemory;
  createdAt: string;
}

/** Stable, hash-keyed snapshot of a prior step's converged state. */
export interface Step1Digest {
  sourceHash: string;
  updatedAt: string;
  questionType: string;
  coreIssue: string;
  constraints: string[];
  dimensions: string[];
  /** Slot names still missing or thin — ask only these. */
  openGaps: string[];
  filled: string[];
}

export interface Step2Digest {
  sourceHash: string;
  updatedAt: string;
  currentStage: string;
  thesis: string;
  userPoints: string;
  body1: string;
  body2: string;
  openGaps: string[];
  filled: string[];
}

export interface Step3Digest {
  sourceHash: string;
  updatedAt: string;
  activeSubpointId: string;
  filledStepCount: number;
  totalStepCount: number;
  /** Empty step labels still needing content. */
  openGaps: string[];
  filled: string[];
}

export interface SessionMemory {
  step1?: Step1Digest;
  step2?: Step2Digest;
  step3?: Step3Digest;
}

// ============================================================
// Step 2.5 Planner 类型
// ============================================================

export interface Step2_5State {
  status: 'idle' | 'running' | 'passed' | 'failed' | 'stale';
  startedAt?: number;
  updatedAt?: number;
  attempt?: number;
  planSignature?: string;
  plannerIntermediate?: {
    stance: string;
    argumentStrategy: string;
    argumentRelation: string;
    layoutPattern: string;
    bodyCount: number;
  };
  rationale?: string;
  bodyPlans: BodyPlan[];
  errorMessage?: string;
  /** True when the plan came from the programmatic fallback instead of the Planner LLM. */
  degraded?: boolean;
}

export interface BodyPlan {
  id: string;
  targetBody: string;
  role: string;
  theme?: string;
  content?: string;
  paragraphDensity?: 'single_point' | 'dual_point';
  argumentRelation?: string;
  pointRoles?: BodyPointRole[];
  mappedPoints?: string[];
  /** Ids into session.step2.coachEvaluation.plannerPayload.points */
  mappedPointIds?: string[];
  paragraphPlan: ParagraphPlan;
}

// ============================================================
// Step2 → Planner payload (材料契约)
// ============================================================

export type CoverageBucket =
  | 'view_a'
  | 'view_b'
  | 'advantage'
  | 'disadvantage'
  | 'cause'
  | 'solution'
  | 'positive'
  | 'negative'
  | 'part_1'
  | 'part_2'
  | 'support_main'
  | 'oppose_or_qualify'
  | 'general';

export type Step2StancePolarity =
  | 'agree'
  | 'disagree'
  | 'partial'
  | 'positive'
  | 'negative'
  | 'balanced'
  | 'outweigh_yes'
  | 'outweigh_no'
  | 'not_required'
  | 'unknown';

export type Step2StanceStrength = 'full' | 'qualified' | 'unknown';

/** Detail/brief role chosen in Step2 retention (详写 / 略写). */
export type Step2RetentionRole = 'detail' | 'brief' | 'dropped';

export interface Step2Point {
  id: string;
  claim: string;
  elaboration?: string;
  fromDimension?: string;
  leanTags: CoverageBucket[];
  quality: 'thin' | 'ready';
  /** 详写 / 略写 / 放下 — mirrored from userPoints retention tags */
  retentionRole?: Step2RetentionRole;
  /**
   * Elaboration came only from Step1 seed / kickoff model rewrite — not yet
   * expanded in a Step2 student content turn. Walk gates treat seedOnly as thin.
   * undefined = legacy (pre-flag) → treat as already expanded.
   */
  seedOnly?: boolean;
  sourceTurn?: number;
  supersededBy?: string;
}

/** Coach-proposed new board slot awaiting explicit student confirm. */
export interface Step2PendingSlotAdd {
  claim: string;
  elaboration?: string;
}

/** Single task-side / question bucket has ≥3 points — ask trim before stance. */
export interface Step2PendingCapacityTrim {
  sideKey: string;
  sideLabel: string;
  pointIds: string[];
  pointClaims: string[];
}

/** Coach-recommended stance awaiting UI 采纳/拒绝. */
export interface Step2PendingStanceConfirm {
  text: string;
}

/** Role assignment inside a side_settle proposal. */
export type Step2ProposalRole = 'detail' | 'brief' | 'dropped';

export type Step2ProposalKind =
  | 'side_settle'
  | 'slot_add'
  | 'slot_merge'
  | 'stance';

/** Structured decision object — UI/buttons bind this; never parse from chat text. */
export type Step2Proposal =
  | {
      proposalId: string;
      kind: 'side_settle';
      rationale?: string;
      createdTurn?: number;
      payload: {
        side: string;
        assignments: Array<{ slotId: string; role: Step2ProposalRole }>;
      };
    }
  | {
      proposalId: string;
      kind: 'slot_add';
      rationale?: string;
      createdTurn?: number;
      payload: {
        claim: string;
        side: string;
        body?: string;
      };
    }
  | {
      proposalId: string;
      kind: 'slot_merge';
      rationale?: string;
      createdTurn?: number;
      payload: {
        /** Slot being folded away (superseded on accept). */
        fromSlotId: string;
        /** Slot that receives the folded content. */
        intoSlotId: string;
      };
    }
  | {
      proposalId: string;
      kind: 'stance';
      rationale?: string;
      createdTurn?: number;
      payload: {
        text: string;
        polarity?: Step2StancePolarity;
      };
    };

export interface Step2PlannerPayload {
  version: 1;
  status: 'draft' | 'ready' | 'invalid';
  updatedAt: string;
  questionType: string;
  requiresStance: boolean;
  /**
   * When true, points[] slot count/labels are frozen from Step1 dimensions.
   * Later turns may only attach elaborations onto existing slots — never append
   * unless the student explicitly confirms a pendingSlotAdd.
   */
  slotsLocked?: boolean;
  /** Canonical claim labels for locked slots (Step1 dimension cores). */
  fixedClaims?: string[];
  /**
   * Student-confirmed claims added beyond Step1 dimensions.
   * Merged into the locked slot list so later turns do not supersede them away.
   */
  extraClaims?: string[];
  /**
   * Current discussion focus point id.
   * Used as mount fallback when string+semantic miss; hard-hang of raw
   * userMessage when focusMode === 'deepen'.
   */
  activePointId?: string;
  /**
   * deepen = coach is asking to flesh out one named point (thin-ask / 详写『X』).
   * none = everyday path: semantic mount → focus fallback → pendingSlotAdd (never silent-drop).
   */
  focusMode?: 'deepen' | 'none';
  /** Proposed new slot — board grows only after explicit accept (采纳). */
  pendingSlotAdd?: Step2PendingSlotAdd | null;
  /**
   * Claims the student declined to add as new parallel slots.
   * Prevents re-proposing the same pending after 拒绝.
   */
  declinedSlotClaims?: string[];
  /**
   * Single-side / single-question overload (≥3 points in one bucket).
   * Stance is blocked until keep_all / brief / drop is confirmed.
   */
  pendingCapacityTrim?: Step2PendingCapacityTrim | null;
  /** Side keys where student chose 全部保留 (do not re-ask trim). */
  capacityTrimDismissedSides?: string[];
  /**
   * Recommended stance awaiting explicit 采纳/拒绝.
   * Accept locks userStance; reject clears and asks for student's own stance.
   */
  pendingStanceConfirm?: Step2PendingStanceConfirm | null;
  /**
   * When true, student already confirmed (or provided own) stance —
   * do not re-arm pendingStanceConfirm from suggestedStance alone.
   */
  stanceConfirmResolved?: boolean;
  /** After 拒绝: waiting for student's own stance text. */
  stanceAwaitingCustom?: boolean;
  /**
   * After rejecting a side_settle: the side whose 详略 now waits for the
   * student's own scheme. While set, the channel must NOT auto re-arm the
   * same fallback settle for this side; it asks an open scheme question.
   */
  settleAwaitingCustomSide?: string | null;
  /**
   * slot_merge proposalIds the student rejected. Detection must skip these so
   * a lingering 「已整合至…」 meta line in userPoints cannot re-arm the same
   * merge every turn after a 拒绝.
   */
  rejectedMergeIds?: string[];
  /**
   * Phase0+ unified decision channel (side_settle / slot_add / stance).
   * At most one pending proposal; chat text never reverse-parses into decisions.
   * Legacy pendingSlotAdd / pendingCapacityTrim / pendingStanceConfirm remain
   * until Phase1 tear-down.
   */
  pendingProposal?: Step2Proposal | null;
  /** Side keys that already completed side_settle (详略+裁剪). */
  sideSettled?: string[];
  stance: {
    text: string;
    polarity: Step2StancePolarity;
    strength: Step2StanceStrength;
  };
  points: Step2Point[];
  redirects: Record<string, string>;
  dimensionDispositions: Array<{
    dimension: string;
    disposition: 'expanded' | 'merged' | 'dropped' | 'pending';
    side?: 'A' | 'B' | '';
    mergedInto?: string;
    note?: string;
    pointIds?: string[];
  }>;
  coverage: {
    passed: boolean;
    requiredBuckets: CoverageBucket[];
    filledBuckets: CoverageBucket[];
    missingBuckets: CoverageBucket[];
    softMissingBuckets: CoverageBucket[];
  };
  exitGate: {
    canComplete: boolean;
    canForceExit: boolean;
    forceExitUsed: boolean;
    blockReason?: string;
  };
}

// ============================================================
// Coach / Intent Agent 类型
// ============================================================

export interface CoachOutput {
  text: string;
  hint?: string;
}

export interface IntentOutput {
  stageTransition?: {
    from: string;
    to: string;
    reason: string;
  };
  slotUpdates?: Array<{
    key: string;
    action: 'draft' | 'confirm' | 'reject';
    value?: string;
    rejectReason?: string;
  }>;
  adaptations?: Array<{
    op: 'reclass' | 'merge' | 'add' | 'skip';
    key?: string;
    newLabel?: string;
    fromKeys?: string[];
    intoKey?: string;
    blockId?: string;
    afterKey?: string;
    label?: string;
    placeholder?: string;
    keys?: string[];
  }>;
  structureChangeOffer?: {
    kind: 'body_argument_change';
    summary: string;
    awaitConfirm: true;
  };
  completionFlag?: {
    isCompleted: boolean;
    reason: string;
  };
  dimensionUpdates?: Array<{
    label: string;
    status: 'probed' | 'expandable' | 'thin' | 'quality_pending';
  }>;
}

// ============================================================
// Board Patch 类型（替代 progressUpdate）
// ============================================================

export interface CoachTurnResponse {
  text: string;
  boardPatch: BoardPatch;
  plannerStatus?: 'running' | 'passed' | 'failed';
}

export interface BoardPatch {
  step1?: Partial<Step1Board>;
  step2?: Partial<Step2Board>;
  step3?: Partial<Step3Board>;
  isCompleted?: boolean;
}

/** Step 1 看板可更新字段 */
export interface Step1Board {
  correctType: string;
  coreIssue: string;
  writingTask: string;
  constraints: string[];
  suggestedDimensions: string[];
  critique: string;
  dimensionsSufficient: boolean;
  exitOffered: boolean;
}

/** Step 2 看板可更新字段 */
export interface Step2Board {
  currentStage: string;
  userStance: string;
  userPoints: string;
  suggestedStance: string;
  suggestedPoints: string;
  plannerPayload?: Step2PlannerPayload;
  blueprint: {
    position: string;
    bodies: Array<{ title: string; content: string }>;
  };
  clustering: any;
  requiresStance: boolean;
  taskLabelA: string;
  taskLabelB: string;
  positionCheckPassed?: boolean;
  positionCheckDesc?: string;
  coverageCheckPassed?: boolean;
  coverageCheckDesc?: string;
  structureCheckPassed?: boolean;
  structureCheckDesc?: string;
}

/** Step 3 看板可更新字段 */
export interface Step3Board {
  activeSubpointId?: string;
  subpoints?: any[];
  isCompleted?: boolean;
  currentSlotUpdate?: {
    key: string;
    value: string;
    status: '' | 'draft' | 'confirmed';
  };
  adaptations?: any[];
  structureChangeOffer?: any;
  step3SlotEval?: any;
  paragraphPlan?: ParagraphPlan;
}

// ============================================================
// Planner 相关类型
// ============================================================

export interface PlannerInput {
  question: string;
  questionType: string;
  requiresStance: boolean;
  materials: {
    /** Preferred: structured Step2 points */
    points: Step2Point[];
    stance: string;
    stanceMeta?: {
      polarity?: Step2StancePolarity;
      strength?: Step2StanceStrength;
    };
    coverage?: Step2PlannerPayload['coverage'];
    /** Soft one-line digest for dynamic bodyCount (not a hard lock). */
    materialDigest?: string;
    /** @deprecated legacy text sides — compatibility only */
    aSide: string;
    bSide: string;
    clusters: any[];
    userRawText: string;
  };
  plannerPayload?: Step2PlannerPayload | null;
}

export interface PlannerOutput {
  layoutPattern: string;
  rationale: string;
  bodyPlans: BodyPlan[];
  plannerIntermediate: Step2_5State['plannerIntermediate'];
}

export interface MechanicalQaResult {
  pass: boolean;
  issues: Array<{
    severity: 'fail' | 'warn';
    field: string;
    reason: string;
  }>;
}

export interface ConsistencyResult {
  valid: boolean;
  issues: string[];
}
