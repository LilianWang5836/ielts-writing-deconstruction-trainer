# 实施进度：P1 结构透明 + P2 Planner 软参数 + P3 判断进对话

> 日期：2026-08-16 | 依据：`docs/plan-coach-intelligence-final-2026-08-16.md`（P1/P2/P3 部分）
> 状态：P1 完整、P2（软参数捕获）已做、P3（判断进对话）已做；各方案中标记"延后"的子项见 §4。

---

## 1. P1 结构透明（完整）

目标：coach 开讲时点题本段 + 进 Step3 时汇报整体方案，让学生"知道我们为什么写这段"。

- `src/server/step3/secretary.ts` 新增纯函数：
  - `renderPlanRecap(subpoints)`：大白话方案汇报（"这一篇计划分 N 段：第 1 段（主论证段）围绕「…」展开…"）；
  - `formatActiveBodyMission(subpoint)`：本段在方案中的角色 + 论证目标（"本段（让步段）：论证「…」"）；
  - `formatBodyRoleZh(role)`：role → 中文（让步段/主论证段/问题段/解决段/观点A/B段/评价段）。
- `server.ts`：
  - 把两者注入 Step3 上下文（`Essay Plan Recap` / `Active Body Mission`，INTERNAL，禁报字段名）；
  - Step3 prompt 新增 `P1 OPENING RECAP` 规则：body 开讲先一句点题本段使命；首个 body 开讲再简短汇报整体方案（1–2 句，自己的话），之后各轮不再重复方案。

## 2. P2 Planner 软参数（layoutPreference 捕获已做；提案微阶段延后）

目标：学生结构偏好作为**软参数**进 Planner，优先采纳、与材料硬约束冲突时以材料为准。

- `src/types.ts`：`Step2PlannerPayload.layoutPreference?`（`bodyCountPref? / concessionOrder? / expansionPref? / note?`）；`PlannerInput.materials.layoutPreference?`。
- `src/server/step2/planner-payload.ts`：`normalizeStep2PlannerPayload` 读取 LLM `step2Data.layoutPreference`（或 `step2Data.plannerPayload.layoutPreference`）并跨轮保留 `prev.layoutPreference`。
- `src/server/planner/planner.ts`：`collectPlannerInput` 透传 `plannerPayload.layoutPreference`。
- `src/server/prompts/planner-prompts.ts`：`buildPlannerPrompt` 增 `4.5 学生结构偏好（软参考，非硬约束；与材料硬约束冲突时以材料为准，并在 rationale 注明）`。
- `server.ts` Step2 prompt 新增 `P2 STRUCTURE PREFERENCE` 规则：stance 锁定后、summary 阶段可**至多 1 轮可选**地问一个结构偏好问题（段数 / 让步位置 / 展开角度），学生可「你定/随便」跳过（**软参考，非硬门禁**）；答案写入 `plannerPayload.layoutPreference`。

**范围说明**：终版方案的"`layout_strategy` 提案通道（UI 采纳/拒绝）微阶段状态机"**延后**——它需要改动 Step2→Planner 自动触发时序与前端按钮，风险较高；本轮用"教练可选结构问答 → layoutPreference 软参数"达成同一目标（偏好进 Planner），且不改变 Step2 完成/Planner 触发流程。

## 3. P3 判断进对话（已做；prompt 减负延后）

- `server.ts` Step3 prompt 新增 `P3 JUDGMENT IN DIALOGUE` 规则：上一轮回答被判 thin/off_target/duplicate 时（见 `上轮门控提示`），Part 1 给**一句专业原因**（"这句还停在'很灵活'，没落到具体场景或机制" / "你答的是展开原因，这一步要的是分论点"），再问追问——不照抄 hint、不以空泛赞美开头、不只重复"请再说具体一点"。
- 门控 hint 已由 P0 持久化到 `subpoint.lastGateHint` 并经 `formatStep3SlotCursorForPrompt` 注入下一轮上下文，本规则使其真正变成"专业点评"而非死代码。

**范围说明**：终版方案的"prompt 减负（`progressUpdate.cta` 结构化替代'进入第三步'字面解析 + 规则下沉 guard）"**延后**——跨前端+服务端、改动面大，需独立回归（已在 P0 进度文档标记）。

## 4. 验证

- `tsc --noEmit` 0。
- `verify-step3-gate` 33/33、`verify-secretary` 10/10、`verify-replay` 16/16、`verify-guards` 20/20、`verify-lens` 14/14 全绿。
- replay 抽样（merge-by-id / single-truth / skeleton-lock / next-ask-clamp）全绿。
- Planner prompt 渲染核对：传 `layoutPreference` 时含"学生结构偏好"段、不含时不出现。

## 5. 延后项（后续）

1. P2 `layout_strategy` 提案微阶段（UI 采纳/拒绝 + Step2→Planner 时序）。
2. P3 prompt 减负（`progressUpdate.cta` 结构化 + 规则下沉 guard）。
3. 评估闭环指标基线（总轮次 / stall / 误判数 / 看板-文本矛盾数）+ 清理 `replay-retention-planner-checklist` 过期源码扫描断言。
4. P1/P2/P3 需一次真实交互（服务 + LLM）验收开讲点题、方案汇报、结构偏好捕获的实际效果。
