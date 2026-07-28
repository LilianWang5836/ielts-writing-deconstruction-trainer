/**
 * Planner 降级策略 — 保守默认结构
 *
 * 当 Planner LLM 调用失败或 QA 连续失败时使用
 * 不调 LLM，纯代码返回通用结构
 *
 * 所有 body 使用 single_point + mechanism→example→impact 结构
 */

import type { BodyPlan } from '../../types';

/**
 * 根据题型返回保守默认 bodyPlans
 */
export function buildFallbackBodyPlans(_questionType: string): BodyPlan[] {
  return [
    {
      id: 'body-1',
      targetBody: 'Body Paragraph 1',
      role: 'main_argument',
      paragraphDensity: 'single_point',
      argumentRelation: 'supports',
      paragraphPlan: {
        mode: 'single_point',
        diagnosis: '[fallback] 使用默认结构 — Planner 未成功',
        pointBlocks: [
          {
            id: 'pb1',
            label: '分论点 1',
            subClaim: '',
            role: 'major',
            expansionStrategy: 'mechanism',
            steps: [
              {
                key: 'pb1_s1',
                label: '分论点',
                placeholder: '用一句话写出本段核心主张',
                value: '',
              },
              {
                key: 'pb1_s2',
                label: '解释机制',
                placeholder: '解释这个主张为什么成立',
                value: '',
              },
              {
                key: 'pb1_s3',
                label: '例证',
                placeholder: '举一个具体场景作为例证',
                value: '',
              },
            ],
          },
        ],
      },
    },
    {
      id: 'body-2',
      targetBody: 'Body Paragraph 2',
      role: 'main_argument',
      paragraphDensity: 'single_point',
      argumentRelation: 'supports',
      paragraphPlan: {
        mode: 'single_point',
        diagnosis: '[fallback] 使用默认结构 — Planner 未成功',
        pointBlocks: [
          {
            id: 'pb2',
            label: '分论点 2',
            subClaim: '',
            role: 'major',
            expansionStrategy: 'mechanism',
            steps: [
              {
                key: 'pb2_s1',
                label: '分论点',
                placeholder: '用一句话写出本段核心主张',
                value: '',
              },
              {
                key: 'pb2_s2',
                label: '解释机制',
                placeholder: '解释这个主张为什么成立',
                value: '',
              },
              {
                key: 'pb2_s3',
                label: '例证',
                placeholder: '举一个具体场景作为例证',
                value: '',
              },
            ],
          },
        ],
      },
    },
  ];
}
