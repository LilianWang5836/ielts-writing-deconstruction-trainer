# 会议秘书方案 v2（Meeting Secretary Plan）

> 分支：`restructure` | 日期：2026-08-15 | 状态：设计定稿（后端核心优先）
> v2 变更：明确「后端业务核心优先，前端为适配后端彻底重构，不做旧结构兼容层」

---

## 0. 原则（v2 核心立场）

1. **后端核心逻辑优先**：产品核心是后端的数据模型与业务逻辑。前端渲染必须适配后端，**后端不得为迁就前端渲染而保留冗余结构**。
2. **前端彻底重构**：Step3Drafting 直接消费新的简化模型，删除对旧 `paragraphPlan` 槽位状态 / 扁平字段 / slotEval 的全部依赖。
3. **真相源单一**：`minutes`（会议纪要）是唯一真相源；骨架只读；看板是投影。
4. **骨架只读**：骨架由 Planner/题型生成一次后**冻结**，任何环节不得修改结构（这是消灭死锁的本质）。
5. **复用不等于保留**：旧架构为「模型整树重写」服务的所有机制（diff/指纹/骨架锁/reclass 守卫/backfill）**全部删除**，不搬进新架构。

---

## 1. 目标回顾

| 漂移类型 | 症状 | 治理 | 优先级 |
|---------|------|------|--------|
| 状态漂移 | 看板错、死锁、结构被改 | 会议秘书（纪要+落槽） | **第一（上线）** |
| 判断漂移 | 教练误判、引导机械 | 判断透镜（评估+瘦身） | 第二 |

**为什么状态漂移是第一优先**：上线初期系统稳定性决定成败。判断漂移是"教得好不好"，状态漂移是"能不能用"。先稳，再质。

### 1.1 上线节奏

```
P0  后端核心（新数据模型+秘书落槽）+ 前端重构   → 稳（第一优先）
P1  纪要双层+可审计                           → 更可维护
P2  判断透镜+教练瘦身+评估输出                 → 质
P3  判断护栏                                  → 再稳一点
```

每个阶段独立验收、独立上线。

---

## 2. 新后端数据模型（核心简化）

### 2.1 架构总览

```
┌────────────────────────────────────────────────────────────┐
│                        server.ts（编排层）                   │
│                                                             │
│  1. 构建上下文（题目 + 冻结骨架 + 当前activeSlot + 学生回答）  │
│  2. [并行] Coach LLM → 对话文本（P2 加结构化评估）            │
│     [并行] 秘书/Intent   → 纪要事实（学生原话, 保真）          │
│  3. 秘书落槽（确定性）→ minutes → 看板（投影，非存储）         │
│  4. 返回 { text, boardView(由skeleton+minutes投影) }         │
└────────────────────────────────────────────────────────────┘
```

**核心变化**：
- 模型**不再输出/维护任何结构**（无 paragraphPlan、无 step3SlotEval、无结构 JSON）
- 骨架由 Planner 生成一次后**冻结**（skeleton）
- 学生内容全在 `minutes`，看板是投影

### 2.2 subpoint 新形态

```typescript
interface Step3Subpoint {
  id: string;
  content: string;           // body 主题
  targetBody?: string;
  isCompleted: boolean;
  selectable: boolean;

  /** 冻结骨架（Planner 生成一次，之后只读） */
  skeleton: Step3Skeleton;

  /** 会议纪要（唯一真相源） */
  minutes: Step3Minute[];

  /** 当前推进到第几个槽（指向 skeleton 展开后的槽下标） */
  activeSlotIndex: number;
}

interface Step3Skeleton {
  blocks: {
    id: string;              // "pb1"
    label: string;           // "含糖食品更便宜、更易得"
    subClaim: string;        // Step2 继承分论点（预填）
    role: 'major' | 'minor';
    slots: Step3Slot[];      // 有序论证槽
  }[];
  /** 论证链类型（驱动 P2 判断透镜） */
  chainType: 'cause_effect' | 'problem_solution' | 'concession' | 'support' | 'compare' | 'parallel';
}

interface Step3Slot {
  key: string;               // "pb1_s2"
  label: string;             // "展开原因" / "机制/过程" / "结果/影响"
  placeholder: string;       // 引导提示（该槽期望内容）
  semantic: 'claim' | 'reason' | 'mechanism' | 'impact' | 'example' | 'scenario' | 'solution';
}

interface Step3Minute {
  id: string;                // "m-<ts>-<seq>"
  role: 'student' | 'coach';
  text: string;              // 原话，保真
  ts: number;
  slotKey?: string;          // 落到的槽（未落为空）
  status: 'recorded' | 'landed' | 'confirmed' | 'rejected';
  rejectReason?: string;
  fromCoachAsk?: string;     // 触发本条回答的教练上一问
}
```

