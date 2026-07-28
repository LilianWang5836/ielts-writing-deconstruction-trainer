# PR-A：类型扩展 + 文件骨架

> 目标 PR | 依赖：无 | 预计行数：~200 | 执行时间：15-30 分钟

---

## A.1 概述

为后续 PR 创建类型定义和新目录结构。**不修改任何 .tsx 组件的业务逻辑。**

---

## A.2 修改 `src/types.ts`

### A.2.1 新增 `Step2_5State` 类型

在 `src/types.ts` 文件末尾追加以下类型定义。

**注意：**
- 不要删除或修改任何已有类型定义
- 新类型放在 `export interface PracticeSession` 之后

需要新增的类型（按顺序追加）：

```typescript
// ============================================================
// Step 2.5 Planner 类型
// ============================================================

export interface Step2_5State {
  status: 'idle' | 'running' | 'passed' | 'failed' | 'stale';
  startedAt?: number;
  updatedAt?: number;
  attempt?: number;
  planSignature?: string;
  plannerIntermediate?: {
    stance: string;
    argumentStrategy: string;
    argumentRelation: string;
    layoutPattern: string;
    bodyCount: number;
  };
  rationale?: string;
  bodyPlans: BodyPlan[];
  errorMessage?: string;
}

export interface BodyPlan {
  id: string;
  targetBody: string;
  role: string;
  theme?: string;
  content?: string;
  paragraphDensity?: 'single_point' | 'dual_point';
  argumentRelation?: ArgumentRelation;
  pointRoles?: BodyPointRole[];
  mappedPoints?: string[];
  paragraphPlan: ParagraphPlan;
}

// ============================================================
// Coach / Intent Agent 类型
// ============================================================

export interface CoachOutput {
  text: string;
  hint?: string;
}

export interface IntentOutput {
  stageTransition?: {
    from: string;
    to: string;
    reason: string;
  };
  slotUpdates?: Array<{
    key: string;
    action: 'draft' | 'confirm' | 'reject';
    value?: string;
    rejectReason?: string;
  }>;
  adaptations?: Array<{
    op: 'reclass' | 'merge' | 'add' | 'skip';
    key?: string;
    newLabel?: string;
    fromKeys?: string[];
    intoKey?: string;
    blockId?: string;
    afterKey?: string;
    label?: string;
    placeholder?: string;
    keys?: string[];
  }>;
  structureChangeOffer?: {
    kind: 'body_argument_change';
    summary: string;
    awaitConfirm: true;
  };
  completionFlag?: {
    isCompleted: boolean;
    reason: string;
  };
  dimensionUpdates?: Array<{
    label: string;
    status: 'probed' | 'expandable' | 'thin' | 'quality_pending';
  }>;
}

// ============================================================
// Board Patch 类型（替代 progressUpdate）
// ============================================================

export interface CoachTurnResponse {
  text: string;
  boardPatch: BoardPatch;
  plannerStatus?: 'running' | 'passed' | 'failed';
}

export interface BoardPatch {
  step1?: Partial<Step1Board>;
  step2?: Partial<Step2Board>;
  step3?: Partial<Step3Board>;
  isCompleted?: boolean;
}

/** Step 1 看板可更新字段 */
export interface Step1Board {
  correctType: string;
  coreIssue: string;
  writingTask: string;
  constraints: string[];
  suggestedDimensions: string[];
  critique: string;
  dimensionsSufficient: boolean;
  exitOffered: boolean;
}

/** Step 2 看板可更新字段 */
export interface Step2Board {
  currentStage: string;
  userStance: string;
  userPoints: string;
  suggestedStance: string;
  suggestedPoints: string;
  blueprint: {
    position: string;
    bodies: Array<{ title: string; content: string }>;
  };
  clustering: any;
  requiresStance: boolean;
  taskLabelA: string;
  taskLabelB: string;
  positionCheckPassed?: boolean;
  positionCheckDesc?: string;
  coverageCheckPassed?: boolean;
  coverageCheckDesc?: string;
  structureCheckPassed?: boolean;
  structureCheckDesc?: string;
}

/** Step 3 看板可更新字段 */
export interface Step3Board {
  activeSubpointId?: string;
  subpoints?: any[];
  isCompleted?: boolean;
  currentSlotUpdate?: {
    key: string;
    value: string;
    status: '' | 'draft' | 'confirmed';
  };
  adaptations?: any[];
  structureChangeOffer?: any;
  step3SlotEval?: any;
  paragraphPlan?: ParagraphPlan;
}

// ============================================================
// Planner 相关类型
// ============================================================

export interface PlannerInput {
  question: string;
  questionType: string;
  requiresStance: boolean;
  materials: {
    aSide: string;
    bSide: string;
    stance: string;
    clusters: any[];
    userRawText: string;
  };
}

export interface PlannerOutput {
  layoutPattern: string;
  rationale: string;
  bodyPlans: BodyPlan[];
  plannerIntermediate: Step2_5State['plannerIntermediate'];
}

export interface MechanicalQaResult {
  pass: boolean;
  issues: Array<{
    severity: 'fail' | 'warn';
    field: string;
    reason: string;
  }>;
}

export interface ConsistencyResult {
  valid: boolean;
  issues: string[];
}
```

