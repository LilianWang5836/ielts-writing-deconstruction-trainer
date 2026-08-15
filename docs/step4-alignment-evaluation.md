# 阶段1 详细工作评估：Step4 与会议秘书架构对齐

> 分支：`restructure` | 日期：2026-08-15
> 范围：评估是否/如何把 Step4（逐句写作）对齐到 Step1-3 已完成的会议秘书架构（skeleton + minutes 唯一真相源）。
> 方法：源码分析（子代理研究报告）+ 真实会话数据验证（浏览器 localStorage 的已通关 Step3 会话）。

---

## 0. 结论速览

**存在一个真实的、可复现的、影响上线质量的数据源脱节 bug**：Step3 的内容全部写入 `minutes`，而 Step4 的 `/api/generate-sentence-tasks` 仍只从旧字段 `paragraphPlan.steps[].value` 提取句子 → **在秘书路径下 Step4 的 Body 句子任务完全缺失（实测仅返回 intro/conclusion，0 个 Body 任务）**，Step3 产出的完整论证内容全部丢失。

**✅ 2026-08-15 已修复（commit `d676c02`）**：方案 A（minutes 优先提取）已实施并实测验证——修复前 Body 任务=0，修复后 **16 个任务完整**（Intro2 + Body1×4 + Body2×4 + Body3×5 + Conc1），全新对话 E2E Step1→4 全环节走通，Body 句子内容与 Step3 minutes 一致。详见 §5。

---

## 1. 核心发现：Step4 与秘书架构零数据交互

### 1.1 数据流对比

```
Step3 秘书路径（已上线）:
  LLM 输出 → 秘书落槽(minutes) → 看板投影(skeleton+minutes)
  └─ 内容真相源 = minutes（skeleton 只存结构，无 value）

Step4 现状:
  Step3 subpoints ─原样透传→ /api/generate-sentence-tasks
                                    └─ 只读 paragraphPlan.pointBlocks[].steps[].value ← 已空！
```

### 1.2 真实会话数据验证（铁证）

从浏览器已通关的 Step3 会话（`ielts_deconstruct_session`）读取：

| Subpoint | skeleton | minutes 总数 | minutes confirmed | paragraphPlan steps 有 value | skeleton subClaim |
|----------|----------|-------------|-------------------|------------------------------|-------------------|
| body-1 | ✅ 1 block | 5 | **4**（完整：分论点/原因/机制/结果） | **0 / 4 全空** | 空 |
| body-2 | ✅ 2 blocks | 3 | **2**（完整：学习灵活性/学习成本补充点） | **0 / 2 全空** | 空 |

**直接后果**：`extractBodySentences(plan)` 读到的 `steps[].value` 全空、`subClaim` 空 → Body 句子任务退化为空；仅 `block.label`（如"教学效果"）和 `sp.theme` 仍可用作方向提示。**Step3 辛苦产出的完整论证内容，到 Step4 全丢了。**

### 1.2b 实测复现（2026-08-15，通过 Vite 代理调用真实 API）

用上述真实会话的 `step3.subpoints` 调用 `/api/generate-sentence-tasks`：

```
请求：question + selectedThesis(部分同意) + subpoints(2 body，含 6 条 confirmed minutes)
返回：HTTP 200，tasks = [
  { id: intro-1,       section: intro,       concept: "有人认为在线学习优点突出…" },
  { id: intro-2,       section: intro,       concept: "我对此持部分赞同态度…" },
  { id: conclusion-1,  section: conclusion,  concept: "综上所述，在线学习虽在灵活性…" },
]
Body 任务：⚠️ 0 个（完全缺失）
```

**结论**：Step3 的 body-1（4 条完整论证）+ body-2（2 条补充点）在 Step4 的句子任务中**全部丢失**。学生进入 Step4 只见 intro/conclusion，主体段逐句练习直接缺失——**实测复现的上线级功能缺陷**。

### 1.3 三条硬证据（为何旧字段为空）

1. **Step3 系统 prompt**（server.ts:8311）明令 LLM 不输出 `paragraphPlan`/`step3SubpointSteps`/`steps[].value`，标注 "legacy and the server no longer reads them"
2. **`toSkeleton`/`planToSkeleton`**（step3Skeleton.ts）自述只保留结构、"丢弃 value/status 等内容字段（内容归 minutes 管）"
3. **`prefillClaimSlotsFromSubClaims`**（step3ClaimPrefill.ts:139）是显式 no-op，`demoteThemeHeadSubClaims` 清空主题词 subClaim

---

## 2. 四个 Step4 端点逐一评估

| 端点 | 现状 | 与秘书脱节程度 | 影响 |
|------|------|---------------|------|
| `/api/generate-sentence-tasks`（10096） | 从 `paragraphPlan.steps[].value`/`subClaim` 提取源句子 | **严重**（Body 句子退化） | **上线级 bug** |
| `/api/evaluate-sentence-practice`（10673） | 入参仅单句 `concept`+`userDraft`，LLM 对照单句生成 annotations | 无（单句级，不需 minutes） | 正常 |
| `/api/inline-guidance`（10866） | 生成式指导，scopeText+draft+intent，无状态 | 无 | 正常 |
| `/api/match-sentence-task`（11085） | 纯语义匹配 userDraft→candidates | 无 | 正常 |

