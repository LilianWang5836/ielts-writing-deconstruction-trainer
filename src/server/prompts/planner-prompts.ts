/**
 * Planner Prompt 模板 — 材料驱动的结构推理
 */

export interface StrategyDef {
  name: string;
  description: string;
  appliesWhen: string;
  argumentRelation: string;
  layoutPattern: string;
  bodyCount: number;
}

/** 所有题型的策略枚举 */
export const STRATEGY_TABLE: Record<string, StrategyDef[]> = {
  'Agree / Disagree': [
    {
      name: 'strong_support',
      description: '完全同意或完全不同意，围绕该立场展开多个论点',
      appliesWhen: '一侧材料明显更强，用户已有明确立场',
      argumentRelation: 'supports',
      layoutPattern: 'support',
      bodyCount: 2,
    },
    {
      name: 'concession',
      description: '承认另一方具有一定合理性，但论证己方观点更重要（Although..., I believe...）',
      appliesWhen: '双方都有材料但己方更强，适合展示批判性思维',
      argumentRelation: 'concedes',
      layoutPattern: 'concession_then_support',
      bodyCount: 2,
    },
    {
      name: 'different_situations',
      description: '不同条件下结论不同（如 In developed countries... / In rural areas...）',
      appliesWhen: '材料涵盖不同场景/人群，且结论因情境而异',
      argumentRelation: 'side_by_side',
      layoutPattern: 'side_by_side',
      bodyCount: 2,
    },
    {
      name: 'partial_agreement',
      description: '部分认同题目观点，但补充更重要或更全面的因素',
      appliesWhen: '题目包含 only/all/best 等绝对词，需要限定范围',
      argumentRelation: 'supports',
      layoutPattern: 'support',
      bodyCount: 2,
    },
  ],
  'Advantages / Disadvantages': [
    {
      name: 'advantage_outweighs',
      description: '承认存在缺点，但优点更重要',
      appliesWhen: '优势材料明显多于/强于劣势材料',
      argumentRelation: 'concedes',
      layoutPattern: 'concession_then_support',
      bodyCount: 2,
    },
    {
      name: 'disadvantage_outweighs',
      description: '承认存在优点，但缺点影响更大',
      appliesWhen: '劣势材料明显多于/强于优势材料',
      argumentRelation: 'concedes',
      layoutPattern: 'concession_then_support',
      bodyCount: 2,
    },
    {
      name: 'different_stakeholders',
      description: '不同群体受不同影响（如政府 vs 普通人）',
      appliesWhen: '材料涉及多个利益相关方，影响方向不同',
      argumentRelation: 'side_by_side',
      layoutPattern: 'side_by_side',
      bodyCount: 2,
    },
    {
      name: 'different_situations',
      description: '不同环境/年龄段/时代下影响不同',
      appliesWhen: '材料在不同条件下表现差异明显',
      argumentRelation: 'side_by_side',
      layoutPattern: 'side_by_side',
      bodyCount: 2,
    },
  ],
  'Discuss Both Views': [
    {
      name: 'support_A',
      description: '完全支持 A 观点',
      appliesWhen: 'A 观点材料远超 B 观点',
      argumentRelation: 'supports',
      layoutPattern: 'support',
      bodyCount: 2,
    },
    {
      name: 'support_B',
      description: '完全支持 B 观点',
      appliesWhen: 'B 观点材料远超 A 观点',
      argumentRelation: 'supports',
      layoutPattern: 'support',
      bodyCount: 2,
    },
    {
      name: 'concession',
      description: '承认另一观点具有一定合理性，最终支持一方',
      appliesWhen: '双方都有合理材料但一方更优',
      argumentRelation: 'concedes',
      layoutPattern: 'concession_then_support',
      bodyCount: 2,
    },
    {
      name: 'different_situations',
      description: '两种观点分别适用于不同情况',
      appliesWhen: '材料显示不同场景适用不同观点',
      argumentRelation: 'side_by_side',
      layoutPattern: 'side_by_side',
      bodyCount: 2,
    },
  ],
  'Problem / Solution': [
    {
      name: 'problem_solution',
      description: '分析问题 → 提出解决方案',
      appliesWhen: '材料包含原因分析和解决措施',
      argumentRelation: 'solves',
      layoutPattern: 'problem_solution',
      bodyCount: 2,
    },
    {
      name: 'cause_effect',
      description: '分析原因 → 分析影响',
      appliesWhen: '材料重点是因果链条',
      argumentRelation: 'causal',
      layoutPattern: 'causal',
      bodyCount: 2,
    },
  ],
  'Two-part Question': [
    {
      name: 'parallel',
      description: '分别独立回答两个问题',
      appliesWhen: '两个问题独立不相关',
      argumentRelation: 'parallel',
      layoutPattern: 'parallel',
      bodyCount: 2,
    },
    {
      name: 'problem_solution',
      description: '第一问分析问题，第二问提出方案',
      appliesWhen: '两问呈问题→解决关系',
      argumentRelation: 'solves',
      layoutPattern: 'problem_solution',
      bodyCount: 2,
    },
    {
      name: 'cause_effect',
      description: '第一问分析原因，第二问分析影响',
      appliesWhen: '两问呈因果或解释关系',
      argumentRelation: 'causal',
      layoutPattern: 'causal',
      bodyCount: 2,
    },
  ],
  'Positive / Negative': [
    {
      name: 'different_situations',
      description: '在不同条件下分别讨论正面和负面影响',
      appliesWhen: '材料涵盖不同场景或群体',
      argumentRelation: 'side_by_side',
      layoutPattern: 'side_by_side',
      bodyCount: 2,
    },
    {
      name: 'cause_effect',
      description: '先分析现象原因，再对发展做积极/消极判定',
      appliesWhen: '题目包含 causes/why 且要求判定',
      argumentRelation: 'causal',
      layoutPattern: 'causal',
      bodyCount: 2,
    },
  ],
};

