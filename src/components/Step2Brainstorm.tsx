import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { CheckCircle2, AlertCircle, ArrowRight, Loader2, BookOpen, Award, Layers, Sparkles, RotateCcw } from 'lucide-react';
import { Topic, PracticeSession, Dimension } from '../types';
import CoachChat from './CoachChat';

/** Strip internal retention/thinness markers before showing userPoints in the Blueprint UI. */
function stripStep2InternalTags(text: string): string {
  return String(text || '')
    .replace(/［待裁决：[^\］]*］/g, '')
    .replace(/［待新增：[^\］]*］/g, '')
    .replace(/［[；;]\s*[:：]?[^\］]*］/g, '')
    .replace(/（待补例子）/g, '')
    .replace(/（\s*[主次]\s*[／/]\s*(?:详写|略写)\s*）/g, '')
    .replace(/（\s*已选详写[^）]*）/g, '')
    .replace(/（\s*已选略写[^）]*）/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Infer 详写/略写 only from locked tags — never from coach「建议详写」recommend copy. */
function retentionRoleFromUserPoints(
  claim: string,
  userPoints: string,
): 'detail' | 'brief' | 'dropped' | undefined {
  const head = String(claim || '').trim();
  if (head.length < 2 || !userPoints) return undefined;
  // Pending proposal must not paint 详写/略写 on the board
  if (/［待裁决：/.test(userPoints) && !/已选详写|已选略写|用户放弃/.test(userPoints)) {
    return undefined;
  }
  const prefix = head.slice(0, Math.min(4, head.length));
  const chunks = String(userPoints)
    .split(/[；;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const relevant = chunks.filter((c) => {
    const bare = stripStep2InternalTags(c);
    return (
      bare.includes(head) ||
      head.includes(bare.slice(0, 8)) ||
      (prefix.length >= 3 && bare.includes(prefix))
    );
  });
  // A corpus that never mentions this claim must NOT leak sibling tags onto
  // it (mirror of the server-side inferRetentionRoleFromText fix): an unfilled
  // B-side slot was painted 详写 by an A-side 已选详写 via the whole-text
  // fallback window.
  if (!relevant.length) return undefined;
  const scan = relevant.join('；');
  const idx = scan.indexOf(prefix);
  const window =
    idx >= 0 ? scan.slice(Math.max(0, idx - 2), idx + head.length + 20) : scan;
  if (/用户放弃/.test(window)) return 'dropped';
  if (/已选详写/.test(window)) return 'detail';
  if (/已选略写|保留-略写/.test(window)) return 'brief';
  return undefined;
}

/** Board quality badge: real body only — never mark claim-echo as 可写. */
function displayPointQuality(
  claim: string,
  elaboration: string,
): 'ready' | 'thin' {
  const c = String(claim || '').trim();
  const e = String(elaboration || '')
    .replace(/［待裁决：[^\］]*］/g, '')
    .replace(/（\s*已选详写[^）]*）/g, '')
    .replace(/（\s*已选略写[^）]*）/g, '')
    .trim();
  if (!e || e.length < 8) return 'thin';
  const core = c
    .replace(
      /[（(]\s*(原因|成因|评价|利弊|影响|解决|问题|主|次|详写|略写|待加深|可写)\s*[）)]/g,
      '',
    )
    .trim();
  if (
    core &&
    (e === core ||
      e === c ||
      (e.startsWith(core) && e.length <= core.length + 6))
  ) {
    return 'thin';
  }
  if (/^(?:原因|成因|评价|待加深|可写)$/.test(e)) return 'thin';
  return 'ready';
}

function displayElaboration(claim: string, elaboration: string): string {
  const e = String(elaboration || '').trim();
  if (!e) return '';
  if (displayPointQuality(claim, e) === 'thin' && e.length <= String(claim || '').length + 8) {
    // Hide claim-echo shells like「主流文化冲击（待加深）」under the title
    const core = String(claim || '')
      .replace(
        /[（(]\s*(原因|成因|评价|利弊|影响|解决|问题)\s*[）)]/g,
        '',
      )
      .trim();
    if (core && (e === core || e.startsWith(core))) return '';
  }
  return e;
}

function displayLeanTags(tags: string[]): string[] {
  const list = (tags || []).map(String).filter(Boolean);
  if (list.some((t) => t !== 'general')) {
    return list.filter((t) => t !== 'general');
  }
  return list;
}

/** Fallback: pull elaboration from userPoints when payload point only has a short head. */
function elabFromUserPoints(claim: string, userPoints: string): string {
  const head = String(claim || '').trim();
  if (!head || head.length < 2) return '';
  const chunks = String(userPoints || '')
    .split(/[；;\n]+/)
    .map((s) => stripStep2InternalTags(s))
    .filter(Boolean);
  for (const chunk of chunks) {
    const colon = chunk.match(
      /^([\u4e00-\u9fffA-Za-z0-9·、]{2,24})\s*[：:]\s*([\s\S]+)$/,
    );
    if (colon) {
      const h = colon[1].trim();
      if (h === head || h.startsWith(head) || head.startsWith(h)) {
        return colon[2].trim();
      }
    }
    const paren = chunk.match(
      /^([\u4e00-\u9fffA-Za-z0-9·、]{2,24})[（(]([\s\S]+?)[）)]/,
    );
    if (paren) {
      const h = paren[1].trim();
      const inner = paren[2].trim();
      if (
        (h === head || h.startsWith(head) || head.startsWith(h)) &&
        inner.length >= 4 &&
        !/^(?:主|次)?[／/]?(?:详写|略写)?$/.test(inner) &&
        !/^(?:原因|成因|评价|利弊|影响|解决|问题|待加深|可写|可展开|空标签|质量待确认|已探测|已询退出)$/.test(
          inner,
        )
      ) {
        return inner;
      }
    }
  }
  return '';
}

/**
 * Split explore-stage userPoints into Body 1 / Body 2 for the Blueprint fallback.
 * Prefer A面/B面 markers; never dump the whole string into Body 1 via split('\\n')[0].
 */
function splitUserPointsForBlueprint(userPoints: string): { body1: string; body2: string } {
  const cleaned = stripStep2InternalTags(userPoints);
  if (!cleaned) return { body1: '', body2: '' };

  const aMatch = cleaned.match(/A面[^：:]*[：:]([\s\S]*?)(?=B面[^：:]*[：:]|$)/);
  const bMatch = cleaned.match(/B面[^：:]*[：:]([\s\S]*)$/);
  if (aMatch || bMatch) {
    return {
      body1: stripStep2InternalTags((aMatch?.[1] || '').replace(/^[；;，,\s]+|[；;，,\s]+$/g, '')),
      body2: stripStep2InternalTags((bMatch?.[1] || '').replace(/^[；;，,\s]+|[；;，,\s]+$/g, '')),
    };
  }

  const byNewline = cleaned.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (byNewline.length >= 2) {
    return { body1: byNewline[0], body2: byNewline.slice(1).join('；') };
  }

  // Single-side explore content (no B面 yet): keep everything in Body 1.
  return { body1: cleaned, body2: '' };
}

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
  const [plannerStatus, setPlannerStatus] = useState<'idle' | 'running' | 'passed' | 'failed'>('idle');
  const plannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const plannerAbortRef = useRef<AbortController | null>(null);
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

  const pointsForBlueprint = splitUserPointsForBlueprint(
    String(evalData?.userPoints || session.step2.userPoints || ''),
  );

  // Jump button: prefer server isCompleted; also unlock for stuck sessions where
  // the coach already said "进入第三步" and the blueprint already has real content
  // (covers the stance→summary currentStage desync without waiting for another turn).
  const showNextStepButton = useMemo(() => {
    if (session.step2.isCompleted) return true;
    const history = session.step2.chatHistory || [];
    const ctaOk = history.some(
      (m) =>
        m.sender === 'ai' &&
        typeof m.text === 'string' &&
        (m.text.includes('进入第三步') ||
          m.text.includes('进入第三阶段') ||
          /进入\s*Step\s*3/i.test(m.text) ||
          (m.text.includes('下一步') && m.text.includes('第三步'))),
    );
    if (!ctaOk) return false;
    const payload = (evalData as any)?.plannerPayload;
    if (payload?.exitGate?.canComplete) return true;
    const readyPoints = Array.isArray(payload?.points)
      ? payload.points.filter(
          (p: any) => !p?.supersededBy && p?.quality === 'ready',
        ).length
      : 0;
    const blueprint = (evalData as any)?.blueprint || {};
    const stance = String(
      payload?.stance?.text ||
        blueprint.position ||
        evalData?.userStance ||
        session.step2.userStance ||
        '',
    ).trim();
    if (readyPoints >= 2 && stance) return true;
    if (!stance) return false;
    const bodies = Array.isArray(blueprint.bodies) ? blueprint.bodies : [];
    const filledBodies = bodies.filter(
      (b: any) => String(b?.content || b?.title || '').trim(),
    ).length;
    const legacyBodies =
      (String(blueprint.body1 || pointsForBlueprint.body1 || '').trim() ? 1 : 0) +
      (String(blueprint.body2 || pointsForBlueprint.body2 || '').trim() ? 1 : 0);
    const clusterCount = Array.isArray((evalData as any)?.clustering?.clusters)
      ? (evalData as any).clustering.clusters.filter((c: any) =>
          String(c?.content || c?.theme || '').trim(),
        ).length
      : 0;
    return Math.max(filledBodies, legacyBodies, clusterCount) >= 2;
  }, [
    session.step2.isCompleted,
    session.step2.chatHistory,
    session.step2.userStance,
    evalData,
    pointsForBlueprint.body1,
    pointsForBlueprint.body2,
  ]);

  // Planner: 当 CTA 出现且 planner 未运行时自动触发
  const triggerPlanner = async (controller: AbortController) => {
    try {
      const res = await fetch('/api/planner/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (plannerTimerRef.current) {
        clearTimeout(plannerTimerRef.current);
        plannerTimerRef.current = null;
      }
      if (data.status === 'passed') {
        setPlannerStatus('passed');
        onUpdateSession({ step2_5: data.step2_5 } as any);
      } else {
        setPlannerStatus('failed');
      }
    } catch {
      if (plannerTimerRef.current) {
        clearTimeout(plannerTimerRef.current);
        plannerTimerRef.current = null;
      }
      setPlannerStatus('failed');
    } finally {
      plannerAbortRef.current = null;
    }
  };

  // Effect A: 状态机 — CTA 出现且 idle 时置 running。
  // 注意：绝不能在同一个 effect 里又创建 controller 又 setState('running')，
  // 否则状态变化触发 cleanup 会立刻 abort 掉刚发起的请求（竞态）。
  useEffect(() => {
    if (!showNextStepButton) return;
    if (plannerStatus !== 'idle') return;
    setPlannerStatus('running');
  }, [showNextStepButton, plannerStatus]);

  // Effect B: 真正发起请求 — 仅在 running 时执行；cleanup 只在状态离开
  // running（成功/失败/卸载）时 abort，属于正常收尾，不会误杀请求。
  useEffect(() => {
    if (plannerStatus !== 'running') return;
    const controller = new AbortController();
    plannerAbortRef.current = controller;
    // 单一超时源：到点即 abort 请求并把状态置为 failed（可重试）。
    // 180s 覆盖服务端最多 2 次 LLM 尝试（正常网络单次 30-80s）。
    plannerTimerRef.current = setTimeout(() => {
      controller.abort();
      setPlannerStatus('failed');
    }, 180000);
    triggerPlanner(controller);
    return () => {
      if (plannerTimerRef.current) {
        clearTimeout(plannerTimerRef.current);
        plannerTimerRef.current = null;
      }
      plannerAbortRef.current?.abort();
      plannerAbortRef.current = null;
    };
  }, [plannerStatus]);

  const handleNextStepWithPlanner = () => {
    if (plannerStatus === 'passed') {
      onNextStep();
    } else if (plannerStatus === 'failed') {
      setPlannerStatus('idle');
    }
  };

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
欢迎进入第二步！我正在结合你第一步的审题结论，为你定制第一个发散问题...`
    : `【雅思写作原题 (Topic)】
${topic.question}

【第二步：立场与论点 🧠】
欢迎进入第二步！我正在结合这道题目，为你定制第一个发散问题...`;

  const kickoffPrompt = (() => {
    const issueText = eval1?.coreIssue || "";
    const constraintsText = eval1?.constraints && eval1.constraints.length > 0
      ? eval1.constraints.join('、')
      : "";
    const dimensionsText = step1SuggestedDimensions.length > 0
      ? step1SuggestedDimensions.join('、')
      : "";
    // Prefer the first Step1 dimension as the expansion anchor (strip task tags like "（原因）").
    const firstDimension = step1SuggestedDimensions[0]
      ? step1SuggestedDimensions[0].replace(/[（(][^）)]*[）)]/g, "").trim()
      : "";

    const contextLines = [
      issueText ? `核心争议：${issueText}` : "",
      constraintsText ? `关键限定：${constraintsText}` : "",
      dimensionsText ? `建议讨论维度：${dimensionsText}` : "",
      userNotes ? `我的审题想法：${userNotes}` : "",
    ].filter(Boolean);

    const contextPrefix =
      contextLines.length > 0
        ? `请直接结合我第一步的审题结论（${contextLines.join('；')}），`
        : "请直接结合这道题目本身，";

    if (firstDimension) {
      return `这是第二步的开场，我还没有说任何话，请不要假装在回应我说过的内容。${contextPrefix}直接进入 Explore-A：点名第一步已确认的维度「${firstDimension}」，只问一个具体展开问题——场景 / 机制 / 受益或受影响对象（三选一即可）。FORBIDDEN：禁止再问「可以从哪些角度切入」「有哪些方面」「请列出维度」等清单式问题；禁止再确认题型或核心议题。问题要短、自然、贴合题目。`;
    }

    return `这是第二步的开场，我还没有说任何话，请不要假装在回应我说过的内容。${contextPrefix}给我一个高质量、有针对性的发散问题（Explore-A 阶段），引导我先谈这个立场下最值得展开的具体支持论据或正面好处；不要泛泛而问，要让问题贴合这道题目和已知信息。FORBIDDEN：禁止再问「可以从哪些角度切入」「有哪些方面」等清单式问题；禁止再确认题型或核心议题。`;
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
          inputDisabled={plannerStatus === 'running'}
        >
          {errorMsg && (
            <div className="bg-rose-50 border border-rose-100 rounded-lg p-3 text-rose-800 text-xs flex items-center gap-2 mt-2">
              <AlertCircle className="h-4 w-4 text-rose-500 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Coach Controls / Action bar — unlock with isCompleted or CTA+blueprint */}
          {showNextStepButton && (
            <div className="mt-4 border-t border-emerald-100 pt-3.5 animate-fade-in">
              <div className="bg-emerald-50 border border-emerald-200/80 rounded-xl p-3.5 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xs">
                <div className="flex items-center gap-2.5">
                  <div className="h-7 w-7 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="h-4 w-4" />
                  </div>
                  <div className="text-left">
                    <h4 className="font-sans font-bold text-emerald-900 text-xs">🎉 观点与分论点通关！</h4>
                    <p className="font-sans text-[11px] text-emerald-700 leading-normal">
                      AI Coach 已判定你的观点与分论点设计合格。点击下方【立即跳转】，进入下一步论证拆解。
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleNextStepWithPlanner}
                  disabled={plannerStatus === 'running'}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-4 py-2 font-sans text-xs font-bold text-white shadow-sm transition shrink-0"
                >
                  {plannerStatus === 'running' ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /><span>正在整理段落结构…</span></>
                  ) : plannerStatus === 'failed' ? (
                    <><RotateCcw className="h-3.5 w-3.5" /><span>重试</span></>
                  ) : (
                    <><span>立即跳转</span><ArrowRight className="h-3.5 w-3.5" /></>
                  )}
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
              {/* Overall progress bar (replaces discrete stage chips) */}
              {(() => {
                const requiresStance = (evalData as any)?.requiresStance !== false;
                const taskLabelA = String((evalData as any)?.taskLabelA || '').trim();
                const taskLabelB = String((evalData as any)?.taskLabelB || '').trim();
                const labelA = taskLabelA || (requiresStance ? '支持面' : '第一任务');
                const labelB = taskLabelB || (requiresStance ? '让步/对立面' : '第二任务');
                const currentStage = String((evalData as any)?.currentStage || 'explore_A');
                const stageMeta: Record<string, { pct: number; label: string }> = requiresStance
                  ? {
                      explore_A: { pct: 25, label: labelA },
                      explore_B: { pct: 50, label: labelB },
                      stance: { pct: 75, label: '明确立场' },
                      summary: { pct: 90, label: '材料确认' },
                    }
                  : {
                      explore_A: { pct: 33, label: labelA || '第一任务' },
                      explore_B: { pct: 66, label: labelB || '第二任务' },
                      summary: { pct: 90, label: '材料确认' },
                    };
                const done = !!session.step2.isCompleted;
                const meta = stageMeta[currentStage] || stageMeta.explore_A;
                const pct = done ? 100 : meta.pct;
                const statusLabel = done ? '已完成' : `${meta.label} · 进行中`;
                return (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                        讨论进度
                      </span>
                      <span className="text-[10px] font-semibold text-slate-500">
                        {statusLabel}
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          done ? 'bg-emerald-500' : 'bg-indigo-600'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })()}

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

              <div className="space-y-5">
                {/* Flat materials board — paragraph layout is Planner's job */}
                <div className="space-y-3">
                  <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider block">
                    材料池（平铺论点）
                  </span>
                  <p className="text-[10px] text-slate-500 leading-relaxed">
                    此处只汇总立场与平行论点；主体段怎么排由下一步 Planner 决定。
                  </p>

                  <div className="space-y-1">
                    <span className="text-[9px] font-bold text-slate-400 uppercase">写作原题 (Topic)</span>
                    <p className="text-xs md:text-[12.5px] italic text-slate-700 font-serif leading-relaxed font-semibold">
                      {topic.question}
                    </p>
                  </div>

                  <div className="space-y-1 pt-2 border-t border-slate-100">
                    <span className="text-[9px] font-bold text-slate-400 uppercase">
                      {(() => {
                        const pos = String(
                          (evalData as any)?.plannerPayload?.stance?.text ||
                            evalData.blueprint?.position ||
                            evalData.userStance ||
                            '',
                        );
                        const looksOverview = /本文按题目|先写「|两个任务|先解释|再提出|再写「/.test(pos);
                        return looksOverview
                          ? '总体概述 (Overview)'
                          : '全文立场 (Overall Position)';
                      })()}
                    </span>
                    <p className={`text-xs md:text-[12.5px] leading-relaxed ${
                      (evalData as any)?.plannerPayload?.stance?.text ||
                      evalData.blueprint?.position ||
                      evalData.userStance
                        ? 'text-slate-900 font-bold'
                        : 'text-slate-400 italic'
                    }`}>
                      {(evalData as any)?.plannerPayload?.stance?.text ||
                        evalData.blueprint?.position ||
                        evalData.userStance ||
                        '⏳ 展开论点后，再在此确认立场...'}
                    </p>
                  </div>

                  {(() => {
                    const sideSettled: string[] = Array.isArray(
                      (evalData as any)?.plannerPayload?.sideSettled,
                    )
                      ? (evalData as any).plannerPayload.sideSettled
                      : [];
                    const pointSideKeyUi = (p: any): string => {
                      const tags = Array.isArray(p.leanTags) ? p.leanTags : [];
                      const order = [
                        'part_1', 'part_2', 'view_a', 'view_b', 'advantage',
                        'disadvantage', 'cause', 'solution', 'positive', 'negative',
                        'support_main', 'oppose_or_qualify',
                      ];
                      for (const b of order) if (tags.includes(b)) return b;
                      return 'general';
                    };
                    const isPointConfirmedUi = (p: any): boolean => {
                      if (p.confirmed === true) return true;
                      if (p.confirmed === undefined) {
                        // 旧会话读取侧迁移：无 confirmed 字段时，若其侧已 sideSettled 视为已确认。
                        return sideSettled.includes(pointSideKeyUi(p));
                      }
                      return false;
                    };
                    const payloadPts = Array.isArray((evalData as any)?.plannerPayload?.points)
                      ? (evalData as any).plannerPayload.points.filter(
                          (p: any) => p && !p.supersededBy && String(p.claim || '').trim(),
                        )
                      : [];
                    const listFallback = Array.isArray(evalData.clustering?.pointsList)
                      ? evalData.clustering.pointsList
                          .map((pt: string) => String(pt || '').trim())
                          .filter(Boolean)
                      : [];
                    const fromUserPoints = String(evalData.userPoints || '')
                      .split(/[；;\n]+/)
                      .map((s) =>
                        s
                          .replace(/^[AB]面[^：:]*[：:]/g, '')
                          .replace(/^\d+[.、．)\]]\s*/, '')
                          .trim(),
                      )
                      .filter((s) => s.length >= 6);

                    const userPointsRaw = String(evalData.userPoints || '');
                    // Only locked tags count — never infer from coach recommend chatter.
                    const hasLockedTags =
                      /已选详写|已选略写|用户放弃/.test(userPointsRaw);
                    const roleCorpus = hasLockedTags ? userPointsRaw : '';
                    const rawItems =
                      payloadPts.length > 0
                        ? payloadPts.map((p: any) => {
                            const claim = String(p.claim || '').trim();
                            let elaboration = String(p.elaboration || '').trim();
                            if (!elaboration) {
                              elaboration = elabFromUserPoints(claim, userPointsRaw);
                            }
                            // Label-echo / task-role shell must stay 待加深 (not length≥4 → 可写).
                            const quality = displayPointQuality(claim, elaboration);
                            // Only the locked-tag corpus may drive display
                            // roles — a raw-corpus call here bypassed the
                            // hasLockedTags guard above.
                            const retentionRole =
                              p.retentionRole ||
                              retentionRoleFromUserPoints(claim, roleCorpus);
                            return {
                              id: p.id,
                              claim,
                              elaboration: displayElaboration(claim, elaboration),
                              quality,
                              retentionRole,
                              confirmed: isPointConfirmedUi(p),
                              tags: displayLeanTags(
                                Array.isArray(p.leanTags) ? p.leanTags : [],
                              ),
                            };
                          })
                        : (listFallback.length ? listFallback : fromUserPoints).map(
                            (claim: string, i: number) => {
                              const c = String(claim || '').trim();
                              const elaboration = elabFromUserPoints(c, userPointsRaw);
                              return {
                                id: `f${i + 1}`,
                                claim: c,
                                elaboration: displayElaboration(c, elaboration),
                                quality: displayPointQuality(c, elaboration),
                                retentionRole: retentionRoleFromUserPoints(
                                  c,
                                  roleCorpus,
                                ),
                                confirmed: false,
                                tags: [] as string[],
                              };
                            },
                          );
                    // Collapse nested heads (社会文化 ⊂ 社会文化服务) for display
                    const flatItems: typeof rawItems = [];
                    for (const item of rawItems) {
                      const idx = flatItems.findIndex((x) => {
                        const a = x.claim;
                        const b = item.claim;
                        if (a === b) return true;
                        const short = a.length <= b.length ? a : b;
                        const long = a.length <= b.length ? b : a;
                        return short.length >= 3 && long.startsWith(short);
                      });
                      if (idx < 0) {
                        flatItems.push(item);
                        continue;
                      }
                      const prev = flatItems[idx];
                      if (item.claim.length > prev.claim.length) prev.claim = item.claim;
                      if (
                        item.elaboration &&
                        !String(prev.elaboration || '').includes(item.elaboration)
                      ) {
                        prev.elaboration = [prev.elaboration, item.elaboration]
                          .filter(Boolean)
                          .join('；');
                      }
                      if (item.quality === 'ready') prev.quality = 'ready';
                      if (item.retentionRole && !prev.retentionRole) {
                        prev.retentionRole = item.retentionRole;
                      }
                      if (item.confirmed) prev.confirmed = true;
                      prev.tags = [...new Set([...(prev.tags || []), ...(item.tags || [])])];
                    }

                    const missing = Array.isArray(
                      (evalData as any)?.plannerPayload?.coverage?.missingBuckets,
                    )
                      ? (evalData as any).plannerPayload.coverage.missingBuckets
                      : [];

                    return (
                      <div className="space-y-2 pt-2 border-t border-slate-100">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[9px] font-bold text-slate-400 uppercase">
                            平行论点 ({flatItems.length})
                          </span>
                          {missing.length > 0 && (
                            <span className="text-[10px] font-semibold text-amber-700">
                              待补：{missing.join('、')}
                            </span>
                          )}
                        </div>
                        {flatItems.length === 0 ? (
                          <p className="text-xs md:text-[12.5px] text-slate-400 italic leading-relaxed">
                            ⏳ 正在从对话中提取平行论点（尚无主体段概念）...
                          </p>
                        ) : (
                          <ol className="space-y-2.5 list-none pl-0">
                            {flatItems.map((item: any, idx: number) => (
                              <li
                                key={item.id || idx}
                                className="pt-2 border-t border-slate-100 first:border-t-0 first:pt-0"
                              >
                                <div className="flex items-start gap-2">
                                  <span className="text-[10px] font-bold text-indigo-500 shrink-0 mt-0.5">
                                    {idx + 1}.
                                  </span>
                                  <div className="min-w-0 space-y-0.5">
                                    <p className="text-xs md:text-[12.5px] leading-relaxed text-slate-900 font-semibold">
                                      {item.claim}
                                      {item.confirmed ? (
                                        <span className="ml-1.5 text-[10px] font-bold text-emerald-600">
                                          已确认
                                        </span>
                                      ) : (
                                        <span className="ml-1.5 text-[10px] font-bold text-amber-600">
                                          待确认
                                        </span>
                                      )}
                                      {item.retentionRole === 'detail' ? (
                                        <span className="ml-1.5 text-[10px] font-bold text-indigo-600">
                                          详写
                                        </span>
                                      ) : null}
                                      {item.retentionRole === 'brief' ? (
                                        <span className="ml-1.5 text-[10px] font-bold text-slate-500">
                                          略写
                                        </span>
                                      ) : null}
                                      {item.retentionRole === 'dropped' ? (
                                        <span className="ml-1.5 text-[10px] font-bold text-slate-400">
                                          放下
                                        </span>
                                      ) : null}
                                    </p>
                                    {item.elaboration ? (
                                      <p className="text-[11px] text-slate-500 leading-relaxed">
                                        {item.elaboration}
                                      </p>
                                    ) : null}
                                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                                      <span
                                        className={`text-[9px] font-bold uppercase tracking-wide ${
                                          item.quality === 'ready'
                                            ? 'text-emerald-600'
                                            : 'text-amber-600'
                                        }`}
                                      >
                                        {item.quality === 'ready' ? '可写' : '待加深'}
                                      </span>
                                      {item.tags.map((t: string) => (
                                        <span
                                          key={t}
                                          className="text-[9px] font-medium text-slate-400"
                                        >
                                          {t}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Optional: dropped/merged notes only — no body clustering UI */}
                {evalData.clustering?.outliers &&
                  evalData.clustering.outliers.length > 0 && (
                  <div className="space-y-2 pt-1 border-t border-slate-100">
                    <span className="text-[10px] font-bold text-amber-800 uppercase tracking-wider block">
                      已放下 / 已合并
                    </span>
                    <div className="space-y-1.5">
                      {evalData.clustering.outliers.map((outlier: any, oIdx: number) => (
                        <div key={oIdx} className="text-xs md:text-[12.5px] space-y-0.5">
                          <span className="font-bold text-amber-900">“{outlier.point}”</span>
                          <p className="text-slate-600 leading-relaxed">{outlier.suggestion}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6 space-y-4 my-auto">
              <div className="h-12 w-12 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center animate-pulse">
                <Layers className="h-6 w-6" />
              </div>
              <div className="max-w-md space-y-1.5">
                <h3 className="font-sans font-bold text-slate-800 text-sm">💡 材料池酝酿中</h3>
                <p className="font-sans text-xs text-slate-500 leading-relaxed">
                  请先在左侧把可写论点平行展开，再确认立场。这里只展示<strong>平铺论点</strong>，不排主体段；段落结构留给下一步 Planner。
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
