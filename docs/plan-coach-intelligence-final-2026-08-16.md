# 方案（终版整合）：Coach 智慧恢复 + Step3 管线修复 + Planner 结构对话

> 日期：2026-08-16 | 状态：仅方案（未改代码）| 基线：`v0.5.1-restructured`
> 本稿为**唯一现行方案**，取代此前三份：`plan-coach-pro-planner-heuristic.md`（v1）、`plan-coach-pro-planner-heuristic-v2.md`、`plan-coach-intelligence-merged-2026-08-16.md`（Kimi 合并稿）。

---

## 0. 整合说明（来源与修正）

**三方共识（全部保留）**：
- 优先级：先修 Step3 落槽管线的**功能性缺陷**（产品四条反馈根因），再谈 coach"显得专业"（结构话语权）。
- 架构底线：骨架冻结后只读；LLM 出判断、代码管状态；不加硬门禁、控制轮次；复用现有机制（提案通道 / 双轨透镜 / landingLog·replayLanding）。
- 反代写红线：教练不写句子、不加事实；任何语言加工必须有确定性校验兜底。

**终版对 Kimi 合并稿的 6 处修正**：

| # | 修正点 | 理由 |
|---|--------|------|
| 1 | **thin 门控调和 anti-loop**（Kimi 3.2：thin 一律不 landed） | 若 thin 永远不落槽，学生给不出更细内容时会卡死（detectStall 触发），与"至多 1 次追问"冲突。调和：**thin → 第一轮不 landed + 1 次追问；下一轮仍薄 → landed（带「偏薄待补」标记 + activeSlot 推进）**。既质量驱动（不马上落薄草稿）又不阻塞流程。 |
| 2 | **意图分类 = 正则快路径 + LLM 解析器**（Kimi 3.4：LLM 判 6 类、正则兜底） | 修正表述：意图字段**挂在现有那轮 LLM 调用的 responseSchema 上**（step3Assessment 旁加字段，边际成本为零，非新增调用）。正则快路径的真正价值是两层：**①高置信 确认/拒绝 短路整个 LLM 轮次（零调用，与 P0-5 同源）；②meta 用确定性正则保护（零误判，防最重失败模式）**——LLM 只解析正则判不定的模糊情形（content vs question vs correction）。 |
| 3 | **defer/乱序落槽降级为 P0+ 可选增强**（Kimi 3.4 建议） | "暂挂该槽稍后回填"需秘书支持乱序落槽，直接改动顺序 `activeSlotIndex` 模型，风险高。**P0 核心用 rephrase + backfill（两者均符合顺序落槽）**；乱序作为后续可选增强单独立项。 |
| 4 | **明确 `rawText` 唯一真相源地位**（Kimi 3.1 隐含） | `displayText`（整理稿）只是**校验后的投影**，仅用于看板显示；`rawText`（学生原话）进 `landingLog`/`replayLanding`。防未来误删原话或把整理稿当学生原话。 |
| 5 | **补轮次预算表**（Kimi 只有文字描述） | 落一张"加-减-净"表（§7），把"净轮次不增"做成可验证的硬约束。 |
| 6 | **P0-6 审计打通显式化**（Kimi 隐含在 §7） | `landingLog` 每条追加 verdict/source 是评估闭环与回归断言的输入，必须显式列为 P0 步骤。 |

**一处补充（对 Kimi 的 P2 排序的确认）**：采纳 Kimi 的 P0→P1（透明）→P2（Planner 问答）→P3 顺序。用户原诉求"Planner 阶段启发式问答"仍是**头牌功能**，只是安排在 P0 稳定 + 轮次对冲之后，避免在管线还生硬时加结构对话放大流程感。

---

## 1. 诊断（合并定稿）

### 1.1 A 类：Step3 落槽管线功能缺陷（产品四条反馈根因，必修）

根因一句话：**秘书架构把"学生原话逐字落槽"当成真相源原则，顺手把 LLM 在管线入口的三个判断（意图、质量、归属）全部短路了。**

