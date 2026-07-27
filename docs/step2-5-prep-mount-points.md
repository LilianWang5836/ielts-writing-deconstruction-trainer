# Step 2.5 落地准备：代码挂载点清单

配套方案：[`step2-5-architecture.md`](./step2-5-architecture.md)。  
配套用例：[`step2-5-prep-golden-cases.md`](./step2-5-prep-golden-cases.md)。

用途：实现时「删什么 / 改什么 / 不动什么」对照表，避免漏路径与 verify 不同相。

图例：`新增` · `改` · `删/停用` · `保留（非目标或仍需要）`

---

## 1. 前端挂载点

| 位置 | 现状 | 落地动作 | Phase |
|------|------|----------|-------|
| `Step2Brainstorm.tsx` → `showNextStepButton` | CTA 依赖 `进入第三步` + blueprint 内容 | **改**：为 true 时幂等触发 2.5；`running` 禁输入；点击等待/自动跳 | A |
| `Step2Brainstorm.tsx` → `onNextStep` | 直接进 Step3 | **改**：gated by `passed` + 指纹 | A |
| `Step2Brainstorm.tsx` → `kickoffPrompt` | Step2 开场 | **保留**（探索主流程非目标） | — |
| `CoachChat.tsx` → 输入框 disabled | loading 等 | **改**：`step2_5.status==='running'`（及 Step3 重规划 running）时禁用 | A/E |
| `CoachChat.tsx` → `progressUpdate` 合并 | step1/2/3 | **改**：合并 `step2_5`；执行后的 plan/adaptations 刷新 subpoints | A/E |
| `Step3Drafting.tsx` → subpoints 从 clustering 构建 | 空壳 + 等对话出 plan | **改**：优先 `step2_5.bodyPlans` 灌 `paragraphPlan` | B |
| `Step3Drafting.tsx` → `kickoffPrompt` ~L246 | 要求「先规划 paragraphPlan 骨架」 | **改**：锁定 plan，只问 firstEmpty expand；禁造骨架/confirm bundle | B |
| `Step3Drafting.tsx` → `frameworkSignature` | 漂移清 plan | **改/保留**：与 `planSignature` 对齐；漂移拒绝脏合并，不自动改结构 | B/D |
| `Step3Drafting.tsx` → 清页重规划 | 无 | **新增**：`structureChangeOffer` 确认后清空 subpoints/chat/UI | E |
| `Header.tsx` 步骤条 | 1–4 | **保留**（不增加 2.5） | — |
| `Step1Analysis.tsx` / `Step4*` | — | **保留**（非目标） | — |
| `types.ts` | 无 `step2_5` | **新增** 字段与 `adaptations` / `structureChangeOffer` | A |

---

## 2. 服务端挂载点（`server.ts`）

### 2.1 结构作者（Step3 路径 — 目标拆除）

| 符号 | 约略职责 | 落地动作 | Phase |
|------|----------|----------|-------|
| `applyStep3FrameworkGuard` | 改 mode + 调 block 数 + 补拍 | **删调用**；函数可删或废弃 | D |
| `enforceFrameworkPointBlockCount` | 修剪/对齐 pointBlocks | **删调用** | D |
| `ensureArgumentRelationCoverage` | 缺拍 `push` 到末尾 | **删调用**；语义归 2.5 QA | D |
| `ensureConcessionStructure` | 上者 compat wrapper | **删** | D |
| 调用点 ~5683 / ~5759 / ~5805 / ~9619 | FrameworkGuard 接入 completion | **改**：去掉 guard | D |
| Step3 prompt STEP 0/A「无 framework 自建骨架」 | LLM 当结构作者 | **改**：改为只读 2.5 锁定 plan | B/D |
| Step3 prompt 运行时补 beats / 自诊单多点 | 同上 | **删相关条文** | D |

### 2.2 槽位 / kickoff（保留核心，改契约）

