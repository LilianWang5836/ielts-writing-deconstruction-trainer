/**
 * E2E（多题型）：Step2(结构化) → Planner(DeepSeek) → Step3 kickoff。
 * 覆盖 3 种 IELTS Task 2 题型：
 *   1. Agree / Disagree（在线学习）
 *   2. Discuss both views（AI 与就业）
 *   3. Problem / Solution（高糖食品）
 * 每种题型：真实 planner 出 bodyPlans → 模拟客户端建 Step3 subpoints
 * （isClaimSentence 过滤）→ Step3 kickoff → 断言 paragraphPlan 存在且
 * active body 的 mapped points 被覆盖（① 守卫），以及 chat 无内部术语。
 * 并驱动一段迷你多轮对话，按题型存档到 docs/recorded-session-<题型>-<时间戳>.txt
 * （与 replay-full-journey 同路径，便于回看各题型真实教练交互）。
 *
 * Run（需本地服务 + LLM=DeepSeek）: npx tsx scripts/replay-typen-e2e.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.PROBE_BASE_URL || 'http://localhost:3000';

// ---- 存档：docs/recorded-session-<题型>-<时间戳>.txt ----
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.join(scriptDir, '..', 'docs');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
function archiveTranscript(slug, lines) {
  fs.mkdirSync(docsDir, { recursive: true });
  const file = path.join(docsDir, `recorded-session-${slug}-${stamp}.txt`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function splitCoachText(text = '') {
  const parts = String(text).split(/\n\s*---\s*\n/);
  return {
    p1: String(parts[0] || '').trim(),
    p2: parts.length > 1 ? parts.slice(1).join('---').trim() : '',
  };
}

// 主题无关的迷你模拟学生：用 active body 自己的 mapped point 作答（各题型素材自洽）。
function studentReplyFor(p2, sp) {
  const firstPoint =
    Array.isArray(sp.points) && sp.points.length
      ? sp.points[0]
      : String(sp.content || '线上学习具有灵活性优势。');
  if (/确认|对吗|可以吗|对不对|请点击.*确认|写入看板/.test(String(p2 || ''))) {
    return '对';
  }
  return firstPoint;
}

async function postCoach(body) {
  const res = await fetch(`${BASE}/api/coach/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`HTTP ${res.status}: ${data.error || 'unknown error'}`);
  }
  return data;
}

async function runPlanner(session) {
  const res = await fetch(`${BASE}/api/planner/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, question: session.topic.question }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Planner HTTP ${res.status}: ${data.error || 'unknown error'}`);
  }
  return data;
}

const FORBIDDEN_JARGON = [
  'paragraphPlan', 'pointBlock', 'step3SubpointSteps', 'expansionStrategy',
  'progressUpdate', 'direct_points', 'single_point', 'total_then_points',
  'explore_A', 'explore_B', 'currentStage', 'mappedPointId',
];
function chatJargonHits(text = '') {
  const lower = String(text).toLowerCase();
  return FORBIDDEN_JARGON.filter((t) => lower.includes(t.toLowerCase()));
}

// ---- 每种题型的 Step2 已完成 session ----
function makeAgreeDisagreeSession() {
  const QUESTION =
    'Some people believe that online learning is highly beneficial and should replace traditional classroom education entirely. To what extent do you agree or disagree?';
  return {
    topic: { question: QUESTION, questionType: 'Agree / Disagree' },
    currentStep: 2,
    step1: {
      isCompleted: true,
      coachEvaluation: {
        correctType: 'Agree / Disagree',
        coreIssue: '线上教育是否应完全替代线下课堂',
        constraints: ['entirely', 'replace'],
        critique: 'ok',
        score: 7,
        suggestedDimensions: [
          '线上灵活性与资源可及性 (打破地理限制，时间自由)',
          '线下不可替代性 (面对面互动，教师即时监督与纪律管理)',
        ],
        dimensionsSufficient: true,
        exitOffered: true,
      },
    },
    step2: {
      isCompleted: true,
      currentStage: 'summary',
      userStance: '线上不应完全取代线下，但可作为补充',
      userPoints:
        'A面：线上灵活性与资源可及性（已选详写）；B面：线下课堂对低龄学生的监督作用（已选详写）',
      coachEvaluation: {
        currentStage: 'summary',
        userStance: '线上不应完全取代线下，但可作为补充',
        userPoints:
          'A面：线上灵活性与资源可及性（已选详写）；B面：线下课堂对低龄学生的监督作用（已选详写）',
        critique: 'ok',
        suggestions: [],
        suggestedStance: '线上不应完全取代线下，但可作为补充',
        suggestedPoints: '',
        requiresStance: true,
        plannerPayload: {
          version: 1,
          status: 'ready',
          updatedAt: new Date().toISOString(),
          questionType: 'Agree / Disagree',
          requiresStance: true,
          redirects: {},
          stance: { text: '线上不应完全取代线下，但可作为补充', polarity: 'partial', strength: 'qualified' },
          points: [
            {
              id: 'p_online',
              claim: '线上灵活性与资源可及性（打破地理限制，时间自由）',
              elaboration: '在职人员可以克服时间与空间障碍，灵活安排学习。',
              retentionRole: 'detail',
              quality: 'ready',
              leanTags: ['support_main'],
              seedOnly: false,
            },
            {
              id: 'p_offline',
              claim: '线下课堂对低龄学生有监督与纪律管理优势',
              elaboration: '低龄学生自律性差，学校老师监督能提高学习效率。',
              retentionRole: 'detail',
              quality: 'ready',
              leanTags: ['oppose_or_qualify'],
              seedOnly: false,
            },
            {
              id: 'p_network',
              claim: '网络普及（原因）',
              elaboration: '网络普及使线上学习更容易被接受。',
              retentionRole: 'brief',
              quality: 'ready',
              leanTags: ['support_main'],
              seedOnly: false,
            },
          ],
          coverage: {
            passed: true,
            requiredBuckets: ['support_main', 'oppose_or_qualify'],
            filledBuckets: ['support_main', 'oppose_or_qualify'],
            missingBuckets: [],
            softMissingBuckets: [],
          },
          exitGate: { canComplete: true, canForceExit: false, forceExitUsed: false },
        },
      },
    },
    step3: { isCompleted: false, subpoints: [], activeSubpointId: '', chatHistory: [] },
  };
}

function makeDiscussBothViewsSession() {
  const QUESTION =
    'With the rapid development of Artificial Intelligence (AI), some think it will bring more benefits to workers, while others fear it will cause widespread unemployment. Discuss both views and give your opinion.';
  return {
    topic: { question: QUESTION, questionType: 'Discussion' },
    currentStep: 2,
    step1: {
      isCompleted: true,
      coachEvaluation: {
        correctType: 'Discussion',
        coreIssue: 'AI 对工人是利大于弊还是导致失业',
        constraints: ['both views', 'opinion'],
        critique: 'ok',
        score: 7,
        suggestedDimensions: [
          'AI 提升生产力与创造新型岗位',
          'AI 取代重复性岗位导致失业',
        ],
        dimensionsSufficient: true,
        exitOffered: true,
      },
    },
    step2: {
      isCompleted: true,
      currentStage: 'summary',
      userStance: 'AI 利大于弊，但需配套再培训',
      userPoints:
        'A面：AI 创造新型高价值岗位（已选详写）；B面：AI 导致部分重复岗位失业（已选略写）',
      coachEvaluation: {
        currentStage: 'summary',
        userStance: 'AI 利大于弊，但需配套再培训',
        userPoints:
          'A面：AI 创造新型高价值岗位（已选详写）；B面：AI 导致部分重复岗位失业（已选略写）',
        critique: 'ok',
        suggestions: [],
        suggestedStance: 'AI 利大于弊，但需配套再培训',
        suggestedPoints: '',
        requiresStance: true,
        plannerPayload: {
          version: 1,
          status: 'ready',
          updatedAt: new Date().toISOString(),
          questionType: 'Discussion',
          requiresStance: true,
          redirects: {},
          stance: { text: 'AI 利大于弊，但需配套再培训', polarity: 'agree', strength: 'balanced' },
          points: [
            {
              id: 'p_ai_benefit',
              claim: 'AI 提升生产力并催生新型高价值岗位',
              elaboration: 'AI 接管重复劳动后，工人转向创意与协作型工作。',
              retentionRole: 'detail',
              quality: 'ready',
              leanTags: ['support_main'],
              seedOnly: false,
            },
            {
              id: 'p_ai_jobloss',
              claim: 'AI 会取代大量重复性岗位导致短期失业',
              elaboration: '制造业与客服等标准化岗位首当其冲。',
              retentionRole: 'detail',
              quality: 'ready',
              leanTags: ['oppose_or_qualify'],
              seedOnly: false,
            },
          ],
          coverage: {
            passed: true,
            requiredBuckets: ['support_main', 'oppose_or_qualify'],
            filledBuckets: ['support_main', 'oppose_or_qualify'],
            missingBuckets: [],
            softMissingBuckets: [],
          },
          exitGate: { canComplete: true, canForceExit: false, forceExitUsed: false },
        },
      },
    },
    step3: { isCompleted: false, subpoints: [], activeSubpointId: '', chatHistory: [] },
  };
}

function makeProblemSolutionSession() {
  const QUESTION =
    'The increasing consumption of sugar-rich foods and drinks is leading to serious health problems worldwide. What are the causes of this issue, and what solutions can be implemented to solve it?';
  return {
    topic: { question: QUESTION, questionType: 'Problem/Solution' },
    currentStep: 2,
    step1: {
      isCompleted: true,
      coachEvaluation: {
        correctType: 'Problem/Solution',
        coreIssue: '高糖食品消费的原因与解决措施',
        constraints: ['causes', 'solutions'],
        critique: 'ok',
        score: 7,
        suggestedDimensions: [
          '高糖饮食的原因（便利食品/广告）',
          '缓解措施（糖税/营养标签/教育）',
        ],
        dimensionsSufficient: true,
        exitOffered: true,
      },
    },
    step2: {
      isCompleted: true,
      currentStage: 'summary',
      userStance: '',
      userPoints:
        'A面：高糖食品过量导致肥胖与糖尿病（已选详写）；B面：应通过糖税与营养标签缓解（已选详写）',
      coachEvaluation: {
        currentStage: 'summary',
        userStance: '',
        userPoints:
          'A面：高糖食品过量导致肥胖与糖尿病（已选详写）；B面：应通过糖税与营养标签缓解（已选详写）',
        critique: 'ok',
        suggestions: [],
        suggestedStance: '',
        suggestedPoints: '',
        requiresStance: false,
        plannerPayload: {
          version: 1,
          status: 'ready',
          updatedAt: new Date().toISOString(),
          questionType: 'Problem/Solution',
          requiresStance: false,
          redirects: {},
          stance: { text: '', polarity: 'unknown', strength: 'neutral' },
          points: [
            {
              id: 'p_cause',
              claim: '高糖食品消费过量导致肥胖和糖尿病激增',
              elaboration: '便利食品与含糖饮料普及，缺乏营养意识。',
              retentionRole: 'detail',
              quality: 'ready',
              leanTags: ['support_main'],
              seedOnly: false,
            },
            {
              id: 'p_solution',
              claim: '应通过征收糖税和强制营养标签来缓解',
              elaboration: '提高含糖产品成本并让消费者知情。',
              retentionRole: 'detail',
              quality: 'ready',
              leanTags: ['oppose_or_qualify'],
              seedOnly: false,
            },
          ],
          coverage: {
            passed: true,
            requiredBuckets: ['support_main', 'oppose_or_qualify'],
            filledBuckets: ['support_main', 'oppose_or_qualify'],
            missingBuckets: [],
            softMissingBuckets: [],
          },
          exitGate: { canComplete: true, canForceExit: false, forceExitUsed: false },
        },
      },
    },
    step3: { isCompleted: false, subpoints: [], activeSubpointId: '', chatHistory: [] },
  };
}

// ---- 模拟 Step3Drafting：bodyPlans → subpoints（isClaimSentence 过滤）----
function isClaimSentenceLike(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  if (s.length < 8) return false;
  if (s.length >= 14) return true;
  return /(是|能|可以|会|应该|必须|通过|因为|所以|导致|使得|提升|降低|改善|减少|带来|造成|有助于|无法|不能)/.test(s);
}
function buildStep3FromBodyPlans(bodyPlans) {
  const subpoints = bodyPlans.map((bp) => {
    const mapped = Array.isArray(bp.mappedPoints) ? bp.mappedPoints : [];
    const points = mapped.filter(isClaimSentenceLike);
    return {
      id: bp.id,
      content: bp.paragraphPlan?.pointBlocks?.[0]?.subClaim || bp.theme || bp.targetBody,
      points,
      pointRoles: bp.pointRoles,
      targetBody: bp.targetBody,
      theme: bp.theme || bp.role,
      paragraphPlan: bp.paragraphPlan,
      frameworkSignature: `${bp.id}-${bp.argumentRelation || ''}`,
      isCompleted: false,
      chatHistory: [],
    };
  });
  return {
    subpoints,
    activeSubpointId: subpoints[0]?.id || '',
    chatHistory: [],
  };
}

// ---- 单题型跑一遍：planner → Step3 kickoff ----
async function runQuestionType(cfg) {
  console.log(`\n========== 题型: ${cfg.name} ==========`);
  const session = cfg.makeSession();
  const QUESTION = session.topic.question;

  // 1) Planner（真实 DeepSeek）
  console.log('>>> planner ...');
  const planner = await runPlanner(session);
  const bodyPlans = planner?.step2_5?.bodyPlans;
  if (!Array.isArray(bodyPlans) || bodyPlans.length === 0) {
    console.log(`  ❌ planner 未产出 bodyPlans (status=${planner?.step2_5?.status} degraded=${planner?.step2_5?.degraded})`);
    return { name: cfg.name, ok: false, reason: 'planner_no_bodies' };
  }
  console.log(`  ✅ planner bodies=${bodyPlans.length} (status=${planner?.step2_5?.status} degraded=${planner?.step2_5?.degraded})`);
  for (const bp of bodyPlans) {
    console.log(`     body ${bp.id}: relation=${bp.argumentRelation || '?'} ids=${JSON.stringify(bp.mappedPointIds || [])}`);
  }

  // 2) 客户端建 Step3（isClaimSentence 过滤）
  const step3 = buildStep3FromBodyPlans(bodyPlans);
  const sp = step3.subpoints.find((s) => s.id === step3.activeSubpointId);
  if (!sp) return { name: cfg.name, ok: false, reason: 'no_active_subpoint' };

  // 3) Step3 kickoff（真实客户端带 step2_5）+ 迷你多轮对话，按题型存档
  const coachSession = { ...session, step2_5: planner.step2_5, step3 };
  const archiveLines = [
    `# 多题型验证 · ${cfg.name} · ${new Date().toISOString()} · 真实 Planner+Step3（本地 DeepSeek）`,
    `# 题目: ${QUESTION}`,
    `# Planner: bodies=${bodyPlans.length} status=${planner.step2_5?.status} degraded=${planner.step2_5?.degraded}`,
    `# 首段 mapped points（客户端 isClaimSentence 过滤后）: ${JSON.stringify(sp.points)}`,
    '',
    '## Step3 对话',
  ];
  const pushTurn = (user, data) => {
    const { p1, p2 } = splitCoachText(data?.text);
    archiveLines.push(`[学生] ${user}`);
    if (p1) archiveLines.push(`[教练P1] ${p1}`);
    if (p2) archiveLines.push(`[教练P2] ${p2}`);
    const pl = data?.progressUpdate?.paragraphPlan;
    if (pl && Array.isArray(pl.pointBlocks)) {
      archiveLines.push(
        `[plan] mode=${pl.mode} blocks=${pl.pointBlocks
          .map((b) => String(b.label || b.subClaim || '').slice(0, 24))
          .join(' | ')}`,
      );
    }
    archiveLines.push('');
  };

  const messages = [{ sender: 'user', text: '我们开始写第一个主体段吧。' }];
  let resp;
  try {
    resp = await postCoach({
      question: QUESTION,
      step: 3,
      userMessage: '我们开始写第一个主体段吧。',
      messages,
      stepContext: {},
      session: coachSession,
    });
  } catch (e) {
    return { name: cfg.name, ok: false, reason: `step3_http:${e.message}` };
  }
  pushTurn('我们开始写第一个主体段吧。', resp);

  // 迷你多轮：学生用首段 mapped point 作答 → 教练确认/追问（最多 3 轮，逐轮容错）
  for (let i = 0; i < 3; i++) {
    const p2 = splitCoachText(resp?.text).p2;
    const reply = studentReplyFor(p2, sp);
    messages.push({ sender: 'user', text: reply });
    try {
      resp = await postCoach({
        question: QUESTION,
        step: 3,
        userMessage: reply,
        messages,
        stepContext: {},
        session: { ...session, step2_5: planner.step2_5, step3: resp?.progressUpdate ? step3 : step3 },
      });
    } catch (e) {
      archiveLines.push(`[提示] 迷你对话第 ${i + 1} 轮中断：${e.message}`);
      break;
    }
    pushTurn(reply, resp);
    // 学生已确认（对）→ 说明确认协议走通，可提前结束
    if (/^对$/.test(reply.trim())) break;
  }

  const plan = resp.progressUpdate?.paragraphPlan;
  const blocks = Array.isArray(plan?.pointBlocks) ? plan.pointBlocks : [];
  const jargon = chatJargonHits(resp.text);

  console.log(`  Step3 kickoff: mode=${plan?.mode || '(none)'} blocks=${blocks.length} jargon=${jargon.length === 0 ? 'OK' : 'FAIL ' + jargon.join(',')}`);
  console.log(`  首段 mapped points（客户端过滤后）: ${JSON.stringify(sp.points)}`);
  if (blocks.length) {
    for (const b of blocks) {
      console.log(`     block ${b.id}: label=${b.label || '(none)'} sub=${String(b.subClaim || '').slice(0, 24)} mappedId=${b.mappedPointId || '-'}`);
    }
  } else {
    console.log('  ⚠️ paragraphPlan.pointBlocks 缺失（无数据契约）');
  }

  // 断言：① 守卫应保证 paragraphPlan 存在且 active body mapped 点被覆盖
  const mappedCore = sp.points.map((p) => String(p).slice(0, 8));
  const planText = JSON.stringify(plan || {});
  const covered = mappedCore.every((core) => planText.includes(core) || blocks.some((b) => String(b.subClaim || '').includes(core) || String(b.label || '').includes(core)));
  const ok = blocks.length >= 1 && jargon.length === 0 && covered;
  if (!ok) {
    console.log(`  ❌ FAIL: blocks=${blocks.length} jargon=${jargon.length} covered=${covered}`);
  } else {
    console.log('  ✅ 通过：paragraphPlan 存在、块覆盖 active mapped 点、chat 无内部术语');
  }
  const archived = archiveTranscript(cfg.slug, archiveLines);
  console.log(`  已存档: ${path.basename(archived)}`);
  return { name: cfg.name, ok, reason: ok ? '' : `blocks=${blocks.length} jargon=${jargon.length} covered=${covered}` };
}

async function main() {
  const cfgs = [
    { name: 'Agree/Disagree（在线学习）', slug: 'agree-disagree', makeSession: makeAgreeDisagreeSession },
    { name: 'Discuss both views（AI）', slug: 'discussion', makeSession: makeDiscussBothViewsSession },
    { name: 'Problem/Solution（高糖食品）', slug: 'problem-solution', makeSession: makeProblemSolutionSession },
  ];
  const results = [];
  for (const cfg of cfgs) {
    try {
      results.push(await runQuestionType(cfg));
    } catch (e) {
      console.log(`  ❌ 异常: ${e.message}`);
      results.push({ name: cfg.name, ok: false, reason: e.message });
    }
  }
  console.log('\n========== 汇总 ==========');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  }
  const allOk = results.every((r) => r.ok);
  console.log(allOk ? '\nALL TYPES PASS' : '\nSOME TYPES FAILED');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error('TYPEN-E2E FAILED:', e.message);
  process.exit(1);
});
