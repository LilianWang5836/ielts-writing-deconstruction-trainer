# 执行 Prompt：产品纯净需求对齐修复

> 本文档是一份**可直接交给编码 Agent 执行的任务书**。基于 2026-08-16 对 HEAD（tag `v0.5.2.1`）的代码核查，所有 file:line 引用均已验证；行号可能漂移，定位失败时用给出的函数名/常量名 grep 锚定。

---

## 0. 任务总述

产品方给出了一份纯净需求（见 §2）。当前实现的主干（四步流程、planner 产出物、反代写红线、确认后写板）与需求对齐，但存在 **6 处已核实的偏离**。你的任务是按 §4 的优先级分阶段修复，每个阶段独立可验收。

**先读再改**：动手前必须读完 §1 架构常识和 §3 偏离清单，并打开文中引用的每个代码位置确认现状。若发现现状与本文描述冲突，**停下来报告冲突，不要自行决断方向**。

---

## 1. 项目背景与架构常识（约束你"怎么改"）

### 1.1 技术栈与运行

- Vite + React 19 前端（`src/`），Express 后端（仓库根目录 `server.ts`，约 11,570 行），LLM 为 `@google/genai`（Gemini）。
- 后端逻辑部分拆在 `src/server/`（`step1/`、`step2/`、`step3/`、`planner/`、`prompts/`）。
- 命令：`npm run dev`（起服务）、`npm run lint`（= `tsc --noEmit`，必须零错误）、`npm run build`。
- `scripts/` 下有回放/诊断脚本（如 `replay-full-journey.mjs`、`replay-e2e-step3-coverage.mjs`），用法见各脚本头部注释；需要 API key（`.env.local`，参照 `.env.example`）。

### 1.2 不可破坏的架构立场（红线）

当前架构是"会议秘书"确定性架构，以下原则是多次迭代后的**明确设计决策**，修复时不得回退：

1. **LLM 出判断、代码管状态**：LLM 只产出对话文本 + 判断（verdict/intent），所有状态变更由服务端确定性函数执行。
2. **学生原话是唯一真相源**：Step3 中学生文本落 minutes；润色版（`displayText`）只是看板投影，且必须通过反代写校验。
3. **骨架冻结**：planner 产出后 paragraphPlan 骨架只读，Step3 中 LLM 禁止输出任何结构字段（prompt 中有 "STRUCTURE IS SERVER-OWNED" 规则）。
4. **反代写红线**：教练不写句子、不补事实；任何语言加工必须有确定性校验兜底（`validatePolishedText`）。
5. **确认后写板**：任何内容未经用户显式确认不得进入 `confirmed` 状态。

### 1.3 关键现状地图（已验证）

- Step1 门禁：`STEP1_DIM_MIN_EFFECTIVE = 3`（`server.ts:2519`），全局计数门禁在 `server.ts:2651-2657`；软退出阻断 `server.ts:5703-5705`；完成态清除 `server.ts:5782-5798`。维度探针状态机在 `src/server/step1/dimension-probe.ts`。
- Step2：实时抽取进 `userPoints`/`plannerPayload.points`（prompt 规则 `server.ts:8702`）；提案机制（`side_settle`/`stance`/`slot_add`/`slot_merge`）在 `src/server/step2/proposal.ts`，按钮渲染在 `src/components/CoachChat.tsx:1281-1313`；右侧材料池在 `src/components/Step2Brainstorm.tsx:755-897`。
- Step3 秘书流：`enforceStep3SecretaryPath`（`server.ts:4323-4602`）→ `resolveLandingGate`（`server.ts:4460`）→ 落槽为 pending → 确认走 `/api/step3/decision`（`server.ts:9463-9526`，零 LLM）；秘书函数在 `src/server/step3/secretary.ts`；看板渲染 `src/components/Step3Drafting.tsx:695-710`（待确认卡片）。
- Planner：prompt 在 `src/server/prompts/planner-prompts.ts`，机械 QA 在 `src/server/planner/planner.ts:261-310`；stale 判定用 `plannerPayloadFingerprint`（`server.ts:1702`、`1854-1857`）。
- 死代码（不要基于它们开发，也不要顺手删）：`src/server/coach/`、`src/server/guards/consistency.ts`、`src/server/prompts/coach-prompts.ts`、`intent-prompts.ts`。

---

## 2. 产品纯净需求（验收基准，原文）

> 整体要求：
> - AI 以陪练身份，帮助用户顺利完成一篇 IELTS Task 2 作文；大部分用户水平 5-6。
> - 写作观点主要由用户给出，AI 使用苏格拉底式提问引导，在和用户确认后定稿。
> - AI 不得直接给回答，不得强行要求用户按 AI 给出的套路来写。
> - 在不改变用户原义的情况下，AI 可以对用户的回答进行措辞和逻辑上的小幅调优。
>
> 第一步 审题：判断题型；理解题目（话题、讨论对象/范围、论证要求、限定词/极端表达）；列出讨论维度。AI 职责：确保正确理解题意；确保列出足够数量可用的维度（初步判断可扩展性；检查论点间高度重叠；**每个问题/每一侧至少 2 个点**：两问题 ≥4，双边讨论 ≥4，同意与否 ≥2）。
>
> 第二步 确定框架大纲：依次展开每个问题/每一侧下的论点（苏格拉底式提问）；完成单侧后确认详略策略；继续下一侧；选择立场（如需要）。AI 职责：判断论点展开程度；基于展开程度与支撑度给出详略建议（引导性）；基于论证思路给出立场建议（引导性）。
> 交互流程：论点1 → 教练提问 → 用户回答 → 教练反馈/优化 → **用户确认 → 确认无误 → 同步至右侧结构区，填入该 slot** → 进入下一个论点 → 完成单侧 → 选详略 → 完成所有 → 选立场。
>
> 第 2.5 步 planner：产出立场、中间段个数 + 每段论点 + 详略策略 + 每个论点的论证链条（2-3 个 body 段）。
>
> 第三步 完成论证链：基于段落框架完成 body 段逻辑链条。
> 交互流程：body1 → slot1 → 教练提问 → 用户回答 → 教练反馈/优化 → **用户确认 → 确认无误 → 同步至右侧结构区，填入该 slot** → 进入下一个 slot。

