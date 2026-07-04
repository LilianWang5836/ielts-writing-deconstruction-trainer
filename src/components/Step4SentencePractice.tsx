import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clipboard,
  Loader2,
  Sparkles,
  Trophy,
  WandSparkles,
} from 'lucide-react';
import { Topic, SentencePracticeTask, PracticeSession, InlineGuidanceResult } from '../types';

interface Step4SentencePracticeProps {
  topic: Topic;
  session: PracticeSession;
  onUpdateSession: (updates: Partial<PracticeSession>) => void;
  onNextStep: () => void;
}

type SectionKey = 'intro' | 'body1' | 'body2' | 'conclusion';
type GuidanceIntent =
  | 'selected_vocabulary'
  | 'selected_grammar'
  | 'selected_wordOrder'
  | 'selected_expression'
  | 'start_sentence'
  | 'find_word';

type Annotation = NonNullable<SentencePracticeTask['annotations']>[number];
type AnnotatedSegment = { text: string; annotation?: Annotation };
type SentenceTaskMatchResult = {
  matchedTaskId: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
};

const SECTION_ORDER: SectionKey[] = ['intro', 'body1', 'body2', 'conclusion'];
const SECTION_LABELS: Record<SectionKey, string> = {
  intro: '第一段（改写+立场）',
  body1: 'Body 1',
  body2: 'Body 2',
  conclusion: 'Conclusion（总结立场）',
};

const CATEGORY_LABELS: Record<string, string> = {
  grammar: '语法',
  lexical: '用词',
  vocabulary: '词汇',
  wordOrder: '语序',
  expression: '表达思路',
  meaning: '意思对齐',
};

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
    hasBeenChecked: !!task.hasBeenChecked,
    annotations: Array.isArray(task.annotations) ? task.annotations : [],
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

