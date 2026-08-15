# 会议秘书 Rebuild 全面评估

> 分支：`restructure` | 评估日期：2026-08-15 | 评估对象：P0–P3 + 前端优化全部提交
> 对照基准：`docs/meeting-secretary-plan.md`（v2 设计定稿 + §7 验收标准）

---

## 0. 结论速览

**总体符合预期，P0/P1/P2/P3 的架构目标全部落地并经多轮验证。** 相比旧架构，状态漂移的死锁根因（结构被 LLM 反复改写 + 双真相源）已被架构性消灭；判断质量通过透镜 + 瘦身 + 护栏分层提升。P0「旧字段全删」的最大残留（惰性 guard）已清除（`b083d62`，-473 行）；前端辅助函数已迁移 skeleton 语义（减少 paragraphPlan 依赖）。现存剩余差距为**小型防御性回退**（Step2 正常使用 + Step3 旧会话兼容分支）。Planner「直接输出 skeleton」经评估**暂不执行**（语义已达成、改造风险高于收益），记录为有据可查的架构决策（见 §6 第 2 项）。

---

## 1. 提交与规模证据

| 提交 | 内容 | server.ts 增量 |
|------|------|----------------|
| `6a3d955` | 会议秘书后端核心重建（rebuild 起点） | 基线 16,094 行 |
| `f4bd373` | P0 前端看板 + 状态回传闭环 | — |
| `b0a2d28` | **P0 收尾：删除旧整树 diff 机制** | **-4,349 行** |
| `203c292` | P0 后续：教练上下文与输出切换到秘书架构 | -679 行 |
| `40412b2` | 修复：秘书路径无条件进入（杜绝死锁） | +33 |
| `d706791` | **P1 纪要双层 + 可审计落槽（tag v0.5）** | +11 |
| `6e4f032` | **P2 判断透镜 + 教练瘦身 + 结构化评估** | +110 |
| `a7a4a08` | **P3 判断护栏（切题预检 + 卡死检测）** | +19 |
| `bdb747c` | 前端优化：确认写板按钮 + Step4 json 修复 | +1 |
| `b083d62` | **P0 补完：删除惰性 paragraphPlan guard + 归档旧脚本** | **-473** |

**规模削减（复杂度控制核心指标）：**

```
rebuild 起点 server.ts   16,094 行
当前 HEAD server.ts      11,205 行
净削减                    4,889 行（-30.4%）
P0 阶段一次性削减         4,349 行（b0a2d28）
P0 补完再削减             473 行（b083d62）
```

→ 后端 Step3 逻辑从「merge + guards + backfill + reclass + framework 校验」的多机制并存，收敛为 4 个确定性函数 + 1 个 dup 预检（`src/server/step3/secretary.ts`），与设计 §3.2 完全一致。

---

## 2. 逐阶段验收对照（§7 验收标准）

### P0 — 新数据模型 + 秘书落槽 + 前端重构 ✅（基本达成）

| 验收项 | 状态 | 证据 |
|--------|------|------|
| 三题型无死锁 | ✅ | 讨论/问题解决/同意反对三题型 Step1→4 全跑通；`40412b2` 修掉「LLM 缺 progressUpdate → 秘书路径跳过 → 死锁」这一最后死锁源（无条件进入 + 兜底初始化） |
| 看板内容全来自 minutes | ✅ | `renderBoard` 从 skeleton + confirmedMinutes 投影；E2E 看板槽位内容与学生原话一致；Lens/StallGuard 审计均在分钟级验证 |
| `tsc --noEmit` 通过 | ✅ | 每次提交后 0 错误 |
| 旧字段全删 | ⚠️ **部分** | 见 §4 缺口 (a) |

### P1 — 纪要双层 + 可审计落槽 ✅

| 验收项 | 状态 | 证据 |
|--------|------|------|
| 槽 ↔ 原话可回溯 | ✅ | `subpoint.landingLog`（minuteId→slotKey→reason） |
| 落槽有 reason | ✅ | `appendAudit` 写入 `landingLog` |
| 重放一致 | ✅ | `scripts/verify-replay.mts` 16/16 通过（含无 landingLog 回退 minutes 推断一致） |
| 诊断基于 minutes 重放 | ✅ | `scripts/diagnose-step3.mts` |

### P2 — 判断透镜 + 教练瘦身 + 结构化评估 ✅

| 验收项 | 状态 | 证据 |
|--------|------|------|
| 教练上下文瘦身 | ✅ | `formatStep3SubpointsBrief`（替换 JSON.stringify(step3Subpoints)）+ `formatLensAnchorForActiveSubpoint`；`203c292` 起 Coach 只拿题目 + 冻结骨架 + activeSlot + 学生回答 + 透镜 |
| 评估可审计 | ✅ | `step3Assessment {slotKey, verdict, reason, nextHint}` 回传；`[Lens]` 审计日志 |
| 配置可编辑 | ✅ | `lens.ts` 常量集中（`LENS_GENERAL_RULES` / `LENS_MIN_LEN` / `LENS_OFF_SIGNAL` / `LENS_CHAIN_CONSTRAINTS`） |
| 引导跟语料走 | ✅ | E2E：学生答「自适应学习」→ 教练追问机制细节；答「理科实验课」→ 追问低龄/情感人群；非套模板 |