---

## 3. 已核实偏离清单（证据已验证）

| # | 需求 | 现状 | 证据 |
|---|------|------|------|
| D1 | Step1 每问/每侧 ≥2 点 | 只有**全局 ≥3** 有效维度的硬门禁，不按问/侧计数；"每问 2 个"只是 prompt 软偏好且有逃生口 | `server.ts:2519,2651-2657,8275` |
| D2 | Step1 检查论点高度重叠 | 仅 prompt 文案，无代码级重叠判定 | `server.ts:8260,5703` |
| D3 | Step2 逐点"确认→同步右侧" | 实时抽取免确认；右侧是材料池滚动，无逐点确认环节 | `server.ts:8702`、`Step2Brainstorm.tsx:755` |
| D4 | Step3 润色失败应对用户可见 | 校验失败静默回退原文，用户不知润色发生过 | `secretary.ts:243` |
| D5 | "不得强行按套路写" ↔ 定稿后可改 | 已确认 slot 无修订入口；结构异议被当 meta 挡回，无重规划路径；唯一出路是清空整个 body | `server.ts:4397-4449`、`Step3Drafting.tsx:555-591` |
| D6 | Step3 逐 slot 确认 | beats 批量落槽允许一次确认 2-3 槽 | `secretary.ts:306-364` |

**已对齐无需改**：planner 产出物（立场/body 数/每段论点 `mappedPointIds`/详略 `role`/论证链 `steps[]`）、Step2 阶段顺序与详略/立场提案的采纳-拒绝路径、Step3 确认时序（未确认不写定）、反代写机制、陪练口吻。

---

## 4. 修改任务（按优先级分阶段）

### 阶段 P1：Step1 门禁改为按问/侧计数（修 D1）

**目标**：实现"每个问题/每一侧至少 2 个有效维度"的硬门禁，替代全局 ≥3。

**步骤**：
1. 先读 `src/server/step1/dimension-probe.ts` 全文与 `server.ts:2490-2700`，弄清 `suggestedDimensions` 的数据结构，确认维度条目是否带有"归属哪一问/哪一侧"的字段。
2. 若无归属字段：在维度抽取/打标环节增加归属标注（LLM 产出时要求标注 `side`/`questionIndex`，服务端校验归属性；归属不明的维度计入"未归属"，不计入任何侧的达标数）。有效维度定义保持不变（`已探测`+`可展开`，`server.ts:2536-2546`）。
3. 门禁改造：按题型确定所需侧数（双边讨论 2 侧、两问题 2 问、同意与否 1 侧），要求**每侧 ≥2 个有效维度**方可通过 `isStep1SlotsComplete`。保留现有的维度总数上限（cap=6）与"已询退出"逃生机制，但逃生放行也必须是按侧判定后的放行（例如某侧确认挖不出来，走"质量待确认"式降级，而不是静默通过）。
4. 同步更新软退出阻断（`server.ts:5703-5705`）与完成态清除（`server.ts:5782-5798`）的计数逻辑；prompt 文案（`server.ts:8275` 附近）改为与硬门禁一致，删掉"只给 1 个也接受"的逃生口。
5. 同意与否题型只有 1 侧时，门槛为 ≥2（与需求一致），注意不要让旧的 ≥3 逻辑残留。

**验收**：构造双边讨论题会话，一侧 3 点、另一侧 0 点 → 门禁不通过、软退出被阻断、提示指向薄弱侧；两侧各 2 点 → 通过。`npm run lint` 零错误。

### 阶段 P2：Step3 已确认槽的修订入口（修 D5 前半）

**目标**：用户可修改已确认写板的 slot，全程确定性、零 LLM。

**步骤**：
1. 在 `/api/step3/decision`（`server.ts:9463-9526`）新增 action（如 `decision: "reopen"` + `slotKey`）：将对应 minute 从 `confirmed` 回退、清空该 slot 的 value/status、把秘书游标移回该 slot、追加审计记录、返回新看板投影。注意处理该槽之后已确认槽的联动策略——**最小方案：只允许 reopen 不破坏后续槽**（后续槽保持已确认，学生重写该槽后重新确认即可）；如果实现中发现 minutes 顺序假设被破坏，停下来报告。
2. 前端：`Step3Drafting.tsx` 已确认槽卡片加"修改"按钮，走同一 decision 通道。
3. reopen 后该槽的后续流程复用现有 pending→confirm 路径，不要新造轮子。

**验收**：确认 body1-slot1 后可点"修改"，槽位回到待填，重新作答并确认后正常写板；reopen 不影响其他已确认槽；`npm run lint` 零错误。

### 阶段 P3：结构异议的重规划路径（修 D5 后半）

**目标**：学生在 Step3 坚持改结构时，提供"确认 → 清 Step3 → 重跑 planner"的显式路径，而不是被当 meta 挡回。

**背景**：该机制在设计文档中早已存在但从未实现——先读 `docs/requirements-and-fix-plan.md` 的 R6/§6.6 与 `docs/step2-5-architecture.md` §4.4/§6.2（`structureChangeOffer` 设计），按设计实现，不要另起方案。

**步骤**：
1. 意图识别：复用 Step3 `step3Assessment.intent` 字段，增加结构变更意图（如 `structure_change`）；LLM 判为该意图时，教练给出一轮"改结构将清空当前 body 进度并重新规划"的确认要约（状态存 session，如 `pendingStructureOffer`），而不是直接执行。
2. 学生确认后：清空 Step3 的 minutes/skeleton 状态，将 `step2_5` 标记为 stale（复用 `plannerPayloadFingerprint` 机制，`server.ts:1702,1854-1857`），引导回 Step2 修改材料或直接重跑 planner（材料未变时）。
3. 拒绝要约则关闭 offer，正常继续 Step3。
4. 更新 Step3 prompt（`server.ts:8578` 附近禁止结构提案的规则），让教练可以**表达**该要约（结构变更的执行仍在服务端）。

