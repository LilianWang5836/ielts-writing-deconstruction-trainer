# PR-C：Step 2→3 过渡

> 目标 PR | 依赖：PR-B | 预计行数：~300 | 执行时间：20-30 分钟

---

## C.1 概述

在 Step 2 完成时触发 Step 2.5 Planner，管理过渡状态（running → passed → 跳转 Step 3）。

**关键约束：**
- 不在此 PR 中修改 Step 3 的 paragraphPlan 消费方式（PR-D 做）
- 不在此 PR 中创建 Express 路由（在 server.ts 现有代码中内联）
- Planner 的 LLM 调用在此 PR 中为**桩函数**（stub），只做结构校验和降级

---

## C.2 修改 `src/components/Step2Brainstorm.tsx`

### C.2.1 新增 Planner 状态管理

在 `Step2Brainstorm` 组件中新增状态：

```typescript
// 在组件函数顶部，其他 useState 之后追加：
const [plannerStatus, setPlannerStatus] = useState<'idle' | 'running' | 'passed' | 'failed'>('idle');
const plannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

### C.2.2 修改 `showNextStepButton` 逻辑

找到 `showNextStepButton` 的 `useMemo`，修改使其在 CTA 出现时触发 Planner：

```typescript
// 在 showNextStepButton 的 useMemo 中追加：
// （保持原有 isCompleted 和 CTA 判断不变，在 return true 之前插入）

// 当 CTA 出现且 planner 尚未运行过时，触发 Planner
useEffect(() => {
  if (!showNextStepButton) return;
  if (plannerStatus !== 'idle') return;
  
  setPlannerStatus('running');
  
  // 设置超时
  plannerTimerRef.current = setTimeout(() => {
    setPlannerStatus('failed');
  }, 60000); // 60s 超时
  
  // 调用 Planner（当前为简化版，不真实调 LLM）
  triggerPlanner();
}, [showNextStepButton, plannerStatus]);
```

### C.2.3 实现 `triggerPlanner` 函数

```typescript
const triggerPlanner = async () => {
  try {
    const res = await fetch('/api/planner/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    
    if (plannerTimerRef.current) {
      clearTimeout(plannerTimerRef.current);
      plannerTimerRef.current = null;
    }
    
    if (data.status === 'passed') {
      setPlannerStatus('passed');
      // 更新 session 中的 step2_5
      onUpdateSession({
        step2_5: data.step2_5,
      } as any);
    } else {
      setPlannerStatus('failed');
    }
  } catch {
    setPlannerStatus('failed');
  }
};
```

### C.2.4 修改 `onNextStep`

```typescript
// 修改原有的 onNextStep 回调（由父组件传入），增加 planner 状态检查：
const handleNextStepOriginal = onNextStep; // 保存原始引用

const handleNextStepWithPlanner = () => {
  if (plannerStatus === 'passed') {
    handleNextStepOriginal();
  } else if (plannerStatus === 'failed') {
    // 重试
    setPlannerStatus('idle');
  }
  // running → 不做任何事（等待）
};
```

在 JSX 中把 `onClick={onNextStep}` 改为 `onClick={handleNextStepWithPlanner}`。

### C.2.5 修改跳转按钮的文案和状态

```tsx
{/* 在 showNextStepButton 的条件块中，根据 plannerStatus 调整按钮 */}
<button
  onClick={handleNextStepWithPlanner}
  disabled={plannerStatus === 'running'}
  className={/* ...保持原有样式... */}
>
  {plannerStatus === 'running' ? (
    <><Loader2 className="h-3.5 w-3.5 animate-spin" /><span>正在整理段落结构…</span></>
  ) : plannerStatus === 'failed' ? (
    <><RotateCcw className="h-3.5 w-3.5" /><span>重试</span></>
  ) : (
    <><span>立即跳转</span><ArrowRight className="h-3.5 w-3.5" /></>
  )}
</button>
```

### C.2.6 CoachChat 输入禁用

在 `<CoachChat>` 组件上传递 `inputDisabled` prop：

```tsx
<CoachChat
  // ... 原有 props ...
  inputDisabled={plannerStatus === 'running'}
/>
```

---

## C.3 修改 `src/components/CoachChat.tsx`

### C.3.1 新增 `inputDisabled` prop

在 `CoachChatProps` 接口中追加：

```typescript
interface CoachChatProps {
  // ... 原有 props ...
  inputDisabled?: boolean;  // Planner running 时禁用输入
}
```

在组件的参数解构中添加 `inputDisabled = false`。

### C.3.2 修改输入框的 disabled 属性

找到输入框的 `<input>` 元素，修改 disabled 逻辑：

```tsx
<input
  disabled={loading || inputDisabled}
  // ... 其他原有属性 ...
/>
```

---

## C.4 在 `server.ts` 中新增 Planner 路由

在 `server.ts` 的路由注册区域（`app.get("/api/health"` 附近）追加：

```typescript
// POST /api/planner/generate — Step 2.5 Planner
app.post("/api/planner/generate", async (req, res) => {
  try {
    const { session } = req.body;
    
    // 当前阶段：不真实调 LLM，使用降级策略
    // 后续集成真实 LLM 时替换此桩
    const questionType = session?.step1?.coachEvaluation?.correctType || "Agree / Disagree";
    const fallbackPlans = buildFallbackBodyPlans(questionType);
    
    res.json({
      status: "passed",
      step2_5: {
        status: "passed",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        attempt: 1,
        planSignature: `sig-${Date.now()}`,
        bodyPlans: fallbackPlans,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Planner failed" });
  }
});
```

**注意：** 需要在 `server.ts` 顶部导入：
```typescript
import { buildFallbackBodyPlans } from "./src/server/planner/planner-fallback";
```

---

## C.5 CoachChat 的 loading 文案

在 `CoachChat.tsx` 中，当 `inputDisabled` 为 true 时，在输入框下方显示提示：

```tsx
{inputDisabled && (
  <div className="text-[10px] text-amber-600 bg-amber-50 px-3 py-1 text-center">
    ⏳ 正在整理段落结构，请稍候…
  </div>
)}
```

---

## C.6 自测

```bash
# 1. TypeScript 编译检查
npx tsc --noEmit 2>&1 | head -30

# 2. 检查关键修改点是否存在（grep 静态检查）
# Step2Brainstorm 中有 plannerStatus 状态
grep -n "plannerStatus" src/components/Step2Brainstorm.tsx

# CoachChat 中有 inputDisabled prop
grep -n "inputDisabled" src/components/CoachChat.tsx

# server.ts 中有 /api/planner/generate 路由
grep -n "planner/generate" server.ts
```

**通过标准：**
- `npx tsc --noEmit` 无错误
- 3 个 grep 检查全部命中
- 代码逻辑：CTA 出现 → plannerStatus 变为 `running` → 按钮显示 loading → 降级返回 passed → 按钮可点击

---

## C.7 提交

```bash
git add -A
git commit -m "feat(PR-C): Step 2→3 过渡 — Planner 触发 + 禁输入 + 等待跳转"
```