→ **只有 `generate-sentence-tasks` 一个端点需要对齐**（从 minutes 提取），其余三个端点是自洽的生成式/评估式，无需 minutes。

---

## 3. 前端复杂度评估（Step4SentencePractice.tsx，1669 行）

### 3.1 问题清单
- **22 个 useState + 7 个 useRef**，单组件承载"状态机 + API 编排 + 重型展示"
- **4 个死状态**：`guidance`/`guidanceIntent`/`guidanceQuestion`/`showGuidance` 只被 set/reset，渲染层从不读——历史胶水残留
- **重复 JSX**：prompts 主列表与「+N 条更多」折叠块近乎相同拷贝；全文抽屉与完成态全文列表各自迭代 `sectionOrder→sectionTaskMap`
- **body 计数锚定错误**：`expectedBodyCount`（464）用 `sp.paragraphPlan` 而非 `skeleton` 判定（次要，因 subpoint 恒有 id，实际≈length）

### 3.2 评估
- 前端重构**不是修复数据源脱节的前提**（前端本就原样透传，病灶在服务端）
- 重构收益：可维护性提升，但**不改 bug**；成本高（1669 行单组件拆分的回归风险）
- **建议降级为可选/后续**，不作为阶段1主线

---

## 4. Step4 测试现状

- scripts/ 下**无任何 Step4 端点级测试**
- E2E 脚本（replay-student-multi 等）**不走真实 Step4 链路**（脚本自述用模拟英文句 + coach-chat 代答），因此**从未暴露过此脱节 bug**
- 4 个单元测试（secretary/replay/lens/guards）均无 Step4 覆盖

→ 这是 bug 长期潜伏的原因：**E2E 没有真正驱动 Step4 的 generate-sentence-tasks**。

---

## 5. 决策建议（按价值/成本排序）

### ✅ 方案 A：服务端对齐 minutes（✅ 已实施，commit `d676c02`）
在 `/api/generate-sentence-tasks` 增加 **minutes 优先提取路径**（`extractBodySentencesFromMinutes`）：
```
优先：sp.minutes 中 status=confirmed 且按骨架 slotKey 顺序排序的文本
      —— 每段得到"分论点/原因/机制/影响/例子"的完整句子序列
回退：现有 paragraphPlan.steps[].value 逻辑（旧会话兼容）
```
- **实测验证**：
  - 修复前：调用返回 3 个任务（Intro2+Conc1，Body 0 个）
  - 修复后：返回 **16 个任务**（Intro2 + Body1×4 + Body2×4 + Body3×5 + Conc1），Body 句子全部来自 Step3 minutes
  - 全新对话 E2E：Step1→2→3→4 全环节走通，Step4 Body1/3 句子任务内容与 Step3 minutes 完全一致
- **回归**：tsc 0 错误；4 单测 60/60

### ⭕ 方案 B：前端拆分重构（可选，低价值高成本）
拆 `Step4SentencePractice.tsx` 子组件 + 删死状态 + 去重 JSX。
- 不改 bug；回归风险高；**建议后续再做，或不做**

### ⭕ 方案 C：Step4 完整"秘书化"（远期，价值待验证）
把 Step4 也纳入确定性落槽（如"句式"槽位 + 透镜判定）。
- **本质区别**：Step4 产出成品句而非填论证槽，是否需落槽值得商榷
- **建议**：先做 A 观察真实效果，再评估 C 的价值

### 🧪 配套：E2E 补真实 Step4 链路
给 `replay-student-multi.mjs` 增加"驱动真实 `/api/generate-sentence-tasks`"的步骤，避免此类脱节长期潜伏。

---

## 6. 推荐执行计划（阶段1 重定义）

```
Step A1 ✅ 已完成（d676c02）  修复 /api/generate-sentence-tasks：extractBodySentences 增加 minutes 优先提取
Step A2 ⏳ 待做（低优先）     补 generate-sentence-tasks 单测（含 minutes 的 subpoint 断言）
Step A3 ✅ 已完成（本次 E2E） 全新对话全环节测试：Step1→4 走通，Step4 16 任务完整，Body 内容与 minutes 一致
Step A4 ⏳ 待做（低优先）     补 E2E 脚本的真实 Step4 驱动
Step B  （后续）              前端拆分重构（死状态清理 + 子组件抽取）——可单独排期
Step C  （远期）              评估 Step4 完整"秘书化"价值
```

**阶段1 核心交付（方案 A）已完成**：实测从"Body 任务=0"恢复到"16 任务完整"，全新对话 E2E 全环节验证通过。剩余 A2/A4 为测试补充（低优先），前端重构（B）与完整秘书化（C）均非当前阻塞项。