**验收**：学生在 Step3 说"我想把第二个论点换掉"→ 收到要约 → 确认后 Step3 清空、planner 重跑、流程可继续；拒绝则无副作用。`npm run lint` 零错误。

### 阶段 P4：润色失败对用户可见（修 D4）

**目标**：`validatePolishedText` 回退原文时，用户能看到"保持原话"的提示。

**步骤**：
1. 服务端：润色校验失败（`displayText` 置 null 处，`secretary.ts:243` 附近）时，在返回前端的 pending 数据/`progressUpdate` 中加标志位（如 `polishReverted: true`）。
2. 前端：待确认卡片（`Step3Drafting.tsx:695-710`）在该标志下显示一行弱提示（如"已保持你的原话"），风格与现有看板一致，不打断流程。

**验收**：构造润色校验失败的输入（如让模型产出偏离原文的 polishedText），看板显示原文 + 提示；正常路径无提示。

### 阶段 P5：Step2 逐点确认（修 D3，大改，先做决策点）

**决策点（先向需求方确认，再动手）**：
- 方案 A（默认，对齐需求）：实现逐点确认——每个论点展开完成后，教练给出该点的整理稿，学生确认后才以"已确认"状态进入右侧材料池；未确认的点显示为"待确认"。
- 方案 B：维持实时抽取现状，推动需求方改写需求文档。若选 B，本阶段只交付需求文档修订建议，不改代码。

**方案 A 步骤**：
1. 改 Step2 prompt 的实时抽取规则（`server.ts:8702`）：抽取照旧用于理解，但点位进入材料池前需经确认。
2. 复用现有提案/按钮机制（`CoachChat.tsx:1281-1313`）做"点位确认"提案；材料池（`Step2Brainstorm.tsx:755-897`）加 待确认/已确认 徽标。
3. `planner-payload.ts` 只消费已确认点位；未确认点不得进入 planner 输入。
4. 注意与 `slot_add`/`slot_merge`/`side_settle` 提案的交互顺序，避免多个 pendingProposal 互相覆盖。

**验收**：Step2 全程走完，每个点都经过显式确认才进材料池；planner 输入只含已确认点；`npm run lint` 零错误，跑通 `scripts/replay-full-journey.mjs` 类全流程回放。

### D6（批量落槽）：不修，仅记录

一次确认多槽是效率优化且语义安全（同一 confirm 覆盖的槽都展示过）。**不修代码**，在交付说明中向产品方标注此偏差，由产品决定是否改需求。

---

## 5. 全局约束

1. **最小改动**：每个阶段只碰所列位置；不做顺手重构、不清理死代码、不改无关 prompt 文案风格。
2. 新增 prompt 文案与现有风格保持一致（现有为中英混排，教练对学生说中文）。
3. 不得削弱 §1.2 的任何红线；新增的状态变更一律走服务端确定性函数 + 审计记录。
4. 每阶段完成后：`npm run lint` 零错误 + 该阶段验收用例通过，再进下一阶段。
5. 行为变更涉及现有 docs 描述的地方（如 Step1 门禁、Step3 决策通道），在对应文档补一节变更记录（项目惯例：docs 记录每次行为演进）。
6. 不要执行 `git commit`/`git push`；改动留在工作区由人审查。

## 6. 交付物

- 各阶段代码改动 + 每阶段一段"验收结果"说明（怎么测的、结果如何）。
- 一份变更总结：列出每个偏离（D1-D6）的最终状态（已修/不修及原因）。

---

## 7. 变更记录（2026-08-16 执行后，追加）

> 本节为本次执行后补充的变更记录（项目惯例：docs 记录每次行为演进）。
> 改动均留在工作区，未执行 `git commit` / `git push`。

### 7.1 偏离最终状态

| # | 需求 | 最终状态 | 说明 |
|---|------|---------|------|
| D1 | Step1 每问/每侧 ≥2 点 | ✅ 已修（P1） | 门禁改为按题型每侧 ≥2 有效维度；软退出/完成态提示指向薄弱侧；prompt 对齐并移除"只给 1 个也接受"逃生口 |
| D2 | Step1 检查论点高度重叠 | ⚠️ 未分配阶段 | §4 阶段清单未包含 D2（仅列在 §3 偏离表）。现状仅 prompt 文案 + 身份去重（`headsCompatible`），无代码级"质量重叠"判定。**建议后续补一个确定性重叠检测**（同侧两条维度核心标签 bigram 重叠 ≥ 阈值则合并/追问），不在本次范围 |
| D3 | Step2 逐点"确认→同步右侧" | ⏸️ 决策待定（P5） | 见 §7.4 |
| D4 | Step3 润色失败对用户可见 | ✅ 已修（P4） | `Step3Minute.polishReverted` 标记 + 待确认卡片显示"（已保持你的原话）" |
| D5a | 已确认 slot 修订入口 | ✅ 已修（P2） | `/api/step3/decision` 新增 `reopen` + `reopenSlot` 确定性函数 + 看板"修改"按钮 |
| D5b | 结构异议重规划路径 | ✅ 已修（P3） | `intent=structure_change` 武装 `pendingStructureOffer` → 确认后清 Step3 + stale step2_5 → 前端重跑 planner 重建 |
| D6 | Step3 逐 slot 确认（批量落槽） | ➖ 不修（按任务书） | 一次确认多槽是效率优化且语义安全，标注给产品方决定 |

### 7.2 各阶段改动摘要与验收