### P3 — 判断护栏（只拦确定性错误）✅

| 验收项 | 状态 | 证据 |
|--------|------|------|
| 切题预检 | ✅ | `isOffTopic()`，只拦明确跑题 |
| 教练卡死检测 | ✅ | `detectStall()`（阈值 4），E2E 全程 0 误报 |
| 护栏不充当模板校验器 | ✅ | `LENS_OFF_SIGNAL` 只对明确信号告警；StallGuard 仅在连续无实质推进时触发 |

---

## 3. 测试与验证证据

### 3.1 单元测试（全部通过）

| 脚本 | 断言 | 覆盖 |
|------|------|------|
| `scripts/verify-secretary.mts` | 10/10 | 4 确定性函数 + dup 预检 + isComplete 投影 |
| `scripts/verify-replay.mts` | 16/16 | landingLog 重放一致性 |
| `scripts/verify-lens.mts` | 14/14 | 判断透镜 6 类链型约束 |
| `scripts/verify-guards.mts` | 20/20 | 护栏（含「评估不改 minutes」） |
| **合计** | **60/60** | |

### 3.2 端到端（真实 LLM + 真实浏览器）

- **问题解决型**：Step3 共 16–18 轮，pb1+pb2 全部完成，无死锁
- **同意反对型（本次）**：Step1 审题通关 → Step2 立场「部分同意」+ 详略采纳 → Step3 秘书看板 Body1（教学效果：分论点/展开原因/机制/结果多轮落地+确认）+ Body2（学习灵活性/学习成本/动手实践：补充点落地+确认）→ **论证进度 2/2 通关**，槽位 2/2 确认
- Lens 瘦薄跟进、body 切换、StallGuard 0 误报均在真实对话中复现验证

### 3.3 本次优化（`bdb747c`）

- **确认写板按钮**：landed slot 显示「待确认」+ 绿色「确认写板」按钮，点击发送纯「对」由服务器 `commitPendingMinute` 确认——修复了学生输入整句（如"对，我同意这个分论点"）导致秘书误落地的问题
- **修复真实 bug**：`disabled={coachChatRef.current?.loading}` 只随父组件重渲染求值，而 `useImperativeHandle` 更新 ref 不触发父组件重渲染 → 按钮卡在 kickoff 的 disabled 状态。改为 `onLoadingChange` 回调同步本地 `coachLoading` state 后，按钮正确启用
- **Step4 json 修复**：`introConclusionPrompt` 增加 "Output a JSON object with exactly the keys..."，修复 DeepSeek `json_object` 400（prompt 必须含 "json" 字样）

---

## 4. 与预期的差距 / 待清理项（诚实清单）

### (a) P0「旧字段全删」未 100% ⚠️ — 主要差距

> ✅ 2026-08-15 已大幅改善（commit `b083d62`）：两处最大的惰性 guard（flat-wrap 回包 + 投影）及 mode-correction 死代码链已删除，server.ts -473 行，旧字段引用 72→48。

server.ts 中旧字段引用当前约 48 处（含注释/提示词说明）：

- **`step3SlotEval`**：无活跃代码依赖，仅存在于注释 + 提示词「不要输出」说明（≈安全，可视为已删）
- **`paragraphPlan`（剩余活跃）**：
  - Step2 反漂移检测（`4451`/`5225` 附近：Step2 误输出 paragraphPlan 时强制完成）——**语义仍有效，保留**
  - Step2 正常使用（`7408` subClaim 提取、prompts 说明）——**应保留**
  - Step3 防御性回退分支（`isSubpointQualityComplete` / `resolveStep3NextAskClamp` 内的 paragraphPlan/structureSteps 分支）——骨架存在时不走，**保留**为旧会话防御
  - 骨架初始化回退（`planToSkeleton(sp.paragraphPlan)`）——**保留**（旧会话兼容，仅当放弃历史会话才可删）
  - `attachStep3UiProgress`（`3015`）——仍在读取 progressUpdate.paragraphPlan 合并到 mergedSp（plan 为 null 时为空展开，无害）

→ **判断**：两处最大惰性 guard 已删，剩余多为 Step2 正常使用或 Step3 防御性回退（正确性不受影响）。「全删」的剩余差距已显著缩小，可结合 Planner skeleton 直出（§6 第 2 项）最终收口。

### (b) Planner 仍输出 paragraphPlan 而非 skeleton 直出

