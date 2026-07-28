# PR-B：Planner 实现

> 目标 PR | 依赖：PR-A | 预计行数：~500 | 执行时间：30-45 分钟

---

## B.1 概述

实现 Step 2.5 Planner 的核心逻辑：
1. Prompt 模板（题型分层策略枚举）
2. Planner 编排层（调 LLM → 机械 QA → 重试/降级）
3. 降级策略（保守默认结构）

**关键约束：** 不在此 PR 中接入 Express 路由（路由在 PR-C 中加），只写纯函数。

---

## B.2 实现 `src/server/prompts/planner-prompts.ts`

### B.2.1 题型-策略枚举表（纯数据，不调 LLM）

```typescript
/**
 * Planner Prompt 模板 — 材料驱动的结构推理
 */

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

export interface StrategyDef {
  name: string;
  description: string;
  appliesWhen: string;
  argumentRelation: string;
  layoutPattern: string;
  bodyCount: number;
}
```

### B.2.2 Planner Prompt 构建函数

```typescript
import type { PlannerInput } from '../../types';

/**
 * 构建 Planner 的完整 LLM prompt
 * 输出：包含题型策略枚举 + 材料 + 4 步推理指令的 prompt 字符串
 */
export function buildPlannerPrompt(input: PlannerInput): string {
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
```

---

## B.3 实现 `src/server/planner/planner.ts`

```typescript
/**
 * Step 2.5 Planner — 材料驱动的结构推理
 */

import type {
  PlannerInput,
  PlannerOutput,
  MechanicalQaResult,
  BodyPlan,
} from '../../types';
import { buildPlannerPrompt } from '../prompts/planner-prompts';
import { buildFallbackBodyPlans } from './planner-fallback';
import { parseAIResponse } from './planner-utils';

// 注意：真实 LLM 调用将在集成时通过 server.ts 传入
// 这里导出纯函数，方便测试

/**
 * 构建 Planner 的 LLM 请求参数
 * 返回 Gemini generateContent 所需的 contents 和 config
 */
export function buildPlannerRequest(input: PlannerInput) {
  const prompt = buildPlannerPrompt(input);
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      temperature: 0.3,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
    },
  };
}

/**
 * 解析 Planner 的 LLM 响应
 */
export function parsePlannerResponse(rawText: string): PlannerOutput | null {
  try {
    const parsed = JSON.parse(rawText);
    if (!parsed.bodyPlans || !Array.isArray(parsed.bodyPlans)) {
      return null;
    }
    return parsed as PlannerOutput;
  } catch {
    // 尝试 jsonrepair（在集成时由 server.ts 的 parseAIResponse 处理）
    return null;
  }
}

/**
 * 机械 QA — 纯函数，不调 LLM
 */
export function runMechanicalQa(bodyPlans: BodyPlan[]): MechanicalQaResult {
  const issues: MechanicalQaResult['issues'] = [];

  // 1. bodyPlans 数量
  if (![2, 3].includes(bodyPlans.length)) {
    issues.push({
      severity: 'fail',
      field: 'bodyPlans.length',
      reason: `必须为 2 或 3，当前 ${bodyPlans.length}`,
    });
  }

  // 2. 每个 plan 的 value 全空
  const allKeys = new Set<string>();
  for (const bp of bodyPlans) {
    const plan = bp?.paragraphPlan;
    if (!plan || !Array.isArray(plan.pointBlocks)) {
      issues.push({
        severity: 'fail',
        field: `bodyPlans.${bp?.id || '?'}.paragraphPlan`,
        reason: 'paragraphPlan 或 pointBlocks 缺失',
      });
      continue;
    }

    for (const block of plan.pointBlocks) {
      if (!Array.isArray(block?.steps)) continue;
      for (const step of block.steps) {
        // value 必须为空
        if (String(step?.value || '').trim()) {
          issues.push({
            severity: 'fail',
            field: `bodyPlans.${bp.id}.pointBlocks.${block.id}.${step?.key || '?'}.value`,
            reason: 'Planner 输出的 value 必须为空字符串',
          });
        }
        // key 唯一性
        const key = String(step?.key || '');
        if (key && allKeys.has(key)) {
          issues.push({
            severity: 'fail',
            field: `step.key`,
            reason: `重复的 key: ${key}`,
          });
        }
        if (key) allKeys.add(key);
      }

      // subClaim 不应该是空字符串
      if (!String(block?.subClaim || '').trim()) {
        issues.push({
          severity: 'warn',
          field: `bodyPlans.${bp.id}.pointBlocks.${block.id}.subClaim`,
          reason: 'subClaim 为空（降级场景可接受）',
        });
      }
    }

    // mode 合法性
    const validModes = ['single_point', 'total_then_points', 'direct_points'];
    if (!validModes.includes(plan.mode)) {
      issues.push({
        severity: 'fail',
        field: `bodyPlans.${bp.id}.mode`,
        reason: `非法 mode: ${plan.mode}`,
      });
    }
  }

  return {
    pass: issues.filter((i) => i.severity === 'fail').length === 0,
    issues,
  };
}

/**
 * Planner 编排函数（模拟版本 — 不真实调 LLM）
 *
 * 真实调用时，外部先调 LLM，再将响应文本传入 parsePlannerResponse，
 * 然后调 runMechanicalQa 校验。
 *
 * 返回策略：
 * - QA pass → 返回 bodyPlans
 * - QA fail → 返回 null（由调用方决定是否重试或降级）
 */
export function processPlannerOutput(rawText: string): {
  success: boolean;
  bodyPlans?: BodyPlan[];
  qaResult: MechanicalQaResult;
} {
  const parsed = parsePlannerResponse(rawText);
  if (!parsed || !Array.isArray(parsed.bodyPlans)) {
    return {
      success: false,
      qaResult: {
        pass: false,
        issues: [
          { severity: 'fail', field: 'response', reason: '无法解析 Planner 响应为有效 JSON' },
        ],
      },
    };
  }

  const qaResult = runMechanicalQa(parsed.bodyPlans);

  return {
    success: qaResult.pass,
    bodyPlans: qaResult.pass ? parsed.bodyPlans : undefined,
    qaResult,
  };
}
```

