# V1 改造方案：Step1 去门禁化 + 学生意图路由 + 教练 JSON 可选化（2026-08-18）

> 方向依据：与产品方讨论结论——现架构"硬门禁 + guard 覆写文本 + 依赖教练每轮 JSON"是
> 人机感与卡死的根源；V1 走"外科手术"路线（见会话讨论），不推翻秘书式内核，只做
> **去门禁化**。markdown 重写列为 V2 候选，本版不涉及。
> 本文档是可直接执行的修改方案 + 测试标准。改动后留工作区，不 commit/push。

---

## 0. 目标与原则

**目标**：在保留现有状态机/看板/前端/回归集的前提下，消除两类用户可感问题：
1. **卡死**：因为模型 JSON 缺字段 / 门禁不达标 / 缺 CTA 而无法进入下一步；
2. **人机感**：guard 覆写教练文本注入机械提示（"当前 0 个有效角度"等）。

**核心原则（V1 起对所有 guard 生效）**：
- **guard 只记状态，不拦流程，不替教练说话**；
- **默认推进 + 显式反对**：状态决策用"非阻塞路由"，任何误判可经对话回声 + 检查点回滚恢复；
- **完成 = 教练明确表达完成**（硬 CTA 或 `isCompleted:true`），内容充分性只作状态标记，不作完成闸门；
- 反代写红线、确认后写板、学生原话唯一真相、骨架冻结：**不变**（见 §6 红线复核）。

---

## 1. V1 范围

| 项 | 做 | 不做（V2/后续） |
|---|---|---|
| ① 学生意图路由 | 新增 `src/server/intent-router.ts`（确定性优先，粗粒度 6 类），接入 Step1 逃生/完成判定 | Step2/Step3 全面接入（先验证 Step1 效果再推广）；LLM 兜底通道（V2 加） |
| ② Step1 去门禁化 | `enforceStep1SlotCompletion` 重写：删全部阻塞分支与文本覆写（仅保留引导性 probe-first + F2 耗尽安全网） | — |
| ② Step2 完成门禁 | `enforceStep2Completion` 两处 `isCompleted=false` 清除改为仅日志（不再弹回） | Step2 其余 guard（momentum/ask-contract 等）保持现状 |
| ② Step3 | 不动 | 秘书落槽管线（稳定部分）保持现状；仅保证缺 progressUpdate 时不阻塞（现已是"无条件进入"） |
| ③ 教练 JSON 可选化 | 缺 `progressUpdate`/字段时所有 guard 降级为"记状态、不阻塞"（Step1 重写即实现；Step2/Step3 已具备） | 彻底去掉 part1/part2/progressUpdate 契约（那是 V2 markdown 方案） |
| markdown 文档方案 | — | V2 候选，另立方案 |

---

## 2. 改动明细

### 2.1 新增 `src/server/intent-router.ts`（①）

确定性优先的学生回复粗粒度分类器，**非阻塞**（只用于路由/打标签，不作闸门）。

```ts
export type StudentIntent =
  | "exhausted" // 想不出来/没了/够了/进入下一步（放弃补充材料）
  | "object"    // 反对/修改/推翻（对当前提案或已确认内容）
  | "accept"    // 纯确认（对/好/可以/嗯/没问题/继续，短句）
  | "clarify"   // 澄清请求（没听懂/什么意思/再说一遍）
  | "content"   // 有实质内容（论点/论据/场景等）
  | "unknown";

export function classifyStudentReply(message: string): StudentIntent
```

判定顺序（先命中的赢）：
1. 空/纯空白 → `unknown`
2. `exhausted`：复用现 `studentSignalsExhausted` 的正则语义（"没有/想不出来/够了/进入下一步"等）
3. `clarify`：什么意思/没听懂/再说一遍/解释一下/没明白/没理解
4. `object`：改成/换成/换掉/去掉/删掉/不对/不是这个/等等/重写/重新来/不要/撤销/回退/算了/别用/我想改/要改
5. `accept`：整句为短确认（对/好/可以/嗯/行/ok/好的/可以了/没问题/继续/确认/是/就这样/挺好）
6. `content`：有实质内容（长度或内容信号）
7. 否则 `unknown`

