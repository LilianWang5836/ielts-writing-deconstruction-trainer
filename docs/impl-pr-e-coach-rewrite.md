# PR-E：Coach Agent + Intent Agent 拆分

> 目标 PR | 依赖：PR-D | 预计行数：~400 | 执行时间：30-45 分钟

---

## E.1 概述

将当前单体 LLM 调用（一次调用同时输出对话 + 结构化 JSON）拆分为两个独立 Agent：

1. **Coach Agent**：只输出自然语言对话（`CoachOutput`）
2. **Intent Agent**：只输出结构化状态变更（`IntentOutput`）

**实现策略：**
- 在 `server.ts` 的主对话路由（`/api/coach/chat`）中，将原本的单次 LLM 调用改为两次并行调用
- 两次调用共享同一个对话历史上下文
- Coach Agent 的响应直接返回给用户
- Intent Agent 的响应用于更新 session 状态

---

## E.2 实现 `src/server/coach/coach-agent.ts`

```typescript
/**
 * Coach Agent — 自然语言对话生成
 */

import type { CoachOutput } from '../../types';
import type { PracticeSession, ChatMessage } from '../../types';

/**
 * 构建 Coach Agent 的 LLM prompt
 */
export function buildCoachPrompt(
  step: number,
  question: string,
  history: ChatMessage[],
  session: PracticeSession,
  userMessage: string,
): string {
  const historyText = history
    .slice(-10)
    .map((m) => `${m.sender === 'user' ? 'Student' : 'Coach'}: ${m.text}`)
    .join('\n');

  // 根据 step 选择不同的系统指令
  const stepGuides: Record<number, string> = {
    1: `你是 IELTS AI Coach，正在帮学生做 Step 1 审题分析。
你的任务：用苏格拉底式提问引导学生识别题型、提取核心议题、找出关键限定词。
规则：
- 一次只问一个问题
- 不要直接给出答案
- 用中文对话
- 不要输出 JSON 或结构化数据`,

    2: `你是 IELTS AI Coach，正在帮学生做 Step 2 立场与论点。
你的任务：引导学生探索 A面/B面论据，明确立场，形成写作蓝图。
规则：
- 按 explore_A → explore_B → stance → summary 阶段推进
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
  history: ChatMessage[],
  session: PracticeSession,
  userMessage: string,
) {
  const prompt = buildCoachPrompt(step, question, history, session, userMessage);
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
```

---

## E.3 实现 `src/server/coach/intent-agent.ts`

```typescript
/**
 * Intent Agent — 结构化状态变更提取
 */

import type { IntentOutput } from '../../types';
import type { PracticeSession, ChatMessage } from '../../types';

/**
 * 构建 Intent Agent 的 LLM prompt + response_schema
 */
export function buildIntentRequest(
  step: number,
  question: string,
  history: ChatMessage[],
  session: PracticeSession,
  userMessage: string,
) {
  const historyText = history
    .slice(-10)
    .map((m) => `${m.sender === 'user' ? 'Student' : 'Coach'}: ${m.text}`)
    .join('\n');

  const sessionSummary = JSON.stringify({
    step1: session.step1 ? {
      correctType: session.step1.coachEvaluation?.correctType,
      coreIssue: session.step1.coachEvaluation?.coreIssue,
      constraints: session.step1.coachEvaluation?.constraints,
      isCompleted: session.step1.isCompleted,
    } : null,
    step2: session.step2 ? {
      currentStage: session.step2.coachEvaluation?.currentStage,
      userStance: session.step2.userStance,
      userPoints: session.step2.userPoints,
      isCompleted: session.step2.isCompleted,
    } : null,
    step3: session.step3 ? {
      activeSubpointId: session.step3.activeSubpointId,
      subpoints: session.step3.subpoints?.map((sp: any) => ({
        id: sp.id,
        isCompleted: sp.isCompleted,
        planSteps: sp.paragraphPlan?.pointBlocks?.flatMap((b: any) =>
          b.steps?.map((s: any) => ({
            key: s.key,
            label: s.label,
            hasValue: !!s.value,
            status: s.status,
          }))
        ),
      })),
      isCompleted: session.step3.isCompleted,
    } : null,
  }, null, 2);

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
```

---

## E.4 修改 `server.ts` 主对话路由

### E.4.1 替换单体 LLM 调用

在 `/api/coach/chat` 的处理函数中（约 L7788-L7900），找到现有的 LLM 调用逻辑。

**当前架构（单体调用）：**
```
一次 generateContent → { text, progressUpdate }
```

**新架构（并行双调用）：**
```
Promise.all([
  generateContent(coachRequest)  → CoachOutput
  generateContent(intentRequest) → IntentOutput
]) → { text: coachOutput.text, progressUpdate: intentOutput }
```

### E.4.2 具体修改步骤

由于 `server.ts` 中 LLM 调用的具体位置和方式需要 AI Agent 在阅读代码后自行判断，这里给出修改指南而非代码：

**步骤 1：导入新模块**
```typescript
import { buildCoachRequest, parseCoachResponse } from "./src/server/coach/coach-agent";
import { buildIntentRequest, parseIntentResponse } from "./src/server/coach/intent-agent";
```

**步骤 2：构建两个请求**
在现有 prompt 构建之后、LLM 调用之前：
```typescript
const coachRequest = buildCoachRequest(step, question, messages, session, userMessage);
const intentRequest = buildIntentRequest(step, question, messages, session, userMessage);
```

**步骤 3：并行调用**
将现有的单次 `generateContentWithFallback` 替换为：
```typescript
const [coachResponse, intentResponse] = await Promise.all([
  generateContentWithFallback(coachRequest),
  generateContentWithFallback(intentRequest),
]);
```

**步骤 4：解析结果**
```typescript
const coachText = coachResponse?.candidates?.[0]?.content?.parts?.[0]?.text || "";
const coachOutput = parseCoachResponse(coachText);

const intentText = intentResponse?.candidates?.[0]?.content?.parts?.[0]?.text || "";
const intentOutput = parseIntentResponse(intentText);
```

**步骤 5：组装响应**
```typescript
const data = {
  text: coachOutput.text,
  progressUpdate: intentOutput ? {
    ...intentOutput,
    isCompleted: intentOutput.completionFlag?.isCompleted || false,
  } : {},
};
```

**步骤 6：如果 Intent Agent 解析失败 → 降级**
```typescript
if (!intentOutput) {
  // Intent Agent 失败时，返回 Coach 的文本但不更新状态
  // （student 的进度不丢失，下一轮再尝试）
  console.warn("[Coach] Intent Agent 解析失败，本轮不更新状态");
}
```

### E.4.3 注意事项

- **不要删除**现有的 guard 函数（它们在 PR-F 中处理）
- 如果并行调用导致类型错误，可以先改为串行（先 Coach 再 Intent），在下一轮优化
- `generateContentWithFallback` 函数已有模型 fallback 逻辑，保持复用

---

## E.5 自测

```bash
# 1. TypeScript 编译检查
npx tsc --noEmit 2>&1 | head -30

# 2. 确认导入路径正确
grep -n "from.*coach-agent\|from.*intent-agent" server.ts

# 3. 确认 Promise.all 存在
grep -n "Promise.all" server.ts
```

**通过标准：**
- `npx tsc --noEmit` 无错误
- 导入路径正确
- 并行调用模式存在

---

## E.6 提交

```bash
git add -A
git commit -m "feat(PR-E): Coach Agent + Intent Agent 拆分"
```
