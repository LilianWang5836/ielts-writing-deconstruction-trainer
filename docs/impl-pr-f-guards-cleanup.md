# PR-F：一致性断言 + 死代码清理

> 目标 PR | 依赖：PR-E | 预计行数：~200 | 执行时间：15-20 分钟

---

## F.1 概述

实现轻量一致性断言 + 删除旧的"结构作者"guard 函数调用。

**核心原则：断言只校验不修改。不合规则重试 Intent Agent（1 次），不修改 Coach 的输出。**

---

## F.2 实现 `src/server/guards/consistency.ts`

```typescript
/**
 * 一致性断言 — 轻量校验
 *
 * 校验 Coach Agent 和 Intent Agent 的输出是否一致。
 * 不合规则返回 issues，由调用方决定是否重试 Intent Agent。
 *
 * 与旧 guard 的关键区别：
 * - 旧 guard：修改 LLM 输出（改写 text、清空字段、注入标记）
 * - 新 guard：只校验不修改，返回 { valid, issues }
 */

import type { CoachOutput, IntentOutput, ConsistencyResult } from '../../types';
import type { PracticeSession } from '../../types';

/**
 * 核心校验函数
 */
export function validateTurnConsistency(
  coachOutput: CoachOutput,
  intentOutput: IntentOutput,
  session: PracticeSession,
  step: number,
): ConsistencyResult {
  const issues: string[] = [];

  // ==========================================
  // 规则 1：Intent 不能修改已确认的槽位
  // ==========================================
  if (step === 3 && intentOutput.slotUpdates?.length) {
    const subpoints = session.step3?.subpoints || [];
    const activeSp = subpoints.find(
      (sp: any) => sp.id === session.step3?.activeSubpointId,
    );

    if (activeSp?.paragraphPlan?.pointBlocks) {
      const confirmedKeys = new Set<string>();
      for (const block of activeSp.paragraphPlan.pointBlocks) {
        for (const s of block.steps || []) {
          if (s.status === 'confirmed') confirmedKeys.add(s.key);
        }
      }

      for (const update of intentOutput.slotUpdates) {
        if (confirmedKeys.has(update.key)) {
          issues.push(
            `[VIOLATION] 试图修改已确认槽位: ${update.key}（当前 action: ${update.action}）`,
          );
        }
      }
    }
  }

  // ==========================================
  // 规则 2：Intent 的 slotUpdate key 必须存在于 plan 中
  // ==========================================
  if (step === 3 && intentOutput.slotUpdates?.length) {
    const subpoints = session.step3?.subpoints || [];
    const activeSp = subpoints.find(
      (sp: any) => sp.id === session.step3?.activeSubpointId,
    );

    if (activeSp?.paragraphPlan?.pointBlocks) {
      const allKeys = new Set<string>();
      for (const block of activeSp.paragraphPlan.pointBlocks) {
        for (const s of block.steps || []) {
          allKeys.add(s.key);
        }
      }

      for (const update of intentOutput.slotUpdates) {
        if (!allKeys.has(update.key)) {
          issues.push(
            `[VIOLATION] slotUpdate 引用了不存在的 key: ${update.key}`,
          );
        }
      }
    }
  }

  // ==========================================
  // 规则 3：adaptations 不能跨 pointBlock merge
  // ==========================================
  if (intentOutput.adaptations?.length) {
    for (const adapt of intentOutput.adaptations) {
      if (adapt.op === 'merge' && adapt.fromKeys?.length) {
        // 校验 fromKeys 来自同一个 pointBlock
        // （此处为简化校验，完整版需要遍历 plan 的 pointBlocks）
        if (adapt.fromKeys.length > 2) {
          issues.push(
            `[VIOLATION] merge fromKeys 数量超过 2: ${adapt.fromKeys.join(', ')}`,
          );
        }
      }
    }
  }

  // ==========================================
  // 规则 4：completionFlag 不能在没有 CTA 文本时设置
  // ==========================================
  if (intentOutput.completionFlag?.isCompleted) {
    const hasCTA = /进入下一步|进入第[二三四]步|点击下一步|完成|大功告成/.test(
      coachOutput.text,
    );
    if (!hasCTA) {
      issues.push(
        `[WARN] completionFlag=true 但 Coach 文本中没有明确的下一步引导`,
      );
    }
  }

  // ==========================================
  // 规则 5：stageTransition 的 to 必须是合法值
  // ==========================================
  if (intentOutput.stageTransition) {
    const validStages = step === 2
      ? ['explore_A', 'explore_B', 'stance', 'summary']
      : step === 1
        ? ['type_check', 'issue_check', 'constraint_check', 'dimension_collect']
        : [];

    if (
      validStages.length > 0 &&
      !validStages.includes(intentOutput.stageTransition.to)
    ) {
      issues.push(
        `[VIOLATION] 非法的 stageTransition.to: ${intentOutput.stageTransition.to}（合法值: ${validStages.join(', ')}）`,
      );
    }
  }

  return {
    valid: issues.filter((i) => i.startsWith('[VIOLATION]')).length === 0,
    issues,
  };
}
```