**测试标准（`scripts/verify-intent-router.mts`）**：
- 每类至少 3 个正例 + 2 个反例；
- 顺序规则用例："可以，但第二点换掉" → `object`（object 优先于 accept）；"进入下一步" → `exhausted`；"我不太懂，能再说一遍吗" → `clarify`；长实质回答 → `content`；
- 全用例通过 + lint 零错误。

### 2.2 重写 `enforceStep1SlotCompletion`（② Step1 去门禁化）

保留（状态记录）：
- 维度归一化、`applyStep1DimensionSides`（F1 侧别注入）、`preserveStep1ProbeTags`、`stripIllegalSameTurnProbeTags`、B-lite 探针裁决（含服务端兜底 `inferProbeVerdictFromStudentMessage`）、耗尽逃生打标（`质量待确认`）、`dimensionsSufficient`/`slotsOk` 状态标记。

删除（阻塞/覆写）：
- ~~软退出前充分性不足 → 覆写 Part2 为 `formatStep1MissingSideHint`~~ → 仅记状态
- ~~同日新维度 → 清 `isCompleted` + 覆写探针~~ → 不拦完成（probe-first 只在不完成时引导）
- ~~exitOpen 未开 → 清 `isCompleted` + 覆写软退出文案~~ → 不拦
- ~~strict-tags 计数不足 → 清 `isCompleted` + 覆写 missing hint~~ → 不拦
- ~~模型置 `isCompleted` 但无 CTA → 清 `isCompleted`~~ → 信任模型（软退出且无 CTA 除外）

保留（确定性安全网）：
- **F2 耗尽硬出口**：`exhausted && slotsOk && !newDimSameTurn && probedDimCount>=2` → 服务端补 CTA + 完成（唯一服务端写完成文案处，仅在学生明确耗尽时触发）。

新增（完成判定，去门禁化）：
```
完成 = ctaOk（硬 CTA） || data.progressUpdate.isCompleted === true
例外：softExitAsk && !ctaOk → 保持非完成
完成时：isCompleted=true；dimensionsSufficient 打当前值；清残留 step2Data
```

probe-first 改为"引导性"：
```
仅当 unprobed && !ctaOk && isCompleted !== true 时：
  若模型文本未在探测该维度 → 用自然化文案引导（buildBareDimensionProbeAsk）
  若已探测 → 仅挂 pendingProbeCore
教练已明确完成 → 不覆写、不拦（裸标签按原样记录，学生可随时回来补充）
```

**测试标准（`scripts/verify-step1-degate.mts`）**：
- 模拟真实对话（沿用 2026-08-17 卡死语料：3 角度 + 3 具体场景 + 模型不返回 probeVerdict）：
  - 3 轮探针后 `effectiveDims=3`、`dimsSufficient=true`；
  - 教练发硬 CTA"点击【下一步】进入第二步"（即使某侧不足/exitOpen 未开）→ `isCompleted=true` 且 **文本不被覆写**；
  - 模型置 `isCompleted:true` 且非软退出 → 保持完成；
  - 软退出"够用了吗？如果暂时想不到，告诉我" 且无 CTA → `isCompleted=false`，文本保持；
  - 学生"进入下一步"（exhausted）+ slotsOk + 已探测≥2 → F2 确定性 CTA + 完成；
  - 文本覆写断言：上述场景中 guard 均不替换教练 Part2（probe 引导与 F2 除外）；
- 复用既有：`replay-step1-dimension-probe`（纯函数）、`verify-p1-per-side`（按侧门禁）、`verify-step1-verdict-fallback` 全绿。

### 2.3 `enforceStep2Completion` 放松（② Step2）

- 两处 `data.progressUpdate.isCompleted = false;`（`!materialReady` 与 `!ctaOk&&!materialReady`）改为**仅日志**（`[Step2CompletionGuard] (degated) keep isCompleted`），不再弹回；
- 正向解锁分支（material-ready unlock / content-gate unlock / anti-drift）**不变**；
- 目的：Step2 不再因"材料未就绪/无 CTA"把模型表达的完成弹回（对齐"默认推进"）；空材料由 planner fallback + 学生可回头补充兜底。