| 产品反馈 | 机制（代码定位） | 本质 |
|---|---|---|
| 不再润色，直接贴进去 | `server.ts:4303` `appendMinute(sp,"student",msg)` 逐字存原文；`secretary.ts` 原样上板 | 为防"LLM 代写后走形式确认"，把整理环节整个删了——从"不许代写语义"过度矫正成"不许任何语言加工" |
| 确认时机变了、生硬推流程 | `server.ts:4269-4304`：正则三分类，**任何实质发言立即 landed**；lens 判 thin/off_target 只产 hint **不拦落槽** | 确认触发从"质量够了"退化成"说话了就算"；文本说"还偏薄"看板却已挂草稿 |
| 前后句语意拼接 | 整条消息进 firstEmpty 一个槽；v0.2 批量协议在新架构无对应通道 | 缺"一条消息覆盖多 beat"的拆分通道 |
| 重复追问 / 记忆错挂 | `我前面已经说过了啊` 被正则判为实质 → **抱怨本身被当内容落槽**；无历史回填通道 | 意图分类只有三类，缺 meta 发言处理与 backfill 动作 |

### 1.2 B 类：coach 结构判断的表现空间缺失（成立，次之）

- Planner 静默黑盒，学生看不见"为什么这样分段/哪点详写/让步放哪"；
- Step3 教练被禁谈结构（`server.ts:8303/8461`），沦为槽位播音员；
- 判断透镜只做内部审计不说给学生；Step3 开讲只有"我们开始构建这个主体段。"

### 1.3 关系

A 类决定"教练做没做对"，B 类决定"教练显得专不专业"。**先做对，再显得专业**——顺序反了会出现"结构讲得头头是道、学生的话照样逐字上板"的割裂体验。

---

## 2. 设计原则（终版）

1. **骨架冻结后只读**：任何环节不得改已冻结结构——消灭死锁的底线。
2. **LLM 出判断，代码管状态**：LLM 恢复"意图分类 / 质量裁决 / 归属判断 / 结构建议"四类判断权；状态写入（落槽、确认、骨架）仍全走确定性代码并校验。
3. **不加硬门禁、控制轮次**：新增对话 ≤1–3 轮、有默认建议可跳过；门禁只管状态不管对话自然度；**净轮次不增**（§7 硬约束）。
4. **复用现有机制**：提案通道（proposal.ts）、双轨透镜（lens.ts + step3Assessment）、landingLog/replayLanding 只扩展不推翻。
5. **反代写红线**：教练不写句子、不加事实；整理/润色只做语言加工，确定性校验兜底，回退安全（显示原文）。
6. **rawText 是唯一真相源**：displayText 是校验后投影，仅看板显示；审计/重放一律用 rawText。

---

## 3. P0：Step3 管线修复（本轮核心，直接对应产品四条反馈）

按依赖顺序 P0-1 → … → P0-6（P0-1 整理层与 P0-2 门控共用一条消息流，可合并实现）。

### P0-1 恢复整理层 + 防代写校验（治"不润色直贴"）

- minute 双字段：`rawText`（学生原话，**唯一真相源**，进 landingLog/重放）+ `displayText`（LLM 整理稿，仅看板显示）。
- LLM 在 `step3Assessment` 附带 `polishedText`（**可选**：不润色则空 → 看板显示原文），职责**仅限语言加工**：去口水词、理顺语序、补全省略主语；禁止新增论点/事实/语义。
- 服务端确定性校验，不达标回退原文：
  - 实体/关键词覆盖：polished 中名词性实体 ⊆ rawText 实体 ∪ 槽位 label 词汇（防加料）；
  - 相似度下限：复用 `secretary.ts` LCS similarity，`similarity(polished, raw) ≥ 0.45`（下限防代写，无上限——整理本来该变美）；
  - 长度比：`polished.length ≤ raw.length × 2`。
- 落点：`secretary.ts` appendMinute 签名扩展 + `renderBoard` 显示逻辑 + `server.ts:4303` 接入校验。
- **polishedText 必须存进 minute 并固化**（与 rawText 并存，落地即存储）：`replayLanding` 重放时**只复验已存字段，绝不重新调 LLM 生成**——重放必须确定性，否则审计失真、评估闭环失效。
- **阈值先松后紧**：误杀合理润色的安全回退是"显示原文"，用回归集调参。

### P0-2 质量门控接回落槽（治"确认时机退化/生硬"）——含 anti-loop 调和

- `step3Assessment.verdict`（双轨：LLM 判 → 透镜 `evaluateMinute` 兜底）参与落槽决策：
  - `ok` → 正常 landed；
  - `off_target` / `duplicate` / `off_topic` → **不 landed**（保持 `recorded` + `rejectReason`），教练一句引导回当前槽/换角度；
  - `thin` → **第一轮不 landed** + 透镜 hint 给教练 1 次针对性追问；**下一轮仍薄 → landed（带「偏薄待补」标记 + activeSlot 推进）**。守 anti-loop，防卡死。
