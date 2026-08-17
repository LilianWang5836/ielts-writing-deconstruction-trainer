/**
 * LLM token 用量累计（进程内存级，小功能）。
 * 两个提供商通道的 usage 形状在这里归一：
 *  - openai-compatible（DeepSeek 等）：{ prompt_tokens, completion_tokens, prompt_cache_hit_tokens?, prompt_cache_miss_tokens? }
 *  - Gemini：{ promptTokenCount, candidatesTokenCount, cachedContentTokenCount? }
 * 缓存命中字段 API 返回时才计入（DeepSeek 的 context caching / Gemini 的 cached content）。
 */

export interface TokenUsageBucket {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** 输入缓存命中 token 数（API 返回时才有，DeepSeek: prompt_cache_hit_tokens / Gemini: cachedContentTokenCount）。 */
  cachedInputTokens: number;
}

export interface TokenUsageSnapshot extends TokenUsageBucket {
  byProvider: Record<string, TokenUsageBucket>;
  since: string;
}

const total: TokenUsageBucket = { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
const byProvider: Record<string, TokenUsageBucket> = {};
const startedAt = new Date().toISOString();

function bucket(provider: string): TokenUsageBucket {
  if (!byProvider[provider]) {
    byProvider[provider] = { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  }
  return byProvider[provider];
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 记录一次 LLM 调用的用量。raw 为提供商原始 usage 对象（两种形状均可），
 * 缺字段时按 0 计。返回本次归一化结果（供日志打印）。
 */
export function recordTokenUsage(
  provider: string,
  model: string,
  raw: any,
): { input: number; output: number; cachedInput: number } {
  const input = num(raw?.prompt_tokens ?? raw?.promptTokenCount);
  const output = num(raw?.completion_tokens ?? raw?.candidatesTokenCount);
  const cachedInput = num(
    raw?.prompt_cache_hit_tokens ?? raw?.cachedContentTokenCount,
  );
  for (const b of [total, bucket(provider)]) {
    b.calls += 1;
    b.inputTokens += input;
    b.outputTokens += output;
    b.cachedInputTokens += cachedInput;
  }
  console.warn(
    `[LLM] tokens ${provider}/${model}: in=${input} out=${output}` +
      (cachedInput > 0 ? ` cacheHit=${cachedInput}` : '') +
      `（累计 入${total.inputTokens} 出${total.outputTokens}）`,
  );
  return { input, output, cachedInput };
}

export function getTokenUsageSnapshot(): TokenUsageSnapshot {
  return {
    ...total,
    byProvider: JSON.parse(JSON.stringify(byProvider)),
    since: startedAt,
  };
}
