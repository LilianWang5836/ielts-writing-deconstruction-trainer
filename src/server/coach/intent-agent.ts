/**
 * Intent Agent — 结构化状态变更提取
 *
 * 职责：
 * 1. 从对话中识别用户意图
 * 2. 输出结构化状态变更（stageTransition / slotUpdates / adaptations / completionFlag）
 *
 * 使用低 temperature + Gemini response_schema 确保输出精度
 */

import type { IntentOutput } from '../../types';

// 后续 PR-E 填充实现
