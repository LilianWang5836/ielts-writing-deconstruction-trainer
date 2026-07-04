import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clipboard,
  Loader2,
  Sparkles,
  Trophy,
} from 'lucide-react';
import { Topic, SentencePracticeTask, PracticeSession } from '../types';

interface Step4SentencePracticeProps {
  topic: Topic;
  session: PracticeSession;
  onUpdateSession: (updates: Partial<PracticeSession>) => void;
  onNextStep: () => void;
}

type SectionKey = 'intro' | 'body1' | 'body2' | 'conclusion';

const SECTION_ORDER: SectionKey[] = ['intro', 'body1', 'body2', 'conclusion'];
const SECTION_LABELS: Record<SectionKey, string> = {
  intro: '第一段（改写+立场）',
  body1: 'Body 1',
  body2: 'Body 2',
  conclusion: 'Conclusion（总结立场）',
};

function parseBoldText(text: string) {
  if (!text) return null;
  const parts = text.split('**');
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return (
        <strong
          key={index}
          className="font-extrabold text-indigo-900 bg-indigo-50/70 px-1 py-0.5 rounded border border-indigo-100/50 text-[11px] inline-block mx-0.5 font-sans"
        >
          {part}
        </strong>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

function inferSectionFromId(id: string): SectionKey {
  if (id.startsWith('intro-')) return 'intro';
  if (id.startsWith('body1-')) return 'body1';
  if (id.startsWith('body2-')) return 'body2';
  if (id.startsWith('conclusion')) return 'conclusion';
  return 'body1';
}

function normalizeTask(task: SentencePracticeTask): SentencePracticeTask {
  const section = task.section || inferSectionFromId(task.id);
  return {
    ...task,
    section,
    confirmed: !!task.confirmed,
    confirmedSentence: task.confirmedSentence || '',
  };
}

function taskSortKey(task: SentencePracticeTask): [number, number] {
  const section = task.section || inferSectionFromId(task.id);
  const sectionIdx = SECTION_ORDER.indexOf(section);
  const numMatch = task.id.match(/(\d+)$/);
  const num = numMatch ? parseInt(numMatch[1], 10) : 0;
  return [sectionIdx === -1 ? 99 : sectionIdx, num];
}

function sortTasksBySectionOrder(tasks: SentencePracticeTask[]): SentencePracticeTask[] {
  return [...tasks]
    .map(normalizeTask)
    .sort((a, b) => {
      const [aSection, aNum] = taskSortKey(a);
      const [bSection, bNum] = taskSortKey(b);
      if (aSection !== bSection) return aSection - bSection;
      return aNum - bNum;
    });
}

export default function Step4SentencePractice({
  topic,
  session,
  onUpdateSession,
}: Step4SentencePracticeProps) {
  const [tasks, setTasks] = useState<SentencePracticeTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [currentTaskIndex, setCurrentTaskIndex] = useState(0);
  const [userDraft, setUserDraft] = useState('');
  const [evaluating, setEvaluating] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const fullDraftRef = useRef<HTMLDivElement>(null);

  const activeTask = tasks[currentTaskIndex];
  const allConfirmed = tasks.length > 0 && tasks.every((t) => !!t.confirmed);
  const activeSection: SectionKey = activeTask?.section || 'intro';

  const sectionTaskMap = useMemo(() => {
    return SECTION_ORDER.reduce((acc, section) => {
      acc[section] = tasks
        .map((task, idx) => ({ task, idx }))
        .filter((entry) => entry.task.section === section);
      return acc;
    }, {} as Record<SectionKey, { task: SentencePracticeTask; idx: number }[]>);
  }, [tasks]);

  const fullDraftText = useMemo(() => {
    const lines: string[] = [];
    SECTION_ORDER.forEach((section) => {
      const sectionTasks = sectionTaskMap[section];
      if (!sectionTasks.length) return;
      lines.push(`${SECTION_LABELS[section]}:`);
      sectionTasks.forEach(({ task }) => {
        if (task.confirmedSentence?.trim()) {
          lines.push(task.confirmedSentence.trim());
        }
      });
      lines.push('');
    });
    return lines.join('\n').trim();
  }, [sectionTaskMap]);

  const totalWords = useMemo(() => {
    return fullDraftText.split(/\s+/).filter(Boolean).length;
  }, [fullDraftText]);

  const setTaskState = (updatedTasks: SentencePracticeTask[]) => {
    setTasks(updatedTasks);
    onUpdateSession({
      step4: {
        ...session.step4,
        tasks: updatedTasks,
        isCompleted: updatedTasks.length > 0 && updatedTasks.every((t) => !!t.confirmed),
      },
    });
  };

  const jumpToFirstPendingTask = (nextTasks: SentencePracticeTask[]) => {
    const sorted = sortTasksBySectionOrder(nextTasks);
    const pendingIdx = sorted.findIndex((task) => !task.confirmed);
    const targetIdx = pendingIdx === -1 ? 0 : pendingIdx;
    setCurrentTaskIndex(targetIdx);
    setUserDraft(
      sorted[targetIdx]?.userDraft || sorted[targetIdx]?.confirmedSentence || '',
    );
    return sorted;
  };

  useEffect(() => {
    const hasTasks = Array.isArray(session.step4.tasks) && session.step4.tasks.length > 0;
    const hasEnglishConcepts =
      hasTasks &&
      session.step4.tasks.some((t) => !/[\u4e00-\u9fa5]/.test(t.concept || ''));
    const normalizedExisting = hasTasks ? session.step4.tasks.map(normalizeTask) : [];
    const hasIntroSection =
      normalizedExisting.length > 0 &&
      normalizedExisting.some((task) => task.section === 'intro');
    const hasConclusionSection =
      normalizedExisting.length > 0 &&
      normalizedExisting.some((task) => task.section === 'conclusion');
    const isLegacyTaskShape = hasTasks && (!hasIntroSection || !hasConclusionSection);

    if (hasTasks && !hasEnglishConcepts && !isLegacyTaskShape) {
      const sorted = jumpToFirstPendingTask(normalizedExisting);
      setTasks(sorted);
      return;
    }
    generateTasks();
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
      if (!res.ok || data.error) {
        setErrorMsg(data.error || '生成写作句式训练任务失败。');
        return;
      }
      if (Array.isArray(data.tasks) && data.tasks.length > 0) {
        const sorted = sortTasksBySectionOrder(data.tasks);
        const positioned = jumpToFirstPendingTask(sorted);
        setTasks(positioned);
        setTaskState(positioned);
      } else {
        setErrorMsg('未生成有效任务，请检查第三步数据后重试。');
      }
    } catch (e) {
      console.error('Failed to generate sentence tasks:', e);
      setErrorMsg('生成写作句式训练任务失败，请检查 API Key。');
    } finally {
      setLoadingTasks(false);
    }
  };

  const handleEvaluateSentence = async () => {
    if (!activeTask) return;
    if (!userDraft.trim()) {
      setErrorMsg('请先写出当前句子的英文版本。');
      return;
    }
    setEvaluating(true);
    setErrorMsg('');
    try {
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
        idx === currentTaskIndex ? { ...task, userDraft: userDraft.trim(), aiFeedback: data } : task,
      );
      setTaskState(updatedTasks);
    } catch (e: any) {
      console.error(e);
      setErrorMsg('评估学术句式时发生网络错误。' + (e.message || ''));
    } finally {
      setEvaluating(false);
    }
  };

  const handleConfirmSentence = () => {
    if (!activeTask) return;
    if (!userDraft.trim()) {
      setErrorMsg('请先输入英文句子，再进行确认。');
      return;
    }
    if (!activeTask.aiFeedback) {
      setErrorMsg('请先点击 Check 获取诊断反馈，再确认最终版本。');
      return;
    }

    const updatedTasks = tasks.map((task, idx) =>
      idx === currentTaskIndex
        ? {
            ...task,
            userDraft: userDraft.trim(),
            confirmedSentence: userDraft.trim(),
            confirmed: true,
          }
        : task,
    );
    const sortedUpdated = sortTasksBySectionOrder(updatedTasks);
    setTaskState(sortedUpdated);
    setErrorMsg('');

    const nextPendingIdx = sortedUpdated.findIndex((task) => !task.confirmed);
    if (nextPendingIdx !== -1) {
      setCurrentTaskIndex(nextPendingIdx);
      setUserDraft(
        sortedUpdated[nextPendingIdx].userDraft ||
          sortedUpdated[nextPendingIdx].confirmedSentence ||
          '',
      );
    }
  };

  const handleTaskSelect = (idx: number) => {
    setCurrentTaskIndex(idx);
    setUserDraft(tasks[idx]?.userDraft || tasks[idx]?.confirmedSentence || '');
    setErrorMsg('');
  };

  const handleSectionSelect = (section: SectionKey) => {
    const sectionTasks = sectionTaskMap[section];
    if (!sectionTasks || sectionTasks.length === 0) return;
    const firstPending = sectionTasks.find(({ task }) => !task.confirmed);
    const target = firstPending || sectionTasks[0];
    handleTaskSelect(target.idx);
  };

  const handleCopyDraft = async () => {
    if (!fullDraftText) return;
    try {
      await navigator.clipboard.writeText(fullDraftText);
    } catch (err) {
      console.error('Copy failed:', err);
      setErrorMsg('复制失败，请手动复制右侧内容。');
    }
  };

  const handleScrollToDraft = () => {
    fullDraftRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 md:gap-6 h-full min-h-0 w-full flex-1">
      <div className="lg:col-span-5 xl:col-span-5 flex flex-col h-[480px] lg:h-full bg-slate-50 rounded-xl border border-slate-200/80 p-4 min-h-0 overflow-y-auto">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 uppercase tracking-wider">
              <Sparkles className="h-4 w-4" />
              <span>分段逐句通关训练</span>
            </div>
            {tasks.length > 0 && (
              <span className="font-mono text-[10px] font-bold text-slate-500 bg-slate-200/60 px-2 py-0.5 rounded-full">
                已确认: {tasks.filter((t) => t.confirmed).length} / {tasks.length}
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            {SECTION_ORDER.map((section) => {
              const sectionTasks = sectionTaskMap[section];
              const done = sectionTasks.filter(({ task }) => task.confirmed).length;
              const total = sectionTasks.length;
              const isActive = activeSection === section;
              return (
                <button
                  key={section}
                  onClick={() => handleSectionSelect(section)}
                  disabled={total === 0}
                  className={`rounded-lg border px-3 py-2 text-left transition ${
                    isActive
                      ? 'border-indigo-600 bg-indigo-50 text-indigo-900'
                      : done === total && total > 0
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                      : 'border-slate-200 bg-white text-slate-600'
                  } ${total === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="text-[11px] font-bold leading-tight">{SECTION_LABELS[section]}</div>
                  <div className="text-[10px] mt-1 font-mono">
                    {done}/{total || 0}
                  </div>
                </button>
              );
            })}
          </div>

          {!allConfirmed && sectionTaskMap[activeSection]?.length > 0 && (
            <div className="flex items-center justify-between gap-2 pb-1 select-none overflow-x-auto">
              <div className="flex gap-2 shrink-0">
                {sectionTaskMap[activeSection].map(({ task, idx }, localIdx) => (
                  <button
                    key={task.id}
                    onClick={() => handleTaskSelect(idx)}
                    className={`px-3 py-1.5 rounded-lg border font-sans text-xs font-bold transition-all shrink-0 flex items-center gap-1 ${
                      idx === currentTaskIndex
                        ? 'border-indigo-600 bg-indigo-600 text-white shadow-sm'
                        : task.confirmed
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100/70'
                        : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    <span>句 {localIdx + 1}</span>
                    {task.confirmed && <CheckCircle2 className="h-3 w-3 text-emerald-600" />}
                  </button>
                ))}
              </div>
              <button
                onClick={generateTasks}
                disabled={loadingTasks}
                className="text-[10px] text-indigo-600 font-bold hover:text-indigo-800 shrink-0 hover:underline flex items-center gap-1 cursor-pointer transition-all active:scale-95"
                title="根据当前数据重新生成逐句任务"
              >
                <span>重新生成 ↻</span>
              </button>
            </div>
          )}

          {loadingTasks && (
            <div className="flex flex-col gap-2 bg-indigo-50/50 rounded-xl p-4 border border-indigo-105/50 font-sans text-xs text-indigo-900 leading-relaxed py-5">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
                <span className="font-bold">正在生成分段逐句训练任务...</span>
              </div>
              <p className="text-[11px] text-slate-500 pl-6 leading-normal">
                正在根据你的立场与 Body 论证链，生成 Intro / Body1 / Body2 / Conclusion 的目标句与句式提示。
              </p>
            </div>
          )}

          {allConfirmed ? (
            <div className="bg-emerald-50 border border-emerald-200/80 rounded-xl p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="h-8 w-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0">
                  <Trophy className="h-4 w-4" />
                </div>
                <div>
                  <h4 className="font-sans font-bold text-emerald-900 text-sm">🎉 全文写作完成</h4>
                  <p className="font-sans text-xs text-emerald-800 mt-1 leading-relaxed">
                    你已完成四段全部确认版本。右侧已汇总最终可用全文，当前共 {tasks.length} 句、约 {totalWords} 词。
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleScrollToDraft}
                  className="flex-1 rounded-lg bg-emerald-600 text-white text-xs font-bold py-2 hover:bg-emerald-700 transition"
                >
                  查看全文
                </button>
                <button
                  onClick={handleCopyDraft}
                  className="flex-1 rounded-lg border border-emerald-300 text-emerald-800 text-xs font-bold py-2 hover:bg-emerald-100 transition"
                >
                  复制全文
                </button>
              </div>
            </div>
          ) : (
            <>
              {activeTask && (
                <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3.5">
                  <div>
                    <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider block mb-1">
                      🎯 当前中文语义目标
                    </span>
                    <p className="text-slate-900 font-bold text-sm leading-relaxed bg-indigo-50/50 border-l-4 border-indigo-500 p-3 rounded-r-lg font-sans">
                      {activeTask.concept}
                    </p>
                  </div>

                  <div>
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">
                      🔗 句型骨架提示（仅结构，不含具体译词）
                    </span>
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
                        }
                        return (
                          <div key={i} className="bg-slate-50 border border-slate-200/60 rounded px-2.5 py-2 font-mono text-[11px] text-slate-700 flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 shrink-0" />
                            <span>{p}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {activeTask?.aiFeedback ? (
                <div className="bg-emerald-50/30 border border-emerald-200/60 rounded-xl p-4 shadow-sm space-y-3 animate-fade-in">
                  <div className="flex items-center justify-between border-b border-emerald-200/50 pb-2">
                    <div className="flex items-center gap-1.5 text-emerald-800 font-extrabold text-xs">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      <span>AI 诊断反馈</span>
                    </div>
                  </div>
                  <div className="space-y-2.5">
                    <div>
                      <span className="text-[10px] font-bold text-slate-400 uppercase block mb-0.5">当前英文版本</span>
                      <p className="font-serif italic text-slate-600 text-xs leading-relaxed pl-2 border-l-2 border-slate-300">
                        "{activeTask.userDraft}"
                      </p>
                    </div>
                    {activeTask.aiFeedback.grammar?.length > 0 && (
                      <div>
                        <span className="text-[10px] font-bold text-slate-500 uppercase block mb-1">语法与句法</span>
                        <ul className="text-slate-600 text-xs leading-relaxed space-y-1.5">
                          {activeTask.aiFeedback.grammar.map((g, i) => (
                            <li key={i} className="pl-1 text-[11px] list-none flex items-start gap-1.5">
                              <span className="text-amber-500 shrink-0 mt-1">▸</span>
                              <span className="text-slate-700 leading-normal">{parseBoldText(g)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {activeTask.aiFeedback.lexicalResource?.length > 0 && (
                      <div>
                        <span className="text-[10px] font-bold text-slate-500 uppercase block mb-1">词汇与搭配</span>
                        <ul className="text-slate-600 text-xs leading-relaxed space-y-1.5">
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
                  <h4 className="font-bold text-slate-700 text-xs">诊断准备就绪</h4>
                  <p className="text-slate-500 text-[11px] leading-relaxed max-w-[260px] mx-auto">
                    先写右侧英文句子并点击 <span className="font-bold text-indigo-600">Check 提交句式诊断</span>，再确认最终版本。
                  </p>
                </div>
              )}
            </>
          )}

          {errorMsg && (
            <div className="bg-rose-50 border border-rose-100 rounded-lg p-3 text-rose-800 text-xs flex items-center gap-2 mt-2">
              <AlertCircle className="h-4 w-4 text-rose-500 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>
      </div>

      <div className="lg:col-span-7 xl:col-span-7 flex flex-col h-[480px] lg:h-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden min-h-0">
        <div className="bg-slate-50/80 border-b border-slate-200 p-4 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-sans font-bold text-slate-500 uppercase tracking-wider mb-1">
                IELTS Writing Prompt / 雅思写作原题
              </div>
              <p className="font-serif italic text-slate-800 text-xs leading-relaxed font-semibold">
                {topic.question}
              </p>
            </div>
            <button
              onClick={handleCopyDraft}
              disabled={!fullDraftText}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Clipboard className="h-3.5 w-3.5" />
              复制全文
            </button>
          </div>
        </div>

        <div className="flex-1 p-5 grid grid-rows-[1fr_auto] gap-4 min-h-0">
          <div ref={fullDraftRef} className="overflow-y-auto border border-slate-200 rounded-xl p-4 bg-slate-50/40 space-y-4">
            {SECTION_ORDER.map((section) => {
              const sectionTasks = sectionTaskMap[section];
              if (!sectionTasks.length) return null;
              return (
                <section key={section} className="space-y-2">
                  <h4 className="text-[11px] font-extrabold uppercase tracking-wide text-slate-600">
                    {SECTION_LABELS[section]}
                  </h4>
                  <div className="space-y-2">
                    {sectionTasks.map(({ task }) => (
                      <div
                        key={task.id}
                        className={`rounded-lg border px-3 py-2 text-sm leading-relaxed ${
                          task.confirmedSentence?.trim()
                            ? 'border-emerald-200 bg-emerald-50/60 text-slate-800'
                            : 'border-slate-200 bg-white text-slate-400 italic'
                        }`}
                      >
                        {task.confirmedSentence?.trim() || `待确认：${task.concept}`}
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>

          {!allConfirmed && (
            <div className="border border-slate-200 rounded-xl p-4 bg-white">
              <div className="flex items-center justify-between mb-2">
                <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  当前练习工作区
                </span>
                <span className="font-mono text-[10px] text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
                  {userDraft.trim().split(/\s+/).filter(Boolean).length} 词 / {userDraft.length} 字符
                </span>
              </div>
              <textarea
                value={userDraft}
                onChange={(e) => setUserDraft(e.target.value)}
                disabled={evaluating || !activeTask}
                placeholder="在此起草当前句子的英文最终版本..."
                className="w-full h-32 p-4 border border-slate-200 rounded-lg font-serif italic text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-none leading-relaxed"
              />
              <div className="mt-3 flex flex-col sm:flex-row gap-2">
                <button
                  onClick={handleEvaluateSentence}
                  disabled={evaluating || !userDraft.trim() || !activeTask}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2.5 font-sans text-xs font-bold text-white shadow-sm hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {evaluating ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-white" />
                      <span>诊断中...</span>
                    </>
                  ) : (
                    <span>Check 提交句式诊断</span>
                  )}
                </button>
                <button
                  onClick={handleConfirmSentence}
                  disabled={!userDraft.trim() || !activeTask}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2.5 font-sans text-xs font-bold text-white shadow-sm hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  确认此句并加入全文
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
