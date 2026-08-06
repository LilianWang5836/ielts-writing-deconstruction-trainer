# PR-D：Step 3 灌入 bodyPlans

> 目标 PR | 依赖：PR-C | 预计行数：~300 | 执行时间：20-30 分钟

---

## D.1 概述

修改 `Step3Drafting.tsx`，使其从 `session.step2_5.bodyPlans` 读取预生成的 paragraphPlan，而非让 LLM 在对话中生成。

---

## D.2 修改 `src/components/Step3Drafting.tsx`

### D.2.1 修改 subpoints 构建逻辑

找到 `parsedSubpoints` 的计算逻辑（约 L50-L120），在其前面插入 `step2_5` 优先读取：

```typescript
// 优先从 step2_5.bodyPlans 构建 subpoints
const step2_5BodyPlans = session.step2_5?.bodyPlans;

const parsedSubpoints: Step3Subpoint[] = step2_5BodyPlans && step2_5BodyPlans.length > 0
  ? step2_5BodyPlans.map((bp: BodyPlan) => ({
      id: bp.id,
      content: bp.paragraphPlan?.pointBlocks?.[0]?.subClaim || bp.theme || bp.targetBody,
      targetBody: bp.targetBody,
      theme: bp.theme || bp.role,
      paragraphDensity: bp.paragraphDensity,
      argumentRelation: bp.argumentRelation,
      pointRoles: bp.pointRoles,
      layoutRationale: (session.step2_5 as any)?.rationale || '',
      paragraphPlan: bp.paragraphPlan,  // ← 关键：直接使用预生成的 plan
      isCompleted: false,
      frameworkSignature: `${bp.id}-${bp.argumentRelation || ''}`,
    }))
  : /* 原有的 fallback 逻辑（clustering → blueprint → userPoints 切分）保持不变 */;
```

**注意：** 保留原有的 fallback 逻辑（当 `step2_5BodyPlans` 为空时使用 clustering/blueprint/userPoints）。

### D.2.2 修改 kickoffPrompt

找到 `kickoffPrompt` 变量（约 L246），修改为锁定 plan 的版本：

```typescript
const kickoffPrompt = activeSubpoint?.paragraphPlan
  ? `请基于右侧已展示的段落结构直接开始，对准第一个空槽（${activeSubpoint.paragraphPlan.pointBlocks?.[0]?.steps?.[0]?.label || '分论点'}）用中文苏格拉底式提问。不要重新规划结构，不要一次性确认所有步骤，不要输出 pendingText。只问一个问题。`
  : activeSubpoint?.content
    ? `请基于这个已确立的主体段分论点直接开始：${activeSubpoint.content}。请先规划本段 paragraphPlan 骨架（分点/角色/步骤标签），所有 steps[].value 保持空。step3SlotEval 必须 mode=expand，对准 firstEmpty，用自然中文苏格拉底问题开问。第二步材料只作提问线索，禁止整理成待确认整链草稿，禁止 mode=confirm / pendingText，禁止让我一次性确认。结构细节写入系统即可，对话里不要提字段名。`
    : "";
```

**关键变化：** 第一个分支（有 paragraphPlan 时）不再要求 LLM"先规划 paragraphPlan 骨架"，而是直接"对准第一个空槽提问"。

### D.2.3 修改右侧看板渲染（展示预生成的 steps）

找到右侧看板中渲染 steps 的部分。如果原有的空壳逻辑（没有 plan 时显示占位）和预生成 plan 的展示逻辑相同，则无需修改。如果不相同，确保：

- 当 `activeSubpoint.paragraphPlan` 存在时，**直接渲染**其 `pointBlocks[].steps[]`，每个 step 显示 `label` + `value`（或 placeholder）
- 已 confirmed 的 step 显示绿色勾
- 当前正在编辑的 step（firstEmpty）高亮

参考逻辑（不要求逐行一致，AI Agent 根据实际代码结构调整）：

```tsx
{activeSubpoint?.paragraphPlan?.pointBlocks?.map((block: any) => (
  <div key={block.id}>
    <h4>{block.label} ({block.role})</h4>
    {block.steps?.map((step: any) => (
      <div key={step.key}>
        <span>{step.label}</span>
        {step.value ? (
          <span>{step.value}</span>
        ) : (
          <span className="italic text-slate-400">{step.placeholder}</span>
        )}
        {step.status === 'confirmed' && <CheckCircle2 />}
      </div>
    ))}
  </div>
))}
```

---

## D.3 修改 `server.ts` 中 Step 3 的 kickoff 处理

如果 `server.ts` 中有处理 Step 3 kickoff 的逻辑（搜索 `prepareStep3KickoffCoachText` 或相关函数），确保：

- 当 `activeSp.paragraphPlan` 已存在时，kickoff 不要求 LLM 生成 plan
- kickoff 的 `step3SlotEval.mode` 必须是 `expand`（不是 `confirm`）

具体修改位置依赖于现有代码，由 AI Agent 在阅读相关函数后自行判断。

---

## D.4 自测

```bash
# 1. TypeScript 编译检查
npx tsc --noEmit 2>&1 | head -30

# 2. 检查关键修改点
grep -n "step2_5BodyPlans\|step2_5?.bodyPlans" src/components/Step3Drafting.tsx
grep -n "请基于右侧已展示的段落结构直接开始" src/components/Step3Drafting.tsx

# 3. 运行 openers 验证
node scripts/verify-step-openers.mjs
```

**通过标准：**
- `npx tsc --noEmit` 无错误
- grep 命中关键代码
- `verify-step-openers.mjs` 全部通过（如失败，按断言更新该脚本）

---

## D.5 提交

```bash
git add -A
git commit -m "feat(PR-D): Step 3 灌入 bodyPlans + kickoff 锁定"
```
