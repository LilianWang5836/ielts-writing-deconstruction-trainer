# 问题反馈清单审查报告 (2026-08-20, v0.5.4.6)

> 对照用户反馈的 6 条问题，逐条在代码层面验证可复现性、定位根因、给出修复方向。

## 结论速览

| # | 问题 | 可复现 | 优先级 | 根因定位 |
|---|------|--------|--------|----------|
| 1 | Step1 探针重复询问 | ✅ | P0 | `dimension-probe.ts:299` 固定模板 + `||` 短路 + core 精确匹配失败 |
| 2 | 论点有效性判断弱 | ✅ | P2 | `Step1ProbeVerdict` 只有 expandable/thin，无语义判断 |
| 3 | Step2 没按题型问立场 | ✅ | P1 | `server.ts:452-453` 单一 Agree/Disagree 模板，无 per-type 分支 |
| 4 | Step2 每条问详略 + 末条卡死 | ✅ | P0 | `isPointWalked` 硬依赖 `retentionRole`，`isStep2ChecklistWalkDone` 阻塞 |
| 5 | 题型选项 chip 丢失 | ✅ | P1 | `CoachChat.tsx:1559` regex 门控脆弱，右侧无选项 |
| 6 | 右侧不同步 + 首条问两次 | ✅ | P0 | 与 1 同源：probe 不盖章 → 重问 + 维度不写入 |

---

## Step1

### 1. 重复询问（探针问法锁死）— P0

**可复现。** 根因有三层：

**① 探针模板是固定字符串** — `src/server/step1/dimension-probe.ts:299-305`
```ts
export function buildBareDimensionProbeAsk(dim: string): string {
  const label = stripStep1AllTags(dim) || String(dim || '').trim() || '这个角度';
  return (
    `「${label}」这个角度，你脑海里有没有浮现出具体的画面或例子？` +
    `哪怕一两句话、说个大概就行；暂时想不出来也没关系，我们就换个角度。`
  );
}
```
这是唯一的探针问句构造器，只插值 label，**重复询问时措辞完全不变**。

**② `probeVerdict` 的 `||` 短路陷阱** — `server.ts:6499-6506`
```ts
const modelVerdict = data.progressUpdate?.step1Data?.probeVerdict ?? merged.probeVerdict;
const verdict =
  normalizeProbeVerdict(modelVerdict) ||
  inferProbeVerdictFromStudentMessage(userMessage);
```
`normalizeProbeVerdict` 返回 `'thin'`（truthy 非空字符串）时，`||` 短路 → `inferProbeVerdictFromStudentMessage` **永不执行**。服务端兜底只在 LLM 完全省略字段或返回垃圾时才触发。DeepSeek 把"打人"误判为 thin → 盖 `（空标签）` → 维度仍"未生效" → 下一轮再灌同一句。

**③ core 精确匹配失败 → 不盖章** — `dimension-probe.ts:252-277`
```ts
if (stripStep1AllTags(raw).toLowerCase() !== core) return raw;  // 不匹配 → 不盖章
```
LLM 在学生回答轮重写 label 文本（如"暴力等伤害行为"→"暴力行为"）时，core 不再匹配 `pendingProbeCore` → **不盖章**，但 `pendingProbeCore` 仍被清除 → 维度保持未探测 → `earliestUnprobedDimension` 重新选中 → 固定模板再触发。**无 probeCount / probeHistory 二次去重。**

### 2. 论点有效性判断弱 — P2

**可复现。** 有效性判断**只看"有没有例子"，不看题型两侧/是否重复/能否独立成点**：

**① verdict 类型只有 expandable/thin** — `dimension-probe.ts:13`
```ts
export type Step1ProbeVerdict = 'expandable' | 'thin' | '';
```
无 `off_target` / `off_topic` / `duplicate` / `standalone` 等语义类别。

**② "有效"= 纯标签存在性检查** — `server.ts:2666-2675`
```ts
function isStep1DimensionExpandable(dim: string): boolean {
  // ...
  return (
    hasStandaloneStep1Tag(t, STEP1_DIM_EXPANDABLE_TAG) &&
    hasStandaloneStep1Tag(t, STEP1_DIM_PROBED_TAG)
  );
}
```
只检查 `（已探测）（可展开）` 标签是否存在，**不考虑**能否独立成点、落在哪一侧、是否与已有点重复。

**③ Discuss Both Views 有 per-side ≥2 计数，但无语义去重** — `server.ts:2853-2898`
```ts
const pass = effective >= STEP1_DIM_MIN_PER_SIDE || (exhausted && allProbed);
```
两侧各要求 ≥2 个有效维度，但"有效"仍只指标签。同一论点的两个面（"学习与改正"/"失去体验"）可被标为同侧两个有效维度，满足计数但无真正双侧覆盖。侧别归属来自 LLM 的 `dimensionSides` 字段或文本 `（侧：X）` 标签，**无语义校验**。