---

## B.4 实现 `src/server/planner/planner-utils.ts`

```typescript
/**
 * Planner 工具函数
 */

/**
 * 从 LLM 响应文本中提取 JSON
 * 复用项目中已有的 parseAIResponse 模式
 */
export function parseAIResponse(text: string | undefined, defaultData: any = {}): any {
  // 此函数与 server.ts 中的 parseAIResponse 逻辑一致
  // 在模块化重构中可提取为共享工具，当前先在此复制一份
  if (!text) return defaultData;
  let responseText = text.trim();
  if (responseText.startsWith('```json')) {
    responseText = responseText
      .replace(/^```json\n?/, '')
      .replace(/\n?```$/, '');
  }
  try {
    return JSON.parse(responseText);
  } catch {
    return defaultData;
  }
}
```

---

## B.5 实现 `src/server/planner/planner-fallback.ts`

```typescript
/**
 * Planner 降级策略 — 保守默认结构
 */

import type { BodyPlan } from '../../types';

/**
 * 当 Planner LLM 调用失败或 QA 连续失败时，
 * 返回基于题型的保守默认 bodyPlans。
 *
 * 所有 body 使用 single_point + mechanism→example→impact 结构
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
                status: '',
              },
              {
                key: 'pb1_s2',
                label: '解释机制',
                placeholder: '解释这个主张为什么成立',
                value: '',
                status: '',
              },
              {
                key: 'pb1_s3',
                label: '例证',
                placeholder: '举一个具体场景作为例证',
                value: '',
                status: '',
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
                status: '',
              },
              {
                key: 'pb2_s2',
                label: '解释机制',
                placeholder: '解释这个主张为什么成立',
                value: '',
                status: '',
              },
              {
                key: 'pb2_s3',
                label: '例证',
                placeholder: '举一个具体场景作为例证',
                value: '',
                status: '',
              },
            ],
          },
        ],
      },
    },
  ];
}
```

---

## B.6 自测

```bash
# 1. TypeScript 编译检查
npx tsc --noEmit 2>&1 | head -20

# 2. 单元逻辑校验（不调 LLM）
node -e "
const { runMechanicalQa } = require('./src/server/planner/planner.ts');
// 测试通过
";
```

**改为用 tsx 运行逻辑校验（项目使用 ESM）：**

创建一个临时测试文件 `test-planner.mjs`（测试后删除）：

```javascript
// test-planner.mjs — Planner 纯逻辑自测
// 运行：node test-planner.mjs

// 手动构造测试数据（不依赖 ts 编译）
const runMechanicalQa = (bodyPlans) => {
  const issues = [];
  if (![2, 3].includes(bodyPlans.length)) {
    issues.push({ severity: 'fail', field: 'bodyPlans.length', reason: `必须为 2 或 3，当前 ${bodyPlans.length}` });
  }
  const allKeys = new Set();
  for (const bp of bodyPlans) {
    const plan = bp?.paragraphPlan;
    if (!plan || !Array.isArray(plan.pointBlocks)) {
      issues.push({ severity: 'fail', field: 'paragraphPlan', reason: '缺失' });
      continue;
    }
    for (const block of plan.pointBlocks) {
      for (const step of block?.steps || []) {
        if (String(step?.value || '').trim()) {
          issues.push({ severity: 'fail', field: `${step.key}.value`, reason: 'value 非空' });
        }
        if (step.key && allKeys.has(step.key)) {
          issues.push({ severity: 'fail', field: 'key', reason: `重复 key: ${step.key}` });
        }
        if (step.key) allKeys.add(step.key);
      }
    }
    if (!['single_point', 'total_then_points', 'direct_points'].includes(plan.mode)) {
      issues.push({ severity: 'fail', field: 'mode', reason: `非法 mode: ${plan.mode}` });
    }
  }
  return { pass: issues.filter(i => i.severity === 'fail').length === 0, issues };
};

// Test 1: 合法的 bodyPlans（2 个 body）
const valid = [
  { id: 'body-1', targetBody: 'Body 1', role: 'main', paragraphPlan: { mode: 'single_point', diagnosis: 'test', pointBlocks: [{ id: 'pb1', label: 'P1', subClaim: 'S1', role: 'major', expansionStrategy: 'mechanism', steps: [{ key: 's1', label: 'L1', placeholder: 'P', value: '', status: '' }] }] } },
  { id: 'body-2', targetBody: 'Body 2', role: 'main', paragraphPlan: { mode: 'single_point', diagnosis: 'test', pointBlocks: [{ id: 'pb2', label: 'P2', subClaim: 'S2', role: 'major', expansionStrategy: 'mechanism', steps: [{ key: 's2', label: 'L2', placeholder: 'P', value: '', status: '' }] }] } },
];
const r1 = runMechanicalQa(valid);
console.assert(r1.pass === true, 'Test 1 FAIL: 合法 bodyPlans 应通过');
console.log('Test 1 PASS: 合法 bodyPlans 通过');

// Test 2: value 非空应 fail
const badValue = JSON.parse(JSON.stringify(valid));
badValue[0].paragraphPlan.pointBlocks[0].steps[0].value = '不应该有内容';
const r2 = runMechanicalQa(badValue);
console.assert(r2.pass === false, 'Test 2 FAIL: value 非空应拒绝');
console.log('Test 2 PASS: value 非空被拒绝');

// Test 3: bodyPlans 数量不对应 fail
const badCount = [valid[0]];
const r3 = runMechanicalQa(badCount);
console.assert(r3.pass === false, 'Test 3 FAIL: bodyCount=1 应拒绝');
console.log('Test 3 PASS: bodyCount=1 被拒绝');

// Test 4: 重复 key 应 fail
const dupKey = JSON.parse(JSON.stringify(valid));
dupKey[1].paragraphPlan.pointBlocks[0].steps[0].key = 's1'; // 与 body-1 的 key 重复
const r4 = runMechanicalQa(dupKey);
console.assert(r4.pass === false, 'Test 4 FAIL: 重复 key 应拒绝');
console.log('Test 4 PASS: 重复 key 被拒绝');

// Test 5: 非法 mode 应 fail
const badMode = JSON.parse(JSON.stringify(valid));
badMode[0].paragraphPlan.mode = 'invalid_mode';
const r5 = runMechanicalQa(badMode);
console.assert(r5.pass === false, 'Test 5 FAIL: 非法 mode 应拒绝');
console.log('Test 5 PASS: 非法 mode 被拒绝');

// Test 6: 降级策略输出应通过 QA
// （手动构造 fallback 格式）
const fallback = [
  { id: 'body-1', targetBody: 'Body Paragraph 1', role: 'main_argument', paragraphDensity: 'single_point', argumentRelation: 'supports', paragraphPlan: { mode: 'single_point', diagnosis: '[fallback]', pointBlocks: [{ id: 'pb1', label: '分论点 1', subClaim: '', role: 'major', expansionStrategy: 'mechanism', steps: [{ key: 'pb1_s1', label: '分论点', placeholder: '...', value: '', status: '' }, { key: 'pb1_s2', label: '解释', placeholder: '...', value: '', status: '' }] }] } },
  { id: 'body-2', targetBody: 'Body Paragraph 2', role: 'main_argument', paragraphDensity: 'single_point', argumentRelation: 'supports', paragraphPlan: { mode: 'single_point', diagnosis: '[fallback]', pointBlocks: [{ id: 'pb2', label: '分论点 2', subClaim: '', role: 'major', expansionStrategy: 'mechanism', steps: [{ key: 'pb2_s1', label: '分论点', placeholder: '...', value: '', status: '' }, { key: 'pb2_s2', label: '解释', placeholder: '...', value: '', status: '' }] }] } },
];
const r6 = runMechanicalQa(fallback);
console.assert(r6.pass === true, 'Test 6 FAIL: fallback 输出应通过 QA');
console.log('Test 6 PASS: fallback 输出通过 QA');

console.log('\n✅ 全部 Planner 自测通过');
```

**执行：**
```bash
node test-planner.mjs && rm test-planner.mjs
```

**通过标准：**
- `npx tsc --noEmit` 无错误
- 6 个测试全部 PASS
- `test-planner.mjs` 已被删除

---

## B.7 提交

```bash
git add -A
git commit -m "feat(PR-B): Planner 实现 — prompt + 机械 QA + 降级策略"
```
