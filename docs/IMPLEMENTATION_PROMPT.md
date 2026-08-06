# IMPLEMENTATION_PROMPT.md — 主执行指令

将此文件内容作为 prompt 交给 AI Agent（Gemini / Copilot），要求其按顺序完成全部 PR-A 到 PR-F 的实现。

---

## 执行指令

```
你是一个高级前端+后端开发工程师，需要按照以下文档组，为 IELTS Writing Deconstruction Trainer 项目执行重构。

【项目根目录】
/Users/dannielzhang/Desktop/code/ielts-writing-deconstruction-trainer

【工作分支】
dev_dannielzhang（已创建，你当前在此分支）

【文档组（按执行顺序阅读）】
1. docs/restructure-plan.md          ← 总体架构与策略（必读）
2. docs/impl-pr-a-types-skeleton.md  ← PR-A：类型扩展 + 文件骨架
3. docs/impl-pr-b-planner.md          ← PR-B：Planner 实现
4. docs/impl-pr-c-step2-transition.md ← PR-C：Step 2→3 过渡
5. docs/impl-pr-d-step3-inject.md     ← PR-D：Step 3 灌入 plan
6. docs/impl-pr-e-coach-rewrite.md    ← PR-E：Coach + Intent Agent
7. docs/impl-pr-f-guards-cleanup.md   ← PR-F：一致性断言 + 死代码清理
8. docs/impl-test-plan.md             ← 自测计划

【执行规则】
1. 严格按照 PR-A → PR-B → ... → PR-F 的顺序执行，不可跳过或并行
2. 每个 PR 完成后，立即按 impl-test-plan.md 中对应阶段的测试项进行自测
3. 自测通过后再进入下一个 PR
4. 每个 PR 完成后，用 git commit 提交

【API 调用禁令】
- 禁止在测试/验证中真实调用 Gemini API（`generateContent`、`getAI()` 等）
- 禁止启动 Express 服务器（`npm run dev`）
- 只能运行不依赖 API key 的静态检查：TypeScript 编译检查、单元逻辑校验
- 如果某个测试需要 API 调用，跳过并标记为 "需要手动验证"

【质量标准】
- 所有新增/修改的 TypeScript 文件必须通过 `npx tsc --noEmit` 检查
- 不引入新的 npm 依赖
- 不修改 docs/ 目录下的任何文档
- 不修改 .env / .env.example / .gitignore
- 不修改 README.md / package.json / vite.config.ts / tsconfig.json
- 每次 commit 的 message 格式：`feat(PR-X): 简短描述`

【参考优先】
- 阅读每个 impl-pr-*.md 前，先确保已理解 restructure-plan.md 的对应章节
- 实现时优先参考现有代码风格（如 server.ts 中的函数命名、错误处理模式）
- 新增文件的导入路径遵循项目现有约定

现在请开始执行 PR-A。
```

---

## 文档组索引

| 文档 | 用途 | 目标读者 |
|------|------|----------|
| `restructure-plan.md` | 总体架构设计（必读第一份） | 人类 + AI |
| `impl-pr-a-types-skeleton.md` | PR-A 执行细节 | AI Agent |
| `impl-pr-b-planner.md` | PR-B 执行细节 | AI Agent |
| `impl-pr-c-step2-transition.md` | PR-C 执行细节 | AI Agent |
| `impl-pr-d-step3-inject.md` | PR-D 执行细节 | AI Agent |
| `impl-pr-e-coach-rewrite.md` | PR-E 执行细节 | AI Agent |
| `impl-pr-f-guards-cleanup.md` | PR-F 执行细节 | AI Agent |
| `impl-test-plan.md` | 自测计划 | AI Agent |

---

## 快速启动

将此文件中的执行指令复制给 AI Agent 即可。AI Agent 应按以下顺序自动工作：

```
1. 阅读 restructure-plan.md
2. 阅读 impl-pr-a-types-skeleton.md → 执行 → 自测 → commit
3. 阅读 impl-pr-b-planner.md        → 执行 → 自测 → commit
4. ...以此类推到 PR-F
5. 最终汇报完成状态
```