- **P1（Step1 按侧门禁）**：`server.ts` 新增 `STEP1_DIM_MIN_PER_SIDE=2`、`STEP1_DIM_SIDE_TAG_RE`、`step1DimensionSide`、`step1RequiredSides`、`step1PerSideStatus`、`formatStep1MissingSideHint`；`isStep1SlotsComplete` / `computeStep1DimensionsSufficient` / `buildStep1Digest` 改为按侧判定；软退出与完成态消息指向薄弱侧；Step1 prompt 新增 `（侧：A/B/G）` 侧别标签要求并移除"只给 1 个也接受"；`Step1Analysis.tsx` 显示剥离侧别标签。验收：`scripts/verify-p1-per-side.mts`（12 用例全过，含 A3/B0 拦截 + 提示指向观点B、A2/B2 通过）；`npm run lint` 零错误。
- **P2（已确认槽修订）**：`src/types.ts` 审计事件新增 `reopened`；`secretary.ts` 新增 `reopenSlot`（confirmed→recorded、清槽、游标移回、审计）；`server.ts` decision 通道新增 `reopen` action 并把 `session.step3.isCompleted` 改为随 `step3Done` 回写（reopen 会解除完成态）；`Step3Drafting.tsx` 已确认槽加"修改"按钮。验收：`scripts/verify-p2-reopen.mts`（16 用例全过）；lint 零错误。
- **P3（结构重规划）**：`server.ts` 新增 `applyStep3StructureReplan`（清全部 body 秘书状态 + stale step2_5）、`enforceStep3SecretaryPath` 增加要约状态机（`structure_change` 武装 → 确认清空 / 拒绝关闭）；prompt 意图枚举加 `structure_change` 并允许教练表达重规划要约；`Step3Drafting.tsx` 监听 `structureReplanned` 重跑 planner 并重建 Step3（loading/失败重试 + 输入禁用）。验收：`scripts/verify-p3-replan.mts`（17 用例全过）；lint 零错误。
- **P4（润色回退可见）**：`Step3Minute` 加 `polishReverted`；`appendMinute` 支持；秘书落槽时按 `validatePolishedText` 结果打标；前端待确认卡片显示"（已保持你的原话）"。验收：`scripts/verify-p4-polish.mts`（8 用例全过）；lint 零错误。

**回归**：纯函数回放/验证全绿（17 套），唯一失败为 `replay-retention-planner-checklist.mjs`（**基线已存在的已知非回归**：其 C 段源码扫描断言的字符串 `No incomplete sibling body; promoting to whole-step jump CTA` 已在早前 rebuild 中被移除，非本次改动引入）。`npm run build` 通过。

### 7.3 关键设计决策（执行中定稿）

- **P1 单侧题型口径**：Agree/Disagree 等单侧题型为"全部有效维度计入唯一侧，未归属也计入"——避免无意义死锁；双侧题型未归属维度不计入任何侧（按任务书）。
- **P1 逃生**：`exhausted`（学生表示无法补充）时某侧维度已全部探测（或该侧无标签）即按"质量待确认"式降级放行，避免死锁；未 exhausted 时"一侧 0 点"仍拦截并指向薄弱侧（符合验收）。
- **P3 要约状态**：存放在 active subpoint `pendingStructureOffer`（随 `step3SecretarySubpoints` 往返，天然持久化），而非独立 session 字段。
- **P4 可见性载体**：`polishReverted` 打在 minute 上（随 board 投影往返），不额外加 progressUpdate 标志，前端待确认卡片直接读。

### 7.4 P5 决策记录（待需求方确认）

执行时需求方不可用（稍后审阅），按任务书"先向需求方确认，再动手"的硬性门槛，**未擅自实施 P5 大改**。以下为两个方案的交付物：

**方案 B —— 需求文档修订建议（若维持现状）**：
> Step2 交互流程中"论点 → 教练反馈/优化 → 用户确认 → 同步右侧填槽"的建议修订：当前实现已把"材料池 + 每侧详略 `side_settle` 采纳/拒绝 + 立场 `stance` 采纳/拒绝"作为 Step2 的显式确认点；若保留"逐点确认"，建议明确其与详略/立场确认的职责边界，避免三点重复确认导致轮次膨胀（与教练智慧方案"净轮次不增"红线冲突）。可考虑折中：**每侧批量一次确认**（该侧所有展开点整理好后统一确认入池），而非逐点确认。

**方案 A —— 实施计划（供审批后执行）**：
1. `planner-payload.ts`：`points[]` 增加 `confirmed?: boolean`（新抽取点默认 false；`side_settle` 采纳时该侧已确认点转 true）。
2. Step2 prompt：抽取照旧用于理解，但新点以"待确认"呈现，教练给出该点整理稿并请学生确认（复用 `slot_add` 式确认 UI 或新增 `point_confirm` 提案）。
3. `planner-payload.ts` 消费侧只取 `confirmed === true` 的点；未确认点不进入 planner 输入。
4. `Step2Brainstorm.tsx` 材料池加 待确认/已确认 徽标。
5. 校验与 `slot_add`/`slot_merge`/`side_settle` 提案的互斥（同一轮只允许一个 pendingProposal）。

**推荐**：倾向"方案 A + 每侧批量一次确认"的折中（对齐 PM 需求又控制轮次）；待需求方拍板后实施。

### 7.5 未提交

全部改动留在工作区，未执行 `git commit` / `git push`，由人审查。新增验证脚本：`scripts/verify-p1-per-side.mts`、`scripts/verify-p2-reopen.mts`、`scripts/verify-p3-replan.mts`、`scripts/verify-p4-polish.mts`。

### 7.6 审查后修订（2026-08-16，P3 要约安全性）

代码审查发现 P3 的 `pendingStructureOffer` 原实现**跨轮次保持武装**（非确认/拒绝回复不清要约），且要约确认检查排在落槽确认之前——学生先表达结构异议、转而正常作答后再对落槽内容打裸确认（"对/好"）时，会被误吞为重规划确认，**不可逆清空全部 Step3 进度**。

已修复（`server.ts` `enforceStep3SecretaryPath` 要约块）：非确认/拒绝回复一律**解除要约**并按普通内容处理，同时清除 `lastGateHint` 的 structure_change 痕迹（避免教练继续追问已失效的要约）；学生若当轮仍在表达结构变更，`structure_change` 分支会重新武装要约。验证：`npm run lint` 零错误；verify-p1~p4、verify-secretary / verify-step3-gate / verify-replay / verify-lens、replay-skeleton-lock / replay-single-truth 全部通过。
---

## 8. 阶段2 变更记录（T1/T2/T3，2026-08-16 执行后，追加）