- 回退链：LLM 未输出 assessment 或 slotKey 不匹配 → 确定性透镜 verdict → 再回退现状（落槽）——**拿不准放行，不误杀**。
- 效果：文本（"这环还薄，再补一句"）与看板（无草稿/带标记草稿）重新一致；确认时机恢复"质量驱动"。

### P0-3 意图分类扩容 + 元评论 + 历史回填（治"重复追问/失忆"）

- **分层**：意图字段挂在**现有那轮 LLM 调用的 responseSchema**（step3Assessment 旁加字段，边际成本为零，**不是新增调用**）。
- **正则快路径**（零 LLM、零误判）：扩展现有 `isAff/isRej` 正则，新增 meta 正则。命中**高置信 确认/拒绝 → 短路整个 LLM 轮次（零调用，与 P0-5 同源）**；命中 meta → **不落槽**（`recorded`，slotKey 空），同样**直接短路本轮 LLM**（无内容可落，无须再调）。
- **meta 正则召回率风险（重点调参）**：中文变体极多（"我不是说了吗""这个刚才聊过了""问过了呀"），漏判的失败模式最重（抱怨被当内容落槽 = 反馈④本身）。原则：**先宽后紧 + 宁判不定交 LLM，不要正则过度自信**；把 meta 语料变体覆盖率作为 §8 调参重点，并在回归集固定一批变体用例。
- **LLM 意图解析器只处理模糊情形**：扩到 6 类 `content / affirm / reject / meta / question / correction`；正则判不定的才交 LLM（挂现有调用）；正则已覆盖的绝不再走 LLM。
- **backfill 动作**：学生说"我前面已经说过了啊" → 教练引用该历史 minute 回填当前槽（秘书校验：minute 存在、未 confirmed 到其他槽、过 dup 预检）→ landed 等确认；或教练明确指出"你说过 X，但缺 Y 这环"——**而不是原样重问**。
- **stall guard 升级**：同槽 3 次未确认 → 强制 coach 下轮选择 `rephrase` 或 `backfill`（**暂不做 defer/乱序**，见 §0 修正 3）。

### P0-4 拆分通道（治"语意拼接"，轮次削减主来源）

- LLM 在 assessment 声明覆盖 beat 分段（`beats: string[]`，每段对连续空槽）。
- 服务端复用 v0.2 批量协议的确定性校验：**从 firstEmpty 起的连续空前缀**、不跨 pointBlock、≤3 条；通过 → 拆多条 minute 分别 landed（各过 dup 预检 + 整理层）；不通过 → 整条落单槽（现状）。
- 学生侧：看板多条草稿各自「确认/改」，一次可全过——v0.2 批量确认以确定性形式回归。

### P0-5 确认走 decision 通道（零 LLM 调用）

- 看板「确认写板」按钮（现 `Step3Drafting.tsx:112-118` 发送纯「对」走完整 LLM 轮次）改走 Step2 既有 decision 通道（proposal.ts 范式）：确定性 commit + 本地推进，**零 LLM 调用**。
- 学生**打字**说"对"的文本确认维持现状，走 P0-3 意图分类。

### P0-6 审计打通（评估闭环输入）

- `landingLog`（P1 已有）每条追加 `verdict`（透镜）与 `source`（affirm/reject/meta/content/batch/single/polished 回退），供 §8 量化统计与回归断言；`replayLanding` 全绿为 P0 门禁。

### P0 验收（逐条对产品反馈）

- [ ] 口语化回答上板前经整理层润色；校验回退时显示原文（治①）
- [ ] 偏薄/跑题时看板不出草稿（thin 至多 1 次追问后带标记落槽），文本与看板一致（治②）
- [ ] 一条消息覆盖两 beat 拆两条草稿落连续槽；确认按钮零 LLM（治③ + 轮次）
- [ ] "我前面已经说过了啊"不落槽；coach 回填历史或指出缺口（治④）
- [ ] 三题型 replay + `replayLanding` 全绿；落槽误判数=0

### P0 实施备注（实现时必读）

1. **polishedText 必须存进 minute 并固化**（P0-1）：落槽时随 `rawText` 一并存储，`replayLanding` 只复验已存字段，**重放绝不重新调 LLM 生成**——重放必须确定性，否则审计失真、评估闭环失效。
2. **meta 正则先宽后紧**（P0-3）：先用宽匹配抓召回（宁可误判 meta → 走"指回/追问"路径，也比把抱怨落槽强），再用回归集收窄误伤；调参顺序 = **先保证"落槽误判数=0"，再降误伤率**。
3. **P0-1 与 P0-2 共用一条消息流**：整理（polishedText）与门控（verdict）在同一轮 LLM 调用产出、同一秘书函数消费，避免两次解析。
4. **验证闭环先行**：任何 P0 子项合入前，先有 §8 基线指标（总轮次 / stall / 误判数 / 看板-文本矛盾数），否则无法判断是否回退。