### A.2.2 修改 `PracticeSession` 类型

在 `PracticeSession` 接口中追加 `step2_5` 字段。

**定位：** 找到 `PracticeSession` 接口定义（约在文件末尾附近），在最后一个字段后追加：

```typescript
export interface PracticeSession {
  // ... 已有字段保持不变 ...

  // 在最后一个已有字段后追加：
  step2_5?: Step2_5State;
}
```

---

## A.3 创建目录结构

在项目根目录下创建以下目录（使用 `mkdir -p` 命令）：

```
src/server/coach/
src/server/planner/
src/server/guards/
src/server/prompts/
```

**执行：**
```bash
mkdir -p src/server/coach src/server/planner src/server/guards src/server/prompts
```

---

## A.4 创建骨架文件

每个文件只需包含类型导入和空导出（或基础骨架），供后续 PR 填充。

### A.4.1 `src/server/planner/planner.ts`

```typescript
/**
 * Step 2.5 Planner — 材料驱动的结构推理
 *
 * 职责：
 * 1. 盘点 Step 2 原材料（A面/B面 强弱）
 * 2. 按题型选择最优论证策略
 * 3. 分配材料到 Body → 生成 ParagraphPlan
 *
 * 入口：buildPlannerPrompt() + runPlanner() + runMechanicalQa()
 */

import type { PlannerInput, PlannerOutput, MechanicalQaResult, BodyPlan } from '../../types';

// 后续 PR-B 填充实现
```

### A.4.2 `src/server/planner/planner-fallback.ts`

```typescript
/**
 * Planner 降级策略 — 保守默认结构
 *
 * 当 Planner LLM 调用失败或 QA 连续失败时使用
 * 不调 LLM，纯代码返回通用结构
 */

import type { BodyPlan } from '../../types';

/**
 * 根据题型返回保守默认 bodyPlans
 * 所有 body 使用 single_point + mechanism→example→impact 结构
 */
export function buildFallbackBodyPlans(_questionType: string): BodyPlan[] {
  // 后续 PR-B 填充实现
  return [];
}
```

### A.4.3 `src/server/coach/coach-agent.ts`

```typescript
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

// 后续 PR-E 填充实现
```

### A.4.4 `src/server/coach/intent-agent.ts`

```typescript
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

// 后续 PR-E 填充实现
```

### A.4.5 `src/server/guards/consistency.ts`

```typescript
/**
 * 一致性断言 — 轻量校验，不修改数据
 *
 * 职责：
 * 校验 Coach Agent 和 Intent Agent 的输出是否一致
 * 不合规则返回 issues，由调用方决定是否重试 Intent Agent
 *
 * 与旧 guard 的关键区别：不做数据修正（旧 guard 会改写 LLM 输出），只做校验
 */

import type { CoachOutput, IntentOutput, ConsistencyResult } from '../../types';
import type { PracticeSession } from '../../types';

/**
 * 校验一轮对话的 Coach 和 Intent 输出是否一致
 * 返回 { valid, issues }
 */
export function validateTurnConsistency(
  _coachOutput: CoachOutput,
  _intentOutput: IntentOutput,
  _session: PracticeSession,
  _step: number,
): ConsistencyResult {
  // 后续 PR-F 填充实现
  return { valid: true, issues: [] };
}
```

### A.4.6 prompt 骨架文件

创建以下三个文件（各含一行注释即可）：

`src/server/prompts/coach-prompts.ts`:
```typescript
/**
 * Coach Agent 各 Step 的 prompt 模板
 * 后续 PR-E 填充
 */
```

`src/server/prompts/intent-prompts.ts`:
```typescript
/**
 * Intent Agent prompt 模板 + Gemini response_schema 定义
 * 后续 PR-E 填充
 */
```

`src/server/prompts/planner-prompts.ts`:
```typescript
/**
 * Planner prompt 模板 — 题型分层策略枚举 + 推理链
 * 后续 PR-B 填充
 */
```

---

## A.5 自测

完成以上步骤后，执行：

```bash
# 1. TypeScript 编译检查（不产生输出即为通过）
npx tsc --noEmit 2>&1 | head -30

# 2. 确认目录结构
ls -la src/server/coach/ src/server/planner/ src/server/guards/ src/server/prompts/

# 3. 确认所有骨架文件存在
ls src/server/coach/coach-agent.ts src/server/coach/intent-agent.ts \
   src/server/planner/planner.ts src/server/planner/planner-fallback.ts \
   src/server/guards/consistency.ts \
   src/server/prompts/coach-prompts.ts src/server/prompts/intent-prompts.ts src/server/prompts/planner-prompts.ts
```

**通过标准：**
- `npx tsc --noEmit` 无错误
- 所有 8 个新文件存在
- `src/types.ts` 包含所有新增类型定义

如果 `tsc --noEmit` 报错，根据错误信息修复类型定义后再提交。

---

## A.6 提交

```bash
git add -A
git commit -m "feat(PR-A): 类型扩展 + src/server/ 目录骨架"
```
