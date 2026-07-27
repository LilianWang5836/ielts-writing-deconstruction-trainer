# Step 2.5 落地准备：黄金用例 · JSON 样例 · 状态机

配套方案：[`step2-5-architecture.md`](./step2-5-architecture.md)。  
用途：实现前钉死契约，供 Phase A–F 验收与单测/手工脚本使用。

---

## 1. `step2_5` 状态机

```
idle
  │ CTA 出现 / 显式触发 / stale 重跑 / 用户确认 Body 论点重规划
  ▼
running  ──(左侧输入禁用)──┐
  │                        │
  │ QA pass                │ 超时 ~60s / 异常
  ▼                        ▼
passed ◄──指纹仍一致─── failed
  │                        │
  │ Step2 指纹变化           │ UI「重试」
  ▼                        └──► running
stale ──► running
```

| 状态 | 左侧输入 | 「进入下一步」点击行为 |
|------|----------|------------------------|
| `idle` | 可用（探索期） | 不应出现 CTA；若出现则先触发 2.5 |
| `running` | **禁用** | 留在本页等待，文案「正在整理段落结构，请稍候…」；完成后自动跳转 |
| `passed`（指纹一致） | 可用 | 进入 Step3，灌入 `bodyPlans` |
| `failed` | 可用 | 展示重试；重试 → `running` |
| `stale` | 视作需重跑 → 很快进 `running` | 同 `running` |

**跳转硬条件：** `status === 'passed'` **且** `planSignature` 与当前 Step2（题目+立场+clustering/framework）一致。

**事务约定：**

- `adaptations`：本轮立即生效；否认 `pendingText` **不**回滚。
- 仅 `steps[].value` 等 affirm 写入。

---

## 2. 黄金用例表

| ID | 场景 | 输入要点 | 期望（2.5 / Step3） | 验收 Phase |
|----|------|----------|---------------------|------------|
| G1 | outweigh + concedes | 利大于弊；Body1 支持、Body2 让步 | 2.5 为让步段生成「承认对立面 + 不足以推翻」类链（顺序按题合理，非强制垫底）；`argumentRelation=concedes`；Step3 不补拍 | A–D |
| G2 | dual_point | 同段两点 major+minor | `paragraphDensity=dual_point`，两 pointBlock；让步拍若需要则段级/major，不强制每 block 一套 | A–C |
| G3 | no-stance 题型 | `requiresStance=false` | Step2 仍可 CTA；2.5 按任务概述生成；不依赖 stance 舞台 | A–B |
| G4 | 早点击等待 | CTA 出现即点跳转，2.5 仍 `running` | 不离页；禁输入；passed 后自动进 Step3 | A |
| G5 | running 超时 | mock 卡住 >60s | → `failed`；输入恢复；可重试 | A |
| G6 | 指纹 stale | CTA 后若仍写入改变 clustering（防呆） | → stale → 重跑；跳转需新 passed | A |
| G7 | kickoff 首槽 | 进 Step3 首轮 | plan 已在板；`mode=expand` 问 firstEmpty；无造骨架、无 confirm bundle | B |
| G8 | QA 明显不合格 | Planner 故意缺段 / value 非空 | 机械或 full QA fail；attempt≤2；最终 failed 可 UI 重试 | A/C |
| G9 | 合理错槽 reclass | 问原因，学生答场景 | LLM `reclass` 改 label；adaptations 立即生效；再 confirm | E |
| G10 | 一句话盖两拍 | 学生一句完成两不同环节 | `merge` 或后续分轮 confirm；**禁止**服务端启发式自动 collapse | E |
| G11 | 缺环 add | 合理但缺一论证环节 | `add` 空槽；前端链上出现新步；下轮再问 | E |
| G12 | 浅层 reject | 「就是这样」无内容 | `mode=reject`；不写 value；不改结构 | E |
| G13 | 改 Body 论点 | 学生要换某段核心分论点 | `structureChangeOffer`；确认后清 Step3 页、禁输入、2.5 重跑、重建 | E |
| G14 | 否认 pending | confirm 后学生说「不对」 | value 不写入；**adaptations 不回滚** | E |
| G15 | 旧会话无 step2_5 | 老 session 点进 Step3 | 跳转前补跑 2.5；通用等待文案 | A/F |

---

## 3. JSON 样例

### 3.1 合法 `step2_5`（节选）