function buildAnnotatedSegments(sentence: string, annotations: Annotation[]) {
  const cleanSentence = sentence || '';
  if (!cleanSentence) {
    return { segments: [] as AnnotatedSegment[], unmatched: [] as Annotation[] };
  }

  const validAnnotations = (annotations || [])
    .filter((ann) => ann?.text?.trim() && ann?.explanation?.trim())
    .map((ann) => ({
      text: ann.text.trim(),
      category: ann.category,
      explanation: ann.explanation.trim(),
    }));

  if (validAnnotations.length === 0) {
    return {
      segments: [{ text: cleanSentence }],
      unmatched: [] as Annotation[],
    };
  }

  const segments: AnnotatedSegment[] = [];
  const unmatched: Annotation[] = [];
  let cursor = 0;

  validAnnotations.forEach((ann) => {
    let idx = cleanSentence.indexOf(ann.text, cursor);
    if (idx === -1) {
      const fallbackIdx = cleanSentence.indexOf(ann.text);
      if (fallbackIdx === -1 || fallbackIdx < cursor) {
        unmatched.push(ann);
        return;
      }
      idx = fallbackIdx;
    }

    if (idx > cursor) {
      segments.push({ text: cleanSentence.slice(cursor, idx) });
    }
    segments.push({ text: ann.text, annotation: ann });
    cursor = idx + ann.text.length;
  });

  if (cursor < cleanSentence.length) {
    segments.push({ text: cleanSentence.slice(cursor) });
  }

  return { segments, unmatched };
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
  const [viewMode, setViewMode] = useState<'editing' | 'reviewing'>('editing');
  const [selectedText, setSelectedText] = useState('');
  const [guidanceLoading, setGuidanceLoading] = useState(false);
  const [guidance, setGuidance] = useState<InlineGuidanceResult | null>(null);
  const [guidanceIntent, setGuidanceIntent] = useState<GuidanceIntent | ''>('');
  const [guidanceQuestion, setGuidanceQuestion] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [showGuidance, setShowGuidance] = useState(false);
  const [topicExpanded, setTopicExpanded] = useState(false);
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

  const reviewResult = useMemo(
    () => buildAnnotatedSegments(userDraft, activeTask?.annotations || []),
    [userDraft, activeTask?.annotations],
  );
  const selectedScope = selectedText.trim();
  const selectedSceneChips: Array<{ id: GuidanceIntent; label: string }> = [
    { id: 'selected_vocabulary', label: '词汇不自然' },
    { id: 'selected_grammar', label: '语法不确定' },
    { id: 'selected_wordOrder', label: '语序别扭' },
    { id: 'selected_expression', label: '更学术一点' },
  ];
  const noSelectionChips: Array<{ id: GuidanceIntent; label: string }> = [
    { id: 'start_sentence', label: '我不会起步' },
    { id: 'find_word', label: '我想表达但词不确定' },
  ];
  const activeGuidanceChips = selectedScope ? selectedSceneChips : noSelectionChips;

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

  const persistCurrentDraftToTask = (
    sourceTasks: SentencePracticeTask[],
    draftValue: string,
  ): SentencePracticeTask[] => {
    const draft = draftValue.trim();
    return sourceTasks.map((task, idx) => {
      if (idx !== currentTaskIndex) return task;
      const previousDraft = (task.userDraft || '').trim();
      if (previousDraft === draft) return task;
      const checkedDataShouldReset = !!task.hasBeenChecked;
      return {
        ...task,
        userDraft: draft,
        hasBeenChecked: checkedDataShouldReset ? false : task.hasBeenChecked,
        annotations: checkedDataShouldReset ? [] : task.annotations,
        contentAlignment: checkedDataShouldReset ? undefined : task.contentAlignment,
      };
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
    setViewMode('editing');
    setSelectedText('');
    setGuidance(null);
    setGuidanceIntent('');
    setGuidanceQuestion('');
    setShowGuidance(false);
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
        setErrorMsg(data.error || '句子批改失败，请检查 API 密钥设置。');
        return;
      }

      const annotations = Array.isArray(data.annotations) ? data.annotations : [];
      const rawAlignment = data.contentAlignment || {};
      const normalizedStatus = String(rawAlignment?.status || '')
        .trim()
        .toLowerCase();
      const contentAlignment = {
        status:
          normalizedStatus === 'mismatched'
            ? 'mismatched'
            : normalizedStatus === 'partial'
              ? 'partial'
              : 'aligned',
        summary: String(rawAlignment?.summary || '').trim(),
        coveredPoints: Array.isArray(rawAlignment?.coveredPoints)
          ? rawAlignment.coveredPoints.filter((item: unknown) => String(item || '').trim())
          : [],
        missingPoints: Array.isArray(rawAlignment?.missingPoints)
          ? rawAlignment.missingPoints.filter((item: unknown) => String(item || '').trim())
          : [],
        extraPoints: Array.isArray(rawAlignment?.extraPoints)
          ? rawAlignment.extraPoints.filter((item: unknown) => String(item || '').trim())
          : [],
      } as SentencePracticeTask['contentAlignment'];
      const updatedTasks = tasks.map((task, idx) =>
        idx === currentTaskIndex
          ? {
              ...task,
              userDraft: userDraft.trim(),
              annotations,
              contentAlignment,
              hasBeenChecked: true,
            }
          : task,
      );
      setTaskState(updatedTasks);
      setViewMode('reviewing');
    } catch (e: any) {
      console.error(e);
      setErrorMsg('批改时发生网络错误。' + (e.message || ''));
    } finally {
      setEvaluating(false);
    }
  };

  const matchDraftToTask = async (
    draft: string,
    candidates: SentencePracticeTask[],
  ): Promise<SentenceTaskMatchResult | null> => {
    if (candidates.length <= 1) {
      return {
        matchedTaskId: candidates[0]?.id || '',
        confidence: 'high',
        reason: '只有一个可匹配任务，直接使用当前任务。',
      };
    }
    try {
      const res = await fetch('/api/match-sentence-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userDraft: draft,
          candidates: candidates.map((task) => ({ id: task.id, concept: task.concept })),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) return null;
      return {
        matchedTaskId: String(data.matchedTaskId || ''),
        confidence:
          data.confidence === 'high' || data.confidence === 'low'
            ? data.confidence
            : 'medium',
        reason: String(data.reason || ''),
      };
    } catch (error) {
      console.error('match sentence task failed', error);
      return null;
    }
  };

  const handleConfirmSentence = async () => {
    if (!activeTask) return;
    const cleanDraft = userDraft.trim();
    if (!cleanDraft) {
      setErrorMsg('请先输入英文句子，再进行确认。');
      return;
    }
    setConfirming(true);
    setErrorMsg('');

    try {
      let workingTasks = persistCurrentDraftToTask(tasks, cleanDraft);
      let targetTaskId = activeTask.id;
      const matchResult = await matchDraftToTask(cleanDraft, workingTasks);
      if (matchResult?.matchedTaskId) {
        targetTaskId = matchResult.matchedTaskId;
        if (
          targetTaskId !== activeTask.id &&
          (matchResult.confidence === 'high' || matchResult.confidence === 'medium')
        ) {
          const shouldRemap = window.confirm(
            `检测到这句更匹配左侧另一任务：${matchResult.reason || '语义更接近该目标句'}\n是否按推荐任务确认？`,
          );
          if (!shouldRemap) {
            targetTaskId = activeTask.id;
          }
        } else if (matchResult.confidence === 'low') {
          targetTaskId = activeTask.id;
          if (matchResult.reason) {
            setErrorMsg(`语义匹配置信度较低，已按当前句确认。提示：${matchResult.reason}`);
          }
        }
      }

      const updatedTasks = workingTasks.map((task) =>
        task.id === targetTaskId
          ? {
              ...task,
              userDraft: cleanDraft,
              confirmedSentence: cleanDraft,
              confirmed: true,
            }
          : task,
      );
      const sortedUpdated = sortTasksBySectionOrder(updatedTasks);
      setTaskState(sortedUpdated);
      setViewMode('editing');
      setSelectedText('');
      setGuidance(null);
      setGuidanceIntent('');
      setGuidanceQuestion('');
      setShowGuidance(false);

      const nextPendingIdx = sortedUpdated.findIndex((task) => !task.confirmed);
      if (nextPendingIdx !== -1) {
        setCurrentTaskIndex(nextPendingIdx);
        setUserDraft(
          sortedUpdated[nextPendingIdx].userDraft ||
            sortedUpdated[nextPendingIdx].confirmedSentence ||
            '',
        );
      }
    } finally {
      setConfirming(false);
    }
  };

  const handleTaskSelect = (idx: number) => {
    if (idx === currentTaskIndex) return;
    const persisted = persistCurrentDraftToTask(tasks, userDraft);
    setTaskState(persisted);
    setCurrentTaskIndex(idx);
    setUserDraft(persisted[idx]?.userDraft || persisted[idx]?.confirmedSentence || '');
    setViewMode('editing');
    setSelectedText('');
    setGuidance(null);
    setGuidanceIntent('');
    setGuidanceQuestion('');
    setShowGuidance(false);
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

  const handleEditorSelection = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    const { selectionStart, selectionEnd, value } = target;
    if (selectionStart === selectionEnd) {
      setSelectedText('');
      setGuidanceIntent('');
      return;
    }
    const selected = value.slice(selectionStart, selectionEnd).trim();
    setSelectedText(selected);
    setGuidance(null);
    setGuidanceIntent('');
  };

  const handleRequestGuidance = async () => {
    if (!activeTask) return;
    const cleanQuestion = guidanceQuestion.trim();
    const hasIntent = !!guidanceIntent;
    if (!selectedScope && !cleanQuestion && !hasIntent) {
      setErrorMsg('请选择一个提问标签，或输入你卡住的问题。');
      return;
    }
    if (selectedScope && !cleanQuestion && !hasIntent) {
      setErrorMsg('你已选中文本，请选择一个标签或补充问题后再提问。');
      return;
    }
    setGuidanceLoading(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/inline-guidance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeText: selectedScope,
          fullDraft: userDraft.trim(),
          concept: activeTask.concept,
          prompts: activeTask.prompts,
          intent: guidanceIntent || null,
          questionText: cleanQuestion,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setErrorMsg(data.error || '快捷帮助调用失败。');
        return;
      }
      setGuidance({
        category: data.category || 'expression',
        issue: data.issue || '',
        hint: data.hint || '',
      });
    } catch (e: any) {
      console.error(e);
      setErrorMsg('快捷帮助调用失败。' + (e.message || ''));
    } finally {
      setGuidanceLoading(false);
    }
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
            activeTask && (
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
                    🔗 句型骨架提示
                  </span>
                  <div className="space-y-2">
                    {activeTask.prompts.slice(0, 2).map((p, i) => {
                      const hasArrow = p.includes('->');
                      if (hasArrow) {
                        const parts = p.split('->');
                        const engPattern = parts[0].trim();
                        const chiMapping = parts.slice(1).join('->').trim();
                        return (
                          <div key={i} className="border-l-2 border-indigo-200 pl-2.5 space-y-0.5">
                            <span className="font-mono text-xs font-bold text-indigo-900 select-all block">{engPattern}</span>
                            {chiMapping && (
                              <p className="font-sans text-[11px] text-slate-400 leading-normal">{chiMapping}</p>
                            )}
                          </div>
                        );
                      }
                      return (
                        <div key={i} className="border-l-2 border-indigo-200 pl-2.5 font-mono text-[11px] text-slate-600">
                          {p}
                        </div>
                      );
                    })}
                    {activeTask.prompts.length > 2 && (
                      <details className="group">
                        <summary className="cursor-pointer list-none text-[10px] text-indigo-500 hover:text-indigo-700 select-none">
                          <span className="group-open:hidden">+ {activeTask.prompts.length - 2} 条更多</span>
                          <span className="hidden group-open:inline">收起</span>
                        </summary>
                        <div className="mt-2 space-y-2">
                          {activeTask.prompts.slice(2).map((p, i) => {
                            const hasArrow = p.includes('->');
                            if (hasArrow) {
                              const parts = p.split('->');
                              const engPattern = parts[0].trim();
                              const chiMapping = parts.slice(1).join('->').trim();
                              return (
                                <div key={i} className="border-l-2 border-indigo-100 pl-2.5 space-y-0.5">
                                  <span className="font-mono text-xs font-bold text-indigo-800 select-all block">{engPattern}</span>
                                  {chiMapping && (
                                    <p className="font-sans text-[11px] text-slate-400 leading-normal">{chiMapping}</p>
                                  )}
                                </div>
                              );
                            }
                            return (
                              <div key={i} className="border-l-2 border-indigo-100 pl-2.5 font-mono text-[11px] text-slate-500">
                                {p}
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    )}
                  </div>
                </div>
              </div>
            )
          )}

          {errorMsg && (
            <div className="bg-rose-50 border border-rose-100 rounded-lg p-3 text-rose-800 text-xs flex items-center gap-2 mt-2">
              <AlertCircle className="h-4 w-4 text-rose-500 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>
      </div>

      <div className="lg:col-span-7 xl:col-span-7 flex flex-col h-[480px] lg:h-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-y-auto min-h-0">
        <div className="bg-slate-50/80 border-b border-slate-200 px-4 py-2.5 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <button
              onClick={() => setTopicExpanded((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 hover:text-slate-700 transition"
            >
              <span>{topicExpanded ? '▾' : '▸'}</span>
              <span>原题</span>
              {!topicExpanded && (
                <span className="font-normal text-slate-400 truncate max-w-[280px]">
                  — {topic.question.slice(0, 60)}{topic.question.length > 60 ? '…' : ''}
                </span>
              )}
            </button>
            <button
              onClick={handleCopyDraft}
              disabled={!fullDraftText}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              <Clipboard className="h-3.5 w-3.5" />
              复制全文
            </button>
          </div>
          {topicExpanded && (
            <p className="font-serif italic text-slate-700 text-xs leading-relaxed mt-2 pl-4 border-l-2 border-slate-300">
              {topic.question}
            </p>
          )}
        </div>

        <div className={`flex-1 p-5 min-h-0 ${allConfirmed ? 'overflow-y-auto' : 'grid grid-rows-[1fr_auto] gap-4'}`}>
          {allConfirmed && (
            <div className="text-center py-6 space-y-1">
              <div className="text-2xl">🎉</div>
              <p className="font-bold text-emerald-700 text-sm">全文写作完成</p>
              <p className="text-xs text-slate-400">{tasks.length} 句 · 约 {totalWords} 词</p>
            </div>
          )}
          <div ref={fullDraftRef} className="overflow-y-auto bg-slate-50/40 rounded-xl p-4 space-y-4">
            {SECTION_ORDER.map((section) => {
              const sectionTasks = sectionTaskMap[section];
              if (!sectionTasks.length) return null;
              return (
                <section key={section} className="space-y-1">
                  <h4 className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500 mb-1">
                    {SECTION_LABELS[section]}
                  </h4>
                  <div className="divide-y divide-slate-100">
                    {sectionTasks.map(({ task, idx }) => {
                      const isActive = idx === currentTaskIndex;
                      return (
                        <div
                          key={task.id}
                          onClick={() => handleTaskSelect(idx)}
                          className={`px-3 py-2 text-sm leading-relaxed cursor-pointer transition-colors ${
                            isActive
                              ? 'border-l-2 border-indigo-400 bg-indigo-50/50 text-slate-800'
                              : task.confirmedSentence?.trim()
                              ? 'text-slate-700 hover:bg-emerald-50/40'
                              : 'text-slate-400 italic hover:bg-slate-100/60'
                          }`}
                        >
                          {task.confirmedSentence?.trim() || `待确认：${task.concept}`}
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          {!allConfirmed && (
            <div className="border-t border-slate-200 pt-4 bg-white space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-400 uppercase tracking-wider">
                  当前练习工作区
                </span>
                {userDraft.trim() && (
                  <span className="text-[10px] text-slate-300 tabular-nums">
                    {userDraft.trim().split(/\s+/).filter(Boolean).length}词
                  </span>
                )}
              </div>

              {viewMode === 'editing' ? (
                <textarea
                  value={userDraft}
                  onChange={(e) => {
                    setUserDraft(e.target.value);
                    setViewMode('editing');
                  }}
                  onSelect={handleEditorSelection}
                  disabled={evaluating || !activeTask}
                  placeholder="在此起草当前句子的英文版本..."
                  className="w-full h-32 p-4 border border-slate-200 rounded-lg font-serif italic text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-none leading-relaxed"
                />
              ) : (
                <div className="w-full min-h-[128px] p-4 border border-slate-200 rounded-lg bg-slate-50/40 text-sm leading-relaxed">
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">句内批改视图（红色高亮）</div>
                  <p className="font-serif text-slate-800">
                    {reviewResult.segments.map((segment, idx) =>
                      segment.annotation ? (
                        <span
                          key={idx}
                          className="bg-rose-100 text-rose-800 underline decoration-wavy decoration-rose-500 px-0.5 rounded-sm cursor-help"
                          title={`${CATEGORY_LABELS[segment.annotation.category] || segment.annotation.category}: ${segment.annotation.explanation}`}
                        >
                          {segment.text}
                        </span>
                      ) : (
                        <span key={idx}>{segment.text}</span>
                      ),
                    )}
                  </p>
                  {reviewResult.segments.length === 0 && (
                    <p className="text-slate-400 italic">暂无可批改内容。</p>
                  )}
                </div>
              )}

              {viewMode === 'reviewing' && activeTask?.annotations && activeTask.annotations.length > 0 && (
                <details open className="group">
                  <summary className="flex items-center gap-1.5 cursor-pointer list-none text-[10px] font-bold text-rose-700 uppercase tracking-wider select-none">
                    <span className="group-open:rotate-90 transition-transform inline-block">▸</span>
                    批改说明（{activeTask.annotations.length} 处）
                  </summary>
                  <div className="mt-1.5 border-l-4 border-rose-300 pl-3 py-1 space-y-1.5">
                    {activeTask.annotations.map((ann, idx) => (
                      <div key={`${ann.text}-${idx}`} className="text-[11px] text-rose-900 leading-relaxed">
                        <span className="font-bold mr-1">[{CATEGORY_LABELS[ann.category] || ann.category}]</span>
                        <span className="font-mono bg-rose-50 px-1 rounded">{ann.text}</span>
                        <span className="mx-1">{'->'}</span>
                        <span>{ann.explanation}</span>
                      </div>
                    ))}
                    {reviewResult.unmatched.length > 0 && (
                      <div className="text-[11px] text-amber-700 pt-1 border-t border-rose-100">
                        部分标注未能精确定位到原句，已按列表展示。
                      </div>
                    )}
                  </div>
                </details>
              )}

              {viewMode === 'reviewing' && activeTask?.contentAlignment && (
                <details open className="group">
                  <summary className={`flex items-center gap-1.5 cursor-pointer list-none text-[10px] font-bold uppercase tracking-wider select-none ${
                    activeTask.contentAlignment.status === 'aligned'
                      ? 'text-emerald-700'
                      : activeTask.contentAlignment.status === 'partial'
                        ? 'text-amber-700'
                        : 'text-rose-700'
                  }`}>
                    <span className="group-open:rotate-90 transition-transform inline-block">▸</span>
                    {{
                      aligned: '✓ 意思对齐',
                      partial: '⚠ 基本对齐，有待补充',
                      mismatched: '✗ 意思偏差较大',
                    }[activeTask.contentAlignment.status] ?? activeTask.contentAlignment.status}
                  </summary>
                  <div className={`mt-1.5 border-l-4 pl-3 py-1 space-y-1 ${
                    activeTask.contentAlignment.status === 'aligned'
                      ? 'border-emerald-400'
                      : activeTask.contentAlignment.status === 'partial'
                        ? 'border-amber-400'
                        : 'border-rose-400'
                  }`}>
                    <p className="text-[11px] text-slate-700 leading-relaxed">
                      {activeTask.contentAlignment.summary || '暂无总结。'}
                    </p>
                    {activeTask.contentAlignment.coveredPoints.length > 0 && (
                      <div className="text-[11px] text-slate-600">
                        <span className="font-bold mr-1">已覆盖：</span>
                        <span>{activeTask.contentAlignment.coveredPoints.join('；')}</span>
                      </div>
                    )}
                    {activeTask.contentAlignment.missingPoints.length > 0 && (
                      <div className="text-[11px] text-amber-700">
                        <span className="font-bold mr-1">待补充：</span>
                        <span>{activeTask.contentAlignment.missingPoints.join('；')}</span>
                      </div>
                    )}
                    {activeTask.contentAlignment.extraPoints.length > 0 && (
                      <div className="text-[11px] text-rose-700">
                        <span className="font-bold mr-1">偏离点：</span>
                        <span>{activeTask.contentAlignment.extraPoints.join('；')}</span>
                      </div>
                    )}
                  </div>
                </details>
              )}

              <div>
                <button
                  type="button"
                  onClick={() => {
                    setShowGuidance((v) => !v);
                    setGuidance(null);
                    setGuidanceIntent('');
                    setGuidanceQuestion('');
                  }}
                  className="flex items-center gap-1.5 text-[10px] font-bold text-indigo-600 hover:text-indigo-800 transition"
                >
                  <WandSparkles className="h-3 w-3" />
                  <span>{showGuidance ? '收起提问' : '遇到问题？快捷提问'}</span>
                  {selectedScope && !showGuidance && (
                    <span className="font-normal text-indigo-400 truncate max-w-[120px]">— 已选中片段</span>
                  )}
                </button>

                {showGuidance && (
                  <div className="mt-2 border-l-4 border-indigo-300 pl-3 py-1 space-y-2">
                    <p className="text-[11px] text-slate-500">
                      {selectedScope
                        ? `针对选中：「${selectedScope}」`
                        : userDraft.trim()
                        ? '针对整句（按问题定位卡点）'
                        : '尚无草稿（按中文目标给起笔思路）'}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {activeGuidanceChips.map((chip) => {
                        const active = guidanceIntent === chip.id;
                        return (
                          <button
                            key={chip.id}
                            type="button"
                            onClick={() => {
                              setGuidanceIntent(chip.id);
                              setGuidance(null);
                            }}
                            className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${
                              active
                                ? 'border-indigo-500 bg-indigo-600 text-white'
                                : 'border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-50'
                            }`}
                          >
                            {chip.label}
                          </button>
                        );
                      })}
                    </div>
                    <textarea
                      value={guidanceQuestion}
                      onChange={(e) => setGuidanceQuestion(e.target.value)}
                      rows={2}
                      placeholder={
                        selectedScope
                          ? '例如：这个片段听起来不自然，不知道要换什么表达。'
                          : '例如：我不知道这句怎么起步，或者不知道该用哪个词。'
                      }
                      className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[11px] text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-none"
                    />
                    <button
                      onClick={handleRequestGuidance}
                      disabled={guidanceLoading || !activeTask}
                      className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      发送提问
                    </button>
                    {guidanceLoading && (
                      <div className="text-[11px] text-indigo-700 flex items-center gap-1.5">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        正在生成引导建议...
                      </div>
                    )}
                    {guidance && (
                      <div className="space-y-1 text-[11px] pt-1">
                        <div className="text-indigo-900">
                          <span className="font-bold mr-1">[{CATEGORY_LABELS[guidance.category] || guidance.category}]</span>
                          <span>{guidance.issue}</span>
                        </div>
                        <div className="text-slate-700 border-l-2 border-indigo-200 pl-2">
                          {guidance.hint}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {!activeTask?.hasBeenChecked && userDraft.trim() && (
                <div className="text-[11px] text-slate-500">
                  你可以直接确认，也可以先批改再确认。
                </div>
              )}

              <div className="sticky bottom-0 bg-white pt-2 pb-1 -mx-4 px-4 border-t border-slate-100 flex flex-col sm:flex-row gap-2">
                <button
                  onClick={handleConfirmSentence}
                  disabled={!userDraft.trim() || !activeTask || confirming}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2.5 font-sans text-xs font-bold text-white shadow-sm hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {confirming ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-white" />
                      <span>确认中...</span>
                    </>
                  ) : (
                    <span>确认此句并加入全文</span>
                  )}
                </button>
                <button
                  onClick={handleEvaluateSentence}
                  disabled={evaluating || confirming || !userDraft.trim() || !activeTask}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 px-3 py-2.5 text-xs text-slate-500 bg-white hover:bg-slate-50 hover:text-slate-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
                  title="检查语法、用词和意思是否对齐"
                >
                  {evaluating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <span>🔍 检查</span>
                  )}
                </button>
                {viewMode === 'reviewing' && (
                  <button
                    onClick={() => setViewMode('editing')}
                    className="inline-flex items-center justify-center rounded-lg border border-slate-200 px-3 py-2.5 text-xs text-slate-500 hover:bg-slate-50"
                    title="返回编辑模式"
                  >
                    ✎ 编辑
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
