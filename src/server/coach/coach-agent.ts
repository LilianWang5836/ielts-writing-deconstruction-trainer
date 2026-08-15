/**
 * Coach Agent — 自然语言对话生成
 *
 * 职责：
 * 1. 接收当前 step + 对话历史 + session 上下文
 * 2. 返回自然语言对话文本（Markdown 格式）
 *
 * 不输出任何结构化状态（状态变更由 intent-agent 负责）
 */

import type { CoachOutput } from '../../types';

/**
 * 构建 Coach Agent 的 LLM prompt
 */
export function buildCoachPrompt(
  step: number,
  question: string,
  history: { sender: string; text: string }[],
  userMessage: string,
): string {
  const historyText = history
    .slice(-10)
    .map((m) => `${m.sender === 'user' ? 'Student' : 'Coach'}: ${m.text}`)
    .join('\n');

  const stepGuides: Record<number, string> = {
    1: `你是 IELTS AI Coach，正在帮学生做 Step 1 审题分析。
你的任务：用苏格拉底式提问引导学生识别题型、提取核心议题、找出关键限定词。
规则：
- 一次只问一个问题
- 不要直接给出答案
- 用中文对话
- 不要输出 JSON 或结构化数据`,

    2: `你是 IELTS AI Coach，正在帮学生做 Step 2 立场与论点。
你的任务：引导学生平行展开可写论点，明确立场；段落结构交给后续 Planner。
规则：
- 阶段：explore_A（主展开）→ explore_B（仅补齐缺失材料类别，无缺口则跳过）→ stance → summary
- 硬规则：explore 未完成前禁止进入 stance、禁止宣布已选立场
- Agree/Disagree 完全同意时不要强制挖对立面
- 一次只问一个问题
- 不要输出 JSON 或结构化数据`,

    3: `你是 IELTS AI Coach，正在帮学生做 Step 3 段落论证起草。
你的任务：引导学生逐槽填充逻辑链（claim → reason → example → impact）。
规则：
- 对准第一个空槽提问
- 学生回答后先确认，再推进到下一个槽
- 不要一次要求确认所有步骤
- 不要输出 JSON 或结构化数据`,

    4: `你是 IELTS AI Coach，正在帮学生做 Step 4 逐句练习。
你的任务：帮助学生将论证链升级为学术句式。
规则：
- 针对具体句子给出词汇/语法/句式建议
- 不要输出 JSON 或结构化数据`,
  };

  const stepGuide = stepGuides[step] || stepGuides[1];

  return `${stepGuide}

【题目】
${question}

【当前步骤】Step ${step}

【对话历史】
${historyText || '（新对话）'}

【学生最新消息】
${userMessage}

请以自然的中文回复学生，只输出对话文本（可以包含 Markdown 格式，但不要包含 JSON）。`;
}

/**
 * 构建 Coach Agent 的 LLM 请求
 */
export function buildCoachRequest(
  step: number,
  question: string,
  history: { sender: string; text: string }[],
  userMessage: string,
) {
  const prompt = buildCoachPrompt(step, question, history, userMessage);
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      temperature: 0.7,
      maxOutputTokens: 2048,
    },
  };
}

/**
 * 解析 Coach Agent 的响应
 */
export function parseCoachResponse(rawText: string): CoachOutput {
  return { text: rawText.trim() };
}