**测试标准**：
- 现有 Step2 单测（replay-proposal-channel / replay-checklist-walk-gate 等）全绿（它们不覆盖此清除分支）；
- 逻辑断言：模型置 `isCompleted:true` 且文本无 CTA 且材料不足 → 保持 `isCompleted=true`（新行为）；
- lint 零错误。

### 2.4 教练 JSON 可选化（③）

- Step1 重写后：即使 `progressUpdate` 部分缺失/字段不全，guard 只记状态、不阻塞、不弹回——即"缺字段不卡"；
- Step2 已有 `step2Data` 空壳兜底、Step3 已是"无条件进入"，无需改动；
- 文档记录：V2 将彻底移除 part1/part2/progressUpdate 契约（markdown 方案）。

---

## 3. 测试标准总表（验收）

| # | 验收项 | 断言 |
|---|--------|------|
| T1 | intent-router 分类 | 每类 ≥3 正例 + ≥2 反例；顺序规则（object>accept、exhausted 含"进入下一步"） |
| T2 | Step1 硬 CTA 完成不被门禁弹回 | isCompleted=true；coach Part2 未被替换 |
| T3 | Step1 模型 isCompleted 被信任 | 非软退出下保持 true |
| T4 | Step1 软退出无 CTA 不完成 | isCompleted=false；文本保持 |
| T5 | Step1 F2 耗尽出口 | exhausted + slotsOk + 已探测≥2 → 确定性 CTA + isCompleted=true |
| T6 | Step1 卡死语料回归 | 3 轮探针 → effectiveDims=3 → 充分（不再"0 个有效角度"） |
| T7 | Step2 完成弹回移除 | 模型 isCompleted=true 不再被清（仅日志） |
| T8 | 既有回归 | replay-step1-dimension-probe / verify-p1-per-side / verify-step1-verdict-fallback / verify-t1-side-preserve / verify-guards / verify-secretary / verify-p3-replan / verify-replay 全绿 |
| T9 | lint | `npm run lint`（=tsc --noEmit）零错误 |

新增脚本：`scripts/verify-intent-router.mts`、`scripts/verify-step1-degate.mts`。
记录归档：本方案 + 变更记录追加至 `docs/`（项目惯例）。

---

## 4. 风险与回退

- **风险 1：完成判定放宽 → 内容不足时提前进入下一步**。缓解：F2/完成仍要求有基本材料（slotsOk 仅在 F2 用到）；planner 有 fallback；学生可随时返回补充（骨架未冻结前）；真实验收以 T2/T3 为准。
- **风险 2：probe 覆盖下降**（教练完成时跳过未探测维度）。缓解：probe-first 在未完成轮仍引导；裸维度记录在案，学生可回来补充；这是"流畅优先"的有意取舍，文档记录。
- **风险 3：Step2 空材料完成**。缓解：planner fallback + 文档记录，待实机验证；若真机出现空跑，V2 再加"最小内容软提示"（非阻塞）。
- **回退**：所有改动集中在 `server.ts` 两函数 + 新增模块，改动留工作区，可整体 revert；纯函数层（侧别/探针/按侧门禁）未动，回归集保护到位。

---

## 5. 不做的事（明确排除）

- 不删死代码、不做顺手重构；
- 不碰 Step3 秘书落槽管线（质量门控/确认/审计）；
- 不引入 LLM 兜底意图分类（V2）；
- 不实施 markdown 文档方案（V2 候选，另立方案）；
- 不执行 `git commit`/`git push`。

---

## 6. 红线复核（V1 后仍然成立）

| 红线 | V1 保障 |
|------|---------|
| LLM 出判断、代码管状态 | 意图/完成信号来自模型文本或 isCompleted；状态写入仍走服务端确定性函数 |
| 学生原话唯一真相 | 未动 Step3 minutes / 看板投影；Step1 维度仍记录学生原话 |
| 骨架冻结 | 未动 planner/Step3 骨架逻辑 |
| 反代写 | 未动 validatePolishedText 与润色路径 |
| 确认后写板 | Step1 探针/维度打标语义不变；F2/完成路径仍以"学生明确耗尽或教练明确 CTA"为前提 |

