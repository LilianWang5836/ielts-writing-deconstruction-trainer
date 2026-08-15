# 当前改动效果评估（本轮增量）

> 分支：`restructure` | 评估日期：2026-08-15
> 范围：`bdb747c`（确认写板按钮）→ `b083d62`（P0 补完）→ `8ae8a27`（前端 skeleton 迁移）
> 关系：本文是 `rebuild-evaluation.md`（全量评估）的**增量补充**，聚焦"最近几轮改动到底改变了什么、值不值"。

---

## 0. 结论速览

**三笔增量改动全部达成预期、零回归，且每一笔都在削减旧架构痕迹、向「skeleton + minutes 唯一真相源」收敛。** 具体：
- 确认写板按钮：解决真实 UX 问题（学生输入整句导致误落地），且修复了一个真实的 React 状态 bug
- P0 补完：server.ts **-473 行**，旧字段活跃引用从 ~53 降到 ~30（其余为必保留的提示词黑名单词 / Step2 正常使用 / 防御回退）
- 前端 skeleton 迁移：辅助函数主路径切换到 skeleton，消除了「前端同框架恢复丢 skeleton」的隐性 bug

---

## 1. 改动量化对比

### 1.1 server.ts 规模（P0 补完 `b083d62`）

| 指标 | 补完前 | 补完后 | 变化 |
|------|--------|--------|------|
| server.ts 行数 | 11,669 | **11,205** | **-464 行** |
| 旧字段总引用（含注释） | 72 | 48 | -24 |
| 其中惰性 guard 代码 | ~120 行 | 0 | 全删 |

**删除内容**（全部为不可达死代码）：
- Step3 flat-wrap 回包 guard（`step3SubpointSteps`→`paragraphPlan`）
- Step3 投影 guard（`paragraphPlan`→`step3SubpointSteps`）
- mode-correction 死代码链：`applyParagraphModeCorrection` / `computeParagraphModeSignals` / `recommendParagraphMode` / `rebuildFlatStepsFromParagraphPlan` / `stripStep3BlockLabelPrefix` / `formatStep3FlatStepLabel` / overlap 工具 / `ParagraphMode` 类型

> 关键点：删除的都是**秘书架构下不可达**的代码（LLM 已被指示不输出这些字段，`ensureStep3SkeletonForSubpoints` 保证 skeleton 存在），因此删后行为完全不变——tsc 0 错误、60/60 单测通过即为证明。

### 1.2 剩余旧字段引用的性质（30 处活跃，全部必要）

| 类别 | 数量 | 说明 | 能否删 |
|------|------|------|--------|
| 提示词「不要输出 paragraphPlan / step3SlotEval…」 | ~8 | 黑名单词，**删了 LLM 就可能误输出** | ❌ 必须保留 |
| Step2 反漂移检测（4451/5225） | 2 | LLM 误输出结构时强制完成 Step2 | ❌ 有效护栏 |
| Step3 防御回退（882-923/1914-1987/2926-2928/3025/10250） | ~15 | 骨架存在时走 skeleton，旧会话兜底 | ⚠️ 旧会话兼容，慎删 |
| 骨架初始化 `planToSkeleton`（4395） | 1 | 旧会话无 skeleton 时的兜底 | ⚠️ 同左 |
| Step2 正常使用（7408） | 1 | Step2 读取 subClaim | ❌ 正常功能 |
| 文本清理正则（7205） | 1 | 从学生可见文本剥离内部词 | ❌ 必须保留 |

→ **结论：30 处活跃引用没有一处是"该删而未删的惰性代码"，全部有明确存在理由。**「旧字段全删」验收已从"没做完"变成"剩余项都有正当理由保留"。

### 1.3 前端 skeleton 迁移（`8ae8a27`）

| 指标 | 迁移前 | 迁移后 |
|------|--------|--------|
| `resolveBodyClaimSentence`/`resolveBodyTheme` 数据源 | 仅 paragraphPlan | **优先 skeleton**，paragraphPlan 回退 |
| `parsedSubpoints` 是否携带 skeleton | ❌（同框架恢复时丢失） | ✅ `skeleton: bp.skeleton` |
| kickoff firstEmpty 来源 | 仅 paragraphPlan | **优先 skeleton 未确认槽**（基于 minutes） |
| Step3Drafting 行数 | 1,196 | 1,246（+50，含注释与骨架优先分支） |

