/**
 * Intent Agent — 结构化状态变更提取
 *
 * 职责：
 * 1. 从对话中识别用户意图
 * 2. 输出结构化状态变更（stageTransition / slotUpdates / adaptations / completionFlag）
 *
 * 使用低 temperature + Gemini response_schema 确保输出精度
 */

import type { IntentOutput } from '../../types';

/**
 * 构建 Intent Agent 的 LLM prompt
 */
export function buildIntentPrompt(
  step: number,
  question: string,
  history: { sender: string; text: string }[],
  userMessage: string,
  sessionSummary: string,
): string {
  const historyText = history
    .slice(-10)
    .map((m) => `${m.sender === 'user' ? 'Student' : 'Coach'}: ${m.text}`)
    .join('\n');

  const prompt = `你是一个意图识别 Agent，负责从对话中提取学生的意图并输出结构化的状态变更。

【题目】${question}
【当前步骤】Step ${step}

【当前 Session 状态】
${sessionSummary}

【对话历史】
${historyText}

【学生最新消息】
${userMessage}

【你的任务】
分析学生的消息，判断需要做哪些状态变更，输出严格 JSON。

【输出格式】
{
  "stageTransition": { "from": "...", "to": "...", "reason": "..." } | null,
  "slotUpdates": [
    { "key": "step_key", "action": "draft"|"confirm"|"reject", "value": "学生文本", "rejectReason": "原因(仅reject时)" }
  ],
  "adaptations": [
    { "op": "reclass"|"merge"|"add"|"skip", "key": "...", "newLabel": "..." }
  ],
  "structureChangeOffer": { "kind": "body_argument_change", "summary": "...", "awaitConfirm": true } | null,
  "completionFlag": { "isCompleted": true|false, "reason": "..." } | null,
  "dimensionUpdates": [
    { "label": "维度名", "status": "probed"|"expandable"|"thin"|"quality_pending" }
  ]
}

【规则】
- 只输出 JSON，不要输出任何其他文本
- stageTransition 仅在步骤确实需要切换时输出
- slotUpdates 仅在 Step 3 中使用（其他 step 为空数组）
- 不要修改 status 为 "confirmed" 的槽位
- completionFlag 仅在步骤确实完成时输出`;

  return prompt;
}

/**
 * 构建 Intent Agent 的 LLM 请求
 */
export function buildIntentRequest(
  step: number,
  question: string,
  history: { sender: string; text: string }[],
  userMessage: string,
  sessionSummary: string,
) {
  const prompt = buildIntentPrompt(step, question, history, userMessage, sessionSummary);
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    },
  };
}

/**
 * 解析 Intent Agent 的响应
 */
export function parseIntentResponse(rawText: string): IntentOutput | null {
  try {
    let text = rawText.trim();
    if (text.startsWith('```json')) {
      text = text.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    }
    return JSON.parse(text) as IntentOutput;
  } catch {
    return null;
  }
}
