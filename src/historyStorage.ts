/**
 * 对话历史存储 — localStorage 持久化
 *
 * 每个历史项包含完整 session 数据 + 元信息（题目、日期、进度）
 */

import type { PracticeSession } from './types';

const HISTORY_KEY = 'ielts_conversation_history';
const MAX_HISTORY = 20;

export interface ConversationHistoryItem {
  id: string;
  topicQuestion: string;
  topicType: string;
  currentStep: number;
  isCompleted: boolean;
  createdAt: string;
  updatedAt: string;
  session: PracticeSession;
}

/** 获取全部历史 */
export function getHistory(): ConversationHistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: any) => item?.id && item?.session?.topic?.question,
    );
  } catch {
    return [];
  }
}

/** 保存/更新一条历史记录 */
export function saveHistoryItem(session: PracticeSession): void {
  try {
    const history = getHistory();
    const existingIdx = history.findIndex((h) => h.id === session.id);

    const item: ConversationHistoryItem = {
      id: session.id,
      topicQuestion: String(session.topic.question || '').slice(0, 80),
      topicType: String(session.topic.questionType || ''),
      currentStep: session.currentStep,
      isCompleted: session.step4?.isCompleted || false,
      createdAt:
        history[existingIdx]?.createdAt ||
        new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      session,
    };

    if (existingIdx >= 0) {
      history[existingIdx] = item;
    } else {
      history.unshift(item);
    }

    // 限制最大条数
    const trimmed = history.slice(0, MAX_HISTORY);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.warn('[HistoryStorage] Failed to save history:', e);
  }
}

/** 删除一条历史记录 */
export function deleteHistoryItem(id: string): void {
  const history = getHistory().filter((h) => h.id !== id);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

/** 根据 ID 获取完整 session（用于恢复对话） */
export function getHistorySession(id: string): PracticeSession | null {
  const history = getHistory();
  const item = history.find((h) => h.id === id);
  return item?.session || null;
}

/** 导出单条对话为 Markdown */
export function exportHistoryAsMarkdown(item: ConversationHistoryItem): string {
  const session = item.session;
  const lines: string[] = [
    `# ${session.topic.question || '未知题目'}`,
    `- **题型**: ${session.topic.questionType || '未知'}`,
    `- **话题**: ${session.topic.topic || ''}`,
    `- **进度**: Step ${item.currentStep}/4`,
    `- **创建时间**: ${item.createdAt}`,
    `- **更新时间**: ${item.updatedAt}`,
    '',
    '---',
    '',
  ];

  for (const stepKey of ['step1', 'step2', 'step3', 'step4']) {
    const step = (session as any)[stepKey];
    if (!step) continue;

    const stepNum = stepKey.slice(-1);
    const titles: Record<string, string> = {
      '1': '审题分析',
      '2': '论点筹备',
      '3': '论证起草',
      '4': '逐句写作',
    };

    lines.push(`## Step ${stepNum}: ${titles[stepNum] || ''}`);
    lines.push('');

    // Step 3 需要从 subpoints 中取 chatHistory
    if (stepKey === 'step3' && Array.isArray(step.subpoints)) {
      for (const sp of step.subpoints) {
        if (Array.isArray(sp.chatHistory)) {
          lines.push(`### ${sp.targetBody || sp.theme || 'Body'}`);
          lines.push('');
          for (const msg of sp.chatHistory) {
            const role = msg.sender === 'ai' ? '**Coach**' : '**User**';
            lines.push(`${role}: ${msg.text}`);
            lines.push('');
          }
        }
      }
    }

    // 各 step 的 chatHistory
    if (Array.isArray(step.chatHistory)) {
      for (const msg of step.chatHistory) {
        const role = msg.sender === 'ai' ? '**Coach**' : '**User**';
        lines.push(`${role}: ${msg.text}`);
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/** 判断当前是否为 debug 模式 */
export function isDebugMode(): boolean {
  // Vite 暴露 import.meta.env.MODE，开发模式为 'development'
  try {
    return (import.meta as any).env?.DEV === true;
  } catch {
    return false;
  }
}
