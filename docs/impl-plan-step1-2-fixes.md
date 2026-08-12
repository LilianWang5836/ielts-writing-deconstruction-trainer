# 实施方案（细化）：Step1/Step2 修复 + 提交结构化拆分

> 基线分支：`work-step2-review`（跟踪 `origin/revise-step2-august-11` @ ead22e6）
> 日期：2026-08-12
> 回归基线：6 个纯函数 replay 套件通过（replay-checklist-walk-gate / parse-coverage / proposal-channel / proposal-phase1 / retention-planner-checklist / step1-dimension-probe）。
> 注意：`verify-*.mjs` 因工作区路径含空格（`coding%20workspace`）读不到文件而失败（环境问题）；`replay-new-cases.mjs` 需要运行中的服务。

---

## 一、目标（按文档优先级 + 产品按钮白名单）

1. **① 修 Step3 丢点守卫数据源**（文档"当前未修复项"）—— 小改，先做。
2. **③ 骨架硬传承**（kickoff 灌骨架 + ID 对齐，让软守卫退役）—— 中。
3. **② 单一真相源**（`plannerPayload.points` 唯一真相，`userPoints` 只读投影）—— 中。
4. **按钮白名单收敛**（产品约束）：Step2 强制按钮 = `side_settle`（每侧详略）+ `stance`（末尾立场）；Step3 = 现有填槽确认。`slot_add`/`slot_merge` 降为对话内动作。

---

## 二、① 修守卫数据源（先做）

### 现状（已核实）
- `src/utils/step3Quality.ts:726` `ensureParagraphPlanCoversFrameworkPoints(plan, subpoint)`：读 `subpoint.points`；空则静默返回。
- `src/components/Step3Drafting.tsx:158-164`：`points: mapped.filter(isClaimSentence)` —— 维度短语（如「网络普及（原因）」）被滤空。
- 调用点 `server.ts:7519`：只传 `(plan, activeSp)`，没传 session/bodyPlans/retentionRole。

### 改动
1. **`src/utils/step3Quality.ts`**：守卫增加第 3 参 `frameworkLedger?: { label: string; role: string }[] | null`。
   - 提供时：用它做覆盖判定与 role 映射（`detail`→major 3 步 / 其余→minor 1 步），逻辑复用现有 append 分支；
   - 缺省时：回退现有 `subpoint.points`/`subpoint.pointRoles`（向后兼容，不影响其他调用方）。
2. **`server.ts` 调用点（~7519）**：从 `session` 构建 ledger：
   - 定位当前 body 的 `bodyPlan`：`session.step2_5.bodyPlans` 按 `activeSp.id`（或 body 序号）匹配；
   - 取 `bp.mappedPointIds`（无则 `bp.mappedPoints`），经 `resolvePointId(id, plannerPayload.redirects)` 找到 `plannerPayload.points[]`；
   - ledger = `{ label: point.claim || mappedPoint, role: point.retentionRole || '' }`；
   - 传入守卫。
3. **`src/components/Step3Drafting.tsx`（可选加固）**：在 subpoint 上保留未过滤的 `frameworkPoints`（planner 账本投影），供 UI/守卫使用；`points` 仍只含完整句（展示不变）。
4. **新增回归用例**：`scripts/replay-framework-coverage.mjs` —— 构造一个 mapped point 为维度短语（非完整句）的 plan+ledger，断言守卫会补出 block（不再静默退出）。

### 验收
- 新用例通过；`replay-*` 全套不回归。

---

## 三、③ 骨架硬传承（次一步）

### 现状
- planner 已产出 `mappedPointIds` + 水合 subClaim（server.ts:11232-11246）；`Step3Drafting` 已把 `bp.paragraphPlan` 放到 subpoint。
- 但 Step3 kickoff 提示（server.ts:12393）仍让 LLM "emit the paragraphPlan skeleton" → 结构可能被重排/丢点。