/** 兜底策略 — 所有未匹配题型的默认 */
export const FALLBACK_STRATEGIES: StrategyDef[] = [
  {
    name: 'side_by_side',
    description: '双方观点并列展开',
    appliesWhen: '通用兜底',
    argumentRelation: 'side_by_side',
    layoutPattern: 'side_by_side',
    bodyCount: 2,
  },
];

/**
 * 构建 Planner 的完整 LLM prompt
 */
export function buildPlannerPrompt(input: {
  question: string;
  questionType: string;
  requiresStance: boolean;
  materials: {
    aSide: string;
    bSide: string;
    stance: string;
  };
}): string {
  const strategies = STRATEGY_TABLE[input.questionType] || FALLBACK_STRATEGIES;

  const strategyBlock = strategies
    .map(
      (s) =>
        `- **${s.name}**：${s.description}（适用：${s.appliesWhen}）→ relation=${s.argumentRelation}, layout=${s.layoutPattern}, bodyCount=${s.bodyCount}`,
    )
    .join('\n');

  return `你是一个 IELTS Task 2 段落结构规划器。

【输入】
1. 题目：${input.question}
2. 题型：${input.questionType}
3. 是否需要明确立场：${input.requiresStance ? '是' : '否'}
4. 学生原材料：
   - A面论据：${input.materials.aSide || '（无）'}
   - B面论据：${input.materials.bSide || '（无）'}
   - 立场：${input.materials.stance || '（未明确）'}

【第1步：盘点原材料】
分析 A面 和 B面 的论据：
- 列出每个具体论点
- 判断每个论点的强度：强（有具体场景/机制支撑） / 弱（空泛提纲）
- 结论：材料天然偏向哪一侧？两侧都有实质内容还是明显失衡？

【第2步：选择论证策略】
可选策略（仅限以下，不可编造）：
${strategyBlock}

决策规则：
① 题型要求（${input.questionType}）
② 是否需要明确立场（${input.requiresStance ? '是' : '否'}）
③ 双方材料强弱
④ 观点之间的逻辑关系（支持/让步/并列/因果/问题→解决）
⑤ Body Count：2（默认）或 3（仅当 3+ 个可独立展开论点 或 Problem→Cause→Solution 或 Discuss Both Views+Personal Opinion）

输出 YAML：
\`\`\`yaml
stance: agree|disagree|balanced|not_required
argumentStrategy: ${strategies.map(s => s.name).join('|')}
argumentRelation: supports|concedes|side_by_side|causal|solves|parallel
layoutPattern: support|concession_then_support|side_by_side|problem_solution|causal|parallel
bodyCount: 2|3
\`\`\`

【第3步：分配材料到 Body】
- 每个 Body 的 role（concession / main_argument / problem / solution / view_A / view_B / evaluation）
- 每个 Body 的 structure（single_point / dual_point）
- 每个 Body 包含哪些具体 points
- 弱论点合并为 Supporting Points

输出 YAML：
\`\`\`yaml
bodies:
  - role: concession|main_argument|problem|solution|...
    structure: single_point|dual_point
    points:
      - 论点文本
    expansion: explanation|example|mechanism|impact|comparison|mixed
\`\`\`

【第4步：生成 paragraphPlan】
基于第3步的 YAML，生成完整的 paragraphPlan JSON。

要求：
- 所有 steps[].value 为空字符串 ""
- 所有 steps[].status 为空字符串 ""
- placeholder 要贴合具体材料内容（不是泛泛的"请写一个例子"）
- key 需要在整个 plan 内唯一
- mode 为 "single_point"（单点）或 "total_then_points"（总分型）或 "direct_points"（分点直写）

【输出格式】严格 JSON：
{
  "layoutPattern": "...",
  "rationale": "给系统的简短解释：为什么选这个策略和结构",
  "plannerIntermediate": {
    "stance": "...",
    "argumentStrategy": "...",
    "argumentRelation": "...",
    "layoutPattern": "...",
    "bodyCount": 2
  },
  "bodyPlans": [
    {
      "id": "body-1",
      "targetBody": "Body Paragraph 1",
      "role": "...",
      "paragraphDensity": "single_point",
      "argumentRelation": "...",
      "paragraphPlan": {
        "mode": "single_point",
        "diagnosis": "...",
        "pointBlocks": [
          {
            "id": "pb1",
            "label": "...",
            "subClaim": "...",
            "role": "major",
            "expansionStrategy": "...",
            "steps": [
              { "key": "pb1_s1", "label": "...", "placeholder": "...", "value": "", "status": "" }
            ]
          }
        ]
      }
    }
  ]
}`;
}