---

## 7. 变更记录（2026-08-18 执行后追加）

> 改动留在工作区，未 `git commit` / `git push`。

### 7.1 已落地改动

| 项 | 文件 | 改动 |
|---|------|------|
| ① 意图路由 | `src/server/intent-router.ts`（新增） | `classifyStudentReply`：确定性优先 6 类（exhausted/object/accept/clarify/content/unknown），顺序规则 object>accept、"进入下一步"=exhausted |
| ② Step1 去门禁化 | `server.ts` `enforceStep1SlotCompletion` | 删除 5 处阻塞分支（软退出不充分覆写 / 同日新维度拦截 / exit 未开拦截 / strict-tags 覆写 / 无 CTA 清完成）；probe-first 改为"未完成时引导"；完成 = 硬 CTA 或模型 isCompleted=true（软退出无 CTA 除外）；F2 耗尽硬出口保留；`exhausted` 改由意图路由 + 原函数联合判定 |
| ② Step2 完成放松 | `server.ts` `enforceStep2Completion` | 两处 `isCompleted=false` 清除改为仅日志（`(degated) keep isCompleted`） |
| ③ JSON 可选 | `server.ts` | Step1 缺字段不再阻塞/弹回（由 ② 实现）；Step2/Step3 已具备 |
| prompt 对齐 | `server.ts` Step1 prompt | "server enforces tags + exit gate" → "server RECORDS 且不阻塞"；新增 DE-GATED COMPLETION 说明（模型驱动完成、仅耗尽兜底自动完成） |

### 7.2 验收结果

| 测试标准 | 结果 |
|----------|------|
| T1 `verify-intent-router.mts` | 35/35 通过（每类正例/反例 + 顺序规则） |
| T2-T7 `verify-step1-degate.mts` | 21/21 通过（直接运行提取自 server.ts 的真实 `enforceStep1SlotCompletion`：硬 CTA 不被弹回/文本不覆写、模型 isCompleted 被信任、软退出不完成、F2 耗尽出口、卡死语料 3 轮探针回归、probe-first 不拦完成、Step2 弹回移除源码断言） |
| T8 既有回归 | replay-step1-dimension-probe(13) / verify-step1-verdict-fallback(23) / verify-p1-per-side / verify-t1-side-preserve / verify-guards(20) / verify-secretary(19) / verify-p3-replan / verify-replay(16) / verify-t2-point-confirm / verify-lens / verify-p2-reopen / verify-p4-polish / verify-step3-gate 全绿；replay-skeleton-lock / single-truth / step3-next-ask-clamp / framework-coverage / checklist-walk-gate(32) / merge-by-id / parse-coverage(21) / proposal-channel(37) / proposal-phase1(7) / step2-english-head 全绿 |
| T9 lint | `npm run lint`（tsc --noEmit）零错误 |

### 7.3 行为变化说明

- **Step1 现在"默认推进"**：教练发硬 CTA 或置 isCompleted=true 即完成，即使维度不足/exit 未开；不再出现"当前 0 个有效角度"式 guard 注入（该文案已从 guard 删除，仅 `formatStep1MissingSideHint` 保留为纯函数供未来/测试使用）。
- **probe-first 降级为引导**：教练已明确完成时不覆写文本、不拦完成；未完成且有裸标签时仍会自然引导探针。
- **F2 仍是唯一服务端写完成文案的路径**（学生明确耗尽时），作为防卡死安全网保留。
- **Step2 不再弹回模型表达完成**（仅日志），配合 planner fallback。
- 已知取舍（文档记录）：完成判定放宽后，若模型过早完成可能带着薄材料进入下一步；缓解 = 学生可随时返回补充 + planner fallback + 真机观察（§4 风险 1）。

### 7.4 未提交

全部改动留工作区，未 commit/push，由人审查。

---

## 8. V1.1 变更记录：Step2/3 接入共享意图路由（2026-08-18）

> 用户要求"step2/3 也要接意图"。把 `intent-router.ts` 的粗粒度路由接入 Step2/Step3 的关键学生意图判定点，非阻塞。

### 8.1 改动

