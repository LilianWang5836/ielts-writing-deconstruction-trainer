# 修复：Step1 探针裁决死锁（真实用户首轮卡死，2026-08-17）

> 性质：线上真实用户对话暴露的确定性死锁 + "非常人机"体验根因。
> 语料：`ielts-conversation-1786975855862(1).md` / `日志(1).md`（Agree / Disagree，线上教育题）。

---

## 现象

学生完整配合了 Step1：

1. 答对题型 → 2. 一句话说清核心任务（含"完全"限定词）→ 3. 给出三个中性角度（便利性 / 互动效果 / 监管强度）→ 4. 对三个探针逐一给出**具体场景**。

但每一轮教练文本都被 guard 覆写为：

```
「整体角度」当前 0 个有效角度，还差至少 2 个。请在该侧再补充至少 1 个不同的中性角度…
```

学生："嗯？为啥说0个有效果" → "进入下一步" → "是"，全部回到同一条提示，**Step1 永远无法完成**。

---

## 根因链

1. **主因 — 探针裁决依赖模型 `probeVerdict`，实机模型整轮不返回**：
   B-lite 在上一轮服务端强制探针后，本轮用 `data.progressUpdate.step1Data.probeVerdict` 盖章。
   实机 DeepSeek **三轮全不返回**（guard 日志 `verdict=thin/default` 即为空值兜底），
   `resolvePendingProbeAnswer` 缺省判 `thin`（空标签）→ 三个维度全部被盖（空标签）。

2. **（空标签）不计入有效**：`isStep1DimensionExpandable` 要求同时有（已探测）+（可展开），
   （空标签）→ 不计 → `effectiveDims=0` → `dimsSufficient=false` → guard 拒绝完成并注入"0 个有效角度"。

3. **次因 — 无升级路径**：`preserveStep1ProbeTags` 把旧（空标签）盖回模型本轮自报的（可展开）
   （日志：`Restored probe tags for: …` 后仍 `Cleared completion; effectiveDims=0`）。

4. **次因 — F2 耗尽逃生被 `!ctaOk` 卡死**：模型在本轮发了硬 CTA（"点击【下一步】按钮，进入第二步"，ctaOk=true），
   F2（`exhausted && !ctaOk && …`）被跳过；随后 strict-tags 块把 CTA 覆写成"0 个有效角度"并清 `isCompleted`。

---

## 修复（三处）

### ① 服务端探针裁决兜底（核心）
- `src/server/step1/dimension-probe.ts` 新增 `inferProbeVerdictFromStudentMessage(message)`：
  - 纯拒绝/含糊短句（没有 / 不清楚 / 想不出来 / 还没想好 / 没有具体例子…）→ `thin`；
  - 任何含具体内容的回答 → `expandable`（探针只是轻量过滤，深度由 Step2/3 把关）。
- `server.ts` B-lite 改为 `模型verdict || 服务端推断`——模型合规时仍以模型裁决为准，
  不合规（实机常态）时由服务端按学生实际回答兜底，不再系统性误判 thin。

### ② F2 耗尽逃生去掉 `!ctaOk`
- 条件改为 `exhausted && slotsOk && !newDimSameTurn && probedDimCount >= 2`。
- 学生已明确耗尽（"想不出来了 / 够了 / 进入下一步"）且按侧门禁放行时，服务端确定性补硬 CTA 并完成，
  即使模型已发 CTA 也不再被 strict-tags 块覆写。

### ③ 薄弱侧提示措辞自然化
- `formatStep1MissingSideHint` 尾部由"请在该侧再补充…"改为"目前记录到的角度还不足以支撑展开，
  请再补充至少 1 个不同的中性角度，并简单说说它对应的具体场景。"；
- 保留「X」当前 N 个有效角度，还差至少 M 个 前缀（既有测试/记录兼容）。

### ④ 探针问句自然化（"人机感"专项，用户第二轮要求）
- `buildBareDimensionProbeAsk` 模板重写：
  旧："『X』这个角度你脑子里已经有具体场景或例子的苗头了吗？有的话简单说一句信号即可；还没有的话我们再换一个角度。"
  新："「X」这个角度，你脑海里有没有浮现出具体的画面或例子？哪怕一两句话、说个大概就行；暂时想不出来也没关系，我们就换个角度。"
- `textLooksLikeProbeAskForDim` 放宽识别（具体+画面/情形/例子、想到过、有没有…画面/例子/场景），
  模型用真人口吻提问时不再被服务端模板覆写。
- server.ts 两处兜底 ask（same-turn / strict-tags）同步自然化。
- 系统 prompt：① 头部新增固定 `PERSONA` 段（耐心、温和、大白话的一对一中文雅思老师，像活人对话而非清单）；
  ② Step1 探针规则改为"提前用自己的话自然生成探针问句、禁苗头/信号等机器措辞、一次只问一个维度"，
  并说明服务端只在模型问得不清楚时才注入兜底——模型自然问法通常就是学生看到的文案。

---

## 验证

| 项 | 结果 |
| --- | --- |
| `npx tsx scripts/verify-step1-verdict-fallback.mts`（新增，复现实机三轮+耗尽逃生+措辞） | 23 用例全过 |
| `npx tsx scripts/replay-step1-dimension-probe.mjs` | 13 用例全过（含新增 natural phrasing 检测；"缺省→空标签"既有语义保留） |
| `npx tsx scripts/verify-p1-per-side.mts` | 全过（按侧门禁不受影响） |
| `npx tsx scripts/verify-t1-side-preserve.mts` | 全过 |
| `npx tsc --noEmit` / `npm run lint` | 零错误 |
