# v0.5.5 实施记录：Step2/Step3 实测 9 问题修复

日期：2026-08-19
基线：v0.5.4（4042c71）
来源：v0.5.4 实测评估（用户手工测试 9 条问题 + `docs/recorded-sessions/ui-full-journey-2026081808*.txt` 佐证）

## 问题 → 根因 → 修复 对照

### Step3

**1. 点右侧「修改」整条文本被清空**
- 根因：`reopenSlot` 把 minute 降级 `recorded` + 清 `slotKey`，看板投影只认 confirmed/landed。
- 修复：`src/server/step3/secretary.ts` `reopenSlot` 改为 `confirmed → landed` 保留 slotKey/原文，打 `reopenedTag`；`landMinuteToSlot` 新增 supersede 逻辑（新内容落槽时回退同槽 reopen 旧稿，必须在 dup 预检之后、只覆盖 reopen 稿）；`replayFromAuditLog` 的 reopened 事件映射同步；`src/types.ts` `Step3Minute` 加 `reopenedTag?`。前端零改动（board 投影天然认 landed→待确认）。
- 回归：`scripts/verify-p2-reopen.mts`（更新）、`verify-step3-reuse-reopen.mts`。

**2. 任何回复都同步右侧，不判有效性（meta 反问句误入看板）**
- 根因：`META_PATTERNS` 全是 `^我…` 锚定形式，「这前面不是已经解释了…」类反问漏网后被当内容落槽。
- 修复：抽出 `src/server/step3/meta.ts`（单一真相源），新增 3 个带言说动词白名单的非锚定/反问模式（防误伤纯内容句）；`server.ts` 改 import。meta 命中走 #9 的 reuse 通道，不落当前消息。

**3/5. 教练不评估语义、符合的原文写入、不符的直接驳回无调整空间**
- 修复（P1 三项）：
  - `step3Assessment` 在 Step3 下 schema 必填（`required: ["text","step3Assessment"]`），slotKey 不匹配时模糊兜底到 firstEmpty 槽而非丢弃（记日志）。
  - `polishedText` 由 MAY 改 SHOULD（verdict=ok 时），`validatePolishedText` 安全网保留。
  - `lens.ts:306` hint 优先级反转 `llmHint || lens.hint`；hold/reject 用 `safeOverridePart1` 模式同轮重写 part1，反馈与判定不再脱节；prompt 要求 nextHint 引用学生原话给具体方向。

**4. 每条 slot 从头问、不带入前序信息**
- 修复（P2 两项）：
  - **reuseQuote 历史回填通道**：`step3Assessment` 加可选 `reuseQuote`；`meta.ts` `validateReuseQuote` 跨 body 最近 30 条学生纪要子串校验，通过则把引用文本（而非当前消息）落槽走正常确认流程；meta+无 pending 为默认路径；伪造引用拒绝落槽。`src/types.ts` 新增 `Step3Assessment` 接口。
  - **上下文扩容**：slot cursor 注入当前 body 全部已确认槽文本（截 120 字）；`formatStep3SubpointsBrief` 其他 body 附内容摘要（≤300 字）替代纯计数；新增 `formatStep3RecentStudentMinutes`（30 条/≤800 字）注入 prompt 供逐字引用。

### Step2

**1. 每展开一条论点就触发详略提案**
- 根因：`sideReadyForSettle` 只查"现存点都展开"，增量挂载下第 1 条展开完即触发 Priority 3 信息量兜底。
- 修复：`proposal.ts` 新增 `sideExploreComplete()`（walk 完成 + 无未落槽 pending 维度）；`armNextProposal` 加探索结束门——Priority 1（retentionSuggestion）/Priority 2（教练方案）不受限，Priority 3 兜底仅在 exhausted 或探索完成后武装。接线：`server.ts:396/855`、`ask-contract.ts:402`。

**2. 确认冗余（自动填入右侧再点采纳）**
- 修复（用户选定方案）：单点侧无真实方案来源时确定性自动确认（confirmed=true、detail），不弹提案；多点侧才弹。文案删除"采纳后将写入材料池"（内容本就实时上板），采纳语义 = 确认表述 + 锁定详略。

**3. 确认消息无有效信息（兜底文案）**
- 修复：`buildAskFromProposal` side_settle 分支逐条渲染 `claim：elaboration` 全文；删除"（按各条信息量生成的兜底方案）"硬编码 rationale；新增"请确认以下论点表述及详略分工"。

**4. 教练不带入前一步信息**
- 核查结论：Step1 摘要（题型/维度/学生原话）每轮已注入 Step2 prompt（`server.ts:8686-8717`），客户端 `session.step1.coachEvaluation` 持久化/回传链路完好（完成轮合并有防清空保护），无断点，未改码。

## 其他改动
- `server.ts`：`PORT` 支持 `process.env.PORT` 覆盖（默认仍 3000），便于并行起测试实例。

## 验证
- `npx tsc --noEmit` 零错误。
- 17 个 `scripts/verify-*.mts` 全绿（含新增 `verify-step2-settle-gate.mts` 26 例、`verify-step3-reuse-reopen.mts` 29 例）。
- 实况全流程：`scripts/replay-full-journey.mjs`（PROBE_BASE_URL 指向 3100 端口实例），存档见 `docs/recorded-sessions/recorded-session-<ts>.txt`。
- 既有基线失败（与本次无关，未修）：`replay-retention-planner-checklist.mjs`（断言已删除的旧日志串）、`verify-discussion-step2.mjs`。

## 遗留风险 / 后续
1. reopen 后的「铅笔预填原文」未接入 CoachChat pendingDrafts 通道（可经看板「确认写板」或重答覆盖闭环，预填为手动）。
2. meta 新模式带动词白名单，更口语化的 meta 依赖 LLM intent=meta 兜底。
3. step3Assessment schema 必填的模型遵从度需实机观察；provider 忽略 required 时模糊兜底 + 透镜兜底仍生效。
4. reuseQuote 仅在 meta 分支消费；非 meta 场景的 SLOT REUSE RULE 仍无执行通道。
5. Step2 探索结束门依赖 dimensionDispositions 同步；维度事实放弃但未标记时，多点侧兜底提案会等 exhausted/教练方案。