### 5. 题型选项 chip 丢失 — P1

**可复现。** chip 渲染条件是脆弱的 regex 门控：

**`src/components/CoachChat.tsx:1552-1572`**
```tsx
{msg.sender === 'ai' &&
  stepKey === 'step1' &&
  msg.id === chatHistory[lastAiHistoryIndex]?.id &&
  /题型|属于什么|哪一类|Question Type|question type/i.test(msg.text) &&
  !session.step1.isCompleted && (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {STEP1_QUESTION_TYPES.map((type) => (...))}
    </div>
  )}
```
反馈所述 4 条件**完全属实**。regex 只匹配 `题型|属于什么|哪一类|Question Type|question type` 5 个字面 token。教练若用"这是双边讨论""这道题要你讨论两方观点"等自然措辞 → **chip 不出现**。

**右侧"① 题型"无选项** — `src/components/Step1Analysis.tsx:281-310`：编辑态是自由文本 `<input>`，placeholder "例如：Two-part Question"，**无下拉/选项列表**。chip 失败时学生只能手打名称。

**选项列表定义** — `CoachChat.tsx:25-33`：7 个值（Agree/Disagree、Discuss Both Views、Advantages/Disadvantages、Two-part Question、Problem/Solution、Positive/Negative、Other），是 chip 的唯一来源。

### 6. 右侧不同步 + 首条问两次 — P0（与 1 同源）

**可复现，且与问题 1 是同一条状态链路的两个表面：**

**① 无"probe 通过 → 立即写入"逻辑** — `suggestedDimensions` 完全由 LLM 每轮重写（schema `server.ts:9730-9770`）。服务端只做：
- `preserveStep1ProbeTags`（`dimension-probe.ts:103-167`）：恢复 LLM 丢掉的**已盖章**行
- `stripIllegalSameTurnProbeTags`：剥离新 label 上的非法自报标签
- `resolvePendingProbeAnswer`：给 pending probe 目标盖章

**LLM 不把新提到的维度写入数组 → 右侧空**，无服务端 fallback 注入。

**② 去重仅靠 `（已探测）` 标签** — `isStep1DimensionUnprobed`（`dimension-probe.ts:65-73`）只看标签；`earliestUnprobedDimension`（`dimension-probe.ts:285-292`）跳过已标维度。**无 probeCount/probeHistory**。标签盖不上（见问题 1 的 ②③）→ 重选 → 重问。

---

## Step2

### 3. 没按题型走对应结构 — P1

**可复现。** stance 问法是**单一 Agree/Disagree 模板，无 per-type 分支**：

**`server.ts:452-453`（确定性 fallback）**
```ts
if (requiresStance && !stanceText) {
  return "各条论点已巡检完毕。结合已有论据强弱，你更倾向完全同意、部分同意（带让步），还是不同意？直接说一个即可。";
}
```
对所有 `requiresStance=true` 的题型**完全相同**。`Discuss Both Views` 的 `detectRequiresStance` 返回 `true`（`server.ts:1210-1213`），所以这句 Agree/Disagree 措辞会触发。

**proposal 通道也无 per-type 措辞** — `proposal.ts:1046-1052`：只包装 LLM 的 `suggestedStance.text`，不按 type 分支。

**per-type stance 逻辑只在 prompt 指令里**（`server.ts:9360-9362`），但确定性 fallback（`server.ts:453`）忽略它。

**与 5 的依赖链**：`correctType` 来源链（`server.ts:1713-1714`）：
1. `session.step1.coachEvaluation.correctType`（Step1 chip）
2. `session.step1.boardOverrides.questionType`
3. `inferQuestionTypeFromQuestion(question)` 启发式
4. **`"Agree / Disagree"` 默认兜底**（`server.ts:1324`）

Step1 chip 没点 + 题目文本无 "discuss both views" 关键词 → Step2 静默默认 Agree/Disagree → 错误 stance 措辞。

### 4. 每条问详略 + 末条卡死 — P0

**可复现。** "每条问详略"在**设计路径**上其实是 side-level（`side_settle`），不是 per-item；但**死锁是真的**：

**① `isPointWalked` 硬依赖 `retentionRole`** — `planner-payload.ts:192-201`
```ts
export function isPointWalked(p, dispositions?): boolean {
  if (!p || p.supersededBy) return true;
  if (p.retentionRole === 'dropped') return true;
  const d = findDispositionForPoint(p, dispositions);
  const disp = String(d?.disposition || '').trim();
  if (disp === 'dropped') return true;
  return isPointRetentionSettled(p);  // ← 需要 detail/brief/dropped
}
```

**② `isStep2ChecklistWalkDone` 阻塞** — `planner-payload.ts:238-256`
```ts
const unwalked = listUnwalkedChecklistPoints(payload, dispositions);
if (unwalked.length > 0) return false;   // ← 任何 unwalked 阻塞
```
`listUnwalkedChecklistPoints`（`planner-payload.ts:215-233`）把"有内容但无 retentionRole"标为 `needs_retention`。