---

## 4. P1：结构透明（纯文本层，低风险，可与 P0 并行）

1. **后置方案确认（post-planner recap）**：Planner 生成后、进 Step3 前，`renderPlanRecap(skeleton)` 纯函数投影大白话方案汇报（"这一篇写两段：第一段展开优势…第二段让步…"），带「照此开始」确认，不新增结构字段。
2. **逐段透明（Step3 kickoff recap）**：每个 body 开讲第一句点明"本段论证什么、为何在这"，替换"我们开始构建这个主体段。"（改 kickoff ContextSummary + 一条 prompt 规则）。

## 5. P2：Planner 前置结构对话（启发式问答核心）

保留原 §3.1 全部设计：新增 `layout_strategy` 提案（采纳/拒绝/自定义）、学生选择写入 `plannerPayload.layoutPreference` **软参数**、Planner prompt 加"偏好优先，但与材料硬约束冲突时以材料为准（rationale 注明）"。

调整：**时机在 P0 稳定之后**；轮次由 P0-4/P0-5 省下的确认轮次对冲，**净轮次不增**（§7 度量）。

## 6. P3：判断进对话 + Prompt 减负

1. **判断进对话**：verdict/reason 转成教练 1 句专业点评；偏薄追问带论证逻辑教学；允许教练给专家推荐。P0 之后，verdict 已落地为行为，对话只补"为什么"。
2. **Prompt 减负**（跨端改动，低优先级）：
   - CTA 结构化：`progressUpdate.cta = { action, target }` 替代"进入第三步"字面解析（现 `server.ts` 多处正则），斩断文案硬耦合；
   - 能确定性校验的规则从 prompt 下沉到 guard（P0 完成后，落槽相关 CRITICAL 条款大部分可删）；
   - 用 §8 回归集做删规则安全网。

---

## 7. 轮次预算表（净不增，硬约束）

| 位置 | 现状 | 终版变化 | 净效果 |
|------|------|---------|--------|
| Step3 逐槽"答→确认" | 每槽 2 拍 | P0-4 批量落槽 + P0-5 零 LLM 确认 → 覆盖多槽时 1 拍 | **-30~50%（多槽轮）** |
| Step3 重复追问 | 元评论被当内容、教练再问 | P0-3 meta 识别 + backfill → 指回/推进 | **-2~3 轮/次** |
| Step3 薄回答 | thin 已 landed 且与文本矛盾 | P0-2 门控（至多 1 次追问后放行） | 0（anti-loop 约束） |
| Planner 前置结构对话 | 0（静默） | P2 +1~3 轮 | **+1~3** |
| 后置确认 + 逐段透明 | 0 | P1 +0~1 轮 | **+0~1** |
| **净** | | | **≈0 或为负** |

红线：回归集内总轮次 ≤ 现状基线；若 P2 净增超过 Step3 省回量，先压 P2 问题数，不砍 Step3 稳定性。

---

## 8. 评估闭环（P0 之前先建）

- **回归集**（基于 `scripts/replay-*` 与 `docs/recorded-sessions/` 真实卡死语料）：agree-discuss / discussion / problem-solution 三题型各一条完整旅程 + 两个已知卡死场景 + P0 四场景（元评论 / 薄回答 / 多句一答 / 批量确认）。
- **量化指标**：Step3 总轮次、同槽连续追问次数、确认撤销率、stall 触发次数、单会话 LLM 调用数、**落槽误判数（meta/非内容被 landed，应=0）**、**看板-文本矛盾数（verdict≠ok 但看板显示 draft，应=0）**。
- **每期 PR 门禁**：replay 全绿 + 指标不比基线差（净轮次不增、stall 不增、误判=0）。

---

## 9. 总排期与风险

| 阶段 | 内容 | 风险 | 前置 |
|------|------|------|------|
| 评估闭环 | replay 回归集 + 指标基线 | 低 | 无，先做 |
| P0 | Step3 管线修复（P0-1…P0-6） | 中（动落槽入口，全有确定性校验 + replay 兜底） | 评估闭环 |
| P1 | 结构透明（recap × 2） | 极低 | 无，可与 P0 并行 |
| P2 | Planner 前置结构对话 | 中 | P0 稳定后 |
| P3 | 判断进对话 + prompt 减负 | 低 | P0 |

