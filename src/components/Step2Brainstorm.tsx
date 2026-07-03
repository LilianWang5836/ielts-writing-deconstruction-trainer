import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { CheckCircle2, AlertCircle, ArrowRight, Loader2, BookOpen, Award, Layers, Sparkles } from 'lucide-react';
import { Topic, PracticeSession, Dimension } from '../types';
import CoachChat from './CoachChat';

interface Step2BrainstormProps {
  topic: Topic;
  session: PracticeSession;
  onUpdateSession: (updates: Partial<PracticeSession>) => void;
  onNextStep: () => void;
}

export default function Step2Brainstorm({
  topic,
  session,
  onUpdateSession,
  onNextStep,
}: Step2BrainstormProps) {
  const [userStance, setUserStance] = useState(session.step2.userStance || '');
  const [userPoints, setUserPoints] = useState(session.step2.userPoints || '');
  const [dimensions, setDimensions] = useState<Dimension[]>([]);
  const [loadingDims, setLoadingDims] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [activeTab, setActiveTab] = useState<'step1' | 'step2' | 'step3' | 'step4'>('step2');
  const eval1 = session.step1.coachEvaluation;
  const userNotes = session.step1.userAnalysisNotes?.trim();
  const step1SuggestedDimensions = (eval1?.suggestedDimensions || [])
    .map((d) => (typeof d === 'string' ? d.trim() : ''))
    .filter((d): d is string => !!d);

  const normalizeDimensionCard = (rawText: string, idx: number): Dimension => {
    const text = rawText.trim();
    const bracketMatch = text.match(/^(.+?)\s*[（(]\s*(.+?)\s*[)）]\s*$/);
    const name = (bracketMatch?.[1] || text).trim();
    const prompt = bracketMatch ? `${name} (${bracketMatch[2].trim()})` : `${name} (from step1)`;
    return {
      id: `s1d-${idx + 1}`,
      name,
      prompt,
      selected: false,
    };
  };

  const mergeDimensionCards = (seed: Dimension[], fetched: Dimension[]) => {
    const seen = new Set<string>();
    const merged: Dimension[] = [];
    [...seed, ...fetched].forEach((dim, idx) => {
      const key = `${(dim.name || '').trim().toLowerCase()}|${(dim.prompt || '').trim().toLowerCase()}`;
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push({
        ...dim,
        id: dim.id || `dim-${idx + 1}`,
        selected: !!dim.selected,
      });
    });
    return merged;
  };

  // Load brainstorming dimensions as inspiration cards on mount
  useEffect(() => {
    setActiveTab('step2');
    if (session.step2.dimensions && session.step2.dimensions.length > 0) {
      setDimensions(session.step2.dimensions);
    } else {
      fetchDimensions();
    }
  }, []);

  const fetchDimensions = async () => {
    setLoadingDims(true);
    try {
      const seededFromStep1: Dimension[] = step1SuggestedDimensions.map((d, idx) =>
        normalizeDimensionCard(d, idx),
      );
      if (!session.step2.dimensions?.length && seededFromStep1.length > 0) {
        setDimensions(seededFromStep1);
        onUpdateSession({
          step2: {
            ...session.step2,
            dimensions: seededFromStep1,
          },
        });
      }

      const res = await fetch('/api/brainstorm-dimensions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: topic.question,
          questionType: topic.questionType,
          userNotes: userNotes || '',
          suggestedDimensions: step1SuggestedDimensions,
        }),
      });
      const data = await res.json();
      if (data.dimensions) {
        const mappedFromApi: Dimension[] = data.dimensions.map((d: any) => ({
          id: d.id,
          name: d.name,
          prompt: d.prompt,
          selected: false,
        }));
        const mapped = mergeDimensionCards(seededFromStep1, mappedFromApi);
        setDimensions(mapped);
        onUpdateSession({
          step2: {
            ...session.step2,
            dimensions: mapped,
          },
        });
      }
    } catch (e) {
      console.error('Failed to fetch dimensions:', e);
    } finally {
      setLoadingDims(false);
    }
  };

  const handleStanceChange = (val: string) => {
    setUserStance(val);
    onUpdateSession({
      step2: {
        ...session.step2,
        userStance: val,
      },
    });
  };

  const handlePointsChange = (val: string) => {
    setUserPoints(val);
    onUpdateSession({
      step2: {
        ...session.step2,
        userPoints: val,
      },
    });
  };

  const handleEvaluate = async () => {
    if (!userStance.trim() || !userPoints.trim()) {
      setErrorMsg('请在右侧编辑器的【逻辑论点】中，同时填写您的全文立场与段落分论点。');
      return;
    }
    setLoading(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/coach/evaluate-step2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: topic.question,
          questionType: topic.questionType,
          userStance: userStance.trim(),
          userPoints: userPoints.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setErrorMsg(data.error || '评估失败，请检查 API 密钥设置。');
        return;
      }

      onUpdateSession({
        step2: {
          ...session.step2,
          userStance,
          userPoints,
          selectedThesis: data.suggestedStance, // store as selectedThesis for Step 3 template recomendation fallback
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

  const chatHistory = session.step2.chatHistory || [];
  const evalData = session.step2.coachEvaluation || (session.step2.chatHistory && session.step2.chatHistory.length > 1 ? {
    userStance: session.step2.userStance || "",
    userPoints: session.step2.userPoints || "",
    critique: "AI Coach 正在倾听你的讨论，并将实时提取你的全文立场与分论点...",
    suggestions: [],
    suggestedStance: session.step2.selectedThesis || "",
    suggestedPoints: "",
    blueprint: undefined as any,
    positionCheckPassed: undefined as boolean | undefined,
    positionCheckDesc: undefined as string | undefined,
    coverageCheckPassed: undefined as boolean | undefined,
    coverageCheckDesc: undefined as string | undefined,
    structureCheckPassed: undefined as boolean | undefined,
    structureCheckDesc: undefined as string | undefined,
    clustering: undefined as any,
  } : null);

  let previousNotes = "";
  if (eval1) {
    previousNotes = `题型判定：${eval1.correctType}\n核心争议：${eval1.coreIssue}${eval1.constraints && eval1.constraints.length > 0 ? `\n关键限定：${eval1.constraints.join('、')}` : ''}`;
    if (step1SuggestedDimensions.length > 0) {
      previousNotes += `\n建议讨论维度：${step1SuggestedDimensions.join('、')}`;
    }
    if (userNotes) {
      previousNotes += `\n我的审题想法：${userNotes}`;
    }
  } else {
    previousNotes = userNotes || session.step1.chatHistory?.filter((m: any) => m.sender === 'user').map((m: any) => m.text).join(' | ').trim() || '';
  }

  // Welcome bubble is a pure bridge (recap only, no committed question). The
  // real, context-reasoned first question is generated by the LLM via
  // autoKickoff below, so the two never compete or duplicate each other.
  const welcomeMessage = previousNotes
    ? `【雅思写作原题 (Topic)】
${topic.question}

【第二步：立场与论点 🧠】
欢迎进入第二步！一个优秀的雅思议论文需要极强的逻辑链条。

在第一步审题中，你已经记录了以下核心想法：
${previousNotes.split('\n').map(line => `> *“${line}”*`).join('\n')}

我正在结合你第一步的审题结论，为你定制第一个发散问题...`
    : `【雅思写作原题 (Topic)】
${topic.question}

【第二步：立场与论点 🧠】
欢迎进入第二步！一个优秀的雅思议论文需要极强的逻辑链条。我们不急于一下子要立场或答案，让我们一步一步来。

我正在结合这道题目，为你定制第一个发散问题...`;

  const kickoffPrompt = (() => {
    const issueText = eval1?.coreIssue || "";
    const constraintsText = eval1?.constraints && eval1.constraints.length > 0
      ? eval1.constraints.join('、')
      : "";
    const dimensionsText = step1SuggestedDimensions.length > 0
      ? step1SuggestedDimensions.join('、')
      : "";

    const contextLines = [
      issueText ? `核心争议：${issueText}` : "",
      constraintsText ? `关键限定：${constraintsText}` : "",
      dimensionsText ? `建议讨论维度：${dimensionsText}` : "",
      userNotes ? `我的审题想法：${userNotes}` : "",
    ].filter(Boolean);

    return `这是第二步的开场，我还没有说任何话，请不要假装在回应我说过的内容。${
      contextLines.length > 0
        ? `请直接结合我第一步的审题结论（${contextLines.join('；')}），`
        : "请直接结合这道题目本身，"
    }给我一个高质量、有针对性的发散问题（Explore-A 阶段），引导我先谈这个立场下最值得展开的具体支持论据或正面好处；不要泛泛而问，要让问题贴合这道题目和已知信息。`;
  })();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 md:gap-6 h-full min-h-0 w-full flex-1">
      {/* LEFT COLUMN: AI Coach Dialogue Area */}
      <div className="lg:col-span-5 xl:col-span-5 h-[480px] lg:h-full flex flex-col min-h-0">
        <CoachChat
          topic={topic}
          step={2}
          stepKey="step2"
          session={session}
          onUpdateSession={onUpdateSession}
          stepContext={{ userStance, userPoints }}
          welcomeMessage={welcomeMessage}
          autoKickoff={true}
          kickoffPrompt={kickoffPrompt}
        >
          {errorMsg && (
            <div className="bg-rose-50 border border-rose-100 rounded-lg p-3 text-rose-800 text-xs flex items-center gap-2 mt-2">
              <AlertCircle className="h-4 w-4 text-rose-500 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Coach Controls / Action bar - Auto-progression upon AI completion */}
          {session.step2.isCompleted && (
            <div className="mt-4 border-t border-emerald-100 pt-3.5 animate-fade-in">
              <div className="bg-emerald-50 border border-emerald-200/80 rounded-xl p-3.5 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xs">
                <div className="flex items-center gap-2.5">
                  <div className="h-7 w-7 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="h-4 w-4" />
                  </div>
                  <div className="text-left">
                    <h4 className="font-sans font-bold text-emerald-900 text-xs">🎉 观点与分论点通关！</h4>
                    <p className="font-sans text-[11px] text-emerald-700 leading-normal">
                      AI Coach 已判定你的观点与分论点设计合格，即将为你<strong>自动切换</strong>到下一步论证拆解...
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
            onClick={() => setActiveTab('step2')}
            className={`flex items-center gap-1 px-4 py-3 font-sans text-xs font-bold border-b-2 transition shrink-0 ${
              activeTab === 'step2'
                ? 'border-indigo-600 text-indigo-700 bg-white font-extrabold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Layers className="h-3.5 w-3.5 text-indigo-600" />
            <span>📊 立场与论据看板</span>
          </button>
          <button
            onClick={() => setActiveTab('step1')}
            className={`flex items-center gap-1 px-4 py-3 font-sans text-xs font-bold border-b-2 transition shrink-0 ${
              activeTab === 'step1'
                ? 'border-indigo-600 text-indigo-700 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <BookOpen className="h-3.5 w-3.5 text-slate-400" />
            <span>📝 审题诊断回顾</span>
          </button>
        </div>

        {/* Editor Body */}
        <div className="flex-1 p-5 flex flex-col min-h-0 overflow-y-auto">
          {activeTab === 'step1' ? (
            <div className="space-y-4 animate-fade-in">
              <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                第一步：审题诊断历史回顾
              </span>
              {session.step1.coachEvaluation ? (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-0.5">题目核心争议</span>
                    <p className="text-slate-800 font-semibold text-xs leading-relaxed">{session.step1.coachEvaluation.coreIssue}</p>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-0.5">判定题型</span>
                    <p className="text-slate-800 font-bold text-xs">{session.step1.coachEvaluation.correctType}</p>
                  </div>
                </div>
              ) : (
                <p className="text-slate-500 text-xs font-sans">暂无审题记录。</p>
              )}
            </div>
          ) : evalData ? (
            <div className="space-y-5 animate-fade-in">
              {/* Socratic Stage Progress Indicator */}
              <div className="grid grid-cols-4 gap-1.5 text-center bg-slate-50 border border-slate-200/50 p-2.5 rounded-xl">
                {[
                  { id: 'explore_A', label: '1. A面优势' },
                  { id: 'explore_B', label: '2. B面不可替代' },
                  { id: 'stance', label: '3. 明确立场' },
                  { id: 'summary', label: '4. 蓝图生成' },
                ].map((st) => {
                  const currentStage = (evalData as any)?.currentStage || 'explore_A';
                  const isCurrent = currentStage === st.id;
                  const isCompleted = session.step2.isCompleted || (
                    (currentStage === 'explore_B' && st.id === 'explore_A') ||
                    (currentStage === 'stance' && (st.id === 'explore_A' || st.id === 'explore_B')) ||
                    (currentStage === 'summary' && st.id !== 'summary')
                  );
                  return (
                    <div
                      key={st.id}
                      className={`py-1 px-1 rounded text-[10px] font-bold transition-all border ${
                        isCompleted
                          ? 'bg-emerald-50 text-emerald-800 border-emerald-250/50'
                          : isCurrent
                          ? 'bg-indigo-600 text-white border-indigo-600 shadow-4xs'
                          : 'bg-white text-slate-400 border-slate-200/60'
                      }`}
                    >
                      {st.label}
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center justify-between border-b border-slate-200/60 pb-3">
                <div className="flex items-center gap-1.5 font-bold font-sans text-sm">
                  {session.step2.isCompleted ? (
                    <div className="flex items-center gap-1.5 text-emerald-750">
                      <CheckCircle2 className="h-4.5 w-4.5 text-emerald-600" />
                      <span>立场与分论点诊断完成</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-indigo-750">
                      <Loader2 className="h-4 w-4 text-indigo-650 animate-spin" />
                      <span>立场与分论点提炼讨论中...</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                {/* Essay Blueprint Card */}
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 space-y-4">
                  <div className="border-b border-slate-200 pb-2">
                    <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider block mb-1">Essay Blueprint / 文章结构蓝图</span>
                  </div>

                  {/* 题目 (Question) */}
                  <div className="space-y-1">
                    <span className="text-[9px] font-bold text-slate-400 uppercase">写作原题 (Topic)</span>
                    <p className="text-xs italic text-slate-700 font-serif leading-relaxed font-semibold">
                      {topic.question}
                    </p>
                  </div>

                  {/* 立场 (Position) */}
                  <div className="space-y-1">
                    <span className="text-[9px] font-bold text-slate-400 uppercase">全文立场 (Overall Position)</span>
                    <p className={`text-xs leading-relaxed ${evalData.blueprint?.position || evalData.userStance ? 'text-slate-900 font-bold' : 'text-slate-400 italic'}`}>
                      {evalData.blueprint?.position || evalData.userStance || "⏳ 正在提取并总结你的立场..."}
                    </p>
                  </div>

                  {/* Dynamic Clustered Body Paragraphs */}
                  {evalData.blueprint?.bodies && evalData.blueprint.bodies.length > 0 ? (
                    evalData.blueprint.bodies.map((b: any, index: number) => (
                      <div key={index} className="space-y-1 bg-white p-2.5 rounded border border-slate-200/60 shadow-3xs">
                        <span className="text-[9px] font-bold text-slate-400 uppercase">{b.title || `Body Paragraph ${index + 1}`}</span>
                        <p className="text-xs leading-relaxed text-slate-800 font-semibold">
                          {b.content}
                        </p>
                      </div>
                    ))
                  ) : (
                    <>
                      {/* Body Paragraph 1 */}
                      <div className="space-y-1 bg-white p-2.5 rounded border border-slate-200/60 shadow-3xs">
                        <span className="text-[9px] font-bold text-slate-400 uppercase">Body Paragraph 1 (第一主体段核心分论点)</span>
                        <p className={`text-xs leading-relaxed ${evalData.blueprint?.body1 || evalData.userPoints ? 'text-slate-800 font-semibold' : 'text-slate-400 italic'}`}>
                          {evalData.blueprint?.body1 || (evalData.userPoints ? evalData.userPoints.split('\n')[0] : "⏳ 正在总结主体段 1 的核心观点...")}
                        </p>
                      </div>

                      {/* Body Paragraph 2 */}
                      <div className="space-y-1 bg-white p-2.5 rounded border border-slate-200/60 shadow-3xs">
                        <span className="text-[9px] font-bold text-slate-400 uppercase">Body Paragraph 2 (第二主体段核心分论点)</span>
                        <p className={`text-xs leading-relaxed ${evalData.blueprint?.body2 || evalData.userPoints ? 'text-slate-800 font-semibold' : 'text-slate-400 italic'}`}>
                          {evalData.blueprint?.body2 || (evalData.userPoints && evalData.userPoints.split('\n')[1] ? evalData.userPoints.split('\n')[1] : "⏳ 正在总结主体段 2 的核心观点...")}
                        </p>
                      </div>
                    </>
                  )}
                </div>

                {/* 智能观点聚类规划 (Argument Clustering) */}
                {evalData.clustering && (
                  <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 space-y-4">
                    <div className="border-b border-slate-200 pb-2 flex items-center justify-between">
                      <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider block">Argument Clustering / 智能观点聚类规划</span>
                      <span className="text-[9px] px-1.5 py-0.5 bg-indigo-100 text-indigo-750 font-bold rounded-full">
                        共 {evalData.clustering.totalPoints || 0} 个原始论点
                      </span>
                    </div>

                    {/* Original brainstormed points container */}
                    {evalData.clustering.pointsList && evalData.clustering.pointsList.length > 0 && (
                      <div className="space-y-1.5 bg-white p-2.5 rounded border border-slate-200/50 shadow-3xs">
                        <span className="text-[9px] font-bold text-slate-400 uppercase">发散出的原始观点 (Brainstormed Points)</span>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {evalData.clustering.pointsList.map((pt: string, idx: number) => (
                            <span key={idx} className="text-[11px] px-2 py-0.5 bg-slate-100 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 text-slate-700 font-medium rounded-md transition-colors">
                              {pt}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Mapping Clusters Flow */}
                    <div className="space-y-3 pt-1">
                      {evalData.clustering.clusters.map((cluster: any, cIdx: number) => (
                        <div key={cIdx} className="bg-white p-3 rounded-lg border border-slate-200/60 shadow-3xs space-y-2.5 relative overflow-hidden">
                          {/* Top header badge */}
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-indigo-950 flex items-center gap-1">
                              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500"></span>
                              聚类主题: {cluster.theme}
                            </span>
                            <span className="text-[9px] px-1.5 py-0.5 bg-slate-100 border border-slate-200 text-slate-500 font-bold rounded">
                              {cluster.targetBody || `Body ${cIdx + 1}`}
                            </span>
                          </div>

                          {/* Arrow down and mapping points */}
                          <div className="flex flex-col items-center justify-center py-1">
                            <div className="flex flex-wrap gap-1.5 justify-center max-w-md">
                              {cluster.points.map((p: string, pIdx: number) => (
                                <span key={pIdx} className="text-[10px] px-2 py-0.5 bg-indigo-50/50 border border-indigo-100/70 text-indigo-850 font-semibold rounded-md shadow-4xs">
                                  {p}
                                </span>
                              ))}
                            </div>
                            <div className="text-slate-300 font-mono text-xs my-0.5">↓</div>
                            <div className="w-full text-center mt-1 border-t border-dashed border-slate-100 pt-2">
                              <p className="text-[11px] text-slate-700 font-bold leading-relaxed bg-slate-50/50 p-1.5 rounded border border-slate-150/50">
                                {cluster.content}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Outliers */}
                    {evalData.clustering.outliers && evalData.clustering.outliers.length > 0 && (
                      <div className="bg-amber-50/40 border border-amber-200/50 rounded-lg p-3 space-y-2">
                        <span className="text-[10px] font-bold text-amber-800 uppercase tracking-wider block">⚠️ 逸出观点与建议 (Outliers & Advice)</span>
                        <div className="space-y-1.5">
                          {evalData.clustering.outliers.map((outlier: any, oIdx: number) => (
                            <div key={oIdx} className="text-[11px] bg-white border border-amber-100 p-2 rounded shadow-4xs space-y-1">
                              <span className="font-bold text-amber-900">观点: “{outlier.point}”</span>
                              <p className="text-amber-850 leading-relaxed font-medium">{outlier.suggestion}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 逻辑检测看板 */}
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 space-y-3">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1">🔍 逻辑一致性检测看板</span>
                  
                  <div className="space-y-2.5">
                    {/* Position Check */}
                    <div className="flex gap-2.5 items-start p-2 rounded bg-white border border-slate-150/60 shadow-3xs">
                      <div className="mt-0.5">
                        {evalData.positionCheckPassed === undefined ? (
                          <span className="h-4 w-4 rounded-full bg-slate-100 flex items-center justify-center text-[9px] text-slate-400 font-bold">⏳</span>
                        ) : evalData.positionCheckPassed ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                        ) : (
                          <AlertCircle className="h-4 w-4 text-rose-500 shrink-0" />
                        )}
                      </div>
                      <div className="space-y-0.5">
                        <span className="text-xs font-bold text-slate-800">立场一致性检测 (Position Consistency)</span>
                        <p className="text-[11px] text-slate-600 leading-normal">
                          {evalData.positionCheckDesc || "等待观点生成后进行一致性对比..."}
                        </p>
                      </div>
                    </div>

                    {/* Coverage Check */}
                    <div className="flex gap-2.5 items-start p-2 rounded bg-white border border-slate-150/60 shadow-3xs">
                      <div className="mt-0.5">
                        {evalData.coverageCheckPassed === undefined ? (
                          <span className="h-4 w-4 rounded-full bg-slate-100 flex items-center justify-center text-[9px] text-slate-400 font-bold">⏳</span>
                        ) : evalData.coverageCheckPassed ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                        ) : (
                          <AlertCircle className="h-4 w-4 text-rose-500 shrink-0" />
                        )}
                      </div>
                      <div className="space-y-0.5">
                        <span className="text-xs font-bold text-slate-800">审题覆盖度检测 (Scope Coverage)</span>
                        <p className="text-[11px] text-slate-600 leading-normal">
                          {evalData.coverageCheckDesc || "等待分论点生成后检测是否回应了关键限定词..."}
                        </p>
                      </div>
                    </div>

                    {/* Structure Check */}
                    <div className="flex gap-2.5 items-start p-2 rounded bg-white border border-slate-150/60 shadow-3xs">
                      <div className="mt-0.5">
                        {evalData.structureCheckPassed === undefined ? (
                          <span className="h-4 w-4 rounded-full bg-slate-100 flex items-center justify-center text-[9px] text-slate-400 font-bold">⏳</span>
                        ) : evalData.structureCheckPassed ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                        ) : (
                          <AlertCircle className="h-4 w-4 text-rose-500 shrink-0" />
                        )}
                      </div>
                      <div className="space-y-0.5">
                        <span className="text-xs font-bold text-slate-800">结构可行性检测 (Structural Feasibility)</span>
                        <p className="text-[11px] text-slate-600 leading-normal">
                          {evalData.structureCheckDesc || "等待段落规划后检测分论点是否独立且可展开..."}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* AI Review */}
                <div className="bg-indigo-50/25 border border-indigo-100/50 rounded-xl p-4 space-y-3">
                  <div>
                    <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider block mb-1">Coach 逻辑诊疗意见</span>
                    <p className="text-slate-700 text-xs whitespace-pre-wrap leading-relaxed">{evalData.critique}</p>
                  </div>
                </div>

                {/* High scoring demo */}
                <div className="pt-3.5 border-t border-slate-100 space-y-3 bg-slate-50/40 p-4 rounded-xl border border-slate-200/50">
                  <span className="text-[10px] font-bold text-indigo-900 uppercase tracking-wider block">🎓 考官重构示范 (Band 8.0+)</span>
                  <div>
                    <span className="text-[9px] font-bold text-slate-400 uppercase">高分立场示范 (Stance)</span>
                    <p className={`font-serif italic text-xs leading-relaxed ${evalData.suggestedStance ? 'text-slate-850' : 'text-slate-400 italic font-medium'}`}>
                      {evalData.suggestedStance || "🔍 确认立场后解锁..."}
                    </p>
                  </div>
                  <div className="pt-2 border-t border-slate-250/30">
                    <span className="text-[9px] font-bold text-slate-400 uppercase">高分因果分论点示范 (Points)</span>
                    <p className={`text-xs leading-relaxed whitespace-pre-wrap ${evalData.suggestedPoints ? 'text-slate-700' : 'text-slate-400 italic font-medium'}`}>
                      {evalData.suggestedPoints || "🔍 确认分论点后解锁..."}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6 space-y-4 my-auto">
              <div className="h-12 w-12 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center animate-pulse">
                <Layers className="h-6 w-6" />
              </div>
              <div className="max-w-md space-y-1.5">
                <h3 className="font-sans font-bold text-slate-800 text-sm">💡 立场与分论点看板酝酿中</h3>
                <p className="font-sans text-xs text-slate-500 leading-relaxed">
                  请在左侧对话区向 AI Coach 表达你对这道题目的<strong>全文立场</strong>（如赞同、反对还是中立）以及支持立场的<strong>分论点</strong>。AI 会在后台自动捕获提纯，并在这里渲染生成【立场与分论点提分看板】。
                </p>
              </div>

              {/* Quick tips panel inside editor */}
              <div className="w-full max-w-lg mt-8 bg-slate-50 rounded-xl p-4 border border-slate-200/80 font-sans text-xs text-slate-600 text-left space-y-2">
                <div className="font-bold text-slate-800 flex items-center gap-1.5 mb-1 text-[11px] uppercase tracking-wider text-indigo-900">
                  <Sparkles className="h-4 w-4 text-indigo-600 shrink-0" />
                  <span>你可以这样和 AI Coach 交流：</span>
                </div>
                <ul className="list-disc pl-4 space-y-1 text-[11px] leading-relaxed">
                  <li>“我支持完全免费。我准备从‘促进文化教育机会平等’和‘增强社会凝聚力’两个维度写分论点。”</li>
                  <li>“我想采取中立立场：一方面支持全额资助艺术馆以保障公益，但另一方面不免票（而是收取象征性的低廉门票）以减少财政浪费。”</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
