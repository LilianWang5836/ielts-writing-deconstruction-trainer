import React, { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import {
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Loader2,
  BookOpen,
  Award,
  Layers,
  HelpCircle,
  Sparkles,
  RotateCcw,
} from "lucide-react";
import { Topic, PracticeSession } from "../types";
import CoachChat from "./CoachChat";
import {
  computeEssayFrameworkSignature,
  computeSubpointFrameworkSignature,
} from "../utils/step3Quality";
import {
  demoteThemeHeadSubClaims,
  isClaimSentence,
  isThemeHeadOnly,
  prefillClaimSlotsFromSubClaims,
  resolveBlockClaimSentence,
  resolveBlockThemeLabel,
} from "../utils/step3ClaimPrefill";

/** Clone plan: demote theme heads only (no silent claim write — confirm-then-write). */
function planWithClaimPrefill<T>(plan: T): T {
  if (!plan || typeof plan !== "object") return plan;
  const next = JSON.parse(JSON.stringify(plan));
  demoteThemeHeadSubClaims(next);
  prefillClaimSlotsFromSubClaims(next); // no-op
  return next as T;
}

/** Body-level 论点句: first block's confirmed/full claim, never a theme word. */
function resolveBodyClaimSentence(bp: any): string {
  const plan = bp?.paragraphPlan;
  const blocks = Array.isArray(plan?.pointBlocks) ? plan.pointBlocks : [];
  for (const block of blocks) {
    const s = resolveBlockClaimSentence(block);
    if (s) return s;
  }
  const sub = String(blocks[0]?.subClaim || "").trim();
  if (isClaimSentence(sub)) return sub;
  const theme = String(bp?.theme || "").trim();
  return isClaimSentence(theme) ? theme : "";
}

function resolveBodyTheme(bp: any): string {
  const t = String(bp?.theme || "").trim();
  if (t && isThemeHeadOnly(t)) return t;
  const blocks = Array.isArray(bp?.paragraphPlan?.pointBlocks)
    ? bp.paragraphPlan.pointBlocks
    : [];
  for (const block of blocks) {
    const head = resolveBlockThemeLabel(block);
    if (head) return head;
  }
  return t && !isClaimSentence(t) ? t : "";
}

type Step3Subpoint = PracticeSession["step3"]["subpoints"][number];

interface Step3DraftingProps {
  topic: Topic;
  session: PracticeSession;
  onUpdateSession: (
    updates:
      | Partial<PracticeSession>
      | ((prev: PracticeSession) => Partial<PracticeSession>),
  ) => void;
  onNextStep: () => void;
}

export default function Step3Drafting({
  topic,
  session,
  onUpdateSession,
  onNextStep,
}: Step3DraftingProps) {
  const [activeTab, setActiveTab] = useState<
    "step1" | "step2" | "step3" | "step4"
  >("step3");
  const [showClearBoardConfirm, setShowClearBoardConfirm] = useState(false);
  const hasAutoSelectedRef = useRef(false);

  const subpointsStr =
    session.step2.coachEvaluation?.userPoints ||
    session.step2.userPoints ||
    "第一个分论点\n第二个分论点";

  const clusters = session.step2.coachEvaluation?.clustering?.clusters;
  const step2Blueprint = session.step2.coachEvaluation?.blueprint;
  const fallbackBodiesFromArray = Array.isArray(step2Blueprint?.bodies)
    ? step2Blueprint.bodies
    : [];
  // Keep parity with server-side digest fallback: support both bodies[] and body1/body2.
  const fallbackBodies =
    fallbackBodiesFromArray.length > 0
      ? fallbackBodiesFromArray
      : [
          {
            title: "Body Paragraph 1",
            content: String(step2Blueprint?.body1 || "").trim(),
          },
          {
            title: "Body Paragraph 2",
            content: String(step2Blueprint?.body2 || "").trim(),
          },
        ].filter((b) => b.content.length > 0);
  const cleanedPointLines = subpointsStr
    .split(/(?:\n|;|；)/)
    .flatMap((p) => p.split(/(?=\b\d+\.\s)/))
    .map((p) => p.replace(/^\d+\.\s*/, "").trim())
    .filter((p) => p !== "");

  const resolveSubpointContent = (
    preferred: string | undefined,
    idx: number,
    fallback: string,
  ) => {
    const preferredText = preferred?.trim();
    if (preferredText && preferredText.length >= 8) return preferredText;
    const pointLine = cleanedPointLines[idx];
    if (pointLine && pointLine.length >= 8) return pointLine;
    return fallback;
  };

  const splitUserPointsByTask = (raw: string): string[] => {
    const text = String(raw || "").trim();
    if (!text) return [];
    const aMatch = text.match(/A面[^：:]*[：:]([\s\S]*?)(?=B面[^：:]*[：:]|$)/);
    const bMatch = text.match(/B面[^：:]*[：:]([\s\S]*)$/);
    const aText = String(aMatch?.[1] || "")
      .replace(/^[；;，,\s]+|[；;，,\s]+$/g, "")
      .trim();
    const bText = String(bMatch?.[1] || "")
      .replace(/^[；;，,\s]+|[；;，,\s]+$/g, "")
      .trim();
    if (aText || bText) {
      return [aText, bText].filter(Boolean);
    }
    return [];
  };

  // 优先从 Step 2.5 bodyPlans 构建 subpoints（当 Planner 已运行成功时）
  const step2_5BodyPlans = (session as any).step2_5?.bodyPlans;

  const parsedSubpoints: Step3Subpoint[] = step2_5BodyPlans && step2_5BodyPlans.length > 0
    ? step2_5BodyPlans.map((bp: any) => {
        const plan = planWithClaimPrefill(bp.paragraphPlan);
        const theme = resolveBodyTheme({ ...bp, paragraphPlan: plan }) || bp.role || '';
        const claimSentence = resolveBodyClaimSentence({ ...bp, paragraphPlan: plan });
        const mapped = Array.isArray(bp.mappedPoints) ? bp.mappedPoints : [];
        // Keep theme heads out of "包含分论点" list; only full sentences
        const pointLines = mapped.filter((p: string) => isClaimSentence(String(p || '')));
        return {
        id: bp.id,
        content: claimSentence || (theme ? `（主题：${theme}，待确认论点句）` : bp.targetBody),
        points: pointLines.length ? pointLines : [],
        targetBody: bp.targetBody,
        theme: theme || bp.role,
        paragraphDensity: bp.paragraphDensity,
        pointRoles: bp.pointRoles,
        argumentRelation: bp.argumentRelation,
        stanceRelation: bp.argumentRelation,
        layoutRationale: (session as any).step2_5?.rationale || '',
        paragraphPlan: plan,
        isCompleted: false,
      };
      })
    : clusters && Array.isArray(clusters) && clusters.length > 0
    ? clusters.map((cluster: any, i: number) => ({
        id: `body-${i + 1}`,
        content: resolveSubpointContent(
          cluster.content,
          i,
          `${cluster.targetBody || `Body Paragraph ${i + 1}`}: ${cluster.theme || `主题 ${i + 1}`}`,
        ),
        points: cluster.points || [],
        targetBody: cluster.targetBody || `Body Paragraph ${i + 1}`,
        theme: cluster.theme || `主题 ${i + 1}`,
        paragraphDensity: cluster.paragraphDensity,
        pointRoles: cluster.pointRoles,
        argumentRelation: cluster.argumentRelation || cluster.stanceRelation,
        stanceRelation: cluster.stanceRelation,
        layoutRationale: cluster.layoutRationale,
        isCompleted: false,
      }))
    : fallbackBodies && Array.isArray(fallbackBodies) && fallbackBodies.length > 0
    ? fallbackBodies.map((body: any, i: number) => ({
        id: `body-${i + 1}`,
        content: body.content || body.title || `Body Paragraph ${i + 1}`,
        points: [body.content || body.title || ""],
        targetBody: body.title || `Body Paragraph ${i + 1}`,
        theme: body.title || `主题 ${i + 1}`,
        paragraphDensity: body.paragraphDensity,
        pointRoles: body.pointRoles,
        argumentRelation: body.argumentRelation || body.stanceRelation,
        stanceRelation: body.stanceRelation,
        layoutRationale: body.layoutRationale,
        isCompleted: false,
      }))
    : (() => {
        const taskBuckets = splitUserPointsByTask(subpointsStr);
        const fallbackLines =
          taskBuckets.length > 0
            ? taskBuckets
            : subpointsStr
                .split(/(?:\n|;|；)/)
                .flatMap((p) => p.split(/(?=\b\d+\.\s)/))
                .map((p) => p.trim())
                .filter((p) => p !== "");
        return fallbackLines.map((p, i) => ({
          id: `body-${i + 1}`,
          content: p,
          points: [p],
          targetBody: `Body Paragraph ${i + 1}`,
          theme: `分论点 ${i + 1}`,
          isCompleted: false,
        }));
      })();

  const essayFrameworkSignature = computeEssayFrameworkSignature(session);
  const parsedSubpointsSignature = [
    essayFrameworkSignature,
    ...parsedSubpoints.map((sp) => computeSubpointFrameworkSignature(sp, session)),
  ].join("|");

  const subpoints = parsedSubpoints.map((parsed) => {
    const existing = (session.step3.subpoints || []).find(
      (sp) => sp.id === parsed.id,
    );
    const parsedSig = computeSubpointFrameworkSignature(parsed, session);
    const existingSig = existing
      ? computeSubpointFrameworkSignature(existing, session)
      : "";
    // Legacy stored sig may embed claim text; treat theme/structure match as same framework.
    const sameFramework =
      !!existing &&
      !!existingSig &&
      (existingSig === parsedSig ||
        String(existing.frameworkSignature || "") === parsedSig ||
        (() => {
          const stored = String(existing.frameworkSignature || "");
          if (!stored || stored === parsedSig) return stored === parsedSig;
          const a = stored.split("::");
          const b = parsedSig.split("::");
          if (a.length !== b.length || a.length < 2) return false;
          for (let i = 0; i < a.length; i++) {
            if (i === 1) continue;
            if (a[i] !== b[i]) return false;
          }
          return true;
        })());
    if (sameFramework && existing) {
      const plan = planWithClaimPrefill(
        existing.paragraphPlan || parsed.paragraphPlan,
      );
      const claimFromBoard = resolveBodyClaimSentence({
        ...parsed,
        paragraphPlan: plan,
      });
      const themeFromBoard =
        resolveBodyTheme({ ...parsed, paragraphPlan: plan }) || parsed.theme;
      return {
        ...parsed,
        // Keep 论点 in sync with confirmed claim-step value (not stale theme placeholder)
        content:
          claimFromBoard ||
          (themeFromBoard
            ? `（主题：${themeFromBoard}，待确认论点句）`
            : parsed.content),
        theme: themeFromBoard,
        frameworkSignature: parsedSig,
        paragraphPlan: plan,
        structureSteps: existing.structureSteps,
        chatHistory: existing.chatHistory,
        kickoffPendingDrafts: (existing as any).kickoffPendingDrafts,
        isCompleted: existing.isCompleted,
      };
    }
    // Soft rebuild: keep dialogue/board if this body already has in-progress work
    if (existing?.chatHistory?.length || existing?.paragraphPlan) {
      return {
        ...parsed,
        frameworkSignature: parsedSig,
        paragraphPlan: planWithClaimPrefill(
          existing.paragraphPlan || parsed.paragraphPlan,
        ),
        structureSteps: existing.structureSteps,
        chatHistory: existing.chatHistory,
        kickoffPendingDrafts: (existing as any).kickoffPendingDrafts,
        isCompleted: existing.isCompleted,
      };
    }
    return {
      ...parsed,
      frameworkSignature: parsedSig,
      isCompleted: false,
    };
  });

  useEffect(() => {
    setActiveTab("step3");
    const existing = session.step3.subpoints || [];
    const shapeChanged =
      !existing ||
      existing.length !== parsedSubpoints.length ||
      existing.some((sp, idx) => sp.id !== parsedSubpoints[idx]?.id) ||
      parsedSubpoints.some((parsed, idx) => {
        const prev = existing[idx];
        if (!prev || prev.id !== parsed.id) return true;
        const nextSig = computeSubpointFrameworkSignature(parsed, session);
        const prevLive = computeSubpointFrameworkSignature(prev, session);
        if (prevLive === nextSig) return false;
        // Ignore legacy claim-content-only drift in stored signature
        const stored = String(prev.frameworkSignature || "");
        if (stored === nextSig) return false;
        const a = stored.split("::");
        const b = nextSig.split("::");
        if (a.length === b.length && a.length >= 2) {
          let onlyContent = true;
          for (let i = 0; i < a.length; i++) {
            if (i === 1) continue;
            if (a[i] !== b[i]) {
              onlyContent = false;
              break;
            }
          }
          if (onlyContent) return false;
        }
        return prevLive !== nextSig;
      });
    // Do NOT full-rewrite subpoints for claim/prefill sync — that raced affirm
    // and wiped chatHistory. Shape/id changes only.
    if (shapeChanged) {
      const currentActive = session.step3.activeSubpointId;
      const activeStillExists =
        currentActive && parsedSubpoints.some((sp) => sp.id === currentActive);
      const nextActiveSubpointId =
        activeStillExists || parsedSubpoints.length === 0
          ? currentActive
          : parsedSubpoints[0].id;
      onUpdateSession({
        step3: {
          ...session.step3,
          subpoints,
          activeSubpointId: nextActiveSubpointId,
          isCompleted: false,
        },
      });
    }
  }, [parsedSubpoints.length, parsedSubpointsSignature, onUpdateSession, session.step3]);

  useEffect(() => {
    if (
      hasAutoSelectedRef.current ||
      !!session.step3.activeSubpointId ||
      subpoints.length === 0
    ) {
      return;
    }
    hasAutoSelectedRef.current = true;
    onUpdateSession({
      step3: {
        ...session.step3,
        activeSubpointId: subpoints[0].id,
      },
    });
  }, [onUpdateSession, session.step3, subpoints]);

  const activeSubpoint = subpoints.find(
    (s) => s.id === session.step3.activeSubpointId,
  );

  // Find the first EMPTY slot in the plan (prefilled/confirmed claim slots are skipped).
  const findFirstEmptyStepLabel = (plan: any): string => {
    if (!plan || !Array.isArray(plan.pointBlocks)) return '分论点';
    for (const block of plan.pointBlocks) {
      if (!Array.isArray(block?.steps)) continue;
      for (const step of block.steps) {
        if (!String(step?.value || '').trim()) {
          return String(step?.label || '当前这一环').trim();
        }
      }
    }
    return '分论点';
  };

  // 待确认草稿（服务端暂存的 pending）：右侧看板同步显示在对应槽位，
  // 让看板随聊天推进即时更新，而不是等确认后才一次性出现。
  const pendingByKey = (() => {
    const map = new Map<string, string>();
    const drafts = Array.isArray(activeSubpoint?.kickoffPendingDrafts)
      ? activeSubpoint.kickoffPendingDrafts
      : [];
    for (const d of drafts) {
      const t = String(d?.text || '').trim();
      if (t) map.set(String(d?.key || ''), t);
    }
    return map;
  })();

  const kickoffFirstLabel = activeSubpoint?.paragraphPlan
    ? findFirstEmptyStepLabel(activeSubpoint.paragraphPlan)
    : "分论点";
  const kickoffTheme = String(activeSubpoint?.theme || "").trim();
  const kickoffNeedsClaimAsk =
    /分论点|核心主张|核心观点|主张|论点/.test(kickoffFirstLabel) &&
    !isClaimSentence(String(activeSubpoint?.content || ""));
  const kickoffPrompt = activeSubpoint?.paragraphPlan
    ? kickoffNeedsClaimAsk
      ? `开场：主题「${kickoffTheme || "本段主题"}」只是标签，不是论点。firstEmpty 必须是「${kickoffFirstLabel}」（论点槽）。DEFAULT：mode=expand — 用第二步素材引导学生用完整句说出本段论点。确认时保留学生逻辑，关联紧密多层可同槽；FORBIDDEN 过度缩成口号；FORBIDDEN 说「分论点已确立」或跳到展开原因。禁止静默写入、禁止改已确认槽。`
      : `开场：对准 firstEmpty「${kickoffFirstLabel}」。DEFAULT：mode=expand。确认整理句以逻辑通顺为准（紧密多层可同槽）；仅当功能明显不同且后面有空槽时才拆多槽。禁止过度简化、禁止从零发明、禁止改 plan 骨架。`
    : activeSubpoint?.content
    ? `开场本段。论点槽优先。DEFAULT expand；确认时保留学生因果链，勿过度一句化。禁止静默写入。`
    : "";

  // Server is the sole authority for whole-step unlock (via progressUpdate.step3Ui).
  const isStep3Finished = !!session.step3.isCompleted;

  const strategyLabel: Record<string, string> = {
    explanation: "解释",
    example: "举例",
    mechanism: "机制",
    impact: "影响",
    contrast: "对比",
    hybrid: "混合",
  };

  const modeLabel: Record<string, string> = {
    total_then_points: "总分型",
    direct_points: "分点直写型",
  };

  const welcomeMessage = `【第三步：段落论证起草 ✍️】
欢迎进入第三步！我们来为每一个主体段落 (Body Paragraph) 构建一个逻辑闭环。
我会从第一个主体段落开始，你可以随时在右侧顶部切换到其他主体段落。`;

  const handleClearActiveBoard = () => {
    const activeId = session.step3.activeSubpointId;
    if (!activeId) return;

    const resetSubpoints = subpoints.map((sp) => {
      if (sp.id !== activeId) return sp;
      return {
        ...sp,
        paragraphPlan: undefined,
        structureSteps: undefined,
        claim: undefined,
        reason: undefined,
        supportType: undefined,
        supportContent: undefined,
        impact: undefined,
        mechanism: undefined,
        result: undefined,
        draft: undefined,
        hint: undefined,
        transitionChecks: undefined,
        sufficiencyCheck: undefined,
        isCompleted: false,
      };
    });

    onUpdateSession({
      step3: {
        ...session.step3,
        subpoints: resetSubpoints,
        isCompleted: false,
      },
    });
    setShowClearBoardConfirm(false);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 md:gap-6 h-full min-h-0 w-full flex-1">
      {/* LEFT COLUMN: AI Coach Dialogue Area */}
      <div className="lg:col-span-5 xl:col-span-5 h-[480px] lg:h-full flex flex-col min-h-0">
        <CoachChat
          topic={topic}
          step={3}
          stepKey="step3"
          session={session}
          onUpdateSession={onUpdateSession}
          stepContext={{ subpoints }}
          welcomeMessage={welcomeMessage}
          autoKickoff={true}
          kickoffPrompt={kickoffPrompt}
          kickoffContextKey={activeSubpoint?.id || ''}
        >
          {/* Manual click-to-jump — same pattern as Step1/Step2; unlocks with body checkmarks */}
          {isStep3Finished && (
            <div className="mt-4 border-t border-emerald-100 pt-3.5 animate-fade-in">
              <div className="bg-emerald-50 border border-emerald-200/80 rounded-xl p-3.5 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xs">
                <div className="flex items-center gap-2.5">
                  <div className="h-7 w-7 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="h-4 w-4" />
                  </div>
                  <div className="text-left">
                    <h4 className="font-sans font-bold text-emerald-900 text-xs">🎉 论证逻辑链全通关！</h4>
                    <p className="font-sans text-[11px] text-emerald-700 leading-normal">
                      两个核心分论点的逻辑链已构建完成。点击下方按钮，进入下一步学术句式升级。
                    </p>
                  </div>
                </div>
                <button
                  onClick={onNextStep}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-4 py-2 font-sans text-xs font-bold text-white shadow-sm transition shrink-0"
                >
                  <span>立即跳转</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </CoachChat>
      </div>

      {/* RIGHT COLUMN: Results Rendering Area */}
      <div className="lg:col-span-7 xl:col-span-7 flex flex-col h-[480px] lg:h-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden min-h-0">
        {/* Top Header */}
        <div className="bg-slate-50/80 border-b border-slate-200 p-4 shrink-0 backdrop-blur-sm">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="flex h-1.5 w-1.5 rounded-full bg-indigo-600 animate-pulse" />
            <span className="text-[10px] font-sans font-bold text-slate-500 uppercase tracking-wider">
              论证进度：{subpoints.filter((s) => s.isCompleted).length} /{" "}
              {subpoints.length}
            </span>
          </div>
          <p className="font-serif italic text-slate-800 text-xs leading-relaxed font-semibold">
            {topic.question}
          </p>
        </div>

        {/* Top Subpoint Navigation Row (Only visible when activeSubpoint is selected) */}
        {activeSubpoint && (
          <div className="flex items-center gap-2 p-3 bg-slate-50 border-b border-slate-150 shrink-0 overflow-x-auto scrollbar-none">
            <button
              onClick={() => {
                onUpdateSession({
                  step3: { ...session.step3, activeSubpointId: undefined }
                });
              }}
              className="text-[11px] font-sans font-semibold text-slate-500 hover:text-indigo-650 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 shadow-3xs shrink-0 transition"
            >
              ← 主体段列表
            </button>
            <div className="h-4 w-px bg-slate-200 shrink-0 mx-0.5"></div>
            {subpoints.map((sp, idx) => {
              const tabSelectable = sp.selectable !== false;
              return (
              <button
                key={sp.id}
                disabled={!tabSelectable}
                onClick={() => {
                  if (!tabSelectable) return;
                  onUpdateSession({
                    step3: { ...session.step3, activeSubpointId: sp.id }
                  });
                }}
                className={`text-[11px] font-sans font-bold px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 shrink-0 border ${
                  sp.id === session.step3.activeSubpointId
                    ? "bg-indigo-650 text-white border-indigo-650 shadow-sm"
                    : tabSelectable
                    ? "bg-white text-slate-600 border-slate-200 hover:border-slate-300"
                    : "bg-slate-50 text-slate-400 border-slate-100 cursor-not-allowed opacity-60"
                }`}
              >
                <span>{sp.targetBody || `主体段 ${idx + 1}`}</span>
                {sp.isCompleted && (
                  <CheckCircle2 className={`h-3.5 w-3.5 ${sp.id === session.step3.activeSubpointId ? 'text-white' : 'text-emerald-500'}`} />
                )}
              </button>
              );
            })}
          </div>
        )}

        {/* Content area */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {!activeSubpoint ? (
            /* Custom Selector View */
            <div className="h-full flex flex-col justify-center items-center p-6 space-y-6 text-center animate-fade-in my-auto min-h-[300px]">
              <div className="h-12 w-12 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center border border-indigo-100 shadow-sm mb-1">
                <Layers className="h-6 w-6" />
              </div>
              <div className="max-w-md space-y-2">
                <h3 className="text-sm font-sans font-bold text-slate-800">你已经规划好了主体段落结构</h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  接下来，我们将使用苏格拉底对话引导，将每个主体段落（Body Paragraph）分别发展成一个结构严密、逻辑闭环的高分论证。请选择其中一个开始：
                </p>
              </div>
              <div className="w-full max-w-md space-y-3">
                {subpoints.map((subpoint, idx) => {
                  const selectable = subpoint.selectable !== false;
                  return (
                  <button
                    key={subpoint.id}
                    disabled={!selectable}
                    onClick={() => {
                      if (!selectable) return;
                      onUpdateSession({
                        step3: {
                          ...session.step3,
                          activeSubpointId: subpoint.id,
                          subpoints: subpoints,
                        }
                      });
                    }}
                    className={`w-full border rounded-xl p-4 text-left transition-all flex items-start gap-3.5 ${
                      selectable
                        ? 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/20 hover:shadow-3xs group'
                        : 'border-slate-100 bg-slate-50/60 opacity-60 cursor-not-allowed'
                    }`}
                  >
                    <span className="h-6 w-6 rounded-full bg-indigo-50 text-indigo-600 font-sans font-bold text-xs flex items-center justify-center shrink-0 group-hover:bg-indigo-100">
                      {idx + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-150">
                          {subpoint.targetBody || `主体段 ${idx + 1}`}
                        </span>
                        {subpoint.theme && (
                          <span className="text-[10px] text-slate-500 font-semibold">
                            {subpoint.theme}
                          </span>
                        )}
                      </div>
                      <p className="text-slate-800 font-bold text-xs leading-relaxed mb-1.5">
                        {(() => {
                          const m = String(
                            subpoint.paragraphPlan?.mode || "",
                          );
                          if (m === "direct_points") {
                            const themes = (
                              subpoint.paragraphPlan?.pointBlocks || []
                            )
                              .map((b) => resolveBlockThemeLabel(b))
                              .filter(Boolean);
                            return themes.length
                              ? `并列分点：${themes.join(" · ")}`
                              : "分点直写（无总起句）";
                          }
                          if (m === "total_then_points") {
                            const tc = String(
                              subpoint.paragraphPlan?.totalClaim || "",
                            ).trim();
                            return `总观点：${tc || "待确认"}`;
                          }
                          return `论点：${
                            isClaimSentence(String(subpoint.content || ""))
                              ? subpoint.content
                              : subpoint.theme
                                ? `（主题：${subpoint.theme}，待确认论点句）`
                                : "待确认论点句"
                          }`;
                        })()}
                      </p>
                      <span className="text-[10px] text-slate-450 flex items-center gap-1 font-semibold mt-2.5">
                        {subpoint.isCompleted ? (
                          <span className="text-emerald-600 flex items-center gap-1 font-bold">✓ 论证逻辑已闭环</span>
                        ) : !selectable ? (
                          <span className="text-slate-400">请先完成前面的主体段</span>
                        ) : (
                          <span>待构建论证链条 · 点击开始</span>
                        )}
                      </span>
                    </div>
                    <ArrowRight className="h-4 w-4 text-slate-400 group-hover:text-indigo-500 transition self-center shrink-0" />
                  </button>
                  );
                })}
              </div>
            </div>
          ) : (
            /* Socratic Visual Logic Chain */
            <div className="p-5 space-y-5 animate-fade-in">
              {(() => {
                const planMode = String(
                  activeSubpoint.paragraphPlan?.mode || "single_point",
                );
                const isTotalThenPoints = planMode === "total_then_points";
                const isDirectPoints = planMode === "direct_points";
                // single_point (and unknown): one body-level 论点; no per-block echo
                const showBodyClaimHeader = !isDirectPoints && !isTotalThenPoints;
                const totalClaimText = String(
                  activeSubpoint.paragraphPlan?.totalClaim || "",
                ).trim();
                const bodyClaimText = isClaimSentence(
                  String(activeSubpoint.content || ""),
                )
                  ? String(activeSubpoint.content)
                  : (
                      activeSubpoint.paragraphPlan?.pointBlocks || []
                    )
                      .map((b) => resolveBlockClaimSentence(b, pendingByKey))
                      .find(Boolean) ||
                    (activeSubpoint.theme
                      ? `（主题：${activeSubpoint.theme}，待确认论点句）`
                      : "待确认论点句");

                return (
              <>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-bold text-indigo-700">
                    {activeSubpoint.targetBody || "当前主体段"}
                  </span>
                  {activeSubpoint.theme && (
                    <span className="text-[10px] text-slate-500">
                      {activeSubpoint.theme}
                    </span>
                  )}
                  {activeSubpoint.paragraphPlan?.mode && (
                    <span className="text-[10px] font-bold text-indigo-600/80">
                      {modeLabel[activeSubpoint.paragraphPlan.mode] ||
                        activeSubpoint.paragraphPlan.mode}
                    </span>
                  )}
                </div>
                {isTotalThenPoints ? (
                  <>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">
                      总观点
                    </p>
                    <p className="text-slate-800 font-bold text-xs md:text-[12.5px] leading-relaxed">
                      {totalClaimText || "待确认总观点"}
                    </p>
                  </>
                ) : showBodyClaimHeader ? (
                  <>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">
                      论点
                    </p>
                    <p className="text-slate-800 font-bold text-xs md:text-[12.5px] leading-relaxed">
                      {bodyClaimText}
                    </p>
                  </>
                ) : (
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    并列分点直写：各分点下分别确认论点，本段无总起句。
                  </p>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    论证过程
                  </span>
                  {showClearBoardConfirm ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-rose-700 font-sans font-medium">
                        清空当前主体段看板？
                      </span>
                      <button
                        type="button"
                        onClick={handleClearActiveBoard}
                        className="text-[10px] font-bold text-white bg-rose-600 hover:bg-rose-700 px-2 py-1 rounded-md transition"
                      >
                        确认
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowClearBoardConfirm(false)}
                        className="text-[10px] font-semibold text-slate-500 hover:text-slate-700 px-1.5 py-1 transition"
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowClearBoardConfirm(true)}
                      className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 hover:text-rose-700 px-1.5 py-0.5 transition shrink-0"
                      title="清空当前主体段的逻辑链看板数据"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>清空</span>
                    </button>
                  )}
                </div>

                {activeSubpoint.paragraphPlan ? (
                  <div className="space-y-4">
                    <div className="space-y-4">
                      {activeSubpoint.paragraphPlan.pointBlocks.map(
                        (block, blockIdx) => {
                          const themeLabel = resolveBlockThemeLabel(
                            block,
                            activeSubpoint.theme || "",
                          );
                          const claimSentence = resolveBlockClaimSentence(
                            block,
                            pendingByKey,
                          );
                          // Per-block 论点: multi-point modes only (总分 / 分点直写)
                          const showPerBlockClaim =
                            isDirectPoints || isTotalThenPoints;
                          // Claim step in chain: hide when already shown as header
                          // (single_point top) or as per-block 论点 (filled).
                          const chainSteps = (block.steps || []).filter(
                            (step) => {
                              const lab = String(step?.label || "");
                              if (
                                !/分论点|核心观点|核心主张|主张|论点|观点|claim/i.test(
                                  lab,
                                )
                              ) {
                                return true;
                              }
                              const filled = String(step?.value || "").trim();
                              const pend = pendingByKey.get(
                                String(step?.key || ""),
                              );
                              if (showBodyClaimHeader) {
                                // single_point: claim lives at body header
                                return !filled && !pend && !claimSentence;
                              }
                              if (showPerBlockClaim && claimSentence) {
                                // Shown under this block as「论点」
                                return false;
                              }
                              // Empty claim still listed as 待填写 in 论证
                              return true;
                            },
                          );
                          return (
                          <div
                            key={block.id || blockIdx}
                            className="space-y-2 pt-1 border-t border-slate-100 first:border-t-0 first:pt-0"
                          >
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <span className="font-sans text-xs md:text-[12.5px] font-bold text-slate-800">
                                {themeLabel ||
                                  (isClaimSentence(String(block.label || ""))
                                    ? `分点 ${blockIdx + 1}`
                                    : block.label) ||
                                  `分点 ${blockIdx + 1}`}
                              </span>
                              <span className="text-[10px] text-slate-500">
                                {block.role === "major" ? "详写" : "略写"}
                                {strategyLabel[block.expansionStrategy]
                                  ? ` · ${strategyLabel[block.expansionStrategy]}`
                                  : ""}
                              </span>
                            </div>

                            {showPerBlockClaim ? (
                              <div className="space-y-0.5">
                                <p className="text-[10px] font-bold text-slate-400">
                                  论点
                                </p>
                                <p className="text-xs md:text-[12.5px] text-slate-800 font-semibold leading-relaxed">
                                  {claimSentence || "待填写"}
                                </p>
                              </div>
                            ) : null}

                            <div className="space-y-2.5 pl-0.5">
                              {chainSteps.length > 0 && (
                                <p className="text-[10px] font-bold text-slate-400 pt-0.5">
                                  论证
                                </p>
                              )}
                              {chainSteps.map((step, idx, arr) => {
                                const pendingText = step.value
                                  ? ""
                                  : pendingByKey.get(String(step.key || "")) ||
                                    "";
                                return (
                                <div key={step.key} className="flex gap-2.5">
                                  <div className="flex flex-col items-center shrink-0 pt-0.5">
                                    <div
                                      className={`h-1.5 w-1.5 rounded-full ${
                                        step.value
                                          ? "bg-indigo-600"
                                          : pendingText
                                          ? "bg-amber-400"
                                          : "bg-slate-300"
                                      }`}
                                    />
                                    {idx < arr.length - 1 && (
                                      <div className="w-px flex-1 bg-slate-200 min-h-[10px] mt-1" />
                                    )}
                                  </div>
                                  <div className="flex-1 min-w-0 pb-0.5">
                                    <span className="text-[10px] font-sans font-bold text-slate-400">
                                      {step.label}
                                    </span>
                                    {pendingText ? (
                                      <p className="text-xs md:text-[12.5px] mt-0.5 leading-relaxed bg-amber-50/70 border border-amber-200/70 rounded-md px-2 py-1 text-slate-700">
                                        <span className="text-amber-600 font-bold">
                                          待确认：
                                        </span>
                                        {pendingText}
                                      </p>
                                    ) : (
                                      <p
                                        className={`text-xs md:text-[12.5px] mt-0.5 leading-relaxed min-h-[1.25rem] ${
                                          step.value
                                            ? "text-slate-700"
                                            : "text-slate-300"
                                        }`}
                                      >
                                        {step.value || "待填写"}
                                      </p>
                                    )}
                                  </div>
                                </div>
                                );
                              })}
                            </div>
                          </div>
                          );
                        },
                      )}
                    </div>

                    {activeSubpoint.paragraphPlan.optionalShortClosing && (
                      <div className="pt-2 border-t border-slate-100">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">
                          简短收束
                        </p>
                        <p className="text-xs md:text-[12.5px] text-slate-700 leading-relaxed italic">
                          {activeSubpoint.paragraphPlan.optionalShortClosing}
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {(
                      activeSubpoint.structureSteps || [
                        {
                          key: "claim",
                          label: "核心观点 (Claim)",
                          value: activeSubpoint.claim,
                        },
                        {
                          key: "reason",
                          label: "展开原因 (Reason)",
                          value: activeSubpoint.reason,
                        },
                        {
                          key: "support",
                          label: `支撑展开 (${
                            activeSubpoint.supportType
                              ? activeSubpoint.supportType === "example"
                                ? "Example / 举例"
                                : activeSubpoint.supportType === "mechanism"
                                  ? "Mechanism / 机制"
                                  : "Scenario / 场景"
                              : "Support"
                          })`,
                          value: activeSubpoint.supportContent,
                        },
                        {
                          key: "impact",
                          label: "推导结果 (Impact)",
                          value: activeSubpoint.impact,
                        },
                      ]
                    ).map((step, idx, arr) => (
                      <div key={step.key} className="flex gap-2.5">
                        <div className="flex flex-col items-center shrink-0 pt-0.5">
                          <div
                            className={`h-1.5 w-1.5 rounded-full ${
                              step.value ? "bg-indigo-600" : "bg-slate-300"
                            }`}
                          />
                          {idx < arr.length - 1 && (
                            <div className="w-px flex-1 bg-slate-200 min-h-[10px] mt-1" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-[10px] font-sans font-bold text-slate-400">
                            {step.label}
                          </span>
                          <p
                            className={`text-xs md:text-[12.5px] mt-0.5 leading-relaxed min-h-[1.25rem] ${
                              step.value ? "text-slate-800 font-semibold" : "text-slate-300"
                            }`}
                          >
                            {step.value || "待填写"}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              </>
                );
              })()}
            </div>
          )}
        </div>

        {/* Status footer — jump CTA lives in left CoachChat only (same as Step1/Step2) */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 shrink-0 flex items-center justify-between gap-3 min-h-[64px]">
          <div className="text-[11px] text-slate-500">
            {isStep3Finished ? (
              <span className="text-emerald-600 font-bold">🎉 两个核心分论点逻辑链已全部构建完成！请点击左侧「立即跳转」进入第四步。</span>
            ) : (
              <span>{activeSubpoint ? "按照提示语与 AI 互动来推进你的论证流程。" : "请在上方先选择一个分论点开启论证流程。"}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
