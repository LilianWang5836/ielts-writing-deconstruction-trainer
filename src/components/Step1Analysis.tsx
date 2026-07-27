import React, { useState, useEffect, useMemo } from 'react';
import { CheckCircle2, AlertCircle, ArrowRight, Loader2, BookOpen, Layers, Plus, Trash2, Check } from 'lucide-react';
import { Topic, PracticeSession } from '../types';
import CoachChat from './CoachChat';

interface Step1AnalysisProps {
  topic: Topic;
  session: PracticeSession;
  onUpdateSession: (updates: Partial<PracticeSession>) => void;
  onNextStep: () => void;
}

type BoardOverrides = NonNullable<PracticeSession['step1']['boardOverrides']>;
type EditableField = keyof BoardOverrides;

/** Display-only: strip Step1 status tags; mark expandable (probed+可展开). */
function formatStep1DimensionForDisplay(dim: string): {
  label: string;
  expandable: boolean;
} {
  const raw = String(dim || '');
  const has = (tag: string) => new RegExp(`[（(]\\s*${tag}\\s*[）)]`).test(raw);
  const expandable =
    has('可展开') &&
    has('已探测') &&
    !has('质量待确认') &&
    !has('空标签');
  const label = raw
    .replace(/[（(]\s*(可展开|空标签|质量待确认|已探测|已询退出)\s*[）)]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { label: label || raw, expandable };
}

export default function Step1Analysis({
  topic,
  session,
  onUpdateSession,
  onNextStep,
}: Step1AnalysisProps) {
  const [userNotes, setUserNotes] = useState(session.step1.userAnalysisNotes || '');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [activeTab, setActiveTab] = useState<'step1' | 'step2' | 'step3' | 'step4'>('step1');
  const [editingField, setEditingField] = useState<EditableField | null>(null);
  const [draftText, setDraftText] = useState('');
  const [draftList, setDraftList] = useState<string[]>([]);

  // Auto-focus active tab on mount
  useEffect(() => {
    setActiveTab('step1');
  }, []);

  // Update session on editor value change (auto-save style)
  const handleEditorChange = (val: string) => {
    setUserNotes(val);
    onUpdateSession({
      step1: {
        ...session.step1,
        userAnalysisNotes: val,
      },
    });
  };

  const handleEvaluate = async () => {
    if (!userNotes.trim()) {
      setErrorMsg('请在右侧编辑器的【审题笔记】中先写下您的分析笔记。');
      return;
    }
    setLoading(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/coach/evaluate-step1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: topic.question,
          userAnalysisText: userNotes.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setErrorMsg(data.error || '诊断失败，请检查 API 密钥设置。');
        return;
      }

      onUpdateSession({
        step1: {
          ...session.step1,
          userAnalysisNotes: userNotes,
          coachEvaluation: data,
          isCompleted: true,
        },
      });
    } catch (e: any) {
      console.error(e);
      setErrorMsg('评估时发生网络错误，请稍后重试。' + (e.message || ''));
    } finally {
      setLoading(false);
    }
  };

  const evalData = session.step1.coachEvaluation || (session.step1.chatHistory && session.step1.chatHistory.length > 1 ? {
    correctType: "",
    coreIssue: "",
    constraints: [],
    critique: "AI Coach 正在倾听并实时提取你的审题想法。请在左侧继续与 Coach 讨论题型、核心争议和限定条件...",
    score: 0
  } : null);

  // Jump button only after the coach emits the Step 1 completion CTA
  // ("进入第二步"), not merely when slots look filled mid Task-B questioning.
  const showNextStepButton = useMemo(() => {
    if (!session.step1.isCompleted) return false;
    const history = session.step1.chatHistory || [];
    return history.some(
      (m) =>
        m.sender === 'ai' &&
        typeof m.text === 'string' &&
        (m.text.includes('进入第二步') ||
          m.text.includes('进入第二阶段') ||
          /进入\s*Step\s*2/i.test(m.text)),
    );
  }, [session.step1.isCompleted, session.step1.chatHistory]);

  const applyBoardPatch = (patch: BoardOverrides) => {
    if (!evalData) return;
    const nextOverrides: BoardOverrides = {
      ...(session.step1.boardOverrides || {}),
      ...patch,
    };
    // Invalidate step1 digest so the next coach turn rebuilds from board edits.
    const nextMemory = session.memory
      ? { ...session.memory, step1: undefined }
      : undefined;
    onUpdateSession({
      step1: {
        ...session.step1,
        boardOverrides: nextOverrides,
        coachEvaluation: {
          ...evalData,
          ...patch,
        },
      },
      ...(nextMemory ? { memory: nextMemory } : {}),
    });
  };

  const startEditText = (field: EditableField, current: string) => {
    setEditingField(field);
    setDraftText(current || '');
    setDraftList([]);
  };

  const startEditList = (field: 'constraints' | 'suggestedDimensions', current: string[]) => {
    setEditingField(field);
    setDraftList(current.length > 0 ? [...current] : ['']);
    setDraftText('');
  };

  const cancelEdit = () => {
    setEditingField(null);
    setDraftText('');
    setDraftList([]);
  };

  const saveTextField = (field: 'correctType' | 'coreIssue' | 'writingTask' | 'keyQualifier') => {
    applyBoardPatch({ [field]: draftText.trim() });
    cancelEdit();
  };

  const saveListField = (field: 'constraints' | 'suggestedDimensions') => {
    const cleaned = draftList.map((item) => item.trim()).filter(Boolean);
    applyBoardPatch({ [field]: cleaned });
    cancelEdit();
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 md:gap-6 h-full min-h-0 w-full flex-1">
      {/* LEFT COLUMN: AI Coach Dialogue Area */}
      <div className="lg:col-span-5 xl:col-span-5 h-[480px] lg:h-full flex flex-col min-h-0">
        <CoachChat
          topic={topic}
          step={1}
          stepKey="step1"
          session={session}
          onUpdateSession={onUpdateSession}
          stepContext={{ userNotes }}
          welcomeMessage={`【雅思写作原题 (Topic)】
${topic.question}

【第一步：审题分析 🔍】
欢迎！审题是写好雅思作文的第一步。为了彻底拆解这道题，我们一个一个问题来攻克：

👉 **Q1：你认为这道题目属于什么题型？** (例如：Agree or Disagree, Discuss Both Views, Advantages/Disadvantages, Two-part, Problem/Solution, Positive/Negative, 还是 Other？)`}
        >
          {errorMsg && (
            <div className="bg-rose-50 border border-rose-100 rounded-lg p-3 text-rose-800 text-xs flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-rose-500 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Coach Controls / Action bar — only after completion CTA */}
          {showNextStepButton && (
            <div className="mt-4 border-t border-emerald-100 pt-3.5 animate-fade-in">
              <div className="bg-emerald-50 border border-emerald-200/80 rounded-xl p-3.5 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xs">
                <div className="flex items-center gap-2.5">
                  <div className="h-7 w-7 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="h-4 w-4" />
                  </div>
                  <div className="text-left">
                    <h4 className="font-sans font-bold text-emerald-900 text-xs">🎉 审题诊断通关！</h4>
                    <p className="font-sans text-[11px] text-emerald-700 leading-normal">
                      AI Coach 已认定你完成了审题。点击下方按钮，进入下一步观点生成。
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
        {/* Pinned Topic Banner */}
        <div className="bg-slate-50/80 border-b border-slate-200 p-4 shrink-0 backdrop-blur-sm">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="flex h-1.5 w-1.5 rounded-full bg-indigo-600 animate-pulse" />
            <span className="text-[10px] font-sans font-bold text-slate-500 uppercase tracking-wider">
              IELTS Writing Prompt / 雅思写作原题
            </span>
          </div>
          <p className="font-serif italic text-slate-800 text-xs leading-relaxed font-semibold">
            {topic.question}
          </p>
        </div>

        {/* Editor Tabs Header */}
        <div className="flex bg-slate-50 border-b border-slate-200 px-2 overflow-x-auto select-none shrink-0">
          <button
            onClick={() => setActiveTab('step1')}
            className={`flex items-center gap-1 px-4 py-3 font-sans text-xs font-bold border-b-2 transition shrink-0 border-indigo-600 text-indigo-700 bg-white`}
          >
            <BookOpen className="h-3.5 w-3.5 text-indigo-600" />
            <span>📊 审题诊断报告</span>
          </button>
        </div>

        {/* Editor Body */}
        <div className="flex-1 p-5 flex flex-col min-h-0 overflow-y-auto">
          {evalData ? (
            <div className="space-y-5 animate-fade-in">
              <div className="flex items-center justify-between border-b border-slate-200/60 pb-3">
                <div className="flex items-center gap-1.5 font-bold font-sans text-sm">
                  {session.step1.isCompleted ? (
                    <div className="flex items-center gap-1.5 text-emerald-750">
                      <CheckCircle2 className="h-4.5 w-4.5 text-emerald-600" />
                      <span>审题诊断完成</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-indigo-750">
                      <Loader2 className="h-4 w-4 text-indigo-650 animate-spin" />
                      <span>审题要素提取与诊断中...</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-4">
                  {/* ① 题型 */}
                  <div>
                    <div className="mb-1">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">① 题型 (Question Type)</span>
                    </div>
                    {editingField === 'correctType' ? (
                      <div className="space-y-2">
                        <input
                          value={draftText}
                          onChange={(e) => setDraftText(e.target.value)}
                          className="w-full rounded border border-indigo-200 bg-white px-2.5 py-1.5 text-xs md:text-[12.5px] text-indigo-900 font-bold focus:outline-none focus:ring-1 focus:ring-indigo-400"
                          placeholder="例如：Two-part Question"
                          autoFocus
                        />
                        <div className="flex gap-2">
                          <button type="button" onClick={() => saveTextField('correctType')} className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-indigo-700">
                            <Check className="h-3 w-3" /> 保存
                          </button>
                          <button type="button" onClick={cancelEdit} className="rounded px-2.5 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-100">取消</button>
                        </div>
                      </div>
                    ) : (
                      <p className={`text-xs md:text-[12.5px] ${evalData.correctType ? 'text-indigo-900 font-bold' : 'text-slate-400 italic font-medium'}`}>
                        {evalData.correctType || "🔍 正在倾听并识别题型..."}
                      </p>
                    )}
                  </div>

                  {/* ② 核心议题 & 写作任务 */}
                  <div className="pt-3 border-t border-slate-100">
                    <div className="mb-1">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">② 核心议题 & 写作任务 (Writing Task)</span>
                    </div>
                    {editingField === 'coreIssue' || editingField === 'writingTask' ? (
                      <div className="space-y-2">
                        <label className="block text-[10px] font-semibold text-slate-400">
                          {editingField === 'coreIssue' ? '核心议题' : '写作任务'}
                        </label>
                        <textarea
                          value={draftText}
                          onChange={(e) => setDraftText(e.target.value)}
                          rows={2}
                          className="w-full rounded border border-slate-200 px-2 py-1.5 text-xs md:text-[12.5px] text-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                          autoFocus
                        />
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => saveTextField(editingField)}
                            className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-indigo-700"
                          >
                            <Check className="h-3 w-3" /> 保存
                          </button>
                          {editingField === 'coreIssue' && (
                            <button
                              type="button"
                              onClick={() => startEditText('writingTask', evalData.writingTask || '')}
                              className="rounded px-2.5 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50"
                            >
                              改写作任务
                            </button>
                          )}
                          <button type="button" onClick={cancelEdit} className="rounded px-2.5 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-100">取消</button>
                        </div>
                      </div>
                    ) : evalData.writingTask || evalData.coreIssue ? (
                      <div className="space-y-1">
                        {evalData.coreIssue && (
                          <p className="text-xs md:text-[12.5px] text-slate-700 leading-relaxed font-semibold">
                            <span className="text-slate-400 font-normal">核心议题：</span>{evalData.coreIssue}
                          </p>
                        )}
                        {evalData.writingTask && (
                          <p className="text-xs md:text-[12.5px] text-slate-800 leading-relaxed font-bold">
                            <span className="text-slate-400 font-normal">写作任务：</span>{evalData.writingTask}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs md:text-[12.5px] text-slate-400 italic">🔍 正在提取核心议题与具体写作任务...</p>
                    )}
                  </div>

                  {/* ③ 关键限定 */}
                  <div className="pt-3 border-t border-slate-100">
                    <div className="mb-1">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">③ 关键限定词 (Key Qualifiers)</span>
                    </div>
                    {editingField === 'constraints' ? (
                      <div className="space-y-2">
                        {draftList.map((item, i) => (
                          <div key={i} className="flex items-center gap-1.5">
                            <input
                              value={item}
                              onChange={(e) => {
                                const next = [...draftList];
                                next[i] = e.target.value;
                                setDraftList(next);
                              }}
                              className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs md:text-[12.5px] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                              placeholder="限定词"
                            />
                            <button
                              type="button"
                              onClick={() => setDraftList(draftList.filter((_, idx) => idx !== i))}
                              className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => setDraftList([...draftList, ''])}
                          className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo-600 hover:text-indigo-800"
                        >
                          <Plus className="h-3 w-3" /> 添加
                        </button>
                        <div className="flex gap-2 pt-1">
                          <button type="button" onClick={() => saveListField('constraints')} className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-indigo-700">
                            <Check className="h-3 w-3" /> 保存
                          </button>
                          <button type="button" onClick={cancelEdit} className="rounded px-2.5 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-100">取消</button>
                        </div>
                      </div>
                    ) : evalData.keyQualifier || (evalData.constraints && evalData.constraints.length > 0) ? (
                      <div className="space-y-1.5">
                        {(evalData.constraints || []).length > 0 && (
                          <p className="text-xs md:text-[12.5px] text-slate-700 font-medium leading-relaxed">
                            {(evalData.constraints || []).join(' · ')}
                          </p>
                        )}
                        {evalData.keyQualifier && (
                          <p className="text-xs md:text-[12.5px] text-slate-700 leading-relaxed whitespace-pre-wrap font-medium">
                            {evalData.keyQualifier}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs md:text-[12.5px] text-slate-400 italic">🔍 正在分析题目中的特殊限定修饰词...</p>
                    )}
                  </div>

                  {/* ④ 建议讨论维度 */}
                  <div className="pt-3 border-t border-slate-100">
                    <div className="mb-1">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">④ 建议讨论维度 (Suggested Dimensions)</span>
                    </div>
                    {editingField === 'suggestedDimensions' ? (
                      <div className="space-y-2 mt-1">
                        {draftList.map((item, i) => (
                          <div key={i} className="flex items-center gap-1.5">
                            <input
                              value={item}
                              onChange={(e) => {
                                const next = [...draftList];
                                next[i] = e.target.value;
                                setDraftList(next);
                              }}
                              className="flex-1 rounded border border-indigo-200 bg-indigo-50/40 px-2.5 py-1.5 text-xs md:text-[12.5px] text-indigo-900 font-semibold focus:outline-none focus:ring-1 focus:ring-indigo-400"
                              placeholder="维度标签，如：经济发展"
                            />
                            <button
                              type="button"
                              onClick={() => setDraftList(draftList.filter((_, idx) => idx !== i))}
                              className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => setDraftList([...draftList, ''])}
                          className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo-600 hover:text-indigo-800"
                        >
                          <Plus className="h-3 w-3" /> 添加维度
                        </button>
                        <div className="flex gap-2 pt-1">
                          <button type="button" onClick={() => saveListField('suggestedDimensions')} className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-indigo-700">
                            <Check className="h-3 w-3" /> 保存
                          </button>
                          <button type="button" onClick={cancelEdit} className="rounded px-2.5 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-100">取消</button>
                        </div>
                      </div>
                    ) : evalData.suggestedDimensions && evalData.suggestedDimensions.length > 0 ? (
                      <ul className="mt-1 space-y-1">
                        {evalData.suggestedDimensions.map((dim, i) => {
                          const { label, expandable } = formatStep1DimensionForDisplay(dim);
                          return (
                            <li key={i} className="text-xs md:text-[12.5px] text-slate-800 font-semibold flex items-start gap-1.5">
                              <span className="text-slate-400 shrink-0">·</span>
                              <span className="min-w-0">
                                {label}
                                {expandable ? (
                                  <span className="ml-1 text-emerald-600" aria-label="可展开">✓</span>
                                ) : null}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="text-xs md:text-[12.5px] text-slate-400 italic">🔍 正在梳理可以辩证讨论的对比维度...</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6 space-y-4 my-auto">
              <div className="h-12 w-12 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center animate-pulse">
                <BookOpen className="h-6 w-6" />
              </div>
              <div className="max-w-md space-y-1.5">
                <h3 className="font-sans font-bold text-slate-800 text-sm">💡 审题诊断报告正在酝酿中</h3>
                <p className="font-sans text-xs text-slate-500 leading-relaxed">
                  请在左侧交流区向 AI Coach 发送你对该话题的分析、拆解或思路，AI 会在后台自动分析判定并在这里生成专属的【审题诊断报告】。
                </p>
              </div>

              {/* Quick tips panel inside editor */}
              <div className="w-full max-w-lg mt-8 bg-slate-50 rounded-xl p-4 border border-slate-200/80 font-sans text-xs text-slate-600 text-left space-y-2">
                <div className="font-bold text-slate-800 flex items-center gap-1.5 mb-1 text-[11px] uppercase tracking-wider text-indigo-900">
                  <Layers className="h-4 w-4 text-indigo-600 shrink-0" />
                  <span>你可以这样和 AI Coach 讨论：</span>
                </div>
                <ul className="list-disc pl-4 space-y-1 text-[11px] leading-relaxed">
                  <li>“我认为这个题目属于 <strong>Discuss Both Views</strong> 题型，因为它要求我们讨论两方观点并给出立场。”</li>
                  <li>“它的争议核心应该是：<strong>政府是否应当全额资助艺术博物馆。</strong>”</li>
                  <li>“关键的限定条件有：‘free of charge’ (免费) 以及 ‘all visitors’ (对所有游客)。”</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
