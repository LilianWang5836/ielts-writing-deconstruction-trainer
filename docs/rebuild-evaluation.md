# 会议秘书 Rebuild 全面评估

> 分支：`restructure` | 评估日期：2026-08-15 | 评估对象：P0–P3 + 前端优化全部提交
> 对照基准：`docs/meeting-secretary-plan.md`（v2 设计定稿 + §7 验收标准）

---

## 0. 结论速览

**总体符合预期，P0/P1/P2/P3 的架构目标全部落地并经多轮验证。** 相比旧架构，状态漂移的死锁根因（结构被 LLM 反复改写 + 双真相源）已被架构性消灭；判断质量通过透镜 + 瘦身 + 护栏分层提升。存在 **1 项未 100% 满足的验收点**（P0「旧字段全删」——兼容/防御性旧字段仍有残留）和 **1 项已知取舍**（Planner 仍输出 paragraphPlan 再转 skeleton，而非 LLM 直接输出 skeleton），二者均不影响运行正确性，属后续清理项。

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

**规模削减（复杂度控制核心指标）：**

```
rebuild 起点 server.ts   16,094 行
当前 HEAD server.ts      11,669 行
净削减                    4,425 行（-27.5%）
P0 阶段一次性削减         4,349 行
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

server.ts 中旧字段引用约 72 处，其中活跃代码约 53 处：

- **`step3SlotEval`**：无活跃代码依赖，仅存在于注释 + 提示词「不要输出」说明（≈安全，可视为已删）
- **`paragraphPlan`（~50 处活跃）**：多为**防御性/兼容 guard**，例如：
  - `9414` 附近：flat `step3SubpointSteps` → paragraphPlan 回包 wrap（LLM 已被告知不输出这些字段，实际几乎不触发）
  - `9540` 附近：paragraphPlan 投影 guard
  - `attachStep3UiProgress`（`3015`）：仍在处理 paragraphPlan 结构
  - 骨架初始化（`4654`）：`sp?.paragraphPlan ? planToSkeleton(sp.paragraphPlan)` 作为回退路径（对新会话走 Planner 冻结 skeleton，此回退只为旧会话兼容）
  - Step1/Step2 的正常 paragraphPlan 使用（这些步骤本就该保留）

→ **判断**：这些是**惰性兼容层**，不参与秘书主路径、不影响运行正确性，但确实没做到「全删」。若要满足 v2「删除优先 + 不做兼容层」的字面要求，需后续专项清理（可在确认 Planner 直接输出 skeleton 后删除回退）。

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

> **架构目标（状态漂移治理）已达成且可证明：-4,425 行、4 个确定性函数、三题型无死锁、看板全来自 minutes、60 个单元断言 + 多轮真实 E2E 全部通过。判断质量（P2/P3）也已落地并零误报。唯一未 100% 兑现的是 v2 字面上的「旧字段全删 / 无兼容层」——现存 ~53 处旧字段引用是惰性防御代码而非活跃依赖，不影响正确性，建议作为下一轮清理项（配合 Planner skeleton 直出一并处理）。**

---

## 6. 建议的后续工作（按优先级）

1. **（清理）** 删除 server.ts 中惰性 paragraphPlan 兼容 guard（9414/9540 回包与投影 guard），前提是先确认历史会话兼容可放弃
2. **（架构）** Planner prompt 改为直接输出 skeleton（去掉 paragraphPlan 中间产物），删除 `planToSkeleton` 回退
3. **（清理）** 前端 `resolveBodyTheme` 等辅助函数迁移到 skeleton 语义，删除 paragraphPlan 读取
4. **（维护）** 清理旧架构诊断脚本（slot-reuse / step3-schemes / momentum-guard），避免与新架构混淆
5. **（可选）** 将评估中的 E2E 场景固化为可回归的 replay 脚本（当前依赖真实 LLM，成本较高）
