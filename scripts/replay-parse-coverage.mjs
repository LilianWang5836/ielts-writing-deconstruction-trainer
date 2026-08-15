/**
 * Replay: userPoints parsing (paren-aware split / balanced-group parse /
 * cross-slot scrub) + planner point-coverage guard (unmapped point → warn or
 * fail, normalize auto-appends a block, theme realigned to major block).
 *
 * Run: node --import tsx/esm scripts/replay-parse-coverage.mjs
 */
import assert from 'node:assert/strict';
import {
  parseClaimElaboration,
  scrubCrossSlotContamination,
  splitClaimChunks,
  splitOutsideParens,
} from '../src/server/step2/planner-payload.ts';
import {
  detectPointCoverageIssues,
  normalizePlannerBodyPlans,
  runMechanicalQa,
} from '../src/server/planner/planner.ts';
import { ensureParagraphPlanCoversFrameworkPoints } from '../src/utils/step3Quality.ts';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// =====================================================================
console.log('\n[1] splitOutsideParens / splitClaimChunks');
// =====================================================================

{
  const packed =
    '文化多样性（评价）（待加深）；强势文化冲击（原因）；网络普及（原因）；全球消费主义（原因）';
  const segs = splitOutsideParens(packed);
  assert.deepEqual(segs, [
    '文化多样性（评价）（待加深）',
    '强势文化冲击（原因）',
    '网络普及（原因）',
    '全球消费主义（原因）',
  ]);
  ok('outer ； splits packed line into 4 segments');
}

{
  const segs = splitOutsideParens('强势文化冲击（例子：圣诞节；黑五促销）');
  assert.deepEqual(segs, ['强势文化冲击（例子：圣诞节；黑五促销）']);
  ok('paren-inner ； is NOT split');
}

{
  // Incident shape: numbered list where one line packs the whole board
  const numbered =
    '1. 强势文化冲击（原因）（比如圣诞节促销）\n5. 文化多样性（评价）（待加深）；强势文化冲击（原因）；网络普及（原因）；全球消费主义（原因）';
  const chunks = splitClaimChunks(numbered);
  assert.ok(
    chunks.includes('文化多样性（评价）（待加深）'),
    `文化多样性 must be its own chunk, got: ${JSON.stringify(chunks)}`,
  );
  assert.ok(
    chunks.some((c) => c.startsWith('网络普及')),
    '网络普及 must be its own chunk',
  );
  assert.ok(
    chunks.every((c) => !c.includes('；')),
    'no chunk may still contain an outer ；-packed blob',
  );
  ok('numbered chunk re-splits at outer ；');
}

// =====================================================================
console.log('\n[2] parseClaimElaboration balanced groups');
// =====================================================================

{
  const r = parseClaimElaboration('文化多样性（评价）（待加深）');
  assert.equal(r.claim, '文化多样性');
  assert.equal(r.elaboration, '');
  ok('role + placeholder groups → empty elaboration (no swallow)');
}

{
  // Old regex swallowed from first （ to last ）across siblings
  const r = parseClaimElaboration(
    '文化多样性（评价）（待加深）；强势文化冲击（原因）',
  );
  assert.equal(r.claim, '文化多样性');
  assert.ok(
    !r.elaboration.includes('强势文化冲击'),
    `elaboration must not swallow sibling claims, got: ${r.elaboration}`,
  );
  ok('sibling claim never swallowed into elaboration');
}

{
  const r = parseClaimElaboration('强势文化冲击（原因）（比如圣诞节促销）');
  assert.equal(r.claim, '强势文化冲击');
  assert.equal(r.elaboration, '比如圣诞节促销');
  ok('role group skipped, content group kept');
}

{
  const r = parseClaimElaboration('环境保护（投入（图书馆）等公共设施）');
  assert.equal(r.claim, '环境保护');
  assert.equal(r.elaboration, '投入（图书馆）等公共设施');
  ok('nested parens stay balanced');
}

{
  const r = parseClaimElaboration('强势文化冲击（外来文化新潮）：年轻人偏爱外来节日');
  assert.equal(r.claim, '强势文化冲击');
  assert.ok(r.elaboration.includes('外来文化新潮'));
  assert.ok(r.elaboration.includes('年轻人偏爱外来节日'));
  ok('tail after groups folds into same claim');
}

// =====================================================================
console.log('\n[3] scrubCrossSlotContamination');
// =====================================================================

const HEADS = ['文化多样性', '强势文化冲击', '网络普及', '全球消费主义'];

{
  const out = scrubCrossSlotContamination(
    '待加深）；强势文化冲击（原因）；网络普及（原因）；全球消费主义（原因）',
    '文化多样性',
    HEADS,
  );
  assert.equal(out, '', `legacy dirty blob must be fully scrubbed, got: ${out}`);
  ok('legacy contaminated blob → scrubbed to empty');
}