> 阶段2 任务书：`docs/prompt-ds-alignment-phase2-2026-08-16.md`。本轮完成 **T1（Step1 侧签加固）**、**T2（每侧批量确认并入 side_settle，P5 折中落地）**、**T3（真实链路端到端走查 + 修复）**；T4 即本节。全部改动留工作区，未 `git commit` / `git push`。

### 8.1 T1：Step1 侧签加固（side-tag 跨轮保留）

- `src/server/step1/dimension-probe.ts`：新增 `SIDE_TAG_RE` / `stripStep1SideTag` / `step1DimensionSide` / `stripStep1AllTags`；`collectCores` / `preserveStep1ProbeTags` / `resolvePendingProbeAnswer` / `buildBareDimensionProbeAsk` / `textLooksLikeProbeAskForDim` 对 core/label 剥离侧签；`preserveStep1ProbeTags` 恢复先前丢失的侧签（尊重显式 A→B 变更）。
- `server.ts`：`pendingProbeCore` 与探针匹配同样剥离侧签（连带修复 T1 的跨文件坑）。
- 验收：`scripts/verify-t1-side-preserve.mts`（8 用例全过）；lint 零错误。

### 8.2 T2：每侧批量确认并入 side_settle（P5 折中落地）

- **决策**：P5 需求书原方案 A（逐点确认）与"净轮次不增"红线冲突 → 采纳 §7.4 推荐的折中：**每侧批量一次确认**，并入既有 `side_settle` 提案，不新增确认轮次。
- 改动：
  - `src/types.ts`：`Step2Point.confirmed?: boolean`（undefined=legacy）。
  - `src/server/step2/planner-payload.ts`：`upsertPointsFromClaims` 新点 `confirmed:false`；新增 `isPointConfirmed`（迁移：`confirmed===undefined` 且侧在 `sideSettled` → 视为已确认）；`plannerPayloadFingerprint` 纳入 confirmed 位；`buildPlannerMaterialDigest` 支持按已确认点集合生成。
  - `src/server/step2/proposal.ts`：`commitProposal` `side_settle` → `{ ...p, retentionRole: role, confirmed: true }`；`slot_add` → `confirmed: true`；`buildAskFromProposal` `side_settle` 文案加「采纳后将把这 N 条论点确认写入材料池（未采纳前为待确认）」。
  - `src/server/planner/planner.ts`：`collectPlannerInput` 只消费 `isPointConfirmed` 的点（未确认点不进 planner 输入）。
  - `src/components/Step2Brainstorm.tsx`：材料池加 已确认(emerald)/待确认(amber) 徽标；`pointSideKeyUi` / `isPointConfirmedUi`（含 `sideSettled` 迁移）；确认位在 `flatItems` 折叠中保留。
- 验收：`scripts/verify-t2-point-confirm.mts`（12 用例全过）；lint 零错误。

### 8.3 T3：真实链路端到端走查（dev server :3000 + 真实 DeepSeek）

方法：`npm run dev` 起服务，交互式学生 + 新增驱动器 `scripts/e2e-step1-side.mjs`、`scripts/e2e-step3-structure-offer.mjs`、`scripts/e2e-step3-trigger.mjs` 驱动真实会话，存档 `docs/recorded-sessions/`。

#### T3.1 Step1 侧签 + A3/B0 门禁
- ✅ **A3/B0（A 侧 3 点 / B 侧 0 点）门禁指向缺失侧**：教练多轮明确引导「观点B / 反方 / B面」（LLM 散文为主 + 确定性 `formatStep1MissingSideHint`），未死循环（每轮措辞变化、持续指向 B）。
- ⚠️ **发现 F1（待产品确认）**：DeepSeek **不输出 （侧：A/B） 侧签**——`suggestedDimensions` 返回纯字符串（如 `"效率提升、成本降低"`），无视 STRICT prompt 指令。确定性 per-side 计数（`STEP1_DIM_SIDE_TAG_RE`）实为 0/侧；A3/B0 拦截实际靠 LLM 散文引导。T1 侧签机制仅单测验证（`verify-t1-side-preserve`），实机未被锻炼。
- ⚠️ **发现 F2（待产品确认）**：**耗尽逃生不自动退出**——学生反复"想不出B"（触发 `studentSignalsExhausted` → per-side 降级放行 → exitOpen），但 `exitOffered` 需模型文本软询问退出才盖章；模型持续追索 B、从不发完成 CTA → `isCompleted` 保持 false → 无硬出口（非死循环但会卡住）。属 §7.3 P1 anti-deadlock 交易项在实机的不彻底落地。

#### T3.2 Step3 结构要约（P3 特性实机验证）
- ❌→✅ **修复 1（结构变更触发）**：P3 的 `structure_change` 分支完全依赖 assess LLM 的 `intent` 分类；实测 DeepSeek 把「我想把第二个论点换成…/结构不合适/想重新规划」一律判为 content 落槽 → `pendingStructureOffer` 永不武装 → **P3 特性实机不可达**（学生"对"只会写板，永不重规划）。修复：`server.ts` `enforceStep3SecretaryPath` 在 LLM 意图解析前加**确定性 `STRUCTURE_CHANGE_RE` 兜底**（武装要约、不落槽，仍需学生确认/拒绝）。
- ❌→✅ **修复 2（确认文案矛盾）**：确认重规划时复用 LLM 的 P1 会与确定性动作自相矛盾（"你确认要改吗？"+"已清空…"）；确认分支固定 P1「好的，已确认。」。
- ✅ 修复后全断言通过：要约武装、**§7.6 交错解除**（正常作答后裸"对"不再触发重规划）、确认→重规划+清空 Step3、拒绝→结构保留、重建 Step3（重跑 planner）。
- ✅ 前端闭环核实：`Step3Drafting.tsx` 监听 `step3.structureReplanned` → `runReplan()` → `/api/planner/generate` → 重建 subpoints。

