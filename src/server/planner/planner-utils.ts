/**
 * Planner 工具函数
 */

import { jsonrepair } from 'jsonrepair';

/**
 * 从 LLM 响应文本中提取 JSON
 * 复用项目中已有的 parseAIResponse 模式
 */
export function parseAIResponse(text: string | undefined, defaultData: any = {}): any {
  if (!text) return defaultData;
  let responseText = text.trim();
  if (responseText.startsWith('```json')) {
    responseText = responseText
      .replace(/^```json\n?/, '')
      .replace(/\n?```$/, '');
  }
  try {
    return JSON.parse(responseText);
  } catch {
    // jsonrepair 能修复截断/尾逗号/缺引号等常见 LLM JSON 问题
    try {
      const repaired = jsonrepair(responseText);
      return JSON.parse(repaired);
    } catch {
      return defaultData;
    }
  }
}
