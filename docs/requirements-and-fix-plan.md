# IELTS Writing Deconstruction Trainer — 需求、设计与修复方案

> 分支：`dev_dannielzhang` | 日期：2026-07-27 | 基于深度评估报告

---

## 目录

1. [系统概述](#1-系统概述)
2. [现有架构](#2-现有架构)
3. [核心问题诊断](#3-核心问题诊断)
4. [修复目标与需求](#4-修复目标与需求)
5. [数据契约](#5-数据契约)
6. [语义规范](#6-语义规范)
7. [实现计划](#7-实现计划)
8. [验收标准](#8-验收标准)

---

## 1. 系统概述

### 1.1 产品定位

一个交互式 IELTS Writing Task 2 训练器，用 LLM（Gemini）做实时 AI Coach，引导用户按四步完成一篇大作文的逻辑构建：

- **Step 1（审题分析）**：识别题型、提取核心议题与关键限定词、发散分析维度
- **Step 2（立场与论点）**：A 面/B 面探索 → 明确立场 → 形成蓝图（position + 两个 body 分论点）
- **Step 3（段落论证起草）**：为每个 Body Paragraph 构建逻辑链（claim → reason → mechanism → example → impact），逐槽填充
- **Step 4（逐句练习）**：将论证链升级为学术句式

### 1.2 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19 + TypeScript + Tailwind CSS 4 + Motion (Framer) |
| 后端 | Express.js + tsx（开发期）/ esbuild（构建） |
| AI | Google Gemini（多模型 fallback） |
| 构建 | Vite（前端）+ esbuild（服务端） |

### 1.3 关键设计原则

- **Coach 对话式推进**：每一步通过 Chat 交互推进，不是填表
- **苏格拉底式提问**：AI 提问引导，不直接给答案
- **confirm-then-write**：Step 3 中学生确认后才写入右侧看板
- **服务端门禁**：每步完成由服务器 guards 判定，不可绕过

---

## 2. 现有架构

### 2.1 前端组件树

```
App.tsx
├── Header.tsx           ← 步骤导航（1-4）+ 重置
├── TopicSelector.tsx     ← 选题（预设 + 导入）
├── TopicImporter.tsx     ← 导入自定义题目
├── Step1Analysis.tsx     ← 审题：CoachChat + 诊断报告看板
├── Step2Brainstorm.tsx   ← 立场与论点：CoachChat + 蓝图看板
├── Step3Drafting.tsx     ← 段落论证：CoachChat + 逻辑链看板
├── Step4SentencePractice.tsx ← 逐句练习
└── CoachChat.tsx         ← 通用聊天组件（被 Step1-4 复用）
```

### 2.2 后端 API 路由

| 路由 | 用途 |
|------|------|
| `GET /api/health` | 健康检查 + API Key 状态 |
| `POST /api/coach/chat` | **核心路由**：所有 Step 的对话交互 |
| `POST /api/coach/evaluate-step1` | Step 1 独立评估 |
| `POST /api/coach/evaluate-step2` | Step 2 独立评估 |
| `POST /api/coach/evaluate-step3` | Step 3 独立评估 |
| `POST /api/brainstorm-dimensions` | Step 2 维度灵感卡片 |
| `POST /api/generate-seeds` | 论据种子生成 |
| `POST /api/induce-thesis` | 立场归纳 |
| `POST /api/recommend-template` | 模板推荐 |
| `POST /api/analyze-argumentation` | 论证分析 |
| `POST /api/inline-action` | 内联操作 |
| `POST /api/generate-sentence-tasks` | Step 4 句子任务生成 |
| `POST /api/evaluate-sentence-practice` | Step 4 句子评估 |
| `POST /api/inline-guidance` | Step 4 内联指导 |
| `POST /api/match-sentence-task` | Step 4 句子匹配 |

### 2.3 核心数据流

```
Session (localStorage + 内存)
  ├── topic: Topic
  ├── currentStep: 1|2|3|4
  ├── step1: { userAnalysisNotes, coachEvaluation, chatHistory[], boardOverrides, isCompleted }
  ├── step2: { userStance, userPoints, coachEvaluation, chatHistory[], isCompleted }
  ├── step3: { subpoints[], activeSubpointId, isCompleted }
  │   └── subpoint: { id, content, paragraphPlan?, structureSteps?, chatHistory[], isCompleted }
  ├── step4: { tasks[], isCompleted }
  └── memory: { step1, step2, step3 }  ← cross-step digests
```

### 2.4 Step 状态机（现有）

```
Step 1: 对话中 → isCompleted + CTA「进入第二步」→ 解锁跳转按钮
Step 2: explore_A → explore_B → stance → summary → isCompleted + CTA → 跳转
Step 3: 选分论点 → 对话出 paragraphPlan → 逐槽 confirm → 全部完成 → 跳转
Step 4: 生成任务 → 逐句练习
```

---

## 3. 核心问题诊断

### 3.1 根本原因：Step 2.5 Planner 缺失

`docs/step2-5-architecture.md` 设计了完整的 Planner 流程，但**代码中零实现**。

**后果链：**

```
Step 2 完成（有 position + clustering，无 paragraphPlan）
  → Step 3 的 kickoffPrompt 要求 LLM 先生成 paragraphPlan
  → LLM 身兼二职：结构作者 + 逐槽教练
  → 每轮对话 LLM 都可能改 plan 结构（mode / pointBlocks / beats）
  → applyStep3FrameworkGuard 在服务端继续自动调整结构
  → frameworkSignature 持续漂移
  → 服务器拒绝合并旧 plan（frameworkDrifted）
  → plan 被清空 → LLM 重新造 → 再次漂移
  → 恶性循环，流程卡死
```

### 3.2 次要问题

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 2 | `applyStep3FrameworkGuard` 是"结构作者"，与设计文档矛盾 | `server.ts` L5129，5 个调用点 | 每轮自动改 plan 结构，与 LLM 冲突 |
| 3 | `server.ts` 约 12,000 行单体巨石 | `server.ts` | 调试困难，逻辑纠缠 |
| 4 | Step 1 维度收集最低 3 个可展开维度 | `enforceStep1SlotCompletion` | 学生可能无话可说时卡住 |
| 5 | confirm-then-write 状态机依赖 `step3SlotEval` 但 LLM 不总是正确输出 | `enforceStep3LogicCompletionInner` | 槽位可能永远无法确认 |
| 6 | Step 3 kickoff 的 `kickoffPrompt` 要求 LLM 规划骨架但无预生成的 plan | `Step3Drafting.tsx` | LLM 自建骨架不稳定 |
| 7 | 缺少 Step 2.5 的 API 端点 | `server.ts` | 无法独立触发 Planner |

---

## 4. 修复目标与需求

### 4.1 总体目标

**让 Step 1 → Step 2 → Step 3 → Step 4 的完整流程可跑通**，不发生恶性循环或无限卡住。

### 4.2 核心需求（按优先级）

#### R1：Step 2.5 Planner（P0 — 阻塞）

在 Step 2 完成（CTA 出现）后、用户点击"进入第三步"前，运行一个 Planner 为每个 Body Paragraph 预生成 `paragraphPlan`。

**输入：**
- 题目文本
- Step 1 审题结论（correctType / coreIssue / constraints / suggestedDimensions）
- Step 2 立场与蓝图（position / bodies / clustering / argumentRelation）

**输出：**
- `session.step2_5.bodyPlans[]`：每个 Body Paragraph 一个 `ParagraphPlan`
  - `mode`：`single_point` | `total_then_points` | `direct_points`
  - `diagnosis`：诊断文本（内部，不对学生展示）
  - `pointBlocks[]`：每个分点一个 block
    - `id` / `label` / `role`（major|minor）/ `subClaim` / `expansionStrategy`
    - `steps[]`：逻辑链步骤（`key` / `label` / `placeholder` / `value=""` / `status=""`）
  - `optionalShortClosing`：可选收束句

**约束：**
- 所有 `steps[].value` **必须为空字符串**
- `bodyPlans.length` 为 2 或 3
- `steps[].key` 在同一个 plan 内唯一
- 不依赖 stance（部分题型不需要立场）

**触发时机：**
- Step 2 `isCompleted === true` 且 CTA「进入第三步」出现时
- 或 Step 3 检测到旧 session 无 `step2_5` 时自动补跑

#### R2：Step 3 去结构作者化（P0 — 阻塞）

Step 3 的 LLM Coach **不再**负责生成/修改 paragraphPlan 的**段级骨架**。

**LLM 可以做的（槽位适配）：**
- 在已有 plan 的第一个空槽（firstEmpty）上 `expand`（追问）
- 内容合理但错槽 → `reclass`（改 label）
- 一句话盖两拍 → `merge`（合并槽位）
- 缺论证环节 → `add`（新增空槽）
- 太浅 → `reject`（拒绝并追问）
- 学生完成当前槽 → `confirm` + `pendingText`

**LLM 不能做的（段级只读）：**
- 改 `mode`
- 增减 `pointBlocks` 数量
- 改 `argumentRelation`
- 改 `paragraphDensity`
- 在 kickoff 时造新的 plan 骨架

**服务端职责：**
- 冻结已确认（confirmed）槽位
- 校验 adaptations 的合法性（key 存在、不跨 block merge 等）
- 执行 adaptations 后立即生效
- provenance firewall：模型不能预填后续空槽

#### R3：Step 2.5 QA（P1）

Planner 输出后必须经过质量检查：

- **机械 QA（纯代码）：** value 全部为空、bodyPlans 数量正确、key 唯一、mode 合法
- **LLM QA（可选增强）：** 链形是否贴合本题、beat 覆盖是否合理

QA 失败 → 重试（最多 2 次）→ 仍失败 → `failed` 状态，UI 可手动重试。

#### R4：Step 1 维度收集宽松化（P1）

- 保持最低 3 个可展开维度，但增加"不再补充"选项
- Step 1 对话超过一定轮数后自动标记 exitOffered

#### R5：代码重构（P1）

- 将 `server.ts` 的 guards 拆分为独立模块
- 将 Step 2.5 Planner 作为独立模块
- 将 prompt 模板集中管理

#### R6：adaptations + structureChangeOffer（P2）

- 实现 LLM 声明的槽位适配操作
- 实现改 Body 论点时的确认 → 重规划流程

---

## 5. 数据契约

### 5.1 `session.step2_5` 类型定义

```typescript
interface Step2_5State {
  status: 'idle' | 'running' | 'passed' | 'failed' | 'stale';
  startedAt?: number;          // Date.now()
  updatedAt?: number;
  attempt?: number;            // Planner 重试次数，上限 2
  qaDepth?: 'mechanical' | 'full';
  planSignature?: string;      // 题目 + 立场 + clustering 指纹
  qaReport?: {
    pass: boolean;
    rubric?: string;           // 内部，不对用户展示
    issues: Array<{
      severity: 'fail' | 'warn';
      bodyId?: string;
      stepKey?: string;
      reason: string;
      fixHint?: string;
    }>;
  };
  bodyPlans: BodyPlan[];
  errorMessage?: string;
}

interface BodyPlan {
  id: string;                  // "body-1" / "body-2"
  targetBody: string;          // "Body Paragraph 1"
  theme?: string;
  content?: string;
  paragraphDensity?: 'single_point' | 'dual_point';
  argumentRelation?: ArgumentRelation;
  pointRoles?: BodyPointRole[];
  mappedPoints?: string[];
  paragraphPlan: ParagraphPlan; // value 全空
}
```

### 5.2 `step3SlotEval` 类型定义（扩展）

```typescript
interface Step3SlotEval {
  mode: 'expand' | 'confirm' | 'reject';
  targetKey?: string;          // 目标 step.key
  qualified?: boolean;         // confirm mode 时内容是否合格
  pendingText?: string;        // confirm mode 时的润色后草稿
  rejectReason?: string;       // reject mode 时的原因
  adaptations?: Adaptation[];  // 槽位适配操作（立即生效）
  structureChangeOffer?: {     // 改 Body 论点
    kind: 'body_argument_change';
    summary: string;
    awaitConfirm: true;
  };
}

type Adaptation =
  | { op: 'reclass'; key: string; newLabel: string }
  | { op: 'merge'; fromKeys: string[]; intoKey: string; newLabel: string }
  | { op: 'add'; afterKey: string; blockId: string; key: string; label: string; placeholder: string }
  | { op: 'skip'; keys: string[] };
```

### 5.3 ParagraphPlan 类型（已有，确认语义）

```typescript
interface ParagraphPlan {
  mode: 'single_point' | 'total_then_points' | 'direct_points';
  diagnosis: string;
  totalClaim?: string;          // total_then_points 模式的总观点
  pointBlocks: ParagraphPointBlock[];
  optionalShortClosing?: string;
}

interface ParagraphPointBlock {
  id: string;
  label: string;               // 显示标签，如 "课堂监管"
  subClaim: string;            // 分点主张
  role: 'major' | 'minor';
  expansionStrategy: 'explanation' | 'example' | 'mechanism' | 'impact' | 'contrast' | 'hybrid';
  steps: LogicStep[];
}

interface LogicStep {
  key: string;                 // 唯一标识，如 "pb1_s1"
  label: string;               // 显示标签，如 "具体机制"
  placeholder: string;         // 占位提示
  value: string;               // 学生填充内容（Planner 输出时为空）
  status: '' | 'draft' | 'confirmed';  // Planner 输出时为空
}
```

---

## 6. 语义规范

### 6.1 Step 完成判定

| Step | isCompleted = true 的条件 |
|------|--------------------------|
| Step 1 | `correctType` + `coreIssue` + `constraints`（或 constraintsSkipped）+ 至少 3 个可展开维度 + exitOffered + CTA「进入第二步」 |
| Step 2 | `summary` 阶段 + CTA「进入第三步」+ position + 至少 2 个 body 有内容 |
| Step 3 | `step3Ui.isStep3Finished === true`（由服务端 `attachStep3UiProgress` 判定：所有 body 的 `isCompleted === true`） |
| Step 4 | 所有 sentence tasks 完成 |

### 6.2 Step 2.5 状态机

```
idle
  │ Step 2 isCompleted + CTA 出现
  ▼
running  ── 左侧输入禁用 ──┐
  │                        │
  │ QA pass                │ 超时 ~60s / 异常
  ▼                        ▼
passed ◄── 指纹一致 ── failed
  │                        │
  │ Step 2 指纹变化         │ UI 可重试
  ▼                        └──► running
stale ──► running
```

**跳转 Step 3 硬条件：** `status === 'passed'` 且 `planSignature` 与当前 Step 2 状态一致。

### 6.3 frameworkSignature 计算

```typescript
// 用于 Step 3 检测 plan 是否过期
function computeFrameworkSignature(session: PracticeSession): string {
  const parts: string[] = [];
  // 题目
  parts.push(session.topic.question);
  // Step 2 立场
  parts.push(session.step2.coachEvaluation?.blueprint?.position || '');
  // Step 2 各 body 的 content + argumentRelation
  for (const body of session.step2.coachEvaluation?.clustering?.clusters || []) {
    parts.push(`${body.content}|${body.argumentRelation || ''}`);
  }
  return stableHash(parts.join('\n'));
}
```

### 6.4 planSignature 计算

```typescript
// 用于 Step 2.5 检测 stale
function computePlanSignature(session: PracticeSession): string {
  // = frameworkSignature 的逻辑，但基于 Step 2 的当前内容
  return computeFrameworkSignature(session);
}
```

### 6.5 confirm-then-write 状态机（Step 3，保留并修复）

```
每一轮对话：
  1. 冻结所有已确认（status=confirmed）的槽位 → 保留 value+label+key
  2. 清除所有未确认槽位的 value（防止模型预填）
  3. 从 step3SlotEval 读取 mode：
     - expand  → 生成追问（对准 firstEmpty），不写 value
     - confirm  → 校验 pendingText → 写入 value + 标记 draft
     - reject   → 生成追问，不写 value
  4. 学生 affirm（"对/是的/好的"） → draft → confirmed（冻结）
  5. provenance firewall：除 firstEmpty 和相邻槽外，不允许写入
  6. 所有槽位 confirmed → 标记 subpoint.isCompleted
  7. 所有 subpoints 完成 → 标记 step3.isCompleted
```

### 6.6 adaptations 语义

| op | 含义 | 合法性约束 |
|----|------|-----------|
| `reclass` | 改步骤标签 | key 必须存在；不能是 confirmed 槽 |
| `merge` | 合并两个相邻槽 | fromKeys 必须在同一个 pointBlock 内；不能跨 block |
| `add` | 在两个步骤间插入新槽 | afterKey 必须存在；key 不能重复 |
| `skip` | 跳过某些槽 | 跳过的槽不能有 confirmed 值 |

**adaptations 立即生效，否认 pendingText 不回滚 adaptations。**

### 6.7 关键术语定义

| 术语 | 定义 |
|------|------|
| **CTA** | Call-to-Action：AI 明确告知学生"点击下一步按钮进入下一阶段" |
| **firstEmpty** | paragraphPlan 中第一个 value 为空且 status 不为 confirmed 的 step |
| **pendingText** | LLM 在 confirm 模式下为学生撰写的润色后草稿，等待学生 affirm |
| **draft** | 已写入 value 但尚未学生确认的步骤状态 |
| **confirmed** | 学生 affirm 后的冻结状态，不可再修改 |
| **provenance firewall** | 防止模型在一次对话中预填多个未确认槽位的保护机制 |
| **frameworkDrifted** | Step 2 的框架在 Step 3 进行中发生了变化（如换了分论点） |
| **stale** | Step 2.5 的 planSignature 与当前 Step 2 状态不一致 |
| **no-stance** | 题型不要求个人立场（如纯 Problem/Solution、Two-part Question） |

---

## 7. 实现计划

### 7.1 PR 切片

| PR | 内容 | 预计行数 | 验收 |
|----|------|---------|------|
| **PR-A** | types 扩展 + `step2_5` API + CTA 触发 + 禁输入 + 等待跳转 | ~300 行 | 手动走通 Step 2→Step 3 跳转，plan 正确灌入 |
| **PR-B** | Step 3 读 2.5 plan + kickoff 锁定 + 禁造骨架 | ~200 行 | `verify-step-openers.mjs` 通过 |
| **PR-C** | Planner QA（机械 + LLM） | ~200 行 | 手动触发 QA fail → 重试 → pass |
| **PR-D** | 拆除 `applyStep3FrameworkGuard` 结构作者 + 补拍逻辑 | ~150 行（删） | `verify-slot-reuse.mjs` 更新通过 |
| **PR-E** | adaptations 执行器 + structureChangeOffer | ~200 行 | 手动测试 reclass/merge/add/skip |
| **PR-F** | 死代码清理 + 重构 + 回归测试 | ~100 行 | 全量 verify 脚本通过 |

### 7.2 修改文件清单

| 文件 | PR | 改动 |
|------|----|------|
| `src/types.ts` | A | 新增 `Step2_5State`、扩展 `Step3SlotEval` |
| `server.ts` | A-F | 新增 2.5 API、Planner prompt、QA、adaptations 执行器；删除 FrameworkGuard；重构 |
| `src/components/Step2Brainstorm.tsx` | A | CTA 触发 2.5、禁输入、等待跳转 |
| `src/components/Step3Drafting.tsx` | B | 从 `step2_5.bodyPlans` 灌 plan、kickoff 锁定 |
| `src/components/CoachChat.tsx` | A/E | running 禁用输入、执行 adaptations 刷新 |
| `scripts/verify-step-openers.mjs` | B | 更新断言 |
| `scripts/verify-slot-reuse.mjs` | D | 更新断言 |

### 7.3 不修改的文件（冻结）

- `src/components/Step1Analysis.tsx`
- `src/components/Step4SentencePractice.tsx`
- `src/components/Header.tsx`
- `src/components/TopicSelector.tsx`
- `src/components/TopicImporter.tsx`
- `src/topics.ts`
- `src/topicStorage.ts`
- Step 2 explore_A → explore_B → stance → summary 对话策略

---

## 8. 验收标准

### 8.1 PR-A 验收

- [ ] `session.step2_5` 有正确的 TypeScript 类型
- [ ] Step 2 `isCompleted` 时自动触发 POST `/api/step2_5/plan`
- [ ] `running` 期间左侧 CoachChat 输入框禁用
- [ ] `passed` 后点击"进入第三步"正确跳转
- [ ] `failed` 后显示重试按钮
- [ ] 超时 ~60s 自动标记 `failed`

### 8.2 PR-B 验收

- [ ] Step 3 进入时 `subpoints[].paragraphPlan` 不为空
- [ ] 右侧看板正确展示 plan 的 pointBlocks / steps
- [ ] kickoff 第一条消息对准 firstEmpty（expand），不要求 LLM 造骨架
- [ ] kickoff 不包含 confirm bundle / pendingText
- [ ] `verify-step-openers.mjs` 全部通过

### 8.3 PR-C 验收

- [ ] 机械 QA 正确拒绝：value 非空的 plan / bodyPlans 数量不对 / key 重复
- [ ] QA fail 后 Planner 重试最多 2 次
- [ ] 2 次仍 fail → `failed` 状态

### 8.4 PR-D 验收

- [ ] `applyStep3FrameworkGuard` 不再在 Step 3 对话路径中被调用
- [ ] `enforceFrameworkPointBlockCount` 不再被调用
- [ ] `ensureArgumentRelationCoverage` / `ensureConcessionStructure` 的 Step 3 调用被移除
- [ ] Step 3 对话中 plan 结构不再每轮变化
- [ ] `verify-slot-reuse.mjs` 更新通过

### 8.5 PR-E 验收

- [ ] `reclass`：LLM 声明改 label → 服务端验证 key 存在 → 立即更新 label
- [ ] `merge`：LLM 声明合并两个槽 → 服务端验证同 block → 合并
- [ ] `add`：LLM 声明插入新槽 → 服务端验证 → 插入
- [ ] `skip`：跳过未使用的槽
- [ ] `structureChangeOffer`：LLM 声明改 Body 论点 → 用户确认 → 清 Step 3 → 2.5 重跑

### 8.6 端到端验收

- [ ] 用 `scripts/run-step1-3-e2e.mjs` 完整跑通 Step 1 → Step 2 → Step 3
- [ ] Step 1 不会无限循环
- [ ] Step 2 正确触发 2.5
- [ ] Step 3 的 paragraphPlan 稳定不漂移
- [ ] 所有 verify 脚本通过
