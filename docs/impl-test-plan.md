# 自测计划 — 不调 Gemini API

> 配套文档：IMPLEMENTATION_PROMPT.md | 每个 PR 完成后执行对应阶段测试

---

## 测试原则

1. **禁止真实调用 Gemini API**（`generateContent`、`getAI()` 等）
2. **禁止启动 Express 服务器**（`npm run dev`）
3. **只能运行静态检查**：TypeScript 编译、grep 断言、纯函数逻辑测试
4. 如果某个测试需要 API 调用，跳过并标记 "需要手动验证"

---

## Phase A 测试（PR-A 完成后）

```bash
# A1. TypeScript 编译
npx tsc --noEmit 2>&1 | head -20

# A2. 目录结构
ls src/server/coach/ src/server/planner/ src/server/guards/ src/server/prompts/

# A3. 骨架文件存在
ls src/server/coach/coach-agent.ts
ls src/server/coach/intent-agent.ts
ls src/server/planner/planner.ts
ls src/server/planner/planner-fallback.ts
ls src/server/guards/consistency.ts
ls src/server/prompts/coach-prompts.ts
ls src/server/prompts/intent-prompts.ts
ls src/server/prompts/planner-prompts.ts

# A4. types.ts 包含新类型
grep -c "Step2_5State\|BodyPlan\|CoachOutput\|IntentOutput\|CoachTurnResponse" src/types.ts
# 预期：每行命中

# A5. PracticeSession 包含 step2_5
grep "step2_5" src/types.ts
```

**通过：全部命中 + tsc 无错误**

---

## Phase B 测试（PR-B 完成后）

```bash
# B1. TypeScript 编译
npx tsc --noEmit 2>&1 | head -20

# B2. STRATEGY_TABLE 覆盖所有题型
grep -c "'Agree / Disagree'\|'Advantages / Disadvantages'\|'Discuss Both Views'\|'Problem / Solution'\|'Two-part Question'\|'Positive / Negative'" src/server/prompts/planner-prompts.ts
# 预期：≥5

# B3. 机械 QA 函数存在
grep -c "runMechanicalQa\|runMechanicalQa" src/server/planner/planner.ts
# 预期：≥2

# B4. 降级函数存在
grep -c "buildFallbackBodyPlans" src/server/planner/planner-fallback.ts
# 预期：≥2

# B5. 纯逻辑自测（不调 LLM）
cat > /tmp/test-planner.mjs << 'EOF'
// 复制 impl-pr-b-planner.md 中 B.6 节的测试代码
// （AI Agent 在执行时从该文档中提取测试代码）
EOF
node /tmp/test-planner.mjs && rm /tmp/test-planner.mjs
```

**通过：6 个测试全部 PASS + tsc 无错误**

---

## Phase C 测试（PR-C 完成后）

```bash
# C1. TypeScript 编译
npx tsc --noEmit 2>&1 | head -20

# C2. plannerStatus 状态管理
grep -c "plannerStatus" src/components/Step2Brainstorm.tsx
# 预期：≥3

# C3. inputDisabled prop
grep -c "inputDisabled" src/components/CoachChat.tsx
# 预期：≥2

# C4. /api/planner/generate 路由
grep -c "planner/generate" server.ts
# 预期：≥1

# C5. import buildFallbackBodyPlans
grep "buildFallbackBodyPlans" server.ts
```

**通过：全部命中 + tsc 无错误**

---

## Phase D 测试（PR-D 完成后）

```bash
# D1. TypeScript 编译
npx tsc --noEmit 2>&1 | head -20

# D2. step2_5 读取
grep -c "step2_5.*bodyPlans\|step2_5BodyPlans" src/components/Step3Drafting.tsx
# 预期：≥1

# D3. kickoff 锁定（不要求造骨架）
grep "请基于右侧已展示的段落结构直接开始" src/components/Step3Drafting.tsx

# D4. verify-step-openers
node scripts/verify-step-openers.mjs
```

**通过：全部命中 + verify 通过 + tsc 无错误**

---

## Phase E 测试（PR-E 完成后）

```bash
# E1. TypeScript 编译
npx tsc --noEmit 2>&1 | head -20

# E2. Coach Agent 存在
grep -c "buildCoachPrompt\|buildCoachRequest\|parseCoachResponse" src/server/coach/coach-agent.ts
# 预期：≥3

# E3. Intent Agent 存在
grep -c "buildIntentRequest\|parseIntentResponse" src/server/coach/intent-agent.ts
# 预期：≥2

# E4. Promise.all 并行调用
grep -c "Promise.all" server.ts
# 预期：≥1

# E5. 导入新 agent
grep "coach-agent\|intent-agent" server.ts
```

**通过：全部命中 + tsc 无错误**

---

## Phase F 测试（PR-F 完成后）

```bash
# F1. TypeScript 编译
npx tsc --noEmit 2>&1 | head -20

# F2. 旧 guard 已删除调用
! grep -n "applyStep3FrameworkGuard(" server.ts
# 预期：无输出（调用已删除）

! grep -n "enforceFrameworkPointBlockCount(" server.ts
# 预期：无输出

# F3. 新 guard 已接入
grep -c "validateTurnConsistency" server.ts
# 预期：≥1

# F4. verify-slot-reuse（可能需要更新断言）
node scripts/verify-slot-reuse.mjs
```

**通过：旧调用已删除 + 新 guard 存在 + verify 通过 + tsc 无错误**

---

## 最终回归测试

所有 PR 完成后执行：

```bash
# 1. 最终编译检查
npx tsc --noEmit

# 2. 验证所有 verify 脚本
node scripts/verify-step-openers.mjs
node scripts/verify-slot-reuse.mjs
node scripts/verify-step3-schemes.mjs
node scripts/verify-coach-momentum-guard.mjs

# 3. 确认 server.ts 行数减少
wc -l server.ts
# （与 12000 行对比，预期减少 500+ 行）

# 4. 确认所有新模块存在
ls -la src/server/coach/ src/server/planner/ src/server/guards/ src/server/prompts/

# 5. 确认 .env / .env.example 未被修改
git diff HEAD -- .env .env.example
# 预期：无输出
```

---

## 手动验证清单（需要 API Key 且启动服务器）

以下测试标注为"需要手动验证"，不在自动自测范围内：

- [ ] `npm run dev` 启动成功
- [ ] 浏览器打开 `http://localhost:3000` 无错误
- [ ] 选一个题目 → Step 1 → Step 2 → Planner → Step 3 → Step 4 完整走通
- [ ] Step 3 的 paragraphPlan 在对话中不漂移
- [ ] Planner 降级路径可用（切断网络后测试）
- [ ] `scripts/run-step1-3-e2e.mjs` 跑通
