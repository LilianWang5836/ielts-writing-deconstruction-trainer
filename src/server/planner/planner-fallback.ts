/**
 * Planner 降级策略 — 数据感知的保守默认结构
 *
 * 当 Planner LLM 调用失败或 QA 连续失败时使用
 * 不调 LLM，纯代码返回通用结构
 *
 * 相对旧版改进：
 * 1. 携带 Step 2 材料到 subClaim（不再空串 → 修复 Step3 重复问「分论点」）
 * 2. 两个 Body 使用不同的展开链（不再是两侧同一模板）
 * 3. 单点 Body 槽位 4–5 个（符合规格：整段 4–7 / 单点 4–5 / 每点 2–3）
 */

import type { BodyPlan, PlannerInput } from '../../types';

/** 从材料中提取一句可作为 subClaim 的完整主张（长度 ≥ 8 才采用）。 */
function pickSubClaim(candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    const t = String(c || '').trim();
    if (t.length >= 8) return t;
  }
  return '';
}

/** 从 cluster 提取一句话（优先 content，其次 theme）。 */
function clusterSentence(cluster: any): string {
  const content = String(cluster?.content || '').trim();
  if (content.length >= 8) return content;
  const theme = String(cluster?.theme || cluster?.targetBody || '').trim();
  return theme;
}

/**
 * 根据题型返回保守默认 bodyPlans。
 * 使用 Step 2 材料填充 subClaim，并按材料采用差异化链形。
 */
export function buildFallbackBodyPlans(
  _questionType: string,
  input?: PlannerInput,
): BodyPlan[] {
  const clusters = Array.isArray(input?.materials?.clusters)
    ? input.materials.clusters
    : [];
  const c0 = clusterSentence(clusters[0]);
  const c1 = clusterSentence(clusters[1]);
  const aSide = String(input?.materials?.aSide || '').trim();
  const bSide = String(input?.materials?.bSide || '').trim();

  const body1Claim = pickSubClaim([c0, aSide, '（论点一）']);
  const body2Claim = pickSubClaim([c1, bSide, '（论点二）']);

  return [
    {
      id: 'body-1',
      targetBody: 'Body Paragraph 1',
      role: 'main_argument',
      theme: c0 || '分论点 1',
      paragraphDensity: 'single_point',
      argumentRelation: 'supports',
      mappedPoints: [body1Claim].filter(Boolean),
      paragraphPlan: {
        mode: 'single_point',
        diagnosis:
          '[fallback] 使用数据感知默认结构 — Planner 未成功；Body1 采用 主张→原因→机制→场景',
        pointBlocks: [
          {
            id: 'pb1',
            label: '分论点 1',
            subClaim: body1Claim,
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
                label: '展开原因',
                placeholder: '解释这个主张为什么成立',
                value: '',
              },
              {
                key: 'pb1_s3',
                label: '具体机制',
                placeholder: '这个原因是通过什么链条起作用的',
                value: '',
              },
              {
                key: 'pb1_s4',
                label: '典型场景',
                placeholder: '举一个具体场景或例子',
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
      theme: c1 || '分论点 2',
      paragraphDensity: 'single_point',
      argumentRelation: 'supports',
      mappedPoints: [body2Claim].filter(Boolean),
      paragraphPlan: {
        mode: 'single_point',
        diagnosis:
          '[fallback] 使用数据感知默认结构 — Planner 未成功；Body2 采用 主张→实例→后果→必要性',
        pointBlocks: [
          {
            id: 'pb2',
            label: '分论点 2',
            subClaim: body2Claim,
            role: 'major',
            expansionStrategy: 'example',
            steps: [
              {
                key: 'pb2_s1',
                label: '分论点',
                placeholder: '用一句话写出本段核心主张',
                value: '',
              },
              {
                key: 'pb2_s2',
                label: '具体实例',
                placeholder: '举一个孩子犯这类错误的日常具体场景',
                value: '',
              },
              {
                key: 'pb2_s3',
                label: '危害后果',
                placeholder: '说明如果不阻止会带来什么后果',
                value: '',
              },
              {
                key: 'pb2_s4',
                label: '干预必要性',
                placeholder: '总结为什么成人的及时干预是必要的',
                value: '',
              },
            ],
          },
        ],
      },
    },
  ];
}