---

## F.3 在 `server.ts` 中接入一致性断言

在 coach/chat 路由中，Intent Agent 解析成功后，调用断言：

```typescript
// 在 Intent Agent 解析后、组装响应前
const consistency = validateTurnConsistency(coachOutput, intentOutput, session, step);

if (!consistency.valid) {
  console.warn(`[ConsistencyGuard] 发现 ${consistency.issues.length} 个问题:`, consistency.issues);

  // 重试 Intent Agent（1 次）
  const retryResponse = await generateContentWithFallback(intentRequest);
  const retryText = retryResponse?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const retryOutput = parseIntentResponse(retryText);

  if (retryOutput) {
    const retryConsistency = validateTurnConsistency(coachOutput, retryOutput, session, step);
    if (retryConsistency.valid) {
      // 重试成功，使用 retryOutput
      // （替换 intentOutput）
    } else {
      console.warn('[ConsistencyGuard] 重试后仍不一致，本轮不更新状态');
      // 不更新状态，但返回 Coach 的对话文本
    }
  }
}
```

---

## F.4 删除旧 guard 调用（关键步骤）

在 `server.ts` 中搜索并删除以下函数的**调用**（不删除函数定义本身，避免级联错误）：

### F.4.1 搜索并删除调用

**搜索模式：**
- `applyStep3FrameworkGuard(` → 删除调用行
- `enforceFrameworkPointBlockCount(` → 删除调用行
- `ensureArgumentRelationCoverage(` → 删除调用行
- `ensureConcessionStructure(` → 删除调用行

**注意：**
- 只删除调用，不删除函数定义
- 如果删除调用后出现未使用变量的 lint 错误，暂时忽略（后续统一清理）
- 如果函数调用是多行（如作为参数传递），需要小心删除整个调用块

### F.4.2 替换硬拒逻辑

搜索 `hardRejectSlotText(` 的调用：

如果 `hardRejectSlotText` 用于语义拦截，保留调用但改为调用新的轻量校验：

```typescript
// 旧：
if (hardRejectSlotText(value)) { /* 拒绝 */ }

// 新（如果需要保留空串/占位符拦截）：
if (!value || value.trim() === '') { /* 仅拦截空串 */ }
// 语义质量判定由 Intent Agent 的 reject action 处理
```

### F.4.3 保留不动的

以下代码**不可删除**：
- `step3Quality.ts` 中的工具函数（`isStep3Confirmed`、`isValidStep3StepValue` 等 — 它们被其他位置使用）
- `enforceStep1SlotCompletion`（Step 1 的完成门禁，不在本次重构范围）
- `enforceStep2Completion`（Step 2 的完成门禁，不在本次重构范围）
- `sanitizeParagraphPlanValues`（value 清理仍需要）

---

## F.5 自测

```bash
# 1. TypeScript 编译检查
npx tsc --noEmit 2>&1 | head -30

# 2. 确认旧 guard 调用已删除
grep -n "applyStep3FrameworkGuard(" server.ts
# 预期：不再有调用（或只在注释中出现）

# 3. 确认新 guard 存在
grep -n "validateTurnConsistency" server.ts
# 预期：有调用

# 4. 运行 slot-reuse 验证（可能需要更新断言）
node scripts/verify-slot-reuse.mjs
```

**通过标准：**
- `npx tsc --noEmit` 无错误
- `applyStep3FrameworkGuard(` 不再被调用
- `validateTurnConsistency` 已接入
- `verify-slot-reuse.mjs` 的断言已更新为检查新 guard（如更新脚本，一并提交）

---

## F.6 提交

```bash
git add -A
git commit -m "feat(PR-F): 一致性断言 + 删除旧结构作者 guard 调用"
```