#### T3.3 P5 smoke（Step2 side_settle）+ 题型推断
- ✅ side_settle 提案卡片含 **论点列表 + 详略建议 + 「采纳后将把这 N 条论点确认写入材料池（未采纳前为待确认）」**；采纳路径（「①详写」）→ 锁定详略 → 推进下一侧；拒绝路径由 `verify-t2-point-confirm` 单测覆盖。
- ✅ **修复 3（既有 bug）**：`inferQuestionTypeFromQuestion` 把含 `cause` 的 Discuss Both Views（"…will cause widespread unemployment. Discuss both views…"）误判为 Problem/Solution（`hasCauses` 分支在 `hasBothViews` 之前）。修复：显式题型标记（both views / agree / adv-dis / pos-neg / other）优先于因果启发式 + `normalizeQuestionTypeLabel('Discussion')` → `Discuss Both Views`。静态 8 用例 + 实机探针均通过（Step2 走「观点A/观点B」）。
- ⚠️ **发现 F3（既有，非本次引入）**：Step2 完成时 DeepSeek 两次缺 `blueprint` → `CoachGuard step2_summary_missing_blueprint` 弹回 → 落到缺料兜底（真实用户点「确认进入下一步」可能被弹回，潜在真实脆弱点）。

### 8.4 回归

- verify 13 套全 PASS（P1/P2/P3/P4/T1/T2 + guards/lens/replay/secretary/step3-gate/discussion-step2/step-openers）；lint 零错误；build 通过。
- replay 全量（除基线失败项）PASS：skeleton-lock / single-truth / step3-next-ask-clamp / framework-coverage / checklist-walk-gate / full-journey / step1-dimension-probe / proposal-phase1 / proposal-channel / merge-by-id / new-cases / parse-coverage / step2-english-head / student-multi / typen-e2e / e2e-step3-coverage。
- `replay-typen-e2e.mjs` 与 `replay-e2e-step3-coverage.mjs` 曾 FAIL：断言读 `progressUpdate.paragraphPlan`（LLM 回显字段，秘书路径不返回）。经核实**真实契约是客户端构建的 `subpoint.paragraphPlan`**（随 `step3SecretarySubpoints` 往返，前端 `Step3Drafting.tsx` 正是从 subpoint 读取）→ 非产品回归，属陈旧断言。已把两个脚本断言回退到 `sp.paragraphPlan` / `activeSub.paragraphPlan`，修复后均 PASS（typem-e2e：3 题型 ALL PASS；e2e-step3-coverage：ALL PASS）。
- 已知基线失败（非本阶段引入）：`replay-retention-planner-checklist.mjs`（断言字符串在早前 rebuild 被移除）。

### 8.5 待产品确认清单（新增）

1. **Step1 侧签合规（F1）**：DeepSeek 实机不输出 （侧：A/B） 标签 → 确定性 per-side ≥2 计数实为 0/侧。选项：(a) 接受 LLM 散文引导 + 耗尽逃生（现状，契合"LLM 出判断"）；(b) 服务端确定性派发侧别（对 LLM 维度做后处理）。建议产品拍板。
2. **Step1 耗尽逃生不自动退出（F2）**：学生反复"想不出B"无硬出口。建议：确定性 `exhausted` → 强制出口提示（防死锁；严格违反"每侧≥2"字面，需产品确认）。
3. **D6 批量落槽**（阶段1已决定不修）：一次确认多槽语义安全，留产品决定。
4. **P5 实际实现口径**：每侧批量确认并入 side_settle（非"逐点确认"字面），与 §7.4 推荐一致；产品若坚持逐点需重排轮次。
5. **Step2 完成 blueprint 生成不稳（F3）**：评估完成态 `blueprint` 允许服务端确定性补全/降级，避免真实用户卡在 Step2。
6. **题型推断修复（本次已修）**：含 `cause/reason` 的 Discuss Both Views 不再误判为 P/S；需回归确认无新误判（如同时含 "discuss both" 的混合题）。

### 8.6 新增脚本

`scripts/e2e-step1-side.mjs`、`scripts/e2e-step3-structure-offer.mjs`、`scripts/e2e-step3-trigger.mjs`、`scripts/probe-type-infer-live.mjs`、`scripts/check-question-type-infer.mjs`、`scripts/verify-t1-side-preserve.mts`、`scripts/verify-t2-point-confirm.mts`。存档：`docs/recorded-sessions/recorded-e2e-step1-side-20260816.txt`、`recorded-e2e-step3-offer-20260816.txt`、`recorded-e2e-step3-trigger-20260816.txt`、`recorded-session-discussion-interactive-20260816151742.txt`。
---

## 9. 阶段3 变更记录（F1/F2/F3 修复，2026-08-17）

> 阶段2 实机走查（§8.3）发现 F1/F2 使 D1 修复在生产模型（DeepSeek）下实质未落地、F3 为既有脆弱点。本阶段直接修复，改动留工作区未 commit。

### 9.1 F1：Step1 侧别归属改走结构化字段

- **根因**：DeepSeek 对 prompt 文内 `（侧：A/B/G）` 标签指令遵从度为零（§8.3 存档：侧签 0 次），但对 JSON schema 字段遵从度高。
- **修复**：
  - 响应 schema `step1Data` 新增 `dimensionSides: [{dimension, side}]`（A/B/G 枚举），prompt 改为"必须在该字段声明每个维度的侧别"，文内标签降为可选；
  - `server.ts` 新增 `applyStep1DimensionSides`：把结构化声明确定性翻译成现有 `（侧：X）` 标签约定（下游 `step1PerSideStatus` / T1 恢复逻辑零改动）；已有侧签不覆盖、标签文本不完全一致时按唯一包含关系模糊匹配；声明优先取本轮模型输出，回退会话持久化值。
- **验收**：`verify-p1-per-side.mts` 新增 3 用例（注入后按侧通过 / 已有侧签不覆盖+模糊匹配 / 非法 sideMap 不改动），全部通过。

### 9.2 F2：exhausted 确定性硬出口

- **根因**：`isStep1ExitGateOpen` 对 exhausted 放行，但最终完成仍需模型文本含硬 CTA；DeepSeek 持续追索缺失侧从不发 CTA → 实机 10 轮 cap 卡死。
- **修复**：`enforceStep1SlotCompletion` 新增确定性分支——`exhausted && slotsOk && dimsSufficient && !newDimSameTurn && !ctaOk` 时，服务端直接改写 Part2 为硬 CTA（"请点击【下一步】进入第二步"）并置 `isCompleted`，同时补 `exitOffered` 戳。

