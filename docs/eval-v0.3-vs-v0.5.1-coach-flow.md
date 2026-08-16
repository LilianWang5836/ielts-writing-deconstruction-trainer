# 评估：v0.5.1 vs v0.3 coach 对话流程差异 + 产品反馈核验

> 评估日期：2026-08-16 | 范围：`v0.3-single-slot-first`（2026-08-07）vs `v0.5.1-restructured`（2026-08-15）
> 方法：双版本 `server.ts` / prompt / 确定性逻辑逐项对比 + 记录会话（2026-08-12 与 2026-08-15 两代）行为对照
> 结论：**产品三条反馈全部属实**。三条反馈是同一个架构取舍的三个侧面——会议秘书（meeting secretary）重构用"确定性/稳定性"换掉了"教练的生成式引导"。

---

## 0. 两版 coach 对话架构总览

| 维度 | v0.3（2026-08-07） | v0.5.1（2026-08-15，restructure） |
|------|--------------------|------------------------------------|
| Step3 结构归属 | **LLM 生成**：`paragraphPlan` / `step3SlotEval` / `kickoffPendingDrafts` 由模型在对话中产出 | **服务器秘书确定性接管**：skeleton 冻结 + `minutes` 唯一真相源 + 看板投影；LLM **禁止**输出任何结构 |
| Step3 教练职责 | 组织 + 润色学生内容 → 给出"整理句" → 引导学生确认 → 服务器写板 | 只产对话文本：按 firstEmpty 槽提问 + 推【确认】按钮；**落槽内容=学生原话** |
| Step2 结构归属 | LLM 在 stance 阶段一次打包"立场+保留/舍弃+详略+body 划分"；summary 阶段向学生**呈现篇章布局并请确认** | Step 2.5 Planner 在 Step2 完成后**静默**决定 body 布局；Step2 对话只确认"材料池+立场" |
| 详略（retention）确认 | **条件触发**（仅同侧有未覆盖兄弟维度时）+ 对话式提问，且"不要把强制 KEEP/DROP 当主问" | **每侧强制一次** + 结构化 `retentionSuggestion` + 按钮「采纳/拒绝」（提案通道） |
| 立场确认 | 对话式"confirm or correct that package" | 按钮「采纳/拒绝」+ 门禁 |
| 门禁 | 软性、prompt 引导为主 | 硬门禁：`CHECKLIST FIRST` / `CHECKLIST BEFORE STANCE` / `NEW SLOT ONLY AFTER CONFIRM` / coach-agent 硬规则"explore 未完成禁止 stance" |

---

## 1. 反馈①：语言润色没了，变成"直接贴进去" —— ✅ 属实

**v0.3（有润色）：**
- Step3 kickoff 确认文案（`buildStep3KickoffConfirmText`，server.ts:2322）：
  > "根据你在第二步提供的材料，我先**整理并润色**成这些论证草稿（只改措辞、不增新事实；确认前不会写入右侧）"
- Step3 对话内确认（`buildContinuousConfirmAsk`，server.ts:3989）：
  > "我**整理了**「label」：{text}" / "我根据你刚说的**整理了**这几环：…"
- Step3 prompt（server.ts:9560）明文要求模型产出"整理句"：
  > `mode=confirm` + `pendingText=对学生原话的整理句；在 text 里给出整理句，然后引导学生点击【确认】按钮写入看板`
- Step2/3 通用规则："If user answer is already complete, you may refine wording (language polish)"；服务端有 `paraphraseKickoffDraftText`（对草稿做措辞规整）
- 即：**v0.3 的教练会把学生啰嗦/不完整的话"顺"成一版可写句子，展示给学生确认后再写板**。

**v0.5.1（直接贴）：**
- 秘书落槽：`appendMinute(sp, "student", msg)` —— 学生消息**原话**记入 minutes，`landMinuteToSlot` → `commitPendingMinute` 写板。看板内容 = 学生原话（设计文档明言"text: 原话，保真"）。
- prompt 明文禁止组织动作（server.ts:8411、8409 HUMAN TUTOR TONE RULE）：
  > "Do NOT restate the student's whole answer back verbatim"；"No meta-commentary about your own process（**我按你的逻辑整理 / 我根据你刚说的整理**…）"
- Step3 prompt（server.ts:8461）："STRUCTURE IS FULLY SERVER-OWNED… lands the **student's words** into slots… 不要浪费输出 token 生成服务器已确定性管理的结构"
- 实测（v0.5.1 记录会话 20260815044854）：教练反复出现机械模板——
  > "好的，这一步已经记下了。请点击右侧【确认】把它写入看板，然后我们继续下一步。"
- 即：**不再有"组织+润色+确认稿"环节，学生原文被直接贴上/落地**。

> 备注：v0.5.1 的 prompt 仍保留 `FILLED_OK → you may polish wording`（Step1/2 对话层），但 **Step3 看板落的是原话**，对话层的润色许可对看板内容已无实际作用。核心的"写板前润色"价值被移除。

---

## 2. 反馈②：确认策略的时机改了 —— ✅ 属实（两个层面）

### 2a. 篇章策略（body 划分/骨架）确认：从"对话内、完成后" → "对话外、不可见"
- **v0.3**：Step2 在对话中拥有并呈现篇章布局。stance 阶段"一次性打包立场+保留点+major/minor 角色"，summary 阶段 **"MUST explicitly present this layout to the student"**，并对每个 body 给出 写作难度 / 完整性 / 篇幅 评估，请学生最后确认。
- **v0.5.1**：Step2 prompt 明令 `NOT paragraph layout`（此变化来自 `edce77e`，v0.3 中不存在）：
  > "FORBIDDEN in Step2 (HARD): deciding Body Paragraph 1/2/3… telling the student the essay skeleton. That is **Step 2.5 Planner's job after isCompleted**."
  - 布局由 Planner 在学生不可见的环节静默生成，学生只被引导"点击左侧【立即跳转】进入第三步"。
