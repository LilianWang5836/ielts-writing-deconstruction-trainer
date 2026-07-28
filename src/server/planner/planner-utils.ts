/**
 * Planner 工具函数
 */

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
    return defaultData;
  }
}
