# Restructure Plan：IELTS Writing Deconstruction Trainer

> 分支：`dev_dannielzhang` | 日期：2026-07-28 | 基于专家评审后的定稿方案

---

## 目录

1. [方案演进对比](#1-方案演进对比)
2. [最终架构设计](#2-最终架构设计)
3. [Planner 详细设计](#3-planner-详细设计)
4. [Coach Agent + Intent Agent 设计](#4-coach-agent--intent-agent-设计)
5. [数据契约](#5-数据契约)
6. [实现计划](#6-实现计划)
7. [验收标准](#7-验收标准)

---

## 1. 方案演进对比

### 1.1 三个版本的演进

| | V1（初始方案） | V2（优化后） | V3（专家定稿） |
|---|---|---|---|
| **Planner 核心语义** | 模板填空 | 材料驱动的语义匹配 | 题型分层 + 策略枚举 + 材料驱动的结构推理 |
| **决策方式** | 纯规则选模板 | LLM 自由推理 ~100 种组合 | LLM 在明确的策略框架内做语义匹配 |
| **Prompt 结构** | 无详细设计 | 开放式指令 | 分层：题型 → 策略枚举 → 决策规则 → 材料分配 → plan 生成 |
| **中间输出** | 无 | 无 | YAML 结构化中间推理（理由可审计） |
| **Body 数量决策** | 写死 2-3 | LLM 自行判断 | 明确的规则：核心论点可展开性 → 2 或 3 → 弱论点合并原则 |
| **Per-body 组织** | 隐式 | 隐式 | 显式：role + structure + points + expansion |

### 1.2 V2 → V3 的关键变化

#### 变化 1：Prompt 从开放式变为分层引导式

**V2（我的设计）：**
```
你是一个 IELTS Task 2 段落结构规划器。
第1步：盘点原材料 → 强弱
第2步：决定结构 → layoutPattern / argumentRelation
第3步：分配材料 → body plans
第4步：生成 paragraphPlan
```

**V3（专家设计）：**
```
你是一个 IELTS Task 2 段落结构规划器。

第1步：盘点原材料 → A面/B面强弱

第2步：选择论证策略（按题型分层）
  Agree/Disagree → 4 种策略（strong_support / concession / different_situations / partial_agreement）
  Advantages/Disadvantages → 4 种策略（advantage_outweighs / disadvantage_outweighs / different_stakeholders / different_situations）
  Discuss Both Views → 4 种策略（support_A / support_B / concession / different_situations）
  Multiple Questions → 3 种策略（parallel / problem_solution / cause_effect）
  
  每种策略输出：stance + argumentStrategy + argumentRelation + layoutPattern + bodyCount

  决策规则（代码辅助）：
    ① 题型
    ② 是否需要明确立场
    ③ 双方材料强弱
    ④ 观点之间的逻辑关系
    ⑤ Body Count（明确规则：可独立展开的核心论点数 → 2 或 3，弱论点合并）

第3步：分配材料到 Body
  显式输出每个 body 的：role + structure(single/dual) + points + expansion

第4步：生成 paragraphPlan
```

**为什么 V3 更好：**
- 不是让 LLM "自由推理 100 种组合"，而是给出**明确的策略菜单**，LLM 做的是"匹配"而非"发明"
- 每种题型有哪些策略是预先穷举的（教学上正确），LLM 不会发明不合理的策略
- 中间 YAML 输出让决策可审查——出问题时能看是哪个环节错了

#### 变化 2：Body Count 从"LLM 自由判断"到"规则驱动"

**V2：** LLM 自行判断 body 数量（"通常在 ~100 种组合中选择"）

**V3：**
```
Body 数量由可独立展开的核心论点（expandable arguments）决定：

Body = 2（默认）：
  - 两个可独立展开的核心论点
  - 一让步 + 一主论点
  - 两个问题分别回答
  - 多个较弱论点合并到同一个 Body

Body = 3：
  - 三个以上可独立展开的核心论点
  - Problem → Cause → Solution
  - Discuss Both Views + Personal Opinion

论点合并原则：弱论点应合并为 Supporting Points，不单独成段
```

这避免了 LLM 随意决定 2 或 3 个 body 导致的不一致。

#### 变化 3：材料分配的显式化

**V2：** LLM 直接输出 paragraphPlan JSON（跳过中间推理）

**V3：** 先输出 YAML 中间格式：
```yaml
bodies:
  - role: concession
    structure: single_point
    points: [traffic restrictions]
    expansion: comparison
  - role: main_argument
    structure: dual_point
    points: [public transport, urban planning]
    expansion: mixed
```

这个 YAML 是 LLM 的"草稿纸"——先确认角色和策略正确，再展开为完整的 paragraphPlan JSON。且这个中间产物对调试极有价值。

#### 变化 4：策略粒度更细

| V2 的 argumentRelation | V3 的 argumentStrategy |
|---|---|
| `supports` | `strong_support` / `partial_agreement` / `support_A` / `support_B` |
| `concedes` | `concession` / `advantage_outweighs` / `disadvantage_outweighs` |
| `side_by_side` | `different_situations` / `different_stakeholders` |
| `solves` | `problem_solution` |
| —（新增） | `cause_effect` / `parallel` |

这更准确——`strong_support` 和 `partial_agreement` 虽然都输出 `argumentRelation: support`，但在 prompt 中是两条不同的策略路径，生成的 plan 结构也不同。

---

## 2. 最终架构设计

### 2.1 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                        Frontend                               │
│  CoachChat（纯展示 + 发送） + 各 Step 组件（处理 boardPatch）  │
└──────────────────────────┬───────────────────────────────────┘
                           │ POST /api/coach/turn
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                     server.ts（编排层 ~2000 行）               │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐     │
│  │              /api/coach/turn 处理流程                  │     │
│  │                                                       │     │
│  │  1. 加载 session + 构建上下文                          │     │
│  │  2. [并行] Coach Agent (T=0.7)  → 自然语言对话        │     │
│  │     [并行] Intent Agent (T=0.1) → 结构化状态变更       │     │
│  │  3. 一致性断言（纯校验，不合规则重试 Intent Agent 1次） │     │
│  │  4. Merge → 返回 { text, boardPatch 只含变化部分 }     │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐     │
│  │              /api/planner/generate 处理流程            │     │
│  │                                                       │     │
│  │  1. 收集 Step 2 原材料（A面/B面/stance/clusters）      │     │
│  │  2. Planner Prompt 构建（题型 → 策略枚举 → 材料）      │     │
│  │  3. Planner LLM 调用 (T=0.3)                          │     │
│  │     ├── 第1步：盘点原材料（自然语言推理）               │     │
│  │     ├── 第2步：选择策略（输出 YAML）                    │     │
│  │     ├── 第3步：分配材料（输出 YAML）                    │     │
│  │     └── 第4步：生成 paragraphPlan JSON                 │     │
│  │  4. 机械 QA（value全空 / bodyCount / key唯一 / mode合法）│     │
│  │  5. fail → 重试 1 次 → 仍 fail → 降级                  │     │
│  │  6. 写入 session.step2_5                               │     │
│  └─────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 文件组织

```
src/server/
├── coach/
│   ├── coach-agent.ts        # Coach LLM（对话，T=0.7，response_schema: {text, hint?}）
│   └── intent-agent.ts       # Intent LLM（结构化状态变更，T=0.1，strict schema）
├── planner/
│   ├── planner.ts            # Planner 编排（调 LLM → 机械 QA → 重试/降级）
│   └── planner-fallback.ts   # 降级策略（保守默认结构）
├── guards/
│   └── consistency.ts        # 轻量断言（不合规则重试 agent，不改数据）
└── prompts/
    ├── coach-prompts.ts      # 各 Step 的 Coach Agent prompt
    ├── intent-prompts.ts     # Intent Agent prompt（含 response_schema 定义）
    └── planner-prompts.ts    # Planner prompt（题型分层策略枚举 + 推理链）
```

### 2.3 保留不动的部分

| 模块 | 状态 |
|------|------|
| localStorage 存储 | 保持，后续随用户系统改造 |
| Step 1 审题对话策略 | 保持（explore_A/B → stance → summary 不在此次范围） |
| Step 2 探索对话策略 | 保持 |
| Step 4 逐句练习 | 保持 |
| 所有 UI 组件 | 仅改 boardPatch 消费方式，不改 UI 结构 |
| Header / TopicSelector / TopicImporter | 不动 |

---

## 3. Planner 详细设计

### 3.1 题型-策略对照表

#### Agree / Disagree

| Strategy | argumentRelation | layoutPattern | 适用场景 |
|----------|:-----------------:|:--------------:|----------|
| `strong_support` | support | support | 一侧材料明显更强，已有明确立场 |
| `concession` | concedes | concession | 承认对方合理性但己方更重要（Although... I believe...） |
| `different_situations` | side_by_side | side_by_side | 不同条件下结论不同（发达国家 vs 农村） |
| `partial_agreement` | support | support | 部分认同 + 补充更重要因素（特别适合 only/all/best 绝对词题目） |

#### Advantages / Disadvantages

| Strategy | argumentRelation | layoutPattern | 适用场景 |
|----------|:-----------------:|:--------------:|----------|
| `advantage_outweighs` | concedes | concession | 承认缺点但优点更重要 |
| `disadvantage_outweighs` | concedes | concession | 承认优点但缺点影响更大 |
| `different_stakeholders` | side_by_side | side_by_side | 不同群体受不同影响（政府 vs 普通人） |
| `different_situations` | side_by_side | side_by_side | 不同环境/年龄段/时代下影响不同 |

#### Discuss Both Views

| Strategy | argumentRelation | layoutPattern | 适用场景 |
|----------|:-----------------:|:--------------:|----------|
| `support_A` | support | support | 完全支持 A 观点 |
| `support_B` | support | support | 完全支持 B 观点 |
| `concession` | concedes | concession | 承认对方合理性但最终支持一方 |
| `different_situations` | side_by_side | side_by_side | 两种观点分别适用于不同情况 |

#### Multiple Questions（Two-part / Problem-Solution / Cause-Effect）

| Strategy | argumentRelation | layoutPattern | 适用场景 |
|----------|:-----------------:|:--------------:|----------|
| `parallel` | parallel | parallel | 各问题独立，分别回答 |
| `problem_solution` | solves | problem_solution | 第一问分析问题，第二问提出方案 |
| `cause_effect` | causal | causal | 第一部分分析原因，第二部分分析影响 |

### 3.2 Planner 决策流程（LLM Prompt 结构）

```
┌─────────────────────────────────────────┐
│  Planner LLM Prompt（分层结构）           │
│                                          │
│  【输入】                                 │
│  ├── 题目文本                             │
│  ├── 题型（已识别）                        │
│  └── 原材料：A面 / B面 / stance / clusters │
│                                          │
│  【第1步：盘点原材料】                      │
│  ├── A面：论点清单 + 每个论点的强度         │
│  │   （有场景/机制支撑 vs 空泛提纲）         │
│  ├── B面：同上                            │
│  └── 结论：材料偏哪侧 / 是否均衡            │
│     → 输出：自然语言推理（内部，不展示）      │
│                                          │
│  【第2步：选择论证策略】                    │
│  ├── 根据题型，从策略菜单中匹配               │
│  ├── 决策规则：                             │
│  │   ① 题型                                │
│  │   ② 是否需要明确立场（requiresStance）    │
│  │   ③ 双方材料强弱                         │
│  │   ④ 观点之间的逻辑关系                    │
│  │   ⑤ Body Count（见 3.3）                │
│  └── 输出 YAML：                            │
│      stance: agree / disagree / balanced    │
│      argumentStrategy: strong_support / ... │
│      argumentRelation: support / concedes / │
│                         side_by_side / ...  │
│      layoutPattern: support / concession /  │
│                      side_by_side / ...     │
│      bodyCount: 2 / 3                       │
│                                          │
│  【第3步：分配材料到 Body】                   │
│  ├── 每个 Body 的 role                      │
│  ├── 每个 Body 的 structure (single/dual)   │
│  ├── 每个 Body 包含哪些 points               │
│  ├── 弱论点合并为 Supporting Points          │
│  └── 输出 YAML：                            │
│      bodies:                                │
│        - role: concession / main_argument /  │
│                problem / solution / ...      │
│          structure: single_point / dual_point│
│          points: [论点文本]                   │
│          expansion: explanation / example /  │
│                      mechanism / ... / mixed │
│                                          │
│  【第4步：生成 paragraphPlan】                │
│  ├── 基于第3步的 YAML，展开为完整 JSON        │
│  ├── 为每个 pointBlock 生成 steps[]          │
│  ├── 所有 value 为空字符串                   │
│  ├── placeholder 贴合具体材料内容              │
│  └── 输出 JSON：{ layoutPattern, rationale,  │
│                   bodyPlans[] }              │
└─────────────────────────────────────────┘
```

### 3.3 Body Count 决策规则

```
Body Count = f(可独立展开的核心论点数量, 题型结构要求)

Body = 2（默认推荐）：
  ✓ 两个可独立展开的核心论点
  ✓ 一让步 + 一主论点（concession 策略）
  ✓ 两个问题分别回答（parallel 策略）
  ✓ 多个弱论点已合并到同一个 Body

Body = 3（仅在以下情况）：
  ✓ 三个以上可独立展开且各有足够论证深度的核心论点
  ✓ Problem → Cause → Solution（problem_solution 策略需要三个维度）
  ✓ Discuss Both Views + Personal Opinion（需要额外一段表达个人立场）
  ✓ 多层次分析且各层次都需要充分展开

论点合并原则：
  - 论证力度弱 → 合并为 Supporting Point
  - 内容高度相关 → 合并为同一 Body
  - 难以单独支撑完整 Body → 合并
```

### 3.4 Planner LLM 调用参数

| 参数 | 值 | 原因 |
|------|-----|------|
| `model` | 从 fallback 列表选最优 | 同其他 LLM 调用 |
| `temperature` | 0.3 | 需要一定创造性（分析材料强弱）但不能太发散 |
| `response_schema` | 严格 JSON | 最终输出是 bodyPlans JSON |
| `maxOutputTokens` | 4096 | paragraphPlan 可能较长 |
| `timeout` | 30s | 比对话超时更长（推理量大） |

### 3.5 机械 QA 规则

```typescript
interface MechanicalQaResult {
  pass: boolean;
  issues: Array<{
    severity: 'fail' | 'warn';
    field: string;
    reason: string;
  }>;
}

function runMechanicalQa(bodyPlans: BodyPlan[]): MechanicalQaResult {
  const issues = [];

  // 1. bodyPlans 数量
  if (![2, 3].includes(bodyPlans.length)) {
    issues.push({ severity: 'fail', field: 'bodyPlans.length', reason: `必须为 2 或 3，当前 ${bodyPlans.length}` });
  }

  // 2. 每个 plan 的 value 全空
  for (const bp of bodyPlans) {
    for (const block of bp.paragraphPlan.pointBlocks || []) {
      for (const step of block.steps || []) {
        if (String(step.value || '').trim()) {
          issues.push({ severity: 'fail', field: `bodyPlans.${bp.id}.${block.id}.${step.key}.value`, reason: 'Planner 输出的 value 必须为空' });
        }
      }
    }
  }

  // 3. key 唯一性（跨所有 body）
  const allKeys = new Set<string>();
  for (const bp of bodyPlans) {
    for (const block of bp.paragraphPlan.pointBlocks || []) {
      for (const step of block.steps || []) {
        if (allKeys.has(step.key)) {
          issues.push({ severity: 'fail', field: `step.key`, reason: `重复的 key: ${step.key}` });
        }
        allKeys.add(step.key);
      }
    }
  }

  // 4. mode 合法性
  const validModes = ['single_point', 'total_then_points', 'direct_points'];
  for (const bp of bodyPlans) {
    if (!validModes.includes(bp.paragraphPlan.mode)) {
      issues.push({ severity: 'fail', field: `bodyPlans.${bp.id}.mode`, reason: `非法 mode: ${bp.paragraphPlan.mode}` });
    }
  }

  // 5. argumentRelation 合法性
  const validRelations = ['supports', 'concedes', 'compares', 'solves', 'elaborates', 'side_by_side', 'parallel', 'causal'];
  for (const bp of bodyPlans) {
    if (bp.argumentRelation && !validRelations.includes(bp.argumentRelation)) {
      issues.push({ severity: 'warn', field: `bodyPlans.${bp.id}.argumentRelation`, reason: `非标准 relation: ${bp.argumentRelation}` });
    }
  }

  // 6. layoutPattern 合法性
  const validPatterns = ['concession_then_support', 'thematic_split', 'side_by_side', 'custom', 'support', 'concession', 'problem_solution', 'causal', 'parallel'];
  // layoutPattern 由 Planner 外层输出，不在 bodyPlans 内，需在外层校验

  return { pass: issues.filter(i => i.severity === 'fail').length === 0, issues };
}
```

### 3.6 降级策略

当 Planner LLM 调用失败或 QA 连续失败时，使用保守默认结构：

```typescript
function buildFallbackBodyPlans(questionType: string): BodyPlan[] {
  // 所有题型的通用保守结构：两个 single_point body
  return [
    {
      id: 'body-1',
      targetBody: 'Body Paragraph 1',
      paragraphDensity: 'single_point',
      argumentRelation: 'supports',
      paragraphPlan: {
        mode: 'single_point',
        diagnosis: '[fallback] 使用默认结构',
        pointBlocks: [{
          id: 'pb1',
          label: '分点 1',
          subClaim: '',
          role: 'major',
          expansionStrategy: 'mechanism',
          steps: [
            { key: 'pb1_s1', label: '分论点', placeholder: '用一句话写出本段核心主张', value: '', status: '' },
            { key: 'pb1_s2', label: '解释机制', placeholder: '解释这个主张为什么成立', value: '', status: '' },
            { key: 'pb1_s3', label: '例证', placeholder: '举一个具体场景作为例证', value: '', status: '' },
          ],
        }],
      },
    },
    {
      id: 'body-2',
      targetBody: 'Body Paragraph 2',
      paragraphDensity: 'single_point',
      argumentRelation: 'supports',
      paragraphPlan: {
        mode: 'single_point',
        diagnosis: '[fallback] 使用默认结构',
        pointBlocks: [{
          id: 'pb2',
          label: '分点 2',
          subClaim: '',
          role: 'major',
          expansionStrategy: 'mechanism',
          steps: [
            { key: 'pb2_s1', label: '分论点', placeholder: '用一句话写出本段核心主张', value: '', status: '' },
            { key: 'pb2_s2', label: '解释机制', placeholder: '解释这个主张为什么成立', value: '', status: '' },
            { key: 'pb2_s3', label: '例证', placeholder: '举一个具体场景作为例证', value: '', status: '' },
          ],
        }],
      },
    },
  ];
}
```

---

## 4. Coach Agent + Intent Agent 设计

### 4.1 职责分离

| | Coach Agent | Intent Agent |
|---|---|---|
| **职责** | 与学生进行苏格拉底式对话 | 从对话中提取意图，输出结构化状态变更 |
| **temperature** | 0.7 | 0.1 |
| **输出格式** | 自然语言（带 Markdown） | 严格 JSON（Gemini response_schema） |
| **是否并行** | 是（与 Intent Agent 同时调用） | 是（与 Coach Agent 同时调用） |
| **历史上下文** | 完整对话历史 + 当前 step 状态摘要 | 完整对话历史 + 当前 session 完整状态 |
| **如果犯错** | 话说得不好，下一轮可补救 | 状态变更错误 → 一致性断言拦截 → 自动重试 |

### 4.2 Intent Agent 的输出 Schema

```typescript
// Intent Agent 的 Gemini response_schema
interface IntentOutput {
  // 步骤级别的状态变更
  stageTransition?: {
    from: string;    // 当前阶段
    to: string;      // 目标阶段（仅在确实需要切换时）
    reason: string;  // 为什么切换
  };

  // 槽位级别的操作（Step 3 专用，其他 step 为空数组）
  slotUpdates?: Array<{
    key: string;                    // step key
    action: 'draft' | 'confirm' | 'reject';
    value?: string;                 // draft/confirm 时的文本
    rejectReason?: string;          // reject 时的原因
  }>;

  // 适配操作（Step 3 专用）
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

  // 结构变更请求（改 Body 论点）
  structureChangeOffer?: {
    kind: 'body_argument_change';
    summary: string;
    awaitConfirm: true;
  };

  // 完成标记
  completionFlag?: {
    isCompleted: boolean;
    reason: string;                 // 为什么判定完成/未完成
  };

  // 维度更新（Step 1 专用）
  dimensionUpdates?: Array<{
    label: string;
    status: 'probed' | 'expandable' | 'thin' | 'quality_pending';
  }>;
}

// Coach Agent 的输出（极简）
interface CoachOutput {
  text: string;     // Markdown 格式的对话文本
  hint?: string;    // 可选：给学生的一个简短提示
}
```

### 4.3 一致性断言

```typescript
interface ConsistencyResult {
  valid: boolean;
  issues: string[];
}

function validateTurnConsistency(
  coachOutput: CoachOutput,
  intentOutput: IntentOutput,
  session: PracticeSession,
  step: number,
): ConsistencyResult {
  const issues: string[] = [];

  // 1. 如果 Coach 说"进入下一步"但 Intent 没有标记完成 → warn（不阻断）
  // 2. 如果 Intent 标记完成但 Step 槽位未满 → REJECT
  // 3. 如果 Intent 操作了一个不存在的 slotKey → REJECT
  // 4. 如果 Intent 试图修改 confirmed 槽位 → REJECT
  // 5. 如果 Intent 的 adaptations 跨 pointBlock merge → REJECT
  // 6. 如果 Intent 的 stageTransition 跳过了必要阶段 → REJECT

  return { valid: issues.length === 0, issues };
}

// REJECT 时自动重试 Intent Agent（最多 1 次），带上 consistency issues
// 重试仍 fail → 丢弃 Intent 结果，仅返回 Coach 的对话文本 + 保守的 boardPatch
```

---

## 5. 数据契约

### 5.1 `session.step2_5` 类型

```typescript
interface Step2_5State {
  status: 'idle' | 'running' | 'passed' | 'failed' | 'stale';
  startedAt?: number;
  updatedAt?: number;
  attempt?: number;
  planSignature?: string;
  plannerIntermediate?: {
    // Planner 第2步 YAML 中间输出（调试用，不对学生展示）
    stance: string;
    argumentStrategy: string;
    argumentRelation: string;
    layoutPattern: string;
    bodyCount: number;
  };
  rationale?: string;          // Planner 的决策理由（内部）
  bodyPlans: BodyPlan[];
  errorMessage?: string;
}

interface BodyPlan {
  id: string;                  // "body-1" / "body-2" / "body-3"
  targetBody: string;          // "Body Paragraph 1"
  role: string;                // concession / main_argument / problem / solution / view_A / view_B / evaluation
  paragraphDensity?: 'single_point' | 'dual_point';
  argumentRelation?: string;
  paragraphPlan: ParagraphPlan;
}
```

### 5.2 API 返回格式（boardPatch）

```typescript
// 替代当前的 progressUpdate 大对象
interface CoachTurnResponse {
  text: string;                // Coach 的对话文本
  boardPatch: {
    step1?: Partial<Step1Board>;
    step2?: Partial<Step2Board>;
    step3?: Partial<Step3Board>;
    isCompleted?: boolean;
  };
  plannerStatus?: 'running' | 'passed' | 'failed';  // Step 2→3 过渡时
}
```

---

## 6. 实现计划

### 6.1 PR 切片

| PR | 内容 | 依赖 | 预计行数 |
|----|------|------|---------|
| **PR-A** | 类型扩展（types.ts）+ 文件骨架（src/server/ 目录） | 无 | ~200 |
| **PR-B** | Planner 实现（prompt + LLM 调用 + 机械 QA + 降级） | PR-A | ~500 |
| **PR-C** | Step 2→3 过渡：CTA 触发 Planner + 禁输入 + 等待跳转 | PR-B | ~300 |
| **PR-D** | Step 3 灌入 bodyPlans + kickoff 锁定 + 右侧看板适配 | PR-C | ~300 |
| **PR-E** | Coach Agent + Intent Agent 拆分（替换当前单体 LLM 调用） | PR-A | ~400 |
| **PR-F** | 一致性断言 + 拆旧 guards + 死代码清理 | PR-E | ~200 |

### 6.2 修改文件清单

| 文件 | PR | 改动类型 |
|------|-----|---------|
| `src/types.ts` | A | 新增 Step2_5State、BodyPlan、IntentOutput、CoachTurnResponse |
| `src/server/planner/planner.ts` | B | **新文件**：Planner 编排逻辑 |
| `src/server/planner/planner-fallback.ts` | B | **新文件**：降级默认结构 |
| `src/server/prompts/planner-prompts.ts` | B | **新文件**：题型分层策略枚举 prompt |
| `src/server/coach/coach-agent.ts` | E | **新文件**：Coach LLM 调用封装 |
| `src/server/coach/intent-agent.ts` | E | **新文件**：Intent LLM 调用封装 |
| `src/server/guards/consistency.ts` | F | **新文件**：轻量一致性断言 |
| `src/server/prompts/coach-prompts.ts` | E | **新文件**：各 Step Coach prompt |
| `src/server/prompts/intent-prompts.ts` | E | **新文件**：Intent prompt + schema |
| `server.ts` | B-F | 瘦身：路由 + 编排，删除死 guard 代码 |
| `src/components/Step2Brainstorm.tsx` | C | CTA 触发 Planner、禁输入、等待跳转 |
| `src/components/Step3Drafting.tsx` | D | 从 step2_5.bodyPlans 灌 plan、kickoff 锁定 |
| `src/components/CoachChat.tsx` | C/E | boardPatch 消费简化、running 禁用输入 |

### 6.3 不修改的文件

| 文件 | 原因 |
|------|------|
| `src/components/Step1Analysis.tsx` | Step 1 不在本次范围 |
| `src/components/Step4SentencePractice.tsx` | Step 4 不在本次范围 |
| `src/components/Header.tsx` | 不增加步骤 |
| `src/components/TopicSelector.tsx` | 不动 |
| `src/components/TopicImporter.tsx` | 不动 |
| `src/topics.ts` / `src/topicStorage.ts` | 不动 |
| `src/utils/step3Quality.ts` | 保留（Step 3 的 value 质量校验工具函数仍然需要） |
| Step 2 对话策略 | 保持 explore_A/B → stance → summary |

---

## 7. 验收标准

### PR-A 验收
- [ ] `types.ts` 中新增类型定义完整
- [ ] `src/server/` 目录结构创建
- [ ] TypeScript 编译通过（`tsc --noEmit`）

### PR-B 验收
- [ ] Planner prompt 覆盖全部 4 种题型、15 种策略
- [ ] 机械 QA 正确拒绝：value 非空 / bodyCount 不对 / key 重复 / mode 非法
- [ ] QA fail → 重试 1 次 → 仍 fail → 降级成功
- [ ] 降级策略输出的 bodyPlans 可用（value 全空、key 唯一、mode 合法）
- [ ] Planner 中间 YAML 输出记录在 `plannerIntermediate`

### PR-C 验收
- [ ] Step 2 `isCompleted` + CTA 出现 → 自动触发 Planner
- [ ] `running` 期间左侧 CoachChat 输入框禁用
- [ ] `passed` 后点击"进入第三步"正确跳转
- [ ] `failed` 后显示重试按钮，点击重试
- [ ] 超时 ~60s 自动标记 `failed`

### PR-D 验收
- [ ] Step 3 进入时 `subpoints[].paragraphPlan` 不为空
- [ ] 右侧看板正确展示 plan 的 pointBlocks / steps
- [ ] kickoff 第一条消息对准 firstEmpty（expand），不要求 LLM 造骨架
- [ ] kickoff 不包含 confirm bundle

### PR-E 验收
- [ ] Coach Agent 和 Intent Agent 并行调用（非串行）
- [ ] Coach Agent 输出自然语言对话，不再输出结构化状态
- [ ] Intent Agent 输出严格 JSON（response_schema），T=0.1
- [ ] 对话轮次延迟不高于当前（并行不增加延迟）

### PR-F 验收
- [ ] 一致性断言在 Intent 输出不合法时正确拦截
- [ ] REJECT 后自动重试 Intent Agent 1 次
- [ ] `applyStep3FrameworkGuard` 调用被移除
- [ ] `enforceFrameworkPointBlockCount` 调用被移除
- [ ] 旧 guard 中的"修正器"逻辑被删除（断言器保留）
- [ ] server.ts 行数显著减少

### 端到端验收
- [ ] `scripts/run-step1-3-e2e.mjs` 完整跑通 Step 1 → 2 → Planner → 3
- [ ] Step 1 不会无限循环
- [ ] Step 2 完成 → Planner 自动运行 → Step 3 进入时有完整 plan
- [ ] Step 3 的 paragraphPlan 稳定不漂移
- [ ] 所有 verify 脚本更新并通过