| 位置 | 改动 |
|------|------|
| `src/server/intent-router.ts` | 新增 `skip` 意图类（跳过/略过/先不填/先过…，先于 exhausted 判定）；新增导出 `isStudentExhausted`（exhausted ∪ skip） |
| `server.ts` Step3 秘书路径 | `isAff` 接入 `classifyStudentReply==="accept"`；`isRej` 接入 `object`（**排除增量表达**：还有一个/补充一个/等等/另外/以及——那些是加料不是拒收）；`isSkipAsk` 接入 `skip`；`STRUCTURE_CHANGE_RE` 不变 |
| `server.ts` Step2 | `isStep2ExploreDone` 与 retention-lock 两处 `exhausted` 富集为 `studentSignalsExhausted \|\| isStudentExhausted` |
| `src/server/step2/student-turn-intent.ts` | `classifyStep2StudentTurnHeuristic` 前置共享路由：待提案槽 accept→采纳（排除"继续"）、短句 object→拒绝（排除增量）；exhausted/skip→unknown（**修复长句"想不出别的角度"被误判为内容**）；accept→confirm_ack 富集（没问题/可以啊/好嘞/对对/确认） |

### 8.2 验收

- `verify-intent-router.mts` 47/47（新增 skip 7 例 + isStudentExhausted 5 例）
- `verify-degate-wiring.mts` 17/17（新增）：Step2 真实启发式行为（长句耗尽→unknown、待提案 采纳/拒绝/不误判、纯确认富集）+ Step3/Step2 接线源码断言
- 既有全量回归（16 verify + 10 replay）全绿；`npm run lint` 零错误

### 8.3 语义说明

- **Step3 确认/拒绝更鲁棒**：`没问题/可以啊/好嘞/对对` 现视为确认（此前会落成内容）；`object` 排除增量表达避免"补充一个例子"被误判为拒收。
- **Step2 长句耗尽不再误判为内容**：`我暂时想不出别的角度了` → unknown（此前因长度≥8 判为 content_elaboration）。
- 全部接入点保持**非阻塞**：意图只路由/打标签，不新增任何闸门。

---

## 9. UI 全流程走查发现与修复（2026-08-18）

### 9.1 走查方法

真实 dev server（:3000 + DeepSeek）+ Playwright 驱动真实 UI（`/tmp/ui-e2e/ui-student.mjs`，配合型 5-6 分学生，Discuss Both Views 题），存档 `docs/recorded-sessions/ui-full-journey-20260818050541.txt`。

### 9.2 首轮结果（V1.1 代码，skip 修复前）

| 环节 | 结果 |
|------|------|
| Step1 | ✅ 通过：3 维度全部 `expandable`；学生"想不出来了"触发 F2 耗尽硬出口 → 确定性 CTA → 进入 Step2（对比修复前同场景卡 13+ 轮） |
| Step2 | ✅ 通过：`side_settle` 两侧详略提案采纳 ×2、立场提案采纳、blueprint 缺失走内容兜底 → summary 完成 → planner 生成 side_by_side 2 body |
| Step3 | ❌ **死锁**：学生反复"这个点我大概就想到这些，暂时展开不了更多了"，秘书 gate 判 `verdict=ok`，但落槽被 `checkDuplicate` 判重拒绝（`duplicate_sibling`）→ 同槽 `body-1_auto_p2_s1`（略写补充点）永不推进 → StallGuard 连续 19 次 hard 报警；教练文本已"进入第二段"但状态未动（文本/状态脱节） |

### 9.3 根因

Step3 秘书的"跳过"出口只在 **stall 触发 + 学生明确说「跳过」** 时生效；而"展开不了更多"这类 **exhausted 表达**未被识别为跳过信号 → 落成内容后被判重拒绝 → 死锁。

### 9.4 修复（V1.2，接意图延伸）