```json
{
  "status": "passed",
  "attempt": 1,
  "qaDepth": "mechanical",
  "planSignature": "sig-example-001",
  "qaReport": {
    "pass": true,
    "rubric": "(full QA only; internal)",
    "issues": []
  },
  "bodyPlans": [
    {
      "id": "body-1",
      "targetBody": "Body Paragraph 1",
      "paragraphDensity": "single_point",
      "argumentRelation": "supports",
      "mappedPoints": ["课堂监管更及时"],
      "pointRoles": [{ "point": "课堂监管更及时", "role": "major" }],
      "paragraphPlan": {
        "mode": "single_point",
        "diagnosis": "[from-step2_5]",
        "totalClaim": "",
        "pointBlocks": [
          {
            "id": "pb1",
            "label": "课堂监管",
            "role": "major",
            "subClaim": "课堂监管更及时",
            "expansionStrategy": "mechanism",
            "steps": [
              { "key": "pb1_s1", "label": "具体机制", "value": "", "placeholder": "" },
              { "key": "pb1_s2", "label": "学习效果", "value": "", "placeholder": "" }
            ]
          }
        ]
      }
    }
  ]
}
```

**机械底线：** 所有 `steps[].value` 为空；`bodyPlans.length ∈ {2,3}`；id/key 唯一。

### 3.2 非法 plan（机械 QA 应 fail）

```json
{
  "issues": [
    { "severity": "fail", "reason": "steps[].value must be empty before Step3", "stepKey": "pb1_s1" },
    { "severity": "fail", "reason": "bodyCount must be 2 or 3", "bodyId": null },
    { "severity": "fail", "reason": "missing bodyPlan for cluster Body Paragraph 2", "bodyId": "body-2" }
  ]
}
```

### 3.3 合法 `adaptations`（立即生效）

```json
{
  "mode": "confirm",
  "targetKey": "pb1_s1",
  "pendingText": "老师能当场提醒走神的学生。",
  "adaptations": [
    { "op": "reclass", "key": "pb1_s1", "newLabel": "课堂场景" },
    { "op": "skip", "keys": ["pb1_s2"] }
  ]
}
```

```json
{
  "mode": "expand",
  "targetKey": "pb1_s1",
  "adaptations": [
    {
      "op": "add",
      "afterKey": "pb1_s1",
      "blockId": "pb1",
      "key": "pb1_s1b",
      "label": "为何不足以推翻整体立场",
      "placeholder": ""
    }
  ]
}
```

```json
{
  "mode": "expand",
  "adaptations": [
    {
      "op": "merge",
      "fromKeys": ["pb1_s1", "pb1_s2"],
      "intoKey": "pb1_s1",
      "newLabel": "场景与影响"
    }
  ]
}
```

### 3.4 非法 adaptations（服务端应拒绝 op，打日志）

| 样例 | 原因 |
|------|------|
| `reclass` 未知 `key` | key 不存在 |
| `reclass` 已 `confirmed` 槽 | 冻结 |
| `add` 缺少 `blockId` / 重复 `key` | 契约违规 |
| `merge` 跨两个 `pointBlock`（若产品禁止） | 越权 |
| 借 `adaptations` 改 `mode` / 删整个 pointBlock / 改 `argumentRelation` | **禁止**；属段级骨架 |

### 3.5 `structureChangeOffer`（改 Body 论点）

```json
{
  "mode": "expand",
  "structureChangeOffer": {
    "kind": "body_argument_change",
    "summary": "你想把第二段核心点从「让步成本」改成「社会公平」，这会重做该段逻辑链。是否重新规划？",
    "awaitConfirm": true
  }
}
```

用户确认 → 清 Step3 页 → `step2_5` 重跑；未确认 → 维持原 plan。

---

## 4. 离线 Prompt 试跑清单（接主流程前）

用 3～5 道真题手工打 Planner / QA / adaptations：

1. Planner：链形是否按题变化（而非永远 claim→reason→impact）
2. QA：是否先产出本题 rubric；warn 是否误升为 fail
3. adaptations：是否误把「改 Body 论点」当成 reclass
4. kickoff 文案：是否仍出现「请确认整链」类死模板

记录失败样例进本文件附录（实现期维护）。

---

## 5. 与 Phase 的映射

| 准备产物 | 优先服务 |
|----------|----------|
| 状态机 + G4/G5/G6 | Phase A |
| G7 + kickoff | Phase B |
| G1/G2/G8 + QA 样例 | Phase C |
| 删除清单（见挂载点文档） | Phase D |
| G9–G14 + adaptations 样例 | Phase E |
| G15 | Phase A 过渡 / Phase F |
