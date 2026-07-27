# Step 2.5 + Step3 去结构作者化 — 完整方案（定稿）

综合目标、非目标、adaptive QA、槽位适配、Body 论点变更出口、次要建议与 review 补丁。

**落地准备（先读再写代码）：**

- [黄金用例 · JSON 样例 · 状态机](./step2-5-prep-golden-cases.md)
- [代码挂载点清单](./step2-5-prep-mount-points.md)

---

## 1. 目标

| # | 目标 |
|---|------|
| 1 | 隐藏 **Step 2.5**：结合题目、立场、各 Body 论点，生成合理段内论证框架（含逻辑链）；**按题自适应，非写死拍表** |
| 2 | CTA「进入下一步」**出现时**后台启动 2.5；**运行中禁用左侧输入**；用户点击时若未完成 → 留在本页等待，完成后跳转 |
| 3 | Step3 **只读段级骨架**（mode / pointBlock 数与角色 / `argumentRelation`）；**允许槽位微适配**（合并 / 新增 / 改标题） |
| 4 | 输入适配由 **LLM 声明**，服务端校验并执行；`adaptations` **本轮立即生效**；仅 `value` 等 affirm |
| 5 | Plan QA 为 **adaptive skill**：先按题目生成 rubric，再评 plan；只判不写；用户不可见细节 |

**成功标准：** 进 Step3 时逻辑链来自 2.5；对话中服务端不再改段级骨架、不再运行时补拍；适配与深浅判定来自 LLM；改 Body 论点须用户确认后回 2.5 清页重跑。

---

## 2. 非目标（冻结）

- 不改 Step1
- 不改 Step4
- 不改 Step2 **探索对话**主流程（explore_A/B → stance → summary）
- Header **不**增加「2.5」步骤
- **不**对用户展示 plan QA / rubric 细节（仅等待/重试类文案）

---

## 3. 目标架构

```
Step2 探索 + summary
  → isCompleted + CTA「进入第三步」出现
       ↓ 同时触发（幂等）→ status=running → 禁用左侧输入
  Step 2.5 Planner（按题生成每段 paragraphPlan，value 全空）
       ↓
  Plan QA Skill
       · 职能0：本题 rubric
       · 1–4：忠实性 / 段内有效性 / 整篇一致性 / 可写性(warn)
       · 5：机械底线（纯代码）
       · 只输出 pass|fail + issues + fixHint；永不改 plan
       ↓ fail → 带 fixHint 重试，attempt ≤ 2；仍 fail → failed，UI 可重试
       ↓ pass → status=passed，锁 planSignature → 开放输入（若仍在 Step2）

用户点「进入下一步」
  ├─ passed 且指纹未 stale → 进 Step3，灌入 bodyPlans
  ├─ running → 留在本页：「正在整理段落结构，请稍候…」→ passed 后自动跳转
  └─ failed → 「整理失败，点击重试」

Step3 每轮用户输入
  → LLM：
      · 贴槽 → confirm + pendingText
      · 合理但错槽/多盖/缺环 → adaptations（merge/add/reclass/skip）立即声明
      · 不合理/太浅 → reject + 追问
      · 改 Body 段论点 → 询问是否回 2.5 重规划（不算普通 adaptations）
  → 服务端：执行 adaptations（立即生效）→ affirm 后写 value
  → 禁止：改 mode/blocks/relation、运行时补拍、启发式 hardReject/自动合并

若用户确认「改 Body 论点 → 重规划」
  → 前端清空 Step3 页数据 → running + 禁输入 → 2.5 重跑 → passed 后重建页面
```

---

## 4. 关键产品规则

### 4.1 2.5 运行与输入

- `status === 'running'`（首次 / stale 重跑 / 用户确认重规划）：**左侧输入禁用**
- CTA 出现即触发并进入 `running`，缩短「可继续聊」窗口
- **超时：** `running` 超过约 60s 且无更新 → 视为 `failed`（可重试），避免输入永久禁用

### 4.2 指纹与 stale

- 维护 `planSignature`（题目 + 立场 + clustering/framework 指纹）
- Step2 若在 CTA 后仍有写入导致指纹变化 → `stale` → 自动重跑 2.5（再次 `running` + 禁输入）
- 跳转条件：`passed` **且** 指纹与当前 Step2 一致

### 4.3 adaptations 事务

- **立即生效**（反映链形应如何）
- 学生否认 `pendingText` **不**回滚 adaptations
- 仅 `steps[].value` 写入依赖 affirm

### 4.4 「改架构」定义与出口

| 算改架构 | 不算改架构 |
|----------|------------|
| 改动 **Body 段论点**（换/增删某主体段核心点，或重映射各 Body 论点） | 同段内改 label、合并/新增/跳过逻辑链步骤 |