### 改动
1. **服务端注入骨架**：Step3 首次进入时，用 `activeSp.paragraphPlan`（来自 bodyPlans）作为权威骨架；coach 只允许填 `steps[].value`（+label 微调）。
2. **改 prompt 契约**（server.ts:12393 及 CoachChat kickoff 上下文）：删除"自行生成 paragraphPlan 骨架"的指示，改为"按给定 pointBlocks 推进填槽"。
3. **merge 按 ID 对齐**：`blockMatchesMappedPoint` 等 label 模糊匹配降级为兜底；优先按 `pointBlock.id`（= mappedPointIds 绑定）对齐。
4. **退役软守卫**：`ensureParagraphPlanCoversFrameworkPoints` 保留为兜底（数据源已修复），`blockMatchesMappedPoint`/`pickPrimaryPointBlock` 等不再作为主路径。
5. **逃生口保留**：改 body 论点仍走既有 `structureChangeOffer`（重规划确认），不新增按钮。

### 验收
- 新会话 Step3 首帧结构 = Step2 planner 骨架；无丢点；教练对话被约束在既定块内。

---

## 四、按钮白名单收敛（产品约束）

### 现状
- `src/components/CoachChat.tsx` 对 `pendingProposal` 的 4 种 kind（side_settle / slot_add / slot_merge / stance）都渲染采纳/否决按钮。

### 改动
1. `CoachChat.tsx`：按钮**只对 `side_settle` 与 `stance` 渲染**；`slot_add`/`slot_merge` 不再渲染独立按钮。
2. `slot_add`（新增平行点）：学生自己说出新点 = 已确认 → 直接上板（走现有提交逻辑）；仅在需要消歧时用对话追问。
3. `slot_merge`（合并）：只允许**学生明确发起**时生效（学生话语即确认）；教练不得口头合并；内容折叠并入当前 `side_settle` 或对话确认。
4. `replay-proposal-channel.mjs` 中 slot_add/slot_merge 相关用例同步更新（仍测"通道逻辑"，但 UI 不再渲染按钮）。

### 验收
- Step2 全流程学生可见强制按钮 ≤ 2（每侧详略 + 立场）；Step3 仅填槽确认。

---

## 五、② 单一真相源（最后/可与 ③ 并行）

### 现状
- 双写：`stampRetentionTagOnUserPoints`（正向，planner-payload.ts 9 处）、`applyRetentionRolesFromUserPoints`（反向，7 处）；`userPoints` 字符串与 `plannerPayload.points` 并存，scrub/strip 只修字符串侧。

### 改动
1. `plannerPayload.points` 为唯一真相；`userPoints` 降为**只读渲染投影**（由结构化派生）。
2. 停用/移除反向同步 `applyRetentionRolesFromUserPoints`（结构化已是权威，无需再从字符串回读）。
3. 正向 `stampRetentionTagOnUserPoints` 仅用于兼容旧会话/展示，不再作为状态源。
4. 渲染源统一：`Step2Brainstorm.tsx` 从 `plannerPayload.points` 取 `retentionRole` 上色，不再从 `userPoints` 字符串反解。
5. 收敛 flag：`settleAwaitingCustomSide / rejectedMergeIds / stanceConfirmResolved / sideSettled / stanceAwaitingCustom / declinedSlotClaims / capacityTrimDismissedSides / pendingProposal` 集中定义状态机（`src/server/step2/proposal.ts` 或新 `state.ts`），交互组合补用例。
6. `retentionSuggestion` 退化加一次重试或显式降级标记（proposal.ts 优先级①→③ 之间）。

### 验收
- 结构化与字符串不再分叉；replay-checklist-walk-gate 等依赖字符串行为的用例需同步迁移到结构化断言。

---

## 六、提交结构化拆分（把 ead22e6 巨型提交拆成逻辑提交）

按逻辑子系统切分（最终树不变，仅历史粒度变化）：