**③ stage 推进门控** — `server.ts:1889-1891`：`exploreDone`（调用 `isStep2ChecklistWalkDone`）为 false → stage 永不进 stance/summary。

**死锁场景**：最后一条的 `side_settle` 提案被拒 + 学生自定义方案 label 匹配失败，或 proposal 通道拒绝武装 → 该点永无 `retentionRole` → `isPointWalked` 恒 false → `resolveNextSideWalkStep` 持续返回 `{kind:'side_retention'}` → 教练无限重问详略。

**"过完再问"逻辑存在但脆弱** — `resolveNextSideWalkStep`（`planner-payload.ts:358-384`）设计是"先展开完一侧所有 thin → 一次 side-level 详略 → 下一侧"。但 side_settle 失败时无确定性 fallback（如最长→detail、其余→brief），导致 `needs_retention` 永久卡住。

---

## 问题串联图（代码确认）

```
Step1 题型 chip 未出现 (5)  [CoachChat.tsx:1559 regex]
    → correctType 可能空/错  [server.ts:1324 默认 Agree/Disagree]
        → Step2 用同意/不同意问立场 (3)  [server.ts:453 单一模板]

Step1 探针固定句 + 盖章失败 (1)  [dimension-probe.ts:299 + ||短路 + core匹配]
    ↔ 右侧维度不同步、首条问两次 (6)  [无服务端注入 + 标签去重]
    → 有效性几乎只看"有没有例子" (2)  [verdict 只有 expandable/thin]

Step2 每条 needs_retention (4)  [isPointWalked 硬依赖 retentionRole]
    → side_settle 失败时无 fallback
    → 末条无标签 → 卡死  [isStep2ChecklistWalkDone 阻塞]
```

---

## 修复方向（按优先级）

### P0

**问题 4（Step2 死锁）**
- 在 `isPointWalked` / `isStep2ChecklistWalkDone` 增加确定性 fallback：当 side_settle 通道拒绝武装、且某点已有实质内容（`isPointExpandedForWalk`）但无 retention 标签时，自动分类（如最长→`detail`，其余→`brief`），避免永久 `needs_retention`。
- 文件：`src/server/step2/planner-payload.ts:192-201`、`238-256`

**问题 1 + 6（探针/棋盘）**
- 探针问句**轮换措辞**：`buildBareDimensionProbeAsk` 增加 ask-count 参数，第 2+ 次换问法（如"能再具体一点吗？举个实际场景"）。
- 修复 `||` 短路：当 LLM 返回 `thin` 但学生消息含具体例子信号时，**覆盖为 expandable**（`inferProbeVerdictFromStudentMessage` 应优先于 LLM thin 判断，或至少并列）。
- core 匹配放宽：`resolvePendingProbeAnswer` 用模糊匹配（包含/编辑距离）而非精确相等，容忍 LLM 重写 label。
- 增加 probeCount/probeHistory：同一维度探测 ≥2 次仍未盖章 → 强制 expandable 或跳过。
- 服务端注入：probe 通过时，若 LLM 未把该维度写入 `suggestedDimensions`，服务端主动注入。
- 文件：`src/server/step1/dimension-probe.ts:299`、`252-277`；`server.ts:6499-6506`、`6438-6473`

### P1

**问题 5（题型 chip）**
- 用结构化服务端信号替代 regex：Step1 问题型轮的 AI 消息携带 `metadata.step1Phase='ask-question-type'` 或 `session.step1.pendingQuestionTypeChoice=true`，chip 按此渲染，不依赖措辞。
- 右侧"① 题型"面板增加 7 选项 chip/select，作为 chat chip 失败时的兜底。
- 文件：`src/components/CoachChat.tsx:1552-1572`、`src/components/Step1Analysis.tsx:281-310`、`server.ts`（Step1 问题型轮）

**问题 3（按题型问立场）**
- `server.ts:452-453` 的 stance fallback 按 `questionType` 分支：Discuss Both Views → "你更倾向哪一方的观点？或是否要带让步？"；Advantages/Disadvantages → "你更倾向利大于弊还是弊大于利？"
- `proposal.ts:1046-1052` 同理。
- 文件：`server.ts:452-453`、`src/server/step2/proposal.ts:1046-1052`

### P2

**问题 2（有效性/双侧去重）**
- 扩展 `Step1ProbeVerdict`：增加 `off_target`/`duplicate`/`standalone` 等语义类别。
- `isStep1DimensionExpandable` 增加语义校验：能否独立成点、是否与已有点重复（文本相似度）、侧别是否真实。
- Discuss Both Views 的 per-side 计数增加语义去重，不只数标签。
- 文件：`src/server/step1/dimension-probe.ts:13`、`server.ts:2666-2675`、`2853-2898`