**流程：** LLM 判定属改 Body 论点 → 询问是否重规划 → 用户确认 → 清空 Step3 前端数据 → 2.5 重跑（禁输入）→ `passed` 后用新 `bodyPlans` 重建并开放输入。未确认则维持原 plan。

### 4.5 段级只读 vs 槽位可适配

- **只读：** mode、pointBlock 数量与 major/minor、`argumentRelation`
- **可适配：** 槽位 merge / add / reclass / skip（LLM 判定内容合理时）

---

## 5. 修改范围

### 5.1 新增

| 项 | 说明 |
|----|------|
| `session.step2_5` | 状态、bodyPlans、qaReport（含 rubric）、planSignature、attempt、时间戳 |
| `POST /api/step2_5/plan`（或内部 job） | 触发 / 重试 / 重规划 |
| Plan QA 模块 | 规则机械层 + LLM adaptive 层 |
| Step2/Step3 等待与禁输入 UX | running 禁输入；点击等待；重规划清页 |
| `step3SlotEval.adaptations` | 含 merge / add / reclass / skip |
| 「改 Body 论点」确认协议 | LLM 提问 + 用户确认 → 触发重规划 |

### 5.2 大改

| 区域 | 改动 |
|------|------|
| `types.ts` | `step2_5`、扩展 `step3SlotEval` |
| `server.ts` | 2.5 编排；拆结构作者；执行 adaptations；kickoff 只读锁定 plan |
| `Step2Brainstorm.tsx` | CTA 触发、等待跳转、禁输入 |
| `Step3Drafting.tsx` | 灌入 2.5；清页重规划；kickoff 不问造骨架 |
| `CoachChat.tsx` | 合并状态；running 禁用输入；执行 adaptations 后刷新看板 |
| Step3 prompt | 锁定骨架；adaptations；改 Body 论点走确认重规划 |
| verify 脚本 | **与删代码同相**更新断言 |

### 5.3 删除 / 停用（Step3 结构作者）

- `ensureArgumentRelationCoverage` / `ensureConcessionStructure` 的 Step3 调用
- `enforceFrameworkPointBlockCount`、`applyStep3FrameworkGuard`
- Step3「无 framework 自建骨架 / 自补 beats」prompt
- `collapseCoveredAdjacent*` 自动启发式 → 仅 LLM `adaptations`
- `hardRejectSlotText` 语义硬拦 → LLM `reject`；服务端仅空串/占位符

### 5.4 保留

- Step2 探索门禁（completion、retention、no-stance、素材过薄等）
- Step3：affirm 写 value、冻结已确认
- `planSignature`：检测漂移 / 拒绝脏合并（不自动改结构）

---

## 6. 数据契约

### 6.1 `session.step2_5`

```ts
step2_5: {
  status: 'idle' | 'running' | 'passed' | 'failed' | 'stale';
  startedAt?: number;
  updatedAt?: number;
  attempt?: number;            // Planner 重试，上限 2
  qaDepth?: 'mechanical' | 'full';  // A 阶段浅检 vs C 阶段满检，避免 passed 语义漂移
  planSignature?: string;
  qaReport?: {
    pass: boolean;
    rubric?: string;           // 内部，不对用户展示
    issues: Array<{
      severity: 'fail' | 'warn';
      bodyId?: string;
      stepKey?: string;
      reason: string;
      fixHint?: string;
    }>;
  };
  bodyPlans: Array<{
    id: string;
    targetBody: string;
    theme?: string;
    content?: string;
    paragraphDensity?: 'single_point' | 'dual_point';
    argumentRelation?: ArgumentRelation;
    pointRoles?: BodyPointRole[];
    mappedPoints?: string[];
    paragraphPlan: ParagraphPlan; // value 全空
  }>;
  errorMessage?: string;
}
```

### 6.2 `step3SlotEval`

```ts
step3SlotEval: {
  mode: 'expand' | 'confirm' | 'reject';
  targetKey?: string;
  pendingText?: string;
  rejectReason?: string;
  /** 改 Body 论点时：请求用户确认是否回 2.5，不算普通槽位适配 */
  structureChangeOffer?: {
    kind: 'body_argument_change';
    summary: string;           // 给学生看的变更说明
    awaitConfirm: true;
  };
  adaptations?: Array<
    | { op: 'reclass'; key: string; newLabel: string }
    | { op: 'skip'; keys: string[] }
    | { op: 'merge'; fromKeys: string[]; intoKey: string; newLabel?: string }
    | { op: 'add'; afterKey?: string; blockId: string;
        key: string; label: string; placeholder?: string }
  >;
}
```

服务端：`adaptations` 校验 key/冻结后立即应用 → 前端刷新；`structureChangeOffer` 等用户确认后再清页重跑 2.5。

---

## 7. Plan QA Skill（adaptive）

