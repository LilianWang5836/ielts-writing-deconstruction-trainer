# v0.5.4.5 实施记录：历史对话导航 + Step3 完成持久化 + Step3 游标死循环

日期：2026-08-19
基线：v0.5.4.1（304ddbc）
来源：v0.5.4.1 实测——历史对话打开后页面报错、步骤切换 disabled、Step3 完成不持久化、Step3 论证死循环。

## 问题 → 根因 → 修复 对照

### 1. 历史对话打开后页面报错（ReferenceError: historyIndex is not defined）

- **现象**：打开历史对话后控制台报 `ReferenceError: historyIndex is not defined`，页面渲染异常。
- **根因**：`src/components/CoachChat.tsx` 中 `renderedMessages.map((msg) =>` 的回调未声明 `historyIndex` 参数，但下方 pending 确认按钮渲染逻辑用 `historyIndex === lastAiHistoryIndex` 比较索引，引用了未定义变量。
- **修复**：改用 `msg.id === chatHistory[lastAiHistoryIndex]?.id` 比较 message id 而非索引，避免依赖未声明的 `historyIndex` 参数。
- **文件**：`src/components/CoachChat.tsx`

### 2. 历史对话步骤切换 disabled（无法点击已完成步骤）

- **现象**：历史对话打开后，已完成的步骤（如 Step1/2/3）按钮 disabled，无法点击切换查看。
- **根因**：`src/components/Header.tsx` 的 `isCompleted = currentStep > step.num` 只看当前显示步骤，历史对话 `currentStep` 可能停在某个步骤，导致前面的步骤被判为"未完成"而 disabled。
- **修复**：
  - `src/components/Header.tsx`：新增 `completedSteps?: number[]` prop，`isCompleted = completedSteps.includes(step.num)`。
  - `src/App.tsx`：计算 `completedSteps` 数组，基于 `session.stepX.isCompleted` 实际标志；Step3 增加回退检查（所有 subpoint.isCompleted 都为 true 时也算完成，修复历史数据 `step3.isCompleted` 未持久化的情况）。
- **文件**：`src/components/Header.tsx`、`src/App.tsx`

### 3. Step3 完成状态未持久化（完成后历史对话仍不可点）

- **现象**：Step3 通过聊天 AFFIRM 路径（"下一步"/"对"）完成后，`session.step3.isCompleted` 仍为 false，导致历史对话中 Step3 按钮 disabled。
- **根因**：`server.ts` `enforceStep3SecretaryPath` 的 AFFIRM 分支只设置 `data.progressUpdate.isCompleted`，但从未更新 `session.step3.isCompleted`（只有 `/api/step3/decision` 接口才写该字段）。
- **修复**：
  - `server.ts` `attachStep3UiProgress`：当 `isStep3Finished` 为 true 时，同步更新 `session.step3.isCompleted = true`，确保持久化到服务端 session 对象（修复未来完成情况）。
  - `src/App.tsx` `completedSteps`：对 Step3 增加回退检查——`step3.isCompleted || 所有 subpoint.isCompleted 都为 true`，修复已存在的、状态未持久化的历史对话。
- **文件**：`server.ts`、`src/App.tsx`

### 4. Step3 论证拆解死循环（游标卡死，无法落槽）

- **现象**：Step3 论证过程中，学生输入任何内容都无法落槽，Coach LLM 一直说"这一步就定下来了，确认后写下一步"，但看板有空槽（展开原因/机制过程显示"待填写"），死循环。
- **根因**：Secretary 游标（`activeSlotIndex`）卡在末尾（值=4，指向 pb1b_s1 已确认），但前面有空槽（pb1_s2 展开原因、pb1_s3 机制/过程）被跳过。`firstEmptySlotKey` 和 `landMinuteToSlot` 都只从 `activeSlotIndex` 向后扫描空槽，找不到就返回 null/`all_slots_filled`，导致学生任何输入都无法落槽。
  - 游标卡死的成因：历史操作中"下一步"、"你这个例子就行啊"等导航/肯定回复被误判为内容并 confirmed 到 s1、s4，`commitPendingMinute` 确认后游标只往后推（`i > activeSlotIndex`），跳过中间空槽。
- **修复**（`src/server/step3/secretary.ts`，3 处）：
  - `firstEmptySlotKey`：从 `activeSlotIndex` 向后找不到空槽时，回退从 0 全局扫描。
  - `landMinuteToSlot`：同样增加回退扫描逻辑。
  - `commitPendingMinute`：确认后推进游标时，向后找不到空槽也回退扫描前面。
- **文件**：`src/server/step3/secretary.ts`

## 其他改动

- `src/components/Header.tsx`：版本号显示从 `MVP v1.0` 改为 `v0.5.4.5`。

## 验证

- `npx tsc --noEmit` 零错误。
- 浏览器实机验证：
  - 历史对话打开无报错。
  - Step1/2/3 按钮 `disabled: false`（可点击），Step4 `disabled: true`（未完成）。
  - Step3 死循环打破：输入实质内容后 `activeSlotIndex` 从 4 回退到 1，内容正确落到 pb1_s2（展开原因）槽，出现"确认"按钮；点击确认后 Step3 完成（论证进度 2/2），出现"立即跳转"进入 Step4。

## 遗留风险 / 后续

1. 游标回退扫描是兜底修复，根因（导航/肯定回复被误判为内容并 confirmed）仍存在，后续应加强 `isAdvanceSignal`/`isAff` 的内容识别，避免"下一步"等被写入看板。
2. `server.ts` 的 Step3 完成持久化修复需 tsx 重启生效；`App.tsx` 回退检查通过 HMR 即时生效，覆盖历史数据。