1. `feat(types): Step2 结构化类型（Step2Point/Step2Proposal/plannerPayload）` → `src/types.ts`
2. `feat(step2): 结构化状态与 planner 物料契约` → `src/server/step2/planner-payload.ts` + `student-turn-intent.ts`
3. `feat(step2): 提案通道（side_settle/stance/slot_add/slot_merge）` → `src/server/step2/proposal.ts` + `ask-contract.ts`
4. `feat(step1): 维度探针服务端化（probeVerdict）` → `src/server/step1/dimension-probe.ts`
5. `feat(step3): 骨架覆盖守卫 + claim 预填` → `src/utils/step3ClaimPrefill.ts` + `step3Quality.ts` + `src/server/planner/*`（planner/planner-prompts）
6. `feat(ui): 提案按钮 + channelAuthoredText` → `src/components/CoachChat.tsx` + `Step2Brainstorm.tsx`（+Step1Analysis/Step3Drafting/Step4 顺带改动）
7. `feat(server): 集成接线` → `server.ts`（跨子系统，单独一个提交）
8. `test: 回放/校验脚本` → `scripts/*`

> 注：`server.ts` 是跨子系统单体，无法按子系统干净拆文件，故独立成"集成接线"提交；用 `git reset --soft edce77e` + 分文件 `git add` 实现，`server.ts` 最后单独提交。

---

## 七、顺序与回归

1. 先拆分提交（纯历史操作，无代码变化）。
2. 实现 ①（含新用例）→ 跑 replay 全套。
3. 按钮白名单收敛 → 跑 proposal-channel 相关用例。
4. ③ 骨架硬传承 → 跑 checklist-walk-gate / step3 相关用例。
5. ② 单一真相源 → 迁移字符串断言到结构化。
6. 每次改动后 `npm run lint`（tsc --noEmit）+ 相关 replay 套件。

---

## 八、完成状态（2026-08-12 检查点）

### ✅ 已完成

- **提交结构化拆分**：巨型提交 ead22e6 → 9 个逻辑提交（types / step1 / step3 / planner / step2 状态 / step2 提案 / ui / server 集成 / scripts）。拆分后与 `origin/revise-step2-august-11` 内容零差异（`git diff` 为空），replay 全套通过。
- **① 修守卫数据源**（提交 `feeaedb`）：
  - `ensureParagraphPlanCoversFrameworkPoints(plan, subpoint, frameworkLedger?)` 新增可选 planner 账本数据源（优先）；旧 `subpoint.points` 路径保留为向后兼容。
  - `server.ts` 新增 `buildStep3FrameworkLedger`（读 `session.step2_5.bodyPlans` 匹配当前 body + `plannerPayload.points[].retentionRole`，经 `resolvePointId` 处理 redirects），并在 `enforceStep3LogicCompletionInner` 传入。
  - 新增 `scripts/replay-framework-coverage.mjs`（6 个断言：维度短语补块 / detail→major3 步 / brief→minor1 步 / dropped 不补 / 已覆盖不重复补 / 无 ledger 回退兼容）。
  - 验证：`tsc --noEmit` 通过；新用例 6/6；全量 replay 无回归（`replay-new-cases` 需运行中的服务，属既有环境限制）。
- **按钮白名单收敛**（提交 `0e8de24`）：
  - `CoachChat.tsx` 的 `isProposalHost` 仅对 `side_settle`/`stance` 渲染采纳/否决按钮；`slot_add`/`slot_merge` 提案降为纯消息，学生可直接打字「可以/采纳」或说出方案（`resolvePendingProposalDecision` 文本路径处理）。
  - 验证：`tsc --noEmit` 通过；replay-proposal-channel / phase1 / checklist-walk-gate 无回归。
  - ⚠️ 遗留：legacy `isSlotAddHost`（旧 pendingSlotAdd 无提案路径）仍渲染按钮，仅影响旧会话；建议后续移除。