- 现状：Planner LLM 仍产出 paragraphPlan，`normalizePlannerBodyPlans` 在落地时 `bp.skeleton = toSkeleton(bp)` 转成冻结骨架
- 设计 §8 期望「Planner 输出改为生成 skeleton（冻结、无 value）」
- → **判断**：语义上已达成（前端/秘书只消费 skeleton，paragraphPlan 仅作 planner 内部中间产物 + 兼容），但 LLM prompt 层未改。低风险取舍，属优化项

### (c) 前端 Step3Drafting 旧字段引用（58 处）

- 多数为 **Step2→Step3 主题/论点句显示**的兼容读取（`resolveBodyTheme` / `resolveBodyClaimSentence` / `planWithClaimPrefill`），**不读看板槽位状态**（看板完全走 skeleton+minutes 投影）
- → **判断**：前端看板重构达成；残留为 body 标签/论点句解析的辅助函数，可后续统一到 skeleton 语义

### (d) 其他已知项（非秘书 scope）

- Step4 逐句写作仍为 coach-chat 回退 + JSON 解析（本次刚修复 json 400），未纳入秘书重构范围
- 部分旧诊断脚本（`verify-step3-schemes.mjs` / `verify-slot-reuse.mjs` / `verify-coach-momentum-guard.mjs` 等）为旧架构编写，输出与新架构不匹配（非回归，是脚本未更新）

---

## 5. 总体判断

### 设计目标逐条核对（§0 原则 / §6 复杂度控制）

| 原则 | 达成度 | 说明 |
|------|--------|------|
| 后端核心优先 | ✅ | 数据模型与确定性函数先定，前端适配 |
| 前端彻底重构（无旧结构兼容层） | ⚠️ 主要达成 | 看板消费新模型；残留仅辅助函数 |
| 真相源单一（minutes） | ✅ | 看板是投影，无持久化看板内容 |
| 骨架只读 | ✅ | 冻结后任何环节不改结构（死锁根因消灭） |
| 复用不等于保留（旧机制全删） | ⚠️ 主要达成 | 主机制全删，惰性兼容 guard 残留 |
| 后端薄（4 函数 + 1 dup 预检） | ✅ | secretary.ts 精确对应 |
| 前端同步重构 | ✅ | 看板 + 确认写板按钮 + loading 同步修复 |

### 一句话结论

> **架构目标（状态漂移治理）已达成且可证明：-4,889 行、4 个确定性函数、三题型无死锁、看板全来自 minutes、60 个单元断言 + 多轮真实 E2E 全部通过。判断质量（P2/P3）也已落地并零误报。v2 字面的「旧字段全删 / 无兼容层」已最大程度兑现：惰性 guard 与前端辅助函数均迁移 skeleton 语义；剩余旧字段引用为 Step2 正常使用 + Step3 防御性回退（不影响正确性）。「Planner skeleton 直出」经权衡暂不执行（见 §6 第 2 项），作为有据可查的架构决策。**

---

## 6. 建议的后续工作（按优先级）

> ✅ 2026-08-15 已处理：第 1 项（惰性 guard 删除，`b083d62`，-473 行）+ 第 4 项（旧脚本归档）+ 第 3 项（前端辅助函数迁移，见下）+ 静态检查脚本修复（`verify-step-openers.mjs` 路径 `%20` 解码 + 失效断言更新）。

1. ~~**（清理）** 删除 server.ts 中惰性 paragraphPlan 兼容 guard~~ ✅ 已删（9414 回包 + 9540 投影 + mode-correction 死代码链）
2. **（架构 · 暂不执行）** Planner prompt 改为直接输出 skeleton —— **决策：不做全量改造**。理由：① 语义已达成（`normalizePlannerBodyPlans` 产出即 `bp.skeleton = toSkeleton(bp)`，Step3 全链路只消费 skeleton，paragraphPlan 仅是 planner 内部中间产物 + Step2/旧会话兼容）；② 改动面大（prompt + 解析 + QA + normalize + Step2 侧读取），DeepSeek 输出新结构需重新验证三题型；③ 转换是确定性纯函数，无运行时风险。**渐进替代**：如需最终收口，可仅当放弃历史会话时删除 `planToSkeleton` 回退（`server.ts ~4395`），并保持 planner 内部用 paragraphPlan 作为 LLM 契约。
3. ~~**（清理）** 前端 `resolveBodyTheme` 等辅助函数迁移到 skeleton 语义~~ ✅ 已迁：`resolveBodyClaimSentence`/`resolveBodyTheme` 优先读 `bp.skeleton.blocks`（同源 label/subClaim），`parsedSubpoints` 映射携带 `skeleton`，`kickoff` firstEmpty 优先从 skeleton 未确认槽取；paragraphPlan 仅作回退。浏览器验证 Body1/Body2 主题标签与看板正常。
4. ~~**（维护）** 清理旧架构诊断脚本~~ ✅ 已归档（slot-reuse / step3-schemes / momentum-guard → `scripts/legacy/`）
5. **（可选）** 将评估中的 E2E 场景固化为可回归的 replay 脚本（当前依赖真实 LLM，成本较高）
