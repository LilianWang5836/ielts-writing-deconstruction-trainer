/**
 * Step 2.5 Planner — 材料驱动的结构推理
 *
 * 职责：
 * 1. 盘点 Step 2 原材料（A面/B面 强弱）
 * 2. 按题型选择最优论证策略
 * 3. 分配材料到 Body → 生成 ParagraphPlan
 *
 * 入口：buildPlannerPrompt() + runPlanner() + runMechanicalQa()
 */

import type { PlannerInput, PlannerOutput, MechanicalQaResult, BodyPlan } from '../../types';

// 后续 PR-B 填充实现
