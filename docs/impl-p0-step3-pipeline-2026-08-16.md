# 实施进度：P0 Step3 管线修复（质量门控 + 整理层 + meta 识别 + 审计）

> 日期：2026-08-16 | 分支：当前工作区 | 依据：`docs/plan-coach-intelligence-final-2026-08-16.md`
> 状态：**P0-1 / P0-2 / P0-3(meta 部分) / P0-4 / P0-5 / P0-6 已实现并测试通过**；P0-3(backfill 动作，见 §3 决策说明) / P1 / P2 / P3 待实施。

---

## 1. 本轮改动（代码定位）

### 1.1 `src/types.ts`
- `Step3Minute` 新增 `displayText?`（校验后整理稿，仅看板显示）+ `thinTag?`（偏薄待补标记）；`text` 保持=学生原话（唯一真相源）。
- `Step3LandingAuditEntry`：`event` 增 `'held'`（质量门控暂不落槽）；新增 `verdict?`、`source?`（供评估闭环统计）。

### 1.2 `src/server/step3/secretary.ts`
- `appendMinute`：支持 `displayText` / `thinTag`。
- `appendAudit`：导出；支持 `verdict` / `source`；落槽/确认审计带 `source`（content/affirm）。
- `validatePolishedText(raw, polished, slotLabel?)`：整理稿防代写/加料校验——相似度下限（2-gram Dice ≥0.45，LCS 兜底）、长度上限（≤2×+8）、新颖内容控制（2-字 bigram 覆盖率 ≥0.55，防新增事实）；不达标返回 null（看板回退原文）。
- `firstEmptySlotKey` / `countHeldForSlot`：门控游标与"thin 至多 1 次追问"计数。
- `renderBoard`：显示 `displayText || text`；thinTag 时看板追加「（偏薄待补）」。
- `replayFromAuditLog`：支持 `held` 事件（重放为 recorded、slotKey 空、rejectReason 不比较）。

### 1.3 `src/server/step3/lens.ts`
- 新增 `resolveLandingGate({ text, slot, confirmed, chainType, llmVerdict, llmReason, llmHint })`：纯函数质量门控——`duplicate→reject`；`off_target/off_topic/thin→hold`；`ok→land`；LLM verdict 优先、确定性透镜兜底；无槽放行。

### 1.4 `server.ts`
- `enforceStep3SecretaryPath` 内容路径重写为**质量门控**：
  1. meta 正则（`META_PATTERNS` / `isMetaComment`）→ 不落槽（`recorded` + 审计 held + `buildMetaHint` 指回）；
  2. `resolveLandingGate` 判定 → `reject`（duplicate，不 landed）/ `hold`（off_target/off_topic/thin 首轮，不 landed）/ `land`（ok，或 thin 追问后仍薄 → 带 thinTag）；
  3. thin 首轮 held → 教练 1 次追问；再薄 → 落槽带「偏薄待补」标记（anti-loop）；
  4. `displayText` 应用校验后的整理稿。
- 门控/拒绝/meta 提示持久化到 `sp.lastGateHint`，并注入 `formatStep3SlotCursorForPrompt`（下一轮教练上下文真正可用，修掉"hint 死代码"）。
- responseSchema 的 `step3Assessment` 增 `polishedText?`（整理稿，仅语言加工、禁加料）与 `intent?`（模糊情形）；Step3 prompt 指引同步更新。
- `buildMetaHint` 强化：当前槽已有 landed 草稿时，提示教练"引导学生点【确认】写入，而不是重新问"（"失忆"最常见形态的直接解法）。

### 1.5 P0-4 批量落槽（一条消息覆盖多槽）
- `secretary.ts` 新增 `landBatchToSlots`：从 firstEmpty 起取连续空前缀、不跨 pointBlock、≤3 条，逐段 dup 预检，任一段失败整批不落（回退单槽）；source=batch 审计。
- `server.ts`：`parseBatchBeats` 校验 LLM `beats`（必须是 msg 子串、按序不重叠、覆盖 ≥60%）；gate=ok 且 beats 合法 → 批量落槽，否则回退单槽。
- 确认改批量：isAff 分支确认**全部 landed**（一次全过）；isRej 分支回退全部 landed。
- responseSchema 增 `beats?`；Step3 prompt 指引说明。