{
  const out = scrubCrossSlotContamination(
    '多样性变小；个体认同削弱',
    '文化多样性',
    HEADS,
  );
  assert.equal(out, '多样性变小；个体认同削弱');
  ok('clean content untouched');
}

{
  const out = scrubCrossSlotContamination(
    '与网络普及相互加强，形成合力',
    '强势文化冲击',
    HEADS,
  );
  assert.equal(out, '与网络普及相互加强，形成合力');
  ok('mere mention of another dimension inside content kept');
}

// =====================================================================
console.log('\n[4] planner coverage guard (B1/B2/B4)');
// =====================================================================

const mkStep = (key, label) => ({ key, label, placeholder: '…', value: '' });
const mkBlock = (id, label, role) => ({
  id,
  label,
  subClaim: '',
  role,
  expansionStrategy: role === 'major' ? 'mechanism' : 'explanation',
  steps: [mkStep(`${id}_s1`, '分论点'), mkStep(`${id}_s2`, '展开')],
});

const mkPayload = () => ({
  points: [
    {
      id: 'p1',
      claim: '强势文化冲击（原因）',
      elaboration: '外来文化被视为新潮，圣诞节流行',
      quality: 'ready',
      retentionRole: 'detail',
      leanTags: ['part_1'],
    },
    {
      id: 'p2',
      claim: '网络普及（原因）',
      elaboration: '信息传播速度快规模大，传统文化被淹没',
      quality: 'ready',
      retentionRole: 'brief',
      leanTags: ['part_1'],
    },
    {
      id: 'p3',
      claim: '全球消费主义（原因）',
      elaboration: '品牌推广重塑习惯',
      quality: 'ready',
      retentionRole: 'brief',
      leanTags: ['part_1'],
    },
    {
      id: 'p5',
      claim: '文化多样性（评价）',
      elaboration: '多样性变小，认同削弱',
      quality: 'ready',
      retentionRole: 'detail',
      leanTags: ['part_2'],
    },
  ],
  redirects: {},
});

// Incident shape: body-1 maps p1+p3 (forgot p2), stale theme says 网络普及
const mkIncidentPlans = () => [
  {
    id: 'body-1',
    targetBody: 'Body Paragraph 1',
    theme: '网络普及（原因）',
    mappedPointIds: ['p1', 'p3'],
    paragraphPlan: {
      mode: 'direct_points',
      diagnosis: 'test',
      pointBlocks: [
        mkBlock('pb1', '强势文化冲击（原因）', 'major'),
        mkBlock('pb2', '全球消费主义（原因）', 'minor'),
      ],
    },
  },
  {
    id: 'body-2',
    targetBody: 'Body Paragraph 2',
    theme: '文化多样性（评价）',
    mappedPointIds: ['p5'],
    paragraphPlan: {
      mode: 'single_point',
      diagnosis: 'test',
      pointBlocks: [mkBlock('pb3', '文化多样性（评价）', 'major')],
    },
  },
];

{
  const issues = detectPointCoverageIssues(mkIncidentPlans(), mkPayload());
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'warn');
  assert.ok(issues[0].reason.includes('p2'));
  ok('unmapped brief point → warn');
}

{
  const qa = runMechanicalQa(mkIncidentPlans(), mkPayload());
  assert.equal(qa.pass, true, 'missing brief must not fail QA');
  assert.ok(qa.issues.some((i) => i.severity === 'warn' && i.reason.includes('p2')));
  ok('QA passes with warn for missing brief');
}

{
  // Missing DETAIL point → hard fail
  const plans = mkIncidentPlans().slice(0, 1); // drop body-2 (p5 detail)
  const qa = runMechanicalQa(plans, mkPayload());
  assert.equal(qa.pass, false, 'missing detail point must fail QA');
  assert.ok(
    qa.issues.some((i) => i.severity === 'fail' && i.reason.includes('p5')),
  );
  ok('unmapped detail point → fail');
}

{
  const plans = normalizePlannerBodyPlans(mkIncidentPlans(), mkPayload());
  const body1 = plans.find((bp) => (bp.mappedPointIds || []).includes('p1'));
  assert.ok(body1, 'body holding p1 must exist');
  // B2: p2 got a synthesized minor block on the same-side detail body
  assert.ok(
    (body1.mappedPointIds || []).map(String).includes('p2'),
    `p2 must be mapped after normalize, got ${JSON.stringify(body1.mappedPointIds)}`,
  );
  const autoBlock = body1.paragraphPlan.pointBlocks.find((b) =>
    String(b.label || '').startsWith('网络普及'),
  );
  assert.ok(autoBlock, 'synthesized block for 网络普及 must exist');
  assert.equal(autoBlock.role, 'minor');
  // B4: stale theme（网络普及）realigned to the major block's label
  assert.ok(
    String(body1.theme || '').startsWith('强势文化冲击'),
    `theme must match major block, got: ${body1.theme}`,
  );
  // Coverage now complete
  const issues = detectPointCoverageIssues(plans, mkPayload());
  assert.equal(issues.length, 0, 'no coverage issues after normalize');
  ok('normalize appends p2 block + realigns theme');
}