- **影响**：学生再也看不到"我为什么这样分两段、哪点详写哪点略写"的整体策略确认——策略确认从对话流程里整个消失。

### 2b. 详略 / 立场确认：从"条件性、对话式" → "每侧强制、按钮化、前置"
- **v0.3**：详略只在"同侧出现未覆盖兄弟维度"时**条件触发**，且规则强调"不要把强制 KEEP/DROP 建议当主问、软默认只作「你定」兜底"；立场在 stance 阶段一次性对话式确认。
- **v0.5.1**：提案通道（`side_settle` / `stance`，来自 `ec3e318`）把确认改成：
  - 每侧详略各一次结构化方案 + 按钮「采纳/拒绝」（实测：Side A 一次、Side B 一次、立场一次，共 3 次按钮确认）
  - 硬门禁 `CHECKLIST FIRST`（每侧先走完 expand 再详略）、`CHECKLIST BEFORE STANCE`（立场必须在 checklist 完成后）、`NEW SLOT ONLY AFTER CONFIRM`
- **影响**：确认从"最后一次性打包确认"变成"流程中分段、前置、强制按钮点击"，时机更早、更碎、更机械。

---

## 3. 反馈③：整体感受很生硬地推流程 —— ✅ 属实

证据（代码 + 实录）：
1. **Step3 教练被降级为"对话文本生产者"**（server.ts:8461）：唯一职责 = 问 firstEmpty + 推确认按钮。不再能"顺势组织、润色、给出超出槽位的引导"。
2. **确定性兜底覆盖模型文本**（`buildStep2ContentAwareFallback`，server.ts:230 起）：用模板问句（"继续推进「XX」：请先回答这一步「分论点」…"）压过模型的自然追问，对话像"检查清单"而非"对话"。
3. **硬门禁把自然流程规则化**：`Explore-before-stance (HARD)`、`CHECKLIST BEFORE STANCE`、coach-agent.ts Step2 硬规则"explore 未完成前禁止进入 stance、禁止宣布已选立场"。
4. **实录对照**：
   - v0.5.1（20260815044854）：学生连续回"对"，教练机械重复"好的，这一步已经记下了。请点击右侧【确认】把它写入看板"；Step2 三连按钮（侧A详略→侧B详略→立场）。
   - v0.4 时代（2026-08-12，v0.3 架构）：教练会"我按你的逻辑整理如下：{学生话}"再引导确认——至少有一层"组织感"。

> 公平补充：v0.5.1 引入了 `HUMAN TUTOR TONE RULE`（19b0186，变化开头/不复述整句/去填充性赞美/禁元过程叙述），文本层的"AI 味"确实被压了；但**结构性**的机械感（按钮流 + 槽位推进 + 模板兜底）仍主导体验，文本语气优化被结构刚性抵消。

---

## 4. 根因：会议秘书架构的取舍

```
重构动因（meeting-secretary-plan v2）
  状态漂移（死锁/看板错/结构被改）= 第一优先 → 秘书确定性接管 → 牺牲了教练的生成式引导
  判断漂移（教得好不好/引导机械）= 第二优先 → P2 判断透镜只做了基础，引导质量未恢复
```

- **学生内容"原话保真"落槽** 是设计选择（防 LLM 代劳、防加料、防漂移），但代价是丢了"组织+润色"这一**教学价值**——把学生啰嗦/不完整的话顺成可写句子，本就是教练的核心职责。
- **结构确定性** 带来稳定，但把"教练的对话自由度"压到最低：Step3 LLM 连结构都不能输出，只能当"提问机"。
- **确认机制** 从"对话内自然确认"改成"按钮化提案"，时机前置、频次变多；篇章结构确认整体消失（移给不可见的 Planner）。

---

## 5. 结论与方向（仅评估，未改代码）

三条产品反馈（润色消失、策略确认时机改变、流程生硬）**全部属实，且可逐条对应到具体代码变更**：

| 反馈 | 对应变更 | 证据位置 |
|------|---------|---------|
| 语言润色→直接贴 | 秘书"原话保真"落槽取代"整理句"确认 | `appendMinute/landMinuteToSlot`（server.ts:4260/4303）+ prompt 8411/8461 + `buildStep3KickoffConfirmText`（v0.3:2322） |
| 确认策略时机改 | 篇章布局移出对话（`edce77e`）+ 详略/立场按钮化前置（`ec3e318`） | Step2 prompt "NOT paragraph layout" / 提案通道 `side_settle`/`stance` |
| 流程生硬 | 秘书架构 + 硬门禁 + 确定性兜底模板 | `buildStep2ContentAwareFallback` + 硬门禁规则 + 实录机械确认句 |

**若未来要恢复"教练感"，可行方向（供决策，不在本次评估实施）：**
1. 秘书架构下重新开放"轻组织"能力：minutes 双层已支持 `recorded/original` 与 `confirmed`——可让 coach 在确认前给一版"整理稿"，学生采纳整理稿，原话仍可追溯（落地=学生稿，写板=整理稿）。
2. 把篇章结构确认放回对话可见层：Planner 生成骨架后、进入 Step3 前，向学生展示"这一段写作蓝图"并确认，或在 Step3 开头展示骨架让"下一步写什么"透明。
3. 减弱硬门禁对对话自然度的侵入：门禁管**状态**，不强制**模板问句**；让 coach 追问回归"跟语料走、有组织感"（这是 roadmap §4.2 已挂的"教练引导质量"方向）。
