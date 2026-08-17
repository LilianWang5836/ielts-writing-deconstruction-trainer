import React, {
  useState,
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { MessageSquare, Send, Loader2, AlertCircle, RotateCcw, CheckCircle2, Pencil, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Topic, PracticeSession, ChatMessage } from '../types';
import {
  isClaimSentence,
  resolveBlockClaimSentence,
} from '../utils/step3ClaimPrefill';
import { computeSubpointFrameworkSignature } from '../utils/step3Quality';
import {
  coachMessageIsContentAskNotDecision,
  coachMessageLooksLikeCapacityTrimDecision,
  coachMessageLooksLikeRetentionDecision,
  coachMessageLooksLikeSlotAddDecision,
  coachMessageLooksLikeStanceDecision,
} from '../server/step2/planner-payload';

/** Step1 Q1 — mutually exclusive chips that fill the input box. */
const STEP1_QUESTION_TYPES = [
  'Agree / Disagree',
  'Discuss Both Views',
  'Advantages / Disadvantages',
  'Two-part Question',
  'Problem / Solution',
  'Positive / Negative',
  'Other',
] as const;

interface CoachChatProps {
  topic: Topic;
  step: number;
  stepKey: 'step1' | 'step2' | 'step3' | 'step4';
  session: PracticeSession;
  onUpdateSession: (
    updates:
      | Partial<PracticeSession>
      | ((prev: PracticeSession) => Partial<PracticeSession>),
  ) => void;
  stepContext: any;
  welcomeMessage: string;
  autoKickoff?: boolean;
  kickoffPrompt?: string;
  kickoffContextKey?: string;
  inputDisabled?: boolean;
  /** loading 变化时通知父组件（Step3 秘书看板「确认写板」按钮据此禁用/启用）。 */
  onLoadingChange?: (loading: boolean) => void;
  children?: React.ReactNode; // For any extra structured evaluation UI
}

/** 暴露给父组件（Step3 看板「确认写板」按钮）的命令式句柄。 */
export interface CoachChatHandle {
  /** 发送一条学生消息（如纯「对」确认秘书 landed 内容）。 */
  sendUserMessage: (
    text: string,
    options?: {
      hiddenUserMessage?: boolean;
      targetSubpointId?: string;
      decision?: {
        type: string;
        action: string;
        claim?: string;
        proposalId?: string;
        legacyType?: string;
      };
    },
  ) => void;
  loading: boolean;
}

const CoachChat = forwardRef<CoachChatHandle, CoachChatProps>(function CoachChat(
  {
  topic,
  step,
  stepKey,
  session,
  onUpdateSession,
  stepContext,
  welcomeMessage,
  autoKickoff = false,
  kickoffPrompt = '',
  kickoffContextKey = '',
  inputDisabled = false,
  onLoadingChange,
  children,
}: CoachChatProps,
  ref: React.Ref<CoachChatHandle>,
) {
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);

  // 把 loading 状态同步给父组件（ref 更新不会触发父组件重渲染，需用回调）。
  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);
  const [errorMsg, setErrorMsg] = useState('');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const kickoffRef = useRef<string | null>(null);
  const migratedLegacyStep3HistoryRef = useRef(false);
  const requestSeqRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Get current step's chat history or initialize it
  const activeStep3SubpointId =
    stepKey === 'step3' ? session.step3?.activeSubpointId : undefined;
  const activeStep3Subpoint =
    stepKey === 'step3'
      ? session.step3?.subpoints?.find((sp) => sp.id === activeStep3SubpointId)
      : undefined;
  const chatHistory =
    stepKey === 'step3'
      ? activeStep3Subpoint?.chatHistory || []
      : session[stepKey]?.chatHistory || [];

  // Step 3：服务端暂存 pending（kickoffPendingDrafts）时，确认 UI 挂在最新 Coach 气泡上。
  const pendingDrafts =
    stepKey === 'step3'
      ? Array.isArray(activeStep3Subpoint?.kickoffPendingDrafts)
        ? activeStep3Subpoint.kickoffPendingDrafts.filter(
            (d: any) => String(d?.text || '').trim().length >= 4,
          )
        : []
      : [];
  // Keep confirm bubble stable while the affirm request is in flight (don't
  // re-split the coach message on --- just because loading flipped true).
  const hasPendingConfirm = pendingDrafts.length > 0;
  const step2Payload = (session.step2?.coachEvaluation as any)?.plannerPayload;
  const pendingProposal =
    stepKey === 'step2' && step2Payload?.pendingProposal?.proposalId
      ? step2Payload.pendingProposal
      : null;
  const hasPendingProposal = Boolean(pendingProposal);
  const pendingProposalKind = String(pendingProposal?.kind || '');
  const pendingProposalDecisionType =
    pendingProposalKind === 'side_settle'
      ? 'retention'
      : pendingProposalKind === 'slot_add'
        ? 'slot_add'
        : pendingProposalKind === 'slot_merge'
          ? 'slot_merge'
          : pendingProposalKind === 'stance'
            ? 'stance'
            : '';
  const pendingProposalSummary = (() => {
    if (!pendingProposal) return '';
    if (pendingProposal.kind === 'slot_add') {
      return String(pendingProposal.payload?.claim || '');
    }
    if (pendingProposal.kind === 'slot_merge') {
      const pts = Array.isArray(step2Payload?.points) ? step2Payload.points : [];
      const label = (id: string) => {
        const p = pts.find((x: any) => x.id === id);
        return String(p?.claim || id)
          .replace(/（[^）]*）/g, '')
          .trim();
      };
      return `${label(String(pendingProposal.payload?.fromSlotId || ''))} → ${label(
        String(pendingProposal.payload?.intoSlotId || ''),
      )}`;
    }
    if (pendingProposal.kind === 'stance') {
      return String(pendingProposal.payload?.text || '').slice(0, 80);
    }
    if (pendingProposal.kind === 'side_settle') {
      const asg = pendingProposal.payload?.assignments || [];
      const pts = Array.isArray(step2Payload?.points) ? step2Payload.points : [];
      const label = (id: string) => {
        const p = pts.find((x: any) => x.id === id);
        return String(p?.claim || id)
          .replace(/（[^）]*）/g, '')
          .trim();
      };
      const d = asg
        .filter((a: any) => a.role === 'detail')
        .map((a: any) => label(a.slotId));
      const b = asg
        .filter((a: any) => a.role === 'brief')
        .map((a: any) => label(a.slotId));
      return `详写「${d.join('、') || '—'}」/ 略写「${b.join('、') || '—'}」`;
    }
    return '';
  })();
  const pendingSlotAddClaim =
    stepKey === 'step2'
      ? String(step2Payload?.pendingSlotAdd?.claim || '').trim()
      : '';
  const hasPendingSlotAdd =
    !hasPendingProposal && Boolean(pendingSlotAddClaim);
  const step2UserPoints = String(
    (session.step2?.coachEvaluation as any)?.userPoints ||
      session.step2?.userPoints ||
      '',
  );
  const pendingRetentionMatch =
    stepKey === 'step2' && !hasPendingProposal
      ? /［待裁决：(?:详=([^｜］]+)｜略=([^｜］]+)|([^｜］]+))/.exec(step2UserPoints)
      : null;
  const hasPendingRetention = Boolean(pendingRetentionMatch);
  const pendingRetentionSummary = pendingRetentionMatch
    ? pendingRetentionMatch[1] && pendingRetentionMatch[2]
      ? `详写「${pendingRetentionMatch[1].trim()}」/ 略写「${pendingRetentionMatch[2].trim()}」`
      : String(pendingRetentionMatch[3] || '').trim()
    : '';
  const pendingCapacityTrim =
    stepKey === 'step2' && !hasPendingProposal
      ? step2Payload?.pendingCapacityTrim
      : null;
  const hasPendingCapacityTrim = Boolean(
    pendingCapacityTrim?.sideKey &&
      Array.isArray(pendingCapacityTrim?.pointClaims) &&
      pendingCapacityTrim.pointClaims.length >= 3,
  );
  const pendingStanceConfirmText =
    stepKey === 'step2' && !hasPendingProposal
      ? String(step2Payload?.pendingStanceConfirm?.text || '').trim()
      : '';
  const hasPendingStanceConfirm = Boolean(pendingStanceConfirmText);

  const lastAiHistoryIndex = (() => {
    for (let i = chatHistory.length - 1; i >= 0; i -= 1) {
      if (chatHistory[i]?.sender === 'ai') return i;
    }
    return -1;
  })();

  const lastAiText =
    lastAiHistoryIndex >= 0
      ? String(chatHistory[lastAiHistoryIndex]?.text || '')
      : '';
  // Hard rule: 采纳/拒绝 ONLY when this coach turn is proposing something to adopt.
  // Content asks (补薄 / 展开 / 自由答详略) never get those buttons — even if stale pending remains.
  const lastIsContentAsk = coachMessageIsContentAskNotDecision(lastAiText);
  const lastLooksSlotAdd =
    !lastIsContentAsk && coachMessageLooksLikeSlotAddDecision(lastAiText);
  const lastLooksRetention =
    !lastIsContentAsk && coachMessageLooksLikeRetentionDecision(lastAiText);
  const lastLooksCapacityTrim =
    !lastIsContentAsk && coachMessageLooksLikeCapacityTrimDecision(lastAiText);
  const lastLooksStance =
    !lastIsContentAsk && coachMessageLooksLikeStanceDecision(lastAiText);

  type RenderedChatMessage = ChatMessage & {
    isSplit: boolean;
    isPendingHost: boolean;
    isProposalHost: boolean;
    isSlotAddHost: boolean;
    isRetentionHost: boolean;
    isCapacityTrimHost: boolean;
    isStanceConfirmHost: boolean;
  };

  // Pending confirm / proposal / legacy: keep the latest Coach turn as ONE bubble.
  const renderedMessages: RenderedChatMessage[] = chatHistory.flatMap(
    (msg, historyIndex): RenderedChatMessage[] => {
      if (msg.sender === 'ai') {
        const isPendingHost =
          hasPendingConfirm && historyIndex === lastAiHistoryIndex;
        // Phase1: trust pendingProposal on latest AI turn (text is display-only).
        // 产品约束：Step2 强制按钮白名单 = side_settle（每侧详略）+ stance（立场）。
        // slot_add / slot_merge 走对话内确认（无按钮）——学生可直接打字「可以/采纳」
        // 或说出自己的方案，由 resolvePendingProposalDecision 的文本路径处理。
        const isProposalHost =
          hasPendingProposal &&
          !hasPendingConfirm &&
          historyIndex === lastAiHistoryIndex &&
          (pendingProposalKind === 'side_settle' ||
            pendingProposalKind === 'stance');
        const isSlotAddHost =
          !isProposalHost &&
          hasPendingSlotAdd &&
          lastLooksSlotAdd &&
          !hasPendingConfirm &&
          !lastLooksRetention &&
          !lastLooksCapacityTrim &&
          !lastLooksStance &&
          historyIndex === lastAiHistoryIndex;
        const isRetentionHost =
          !isProposalHost &&
          hasPendingRetention &&
          lastLooksRetention &&
          !hasPendingConfirm &&
          !lastLooksSlotAdd &&
          !lastLooksCapacityTrim &&
          !lastLooksStance &&
          historyIndex === lastAiHistoryIndex;
        const isCapacityTrimHost =
          !isProposalHost &&
          hasPendingCapacityTrim &&
          lastLooksCapacityTrim &&
          !hasPendingConfirm &&
          !lastLooksSlotAdd &&
          !lastLooksRetention &&
          !lastLooksStance &&
          historyIndex === lastAiHistoryIndex;
        const isStanceConfirmHost =
          !isProposalHost &&
          hasPendingStanceConfirm &&
          !hasPendingConfirm &&
          !lastLooksSlotAdd &&
          !lastLooksRetention &&
          !lastLooksCapacityTrim &&
          historyIndex === lastAiHistoryIndex &&
          (lastLooksStance ||
            /请点击「采纳」|点击「采纳」锁定|基于你材料的立场推荐/.test(
              lastAiText,
            ));
        if (
          isPendingHost ||
          isProposalHost ||
          isSlotAddHost ||
          isRetentionHost ||
          isCapacityTrimHost ||
          isStanceConfirmHost
        ) {
          const joined = String(msg.text || '')
            .split('---')
            .map((part) => part.trim())
            .filter(Boolean)
            .join('\n\n');
          return [
            {
              ...msg,
              text: joined,
              id: `${msg.id}-pending`,
              isSplit: false,
              isPendingHost,
              isProposalHost,
              isSlotAddHost,
              isRetentionHost,
              isCapacityTrimHost,
              isStanceConfirmHost,
            },
          ];
        }
        return msg.text.split('---').map((part, i) => ({
          ...msg,
          text: part.trim(),
          id: `${msg.id}-${i}`,
          isSplit: i > 0,
          isPendingHost: false,
          isProposalHost: false,
          isSlotAddHost: false,
          isRetentionHost: false,
          isCapacityTrimHost: false,
          isStanceConfirmHost: false,
        }));
      }
      return [
        {
          ...msg,
          isSplit: false,
          isPendingHost: false,
          isProposalHost: false,
          isSlotAddHost: false,
          isRetentionHost: false,
          isCapacityTrimHost: false,
          isStanceConfirmHost: false,
        },
      ];
    },
  );

  const beginEditPendingDraft = (d: any) => {
    // Prefill the current confirm sentence so students edit 待确认句, not a blank label.
    const label = String(d.label || '当前一环').trim();
    const text = String(d.text || '').trim();
    setInputText(text ? `${label}：${text}` : `${label}：`);
    inputRef.current?.focus();
  };

  /** Render-only: let **bold** work when markers wrap CJK quotation marks. */
  const prepareCoachMarkdown = (text: string) =>
    String(text || '')
      .replace(/\\n/g, '\n')
      .replace(
        /\*\*([“‘「『])([\s\S]+?)([”’」』])\*\*/g,
        (_m, open, inner, close) => `${open}**${inner}**${close}`,
      );

  /** Render coach text with pending polished sentences as click-to-edit targets. */
  const renderPendingHostText = (rawText: string) => {
    const raw = prepareCoachMarkdown(rawText);
    type Hit = { start: number; end: number; draft: any };
    const hits: Hit[] = [];
    for (const d of pendingDrafts) {
      const t = String(d?.text || '').trim();
      if (t.length < 4) continue;
      const variants = [
        t,
        `「${t}」`,
        `"${t}"`,
        `'${t}'`,
        `**${t}**`,
        `**「${t}」**`,
        `**“${t}”**`,
      ];
      for (const v of variants) {
        let from = 0;
        while (from <= raw.length - v.length) {
          const idx = raw.indexOf(v, from);
          if (idx < 0) break;
          const end = idx + v.length;
          if (!hits.some((h) => idx < h.end && end > h.start)) {
            hits.push({ start: idx, end, draft: d });
          }
          from = end;
        }
      }
    }
    hits.sort((a, b) => a.start - b.start);

    if (hits.length === 0) {
      // Fallback: still show pending as the only editable confirm target (never
      // invent a second sentence from chat). Server keeps pending = 待确认句.
      return (
        <>
          <div className="markdown-body text-xs md:text-[12.5px] text-slate-800">
            <ReactMarkdown>{raw}</ReactMarkdown>
          </div>
          <div className="mt-2 space-y-1.5">
            {pendingDrafts.map((d: any) => (
              <button
                key={String(d.key || d.label || d.text)}
                type="button"
                disabled={loading}
                onClick={() => beginEditPendingDraft(d)}
                className="block w-full text-left rounded-md bg-amber-50/80 border border-amber-200/70 px-2 py-1.5 text-[12px] leading-relaxed text-slate-800 hover:bg-amber-50 transition disabled:opacity-50"
                title="点击修改当前待确认句"
              >
                {d.text}
                <Pencil className="inline-block h-3 w-3 ml-1 text-slate-400 align-[-1px]" />
              </button>
            ))}
          </div>
        </>
      );
    }

    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    hits.forEach((h, i) => {
      if (h.start > cursor) {
        nodes.push(
          <div
            key={`pre-${i}`}
            className="markdown-body text-xs md:text-[12.5px] text-slate-800"
          >
            <ReactMarkdown>{raw.slice(cursor, h.start)}</ReactMarkdown>
          </div>,
        );
      }
      nodes.push(
        <button
          key={`pend-${i}-${h.start}`}
          type="button"
          disabled={loading}
          onClick={() => beginEditPendingDraft(h.draft)}
          className="inline text-left rounded px-0.5 bg-amber-50 border-b border-dashed border-amber-400 text-slate-900 hover:bg-amber-100/80 transition disabled:opacity-50"
          title="点击修改"
        >
          {raw.slice(h.start, h.end)}
          <Pencil className="inline-block h-3 w-3 ml-0.5 text-slate-400 align-[-1px]" />
        </button>,
      );
      cursor = h.end;
    });
    if (cursor < raw.length) {
      nodes.push(
        <div
          key="post"
          className="markdown-body text-xs md:text-[12.5px] text-slate-800"
        >
          <ReactMarkdown>{raw.slice(cursor)}</ReactMarkdown>
        </div>,
      );
    }
    return (
      <div className="text-xs md:text-[12.5px] text-slate-800 leading-relaxed">
        {nodes}
      </div>
    );
  };

  useEffect(() => {
    if (stepKey !== 'step3') return;
    if (migratedLegacyStep3HistoryRef.current) return;

    const legacyHistory = Array.isArray(session.step3?.chatHistory)
      ? session.step3.chatHistory
      : [];
    if (legacyHistory.length === 0) {
      migratedLegacyStep3HistoryRef.current = true;
      return;
    }

    const activeId = session.step3?.activeSubpointId;
    const subpoints = Array.isArray(session.step3?.subpoints)
      ? session.step3.subpoints
      : [];
    if (!activeId || subpoints.length === 0) return;

    const activeSubpoint = subpoints.find((sp) => sp.id === activeId);
    if (
      activeSubpoint &&
      Array.isArray(activeSubpoint.chatHistory) &&
      activeSubpoint.chatHistory.length > 0
    ) {
      migratedLegacyStep3HistoryRef.current = true;
      return;
    }

    const migratedSubpoints = subpoints.map((sp) =>
      sp.id === activeId ? { ...sp, chatHistory: legacyHistory } : sp,
    );

    onUpdateSession({
      step3: {
        ...session.step3,
        subpoints: migratedSubpoints,
        chatHistory: [],
      },
    });
    migratedLegacyStep3HistoryRef.current = true;
  }, [
    onUpdateSession,
    session.step3,
    stepKey,
  ]);

  useEffect(() => {
    setShowResetConfirm(false); // Reset confirmation state on step change
    kickoffRef.current = null;
    // When autoKickoff is on (step2/step3), the LLM-generated opener is the first
    // message; do NOT seed a templated welcome bubble (it duplicates the opener).
    if (chatHistory.length === 0 && !autoKickoff) {
      const initialMessage: ChatMessage = {
        id: `msg-welcome-${Date.now()}`,
        sender: 'ai',
        text: welcomeMessage,
        timestamp: new Date().toISOString(),
      };
      
      onUpdateSession({
        [stepKey]: {
          ...session[stepKey],
          chatHistory: [initialMessage],
        },
      });
    }
  }, [stepKey]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, loading, children]);

  const buildDraftFromParagraphPlan = (plan: any) => {
    if (!plan || !Array.isArray(plan.pointBlocks)) return '';

    const parts: string[] = [];
    if (plan.totalClaim && String(plan.totalClaim).trim()) {
      parts.push(`【总观点】\n${plan.totalClaim}`);
    }

    for (const block of plan.pointBlocks) {
      const blockParts: string[] = [];
      if (block.subClaim) {
        blockParts.push(`【${block.label || '分点'}】\n${block.subClaim}`);
      }
      if (Array.isArray(block.steps)) {
        for (const step of block.steps) {
          if (step.value) {
            blockParts.push(`【${step.label}】\n${step.value}`);
          }
        }
      }
      if (blockParts.length > 0) {
        parts.push(blockParts.join('\n\n'));
      }
    }

    if (plan.optionalShortClosing && String(plan.optionalShortClosing).trim()) {
      parts.push(`【简短收束】\n${plan.optionalShortClosing}`);
    }

    return parts.join('\n\n');
  };

  const sendUserMessage = async (
    textToSend: string,
    options?: {
      hiddenUserMessage?: boolean;
      targetSubpointId?: string;
      decision?: {
        type: string;
        action: string;
        claim?: string;
        proposalId?: string;
        legacyType?: string;
      };
    },
  ) => {
    if (!textToSend.trim() || loading) return;

    setErrorMsg('');

    const newUserMessage: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      sender: 'user',
      text: textToSend.trim(),
      timestamp: new Date().toISOString(),
    };

    const hiddenUserMessage = !!options?.hiddenUserMessage;
    const decision = options?.decision;
    const activeSubpointIdAtSend =
      stepKey === 'step3'
        ? options?.targetSubpointId || session.step3?.activeSubpointId
        : undefined;
    if (stepKey === 'step3' && !activeSubpointIdAtSend) {
      setErrorMsg('请先选择一个主体段落，再继续对话。');
      return;
    }
    const promptHistory = [...chatHistory, newUserMessage];
    const updatedHistory = hiddenUserMessage
      ? [...chatHistory]
      : [...chatHistory, newUserMessage];

    // Optimistically update UI (skip the synthetic kickoff user bubble)
    if (!hiddenUserMessage) {
      if (stepKey === 'step3' && activeSubpointIdAtSend) {
        onUpdateSession((prev) => {
          const step3 = prev.step3 || session.step3;
          const nextSubpoints = (step3.subpoints || []).map((sp: any) =>
            sp.id === activeSubpointIdAtSend
              ? { ...sp, chatHistory: updatedHistory }
              : sp,
          );
          return {
            step3: {
              ...step3,
              subpoints: nextSubpoints,
            },
          };
        });
      } else {
        onUpdateSession({
          [stepKey]: {
            ...session[stepKey],
            chatHistory: updatedHistory,
          },
        });
      }
    }

    // Supersede any in-flight coach turn (reset / double-send safety).
    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const reqId = ++requestSeqRef.current;
    setLoading(true);

    try {
      const sessionForRequest =
        stepKey === 'step3' && activeSubpointIdAtSend
          ? {
              ...session,
              step3: {
                ...session.step3,
                activeSubpointId: activeSubpointIdAtSend,
                subpoints: (session.step3.subpoints || []).map((sp: any) =>
                  sp.id === activeSubpointIdAtSend
                    ? { ...sp, chatHistory: updatedHistory }
                    : sp,
                ),
              },
            }
          : session;

      const res = await fetch('/api/coach/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          question: topic.question,
          step,
          messages: promptHistory,
          stepContext,
          session: sessionForRequest,
          userMessage: textToSend.trim(),
          // Hidden openers (Step2/Step3 kickoff) are system prompts — never student material.
          ...(hiddenUserMessage ? { isHiddenKickoff: true } : {}),
          ...(decision ? { decision } : {}),
        }),
      });

      if (reqId !== requestSeqRef.current) return;

      const data = await res.json();
      if (!res.ok || data.error) {
        setErrorMsg(data.error || 'AI Coach 暂无回应，请检查 API 密钥。');
        return;
      }

      if (reqId !== requestSeqRef.current) return;

      const newAiMessage: ChatMessage = {
        id: `msg-ai-${Date.now()}`,
        sender: 'ai',
        text: data.text,
        timestamp: new Date().toISOString(),
      };

      let sessionUpdates: any = {};
      if (data.progressUpdate) {
        // Real-time synchronization of step1Data, step2Data, and step3Data as the student chats
        if (stepKey === 'step1' && data.progressUpdate.step1Data) {
          const boardOverrides = session.step1.boardOverrides || {};
          sessionUpdates.step1 = {
            ...session.step1,
            userAnalysisNotes: (() => {
              const prevNotes = session.step1.userAnalysisNotes || '';
              const newMsg = textToSend.trim();
              if (!prevNotes) return newMsg;
              if (prevNotes.includes(newMsg)) return prevNotes;
              if (newMsg.length < 5 || /^(对|是|是的|对的|好的|嗯|明白|好的好的|是的是的|ok|okay|yes)$/i.test(newMsg)) {
                return prevNotes;
              }
              return `${prevNotes} | ${newMsg}`;
            })(),
            coachEvaluation: {
              ...(session.step1.coachEvaluation || {}),
              ...data.progressUpdate.step1Data,
              ...boardOverrides,
            },
            // Honor explicit false from server (premature-completion guard).
            isCompleted:
              data.progressUpdate.isCompleted === false
                ? false
                : Boolean(data.progressUpdate.isCompleted || session.step1.isCompleted),
          };
        } else if (stepKey === 'step2' && data.progressUpdate.step2Data) {
          sessionUpdates.step2 = {
            ...session.step2,
            userStance: data.progressUpdate.step2Data.userStance || session.step2.userStance || '',
            userPoints: data.progressUpdate.step2Data.userPoints || session.step2.userPoints || '',
            selectedThesis: data.progressUpdate.step2Data.suggestedStance || session.step2.selectedThesis || '',
            coachEvaluation: {
              ...(session.step2.coachEvaluation || {}),
              ...data.progressUpdate.step2Data,
            },
            isCompleted:
              data.progressUpdate.isCompleted === false
                ? false
                : Boolean(data.progressUpdate.isCompleted || session.step2.isCompleted),
          };
        } else if (stepKey === 'step3' && data.progressUpdate.step3Data) {
          sessionUpdates.step3 = {
            ...session.step3,
            userDraft: data.progressUpdate.step3Data.userDraft || session.step3.userDraft,
            // Never OR-in a stale true; server false must win.
            isCompleted:
              data.progressUpdate.isCompleted === false
                ? false
                : Boolean(data.progressUpdate.isCompleted || session.step3.isCompleted),
          };
        }

        if (data.progressUpdate.isCompleted) {
          if (stepKey === 'step1') {
            const boardOverrides = session.step1.boardOverrides || {};
            const mergedEval = {
              ...(session.step1.coachEvaluation || {}),
              ...(data.progressUpdate.step1Data || {}),
              ...boardOverrides,
            };
            sessionUpdates.step1 = {
              ...session.step1,
              ...(sessionUpdates.step1 || {}),
              userAnalysisNotes: (() => {
                const prevNotes = sessionUpdates.step1?.userAnalysisNotes || session.step1.userAnalysisNotes || '';
                const newMsg = textToSend.trim();
                if (!prevNotes) return newMsg;
                if (prevNotes.includes(newMsg)) return prevNotes;
                if (newMsg.length < 5 || /^(对|是|是的|对的|好的|嗯|明白|好的好的|是的是的|ok|okay|yes)$/i.test(newMsg)) {
                  return prevNotes;
                }
                return `${prevNotes} | ${newMsg}`;
              })(),
              coachEvaluation: Object.keys(mergedEval).length > 0 ? mergedEval : session.step1.coachEvaluation,
              isCompleted: true,
            };
          } else if (stepKey === 'step2') {
            sessionUpdates.step2 = {
              ...session.step2,
              ...(sessionUpdates.step2 || {}),
              userStance: data.progressUpdate.step2Data?.userStance || session.step2.userStance || '',
              userPoints: data.progressUpdate.step2Data?.userPoints || session.step2.userPoints || '',
              selectedThesis: data.progressUpdate.step2Data?.suggestedStance || session.step2.selectedThesis || '',
              coachEvaluation: data.progressUpdate.step2Data || session.step2.coachEvaluation,
              isCompleted: true,
            };
          } else if (stepKey === 'step3') {
            sessionUpdates.step3 = {
              ...session.step3,
              ...(sessionUpdates.step3 || {}),
              userDraft: data.progressUpdate.step3Data?.userDraft || session.step3.userDraft,
              isCompleted: true,
            };
          }
        }
        
        // Step 3 is a dumb client projection: the server has already merged,
        // sanitized, gated and completed the board before returning progressUpdate.
        if (stepKey === 'step3') {
          const currentStep3 = sessionUpdates.step3 || session.step3;
          // 会议秘书新架构：服务器回传的 subpoints（含冻结 skeleton + minutes + activeSlotIndex）
          // 是权威状态，客户端只做 isCompleted/selectable 覆盖。无秘书字段时回退旧路径。
          const secretarySubpoints = Array.isArray(
            data.progressUpdate.step3SecretarySubpoints,
          )
            ? data.progressUpdate.step3SecretarySubpoints
            : null;
          const currentSubpoints = secretarySubpoints
            ? secretarySubpoints
            : currentStep3.subpoints || [];
          const activeId = activeSubpointIdAtSend || currentStep3.activeSubpointId || session.step3?.activeSubpointId;
          const step3Ui = data.progressUpdate.step3Ui;
          const uiById = new Map(
            (Array.isArray(step3Ui?.bodies) ? step3Ui.bodies : []).map(
              (body: any) => [String(body.id), body],
            ),
          );

          const updatedSubpoints = currentSubpoints.map((sp: any) => {
            const uiBody: any = uiById.get(String(sp.id));
            const updatedSp = {
              ...sp,
              ...(uiBody
                ? {
                    isCompleted: !!uiBody.isCompleted,
                    selectable: !!uiBody.selectable,
                  }
                : {}),
            };
            if (sp.id === activeId) {
              if (data.progressUpdate.currentSubpointHint) {
                updatedSp.hint = data.progressUpdate.currentSubpointHint;
              }
              if (data.progressUpdate.step3SubpointClaim) {
                updatedSp.claim = data.progressUpdate.step3SubpointClaim;
              }
              if (data.progressUpdate.step3SubpointReason) {
                updatedSp.reason = data.progressUpdate.step3SubpointReason;
              }
              if (data.progressUpdate.step3SubpointSupportType) {
                updatedSp.supportType = data.progressUpdate.step3SubpointSupportType;
              }
              if (data.progressUpdate.step3SubpointSupportContent) {
                updatedSp.supportContent = data.progressUpdate.step3SubpointSupportContent;
              }
              if (data.progressUpdate.step3SubpointImpact) {
                updatedSp.impact = data.progressUpdate.step3SubpointImpact;
              }
              if (data.progressUpdate.step3SubpointMechanism) {
                updatedSp.mechanism = data.progressUpdate.step3SubpointMechanism;
              }
              if (data.progressUpdate.step3SubpointResult) {
                updatedSp.result = data.progressUpdate.step3SubpointResult;
              }
              if (data.progressUpdate.paragraphPlan) {
                updatedSp.paragraphPlan = data.progressUpdate.paragraphPlan;
                // Sync body「论点」from confirmed claim-step (theme heads ignored)
                try {
                  const pendingMap = new Map<string, string>();
                  const drafts =
                    data.progressUpdate.step3KickoffPendingDrafts ||
                    updatedSp.kickoffPendingDrafts ||
                    [];
                  for (const d of drafts) {
                    const k = String(d?.key || "").trim();
                    const t = String(d?.text || "").trim();
                    if (k && t) pendingMap.set(k, t);
                  }
                  const blocks =
                    data.progressUpdate.paragraphPlan?.pointBlocks || [];
                  for (const block of blocks) {
                    const claim = resolveBlockClaimSentence(block, pendingMap);
                    if (claim && isClaimSentence(claim)) {
                      updatedSp.content = claim;
                      // Keep signature on theme/structure (not claim text)
                      updatedSp.frameworkSignature =
                        computeSubpointFrameworkSignature(
                          updatedSp,
                          session,
                        );
                      break;
                    }
                  }
                } catch {
                  /* keep prior content */
                }
              }
              if (
                Array.isArray(data.progressUpdate.step3SubpointSteps) &&
                data.progressUpdate.step3SubpointSteps.length > 0
              ) {
                updatedSp.structureSteps =
                  data.progressUpdate.step3SubpointSteps;
              }
              if (Array.isArray(data.progressUpdate.step3KickoffPendingDrafts)) {
                updatedSp.kickoffPendingDrafts =
                  data.progressUpdate.step3KickoffPendingDrafts;
              }
              if (typeof data.progressUpdate.step3LastRejectCode === "string") {
                updatedSp.lastRejectCode =
                  data.progressUpdate.step3LastRejectCode;
              }
              if (
                data.progressUpdate.step3SlotEval &&
                typeof data.progressUpdate.step3SlotEval === "object"
              ) {
                updatedSp.step3SlotEval = data.progressUpdate.step3SlotEval;
              }

              if (data.progressUpdate.step3SubpointCompletenessChecks) {
                updatedSp.completenessChecks = data.progressUpdate.step3SubpointCompletenessChecks;
              }
              if (data.progressUpdate.step3SubpointTransitionChecks) {
                updatedSp.transitionChecks = data.progressUpdate.step3SubpointTransitionChecks;
              }
              if (data.progressUpdate.step3SubpointSufficiencyCheck) {
                updatedSp.sufficiencyCheck = data.progressUpdate.step3SubpointSufficiencyCheck;
              }
              if (!uiBody && typeof data.progressUpdate.step3SubpointCompleted === 'boolean') {
                updatedSp.isCompleted =
                  !!data.progressUpdate.step3SubpointCompleted;
              }
            }
            return updatedSp;
          });

          // Construct the combined draft of the active subpoint. paragraphPlan is
          // authoritative for grouped multi-point claims; structureSteps and legacy
          // claim/reason/support/impact fields are fallbacks.
          const activeSp = updatedSubpoints.find((sp: any) => sp.id === activeId);
          let subpointDraft = activeSp?.draft || '';
          // 会议秘书新架构：从 skeleton + minutes 构建 draft（真相源），供 LLM 上下文使用。
          if (
            activeSp &&
            Array.isArray(activeSp.skeleton?.blocks) &&
            activeSp.skeleton.blocks.length > 0
          ) {
            const parts: string[] = [];
            for (const block of activeSp.skeleton.blocks) {
              if (!Array.isArray(block?.slots)) continue;
              for (const slot of block.slots) {
                const confirmed = (activeSp.minutes || []).find(
                  (m: any) => m.status === 'confirmed' && m.slotKey === slot.key,
                );
                const landed = (activeSp.minutes || []).find(
                  (m: any) => m.status === 'landed' && m.slotKey === slot.key,
                );
                const text = confirmed?.text || landed?.text || '';
                if (text) {
                  parts.push(`【${slot.label}】\n${text}`);
                }
              }
            }
            subpointDraft = parts.join('\n\n');
          } else if (activeSp && activeSp.paragraphPlan) {
            subpointDraft = buildDraftFromParagraphPlan(activeSp.paragraphPlan);
          } else if (activeSp && activeSp.structureSteps && activeSp.structureSteps.length > 0) {
            const parts = [];
            for (const step of activeSp.structureSteps) {
              if (step.value) {
                parts.push(`【${step.label}】\n${step.value}`);
              }
            }
            subpointDraft = parts.join('\n\n');
          } else if (activeSp && (activeSp.claim || activeSp.reason || activeSp.supportContent || activeSp.impact)) {
            const parts = [];
            if (activeSp.claim) parts.push(`【核心观点 (Claim)】\n${activeSp.claim}`);
            if (activeSp.reason) parts.push(`【理由展开 (Reason)】\n${activeSp.reason}`);
            if (activeSp.supportType && activeSp.supportContent) {
              const typeMap: Record<string, string> = {
                example: '举例 (Example)',
                mechanism: '机制 (Mechanism)',
                scenario: '场景 (Scenario)'
              };
              const typeStr = typeMap[activeSp.supportType.toLowerCase()] || activeSp.supportType;
              parts.push(`【支撑方式 - ${typeStr}】\n${activeSp.supportContent}`);
            }
            if (activeSp.impact) parts.push(`【推导结果 (Impact)】\n${activeSp.impact}`);
            subpointDraft = parts.join('\n\n');
          }

          const finalSubpoints = updatedSubpoints.map((sp: any) =>
            sp.id === activeId ? { ...sp, draft: subpointDraft } : sp,
          );

          sessionUpdates = {
            ...sessionUpdates,
            step3: {
              ...currentStep3,
              subpoints: finalSubpoints,
              activeSubpointId:
                step3Ui?.nextActiveSubpointId ||
                currentStep3.activeSubpointId ||
                activeId,
              isCompleted:
                typeof step3Ui?.isStep3Finished === 'boolean'
                  ? step3Ui.isStep3Finished
                  : !!data.progressUpdate.isCompleted,
              // P3（D5 后半）：结构重规划已确认 → 前端据此重跑 planner 并重建 Step3。
              structureReplanned:
                data.progressUpdate.step3StructureReplanned === true
                  ? true
                  : currentStep3.structureReplanned,
            }
          };
        }
      }

      const finalHistory = [...updatedHistory, newAiMessage];
      if (data.progressUpdate?.memory) {
        sessionUpdates = {
          ...sessionUpdates,
          memory: data.progressUpdate.memory,
        };
      }
      if (reqId !== requestSeqRef.current) return;

      if (stepKey === 'step3' && activeSubpointIdAtSend) {
        const step3State = sessionUpdates.step3 || session.step3;
        const nextSubpoints = (step3State.subpoints || []).map((sp: any) =>
          sp.id === activeSubpointIdAtSend
            ? { ...sp, chatHistory: finalHistory }
            : sp,
        );
        onUpdateSession({
          ...sessionUpdates,
          step3: {
            ...step3State,
            subpoints: nextSubpoints,
          },
        });
        return;
      }

      const nextStepKeyUpdate = {
        ...(sessionUpdates[stepKey] || session[stepKey]),
        chatHistory: finalHistory,
      };

      onUpdateSession({
        ...sessionUpdates,
        [stepKey]: nextStepKeyUpdate,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      console.error(err);
      if (reqId === requestSeqRef.current) {
        setErrorMsg('发送失败，请稍后重试。' + (err.message || ''));
      }
    } finally {
      if (reqId === requestSeqRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!autoKickoff || !kickoffPrompt.trim() || loading) return;
    // Step3: wait until a body is selected (avoids empty-key double kickoff).
    if (stepKey === 'step3' && !String(kickoffContextKey || '').trim()) return;
    // Fire the opener only when the step chat is still empty (no welcome bubble is
    // seeded for autoKickoff steps). Once any message exists, never re-fire.
    const hasAnyMessage = chatHistory.some(
      (m) => m.sender === 'ai' || m.sender === 'user',
    );
    if (hasAnyMessage) return;
    const kickoffKey = `${stepKey}:${kickoffContextKey}`;
    if (kickoffRef.current === kickoffKey) return;
    kickoffRef.current = kickoffKey;
    sendUserMessage(kickoffPrompt, { hiddenUserMessage: true });
  }, [
    autoKickoff,
    kickoffPrompt,
    loading,
    chatHistory,
    stepKey,
    kickoffContextKey,
  ]);

  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim() || loading) return;
    const text = inputText;
    setInputText('');
    await sendUserMessage(text);
  };

  // 暴露发送能力给父组件（Step3 秘书看板「确认写板」按钮）。
  useImperativeHandle(
    ref,
    () => ({
      sendUserMessage: (text, options) => {
        void sendUserMessage(text, options);
      },
      loading,
    }),
    [loading, chatHistory, session],
  );

  const handleResetChat = () => {
    // Cancel in-flight turn so a late response cannot restore old chat.
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    requestSeqRef.current += 1;
    setLoading(false);

    // autoKickoff steps (step2/step3) have no welcome bubble; clear to empty so the
    // opener effect regenerates the first message. Other steps keep the welcome.
    const initialHistory: ChatMessage[] = autoKickoff
      ? []
      : [
          {
            id: `msg-welcome-${Date.now()}`,
            sender: 'ai',
            text: welcomeMessage,
            timestamp: new Date().toISOString(),
          },
        ];

    if (stepKey === 'step3') {
      const activeId = session.step3?.activeSubpointId;
      const resetSubpoints = (session.step3?.subpoints || []).map((sp: any) =>
        sp.id === activeId
          ? {
              ...sp,
              chatHistory: initialHistory,
              kickoffPendingDrafts: [],
              step3SlotEval: undefined,
              lastRejectCode: '',
            }
          : sp,
      );
      onUpdateSession({
        step3: {
          ...session.step3,
          subpoints: resetSubpoints,
        },
      });
      kickoffRef.current = null;
      setErrorMsg('');
      setInputText('');
      setShowResetConfirm(false);
      return;
    }

    const updatedStepState: any = {
      ...session[stepKey],
      chatHistory: initialHistory,
      isCompleted: false,
      coachEvaluation: null,
    };

    if (stepKey === 'step1') {
      updatedStepState.userAnalysisNotes = '';
    } else if (stepKey === 'step2') {
      updatedStepState.userStance = '';
      updatedStepState.userPoints = '';
      updatedStepState.selectedThesis = '';
    }

    onUpdateSession({
      [stepKey]: updatedStepState,
    });
    kickoffRef.current = null;
    setErrorMsg('');
    setInputText('');
    setShowResetConfirm(false);
  };

  return (
    <div className="flex flex-col h-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Coach Header */}
      <div className="bg-slate-50 border-b border-slate-200 px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600">
            <MessageSquare className="h-4.5 w-4.5" />
          </div>
          <div>
            <h2 className="font-sans font-bold text-xs text-slate-800">IELTS AI Coach</h2>
            <p className="text-[10px] text-slate-500">雅思写作拆解式诊断专家（支持双语实时答疑）</p>
          </div>
        </div>
        {showResetConfirm ? (
          <div className="flex items-center gap-1.5 bg-rose-50 px-2 py-1 rounded border border-rose-100 shadow-sm">
            <span className="text-[10px] text-rose-700 font-sans font-medium">清空并重新对话？</span>
            <button
              type="button"
              onClick={handleResetChat}
              className="text-[10px] font-sans font-bold text-white bg-rose-500 hover:bg-rose-600 px-1.5 py-0.5 rounded transition"
            >
              是
            </button>
            <button
              type="button"
              onClick={() => setShowResetConfirm(false)}
              className="text-[10px] font-sans font-bold text-slate-500 bg-white hover:bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded transition"
            >
              否
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            className="inline-flex items-center gap-1 text-[10px] font-sans font-bold text-indigo-600 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-2 py-1 rounded transition border border-indigo-100/60 shadow-sm"
            title="重新开始本步对话 / Reset Step Dialogue"
          >
            <RotateCcw className="h-3 w-3" />
            <span>重新对话</span>
          </button>
        )}
      </div>

      {/* Chat Message History */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5 min-h-0">
        {renderedMessages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-2.5 items-start ${msg.sender === 'user' ? 'justify-end' : ''}`}
          >
            {msg.sender === 'ai' && !msg.isSplit && (
              <div className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-md bg-indigo-50 border border-indigo-100/80 text-indigo-600 font-sans text-[9px] font-bold shadow-2xs">
                Coach
              </div>
            )}
            {/* Add placeholder div for split bubbles to align with Coach icon */}
            {msg.sender === 'ai' && msg.isSplit && <div className="w-6.5 shrink-0" />}
            
            <div
              className={`rounded-xl px-3 py-1.5 max-w-[85%] font-sans text-xs md:text-[12.5px] leading-relaxed shadow-2xs transition-all ${
                msg.sender === 'user'
                  ? 'bg-indigo-600 text-white rounded-tr-none'
                  : 'bg-slate-50 border border-slate-200/50 text-slate-800 rounded-tl-none'
              }`}
            >
              {msg.sender === 'user' ? (
                <p className="whitespace-pre-wrap">{msg.text}</p>
              ) : (msg as any).isPendingHost ? (
                <div>
                  {renderPendingHostText(msg.text)}
                  <div className="mt-2.5">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => sendUserMessage('对')}
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white transition disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      确认
                    </button>
                  </div>
                </div>
              ) : (msg as any).isProposalHost ? (
                <div>
                  <div className="markdown-body text-xs md:text-[12.5px] text-slate-800">
                    <ReactMarkdown>{prepareCoachMarkdown(msg.text)}</ReactMarkdown>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={loading || inputDisabled}
                      onClick={() =>
                        sendUserMessage('采纳', {
                          decision: {
                            type: 'proposal',
                            action: 'accept',
                            proposalId: pendingProposal?.proposalId,
                            // legacy alias for older server mappers
                            ...(pendingProposalDecisionType
                              ? { legacyType: pendingProposalDecisionType }
                              : {}),
                          },
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white transition disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      采纳
                    </button>
                    <button
                      type="button"
                      disabled={loading || inputDisabled}
                      onClick={() =>
                        sendUserMessage('拒绝', {
                          decision: {
                            type: 'proposal',
                            action: 'reject',
                            proposalId: pendingProposal?.proposalId,
                          },
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white hover:bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-slate-700 transition disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                      拒绝
                    </button>
                  </div>
                  {pendingProposalSummary ? (
                    <p className="mt-1.5 text-[10px] text-slate-400">
                      {pendingProposalKind === 'slot_add'
                        ? `待决策：是否将「${pendingProposalSummary}」加入材料池`
                        : pendingProposalKind === 'slot_merge'
                          ? `待决策合并：${pendingProposalSummary}`
                          : pendingProposalKind === 'stance'
                            ? `待确认立场：${pendingProposalSummary}${
                                String(pendingProposal?.payload?.text || '')
                                  .length > 80
                                  ? '…'
                                  : ''
                              }`
                            : `待决策详略：${pendingProposalSummary}`}
                    </p>
                  ) : null}
                </div>
              ) : (msg as any).isSlotAddHost ? (
                <div>
                  <div className="markdown-body text-xs md:text-[12.5px] text-slate-800">
                    <ReactMarkdown>{prepareCoachMarkdown(msg.text)}</ReactMarkdown>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={loading || inputDisabled}
                      onClick={() =>
                        sendUserMessage('采纳', {
                          decision: { type: 'slot_add', action: 'accept' },
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white transition disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      采纳
                    </button>
                    <button
                      type="button"
                      disabled={loading || inputDisabled}
                      onClick={() =>
                        sendUserMessage('拒绝', {
                          decision: { type: 'slot_add', action: 'reject' },
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white hover:bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-slate-700 transition disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                      拒绝
                    </button>
                  </div>
                  {pendingSlotAddClaim ? (
                    <p className="mt-1.5 text-[10px] text-slate-400">
                      待决策：是否将「{pendingSlotAddClaim}」加入材料池
                    </p>
                  ) : null}
                </div>
              ) : (msg as any).isRetentionHost ? (
                <div>
                  <div className="markdown-body text-xs md:text-[12.5px] text-slate-800">
                    <ReactMarkdown>{prepareCoachMarkdown(msg.text)}</ReactMarkdown>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={loading || inputDisabled}
                      onClick={() =>
                        sendUserMessage('采纳', {
                          decision: { type: 'retention', action: 'accept' },
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white transition disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      采纳
                    </button>
                    <button
                      type="button"
                      disabled={loading || inputDisabled}
                      onClick={() =>
                        sendUserMessage('拒绝', {
                          decision: { type: 'retention', action: 'reject' },
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white hover:bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-slate-700 transition disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                      拒绝
                    </button>
                  </div>
                  {pendingRetentionSummary ? (
                    <p className="mt-1.5 text-[10px] text-slate-400">
                      待决策详略：{pendingRetentionSummary}
                    </p>
                  ) : null}
                </div>
              ) : (msg as any).isCapacityTrimHost ? (
                <div>
                  <div className="markdown-body text-xs md:text-[12.5px] text-slate-800">
                    <ReactMarkdown>{prepareCoachMarkdown(msg.text)}</ReactMarkdown>
                  </div>
                  <div className="mt-2.5 space-y-2">
                    {(pendingCapacityTrim?.pointClaims || []).map(
                      (claim: string) => (
                        <div
                          key={claim}
                          className="flex flex-wrap items-center gap-1.5 rounded-md border border-slate-100 bg-white px-2 py-1.5"
                        >
                          <span className="text-[11px] text-slate-700 flex-1 min-w-[8rem]">
                            {claim}
                          </span>
                          <button
                            type="button"
                            disabled={loading || inputDisabled}
                            onClick={() =>
                              sendUserMessage(`略写「${claim}」`, {
                                decision: {
                                  type: 'capacity_trim',
                                  action: 'brief',
                                  claim,
                                },
                              })
                            }
                            className="rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-700 transition disabled:opacity-50"
                          >
                            略写此条
                          </button>
                          <button
                            type="button"
                            disabled={loading || inputDisabled}
                            onClick={() =>
                              sendUserMessage(`丢掉「${claim}」`, {
                                decision: {
                                  type: 'capacity_trim',
                                  action: 'drop',
                                  claim,
                                },
                              })
                            }
                            className="rounded-md border border-rose-100 bg-rose-50 hover:bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700 transition disabled:opacity-50"
                          >
                            丢掉
                          </button>
                        </div>
                      ),
                    )}
                    <button
                      type="button"
                      disabled={loading || inputDisabled}
                      onClick={() =>
                        sendUserMessage('全部保留', {
                          decision: {
                            type: 'capacity_trim',
                            action: 'keep_all',
                          },
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white transition disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      全部保留（不裁剪）
                    </button>
                  </div>
                  <p className="mt-1.5 text-[10px] text-slate-400">
                    单侧/单问已有 {pendingCapacityTrim?.pointClaims?.length || 0}{' '}
                    条 —— 确认后再改板
                  </p>
                </div>
              ) : (msg as any).isStanceConfirmHost ? (
                <div>
                  <div className="markdown-body text-xs md:text-[12.5px] text-slate-800">
                    <ReactMarkdown>{prepareCoachMarkdown(msg.text)}</ReactMarkdown>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={loading || inputDisabled}
                      onClick={() =>
                        sendUserMessage('采纳', {
                          decision: { type: 'stance', action: 'accept' },
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white transition disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      采纳
                    </button>
                    <button
                      type="button"
                      disabled={loading || inputDisabled}
                      onClick={() =>
                        sendUserMessage('拒绝', {
                          decision: { type: 'stance', action: 'reject' },
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white hover:bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-slate-700 transition disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                      拒绝
                    </button>
                  </div>
                  {pendingStanceConfirmText ? (
                    <p className="mt-1.5 text-[10px] text-slate-400">
                      待确认立场：{pendingStanceConfirmText.slice(0, 80)}
                      {pendingStanceConfirmText.length > 80 ? '…' : ''}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="markdown-body text-xs md:text-[12.5px] text-slate-800">
                  <ReactMarkdown>{prepareCoachMarkdown(msg.text)}</ReactMarkdown>
                  {/* Step1 Q1: question-type chips → fill input (mutually exclusive) */}
                  {msg.sender === 'ai' &&
                    stepKey === 'step1' &&
                    chatHistory[0] &&
                    msg.id.startsWith(chatHistory[0].id) &&
                    !chatHistory.some((m) => m.sender === 'user') && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {STEP1_QUESTION_TYPES.map((type) => (
                          <button
                            key={type}
                            type="button"
                            disabled={loading || inputDisabled}
                            onClick={() => sendUserMessage(type)}
                            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-indigo-200 hover:bg-indigo-50/70 disabled:opacity-50"
                          >
                            {type}
                          </button>
                        ))}
                      </div>
                    )}
                  {/* Add selection buttons if in step 3 */}
                  {msg.sender === 'ai' &&
                    stepKey === 'step3' &&
                    stepContext?.subpoints &&
                    stepContext.subpoints.length > 0 &&
                    !session?.step3?.activeSubpointId &&
                    chatHistory[0] &&
                    msg.id.startsWith(chatHistory[0].id) && (
                      <div className="mt-3 space-y-2">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">请选择要开始论证的分论点：</p>
                        {stepContext.subpoints.map((sp: any) => (
                          <button
                            key={sp.id}
                            onClick={() => {
                              onUpdateSession({
                                step3: {
                                  ...session.step3,
                                  activeSubpointId: sp.id,
                                  subpoints: stepContext.subpoints,
                                },
                              });
                              sendUserMessage(`我想先论证这个分论点：${sp.content}`, {
                                targetSubpointId: sp.id,
                              });
                            }}
                            className={`block w-full text-left p-3 rounded-lg text-xs border shadow-sm transition cursor-pointer animate-fade-in ${
                              session?.step3?.activeSubpointId === sp.id
                                ? 'bg-indigo-100 border-indigo-300 text-indigo-900 ring-1 ring-indigo-300'
                                : 'border-indigo-200 bg-white hover:bg-indigo-50 text-indigo-900'
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <div className="mt-0.5">
                                {session?.step3?.activeSubpointId === sp.id ? (
                                  <div className="w-3.5 h-3.5 rounded-full bg-indigo-500 flex items-center justify-center">
                                    <div className="w-1.5 h-1.5 rounded-full bg-white" />
                                  </div>
                                ) : (
                                  <div className="w-3.5 h-3.5 rounded-full border border-indigo-300" />
                                )}
                              </div>
                              <span className="flex-1">{sp.content}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                </div>
              )}
            </div>
            {msg.sender === 'user' && (
              <div className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-md bg-slate-100 border border-slate-200/80 text-slate-600 font-sans text-[9px] font-bold shadow-2xs">
                User
              </div>
            )}
          </div>
        ))}

        {/* Extra children nodes like diagnostics */}
        {children}

        {loading && (
          <div className="flex gap-2.5 items-start">
            <div className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-md bg-indigo-50 border border-indigo-100/80 text-indigo-600 font-sans text-[9px] font-bold shadow-2xs animate-pulse">
              Coach
            </div>
            <div className="bg-slate-50 border border-slate-200/50 rounded-xl rounded-tl-none px-3 py-1.5 max-w-[85%] flex items-center gap-2 font-sans text-xs text-slate-500 shadow-2xs">
              <Loader2 className="h-3 w-3 animate-spin text-indigo-600" />
              <span>Coach 正在思考中...</span>
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="bg-rose-50 border border-rose-100 rounded-lg p-2.5 text-rose-800 text-xs flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 text-rose-500 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Dynamic Chat Input Bar at the Bottom */}
      <form
        onSubmit={handleSendMessage}
        className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex gap-2 items-center shrink-0"
      >
        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          disabled={loading || inputDisabled}
          placeholder="向 AI Coach 提问，或讨论你的写作思路..."
          className="flex-1 min-w-0 bg-white border border-slate-200 rounded-lg px-3 py-1.5 font-sans text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={loading || !inputText.trim()}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 active:bg-indigo-800 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </button>
      </form>
    </div>
  );
});

export default CoachChat;
