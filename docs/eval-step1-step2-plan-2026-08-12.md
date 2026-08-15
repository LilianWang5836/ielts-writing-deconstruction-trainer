# 评估（复评）：step1-step2-架构梳理与问题清单（2026-08-11）

> 复评日期：2026-08-12
> 评估基线：**`revise-step2-august-11`（ead22e6，2026-08-11 23:01，「修改第二步的流程，新增接受/否决」）** —— 即文档所述的 "Step2 大改" 真实代码。本地工作分支 `work-step2-review` 跟踪之。
> 过程修正：初版评估基于 `main`/`release/v0.2`（旧架构）并误判"文档功能不存在于任何分支"，因统计脚本 awk 字段解析错误 + 新分支当时未拉取。已更正。

---

## 0. 基线确认（关键更正）

- 远端最新分支 `revise-step2-august-11` 即为文档描述状态。文档"已建/已修"符号在该分支**全部存在**（git grep 计数）：`Step2Point` 93、`retentionRole` 71、`mappedPointIds` 36、`stanceConfirmResolved` 31、`side_settle` 27、`slot_merge` 25、`settleAwaitingCustomSide` 14、`probeVerdict` 8、`preserveStep1ProbeTags`/`channelAuthoredText`/`ensureParagraphPlanCoversFrameworkPoints` 等各 3。
- 该分支是一次大规模重构（+14241 行，新增 `src/server/step1/dimension-probe.ts`、`src/server/step2/{ask-contract,proposal,planner-payload,student-turn-intent}.ts`、`src/utils/step3ClaimPrefill.ts`）。
- ⚠️ 教训：`git grep -c` 输出是 `ref:path:count` 三字段，awk 统计计数须取 `$NF`。

---

## 1. 文档"已建/已修" 现状核实（对照真实代码）

| 文档声称 | 代码位置 | 判定 |
|---|---|---|
| Step1 probe-first 门禁 + 服务端盖章 `probeVerdict` | `types.ts:270 probeVerdict`、`pendingProbeCore`；`src/server/step1/dimension-probe.ts`（270 行）；`preserveStep1ProbeTags` ×3 | ✅ 已建 |
| Step2 arm-first 提案通道（采纳/拒绝按钮） | `types.ts:613 Step2Proposal`（kind: side_settle/slot_add/slot_merge/stance，proposalId）；`src/server/step2/proposal.ts`（1467 行，validate/commit/readiness）；UI 按钮绑定 proposalId | ✅ 已建 |
| 结构化 `Step2Point`（claim/elaboration/retentionRole/seedOnly/leanTags） | `types.ts:565 Step2Point`；`plannerPayload.points` | ✅ 已建 |
| 反提案/标签版解析、拒绝防重 arm | `settleAwaitingCustomSide`、`rejectedMergeIds`、`buildSideSettleFromLabelMessage`、`parseRetentionSchemeMessage` | ✅ 已建 |
| `ensureParagraphPlanCoversFrameworkPoints` 守卫 | `src/utils/step3Quality.ts:726`；调用点 `server.ts:7519` | ✅ 存在，但**数据源 bug（见 §3 ①）** |
| planner 产出 `mappedPointIds` | `planner-prompts.ts:306` 强制"每个 Body 必须给出 mappedPointIds"；`detectPointCoverageIssues`（planner.ts:227）、`appendMissingPointBlocks`（planner-payload.ts:4310）、服务端按 id 水合 subClaim（server.ts:11242） | ✅ 已建 |
| `channelAuthoredText`、`buildSettleRecapAck` | 服务端复述采纳确认（×3） | ✅ 已建 |

**结论：文档第一部分/第二部分的"已建"描述与该分支代码一致。**

---

## 2. 三个结构性根因在"当前基线"上的真实状态

| 根因 | 当前基线状态 | 判定 |
|---|---|---|
| ① 状态寄生自由文本 | **Step2 主体已迁出**（`plannerPayload.points` 结构化 + 提案通道决策不反解析文本）。**残留**：`userPoints` 字符串仍双写（`stampRetentionTagOnUserPoints` 正向 / `applyRetentionRolesFromUserPoints` 反向同步，planner-payload.ts）；**Step1 探测标签仍在 `suggestedDimensions` 字符串**。 | ⚠️ 部分根治（Step2 主、Step1 与兼容层未） |
| ② 决策靠文本检测 | **提案通道已建**（arm-first）。**残留**：进入通道的"触发/内容检测"仍靠正则——proposal.ts:1349 `mergeNarrated = /合并\|并入\|折进\|整合至\|整合到\|归入/` 从 coachText 判合并、`resolveMergeIntoFromText` 从文本解析合并目标、`buildSideSettleFromCoachText` 兜底解析 prose。 | ⚠️ 通道在，触发层仍有正则残留（文档 item2 "遗留风险"属实） |
| ③ 结构化每跳降级 | **planner→客户端已 ID 化**（mappedPointIds + 水合 + QA/append）。**最大残留**：Step3 kickoff 仍让 LLM 重新生成 plan（server.ts:12393 prompt "KICKOFF / FIRST PLANNING TURN: ALL steps[].value empty…"）；merge 靠 label 模糊匹配；**丢点守卫数据源 bug（§3 ①）**。 | ⚠️ 半程（管线通、Step3 骨架未硬传承） |

