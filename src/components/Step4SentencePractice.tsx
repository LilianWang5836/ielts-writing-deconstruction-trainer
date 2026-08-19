import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clipboard,
  Loader2,
  Sparkles,
  Trophy,
} from 'lucide-react';
import {
  Topic,
  SentencePracticeTask,
  PracticeSession,
  InlineGuidanceResult,
  ConceptHighlightSpan,
} from '../types';

interface Step4SentencePracticeProps {
  topic: Topic;
  session: PracticeSession;
  onUpdateSession: (updates: Partial<PracticeSession>) => void;
  onNextStep: () => void;
}

/** intro | bodyN | conclusion — body count follows Step3 subpoints. */
type SectionKey = string;
type GuidanceIntent =
  | 'selected_vocabulary'
  | 'selected_grammar'
  | 'selected_wordOrder'
  | 'selected_expression'
  | 'start_sentence'
  | 'find_word';

type Annotation = NonNullable<SentencePracticeTask['annotations']>[number];
type AnnotatedSegment = {
  text: string;
  annotation?: Annotation;
  annotationIndex?: number;
};
type SentenceTaskMatchResult = {
  matchedTaskId: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
};

function sectionSortRank(section: SectionKey): number {
  if (section === 'intro') return 0;
  if (section === 'conclusion') return 1000;
  const m = String(section || '').match(/^body(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  return 500;
}

function sectionLabel(section: SectionKey): string {
  if (section === 'intro') return '第一段（改写+立场）';
  if (section === 'conclusion') return 'Conclusion（总结立场）';
  const m = String(section || '').match(/^body(\d+)$/i);
  if (m) return `Body ${m[1]}`;
  return section;
}

/** Compact nav pills on Step4 left rail. */
function sectionShortLabel(section: SectionKey): string {
  if (section === 'intro') return 'Intro';
  if (section === 'conclusion') return 'Conc';
  const m = String(section || '').match(/^body(\d+)$/i);
  if (m) return `Body${m[1]}`;
  return section;
}

function buildSectionOrder(tasks: SentencePracticeTask[]): SectionKey[] {
  const set = new Set<SectionKey>();
  tasks.forEach((t) => {
    set.add(t.section || inferSectionFromId(t.id));
  });
  return [...set].sort((a, b) => sectionSortRank(a) - sectionSortRank(b));
}

const CATEGORY_LABELS: Record<string, string> = {
  grammar: '语法',
  lexical: '用词',
  vocabulary: '词汇',
  wordOrder: '语序',
  expression: '表达思路',
  meaning: '意思对齐',
};

/** Left-panel whole-sentence quick asks (always visible). */
const LEFT_QUICK_ASKS: Array<{ id: GuidanceIntent; label: string }> = [
  { id: 'find_word', label: '核心词汇提示' },
  { id: 'start_sentence', label: '我不会起步' },
];

type GuidanceThreadMessage = {
  id: string;
  role: 'user' | 'coach';
  label?: string;
  category?: string;
  issue?: string;
  hint?: string;
};

const HIGHLIGHT_TIER_CLASS: Record<'core' | 'subordinate', string> = {
  core: 'rounded px-0.5 bg-amber-200/90 text-amber-950 font-semibold underline decoration-2 decoration-amber-700 underline-offset-2 box-decoration-clone',
  subordinate: 'rounded px-0.5 bg-sky-100 text-sky-900 box-decoration-clone',
};

/** Render Chinese concept with S/V/O highlights (core = brightest + underline). */
function renderConceptWithHighlights(
  concept: string,
  highlights?: ConceptHighlightSpan[],
): React.ReactNode {
  const raw = String(concept || '');
  if (!raw) return null;
  if (!Array.isArray(highlights) || highlights.length === 0) return raw;

  const tierRank = (t: ConceptHighlightSpan['tier']) =>
    t === 'core' ? 0 : t === 'subordinate' ? 1 : 2;

  const sorted = [...highlights]
    .filter(
      (h) =>
        (h.tier === 'core' || h.tier === 'subordinate') &&
        Number.isFinite(h.start) &&
        Number.isFinite(h.end) &&
        h.start >= 0 &&
        h.end > h.start &&
        h.end <= raw.length,
    )
    .sort(
      (a, b) =>
        a.start - b.start ||
        b.end - a.end ||
        tierRank(a.tier) - tierRank(b.tier),
    );

  // Drop overlaps: earlier (already sorted with core-first among same start) wins.
  const accepted: ConceptHighlightSpan[] = [];
  for (const h of sorted) {
    if (accepted.some((a) => h.start < a.end && h.end > a.start)) continue;
    accepted.push(h);
  }
  accepted.sort((a, b) => a.start - b.start);

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  accepted.forEach((h, i) => {
    if (h.start > cursor) nodes.push(raw.slice(cursor, h.start));
    const tierClass =
      h.tier === 'core'
        ? HIGHLIGHT_TIER_CLASS.core
        : HIGHLIGHT_TIER_CLASS.subordinate;
    nodes.push(
      <mark key={`cspan-${i}-${h.start}`} className={tierClass}>
        {raw.slice(h.start, h.end)}
      </mark>,
    );
    cursor = h.end;
  });
  if (cursor < raw.length) nodes.push(raw.slice(cursor));
  return nodes.length ? <>{nodes}</> : raw;
}

/** Highlight key fragments in coach guidance (candidates, quotes, bold). */
function renderHighlightedGuidanceText(text: string): React.ReactNode {
  const raw = String(text || '');
  if (!raw) return null;
  const re =
    /(\*\*[^*]+\*\*|`[^`]+`|「[^」]+」|"[^"]+"|'[^']+'|[A-Za-z][A-Za-z'/.-]{1,}(?:\s+[A-Za-z][A-Za-z'/.-]+){0,4})/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(raw)) !== null) {
    if (match.index > last) {
      nodes.push(raw.slice(last, match.index));
    }
    const token = match[0];
    let inner = token;
    if (token.startsWith('**') && token.endsWith('**')) inner = token.slice(2, -2);
    else if (token.startsWith('`') && token.endsWith('`')) inner = token.slice(1, -1);
    else if (token.startsWith('「') && token.endsWith('」')) inner = token.slice(1, -1);
    else if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      inner = token.slice(1, -1);
    }
    nodes.push(
      <mark
        key={`h-${key++}`}
        className="rounded px-1 py-0.5 bg-amber-100 text-amber-950 font-semibold not-italic"
      >
        {inner}
      </mark>,
    );
    last = match.index + token.length;
  }
  if (last < raw.length) nodes.push(raw.slice(last));
  return nodes.length ? <>{nodes}</> : raw;
}

function inferSectionFromId(id: string): SectionKey {
  if (id.startsWith('intro-')) return 'intro';
  if (id.startsWith('conclusion')) return 'conclusion';
  const bodyMatch = id.match(/^body(\d+)/i);
  if (bodyMatch) return `body${bodyMatch[1]}`;
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
  const numMatch = task.id.match(/(\d+)$/);
  const num = numMatch ? parseInt(numMatch[1], 10) : 0;
  return [sectionSortRank(section), num];
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

  const source = annotations || [];
  const validWithIndex = source
    .map((ann, annotationIndex) => ({
      ann,
      annotationIndex,
      text: String(ann?.text || '').trim(),
      explanation: String(ann?.explanation || '').trim(),
    }))
    .filter((item) => item.text && item.explanation);

  if (validWithIndex.length === 0) {
    return {
      segments: [{ text: cleanSentence }],
      unmatched: [] as Annotation[],
    };
  }

  const segments: AnnotatedSegment[] = [];
  const unmatched: Annotation[] = [];
  let cursor = 0;

  validWithIndex.forEach(({ ann, annotationIndex, text }) => {
    let idx = cleanSentence.indexOf(text, cursor);
    if (idx === -1) {
      const fallbackIdx = cleanSentence.indexOf(text);
      if (fallbackIdx === -1 || fallbackIdx < cursor) {
        unmatched.push(ann);
        return;
      }
      idx = fallbackIdx;
    }

    if (idx > cursor) {
      segments.push({ text: cleanSentence.slice(cursor, idx) });
    }
    segments.push({
      text,
      annotation: {
        text,
        category: ann.category,
        explanation: String(ann.explanation || '').trim(),
      },
      annotationIndex,
    });
    cursor = idx + text.length;
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
  const [confirming, setConfirming] = useState(false);
  const [topicExpanded, setTopicExpanded] = useState(false);
  const [draftExpanded, setDraftExpanded] = useState(false);
  const [activeAnnotationIdx, setActiveAnnotationIdx] = useState<number | null>(null);
  const [guidanceThread, setGuidanceThread] = useState<GuidanceThreadMessage[]>([]);
  const [startScaffoldActive, setStartScaffoldActive] = useState(false);
  const [scaffoldReply, setScaffoldReply] = useState('');
  const [selectionGuidance, setSelectionGuidance] = useState<InlineGuidanceResult | null>(null);
  const [selectionAskLoading, setSelectionAskLoading] = useState(false);
  const fullDraftRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const annotationListRef = useRef<HTMLDivElement>(null);
  const annotationItemRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const handleRequestGuidanceRef = useRef<() => void>(() => {});
  const guidanceThreadEndRef = useRef<HTMLDivElement>(null);

  const activeTask = tasks[currentTaskIndex];
  const allConfirmed = tasks.length > 0 && tasks.every((t) => !!t.confirmed);
  const activeSection: SectionKey = activeTask?.section || 'intro';
  const sectionOrder = useMemo(() => buildSectionOrder(tasks), [tasks]);

  const sectionTaskMap = useMemo(() => {
    return sectionOrder.reduce((acc, section) => {
      acc[section] = tasks
        .map((task, idx) => ({ task, idx }))
        .filter((entry) => entry.task.section === section);
      return acc;
    }, {} as Record<SectionKey, { task: SentencePracticeTask; idx: number }[]>);
  }, [tasks, sectionOrder]);

  const fullDraftText = useMemo(() => {
    const lines: string[] = [];
    sectionOrder.forEach((section) => {
      const sectionTasks = sectionTaskMap[section];
      if (!sectionTasks?.length) return;
      lines.push(`${sectionLabel(section)}:`);
      sectionTasks.forEach(({ task }) => {
        if (task.confirmedSentence?.trim()) {
          lines.push(task.confirmedSentence.trim());
        }
      });
      lines.push('');
    });
    return lines.join('\n').trim();
  }, [sectionTaskMap, sectionOrder]);

  const totalWords = useMemo(() => {
    return fullDraftText.split(/\s+/).filter(Boolean).length;
  }, [fullDraftText]);

  const reviewResult = useMemo(
    () => buildAnnotatedSegments(userDraft, activeTask?.annotations || []),
    [userDraft, activeTask?.annotations],
  );
  const selectedScope = selectedText.trim();
  const selectedSceneChips: Array<{ id: GuidanceIntent; label: string }> = [
    { id: 'selected_vocabulary', label: '表达不确定' },
    { id: 'selected_grammar', label: '语法不确定' },
    { id: 'selected_wordOrder', label: '语序别扭' },
    { id: 'selected_expression', label: '更学术一点' },
  ];

  const currentSectionEntries = sectionTaskMap[activeSection] || [];
  const currentSectionPreview = useMemo(() => {
    const confirmed = currentSectionEntries
      .filter(({ task, idx }) => idx !== currentTaskIndex && task.confirmedSentence?.trim())
      .map(({ task }) => task.confirmedSentence!.trim());
    if (confirmed.length === 0) return '本段尚无其它已确认句';
    const joined = confirmed.join(' · ');
    return joined.length > 90 ? `${joined.slice(0, 90)}…` : joined;
  }, [currentSectionEntries, currentTaskIndex]);

  const focusAnnotation = (idx: number | null) => {
    setActiveAnnotationIdx(idx);
    if (idx == null) return;
    const el = annotationItemRefs.current[idx];
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

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
    setActiveAnnotationIdx(null);
    setDraftExpanded(false);
    setGuidanceThread([]);
    setStartScaffoldActive(false);
    setScaffoldReply('');
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
    const expectedBodyCount = Array.isArray(session.step3.subpoints)
      ? session.step3.subpoints.filter((sp) => sp && (sp.id || sp.paragraphPlan)).length
      : 0;
    const bodySectionsInTasks = new Set(
      normalizedExisting
        .map((task) => task.section)
        .filter((section) => /^body\d+$/i.test(section)),
    );
    const bodyCountMismatch =
      expectedBodyCount > 0 && bodySectionsInTasks.size < expectedBodyCount;
    const isLegacyTaskShape =
      hasTasks &&
      (!hasIntroSection || !hasConclusionSection || bodyCountMismatch);

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
      setActiveAnnotationIdx(null);
      setGuidanceThread([]);
      setStartScaffoldActive(false);
      setScaffoldReply('');

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
    setErrorMsg('');
    setActiveAnnotationIdx(null);
    setGuidanceThread([]);
    setStartScaffoldActive(false);
    setScaffoldReply('');
    setSelectionGuidance(null);
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
    setDraftExpanded(true);
    requestAnimationFrame(() => {
      fullDraftRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const handleEditorSelection = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    const { selectionStart, selectionEnd, value } = target;
    if (selectionStart === selectionEnd) {
      setSelectedText('');
      setSelectionGuidance(null);
      return;
    }
    const selected = value.slice(selectionStart, selectionEnd).trim();
    setSelectedText(selected);
    setSelectionGuidance(null);
  };

  const handleSelectionAsk = async (intent: GuidanceIntent) => {
    if (!activeTask || !selectedScope || selectionAskLoading) return;
    setSelectionAskLoading(true);
    setErrorMsg('');
    setSelectionGuidance(null);
    try {
      const res = await fetch('/api/inline-guidance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeText: selectedScope,
          fullDraft: userDraft.trim(),
          concept: activeTask.concept,
          prompts: activeTask.prompts,
          intent,
          questionText: '',
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setErrorMsg(data.error || '快捷帮助调用失败。');
        return;
      }
      setSelectionGuidance({
        category: data.category || 'expression',
        issue: data.issue || '',
        hint: data.hint || '',
      });
    } catch (e: any) {
      console.error(e);
      setErrorMsg('快捷帮助调用失败。' + (e.message || ''));
    } finally {
      setSelectionAskLoading(false);
    }
  };

  handleRequestGuidanceRef.current = () => {};


  const buildHighlightPayload = (task: SentencePracticeTask) =>
    (Array.isArray(task.highlights) ? task.highlights : []).map((h) => ({
      start: h.start,
      end: h.end,
      role: h.role,
      tier: h.tier,
      text: String(task.concept || '').slice(h.start, h.end),
    }));

  const buildGuidanceHistoryPayload = (thread: GuidanceThreadMessage[]) =>
    thread.map((msg) => ({
      role: msg.role,
      text:
        msg.role === 'user'
          ? String(msg.label || '')
          : [msg.issue, msg.hint].filter(Boolean).join(' '),
      label: msg.label,
      issue: msg.issue,
      hint: msg.hint,
    }));

  const requestLeftGuidance = async (
    intent: GuidanceIntent,
    userLabel: string,
    priorThread: GuidanceThreadMessage[],
  ) => {
    if (!activeTask) return;
    if (intent === 'start_sentence') setStartScaffoldActive(true);
    setGuidanceLoading(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/inline-guidance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeText: '',
          fullDraft: userDraft.trim(),
          concept: activeTask.concept,
          prompts: activeTask.prompts,
          intent,
          questionText: userLabel,
          guidanceHistory: buildGuidanceHistoryPayload(priorThread),
          highlights: buildHighlightPayload(activeTask),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setErrorMsg(data.error || '快捷帮助调用失败。');
        setGuidanceThread((prev) => [
          ...prev,
          {
            id: `c-${Date.now()}`,
            role: 'coach',
            issue: '暂时没能生成建议',
            hint: String(data.error || '请稍后再试。'),
          },
        ]);
        return;
      }
      const result: InlineGuidanceResult = {
        category: data.category || 'expression',
        issue: data.issue || '',
        hint: data.hint || '',
      };
      setGuidanceThread((prev) => [
        ...prev,
        {
          id: `c-${Date.now()}`,
          role: 'coach',
          category: result.category,
          issue: result.issue,
          hint: result.hint,
        },
      ]);
    } catch (e: any) {
      console.error(e);
      setErrorMsg('快捷帮助调用失败。' + (e.message || ''));
      setGuidanceThread((prev) => [
        ...prev,
        {
          id: `c-${Date.now()}`,
          role: 'coach',
          issue: '调用失败',
          hint: String(e?.message || '请检查网络后重试。'),
        },
      ]);
    } finally {
      setGuidanceLoading(false);
    }
  };

  const handleLeftQuickAsk = async (ask: { id: GuidanceIntent; label: string }) => {
    if (!activeTask || guidanceLoading) return;
    const userMsg: GuidanceThreadMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      label: ask.label,
    };
    const prior = [...guidanceThread, userMsg];
    setGuidanceThread(prior);
    await requestLeftGuidance(ask.id, ask.label, prior);
  };

  const handleScaffoldReply = async () => {
    if (!activeTask || guidanceLoading) return;
    const text = scaffoldReply.trim();
    if (!text) return;
    const userMsg: GuidanceThreadMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      label: text,
    };
    const prior = [...guidanceThread, userMsg];
    setGuidanceThread(prior);
    setScaffoldReply('');
    await requestLeftGuidance('start_sentence', text, prior);
  };

  useEffect(() => {
    guidanceThreadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [guidanceThread, guidanceLoading]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedText) {
          setSelectedText('');
          setSelectionGuidance(null);
          const el = editorRef.current;
          if (el) {
            const pos = el.selectionEnd;
            el.setSelectionRange(pos, pos);
          }
        } else if (draftExpanded) {
          setDraftExpanded(false);
        } else if (activeAnnotationIdx != null) {
          setActiveAnnotationIdx(null);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedText, draftExpanded, activeAnnotationIdx]);

  useEffect(() => {
    setActiveAnnotationIdx(null);
    setSelectionGuidance(null);
  }, [currentTaskIndex, viewMode]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 md:gap-6 h-full min-h-0 w-full flex-1">
      <div className="lg:col-span-5 xl:col-span-5 flex flex-col h-[480px] lg:h-full bg-slate-50 rounded-xl border border-slate-200/80 p-3 min-h-0 overflow-hidden">
        {/* Compact top switcher */}
        <div className="shrink-0 space-y-1.5 pb-2 border-b border-slate-200/80">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 text-[10px] font-bold text-indigo-600 uppercase tracking-wider min-w-0">
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">逐句通关</span>
            </div>
            {tasks.length > 0 && (
              <span className="font-mono text-[10px] font-bold text-slate-500 bg-slate-200/60 px-1.5 py-0.5 rounded shrink-0">
                {tasks.filter((t) => t.confirmed).length}/{tasks.length}
              </span>
            )}
          </div>

          <div className="flex gap-1 overflow-x-auto">
            {sectionOrder.map((section) => {
              const sectionTasks = sectionTaskMap[section] || [];
              const done = sectionTasks.filter(({ task }) => task.confirmed).length;
              const total = sectionTasks.length;
              const isActive = activeSection === section;
              return (
                <button
                  key={section}
                  onClick={() => handleSectionSelect(section)}
                  disabled={total === 0}
                  title={sectionLabel(section)}
                  className={`shrink-0 rounded-md border px-2 py-1 text-[10px] font-bold transition ${
                    isActive
                      ? 'border-indigo-600 bg-indigo-600 text-white'
                      : done === total && total > 0
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                      : 'border-slate-200 bg-white text-slate-600'
                  } ${total === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {sectionShortLabel(section)}
                  <span className="ml-1 font-mono font-normal opacity-80">
                    {done}/{total || 0}
                  </span>
                </button>
              );
            })}
          </div>

          {!allConfirmed && sectionTaskMap[activeSection]?.length > 0 && (
            <div className="flex items-center justify-between gap-2 select-none overflow-x-auto">
              <div className="flex gap-1 shrink-0">
                {sectionTaskMap[activeSection].map(({ task, idx }, localIdx) => (
                  <button
                    key={task.id}
                    onClick={() => handleTaskSelect(idx)}
                    className={`px-2 py-0.5 rounded-md border font-sans text-[10px] font-bold transition-all shrink-0 flex items-center gap-0.5 ${
                      idx === currentTaskIndex
                        ? 'border-indigo-600 bg-indigo-600 text-white'
                        : task.confirmed
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border-slate-200 bg-white text-slate-500'
                    }`}
                  >
                    <span>句{localIdx + 1}</span>
                    {task.confirmed && <CheckCircle2 className="h-2.5 w-2.5 text-emerald-600" />}
                  </button>
                ))}
              </div>
              <button
                onClick={generateTasks}
                disabled={loadingTasks}
                className="text-[10px] text-indigo-600 font-bold hover:text-indigo-800 shrink-0 hover:underline"
                title="根据当前数据重新生成逐句任务"
              >
                ↻
              </button>
            </div>
          )}
        </div>

        {/* Main content — takes remaining height */}
        <div className="flex-1 min-h-0 overflow-y-auto pt-2.5 space-y-3">
          {loadingTasks && (
            <div className="flex flex-col gap-2 bg-indigo-50/50 rounded-xl p-3 border border-indigo-100 font-sans text-xs text-indigo-900 leading-relaxed">
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
              <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm space-y-3 flex flex-col min-h-0">
                <div>
                  <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider block mb-1">
                    🎯 当前中文语义目标
                  </span>
                  <p className="text-slate-900 font-bold text-sm leading-relaxed bg-indigo-50/50 border-l-4 border-indigo-500 p-2.5 rounded-r-lg font-sans">
                    {renderConceptWithHighlights(
                      activeTask.concept,
                      activeTask.highlights,
                    )}
                  </p>
                </div>

                <div>
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1">
                    🔗 句型骨架提示
                  </span>
                  <div className="space-y-1.5">
                    {activeTask.prompts.slice(0, 2).map((p, i) => {
                      const hasArrow = p.includes('->');
                      if (hasArrow) {
                        const parts = p.split('->');
                        const engPattern = parts[0].trim();
                        const chiMapping = parts.slice(1).join('->').trim();
                        return (
                          <div key={i} className="border-l-2 border-indigo-200 pl-2 space-y-0.5">
                            <span className="font-mono text-xs font-bold text-indigo-900 select-all block">{engPattern}</span>
                            {chiMapping && (
                              <p className="font-sans text-[11px] text-slate-400 leading-normal">{chiMapping}</p>
                            )}
                          </div>
                        );
                      }
                      return (
                        <div key={i} className="border-l-2 border-indigo-200 pl-2 font-mono text-[11px] text-slate-600">
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
                        <div className="mt-1.5 space-y-1.5">
                          {activeTask.prompts.slice(2).map((p, i) => {
                            const hasArrow = p.includes('->');
                            if (hasArrow) {
                              const parts = p.split('->');
                              const engPattern = parts[0].trim();
                              const chiMapping = parts.slice(1).join('->').trim();
                              return (
                                <div key={i} className="border-l-2 border-indigo-100 pl-2 space-y-0.5">
                                  <span className="font-mono text-xs font-bold text-indigo-800 select-all block">{engPattern}</span>
                                  {chiMapping && (
                                    <p className="font-sans text-[11px] text-slate-400 leading-normal">{chiMapping}</p>
                                  )}
                                </div>
                              );
                            }
                            return (
                              <div key={i} className="border-l-2 border-indigo-100 pl-2 font-mono text-[11px] text-slate-500">
                                {p}
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    )}
                  </div>
                </div>

                <div className="border-t border-slate-100 pt-2.5 space-y-2 flex flex-col min-h-0 flex-1">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                    快捷提问
                  </span>
                  <div className="grid grid-cols-2 gap-1.5 shrink-0">
                    {LEFT_QUICK_ASKS.map((ask) => (
                      <button
                        key={ask.id}
                        type="button"
                        disabled={guidanceLoading || !activeTask}
                        onClick={() => void handleLeftQuickAsk(ask)}
                        className="rounded-lg border border-indigo-200 bg-indigo-50/60 px-2 py-2 text-left text-[11px] font-bold text-indigo-900 hover:bg-indigo-100 transition disabled:opacity-50"
                      >
                        {ask.label}
                      </button>
                    ))}
                  </div>

                  {(guidanceThread.length > 0 || guidanceLoading) && (
                    <div className="flex-1 min-h-[140px] max-h-none overflow-y-auto space-y-1.5 rounded-lg bg-slate-50/80 border border-slate-100 p-2">
                      {guidanceThread.map((msg) =>
                        msg.role === 'user' ? (
                          <div key={msg.id} className="flex justify-end">
                            <div className="max-w-[90%] rounded-2xl rounded-br-md bg-indigo-600 px-2.5 py-1 text-[11px] font-bold text-white">
                              {msg.label}
                            </div>
                          </div>
                        ) : (
                          <div key={msg.id} className="flex justify-start">
                            <div className="max-w-[95%] rounded-2xl rounded-bl-md border border-slate-200 bg-white px-2.5 py-1.5 space-y-1 shadow-xs">
                              {(() => {
                                const hint = String(msg.hint || '').trim();
                                const issue = String(msg.issue || '').trim();
                                const showIssue =
                                  !!issue &&
                                  (!hint ||
                                    (!hint.includes(issue) &&
                                      issue.length >= 4 &&
                                      issue !== '暂时没能生成建议' &&
                                      issue !== '调用失败'));
                                return (
                                  <>
                                    {showIssue && (
                                      <p className="text-[11px] text-slate-500 leading-snug">
                                        {renderHighlightedGuidanceText(issue)}
                                      </p>
                                    )}
                                    {hint ? (
                                      <p className="text-[12px] text-slate-800 leading-relaxed font-medium">
                                        {renderHighlightedGuidanceText(hint)}
                                      </p>
                                    ) : showIssue ? null : (
                                      <p className="text-[11px] text-slate-400">暂无建议</p>
                                    )}
                                  </>
                                );
                              })()}
                            </div>
                          </div>
                        ),
                      )}
                      {guidanceLoading && (
                        <div className="flex justify-start">
                          <div className="inline-flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] text-indigo-700">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            …
                          </div>
                        </div>
                      )}
                      <div ref={guidanceThreadEndRef} />
                    </div>
                  )}
                  {startScaffoldActive && (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <input
                        type="text"
                        value={scaffoldReply}
                        onChange={(e) => setScaffoldReply(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void handleScaffoldReply();
                          }
                        }}
                        disabled={guidanceLoading}
                        placeholder="接着回答起步引导…"
                        className="flex-1 min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
                      />
                      <button
                        type="button"
                        disabled={guidanceLoading || !scaffoldReply.trim()}
                        onClick={() => void handleScaffoldReply()}
                        className="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
                      >
                        发送
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          )}

          {errorMsg && (
            <div className="bg-rose-50 border border-rose-100 rounded-lg p-3 text-rose-800 text-xs flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-rose-500 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>
      </div>

      <div className="lg:col-span-7 xl:col-span-7 relative flex flex-col h-[480px] lg:h-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden min-h-0">
        {/* Thin top bar */}
        <div className="bg-slate-50/80 border-b border-slate-200 px-4 py-2 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <button
                onClick={() => setTopicExpanded((v) => !v)}
                className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 hover:text-slate-700 transition shrink-0"
              >
                <span>{topicExpanded ? '▾' : '▸'}</span>
                <span>原题</span>
                {!topicExpanded && (
                  <span className="font-normal text-slate-400 truncate max-w-[160px]">
                    — {topic.question.slice(0, 40)}{topic.question.length > 40 ? '…' : ''}
                  </span>
                )}
              </button>
              <span className="text-slate-300 hidden sm:inline">|</span>
              <span className="text-[11px] font-bold text-indigo-700 truncate hidden sm:inline">
                {sectionLabel(activeSection)}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setDraftExpanded(true)}
                className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-700 hover:bg-slate-50"
              >
                全文 ▸
              </button>
              <button
                onClick={handleCopyDraft}
                disabled={!fullDraftText}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Clipboard className="h-3.5 w-3.5" />
                复制
              </button>
            </div>
          </div>
          {topicExpanded && (
            <p className="font-serif italic text-slate-700 text-xs leading-relaxed mt-2 pl-4 border-l-2 border-slate-300">
              {topic.question}
            </p>
          )}
        </div>

        {/* Context strip — current section preview only */}
        {!allConfirmed && (
          <button
            type="button"
            onClick={() => setDraftExpanded(true)}
            className="shrink-0 border-b border-slate-100 px-4 py-2 text-left hover:bg-slate-50/80 transition"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                本段上下文
              </span>
              <span className="text-[10px] text-indigo-600 font-bold">展开全文</span>
            </div>
            <p className="mt-0.5 text-[11px] text-slate-500 truncate leading-relaxed">
              {currentSectionPreview}
            </p>
          </button>
        )}

        {/* Full draft overlay drawer */}
        {draftExpanded && (
          <div className="absolute inset-0 z-20 flex flex-col bg-white/95 backdrop-blur-[2px]">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5 shrink-0">
              <span className="text-[11px] font-bold text-slate-700">全文草稿</span>
              <button
                type="button"
                onClick={() => setDraftExpanded(false)}
                className="text-[11px] font-bold text-slate-500 hover:text-slate-800"
              >
                收起 ✕
              </button>
            </div>
            <div ref={fullDraftRef} className="flex-1 overflow-y-auto p-4 space-y-4">
              {allConfirmed && (
                <div className="text-center py-2 space-y-1">
                  <p className="font-bold text-emerald-700 text-sm">全文写作完成</p>
                  <p className="text-xs text-slate-400">{tasks.length} 句 · 约 {totalWords} 词</p>
                </div>
              )}
              {sectionOrder.map((section) => {
                const sectionTasks = sectionTaskMap[section];
                if (!sectionTasks?.length) return null;
                return (
                  <section key={section} className="space-y-1">
                    <h4 className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500 mb-1">
                      {sectionLabel(section)}
                    </h4>
                    <div className="divide-y divide-slate-100">
                      {sectionTasks.map(({ task, idx }) => {
                        const isActive = idx === currentTaskIndex;
                        return (
                          <div
                            key={task.id}
                            onClick={() => {
                              handleTaskSelect(idx);
                              setDraftExpanded(false);
                            }}
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
          </div>
        )}

        {/* Main practice stage */}
        <div className="flex-1 min-h-0 flex flex-col p-4 overflow-hidden">
          {allConfirmed ? (
            <div className="flex-1 overflow-y-auto space-y-4">
              <div className="text-center py-4 space-y-1">
                <div className="text-2xl">🎉</div>
                <p className="font-bold text-emerald-700 text-sm">全文写作完成</p>
                <p className="text-xs text-slate-400">{tasks.length} 句 · 约 {totalWords} 词</p>
              </div>
              <div className="bg-slate-50/40 rounded-xl p-4 space-y-4">
                {sectionOrder.map((section) => {
                  const sectionTasks = sectionTaskMap[section];
                  if (!sectionTasks?.length) return null;
                  return (
                    <section key={section} className="space-y-1">
                      <h4 className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500 mb-1">
                        {sectionLabel(section)}
                      </h4>
                      <div className="divide-y divide-slate-100">
                        {sectionTasks.map(({ task }) => (
                          <div key={task.id} className="px-3 py-2 text-sm leading-relaxed text-slate-700">
                            {task.confirmedSentence?.trim() || task.concept}
                          </div>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
              <div className="flex items-center justify-between shrink-0">
                <span className="text-[10px] text-slate-400 uppercase tracking-wider">
                  当前练习工作区
                </span>
                <div className="flex items-center gap-2">
                  {userDraft.trim() && (
                    <span className="text-[10px] text-slate-300 tabular-nums">
                      {userDraft.trim().split(/\s+/).filter(Boolean).length}词
                    </span>
                  )}
                  <span className="text-[10px] text-slate-300 hidden md:inline" title="快捷键">
                    选中后点标签提问 · Esc 清除
                  </span>
                </div>
              </div>

              {/* Selection ask — chips + answer directly below */}
              {viewMode === 'editing' && selectedScope && (
                <div className="shrink-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50/70 px-2.5 py-2">
                    <span className="text-[11px] text-indigo-800 truncate max-w-[180px]">
                      选中：「{selectedScope}」
                    </span>
                    {selectedSceneChips.map((chip) => (
                      <button
                        key={chip.id}
                        type="button"
                        disabled={selectionAskLoading}
                        onClick={() => void handleSelectionAsk(chip.id)}
                        className="rounded-full border border-indigo-200 bg-white px-2 py-0.5 text-[10px] font-bold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                      >
                        {chip.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedText('');
                        setSelectionGuidance(null);
                      }}
                      className="ml-auto text-[10px] text-slate-400 hover:text-slate-600"
                    >
                      Esc 清除
                    </button>
                  </div>
                  {(selectionAskLoading || selectionGuidance) && (
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 space-y-1">
                      {selectionAskLoading && (
                        <div className="text-[11px] text-indigo-700 flex items-center gap-1.5">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          …
                        </div>
                      )}
                      {selectionGuidance && !selectionAskLoading && (
                        <>
                          {selectionGuidance.hint?.trim() ? (
                            <p className="text-[12px] text-slate-800 leading-relaxed font-medium">
                              {renderHighlightedGuidanceText(selectionGuidance.hint)}
                            </p>
                          ) : selectionGuidance.issue?.trim() ? (
                            <p className="text-[12px] text-slate-800 leading-relaxed">
                              {renderHighlightedGuidanceText(selectionGuidance.issue)}
                            </p>
                          ) : (
                            <p className="text-[11px] text-slate-400">暂无建议</p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-0.5">
                {viewMode === 'editing' ? (
                  <textarea
                    ref={editorRef}
                    value={userDraft}
                    onChange={(e) => {
                      setUserDraft(e.target.value);
                      setViewMode('editing');
                    }}
                    onSelect={handleEditorSelection}
                    disabled={evaluating || !activeTask}
                    placeholder="在此起草当前句子的英文版本... 选中片段可提问"
                    className="w-full min-h-[160px] h-full p-4 border border-slate-200 rounded-lg font-serif italic text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-none leading-relaxed"
                  />
                ) : (
                  <div className="w-full min-h-[128px] p-4 border border-slate-200 rounded-lg bg-slate-50/40 text-sm leading-relaxed">
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">
                      句内批改（点击描红查看说明）
                    </div>
                    <p className="font-serif text-slate-800">
                      {reviewResult.segments.map((segment, idx) =>
                        segment.annotation ? (
                          <button
                            type="button"
                            key={idx}
                            onClick={() =>
                              focusAnnotation(
                                typeof segment.annotationIndex === 'number'
                                  ? segment.annotationIndex
                                  : null,
                              )
                            }
                            className={`px-0.5 rounded-sm underline decoration-wavy decoration-rose-500 cursor-pointer transition ${
                              activeAnnotationIdx === segment.annotationIndex
                                ? 'bg-rose-300 text-rose-950 ring-2 ring-rose-400'
                                : 'bg-rose-100 text-rose-800 hover:bg-rose-200'
                            }`}
                            title={`${CATEGORY_LABELS[segment.annotation.category] || segment.annotation.category}: ${segment.annotation.explanation}`}
                          >
                            {segment.text}
                          </button>
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
                  <div ref={annotationListRef} className="space-y-1.5">
                    <div className="text-[10px] font-bold text-rose-700 uppercase tracking-wider">
                      批改说明（{activeTask.annotations.length} 处）· 点击与描红联动
                    </div>
                    <div className="space-y-1.5">
                      {activeTask.annotations.map((ann, idx) => {
                        const active = activeAnnotationIdx === idx;
                        return (
                          <div
                            key={`${ann.text}-${idx}`}
                            ref={(el) => {
                              annotationItemRefs.current[idx] = el;
                            }}
                            onClick={() => focusAnnotation(idx)}
                            className={`cursor-pointer rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed transition ${
                              active
                                ? 'border-rose-400 bg-rose-50 text-rose-950 shadow-sm'
                                : 'border-transparent border-l-4 border-l-rose-200 text-rose-900 hover:bg-rose-50/60'
                            }`}
                          >
                            <span className="font-bold mr-1">
                              [{CATEGORY_LABELS[ann.category] || ann.category}]
                            </span>
                            <span className="font-mono bg-rose-100/80 px-1 rounded">{ann.text}</span>
                            <span className="mt-0.5 block text-rose-800/90">{ann.explanation}</span>
                          </div>
                        );
                      })}
                      {reviewResult.unmatched.length > 0 && (
                        <div className="text-[11px] text-amber-700 pt-1">
                          部分标注未能精确定位到原句，已按列表展示。
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {viewMode === 'reviewing' && activeTask?.contentAlignment && (
                  <details className="group">
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
              </div>

              {!activeTask?.hasBeenChecked && userDraft.trim() && (
                <div className="text-[11px] text-slate-500 shrink-0">
                  你可以直接确认，也可以先批改再确认。
                </div>
              )}

              <div className="shrink-0 bg-white pt-2 border-t border-slate-100 flex flex-col sm:flex-row gap-2">
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