- **DeepSeek（OpenAI 兼容）集成打通**（提交 `735168b`）：
  - `.env.local` 配置 `LLM_PROVIDER=openai-compatible` + `https://api.deepseek.com/v1` + `deepseek-chat`，服务端 `/api/health` 返回 `provider=openai-compatible, hasKey=true`。
  - e2e 发现的 3 个真实集成 bug 全部修复：
    1. `generateOpenAICompat` 返回体补顶层 `text`（Gemini SDK 有 `.text` getter，多数调用方用 `response.text`；此前 OpenAI 兼容路径返回 undefined → 全部解析失败）；
    2. 消息规范化：`contents` 支持字符串与 `[{role,parts}]`，合并 `config.systemInstruction` → system 消息（修 DeepSeek 400 `Empty input messages`）；
    3. `parseAIResponse` 纯文本兜底：端点偶发输出非 JSON 教练文本时，内容充实则作为教练消息，不再暴露 "Error parsing AI response."。
  - 验证：`replay-new-cases.mjs` 跑通（真实 DeepSeek 调用，教练文本自然、part1/part2 结构正确）；7 个纯函数 replay 套件全绿。
- **① 端到端验证通过**（提交 `aa92cb0`，`scripts/replay-e2e-step3-coverage.mjs`）：
  - Step2 完成（含维度短语点 `网络普及（原因）`）→ planner（真实 DeepSeek）产出 3 body、`mappedPointIds` 覆盖全部点 → 客户端 `isClaimSentence` 过滤掉维度短语（复现原 bug）→ 服务端守卫把它补回 Step3 骨架（plan blocks 含「网络普及（原因）」）——**丢点事故全链路闭环**。

### ⏳ 待实施（方案已细化，见第三/四/五节）

- **③ 骨架硬传承**：kickoff 服务端灌骨架、改 prompt（server.ts:12393）、merge 按 ID 对齐、软守卫降级。⚠️ 涉及 Step3 主流程 + LLM 契约，**需 e2e（运行服务 + LLM key）验证后实施**。
- **② 单一真相源**：`userPoints` 只读投影、停用 `applyRetentionRolesFromUserPoints`（涉及 replay-checklist-walk-gate 断言迁移）、flag 状态机集中化、`retentionSuggestion` 退化重试。⚠️ 同上，需 e2e 验证后实施。

### ✅ 已实施（2026-08-12 第二轮，e2e 环境就绪后）

- **③ 骨架硬传承**（提交 `4606a8f`）：
  - `step3Quality` 新增 `enforceStep3SkeletonLock`：模型回合返回的 paragraphPlan 对齐到 planner 骨架（bodyPlans pointBlocks）；块级增删/改序/改角色一律拒收，仅允许 value 级修改（块内新 step key 允许追加以支持槽内 reclass/合并）。
  - `server` 新增 `buildStep3Skeleton`，在 `enforceStep3LogicCompletionInner` 合并后调用骨架锁。
  - 教练 prompt 新增 FROZEN SKELETON 规则：已有 paragraphPlan 时不得增删改块，结构变更走重规划流程。
  - 新增 `scripts/replay-skeleton-lock.mjs`（5 断言）；tsc + 全量 replay + Step3 e2e 通过。
- **② 单一真相源**（提交 `0b148ba`）：
  - `applyRetentionRolesFromUserPoints`：结构化 `retentionRole`（含 dropped）优先，字符串只对未标注的点补缺——消除"双写不同步"分叉方向。
  - 新增 `scripts/replay-single-truth.mjs`（4 断言）；tsc + 全量 replay + Step2/Step3 e2e 通过。
  - ⚠️ 其余清理（`userPoints` 完全只读投影、flag 状态机集中化、`retentionSuggestion` 退化重试）仍为后续项。
- **e2e 脚本修复**：`replay-e2e-step3-coverage.mjs` 的 coach 会话补传 `session.step2_5`（真实客户端行为），断言改为"active body 自身 mapped 点全覆盖"，消除对 planner 非确定性输出的依赖。
- **② 收尾（部分）**（提交 `39b8529`）：`retentionSuggestion` 退化显式化——结构化建议提供但本侧不可用时记录 warn 日志，不再静默退回 prose/长度启发式（文档 item5-4）。纯观察性改动。

