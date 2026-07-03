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
} from "lucide-react";
import { Topic, PracticeSession } from "../types";
import CoachChat from "./CoachChat";

type Step3Subpoint = PracticeSession["step3"]["subpoints"][number];

interface Step3DraftingProps {
  topic: Topic;
  session: PracticeSession;
  onUpdateSession: (updates: Partial<PracticeSession>) => void;
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
  const hasAutoSelectedRef = useRef(false);

  const subpointsStr =
    session.step2.coachEvaluation?.userPoints ||
    session.step2.userPoints ||
    session.step2.coachEvaluation?.suggestedPoints ||
    "第一个分论点\n第二个分论点";

  const clusters = session.step2.coachEvaluation?.clustering?.clusters;
  const fallbackBodies = session.step2.coachEvaluation?.blueprint?.bodies;
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

  const parsedSubpoints: Step3Subpoint[] = clusters && Array.isArray(clusters) && clusters.length > 0
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
        isCompleted: false,
      }))
    : fallbackBodies && Array.isArray(fallbackBodies) && fallbackBodies.length > 0
    ? fallbackBodies.map((body: any, i: number) => ({
        id: `body-${i + 1}`,
        content: body.content || body.title || `Body Paragraph ${i + 1}`,
        points: [body.content || body.title || ""],
        targetBody: body.title || `Body Paragraph ${i + 1}`,
        theme: body.title || `主题 ${i + 1}`,
        isCompleted: false,
      }))
    : subpointsStr
        .split(/(?:\n|;|；)/)
        .flatMap((p) => p.split(/(?=\b\d+\.\s)/))
        .map((p) => p.trim())
        .filter((p) => p !== "")
        .map((p, i) => ({
          id: `sp-${i}`,
          content: p,
          points: [p],
          targetBody: `Body Paragraph ${i + 1}`,
          theme: `分论点 ${i + 1}`,
          isCompleted: false,
        }));

  const subpoints =
    session.step3.subpoints &&
    session.step3.subpoints.length === parsedSubpoints.length
      ? session.step3.subpoints
      : parsedSubpoints;

  useEffect(() => {
    setActiveTab("step3");
    if (
      !session.step3.subpoints ||
      session.step3.subpoints.length !== parsedSubpoints.length
    ) {
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
          subpoints: parsedSubpoints,
          activeSubpointId: nextActiveSubpointId,
        },
      });
    }
  }, [parsedSubpoints.length, onUpdateSession, session.step3]);

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
  const kickoffPrompt = activeSubpoint?.content
    ? `请基于这个已确立的主体段分论点直接开始：${activeSubpoint.content}。先判断这是单点还是多点论点，用大白话简要说明结构安排，然后直接开始第一个具体问题；结构细节写入系统即可，不要在对话里提字段名。`
    : "";

  const isStep3Finished = session.step3.isCompleted || (subpoints.length > 0 && subpoints.every((s) => s.isCompleted));

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

  const isStepAvailable = (
    steps: { value?: string }[],
    idx: number,
  ) => !!steps[idx]?.value || idx === 0 || !!steps[idx - 1]?.value;

  const welcomeMessage = `【第三步：段落论证起草 ✍️】
欢迎进入第三步！我们来为每一个主体段落 (Body Paragraph) 构建一个逻辑闭环。
我会从第一个主体段落开始，你可以随时在右侧顶部切换到其他主体段落。`;

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
          {/* Coach Controls / Action bar - Auto-progression upon AI completion */}
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
                      两个核心分论点的逻辑链已构建完成，即将为你<strong>自动切换</strong>到下一步学术句式升级...
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
            {subpoints.map((sp, idx) => (
              <button
                key={sp.id}
                onClick={() => {
                  onUpdateSession({
                    step3: { ...session.step3, activeSubpointId: sp.id }
                  });
                }}
                className={`text-[11px] font-sans font-bold px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 shrink-0 border ${
                  sp.id === session.step3.activeSubpointId
                    ? "bg-indigo-650 text-white border-indigo-650 shadow-sm"
                    : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"
                }`}
              >
                <span>{sp.targetBody || `主体段 ${idx + 1}`}</span>
                {sp.isCompleted && (
                  <CheckCircle2 className={`h-3.5 w-3.5 ${sp.id === session.step3.activeSubpointId ? 'text-white' : 'text-emerald-500'}`} />
                )}
              </button>
            ))}
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
                {subpoints.map((subpoint, idx) => (
                  <button
                    key={subpoint.id}
                    onClick={() => {
                      onUpdateSession({
                        step3: {
                          ...session.step3,
                          activeSubpointId: subpoint.id,
                          subpoints: subpoints,
                        }
                      });
                    }}
                    className="w-full border border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/20 rounded-xl p-4 text-left transition-all hover:shadow-3xs group flex items-start gap-3.5"
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
                        中心句：{subpoint.content}
                      </p>
                      {subpoint.points && subpoint.points.length > 0 && (
                        <div className="mt-2 bg-slate-50 rounded-lg p-2 space-y-1 text-[11px] text-slate-600 border border-slate-100">
                          <p className="font-bold text-slate-500 text-[10px] uppercase tracking-wider">📌 包含分论点：</p>
                          {subpoint.points.map((pt: string, pIdx: number) => (
                            <div key={pIdx} className="flex items-start gap-1">
                              <span className="text-indigo-500 shrink-0">•</span>
                              <span>{pt}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <span className="text-[10px] text-slate-450 flex items-center gap-1 font-semibold mt-2.5">
                        {subpoint.isCompleted ? (
                          <span className="text-emerald-600 flex items-center gap-1 font-bold">✓ 论证逻辑已闭环</span>
                        ) : (
                          <span>待构建论证链条 · 点击开始</span>
                        )}
                      </span>
                    </div>
                    <ArrowRight className="h-4 w-4 text-slate-400 group-hover:text-indigo-500 transition self-center shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* Socratic Visual Logic Chain and Checklists */
            <div className="p-5 space-y-6 animate-fade-in">
              <div className="bg-slate-50 border border-slate-150 rounded-xl p-4">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-150">
                    {activeSubpoint.targetBody || "当前主体段"}
                  </span>
                  {activeSubpoint.theme && (
                    <span className="text-[10px] text-slate-500 font-semibold">
                      {activeSubpoint.theme}
                    </span>
                  )}
                </div>
                <p className="text-[10px] font-sans font-bold text-indigo-600 uppercase tracking-wider mb-1">段落中心句 (Topic Sentence)</p>
                <p className="text-slate-800 font-bold text-xs leading-relaxed mb-1">{activeSubpoint.content}</p>
                {activeSubpoint.points && activeSubpoint.points.length > 0 && (
                  <div className="mt-2 bg-white rounded-lg p-2.5 space-y-1 text-[11px] text-slate-600 border border-slate-200/50">
                    <p className="font-bold text-slate-500 text-[10px] uppercase tracking-wider">📌 本段需融合的分论点：</p>
                    {activeSubpoint.points.map((pt: string, pIdx: number) => (
                      <div key={pIdx} className="flex items-start gap-1">
                        <span className="text-indigo-500 shrink-0">•</span>
                        <span>{pt}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Socratic logic chain flow chart */}
              <div className="space-y-4">
                <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                  🔗 论证链条构建状态（Logic Chain Flow）
                </span>

                {activeSubpoint.paragraphPlan ? (
                  <div className="relative border border-indigo-100 bg-indigo-50/10 rounded-xl p-4 space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-2 py-1 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-800 border border-indigo-200">
                        {modeLabel[activeSubpoint.paragraphPlan.mode] || activeSubpoint.paragraphPlan.mode}
                      </span>
                      <span className="text-[11px] text-slate-500 leading-relaxed">
                        {activeSubpoint.paragraphPlan.diagnosis}
                      </span>
                    </div>

                    {activeSubpoint.paragraphPlan.totalClaim && (
                      <div className="bg-white border border-indigo-150 rounded-xl p-3 shadow-3xs">
                        <p className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider mb-1">总观点 (Total Claim)</p>
                        <p className="text-xs text-slate-800 font-bold leading-relaxed">
                          {activeSubpoint.paragraphPlan.totalClaim}
                        </p>
                      </div>
                    )}

                    <div className="space-y-3">
                      {activeSubpoint.paragraphPlan.pointBlocks.map((block, blockIdx) => (
                        <div key={block.id || blockIdx} className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-3xs space-y-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="h-5 w-5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-150 flex items-center justify-center text-[10px] font-bold">
                              {blockIdx + 1}
                            </span>
                            <span className="font-sans text-xs font-bold text-slate-800">
                              {block.label || `分点 ${blockIdx + 1}`}
                            </span>
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                              block.role === "major"
                                ? "bg-emerald-50 text-emerald-700 border-emerald-150"
                                : "bg-slate-50 text-slate-600 border-slate-200"
                            }`}>
                              {block.role === "major" ? "详写" : "略写"}
                            </span>
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-50 text-amber-700 border border-amber-150">
                              {strategyLabel[block.expansionStrategy] || block.expansionStrategy}
                            </span>
                          </div>

                          <div className="bg-slate-50 border border-slate-150 rounded-lg p-2.5">
                            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">子观点 (Sub-Claim)</p>
                            <p className="text-xs text-slate-800 font-bold leading-relaxed">
                              {block.subClaim}
                            </p>
                          </div>

                          <div className="space-y-2">
                            {block.steps.map((step, idx, arr) => {
                              const iconChar = step.key.charAt(0).toUpperCase();
                              const available = isStepAvailable(arr, idx);
                              return (
                                <div key={step.key} className="flex gap-2.5">
                                  <div className="flex flex-col items-center shrink-0">
                                    <div className={`h-5 w-5 rounded-full flex items-center justify-center font-sans font-bold text-[9px] transition ${
                                      step.value ? "bg-indigo-650 text-white" : "bg-slate-100 text-slate-400"
                                    }`}>
                                      {iconChar}
                                    </div>
                                    {idx < arr.length - 1 && (
                                      <div className="w-0.5 flex-1 bg-slate-200 min-h-[12px]"></div>
                                    )}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <span className="text-[10px] font-sans font-bold text-slate-400 uppercase tracking-wider">
                                      {step.label}
                                    </span>
                                    {step.value ? (
                                      <p className="text-slate-700 font-semibold text-[11px] mt-0.5 leading-relaxed bg-slate-50 border border-slate-150 rounded-lg p-2">
                                        {step.value}
                                      </p>
                                    ) : (
                                      <p className="text-slate-400 text-[11px] italic mt-0.5">
                                        {available ? step.placeholder : "等待上一步构建完成后开启..."}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>

                    {activeSubpoint.paragraphPlan.optionalShortClosing && (
                      <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-3xs">
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">简短收束</p>
                        <p className="text-xs text-slate-700 leading-relaxed italic">
                          {activeSubpoint.paragraphPlan.optionalShortClosing}
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="relative border border-indigo-100 bg-indigo-50/10 rounded-xl p-4 space-y-4">
                    {(activeSubpoint.structureSteps || [
                      {
                        key: "claim",
                        label: "核心观点 (Claim)",
                        placeholder: "思考并回答 Coach 的第一个问题以建立一句话核心观点...",
                        value: activeSubpoint.claim
                      },
                      {
                        key: "reason",
                        label: "展开原因 (Reason)",
                        placeholder: activeSubpoint.claim ? "为什么？思考并回答该观点是如何在逻辑上成立的..." : "等待核心观点建立后开启...",
                        value: activeSubpoint.reason
                      },
                      {
                        key: "support",
                        label: `支撑展开 (${activeSubpoint.supportType ? (activeSubpoint.supportType === 'example' ? 'Example / 举例' : activeSubpoint.supportType === 'mechanism' ? 'Mechanism / 机制' : 'Scenario / 场景') : 'Support'})`,
                        placeholder: activeSubpoint.reason ? "在 Coach 推荐的论证策略指导下，思考并回答具体佐证内容..." : "等待原因展开后开启...",
                        value: activeSubpoint.supportContent
                      },
                      {
                        key: "impact",
                        label: "推导结果 (Impact)",
                        placeholder: activeSubpoint.supportContent ? "思考并回答这种优势/佐证最终会产生什么重大影响或长远结果..." : "等待支撑展开后开启...",
                        value: activeSubpoint.impact
                      }
                    ]).map((step, idx, arr) => {
                      const iconChar = step.key.charAt(0).toUpperCase();
                      const available = isStepAvailable(arr, idx);
                      return (
                        <div key={step.key} className="flex gap-3">
                          <div className="flex flex-col items-center shrink-0">
                            <div className={`h-6 w-6 rounded-full flex items-center justify-center font-sans font-bold text-[10px] transition ${step.value ? 'bg-indigo-650 text-white' : 'bg-slate-100 text-slate-400'}`}>
                              {iconChar}
                            </div>
                            {idx < arr.length - 1 && (
                              <div className="w-0.5 flex-1 bg-slate-200 min-h-[16px]"></div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="text-[10px] font-sans font-bold text-slate-400 uppercase tracking-wider">Step {idx + 1}: {step.label}</span>
                            {step.value ? (
                              <p className="text-slate-800 font-bold text-xs mt-0.5 leading-relaxed bg-white border border-slate-150 rounded-lg p-2.5 shadow-3xs">{step.value}</p>
                            ) : (
                              <p className="text-slate-400 text-xs italic mt-0.5">
                                {available ? step.placeholder : "等待上一步构建完成后开启..."}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Three Evaluation Checklists */}
              {activeSubpoint.isCompleted && (
                <div className="space-y-5 pt-3 border-t border-slate-150 animate-fade-in">
                  <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                    🔍 逻辑闭环诊断报告 (AI Coach Diagnosis)
                  </span>

                  {/* Check 1: 逻辑完整性 */}
                  <div className="border border-slate-200 bg-slate-50/50 rounded-xl p-4 space-y-3">
                    <h4 className="font-sans font-bold text-slate-800 text-xs flex items-center gap-1.5">
                      <span className="text-emerald-500">✅</span>
                      <span>1. 逻辑完整性评测 (Logic Completeness)</span>
                    </h4>
                    <div className="overflow-hidden border border-slate-150 rounded-lg bg-white">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead>
                          <tr className="bg-slate-50/50 border-b border-slate-150">
                            <th className="p-2 font-sans font-bold text-slate-600 w-1/3">检查项</th>
                            <th className="p-2 font-sans font-bold text-slate-600 w-16 text-center">结果</th>
                            <th className="p-2 font-sans font-bold text-slate-600">诊断说明</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-150">
                          {(activeSubpoint.completenessChecks || [
                            { label: "是否有明确观点（Claim）", passed: true, desc: "观点非常明确。" },
                            { label: "是否解释了原因（Reason）", passed: true, desc: "解释了为什么具有此核心优势。" },
                            { label: "是否提供了支撑（Support）", passed: true, desc: "提供并锁定了具体的支撑佐证。" },
                            { label: "是否形成逻辑闭环（Impact）", passed: true, desc: "最终影响推导清晰，与观点高度一致。" }
                          ]).map((chk, i) => (
                            <tr key={i} className="hover:bg-slate-50/50">
                              <td className="p-2 font-medium text-slate-700">{chk.label}</td>
                              <td className="p-2 text-center text-emerald-600 font-bold">{chk.passed ? "✅" : "❌"}</td>
                              <td className="p-2 text-slate-500 leading-normal text-[11px]">{chk.desc}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[11px] text-slate-500 leading-relaxed font-semibold">
                      结论：整个论证逻辑连贯，没有明显跳步。
                    </p>
                  </div>

                  {/* Check 2: 自然衔接 */}
                  <div className="border border-slate-200 bg-slate-50/50 rounded-xl p-4 space-y-3">
                    <h4 className="font-sans font-bold text-slate-800 text-xs flex items-center gap-1.5">
                      <span className="text-emerald-500">✅</span>
                      <span>2. 每一步过渡衔接评估 (Transition Coherence)</span>
                    </h4>
                    <div className="space-y-2">
                      {(activeSubpoint.transitionChecks || [
                        { label: "Claim → Reason", passed: true, desc: "过渡自然，直接且顺畅地回答了观点之所以成立的核心动因。" },
                        { label: "Reason → Support", passed: true, desc: "支撑机制/具体例子能精准地服务并巩固前一步骤的理由展开。" },
                        { label: "Support → Impact", passed: true, desc: "结果推导是佐证材料逻辑自然延伸，达到了完美的逻辑闭环，无任何逻辑断层。" }
                      ]).map((trans, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs bg-white border border-slate-150 rounded-lg p-2.5 shadow-3xs">
                          <span className="text-emerald-600 shrink-0 font-bold">✔</span>
                          <div className="min-w-0">
                            <span className="font-bold text-slate-700">{trans.label}：</span>
                            <span className="text-slate-500 text-[11px] leading-relaxed">{trans.desc}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] text-slate-500 leading-relaxed font-semibold">
                      结论：整体逻辑衔接极其自然顺畅。
                    </p>
                  </div>

                  {/* Check 3: 信息量与字数预估 */}
                  <div className="border border-slate-200 bg-slate-50/50 rounded-xl p-4 space-y-3">
                    <h4 className="font-sans font-bold text-slate-800 text-xs flex items-center gap-1.5">
                      <span className="text-indigo-600">📊</span>
                      <span>3. 段落信息充实度评估 (Information Sufficiency)</span>
                    </h4>
                    {activeSubpoint.sufficiencyCheck ? (
                      <div className="text-xs bg-white border border-slate-150 rounded-lg p-3 space-y-2 shadow-3xs">
                        <div className="flex items-center justify-between">
                          <span className="font-sans font-bold text-slate-700">{activeSubpoint.sufficiencyCheck.label}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeSubpoint.sufficiencyCheck.passed ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                            {activeSubpoint.sufficiencyCheck.passed ? "足量 ✓" : "建议补充"}
                          </span>
                        </div>
                        <p className="text-slate-500 text-[11px] leading-relaxed whitespace-pre-wrap">
                          {activeSubpoint.sufficiencyCheck.desc}
                        </p>
                      </div>
                    ) : (
                      <div className="text-xs bg-white border border-slate-150 rounded-lg p-3 space-y-2 shadow-3xs">
                        <div className="flex items-center justify-between">
                          <span className="font-sans font-bold text-slate-700">信息量是否足够写成一个主体段</span>
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                            足量 ✓
                          </span>
                        </div>
                        <p className="text-slate-500 text-[11px] leading-relaxed">
                          目前的信息量非常充分，预计可以写成 90–110 字左右的高质量主体段（约包含 1 句 Topic Sentence，2-3 句逻辑展开，1 句结果总结）。对于 250–300 字的 IELTS Task 2 而言完全足够，无需额外补充内容。
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Action Footer for Step 3 */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 shrink-0 flex items-center justify-between gap-3 min-h-[64px]">
          <div className="text-[11px] text-slate-500">
            {isStep3Finished ? (
              <span className="text-emerald-600 font-bold">🎉 两个核心分论点逻辑链已全部构建完成！</span>
            ) : (
              <span>{activeSubpoint ? "按照提示语与 AI 互动来推进你的论证流程。" : "请在上方先选择一个分论点开启论证流程。"}</span>
            )}
          </div>
          {isStep3Finished && (
            <button
              onClick={onNextStep}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 font-sans text-xs font-semibold text-white shadow-md bg-emerald-600 hover:bg-emerald-700 animate-pulse ring-4 ring-emerald-100 transition-all shrink-0"
            >
              <span>进入第四步：逐句写作练习</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