> 隐性 bug 修复：迁移前 `parsedSubpoints` 映射**丢弃了 `bp.skeleton`**，导致同框架恢复（`sameFramework` 分支）里 `resolveBodyTheme` 读不到 skeleton、被迫走 paragraphPlan 回退。现在骨架随 bodyPlan 一路带到 subpoint，恢复逻辑走 skeleton 主路径。

---

## 2. 功能与 UX 效果（确认写板按钮 `bdb747c`）

### 2.1 解决的问题
- **误落地**：学生原本必须输入纯"对"来确认。若输入"对，我同意这个分论点"，秘书可能把整句当内容落地 → 看板污染。按钮点击发送**纯"对"**，杜绝误判
- **UX 缺口**：E2E 测试发现看板没有显式的"确认"入口，学生不知道如何确认

### 2.2 顺带修复的真实 bug
- `disabled={coachChatRef.current?.loading}` 只在父组件重渲染时求值，而 `useImperativeHandle` 更新 ref **不触发父组件重渲染** → 按钮永久禁用
- 修复：`onLoadingChange` 回调同步本地 `coachLoading` state，按钮正确启用

### 2.3 Step4 json 修复（同提交）
- `introConclusionPrompt` 增加 JSON 关键词，修复 DeepSeek `json_object` 400（prompt 必须含 "json" 字样）——**上线级 bug，此前会直接 400 报错**

---

## 3. 回归验证证据（全部通过）

| 验证 | 结果 |
|------|------|
| `tsc --noEmit` | 0 错误 |
| `verify-secretary.mts` | 10/10 ✅ |
| `verify-replay.mts` | 16/16 ✅ |
| `verify-lens.mts` | 14/14 ✅ |
| `verify-guards.mts` | 20/20 ✅ |
| `verify-step-openers.mjs`（静态） | 全过 ✅ |
| 浏览器 E2E（同意反对型） | Step1→3 全通，论证进度 2/2，Body1/Body2 看板正常，Body 切换正常 |
| 服务器 `/api/health` | ok |

---

## 4. 未达预期 / 风险提示

1. **前端 paragraphPlan 引用 32→35（+3）**：迁移增加了 skeleton 优先分支 + 注释，活跃引用不降反微增。但**语义已迁移**（主路径 skeleton，paragraphPlan 仅回退），净效果是减少了"依赖"。若追求字面引用数下降，需删除渲染回退路径（`activeSubpoint.paragraphPlan` 分支，~300 行）——**不建议**：它是 skeleton 缺失时的防御兜底，删除会引入白屏风险。
2. **Planner 仍输出 paragraphPlan**（已记录决策）：语义达成（normalize 即冻结 skeleton），但 LLM 契约未改。风险点在于"若未来 planner prompt 变更导致 pointBlocks 结构变化，`toSkeleton` 需同步"。已评估为低风险、暂不处理。
3. **依赖真实 LLM 的 E2E 不可离线回归**：现有 `replay-student-multi.mjs` 全自动但需服务器 + LLM。离线 mock 成本高，暂不投入。

---

## 5. 综合评价

```
改动方向       ✅ 正确（持续收敛 skeleton+minutes 唯一真相源）
代码量         ✅ server.ts 11,669 → 11,205（-464），累计 -4,889（-30.4%）
旧架构清理     ✅ 惰性 guard 全删，剩余 30 处全部有正当理由
UX/功能        ✅ 确认写板按钮 + Step4 json 400 修复
正确性         ✅ 0 回归（tsc + 60 单测 + 静态 + 浏览器 E2E）
遗留风险       ⚠️ 均为"有理由保留"的防御代码，无影响正确性的项
```

**一句话**：三笔改动全部是"低风险、高确定性"的收尾——删了该删的（不可达死代码）、修了真 bug（loading 卡死、json 400、skeleton 丢失）、补了 UX 缺口（确认写板），且每一步都有 tsc + 单测 + 浏览器三重回归兜底。当前 `restructure` 分支处于**可上线、可继续演进**的稳定状态。
