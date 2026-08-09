/**
 * Planner Prompt 模板 — 材料驱动的结构推理
 */

export interface StrategyDef {
  name: string;
  description: string;
  appliesWhen: string;
  argumentRelation: string;
  layoutPattern: string;
  /**
   * @deprecated Segment count is decided dynamically from materials (retentionRole /
   * ready points). Kept optional for docs/compat; do NOT treat as a hard lock.
   */
  bodyCount?: number;
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
    aSide?: string;
    bSide?: string;
    stance: string;
    points?: Array<{
      id: string;
      claim: string;
      elaboration?: string;
      quality?: string;
      leanTags?: string[];
      retentionRole?: 'detail' | 'brief' | 'dropped' | string;
    }>;
    stanceMeta?: { polarity?: string; strength?: string };
    coverage?: {
      requiredBuckets?: string[];
      missingBuckets?: string[];
      filledBuckets?: string[];
    };
    /** Soft material digest for bodyCount judgment (not a hard lock). */
    materialDigest?: string;
  };
}): string {
  const strategies = STRATEGY_TABLE[input.questionType] || FALLBACK_STRATEGIES;

  // Strategy names decide relation/layout ONLY — never lock bodyCount.
  const strategyBlock = strategies
    .map(
      (s) =>
        `- **${s.name}**：${s.description}（适用：${s.appliesWhen}）→ relation=${s.argumentRelation}, layout=${s.layoutPattern}`,
    )
    .join('\n');

  const points = Array.isArray(input.materials.points) ? input.materials.points : [];
  const roleLabel = (r?: string) =>
    r === 'detail' ? '详写' : r === 'brief' ? '略写' : r === 'dropped' ? '放下' : '未标详略';
  const pointsBlock = points.length
    ? points
        .map(
          (p, i) =>
            `${i + 1}. id=${p.id} | quality=${p.quality || '?'} | retentionRole=${roleLabel(p.retentionRole)} | tags=${(p.leanTags || []).join(',') || 'general'}\n   claim: ${p.claim}\n   elaboration: ${p.elaboration || '（无）'}`,
        )
        .join('\n')
    : `（无结构化 points；兼容文本）\n- A侧：${input.materials.aSide || '（无）'}\n- B侧：${input.materials.bSide || '（无）'}`;

  const stanceMeta = input.materials.stanceMeta || {};
  const coverage = input.materials.coverage || {};
  const digest =
    String(input.materials.materialDigest || '').trim() ||
    '（无摘要：请直接根据上方 points 的 quality / retentionRole 判断）';

  return `你是一个 IELTS Task 2 段落结构规划器。

【输入】
1. 题目：${input.question}
2. 题型：${input.questionType}
3. 是否需要明确立场：${input.requiresStance ? '是' : '否'}
4. 立场：${input.materials.stance || '（未明确）'}（polarity=${stanceMeta.polarity || 'unknown'}, strength=${stanceMeta.strength || 'unknown'}）
5. 材料覆盖：required=${(coverage.requiredBuckets || []).join(',') || '无硬性双桶'}; filled=${(coverage.filledBuckets || []).join(',') || '无'}; missing=${(coverage.missingBuckets || []).join(',') || '无'}
6. 材料摘要（供 bodyCount 动态判断，非死公式）：
${digest}
7. 学生平行论点（Step2 plannerPayload.points — 尚未排段）：
${pointsBlock}

【第1步：盘点原材料】
按上面的 points 逐条盘点：
- 哪些是 ready（有场景/机制）/ thin；哪些是 详写(detail) / 略写(brief) / 放下(dropped)
- 标签桶是否满足题型硬性要求
- Agree/Disagree 且 strength=full：允许双主段 thematic_split，不必强行让步段
- Discuss Both / 利弊：两侧桶都必须落入不同 Body

【第2步：选择论证策略】
可选策略（仅限以下，不可编造；策略名只决定段间关系，不决定段数）：
${strategyBlock}

决策规则：
① 题型要求（${input.questionType}）
② 是否需要明确立场（${input.requiresStance ? '是' : '否'}）+ polarity/strength
③ points 强弱、retentionRole（详写/略写）、标签桶
④ 观点之间的逻辑关系（支持/让步/并列/因果/问题→解决）
⑤ Body Count（必须动态判断 2 或 3，禁止因策略名而默认永远 2）：
   - 先看「详写 + ready」能否各自支撑一段；再看略写是否必须单独成段
   - 详写优先各自成 Body；略写默认合并进主题最近的详写 Body（作 supporting / dual_point），不要仅为略写硬开第三段
   - 仅当存在 ≥3 条互不从属、均可独立展开的主线（多为 3 条详写，或 Problem→Cause→Solution / Discuss Both+个人立场需要三段）时选 bodyCount=3
   - 2 详写 + 1 略写 → 通常 bodyCount=2（略写并进相关段）
   - 未标详略时：按 ready 点是否主题独立推断，并在 rationale 注明「未标详略，按可写点推断」
   - FORBIDDEN：只因为策略是 concession / partial_agreement 就固定 bodyCount=2
   - 在 rationale 用中文说明为何选 2 或 3（引用 point id 与详略）

输出 YAML：
\`\`\`yaml
stance: agree|disagree|balanced|not_required
argumentStrategy: ${strategies.map(s => s.name).join('|')}
argumentRelation: supports|concedes|side_by_side|causal|solves|parallel
layoutPattern: support|concession_then_support|side_by_side|problem_solution|causal|parallel
bodyCount: 2|3   # 按上方材料动态填写，勿套死值
\`\`\`

【第3步：分配材料到 Body】
- 每个 Body 的 role（concession / main_argument / problem / solution / view_A / view_B / evaluation）
- 每个 Body 的 structure（single_point / dual_point）
- 每个 Body 必须给出 mappedPointIds（引用上面的 point id）；禁止编造无来源新论点
- subClaim 规则（论点句 → 论证过程；论证过程可多步）：
  - 仅当 mapped claim 已是完整主张句时，才写入 subClaim（完整句）
  - 若 mapped claim 只是主题词/维度头（如「环境保护」「人际关系」），把词放进 pointBlock.label 或 body theme，subClaim 留空——Step3 会先让学生确认论点句
  - FORBIDDEN：把主题词当成 subClaim 假装论点已完成
- 详写点优先独占 Body；略写点合并为 Supporting Points / 同一 Body 的次要 pointBlock（dual_point）
- dropped 点不要映射进 Body
- 详略与 pointBlock.role：
  - 详写主线 → pointBlock.role = "major"
  - 并入的略写点 → pointBlock.role = "minor"（supporting）

输出 YAML：
\`\`\`yaml
bodies:
  - role: concession|main_argument|problem|solution|...
    structure: single_point|dual_point
    mappedPointIds: [p1]
    points:
      - 论点文本
    expansion: explanation|example|mechanism|impact|comparison|mixed
\`\`\`

【第4步：生成 paragraphPlan】
基于第3步的 YAML，生成完整的 paragraphPlan JSON。

要求：
- 所有 steps[].value 为空字符串 ""
- 所有 steps[].status 为空字符串 ""
- placeholder 要贴合具体材料内容（不是泛泛的"请写一个例子"）；可提示材料里的多层因果（如研发→减污→生活质量），供 Step3 展开
- key 需要在整个 plan 内唯一
- mode 为 "single_point"（单点）或 "total_then_points"（总分型）或 "direct_points"（分点直写；dual_point 常用）
- 每个 pointBlock.subClaim：仅完整主张句；主题词只进 label，subClaim 用 ""
- diagnosis / rationale / label / placeholder / subClaim 一律使用中文（禁止英文论述）
- CRITICAL — 详写 / 略写步数（按 role，不是按整段句数偷懒）：
  - role=major（详写主线）：steps 建议 ≥4 —— 第1步必须是分论点/核心观点；其后至少 3 个展开槽（按 expansion 选标签，例如：展开原因 / 机制或过程 / 结果或场景 / 影响）。FORBIDDEN：major 只有「论点 + 一句机制」两步就收工。
  - role=minor（略写/supporting）：steps 1～2 即可（补充点 ± 一句带过）。
  - dual_point：major 用厚链，minor 用短链；不要为了给 minor 腾位置而把 major 压成 2 步。
  - 标签贴合材料与 expansionStrategy，不必套死英文模板名；但 major 的展开槽数量要够用。

【输出格式】严格 JSON：
{
  "layoutPattern": "...",
  "rationale": "中文说明：为何选该策略，以及为何 bodyCount=2 或 3（引用 point id / 详略）",
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
      "paragraphDensity": "dual_point",
      "argumentRelation": "...",
      "mappedPointIds": ["p1", "p3"],
      "paragraphPlan": {
        "mode": "direct_points",
        "diagnosis": "中文诊断：详写主线 + 略写并入...",
        "pointBlocks": [
          {
            "id": "pb1",
            "label": "详写主题词或短标签",
            "subClaim": "",
            "role": "major",
            "expansionStrategy": "mechanism",
            "steps": [
              { "key": "pb1_s1", "label": "分论点", "placeholder": "本段完整主张句", "value": "", "status": "" },
              { "key": "pb1_s2", "label": "展开原因", "placeholder": "贴材料：为何成立", "value": "", "status": "" },
              { "key": "pb1_s3", "label": "机制/过程", "placeholder": "贴材料：可含多层紧密因果", "value": "", "status": "" },
              { "key": "pb1_s4", "label": "结果/影响", "placeholder": "贴材料：对幸福感/生活的结果", "value": "", "status": "" }
            ]
          },
          {
            "id": "pb1b",
            "label": "略写补充标签",
            "subClaim": "",
            "role": "minor",
            "expansionStrategy": "explanation",
            "steps": [
              { "key": "pb1b_s1", "label": "补充点", "placeholder": "一两句带过略写点", "value": "", "status": "" }
            ]
          }
        ]
      }
    }
  ]
}
（bodyPlans 数组长度必须等于你选定的 bodyCount，可为 2 或 3）`;
}
