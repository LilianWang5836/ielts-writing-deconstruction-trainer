import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { CheckCircle2, AlertCircle, ArrowRight, Loader2, BookOpen, Award, Layers, Sparkles, ChevronRight } from 'lucide-react';
import { Topic, SentencePracticeTask, PracticeSession } from '../types';
import CoachChat from './CoachChat';

interface Step4SentencePracticeProps {
  topic: Topic;
  session: PracticeSession;
  onUpdateSession: (updates: Partial<PracticeSession>) => void;
  onNextStep: () => void;
}

function parseBoldText(text: string) {
  if (!text) return null;
  const parts = text.split('**');
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return (
        <strong key={index} className="font-extrabold text-indigo-900 bg-indigo-50/70 px-1 py-0.5 rounded border border-indigo-100/50 text-[11px] inline-block mx-0.5 font-sans">
          {part}
        </strong>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

export default function Step4SentencePractice({
  topic,
  session,
  onUpdateSession,
  onNextStep,
}: Step4SentencePracticeProps) {
  const [tasks, setTasks] = useState<SentencePracticeTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [currentTaskIndex, setCurrentTaskIndex] = useState(0);
  const [userDraft, setUserDraft] = useState('');
  const [evaluating, setEvaluating] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [activeTab, setActiveTab] = useState<'step1' | 'step2' | 'step3' | 'step4'>('step4');

  useEffect(() => {
    setActiveTab('step4');
    const hasTasks = session.step4.tasks && session.step4.tasks.length > 0;
    const hasEnglishConcepts = hasTasks && session.step4.tasks.some(
      (t) => !/[\u4e00-\u9fa5]/.test(t.concept || '')
    );

    if (hasTasks && !hasEnglishConcepts) {
      setTasks(session.step4.tasks);
      // find first uncompleted task
      const firstUncompleted = session.step4.tasks.findIndex((t) => !t.userDraft);
      if (firstUncompleted !== -1) {
        setCurrentTaskIndex(firstUncompleted);
        setUserDraft('');
      } else {
        setCurrentTaskIndex(0);
        setUserDraft(session.step4.tasks[0]?.userDraft || '');
      }
    } else {
      generateTasks();
    }
  }, []);

  const generateTasks = async () => {
    setLoadingTasks(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/generate-sentence-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: topic.question,
          questionType: topic.questionType,
          selectedThesis: session.step2.selectedThesis || session.step2.userStance || '',
          subpoints: session.step3.subpoints || [],
        }),
      });
      const data = await res.json();
      if (data.tasks) {
        setTasks(data.tasks);
        onUpdateSession({
          step4: {
            ...session.step4,
            tasks: data.tasks,
          },
        });
      }
    } catch (e) {
      console.error('Failed to generate sentence tasks:', e);
      setErrorMsg('生成写作句式训练任务失败，请检查 API Key。');
    } finally {
      setLoadingTasks(false);
    }
  };

  const handleEvaluateSentence = async () => {
    if (!userDraft.trim()) {
      setErrorMsg('请在右侧编辑器的【句式精进】中写下您的改进英文表达。');
      return;
    }
    setEvaluating(true);
    setErrorMsg('');
    try {
      const activeTask = tasks[currentTaskIndex];
      const res = await fetch('/api/evaluate-sentence-practice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          concept: activeTask.concept,
          prompts: activeTask.prompts,
          userDraft: userDraft.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setErrorMsg(data.error || '句式 AI 诊断失败，请检查 API 密钥设置。');
        return;
      }

      const updatedTasks = tasks.map((task, idx) =>
        idx === currentTaskIndex
          ? { ...task, userDraft: userDraft.trim(), aiFeedback: data }
          : task
      );

      setTasks(updatedTasks);

      const allCompleted = updatedTasks.every((t) => !!t.userDraft);

      onUpdateSession({
        step4: {
          ...session.step4,
          tasks: updatedTasks,
          isCompleted: allCompleted,
        },
      });
    } catch (e: any) {
      console.error(e);
      setErrorMsg('评估学术句式时发生网络错误。' + (e.message || ''));
    } finally {
      setEvaluating(false);
    }
  };

  const handleTaskSelect = (idx: number) => {
    setCurrentTaskIndex(idx);
    setUserDraft(tasks[idx]?.userDraft || '');
    setErrorMsg('');
  };

  const activeTask = tasks[currentTaskIndex];
  const allCompleted = tasks.length > 0 && tasks.every((t) => !!t.userDraft);

  const previousDraft = session.step3.userDraft || (session.step3.subpoints && session.step3.subpoints.map(s => s.draft).filter(Boolean).join('\n\n'));
  const welcomeMessage = previousDraft
    ? `【雅思写作原题 (Topic)】
${topic.question}

【第四步：学术句式强化练 🎯】
欢迎进入第四步！在前面的步骤中，你已经完成了主体段落论证链条的起草。

这是你的段落草稿：
> *“${previousDraft}”*

现在，我们来进行高分词汇与学术句式的专项强化。我已经将你确认的论证链条拆解为逐句翻译升级任务，为你定制了高分学术句式通关练习。

👉 **请阅读下方的任务卡，并在右侧编辑区（或直接在聊天框中）写下第 1 个任务的英文高分表达，然后提交诊断！**`
    : `【雅思写作原题 (Topic)】
${topic.question}

【第四步：学术句式强化练 🎯】
现在我们来进行高分词汇与学术句式的专项强化。我已经将核心语义拆解为逐句翻译升级任务，为你定制了高分学术句式通关练习。

👉 **请阅读下方的任务卡，并在右侧编辑区（或直接在聊天框中）写下第 1 个任务的英文高分表达，然后提交诊断！**`;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 md:gap-6 h-full min-h-0 w-full flex-1">
      {/* LEFT COLUMN: Target Sentence Card & AI Diagnostics */}
      <div className="lg:col-span-5 xl:col-span-5 flex flex-col h-[480px] lg:h-full bg-slate-50 rounded-xl border border-slate-200/80 p-4 min-h-0 overflow-y-auto">
        <div className="space-y-4">
          {/* Header & Progress Indicator */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 uppercase tracking-wider">
              <Sparkles className="h-4 w-4" />
              <span>学术逐句通关训练</span>
            </div>
            {tasks.length > 0 && (
              <span className="font-mono text-[10px] font-bold text-slate-500 bg-slate-200/60 px-2 py-0.5 rounded-full">
                进度: {currentTaskIndex + 1} / {tasks.length}
              </span>
            )}
          </div>

          {/* Quick Clickable Progress Pills */}
          {tasks.length > 0 && (
            <div className="flex items-center justify-between gap-2 pb-1 select-none overflow-x-auto">
              <div className="flex gap-2 shrink-0">
                {tasks.map((task, idx) => (
                  <button
                    key={task.id}
                    onClick={() => handleTaskSelect(idx)}
                    className={`px-3 py-1.5 rounded-lg border font-sans text-xs font-bold transition-all shrink-0 flex items-center gap-1 ${
                      idx === currentTaskIndex
                        ? 'border-indigo-600 bg-indigo-600 text-white shadow-sm'
                        : task.userDraft
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100/70'
                        : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    <span>句 {idx + 1}</span>
                    {task.userDraft && <CheckCircle2 className="h-3 w-3 text-emerald-600" />}
                  </button>
                ))}
              </div>
              <button
                onClick={generateTasks}
                disabled={loadingTasks}
                className="text-[10px] text-indigo-600 font-bold hover:text-indigo-800 shrink-0 hover:underline flex items-center gap-1 cursor-pointer transition-all active:scale-95"
                title="根据第3步大纲重新生成翻译强化练习"
              >
                <span>重新生成 ↻</span>
              </button>
            </div>
          )}

          {loadingTasks && (
            <div className="flex flex-col gap-2 bg-indigo-50/50 rounded-xl p-4 border border-indigo-105/50 font-sans text-xs text-indigo-900 leading-relaxed py-5">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
                <span className="font-bold">正在导入第三步逻辑链并定制句式训练...</span>
              </div>
              <p className="text-[11px] text-slate-500 pl-6 leading-normal">
                AI Coach 正在把你第三步中确认的 Claim（核心论点）、Mechanism（论证机制）与 Result（论证结果）中文核心句顺畅拆解为针对性的【逐句句式升级任务】。
              </p>
            </div>
          )}

          {/* Active Target Card */}
          {activeTask && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3.5">
              <div>
                <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider block mb-1">🎯 核心中文语义目标</span>
                <p className="text-slate-900 font-bold text-sm leading-relaxed bg-indigo-50/50 border-l-4 border-indigo-500 p-3 rounded-r-lg font-sans">
                  {activeTask.concept}
                </p>
              </div>

              <div>
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">🔗 建议高分学术搭配与连接词 (Patterns)</span>
                <div className="space-y-2.5">
                  {activeTask.prompts.map((p, i) => {
                    const hasArrow = p.includes('->');
                    if (hasArrow) {
                      const parts = p.split('->');
                      const engPattern = parts[0].trim();
                      const chiMapping = parts.slice(1).join('->').trim();
                      return (
                        <div key={i} className="bg-slate-50/75 border border-slate-200/60 rounded-lg p-2.5 shadow-xs space-y-1">
                          <div className="flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 rounded-full bg-indigo-500 shrink-0" />
                            <span className="font-mono text-xs font-bold text-indigo-900 select-all">{engPattern}</span>
                          </div>
                          {chiMapping && (
                            <p className="font-sans text-[11px] text-slate-500 pl-3 leading-normal border-l-2 border-indigo-100">
                              {chiMapping}
                            </p>
                          )}
                        </div>
                      );
                    } else {
                      return (
                        <div key={i} className="bg-slate-50 border border-slate-200/60 rounded px-2.5 py-2 font-mono text-[11px] text-slate-700 flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 shrink-0" />
                          <span>{p}</span>
                        </div>
                      );
                    }
                  })}
                </div>
              </div>
            </div>
          )}

          {/* AI Diagnostic Board */}
          {activeTask?.aiFeedback ? (
            <div className="bg-emerald-50/30 border border-emerald-200/60 rounded-xl p-4 shadow-sm space-y-3 animate-fade-in">
              <div className="flex items-center justify-between border-b border-emerald-200/50 pb-2">
                <div className="flex items-center gap-1.5 text-emerald-800 font-extrabold text-xs">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  <span>AI 考官原句精进诊断</span>
                </div>
              </div>

              <div className="space-y-2.5">
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase block mb-0.5">🤔 我的原句表达</span>
                  <p className="font-serif italic text-slate-600 text-xs leading-relaxed pl-2 border-l-2 border-slate-300">
                    "{activeTask.userDraft}"
                  </p>
                </div>

                {activeTask.aiFeedback.grammar && activeTask.aiFeedback.grammar.length > 0 && (
                  <div>
                    <span className="text-[10px] font-bold text-slate-500 uppercase block mb-1">💡 语法与句法分析 (Grammar & Syntax)</span>
                    <ul className="list-disc list-inside text-slate-600 text-xs leading-relaxed space-y-1.5">
                      {activeTask.aiFeedback.grammar.map((g, i) => (
                        <li key={i} className="pl-1 text-[11px] list-none flex items-start gap-1.5">
                          <span className="text-amber-500 shrink-0 mt-1">▸</span>
                          <span className="text-slate-700 leading-normal">{parseBoldText(g)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {activeTask.aiFeedback.lexicalResource && activeTask.aiFeedback.lexicalResource.length > 0 && (
                  <div>
                    <span className="text-[10px] font-bold text-slate-500 uppercase block mb-1">💡 词汇与学术搭配建议 (Vocabulary & Collocations)</span>
                    <ul className="list-disc list-inside text-slate-600 text-xs leading-relaxed space-y-1.5">
                      {activeTask.aiFeedback.lexicalResource.map((l, i) => (
                        <li key={i} className="pl-1 text-[11px] list-none flex items-start gap-1.5">
                          <span className="text-indigo-500 shrink-0 mt-1">▸</span>
                          <span className="text-slate-700 leading-normal">{parseBoldText(l)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-slate-100/50 border border-dashed border-slate-300 rounded-xl p-5 text-center space-y-2 py-8">
              <Award className="h-8 w-8 text-slate-400 mx-auto" />
              <h4 className="font-bold text-slate-700 text-xs">考官句式诊断准备就绪</h4>
              <p className="text-slate-500 text-[11px] leading-relaxed max-w-[240px] mx-auto">
                请在右侧写下你对本句的学术级翻译，然后点击右下方的 <span className="font-bold text-indigo-600">Check 提交句式诊断</span>。
              </p>
            </div>
          )}

          {errorMsg && (
            <div className="bg-rose-50 border border-rose-100 rounded-lg p-3 text-rose-800 text-xs flex items-center gap-2 mt-2">
              <AlertCircle className="h-4 w-4 text-rose-500 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {allCompleted && (
            <div className="bg-emerald-50 border border-emerald-200/80 rounded-xl p-3.5 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xs animate-fade-in mt-2">
              <div className="flex items-center gap-2.5">
                <div className="h-7 w-7 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
                <div className="text-left">
                  <h4 className="font-sans font-bold text-emerald-900 text-xs">🎉 句式精进训练通关！</h4>
                  <p className="font-sans text-[11px] text-emerald-700 leading-normal">
                    你已完成全部句式通关练习。5秒后将为你<strong>自动生成最终评估报告</strong>...
                  </p>
                </div>
              </div>
              <button
                onClick={onNextStep}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-3.5 py-2 font-sans text-xs font-bold transition shrink-0"
              >
                <span>立即跳转</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* RIGHT COLUMN: Persistent Writing Editor & Dynamic Actions */}
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
            className={`flex items-center gap-1 px-4 py-3 font-sans text-xs font-bold border-b-2 transition shrink-0 ${
              activeTab === 'step1'
                ? 'border-indigo-600 text-indigo-700 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <BookOpen className="h-3.5 w-3.5 text-slate-400" />
            <span>📝 审题笔记</span>
          </button>
          <button
            onClick={() => setActiveTab('step2')}
            className={`flex items-center gap-1 px-4 py-3 font-sans text-xs font-bold border-b-2 transition shrink-0 ${
              activeTab === 'step2'
                ? 'border-indigo-600 text-indigo-700 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Layers className="h-3.5 w-3.5 text-slate-400" />
            <span>💡 逻辑论点</span>
          </button>
          <button
            onClick={() => setActiveTab('step3')}
            className={`flex items-center gap-1 px-4 py-3 font-sans text-xs font-bold border-b-2 transition shrink-0 ${
              activeTab === 'step3'
                ? 'border-indigo-600 text-indigo-700 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Layers className="h-3.5 w-3.5 text-slate-400" />
            <span>✍️ 正文起草</span>
          </button>
          <button
            onClick={() => setActiveTab('step4')}
            className={`flex items-center gap-1 px-4 py-3 font-sans text-xs font-bold border-b-2 transition shrink-0 ${
              activeTab === 'step4'
                ? 'border-indigo-600 text-indigo-700 bg-white font-extrabold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Award className="h-3.5 w-3.5 text-indigo-600" />
            <span>🎯 句式精进</span>
          </button>
        </div>

        {/* Editor Body */}
        <div className="flex-1 p-5 flex flex-col min-h-0 overflow-y-auto">
          {activeTab === 'step1' ? (
            <div className="flex-1 flex flex-col min-h-0">
              <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                审题笔记回顾 (Read-only)
              </span>
              <textarea
                value={session.step1.userAnalysisNotes || '暂无笔记。'}
                readOnly
                className="flex-1 w-full p-4 border border-slate-200 rounded-lg font-sans text-sm text-slate-500 bg-slate-50/50 resize-none leading-relaxed focus:outline-none"
              />
            </div>
          ) : activeTab === 'step2' ? (
            <div className="flex-1 flex flex-col min-h-0 space-y-4">
              <div>
                <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  全文总立场回顾 (Read-only)
                </span>
                <div className="p-3 border border-slate-200 rounded-lg font-sans text-sm text-slate-500 bg-slate-50/50 whitespace-pre-wrap">
                  {session.step2.userStance || '暂无总观点。'}
                </div>
              </div>
              <div className="flex-1 flex flex-col min-h-0">
                <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  分论点回顾 (Read-only)
                </span>
                <div className="flex-1 p-3 border border-slate-200 rounded-lg font-sans text-sm text-slate-500 bg-slate-50/50 whitespace-pre-wrap overflow-y-auto">
                  {session.step2.userPoints || '暂无分论点。'}
                </div>
              </div>
            </div>
          ) : activeTab === 'step3' ? (
            <div className="flex-1 flex flex-col min-h-0">
              <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                正文起草草稿区回顾 (Read-only)
              </span>
              <textarea
                value={session.step3.userDraft || '暂无草稿。'}
                readOnly
                className="flex-1 w-full p-4 border border-slate-200 rounded-lg font-serif italic text-sm text-slate-500 bg-slate-50/50 resize-none leading-relaxed focus:outline-none"
              />
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-2">
                <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  当前练习：翻译与学术重构工作区 (Task {currentTaskIndex + 1})
                </span>
                <span className="font-mono text-[10px] text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
                  字数统计: {userDraft.trim().split(/\s+/).filter(Boolean).length} 词 / {userDraft.length} 字符
                </span>
              </div>

              <textarea
                value={userDraft}
                onChange={(e) => setUserDraft(e.target.value)}
                disabled={evaluating || !activeTask}
                placeholder="在此起草你的高分英文重构。尽量融入左侧建议的高分搭配与连接词..."
                className="flex-1 w-full p-4 border border-slate-200 rounded-lg font-serif italic text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-none leading-relaxed"
              />

              {/* Action Buttons inside Workspace */}
              <div className="mt-4 flex flex-col sm:flex-row gap-3">
                <button
                  onClick={handleEvaluateSentence}
                  disabled={evaluating || !userDraft.trim()}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2.5 font-sans text-xs font-bold text-white shadow-sm hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {evaluating ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-white" />
                      <span>正在智能诊断并润色...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      <span>Check 提交句式诊断</span>
                    </>
                  )}
                </button>

                {/* Next task / Next step button if feedback is received */}
                {activeTask?.aiFeedback && (
                  <button
                    onClick={
                      currentTaskIndex < tasks.length - 1
                        ? () => handleTaskSelect(currentTaskIndex + 1)
                        : onNextStep
                    }
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2.5 font-sans text-xs font-bold text-white shadow-md hover:bg-emerald-700 hover:scale-[1.01] transition-all animate-pulse"
                  >
                    <span>
                      {currentTaskIndex < tasks.length - 1 ? '进入下一句练习 ➔' : '进入最终评估报告 🎉'}
                    </span>
                  </button>
                )}
              </div>

              {/* Translation Tips card */}
              <div className="mt-4 bg-indigo-50/40 rounded-lg p-3 border border-indigo-100/60 font-sans text-[11px] text-indigo-950 flex gap-2">
                <BookOpen className="h-4 w-4 text-indigo-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <strong>💡 提分小贴士：</strong>
                  <p className="text-slate-600 leading-relaxed">
                    翻译时，不要硬套字面上的中文。试着采用<strong>“名词化 (Nominalization)”</strong>或<strong>“主被动语态转化”</strong>。例如，不要写 "We can save money by doing this"，升级为高分学术表达 "This approach yields substantial financial savings"。
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