### 9.3 F3：summary blueprint 确定性补全

- **修复**：`checkNeedsRepair` 的 `step2_summary_missing_blueprint` 分支先尝试 `synthesizeStep2BlueprintFromPayload`（详写点各自成段、略写点并一段、立场取已锁定值，只消费已确认点）；材料不足才走原修复重试。

### 9.4 连带防御修复（实机 500）

- e2e 复跑触发 `(step1Eval.suggestedDimensions || []).map is not a function`：模型把数组字段返回为字符串/对象。加固两处：`enforceStep1SlotCompletion` 维度入口归一化（对象取 `dimension/label` 字段、字符串包数组）；prompt 上下文构建（`server.ts` Step1 Coach Evaluation 段）`suggestedDimensions`/`constraints` 同样归一化。

### 9.5 验收与回归

- `npm run lint`（tsc）零错误；verify 11 套全过 + `check-question-type-infer` 8/8。
- e2e 复跑（dev server + 真实 DeepSeek）：正常路径 `verify-discussion-step2`（Step1→Step2→Planner）通过（step2 isCompleted=true，planner status=passed、非降级、3 body 段）；对抗路径 `e2e-step1-side` 迭代记录见 §9.6。

### 9.6 阶段3 续：实机迭代修复（2026-08-17，e2e 驱动）

阶段3 首轮 e2e 暴露出一串更深的问题，逐一修复如下（均在 `server.ts` / `src/server/step1/dimension-probe.ts`，改动留工作区）：

1. **驱动脚本 bug（重大发现）**：`scripts/e2e-step1-side.mjs` 传 `step: 'step1'`（字符串），`Number()` 得 NaN → Step1 全部服务端守卫被跳过。§8.3 的 F1/F2 观测实际是在"门禁从未运行"的前提下做出的。已修为 `step: 1`。其余驱动（step3 系列、verify-discussion-step2）均为数字，未受影响。
2. **`stripIllegalSameTurnProbeTags` 空洞**：原逻辑对"老 core"直接放行——首轮被剥成裸标签的维度入会话后，模型下一轮重新贴自报戳会被当老 core 放行，随后 `preserveStep1ProbeTags` 把脏戳当服务端戳永久锁定（实机观测）。修复：只对"prior 中带合法戳的 core"放行，其余自报戳一律剥除。
3. **伪戳 `（待探测）`**：DeepSeek 自造的非协议戳，归入剥离列表（两文件 STATUS_TAG_RE 同步），按裸标签语义处理。
4. **空 `step2Data:{}` 触发反漂移强制完成**：`applyStepCompletionHeuristic` 把 Step1 中模型顺带输出的空 step2Data 当 drift 直接 force-complete（曾致第 1 轮误判完成）。
5. **Step1 完成判定收归独占**：同一启发式对"CTA 文案"也强制完成，绕过按侧门禁（实机观测：双侧 0 有效角度、门禁提示缺失侧的同时被判完成）。修复：stepNum===1 分支整体移除，Step1 完成判定由 `enforceStep1SlotCompletion` 独占。
6. **侧别前缀习语**：模型把侧别写进标签文本（"角度A（…）"/"A面…"/"第1问…"），`step1DimensionSide` 增加词首习语识别（server.ts 与 dimension-probe.ts 同步）。
7. **聚焦侧别小调用兜底**：`maybeClassifyStep1DimensionSides`——双侧题型、存在无归属维度、维度集合指纹变化时才触发（temperature 0.1 的独立小 prompt），结果写入 `dimensionSides` 复用 F1 注入通道。
8. **F2 硬出口底线修正**：初版 `effectiveCount ≥2` 会挡住"学生给了真实材料但被判 thin"的正当逃生；改为"已探测维度 ≥2"（已探测=教练问过、学生答过；空 dims 空洞完成仍被挡）。

**e2e 迭代记录（e2e-step1-side，对抗场景：A 侧 3 点 + B 侧 0 点 + 持续"想不出来"）**：
- 第 1–5 轮（step 参数 bug 期间）：守卫未运行，结论无效；
- 第 6 轮：守卫首跑，dimensionSides 返回+注入成功、探针改写成功，但空 step2Data 误触发完成；
- 第 7 轮：按侧门禁真实工作（教练文本带"「观点A」当前 0 个有效角度…"提示），但 CTA 启发式绕过门禁判完成；
- 第 8 轮：门禁持有成功不再误判完成，但 F2 底线（effectiveCount≥2）挡住耗尽逃生，打满 cap；
- 第 9 轮：门禁/侧签/探针全链路正常，仍打满 cap——剩余失败为**模型行为层**：维度不逐轮累积（LOCK 遵从差，裸标签被丢弃后不在 preserve 保护范围）、富内容被判 thin、侧别归属偶发标错、`---` 分隔符持续缺失（P1 fallback 兜住）。

**结论与建议**：确定性机器层面（按侧门禁、侧别注入、探针协议、耗尽硬出口、防误判完成）已全部就位并有单测覆盖；对抗场景下 DeepSeek 的逐轮遵从度（维度累积、verdict 质量、分隔符）成为瓶颈。正常路径 e2e（verify-discussion-step2：Step1→Step2→Planner）通过。后续选项：(a) 接受现状（真实学生极少持续 stonewall）；(b) 简化 Step1 打戳协议（减少模型配合面）；(c) Step1 教练调用换 Gemini（`LLM_PROVIDER` 可配）。建议产品/技术共同拍板。

---

## 10. 阶段4 变更记录：part1/part2 结构化契约（2026-08-17）

> 背景：openai-compatible 通道（DeepSeek）对 text 内 `---` 分隔符的遵从度为 0/77（§9 实机观测），导致每轮走 `text_missing_delimiter` 修复路径，P2 被 `fallbackNextStep` 整体替换。同时录到 `fallbackNextStep` 两个 bug。本阶段把 P1/P2 从"字符串内分隔符契约"升级为"JSON 字段契约"。

### 10.1 part1/part2 字段（A1 方案）