### 1.6 P0-5 确认走 decision 通道（按钮零 LLM）
- `server.ts` 新增 `POST /api/step3/decision`：对 subpoint 的全部 landed 执行 `commitPendingMinute`（confirm）或回退 recorded（reject），返回权威 subpoint + 看板 + isComplete。确定性、零 LLM。
- `Step3Drafting.tsx`：`confirmLanded` 改为调用该端点并合并返回的 subpoint 到 session.step3.subpoints（失败回退原聊天路径"对"）；秘书看板显示 `displayText` 与「偏薄待补」标记。

## 2. 测试

- 新增 `scripts/verify-step3-gate.mts`（**33 断言**，无 LLM）：
  1. `resolveLandingGate`：ok→land / thin→hold / off_target→hold / duplicate→reject / LLM 覆写；
  2. `validatePolishedText`：轻整理通过 / 加料拒绝 / 超长拒绝 / 低相似度拒绝 / 空回退；
  3. thin 一轮追问后放行（held 计数 → thinTag 落槽 → 看板标记 → replay 一致）；
  4. meta 不落槽 + 审计 verdict/source + 重放一致；
  5. `landBatchToSlots`：2 段连续落槽 / 一次确认全过 / 审计 source=batch / 重放一致 / >3 段拒绝 / <2 段拒绝 / 无骨架拒绝 / 跨 block 拒绝 / 同 block 2 段成功。
- 回归全绿：`tsc --noEmit` 0；`verify-secretary` 10/10、`verify-replay` 16/16、`verify-guards` 20/20、`verify-lens` 14/14、`verify-step3-gate` 33/33。
- 已知非回归：`replay-retention-planner-checklist` C 段源码扫描断言（`No incomplete sibling body...`）在基线 `b0a2d28` 即已失效（旧机制删除后未更新断言）；`replay-new-cases` 需运行服务（仓库备注已排除）。

## 3. 对产品反馈的对应

| 反馈 | 本轮落点 |
|------|---------|
| ① 不润色直贴 | 整理层恢复（displayText 仅语言加工 + 确定性防加料校验，回退安全显示原文） |
| ② 确认时机退化/生硬 | 质量门控接回落槽（off_target/duplicate 不 landed；thin 至多 1 次追问后带标记落槽；文本与看板一致） |
| ④ 重复追问失忆 | meta 识别（"我前面已经说过了啊"不落槽）+ 指回提示（引用历史原话）+ 门控提示回灌教练 |
| ③ 语意拼接 | 批量落槽（P0-4：beats → 连续空槽一次落齐 + 一次确认）+ 审计/重放/评估闭环（verdict/source 入 landingLog） |

## 4. 待实施（按优先级）

1. **P0-3 backfill 动作（范围已收敛，见 §5）**：教练文本层已能"引用历史原话/指回待确认草稿"；服务端自动回填（把 held/rejected 的旧 minute 重新落槽）与质量门控冲突，**不建议自动执行**——由教练在文本中引用并请学生确认即可。
2. **P1 结构透明**：`renderPlanRecap(skeleton)` + kickoff 逐段点题。
3. **P2 Planner 前置结构对话**：`layout_strategy` 提案 + `layoutPreference` 软参数。
4. **P3 判断进对话 + prompt 减负**。
5. **评估闭环完善**：把 verify-step3-gate 扩展为指标基线（总轮次 / stall / 误判数 / 看板-文本矛盾数），并清理 `replay-retention-planner-checklist` 的过期源码扫描断言。
6. **P0-5 端到端验证**：`/api/step3/decision` 与前端合并路径需一次真实交互（服务 + LLM）验收确认按钮零 LLM 生效、看板即时更新。

## 5. P0-3 backfill 范围决策

终版方案建议"LLM 指出某条历史 minute → 秘书校验后 landed"。实现时发现：新门控下任何学生内容都走 ok/thin/off_target/duplicate 判定，`recorded`（held/rejected）状态的旧 minute 本就因质量不足未落槽，服务端自动重新落槽会**推翻门控结论**（自相矛盾）。因此 backfill 收敛为：
- meta 不落槽 + `buildMetaHint` 引用最近学生原话 + **若当前槽已有 landed 草稿则直接引导确认**（覆盖"失忆"最常见形态：教练重复问已确认/待确认的槽）；
- 不实现"服务端把 held/rejected 旧 minute 自动落槽"（与门控冲突，风险 > 收益）。