### 2.3 相比旧模型的删减

| 旧字段/机制 | 新模型 | 处置 |
|------------|--------|------|
| `paragraphPlan.pointBlocks[].steps[].value/status` | `skeleton.slots`（只存结构不存内容） | **删除**，内容在 minutes |
| `structureSteps[]` | — | **删除**（与 plan 重复） |
| 扁平字段 `claim/mechanism/result/reason/impact/supportContent` | — | **删除**（废弃残留） |
| `step3SlotEval` | — | **删除**（秘书落槽替代） |
| `kickoffPendingDrafts` | — | **删除**（minutes 状态机替代） |
| `frameworkSignature` / `frameworkDrifted` | — | **删除**（无整树 diff） |
| `mergeParagraphPlanValues` | — | **删除** |
| `enforceStep3SkeletonLock` | — | **删除**（骨架本就只读） |
| `absorbStep3ConfirmReclass` | — | **删除** |
| `tryBackfillSubstantiveAnswer` | 落槽逻辑（重写） | **重写**为秘书，不复用旧函数 |

### 2.4 看板是投影，不是存储

```
renderBoard(subpoint):
  for each block in skeleton.blocks:
    for each slot in block.slots:
      content = confirmedMinutesFor(slot.key)   // minutes 中 status=confirmed 且 slotKey 匹配
      status  = deriveStatus(slot.key)          // empty / draft(landed) / confirmed
```

**没有任何地方持久化"看板内容"**——内容永远在 minutes，看板只是函数输出。从根本上消灭"双真相源"。

---

## 3. 后端核心流程（P0）

### 3.1 落槽状态机

```
学生发言(userMessage)
  │
  ▼ 类型判定（isSubstantiveAnswer / isAffirmative / isReject）
  │
  ├─ 实质回答 ──► 写 minutes(recorded) → 找 skeleton 当前 activeSlot
  │                 ├─ 与已 confirmed 兄弟槽语义重复 → rejected(+reason)
  │                 ├─ 否则 → landed（draft，等确认）
  │                 └─ 无空槽 → 保持 recorded（教练引导收尾）
  │
  ├─ 确认("对") ──► landed → confirmed（minutes.status=confirmed）
  │                 → activeSlotIndex+1
  │
  └─ 拒绝/指令 ──► 写 minutes(recorded)，不进看板
```

### 3.2 四个确定性函数（后端全部逻辑）

```typescript
// 1. 记纪要
function appendMinute(subpoint, role, text): Step3Minute

// 2. 落槽（找当前槽 → dup 预检 → landed）
function landMinuteToSlot(subpoint, minute): { ok, slotKey?, reason? }

// 3. 确认写板（landed → confirmed，推进 activeSlotIndex）
function commitPendingMinute(subpoint, minute): void

// 4. 渲染投影（只读）
function renderBoard(subpoint): BoardView
```

**后端 Step3 逻辑量 = 4 个函数 + 1 个 dup 预检。** 相比当前的 merge + guards + backfill + reclass + framework 校验，数量级缩减。

### 3.3 dup 预检（唯一保留的确定性护栏）

沿用 `hardRejectSlotText` 思路，检查学生回答与已 confirmed 兄弟槽的语义重复。这是 P0 唯一保留的护栏，因为"复读"是明确的确定性错误。

---

## 4. 前端彻底重构（Step3Drafting）

### 4.1 原则

前端直接消费 `skeleton + minutes + renderBoard 输出`，**删除**对旧 `paragraphPlan` 槽位状态 / 扁平字段 / slotEval / kickoffPendingDrafts 的全部依赖。**不做旧结构兼容层。**

### 4.2 改造清单