| 职能 | 内容 | 实现 |
|------|------|------|
| 0. 本题 rubric | 从题目/立场/各段论点与 relation 推出评判标准 | LLM，写入 `qaReport.rubric` |
| 1. 忠实性 | 未发明论据；与 Step2 立场/relation/角色/保留点一致 | LLM |
| 2. 段内有效性 | 按 rubric 评链是否成立（不数固定拍） | LLM |
| 3. 整篇一致性 | 段间不打架；回应题目与限定词 | LLM |
| 4. 可写性 | 一步一句、篇幅 realistic | 默认 **warn**，不阻塞 |
| 5. 机械底线 | schema、value 空、body 2–3、id 对齐 | **纯代码** |

- 只判不写；fail 带 `fixHint`；**attempt ≤ 2**
- 防退化：禁止通用「必须 N 步」规则；强制先输出本题 rubric
- Phase A 可仅机械检，`qaDepth: 'mechanical'`；Phase C 升为 `full`

**Planner：** 按题生成灵活链形；步数与顺序由材料决定。

---

## 8. 次要建议（已收入）

| 建议 | 落点 |
|------|------|
| QA/重试成本可控 | `attempt ≤ 2`；超限 `failed` + UI 重试，不静默转圈 |
| A/B 阶段 QA 占位语义 | `qaDepth: 'mechanical' \| 'full'`，避免 `passed` 含义漂移 |
| 旧会话兼容 | 无 `step2_5` 时跳转前补跑；等待文案通用（「正在整理段落结构…」） |
| running 超时 | ~60s → `failed`，解除禁输入并可重试 |
| verify 与删除同相 | Phase D/E 删代码时同步改断言，不留到最后 |

---

## 9. 分阶段实施方案

### Phase A — 2.5 + UX 门禁 + 禁输入

1. `step2_5` 类型与初始化
2. API：触发 Planner；QA 可先仅机械（`qaDepth: 'mechanical'`）
3. CTA 出现 → 幂等触发 → `running` → **禁左侧输入**
4. 点击：passed+指纹一致 → 跳转；running → 等待并自动跳；failed → 重试
5. 超时与指纹 stale → 重跑

**验收：** CTA 即跑；跑时不能继续聊；早点击等待；通过后进 Step3。

### Phase B — Step3 只读灌入 + kickoff

1. 从 `step2_5.bodyPlans` 建 subpoints
2. ContextSummary：「Locked plan from Step 2.5」
3. **Kickoff 改写：** 禁止现场造骨架；直接问第一个空槽；同步改服务端 kickoff 兜底（避免死模板/空板 confirm）
4. 无 passed 禁止进入或回 Step2 补跑

**验收：** 进 Step3 链已在；首轮即问首槽。

### Phase C — 完整 adaptive QA

1. 职能 0–4 + 机械层；`qaDepth: 'full'`
2. fail + fixHint 重试闭环（≤2）
3. rubric/issues 仅内部

**验收：** 明显不合题 plan 被打回；合理灵活链可通过；用户看不到 QA 细节。

### Phase D — 拆除 Step3 结构作者（verify 同相）

1. 删除 FrameworkGuard / 补拍 / 改 block 调用与相关 prompt
2. **同批**更新 verify（不再断言这些函数为 Step3 必有路径）

**验收：** 无服务端改段级结构、无末尾 push 拍。

### Phase E — 槽位适配 LLM 化 + Body 论点出口

1. schema/prompt：`adaptations` + `structureChangeOffer`
2. `applyStep3Adaptations`：立即执行合法 op
3. 停用自动 collapse；hardReject 缩成空/占位符
4. 确认重规划：清 Step3 页 → running 禁输入 → 2.5 → 重建
5. **同批**更新相关 verify

**验收：** 合理错槽可合并/新增/改标题；改 Body 论点走确认清页重跑；否认 pending 不回滚 adaptations。

### Phase F — 清理与回归

1. 删死代码
2. 用例：ouweigh+concedes、dual_point、早点击等待、running 禁输入、QA fail 重试、kickoff 首槽、adaptations、Body 论点重规划、旧会话补跑
3. 过渡期结束后可收紧「无 2.5 禁止进 Step3」

---

## 10. 风险与对策

| 风险 | 对策 |
|------|------|
| 2.5 延迟 | CTA 预跑；点击只等待 |
| Planner↔QA 死循环 | attempt≤2；warn 不阻塞 |
| QA 变相固定拍表 | 先 rubric；禁通用步数教条 |
| 乱发 adaptations | 校验 key/冻结；非法丢弃 |
| running 卡死 | 超时 → failed |
| CTA 后继续改点 | running 禁输入 + 指纹 stale 重跑 |
| kickoff 回潮 | Phase B 显式改 prompt 与兜底 |
| CI 中间态全红 | 删除与 verify 同相 |

---

## 11. 落地顺序

**A → B → C → D → E → F**

最小可交付：**A + B**（能等、能禁输入、能灌、kickoff 正确）。  
结构质量靠 **C**；去服务端作者靠 **D**；槽位与 Body 重规划靠 **E**。