| 符号 | 约略职责 | 落地动作 | Phase |
|------|----------|----------|-------|
| `enforceStep3LogicCompletion` / Inner | confirm→写 value、冻结 | **保留**；接入 `adaptations` 执行 | E |
| `step3SlotEval` 暂存 pending | 唯一 staging 源 | **保留**；扩展字段 | E |
| `hardRejectSlotText` | 语义硬拦 | **缩**：仅空串/占位符；深浅归 LLM `reject` | E |
| `collapseCoveredAdjacentStep3Slots` | 服务端启发式合并 | **停用自动路径**；改由 `adaptations.merge` | E |
| kickoff：`prepareStep3KickoffCoachText` 等 | 禁 kickoff confirm、salvage | **改**：假设 plan 已存在；对齐 firstEmpty expand | B |
| `kickoffPendingDrafts` | 历史 confirm-bundle | **保留兼容或逐步收紧**；kickoff 主路径不再造骨架 | B |
| `guardStep3ValueProvenance` / freeze confirmed | 防模型预填 | **保留** | — |

### 2.3 Step2（探索 — 原则上不动）

| 符号 | 落地动作 |
|------|----------|
| `enforceStep2Completion` / CTA「进入第三步」 | **保留**；CTA 出现作为 2.5 触发信号 |
| `applyNoStanceGate` / retention / stance material | **保留** |
| `stampStep2TaskBrief` | **保留** |

### 2.4 新增（方案）

| 项 | 说明 | Phase |
|----|------|-------|
| `POST /api/step2_5/plan` 或内部 job | Planner + QA 编排 | A |
| `computeStep25PlanSignature` | 题目+立场+clustering 指纹 | A |
| `runStep25MechanicalQa` | 纯函数机械底线 | A |
| `runStep25FullQa`（LLM） | rubric + 合理性 | C |
| `applyStep3Adaptations` | 校验并执行 op | E |
| running 超时扫描 | ~60s → failed | A |

---

## 3. Verify / 脚本（必须与删代码同相）

| 文件 | 相关断言（现状） | 落地动作 | Phase |
|------|------------------|----------|-------|
| `scripts/verify-slot-reuse.mjs` | 要求存在 `applyStep3FrameworkGuard`、`ensureArgumentRelationCoverage`、`hardRejectSlotText`、`collapseCoveredAdjacentStep3Slots` 等 | **同批改写**：断言「Step3 路径不再调用结构作者」；断言 adaptations 执行器 / 2.5 机械 QA 存在 | D/E |
| `scripts/verify-step-openers.mjs` | Step3 `kickoffPrompt` 要求规划骨架、expand、禁 confirm | **改**：断言「锁定 plan / 问 firstEmpty / 不提造骨架」 | B |
| 其他 verify | 按需 | 跑全量，失败项记入本表 | F |

**纪律：** Phase D/E 合并请求中，**删除实现与更新 verify 同一 commit/PR**，禁止先删后改脚本。

---

## 4. 非目标核对（禁止误改）

- [ ] Step1 探索 / 诊断逻辑与 UI 流程无功能改动（展示优化除外，不在本方案）
- [ ] Step4 无改动
- [ ] Step2 explore_A/B/stance/summary **对话策略**无改动（仅 CTA→2.5 触发与禁输入）
- [ ] Header 无「2.5」步骤
- [ ] 用户不可见 rubric / QA issues 原文

---

## 5. 建议 PR 切片

| PR | 内容 | Verify |
|----|------|--------|
| PR-A | types + API + CTA 触发 + 禁输入 + 等待跳转 | 新增 2.5 相关冒烟；不删 FrameworkGuard |
| PR-B | Step3 灌入 + kickoff 文案/兜底 | `verify-step-openers` 同步 |
| PR-C | full QA | 单测/脚本 |
| PR-D | 拆 FrameworkGuard/补拍 | `verify-slot-reuse` **同相** |
| PR-E | adaptations + structureChangeOffer | verify **同相** |
| PR-F | 死代码与回归清单勾选 | 全量 scripts |

---

## 6. 实现前勾选

- [ ] 已读 `step2-5-architecture.md` 定稿
- [ ] 已读黄金用例 G1–G15
- [ ] 本清单与当前 `server.ts` / 组件行号已目测核对（合并前再扫一遍 grep）
- [ ] Feature 顺序锁定：A → B → C → D → E → F（D 不早于 B）