{
  // Already-covered plan: normalize must not duplicate blocks
  const plans = normalizePlannerBodyPlans(
    normalizePlannerBodyPlans(mkIncidentPlans(), mkPayload()),
    mkPayload(),
  );
  const body1 = plans.find((bp) => (bp.mappedPointIds || []).includes('p1'));
  const autoBlocks = body1.paragraphPlan.pointBlocks.filter((b) =>
    String(b.label || '').startsWith('网络普及'),
  );
  assert.equal(autoBlocks.length, 1, 'no duplicate synthesized blocks');
  ok('normalize is idempotent for coverage fix');
}

// =====================================================================
console.log('\n[4] Step3 kickoff plan framework coverage');
// =====================================================================

const mkSubpoint = () => ({
  id: 'body1',
  points: ['强势文化冲击（原因）', '网络普及（原因）'],
  pointRoles: [
    { point: '强势文化冲击（原因）', role: 'detail' },
    { point: '网络普及（原因）', role: 'brief' },
  ],
});

const mkPlanMissingBrief = () => ({
  totalClaim: '文化趋同的成因',
  pointBlocks: [
    {
      id: 'b1',
      label: '强势文化冲击',
      role: 'major',
      steps: [{ key: 'b1_s1', label: '分论点', value: '' }],
    },
  ],
});

{
  // Incident shape: coach plan narrates only the detail point; the mapped
  // brief point（网络普及）got no block → guard appends a minor block.
  const plan = mkPlanMissingBrief();
  const appended = ensureParagraphPlanCoversFrameworkPoints(plan, mkSubpoint());
  assert.deepEqual(appended, ['网络普及']);
  assert.equal(plan.pointBlocks.length, 2);
  const auto = plan.pointBlocks[1];
  assert.equal(auto.role, 'minor');
  assert.ok(String(auto.label).startsWith('网络普及'));
  assert.equal(auto.steps.length, 1);
  ok('missing brief point gets a minor block appended');
}

{
  // Missing detail point → major block with the 3-step scaffold
  const plan = {
    pointBlocks: [
      {
        id: 'b1',
        label: '网络普及',
        role: 'minor',
        steps: [{ key: 'b1_s1', label: '补充点', value: '' }],
      },
    ],
  };
  const appended = ensureParagraphPlanCoversFrameworkPoints(plan, mkSubpoint());
  assert.deepEqual(appended, ['强势文化冲击']);
  const auto = plan.pointBlocks[1];
  assert.equal(auto.role, 'major');
  assert.equal(auto.steps.length, 3);
  ok('missing detail point gets a major block appended');
}

{
  // Fuzzy label already represents the point（label ⊃ claim core）→ no append
  const plan = {
    pointBlocks: [
      { id: 'b1', label: '强势文化冲击下的节日趋同', role: 'major', steps: [] },
      { id: 'b2', label: '网络普及的推波助澜', role: 'minor', steps: [] },
    ],
  };
  const appended = ensureParagraphPlanCoversFrameworkPoints(plan, mkSubpoint());
  assert.deepEqual(appended, []);
  assert.equal(plan.pointBlocks.length, 2);
  ok('fuzzy-matched labels count as covered, no duplicates');
}

{
  // Dropped-role point must NOT be appended
  const sp = {
    id: 'body1',
    points: ['强势文化冲击（原因）', '全球消费主义（原因）'],
    pointRoles: [
      { point: '强势文化冲击（原因）', role: 'detail' },
      { point: '全球消费主义（原因）', role: 'dropped' },
    ],
  };
  const plan = mkPlanMissingBrief();
  const appended = ensureParagraphPlanCoversFrameworkPoints(plan, sp);
  assert.deepEqual(appended, []);
  ok('dropped points are not resurrected');
}

{
  // Flat mode (no pointBlocks) and empty framework → no-op
  assert.deepEqual(
    ensureParagraphPlanCoversFrameworkPoints({ steps: [] }, mkSubpoint()),
    [],
  );
  assert.deepEqual(
    ensureParagraphPlanCoversFrameworkPoints(mkPlanMissingBrief(), {
      id: 'x',
      points: [],
    }),
    [],
  );
  ok('flat plans and empty frameworks are untouched');
}

console.log(`\nAll ${passed} checks passed.`);