**风险边界**：
- 整理层相似度校验可能误杀合理润色 → 阈值先松后紧，回退安全（显示原文），回归集调参；
- verdict 门控可能因 LLM 误判 thin 导致该落不落 → 双轨回退链（LLM → 透镜 → 放行），拿不准放行；
- thin 门控过严导致卡死 → 已用"至多 1 次追问后落槽"调和 + stall guard 兜底；
- 结构对话流程感反噬 → ≤3 轮、可跳过、非硬门禁、净轮次不增；
- 乱序落槽（defer）风险 → 已降级为 P0+ 可选增强，独立评估。

---

## 10. 验收清单

- [ ] §8 回归集与指标基线已建，跑通
- [ ] P0-1 整理层：口语回答上板前经润色；校验回退显示原文；rawText 始终为真相源
- [ ] P0-2 门控：off_target/duplicate 不 landed；thin 至多 1 次追问后带标记落槽；文本与看板一致
- [ ] P0-3 意图：正则快路径 + LLM 解析器；meta 不落槽；"已说过"→ backfill 或指出缺口；stall 升级 rephrase/backfill
- [ ] P0-4 拆分：一条覆盖多槽 → 批量落槽 + 批量确认；不通过校验回退单槽
- [ ] P0-5 确认按钮零 LLM 调用
- [ ] P0-6 landingLog 含 verdict/source；`replayLanding` 全绿
- [ ] P1 进 Step3 前有方案汇报；每 body 开讲点题
- [ ] P2 Planner 启发式问答 ≤3 轮、可采纳/自定义/跳过；`layoutPreference` 软参数，冲突以材料为准
- [ ] P3 判断进对话只补"为什么"；CTA 结构化（后续）；prompt 规则按回归集删减
- [ ] §7 总轮次 ≤ 基线；误判数=0；卡死/撤销/thin 追问率不恶化；骨架冻结后 Step3 结构零改动
- [ ] 三题型 E2E + tsc + 全量 replay 全绿

---

## 11. 实施调整记录（2026-08-16，实施后补记）

实施与验证过程中对本方案的偏离/补充，均已验证（tsc 0；verify-secretary 10/10、verify-replay 16/16、verify-guards 20/20、verify-lens 14/14、verify-step3-gate 35/35）：

1. **P0-3 backfill 收缩（偏离，已确认）**：不实现"服务端把 held/rejected 旧 minute 自动落槽"——新门控下这些 minute 本就因质量不足未落槽，自动重落会推翻门控结论（自相矛盾）。改由 `buildMetaHint` 在文本层指回：当前槽已有 landed 草稿时直接引导确认（覆盖"失忆"最高频形态），否则引用最近学生原话请确认或指出缺口。
2. **P1「照此开始」确认按钮未做（偏离，已确认）**：方案汇报改为教练在首个 body 开讲时口述（`renderPlanRecap` 注入上下文 + prompt 规则），少一步 UI 门禁，摩擦更低。
3. **P0-3 LLM 意图解析补接通（验证后补做）**：初版只在 schema/prompt 声明了 `step3Assessment.intent` 但服务端未消费（死字段）。已补上：正则快路径之后，`intent=meta` 走与正则 meta 相同的不落槽+指回路径；`intent=question` 不落槽并提示教练先答学生问题再回当前槽。intent 是消息级判断，不要求 slotKey 匹配；affirm/reject 仍只信确定性正则/按钮，LLM intent 不触发写板。
4. **stall guard 升级补做（验证后补做）**：初版 `detectStall` 仍只报警。已在触发时把"禁止原样重问、必须 rephrase 或引用原话请确认"的强制约束写入 `sp.lastGateHint`，经 `formatStep3SlotCursorForPrompt` 注入下一轮教练上下文。
5. **批量落槽游标修正（验证后补做）**：`landBatchToSlots` 的 `activeSlotIndex` 曾误写为 `blockIndex`，已改为槽位下标（flatIndex），与 `landMinuteToSlot` 语义一致；verify-step3-gate 新增 2 条回归断言（批量落第二 block 场景）。
6. **仍待实施**：P2 `layout_strategy` 提案微阶段（UI 采纳/拒绝 + Step2→Planner 时序）、P3 prompt 减负（CTA 结构化）、评估闭环指标基线（总轮次/stall/误判数/矛盾数——§7"净轮次不增"目前无度量工具）、`/api/step3/decision` 与 P1/P2/P3 的真实 LLM 交互验收。
