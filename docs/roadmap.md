# 后续推进计划（Roadmap）

> 分支：`restructure` | 日期：2026-08-15
> 前置：rebuild（P0-P3 + 前端优化 + 清理）已全部完成并验证，`docs/current-changes-evaluation.md` 确认当前改动零回归。
> 本文回答："秘书 rebuild 收尾后，接下来做什么？"

---

## 0. 现状盘点（已核实）

| 项 | 状态 |
|----|------|
| Step1-3 秘书架构（skeleton + minutes + 4 确定性函数 + 透镜 + 护栏） | ✅ 完整 |
| Step2 Planner（`/api/planner/generate` + CTA 自动触发） | ✅ 已达成（Step2Brainstorm.tsx:436） |
| 历史 PR-A~E 验收项 | ✅ 基本达成（残留均为注释/文档） |
| server.ts 规模 | 11,205 行（-4,889 vs 起点，-30.4%） |
| 测试 | tsc 0 + 60 单测 + 静态 + E2E 全过 |
| 未推送提交 | 14 个（`restructure` 落后于远端） |

---

## 1. 近期（低风险收尾，可随时做）

### 1.1 推送 `restructure` 分支
- 14 个未推送提交（含全部 rebuild 成果）需推送到 origin
- **注意**：先确认是否要合并到 `dev_dannielzhang` 或直接维护 `restructure`，与远端策略对齐

### 1.2 更新历史验收文档 checkbox
- `requirements-and-fix-plan.md` §8 的 PR-A~E checkbox 多数已达成但未打勾
- 建议逐项核实后勾选，标注实际实现位置（避免误导后来人以为未完成）

### 1.3 移除历史文档中的过时引用
- `verify-slot-reuse.mjs`（已归档到 `scripts/legacy/`）在 requirements 中被引用，需同步说明
- PR-D/PR-E 残留注释（`@deprecated` 等）可清理为纯文档

---

## 2. 中期（下一个主方向：Step4 纳入秘书/透镜架构）

### 2.1 现状问题
- `Step4SentencePractice.tsx` 共 **1,669 行**，是全项目最大的前端组件（比 Step3 的 1,246 行还大）
- **完全未使用** 秘书/透镜模式（`lens`/`secretary`/`minutes`/`skeleton` 引用 = 0）
- Step4 是"逐句写作 + 学术句式升级"，目前靠 `/api/generate-sentence-tasks` 单点生成 + 前端大量胶水逻辑

### 2.2 建议方向
- **短期**：先做 Step4 的 E2E 验证（浏览器走一遍逐句写作，确认 json 修复后无 400），记录问题
- **中期**：评估是否值得把 Step4 也纳入"结构化评估"模式——引入轻量版透镜（句式质量判定），复用 Step3 的 `step3Assessment` 思想输出结构化反馈
- **决策点**：Step4 是否也要"会议秘书式"确定性落槽？还是保持 coach-chat 生成式（Step4 与 Step3 的本质区别是"产出成品句"而非"填论证槽"，可能不需要落槽）

### 2.3 具体任务（若采纳）
1. 浏览器 E2E 走完 Step4 全流程（intro → bodyN → conclusion），确认 json 修复生效、无 400
2. 梳理 Step4 前端 1,669 行的重复逻辑，拆分子组件
3. 评估句质量透镜：`/api/generate-sentence-tasks` 返回结构化 `sentenceAssessment`（可选）

---

## 3. 中期（架构收口，决策已记录）

### 3.1 Planner skeleton 直出（暂不执行，保持记录）
- 已决策不改造（语义已达成，风险>收益）
- **触发条件**：若未来放弃历史会话兼容，可删除 `planToSkeleton` 回退（server.ts ~4395）

### 3.2 E2E 离线回归（暂不投入）
- 现有 `replay-student-multi.mjs` 全自动但依赖真实 LLM
- **触发条件**：若 CI 需要无 LLM 回归，再评估 mock 层成本

---

## 4. 长期（判断质量提升 — 对应 rebuild §1 的"第二优先"）

> rebuild 目标回顾：状态漂移（第一优先，已完成）→ 判断漂移（第二优先，P2/P3 已落地基础）

### 4.1 判断透镜扩展
- 当前 lens 覆盖 6 类链型约束（`LENS_CHAIN_CONSTRAINTS`）
- 可扩展：更多题型/句式的判断规则，配置从常量升级为可运营编辑（JSON/远程）

### 4.2 教练引导质量
- P2 已实现"引导跟语料走"（不套模板）
- 可进一步：分析教练追问的多样性/针对性，减少重复句式

### 4.3 学生诊断报告
- Step1 已有"审题诊断报告"；Step2/Step3 可产出汇总诊断（论证质量画像）

---

## 5. 建议的执行顺序

```
阶段 0（立即，<1天）  推送分支 + 更新历史验收文档 checkbox
阶段 1（近期，1-2天） Step4 E2E 验证 + 前端梳理（拆子组件）
阶段 2（中期）        决策 Step4 是否纳入透镜评估模式
阶段 3（长期，可选）  透镜扩展 + 教练质量 + 诊断报告
```

**推荐从"阶段 0"开始**：成本最低、消除"成果未上远端"的风险；随后进入 Step4 验证（确认 json 修复在真实流程中的效果）。