### ⏳ 剩余收尾（需更谨慎的重构，建议在有完整 e2e 的新会话推进）

- **②**：`userPoints` 完全只读投影（由结构化派生）、flag 状态机集中化（`settleAwaitingCustomSide / rejectedMergeIds / stanceConfirmResolved / sideSettled / stanceAwaitingCustom / declinedSlotClaims / capacityTrimDismissedSides / pendingProposal`）。
- **③**：merge 按 pointBlock id 对齐（需把 `bodyPlans.mappedPointIds` 管线接入 `pickPrimaryPointBlock`/`blockMatchesMappedPoint`，当前 `framework` 只来自 clustering）、软守卫降级/退役。

### 真实旅程发现（2026-08-12，`replay-full-journey.mjs`，本地 DeepSeek key）

用本地 key 驱动了完整 Step1→Step2→Planner→Step3→Step4 真实交互（33 轮），结论：
- **Step1/Step2 正常**：Step2 详略提案（详写在职人员/略写低龄学生）→ 采纳 → 角色锁定；立场提案 → 采纳 → 立场锁定（"线上不应完全取代线下，但可作为补充"）。提案通道 + 按钮白名单端到端工作。
- **Planner 正常**：2 bodies、未降级。
- **Step3 骨架 + 填槽协议工作**：分论点→原因→机制逐槽经 pendingText→「对」→写入看板推进；③ 骨架锁保持块结构稳定。**但发现真问题 A**：教练的自然语言下一问偶发**回退到已确认的槽**（t13 学生答了原因、教练却问"分论点"；t16 确认原因后教练又问"分论点"）——服务端看板正确，是模型 P2 偏离 firstEmpty。
- **Step3 深度门槛按设计工作（B）**：对离题/泛泛的回答（如给"场景"而非"结果/影响"）持续追问，正确拒绝；模拟学生未能给出有效"影响"答案导致 Step3 22 轮未完成（脚本局限，非产品 bug）。
- **发现 C**：DeepSeek 偶发省略 `---` 分隔符 → `text_missing_delimiter` 触发修复重试（额外延迟/成本）。
- **发现 D**：`step3LastRejectCode` 正常出现（离题回答被硬拒）。

**据此更新收尾优先级（按真实 ROI）**：
- **P0 ✅ 已实施并复验（2026-08-12）**：Step3 下一问钳制——服务端在模型 P2 不指向真实 firstEmpty 时用规范问句覆盖（直接修发现 A 的 UX 瑕疵）。
  - `step3Quality.step3TextAsksConfirmedSlot(text, plan)`：命中"请先把「分论点」说具体一点"类已确认槽回退 → `detectStep3IllegalCoachText` 返回 `ask_confirmed_slot` → veto 到 firstEmpty 规范问句。
  - 单测 `scripts/replay-step3-next-ask-clamp.mjs`（5 断言）；tsc 0 错误；10 个纯函数 replay 全绿；Step3 e2e ALL PASS；真实旅程 t9 确认分论点后 P2 转向 firstEmpty（展开原因），未再回退已确认槽。提交：`test(journey)…镜像客户端 Step3 进度回写` + `fix(step3): P0 下一问钳制…`。
- **P1**：`---` 分隔符缺失时跳过修复重试（文本充实即单段兜底 + fallback part2），全步降延迟（修发现 C）。
- **P2**：③ merge ID 对齐（骨架锁已稳定块结构，旅程中标签合并非瓶颈，ROI 降低）；② userPoints 只读投影/flag 状态机（Step2 旅程正常，双写分叉是理论风险，可后置）。

### ⚠️ 说明

- 本环境无法运行完整 e2e（`replay-new-cases.mjs` 需要运行中的服务与 LLM key；3 个 `verify-*.mjs` 因工作区路径含空格读不到文件）。
- 分支 `work-step2-review` 已改写历史（ahead 10 / behind 1），**勿对其 force-push 覆盖远端**；若需同步，用新分支或 PR。