- 响应 schema 新增可选 `part1`（反馈）/ `part2`（下一问）字段；prompt 的 STRUCTURE RULE、输出骨架、修复重试文案同步改为"优先 part1/part2，text 单字段 + --- 为兼容兜底"。
- `server.ts` 新增 `assembleCoachTextFromParts`：模型给出 part1/part2 时服务端组装 `text = part1 + "\n\n---\n\n" + part2`（part1 内残留的 `---` 剥除），下游 `splitTwoParts` 及全部守卫零改动；part2 缺失时留单段 text，由既有 P1 修复路径挂程序化 P2。主调用与修复重试两处 parse 后均接入。
- Gemini 通道行为不变（schema 中 text 仍 required，Gemini 照旧输出带 `---` 的 text，组装函数只在 part1/part2 存在时介入）。

### 10.2 fallbackNextStep 两个 bug 修复（P1/P2 无限追问与自相矛盾的根因）

- **陈旧读取**：原实现只读 `session.step1.coachEvaluation`（上一轮旧状态），当轮刚填的槽不可见——出现"P1 题型判断正确 + P2 先完成题型识别"同条消息自相矛盾。修复：新增第 4 参 `step1Data`，合并本轮 progressUpdate 后判定（两处调用点已更新）。
- **不识别 constraintsSkipped**：`constraints` 为空数组就固定追问限定词，学生对"没有极端表达"的有效回答永远关不掉该槽（实机录制连问 10+ 轮）。修复：`constraintsSkipped === true` 时跳过限定词追问，进入下一环节。
- **F2 模型否决解除**（阶段4 追加）：F2 硬出口原本要求 `dimsSufficient`，而该标志尊重模型的 `dimensionsSufficient=false` 否决——DeepSeek 按"材料不足"持续否决，使耗尽逃生永不可达。修复：F2 条件移除该模型否决（降级放行本就是服务端裁决），保留 slotsOk + 已探测≥2 底线。
- e2e 验证结果：part1/part2 契约遵从 **23/24 轮**（`text_missing_delimiter` 从 77/会话 降为 0）；对抗场景（e2e-step1-side）仍未收束——本轮模型连 coreIssue 都未回填（教练自己承认"核心议题待定"），slotsOk 合法拦截。剩余卡点是模型字段回填的逐场漂移（每轮缺不同的槽），非机制问题；正常路径 verify-discussion-step2 通过。

### 10.3 回归结论

verify-discussion-step2 在本轮代码上共跑 3 次：2 失败（均为 32 轮预算耗尽于 Step2 加深走查）+ 1 通过（t17 完成，planner passed / 2 bodies）。失败模式为 DeepSeek 走查节奏的运行间方差，与 part1/part2 改动无机制关联（通过的那次即跑在新代码上），判定非回归。该脚本对预算敏感，建议后续把失败率本身作为"净轮次"指标的观测信号。

---

## 11. 阶段5 变更记录：UI 全流程走查与打转熔断（2026-08-17）

> 方法：Playwright 驱动 headless Chromium 模拟配合型学生走真实 UI（驱动脚本 `/tmp/ui-e2e/ui-student.mjs`，存档 `docs/recorded-sessions/ui-full-journey-*.txt`），共 6 轮。只记录问题、修复后再验证。

### 11.1 修复项（代码）

1. **打转熔断（Step3 duplicate/off_target 死循环）**：`detectStall` 原只统计 landed 分钟，对被 rejected/held 的打转完全失明。扩展为：无待确认落槽时统计自最近一次确认以来 landingLog 中连续的 rejected/held 轮次。新增 `skipSlot`（confirmed + `skippedTag` 占位分钟：游标推进/完成判定/看板投影/reopen 回补全部复用现有机制，看板显示「暂略，可点『修改』补充」）；服务端在 stall 状态下识别学生「跳过/略过」等明确说法并确定性执行；stall 提示在 hard 级（≥6 轮）追加让教练告知「跳过」出口。验收：`verify-secretary.mts` 新增 9 用例，全部 19/19 通过。
2. **body 完成不推进（Step3）**：body-1 完成后 `activeSubpointId` 不自动切换，学生继续作答全部打到已完成 body 上空转（教练原地重问 30+ 轮）。修复（`Step3Drafting.tsx`）：同一 body「未完成→完成」跃迁时自动推进到下一未完成 body；用户手动点 tab 回看不触发。
3. **F2 补充**（阶段4 基础上）：移除模型 `dimensionsSufficient=false` 否决对耗尽硬出口的压制（降级放行是服务端裁决）。

### 11.2 走查轮次摘要

| 轮次 | 结果 | 发现 |
|---|---|---|
| 1 | 卡 Step1 | 驱动失步（加载气泡误判）；产品：限定词无限追问（→§10.2 已修） |
| 2 | 卡 Step1 | 驱动脚本 step 参数为字符串 → 守卫从未运行（已修脚本）；F1/F2 观测前提修正 |
| 3-5 | Step1/2 过，Step3 打转 | duplicate 死循环（→11.1.1 修复）；body 不推进（→11.1.2 修复）；驱动语料答非所问 |
| 6 | **Step1→2→2.5→3 全程走通并进入 Step4** | Step1 经 F2 耗尽出口收束；Step2 提案 9 次采纳；Step3 两 body 共 14 次确认写板、body 自动推进生效；84 动作完成 |

### 11.3 遗留观察（未修，供产品决策）

- **教练在循环压力下会给出整句候选表述**（"你愿意用类似这样的话吗？比如'……'"）——违反反代写红线（prompt 有禁令但无确定性拦截）。出现于学生连续答非所问时。如需拦截，可加确定性检测（P2 含完整候选句 + "你愿意用"句式 → 重写），代价是可能误杀正常举例。
- UI 驱动在 Step3→Step4 切换后找不到教练输入框（Step4 输入框占位符不同）——驱动限制，非产品问题；Step4 内部流程未覆盖。
- Step2 加深走查节奏存在模型方差（verify-discussion-step2 约 50% 概率超 32 轮预算），可作为"净轮次"指标的观测信号。