| 旧依赖（Step3Drafting.tsx） | 处置 |
|----------------------------|------|
| `paragraphPlan.pointBlocks[].steps[].value/status`（17 处） | 改读 `renderBoard` 输出 / `skeleton.slots` + `minutes` |
| `pointBlocks`（7 处） | 改 `skeleton.blocks` |
| `.steps`（4 处） | 改 `slots` |
| `structureSteps`（3 处） | 删除 |
| `.value`（10 处） | 改从 minutes 投影 |
| `pendingText`（6 处） | 改读 minutes 中 landed |
| `kickoffPendingDrafts`（2 处） | 删除 |
| 扁平字段 `.claim/.impact/.reason`（3 处） | 删除 |

### 4.3 前端提交的决策

前端不再传 `step3SlotEval` / 结构字段；只传：
- `userMessage`（学生原话）
- `decision`（确认/拒绝，复用现有 decision 通道）
- `activeSubpointId`

其余由后端从 minutes 推导。

---

## 5. 分阶段实施（后端优先，前端同步重构）

### P0 — 后端核心（会议秘书最小版）+ 前端重构

**目标**：三题型跑通、无死锁、看板内容全部来自 minutes。

- [ ] 后端：新数据模型（skeleton + minutes）+ 4 个确定性函数
- [ ] 后端：删除旧 Step3 机制（merge/指纹/骨架锁/reclass/backfill/slotEval/kickoffDrafts/扁平字段）
- [ ] 后端：Planner 输出改为生成 `skeleton`（冻结），不再生成带 value 的 paragraphPlan
- [ ] 前端：Step3Drafting 重写为消费 skeleton + minutes（删旧依赖）
- [ ] 验证：三题型 Step1→4 完整跑通，无死锁，`tsc --noEmit` 通过

### P1 — 纪要双层 + 可审计落槽

- [ ] 落槽审计日志（minuteId → slotKey → reason）
- [ ] 可重放：从 minutes 重放落槽结果与运行一致
- [ ] 诊断脚本基于 minutes 重放

### P2 — 判断透镜 + 教练瘦身 + 结构化评估

- [ ] 教练上下文瘦身（只给题目 + skeleton + activeSlot + 学生回答 + 透镜）
- [ ] Coach 输出结构化评估 `{slotKey, verdict, reason, nextHint}`
- [ ] 判断透镜配置（通用原则清单 + 题型结构约束表，运营可编辑）
- [ ] 引导内容随学生回答变化（不套模板）

### P3 — 判断护栏（只拦确定性错误）

- [ ] 切题预检（只拦明确跑题）
- [ ] 教练卡死检测
- [ ] 原则：护栏不充当模板校验器

---

## 6. 复杂度控制总则（v2 修订）

1. **后端核心优先**：先定数据模型与业务逻辑，前端适配。
2. **删除优先**：旧架构机制全部删除，不搬移；每保留一个旧机制先问能否删除。
3. **真相源单一**：minutes 唯一，看板是投影，无持久化看板内容。
4. **骨架只读**：结构冻结是消灭死锁的本质，任何环节不得改结构。
5. **后端薄**：Step3 后端逻辑收敛为 4 个确定性函数 + 1 个 dup 预检。
6. **前端同步重构**：不接受"投影层兼容旧结构"的中间态，直接改到消费新模型。

---

## 7. 验收总览

| 阶段 | 核心 | 验收 |
|------|------|------|
| P0 | 新数据模型 + 秘书落槽 + 前端重构 | 三题型无死锁；看板内容全来自 minutes；tsc 通过；旧字段全删 |
| P1 | 纪要双层 + 审计 + 可重放 | 槽↔原话可回溯；落槽有 reason；重放一致 |
| P2 | 判断透镜 + 教练瘦身 + 评估输出 | 教练瘦身；评估可审计；配置可编辑；引导跟语料走 |
| P3 | 判断护栏 | 只拦确定性错误 |

---

## 8. 与旧文档的关系

- `restructure-plan.md` 的 **Planner（题型-策略-骨架生成）** 保留，但其输出改为生成 `skeleton`（冻结、无 value），不再生成旧 paragraphPlan。
- 本方案 v2 取代 v1 中「复用 backfill / 保留骨架锁为保险丝」的妥协——**新架构从零建模，旧机制全部删除**。
- 前端不再有"投影层兼容旧结构"的中间态，直接重构到消费新模型。