1. `intent-router.ts`：`EXHAUSTED_SUB_RE` 增加"展开不了/展开不出来/没法展开/不硬展开/暂时展开不了"等家族。
2. `server.ts` Step3 秘书路径：跳过出口触发条件从"仅 isSkipAsk"扩为 **`isSkipAsk || isStudentExhausted(msg)`**；生效门槛 = `stall 已触发 || 目标空槽被拒≥2`（防误伤正常作答）。复用 `skipSlot`（confirmed+skippedTag 占位，看板标「暂略」可点「修改」回补）。
3. 驱动脚本 `detectStep` 修复（测试 artifact）：Step3 检测优先用"主体段/Body Paragraph"等持久标记，避免看板无"待确认"时被"详写/略写"误判回 step2。

### 9.5 验收

- `verify-intent-router.mts` 51/51（新增"展开不了"家族 4 例）
- `verify-degate-wiring.mts` 21/21（新增 Step3 秘书跳过接入断言 2 例）
- lint 零错误
- 全量 UI 重跑（V1.2 代码 + 驱动修复）结果见 §9.6

### 9.6 全量重跑结果（V1.2 代码 + 驱动修复，存档 `ui-full-journey-20260818052033.txt`）

| 环节 | 结果 |
|------|------|
| Step1 | ✅ 8 动作：3 维度全部 expandable；"想不出来了"触发 F2 耗尽出口 → 进入 Step2 |
| Step2 | ✅ 4×「采纳」（3× side_settle 详略 + 1× 立场）+ blueprint 内容兜底 → 完成 |
| Step2.5 | ✅ planner 生成 side_by_side **3 body**（提高效率 / 企业运营优化 / 失业风险） |
| Step3 | ✅ 38 动作、**12×「确认写板」**：body-1（4 槽）+ body-2 等多槽逐槽落槽+确认，秘书游标正常推进，**无死锁** |
| Step4 | ✅ 到达（"逐句通关 / 正在生成分段逐句训练任务"页面已渲染） |

**异常汇总（1 条，非产品问题）**：`[异常] 输入框不可见（step=3，动作 47）`——驱动在 Step3→Step4 切换后找不到 Step4 输入框（占位符不同，已知驱动限制，§11.3 已记录），非服务端 bug。

**结论**：V1 去门禁化 + V1.1 意图路由 + V1.2 Step3 暂略修复后，**Step1→Step2→Step2.5→Step3→Step4 全流程 UI 走查通过**；Step3 的"展开不了更多"死锁已消除（首轮 77 动作卡死 → 本轮 47 动作走完并进入 Step4）。Token：入 427.5k / 出 18.1k / 缓存 339.8k。

### 9.6.1 Step4 起步引导交互闭环验证（第 12 轮，存档 `ui-full-journey-20260818081419.txt`）

| 环节 | 结果 |
|------|------|
| Step1 | ✅ 维度探测 → F2 耗尽硬出口 → 确定性 CTA |
| Step2 | ✅ 材料展开（效率/降低成本/客服行业 A 面 + 失业风险 B 面）→ 4×「采纳」详略/立场锁定 → planner 生成 side_by_side **2 body** |
| Step3 | ✅ 秘书逐槽确认（body-1 降低成本 6 槽：分论点/原因/机制/结果/补充）；**exhausted→「暂略」跳过链路实测通过**（`SKIP slot=...（exhausted）`，教练"看板上标了「暂略」…"） |
| Step3→Step4 | ✅ 动作 39「立即跳转」→ 逐句任务生成（intro 1/2 · body1 0/6 · body2 0/4 · conc 0/1） |
| Step4 起步引导 | ✅ 动作 40：「我不会起步」激活（含一次重试）→ 起步引导输入框出现 → 发送中文回复 → **教练引导回复到达**（引导线程新增"起步阶段"气泡） |
| Step4 收尾 | ✅ 写入英文草稿 `AI significantly improves workers productivity by automating repetitive tasks.` → 点击「确认此句并加入全文」→ 收尾 |

**异常汇总（0 条）**——**Step1→2→3→4 全流程 + Step4 起步引导问答闭环 + 确认此句全部通过**。

**结论**：产品侧 Step3→Step4 转换与 Step4 起步引导交互**均正常**（此前 5 轮失败全部为 Playwright 驱动缺陷：Step2/3 误判、候选回显句式缺口、Step4 输入框激活时机、引导回复检测选择器，逐项修复后归零）。Token 累计：入 ~6.2M / 出 ~340k（含 12 轮全流程累积）。