---

## 3. 优先级 ① 评估（修复守卫数据源 —— 文档"当前未修复项"，已在代码确认）

**文档表述**：`ensureParagraphPlanCoversFrameworkPoints` 守卫"当前未生效"——读的 `subpoint.points` 被客户端 `isClaimSentence` 过滤成空数组、`pointRoles` 在 planner 路径不产出，守卫零框架信息静默退出；正确数据源应为 `session.step2_5.bodyPlans` 的 `mappedPoints/mappedPointIds` + payload 的 `retentionRole`。

**代码验证（全部属实）**：
1. 守卫 `step3Quality.ts:726`：`const points = subpoint?.points ?? []`；`if (!points.length) return []` —— **空即静默返回**。
2. 客户端 `Step3Drafting.tsx:158-164`：`mapped.filter((p) => isClaimSentence(String(p||'')))` → `points: pointLines.length ? pointLines : []`。`isClaimSentence`（step3ClaimPrefill.ts:8）明确拒绝"纯维度短语/主题头"（如「网络普及（原因）」）→ **points 被滤空**。
3. 调用点 `server.ts:7519`：`ensureParagraphPlanCoversFrameworkPoints(plan, activeSp)` —— 只传 subpoint，不传 session/bodyPlans/plannerPayload。

**修复路径（小改，建议先行）**
1. 守卫改读 planner 账本：入参增加 `session`（或直接传 `mappedPoints/mappedPointIds` + `plannerPayload.points[].retentionRole`），以 **bodyPlans 的 mappedPointIds** 为覆盖判定源，而不是 `subpoint.points`；
2. 或最小改动：客户端在 subpoint 上保留一份**未过滤**的 `frameworkPoints`（planner 账本投影），守卫读它；
3. 补一条回归用例：mapped point 为维度短语（非完整句）时不得丢块。

**收益**：闭合"网络普及"类丢点事故。

---

## 4. 优先级 ② 评估（Step2 状态迁出字符串 —— 大部分已做，剩余是"还债"）

**现状**：结构化 `plannerPayload.points` 已是 Step2→planner 的唯一真相；提案走 `Step2Proposal` 通道。**剩余的债**（文档 item5）：
1. **双写不同步**：`userPoints` 字符串与结构化 points 并存，`applyRetentionRolesFromUserPoints` 反向同步、scrub/strip 只修字符串侧。→ 把 `userPoints` 降为**纯只读渲染投影**（由结构化派生），删除/收敛反向解析。
2. **flag 蔓延**：`settleAwaitingCustomSide / rejectedMergeIds / stanceConfirmResolved / sideSettled / stanceAwaitingCustom / declinedSlotClaims / capacityTrimDismissedSides / pendingProposal …` 无集中状态机定义。→ 集中定义状态机 + 交互组合用例穷举（现有 `scripts/replay-proposal-channel.mjs`、`replay-proposal-phase1.mjs`、`verify-slot-reuse.mjs` 可作基线）。
3. **retentionSuggestion 退化**：proposal.ts 优先级 = 结构化建议 → 解析 coach 文本 → **长度启发式兜底**；`sanitizeRetentionReason` 只截断/丢弃，无重试。→ 加一次重试或显式降级标记，避免静默退化。
4. **Step1 探测状态仍是字符串标签**（item6）：`probeVerdict` 是服务端盖章，但标签仍写回 `suggestedDimensions` 字符串。→ 与 ② 同类处理（结构化 probe 状态为唯一真相）。

**规模**：中（清理为主，非重建）。

---

## 5. 优先级 ③ 评估（planner→Step3 ID 硬传承 —— 管线已通，缺"骨架锁定"）

**现状**：planner 已产出 `mappedPointIds` 并水合；QA/append 已兜底。**剩余缺口**：
1. **kickoff 仍让 LLM 重新生成 plan**（server.ts:12393）。→ Step3 进入时服务端直接把 `bodyPlans` 的 pointBlocks 灌入 activeSubpoint.paragraphPlan；LLM 只允许填 `steps[].value`（+label 微调），**结构性 diff 拒收**。
2. **merge 按 label 模糊匹配**（`blockMatchesMappedPoint`/prevPlan key 归属）。→ 改为按 pointBlock id（=mappedPointIds 绑定）对齐。
3. 上述完成后，**现有丢点守卫可退役**：`ensureParagraphPlanCoversFrameworkPoints`、`detectPointCoverageIssues`/`appendMissingPointBlocks` 降为兜底、`blockMatchesMappedPoint` 弃用。

**规模**：中。**收益**：丢点事故在数据契约层闭环（与 ① 同源，做 ③ 后 ① 的守卫可移除）。

---

## 6. 建议顺序、验证与风险

- **顺序**：**① 先行**（小、直接闭合当前丢点）→ **③**（骨架硬传承，让 ① 守卫退役）→ **②**（清双写债 + flag 状态机 + Step1 结构化）。①③ 同属 Step3 丢点链路，连贯推进；② 为独立清理。
- **验证**：`scripts/` 下 `verify-*.mjs` + `replay-*.mjs`（replay-proposal-channel / replay-proposal-phase1 / replay-retention-planner-checklist / replay-step1-dimension-probe / replay-checklist-walk-gate / replay-parse-coverage / replay-new-cases）+ `run-step1-3-e2e.mjs`；新增"维度短语型 mapped point 覆盖性"用例。
- **风险**：
  - 该分支是单 commit 大重构（+14k 行）且**未合入 main**；改动前先在此分支上跑通全部 replay/verify 脚本做回归基线。
  - 旧会话脏数据（文档 item5-5）：历史 bug 污染的 `userPoints` 靠 scrub 不保证干净，**测试一律用新会话**。
  - 双写分叉、flag 组合未穷举（item5-2/5-3）：② 阶段集中处理并补组合用例。

---

## 7. 结论

1. **基线确认**：`revise-step2-august-11` 就是文档所描述的真实代码，"已建/已修"基本全部属实。
2. **文档判断准确**：三个根因中 ①（Step2）已根治、② 已建通道、③ 是最薄弱环节；"当前未修复项"（守卫数据源）在代码中得到逐点证实（`isClaimSentence` 过滤 → `subpoint.points=[]` → 守卫静默退出）。
3. **优先级成立**：①→③→② 顺序合理，① 先小改止血，③ 从根上闭环，② 负责还清状态结构化的债。
4. **前置动作**：建议先在该分支上跑通现有 replay/verify 回归脚本，确认基线稳定后再动 ①。

---

## 8. 产品交互约束（2026-08-12 补充）与方案更新

> 产品侧明确：**强制按钮显式确认 = 严格白名单**，其余决策一律走对话，不出现强制按钮。

### 8.1 按钮白名单（唯一允许"采纳/拒绝"按钮的位置）

| # | 位置 | 触发时机 | 对应提案 kind |
|---|---|---|---|
| 1 | Step2 每侧详略 | 该侧（A/B）要点**全部展开结束**后，确认该侧详略策略 | `side_settle` |
| 2 | Step2 立场 | Step2 **最后一个流程**，确认立场 | `stance` |
| 3 | Step3 填槽确认 | 现状保留：确认某槽已填内容（**不新增、不删除**） | 现有填槽协议 |

### 8.2 因此对方案的更新

1. **交互面收敛**：`proposal` 通道里除 `side_settle`/`stance` 之外的 kind（`slot_add`、`slot_merge`）**降级为"对话内动作"，不再渲染独立按钮**：
   - `slot_add`（新增平行点）：学生自己说出新点 = 已确认 → 直接上板；仅当"疑似新增需消歧"时才用对话追问，不弹按钮。
   - `slot_merge`（合并）：**只允许学生明确发起时生效（学生的话即确认）**；教练不得口头合并；涉及内容折叠时并入当前详略确认（`side_settle`）一起处理或对话确认——**不新增第三个按钮**。
   - 反提案（"详写2，略写1和3"等）仍走 modify-and-accept，发生在既有两个按钮/对话内，不新增按钮。
2. **与当前分支代码的差异点**：当前分支 `CoachChat.tsx` 已对 `slot_add`/`slot_merge` 渲染采纳/否决按钮 → 需把这两类从"独立按钮"改成"对话内/并入 settle"，使按钮白名单收敛到 2（Step2）+ 1（Step3 填槽）。
3. **① ② ③ 工程改动不变**，但明确"按钮面不扩大"：
   - ① 守卫数据源：纯正确性修复，无交互新增。
   - ② 单一真相源：`userPoints` 只读投影后，按钮状态（`pendingProposal`）与看板渲染都唯一 → 颜色/标记/详略不再闪变。
   - ③ 骨架硬传承：Step3 填槽确认沿用现状；结构被钉死后，若需改 body 论点仍走既有 `structureChangeOffer`（重规划确认，非新增按钮）。

### 8.3 更新后的交互影响

- 学生在 Step2 只会**在两个时刻**看到按钮：每侧详略确认、末尾立场确认。
- 新增平行点、合并、反提案都以**对话**完成（学生的话即确认），产品更"对话优先"，贴合苏格拉底气质。
- Step3 交互**无变化**（沿用现有填槽确认）。
- 验收口径：Step2 全流程学生见到的强制按钮 ≤2；Step3 仅填槽确认按钮。
