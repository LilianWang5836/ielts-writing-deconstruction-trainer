/**
 * E2E（多题型 · 完整旅程）：用本地 DeepSeek key 对 3 种 IELTS Task 2 题型各驱动
 * 一次完整教练交互：Step1 拆题 → Step2 立场论点 → Planner → Step3 段落逻辑链 →
 * Step4 逐句练习。内置"主题无关"模拟学生（Step3 用各题型自己 body 的 mapped point
 * 作答），完整记录对话并逐题型存档到 docs/recorded-sessions/。
 *
 * 运行前提：本地服务 3000 端口 + .env.local 已配 LLM key。
 * Run: npx tsx scripts/replay-full-typen.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.PROBE_BASE_URL || 'http://localhost:3000';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.join(scriptDir, '..', 'docs', 'recorded-sessions');
fs.mkdirSync(docsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const LIVE_FILE = '/tmp/journey-transcript.log';

// 当前题型的题目（runOneType 里每个题型循环先赋值，供 postCoach 使用）
let CURRENT_QUESTION = '';

// ---- 3 种题型配置 ----
const TYPES = [
  {
    slug: 'agree-disagree',
    name: 'Agree/Disagree（在线学习）',
    question:
      'Some people believe that online learning is highly beneficial and should replace traditional classroom education entirely. To what extent do you agree or disagree?',
    questionType: 'Agree / Disagree',
    typeName:
      '这是 Agree/Disagree 题型，要判断在线学习是否应该完全取代线下课堂。',
    coreIssue: '核心争议是线上教育是否应完全取代线下课堂。',
    qualifier: '关键限定词是 entirely（完全），这是很极端的说法，论证时要回应。',
    dims: [
      '线上学习的灵活性与资源可及性',
      '线下课堂的互动与监督',
      '网络普及让更多人能接触线上课程',
    ],
    stance: '我倾向于部分同意：线上优势明显，但不应完全取代线下。',
    // 主题正确素材（按类别：benefit/cause/solution），供 Step2 分类作答
    points: [
      { cat: 'benefit', text: '在职人员能利用通勤、午休等零散时间在线学习，省去往返线下课堂的时间成本。' },
      { cat: 'benefit', text: '低龄学生在学校有老师现场监督，不易分心；在家上网课则容易走神。' },
      { cat: 'benefit', text: '网络普及让偏远地区也能接触到线上课程，降低了教育资源获取门槛。' },
    ],
  },
  {
    slug: 'discussion',
    name: 'Discuss both views（AI）',
    question:
      'With the rapid development of Artificial Intelligence (AI), some think it will bring more benefits to workers, while others fear it will cause widespread unemployment. Discuss both views and give your opinion.',
    questionType: 'Discussion',
    typeName:
      '这是 Discussion 题型，要分别讨论 AI 的好处与失业风险，再给出个人观点。',
    coreIssue: '核心是 AI 对劳动者是利大于弊还是导致失业，需要权衡双方。',
    qualifier: '要同时覆盖 both views（双方观点）并给出自己的 opinion。',
    dims: [
      'AI 提升生产力并催生新型高价值岗位',
      'AI 取代重复性岗位导致短期失业',
      '配套再培训以缓冲冲击',
    ],
    stance: '我认为 AI 总体利大于弊，但需配套再培训来缓冲失业。',
    points: [
      { cat: 'benefit', text: 'AI 接管重复性劳动后，把人们解放出来转向创意与协作型工作，催生更多新型高价值岗位。' },
      { cat: 'cause', text: 'AI 会取代制造业、客服等标准化程度高的岗位，导致部分工人短期失业。' },
      { cat: 'solution', text: '应通过政府与企业联合的再培训计划，帮助受冲击的工人学习新技能并转岗。' },
    ],
  },
  {
    slug: 'problem-solution',
    name: 'Problem/Solution（高糖食品）',
    question:
      'The increasing consumption of sugar-rich foods and drinks is leading to serious health problems worldwide. What are the causes of this issue, and what solutions can be implemented to solve it?',
    questionType: 'Problem/Solution',
    typeName:
      '这是 Problem/Solution 题型，要分析高糖食品问题的原因并给出解决措施。',
    coreIssue: '核心是高糖食品消费的原因与可落地的解决措施。',
    qualifier: '要同时覆盖 causes 和 solutions 两方面。',
    dims: [
      '高糖饮食的原因（便利食品/广告）',
      '缓解措施（糖税/营养标签/教育）',
      '政府与个人责任分工',
    ],
    stance: '', // requiresStance=false → 不回答立场
    points: [
      { cat: 'cause', text: '含糖食品与饮料更便宜、更易得，加上广告的反复引导，人们逐渐养成高糖饮食习惯。' },
      { cat: 'solution', text: '应通过征收糖税、强制营养标识和公共健康教育来减少含糖食品的摄入。' },
      { cat: 'solution', text: '还应引导食品行业改良配方，在不过度牺牲口味的前提下降低含糖量。' },
    ],
  },
];

// ---- 通用兜底材料点池（仅当题型未提供 points 时使用）----
const STEP2_POINTS = [
  '相关人群可以利用通勤、午休等零散时间通过便捷渠道学习或办事，省去往返固定场所的时间成本。',
  '对自制力较弱的人群，现场有人监督提醒，更容易保持专注并坚持完成任务。',
  '获取门槛降低，偏远地区或条件有限的人也能接触到优质内容与服务。',
  '内容可以反复回看，学习者能按自己的节奏巩固，基础薄弱者尤其受益。',
  '面对面的即时互动是远程方式难以替代的，能当场发现并纠正问题。',
];
const STEP2_STANCE_FALLBACK =
  '我倾向于部分同意：这种方式优势明显，但不应完全取代原有方式，需要权衡。';

// Step3 通用展开（claim 用各 body 自己的 mapped point 在运行时注入）
const STEP3_ANSWERS = {
  reason: '因为这种方式把内容拆成可按自己节奏消化的单元，不受固定时间和地点限制，打破了原有的门槛。',
  mechanism: '具体来说，通过碎片化安排和随时可用的渠道，学习者能利用零散时间持续推进，系统还会记录进度并提醒复习。',
  scenario: '比如一位兼顾工作与家庭的人，可以在通勤路上用手机完成一小段学习，周末再集中补齐。',
  impact: '这样一来，原本受时间地点限制而无法学习的人也能持续投入，整体上让机会变得更公平。',
  meta: '这个分论点可以从原因、具体机制和场景几个层面来展开。',
};
const STEP4_POOL = [
  'This approach offers learners the flexibility to study at their own pace, which makes it more accessible for many groups.',
  'People can fit learning around their daily routine because the content is available anytime and anywhere.',
  'A working parent can study on the phone during the daily commute and catch up on assignments at the weekend.',
];

function splitText(text = '') {
  const parts = String(text).split(/\n\s*---\s*\n/);
  return { p1: String(parts[0] || '').trim(), p2: parts.length > 1 ? parts.slice(1).join('---').trim() : '' };
}

// ---- 单题型运行状态 ----
let turnCount = 0;
let transcript = [];
let archiveFile = '';
let logLine = () => {};
let dimIdx = 0;
let step2PointIdx = 0;
let usedPoints = new Set();
let step3RoleCount = {};
let step4Idx = 0;

function activeSubpointFirstPoint(session) {
  const sp = (session?.step3?.subpoints || []).find(
    (s) => String(s.id) === String(session?.step3?.activeSubpointId || ''),
  );
  const pts = Array.isArray(sp?.points) ? sp.points.filter(Boolean) : [];
  return (pts.length ? pts[0] : '') || String(sp?.content || '线上学习具有灵活性优势。');
}

function studentStep1(p2, type) {
  if (/题型|题目类型|属于|分类|哪一种/.test(p2)) return type.typeName;
  if (/核心|争议|议题|问题|中心/.test(p2)) return type.coreIssue;
  if (/限定|qualif|关键词|entirely|完全|both views|extreme/.test(p2)) return type.qualifier;
  if (/角度|维度|方面|还有|另一个|方向/.test(p2)) {
    const d = type.dims[dimIdx % type.dims.length];
    dimIdx += 1;
    return d;
  }
  if (/进入第二步|第二步|够了|完成|下一步/.test(p2)) return '没有了，我们进入第二步吧。';
  return type.dims[0];
}

function studentStep2(p2, session, type) {
  const payload = session.step2.coachEvaluation?.plannerPayload;
  const pending = payload?.pendingProposal;
  if (pending) {
    return { text: '采纳', decision: { type: 'proposal', action: 'accept', proposalId: pending.proposalId } };
  }
  // 完成/进入下一步确认：教练说"材料池和立场已经齐了…确认进入下一步"时，
  // 回"确认进入下一步"——绝不能因"立场"二字误回立场句（否则死循环）。
  if (/进入下一步|确认进入|若没有要改|没有更多了|材料池和立场已经齐了|可以进入下一步/.test(p2)) {
    return '没有了，确认进入下一步。';
  }
  // 仅在教练真正问立场时回答（推荐立场 / 你更倾向 / 同意还是不同意 等）
  if (/推荐立场|你更倾向|同意还是不同意|完全同意|完全不同意|部分同意/.test(p2) && type.stance) {
    return type.stance;
  }
  // 分类作答：教练明确要"原因/成因"或"解决/措施"时，从题型主题正确的素材里取对应类。
  const pts = Array.isArray(type.points) && type.points.length ? type.points : STEP2_POINTS.map((t) => ({ cat: 'benefit', text: t }));
  const take = (cats) => {
    const pool = pts.filter((x) => cats.includes(x.cat));
    const p = pool.find((x) => !usedPoints.has(x.text)) || pool[0];
    if (p) {
      usedPoints.add(p.text);
      step2PointIdx += 1;
      return p.text;
    }
    return null;
  };
  if (/原因|成因|为什么|导致|推动|诱因|是.*造成的/.test(p2)) {
    const t = take(['cause', 'reason']);
    if (t) return t;
  }
  if (/解决|措施|方案|怎么办|应对|建议|手段|如何.*缓解/.test(p2)) {
    const t = take(['solution', 'measure']);
    if (t) return t;
  }
  // 一般补充/展开：优先未用过的点（避免复读死循环）
  const unused = pts.filter((x) => !usedPoints.has(x.text));
  const p = unused.length ? unused[0] : pts[step2PointIdx % pts.length];
  if (p) {
    usedPoints.add(p.text);
    step2PointIdx += 1;
    return p.text;
  }
  return type.stance || STEP2_STANCE_FALLBACK;
}

function toFullClaim(point, fallback) {
  const t = String(point || '').trim();
  if (!t) return fallback;
  // 已是完整主张句（含谓词/因果词）→ 直接用
  if (
    t.length >= 12 &&
    /(是|能|可以|会|应该|必须|通过|因为|所以|导致|使得|提升|降低|改善|减少|带来|造成|有助于|无法|不能|推动|催生|促进|缓解)/.test(t)
  ) {
    return t;
  }
  // 主题词 → 包装成完整主张句（过 claim 深度门槛）
  return `${t}是导致问题持续存在的重要推动因素，需要通过针对性措施加以应对。`;
}

function studentStep3(p2, session) {
  const payload = session.step2.coachEvaluation?.plannerPayload;
  const pending = payload?.pendingProposal;
  if (pending) return { text: '采纳', decision: { type: 'proposal', action: 'accept', proposalId: pending.proposalId } };
  if (/确认|对吗|可以吗|对不对|同意|确认写入|点击.*确认/.test(p2)) return '对';
  // 确认 CTA 在 P1（"我按你的逻辑整理如下…请点击【确认】"），P2 为空 → 回「对」。
  // 否则分论点永远不被确认、P2 反复问同一槽 → 死循环。
  if (!String(p2 || '').trim()) return '对';
  let role = 'meta';
  if (/分论点|核心观点|论点|主张|观点句/.test(p2)) role = 'claim';
  else if (/原因|为什么|起因|通常意味着|怎么解决|如何解决/.test(p2)) role = 'reason';
  else if (/机制|如何实现|怎么实现|通过什么|怎么发生|链条|具体是怎么|怎么操作|是利用|利用.*(学习|方式)/.test(p2)) role = 'mechanism';
  else if (/影响|结果|好处|作用|效果|最终|带来.*(什么|好处)/.test(p2)) role = 'impact';
  else if (/场景|例子|举例|典型|人群|受益|具体做|做什么/.test(p2)) role = 'scenario';
  const count = (step3RoleCount[role] = (step3RoleCount[role] || 0) + 1);
  if (role === 'claim') {
    const first = activeSubpointFirstPoint(session);
    const claim = toFullClaim(first, '这个分论点围绕相关人群从中获得的关键价值来展开。');
    return count >= 2 ? `我指的分论点就是：${claim}` : claim;
  }
  if (role === 'meta' && count >= 2) {
    return ['我觉得可以这样展开：先讲原因，再用一个具体场景说明。', '本质上就是：它降低了门槛，让更多人能按自己的节奏参与。'][(count - 2) % 2];
  }
  return STEP3_ANSWERS[role] || STEP3_ANSWERS.meta;
}

function studentStep4(p2) {
  if (/场景|例子|具体|通勤|午休|地铁|时刻|描述|example/.test(p2)) return STEP4_POOL[2];
  if (/主题句|topic|中心句|论点句/.test(p2)) return STEP4_POOL[0];
  step4Idx += 1;
  return STEP4_POOL[step4Idx % STEP4_POOL.length];
}

async function postCoach({ step, userMessage, session, decision, messages }) {
  turnCount += 1;
  const body = {
    question: CURRENT_QUESTION,
    step,
    userMessage,
    messages: messages || [{ sender: 'user', text: userMessage }],
    stepContext: {},
    session,
    ...(decision ? { decision } : {}),
  };
  const res = await fetch(`${BASE}/api/coach/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`HTTP ${res.status} step${step}: ${data.error || 'unknown'}`);
  }
  transcript.push({ step, user: userMessage, coach: data.text, data });
  const { p1, p2 } = splitText(data.text);
  logLine(`[step${step}][t${turnCount}] 学生: ${userMessage}`);
  logLine(`[step${step}][t${turnCount}] 教练P1: ${p1.slice(0, 300)}`);
  logLine(`[step${step}][t${turnCount}] 教练P2: ${p2.slice(0, 300)}`);
  return data;
}

// ---- 客户端 progressUpdate 合并（对齐 CoachChat.tsx）----
function applyProgress(session, stepKey, pu, userMsg) {
  if (!pu) return;
  if (stepKey === 1 && pu.step1Data) {
    session.step1 = {
      ...session.step1,
      coachEvaluation: { ...(session.step1.coachEvaluation || {}), ...pu.step1Data },
      isCompleted: pu.isCompleted === false ? false : Boolean(pu.isCompleted || session.step1.isCompleted),
    };
  } else if (stepKey === 2 && pu.step2Data) {
    session.step2 = {
      ...session.step2,
      userStance: pu.step2Data.userStance || session.step2.userStance || '',
      userPoints: pu.step2Data.userPoints || session.step2.userPoints || '',
      selectedThesis: pu.step2Data.suggestedStance || session.step2.selectedThesis || '',
      coachEvaluation: { ...(session.step2.coachEvaluation || {}), ...pu.step2Data },
      isCompleted: pu.isCompleted === false ? false : Boolean(pu.isCompleted || session.step2.isCompleted),
    };
  } else if (stepKey === 3) {
    const currentStep3 = session.step3 || {};
    const subpoints = Array.isArray(currentStep3.subpoints) ? currentStep3.subpoints : [];
    const activeId = currentStep3.activeSubpointId || (subpoints[0] && subpoints[0].id) || '';
    const step3Ui = pu.step3Ui;
    const uiById = new Map((Array.isArray(step3Ui?.bodies) ? step3Ui.bodies : []).map((b) => [String(b.id), b]));
    const updatedSubpoints = subpoints.map((sp) => {
      const uiBody = uiById.get(String(sp.id));
      const next = { ...sp };
      if (uiBody) {
        next.isCompleted = !!uiBody.isCompleted;
        next.selectable = !!uiBody.selectable;
      }
      if (String(sp.id) === String(activeId)) {
        if (pu.paragraphPlan) next.paragraphPlan = pu.paragraphPlan;
        if (Array.isArray(pu.step3SubpointSteps) && pu.step3SubpointSteps.length) next.structureSteps = pu.step3SubpointSteps;
        if (pu.step3SlotEval) next.step3SlotEval = pu.step3SlotEval;
        if (Array.isArray(pu.step3KickoffPendingDrafts)) next.kickoffPendingDrafts = pu.step3KickoffPendingDrafts;
      }
      return next;
    });
    session.step3 = {
      ...currentStep3,
      ...(pu.step3Data || {}),
      subpoints: updatedSubpoints,
      activeSubpointId: step3Ui?.nextActiveSubpointId || activeId,
      isCompleted: pu.isCompleted === false ? false : Boolean((step3Ui && step3Ui.isStep3Finished === true) || pu.isCompleted || currentStep3.isCompleted),
    };
  } else if (stepKey === 4 && pu.step4Data) {
    session.step4 = {
      ...session.step4,
      ...pu.step4Data,
      isCompleted: pu.isCompleted === false ? false : Boolean(pu.isCompleted || session.step4.isCompleted),
    };
  }
}

async function runStep(session, step, opening, responder, type, maxTurns = 14) {
  let msgs = [{ sender: 'user', text: opening }];
  let pendingDecision = null;
  for (let i = 0; i < maxTurns; i++) {
    const lastUser = msgs[msgs.length - 1].text;
    const resp = await postCoach({ step, userMessage: lastUser, session, messages: msgs, ...(pendingDecision ? { decision: pendingDecision } : {}) });
    pendingDecision = null;
    const { p2 } = splitText(resp.text);
    applyProgress(session, step, resp.progressUpdate, lastUser);
    const st = session[`step${step}`];
    if (st?.isCompleted) {
      console.log(`    ✅ step${step} 完成（${i + 1} 轮）`);
      return;
    }
    if (i >= maxTurns - 1) {
      console.log(`    ⏸ step${step} 达轮次上限未完成（isCompleted=${!!st?.isCompleted}）`);
      return;
    }
    const ans = responder(p2, session, type);
    const replyText = typeof ans === 'string' ? ans : ans.text;
    if (ans && typeof ans === 'object' && ans.decision) pendingDecision = ans.decision;
    msgs = [...msgs, { sender: 'ai', text: resp.text }, { sender: 'user', text: replyText }];
  }
}

async function runOneType(type) {
  turnCount = 0;
  transcript = [];
  dimIdx = 0;
  step2PointIdx = 0;
  usedPoints = new Set();
  step3RoleCount = {};
  step4Idx = 0;
  archiveFile = path.join(docsDir, `recorded-session-${type.slug}-full-${stamp}.txt`);
  logLine = (line) => {
    try { fs.appendFileSync(archiveFile, `${line}\n`); } catch (e) { /* ignore */ }
    try { fs.appendFileSync(LIVE_FILE, `${line}\n`); } catch (e) { /* ignore */ }
  };

  // 当前题型
  CURRENT_QUESTION = type.question;

  const session = {
    topic: { question: type.question, questionType: type.questionType },
    currentStep: 1,
    step1: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
    step2: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
    step3: { isCompleted: false, subpoints: [], activeSubpointId: '', chatHistory: [] },
    step4: { isCompleted: false, tasks: [], chatHistory: [] },
  };
  logLine(`# 完整旅程 · ${type.name} · ${new Date().toISOString()} · Step1→Step4（本地 DeepSeek）`);
  logLine(`# 题目: ${type.question}`);

  console.log(`\n========== ${type.name} ==========`);
  console.log('  ## STEP 1 拆题 ##');
  await runStep(session, 1, '我想分析一下这个 IELTS 题目。', studentStep1, type, 10);

  console.log('  ## STEP 2 立场与论点 ##');
  await runStep(session, 2, '我来说说我对这个题目的立场和一些论点。', studentStep2, type, 18);

  console.log('  ## PLANNER ##');
  const plannerRes = await fetch(`${BASE}/api/planner/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, question: type.question }),
  });
  const planner = await plannerRes.json().catch(() => ({}));
  if (!plannerRes.ok || planner.error) {
    console.log(`    ❌ planner 失败: ${planner.error || plannerRes.status}`);
  } else {
    const bodyPlans = planner.step2_5?.bodyPlans || [];
    console.log(`    planner status=${planner.step2_5?.status} degraded=${planner.step2_5?.degraded} bodies=${bodyPlans.length}`);
    logLine(`# Planner: status=${planner.step2_5?.status} degraded=${planner.step2_5?.degraded} bodies=${bodyPlans.length}`);
    session.step2_5 = planner.step2_5;
    session.step3.subpoints = bodyPlans.map((bp) => ({
      id: bp.id,
      content: bp.paragraphPlan?.pointBlocks?.[0]?.subClaim || bp.theme || bp.targetBody,
      points: Array.isArray(bp.mappedPoints) ? bp.mappedPoints : [],
      targetBody: bp.targetBody,
      theme: bp.theme || bp.role,
      paragraphPlan: bp.paragraphPlan,
      frameworkSignature: `${bp.id}-${bp.argumentRelation || ''}`,
      isCompleted: false,
      chatHistory: [],
    }));
    session.step3.activeSubpointId = session.step3.subpoints[0]?.id || '';
    session.step3.currentStep = 3;
  }

  console.log('  ## STEP 3 段落逻辑链 ##');
  await runStep(session, 3, '我们开始写第一个主体段吧。', studentStep3, type, 18);

  console.log('  ## STEP 4 逐句练习 ##');
  await runStep(session, 4, '我准备好做逐句练习了。', studentStep4, type, 8);

  console.log(`  共 ${turnCount} 轮 → 已存档: ${path.basename(archiveFile)}`);
}

async function main() {
  const only = String(process.env.ONLY_TYPE || '').trim();
  const list = only ? TYPES.filter((t) => t.slug === only) : TYPES;
  for (const type of list) {
    try {
      await runOneType(type);
    } catch (e) {
      console.log(`  ❌ ${type.name} 异常: ${e.message}`);
      console.error(e.stack);
    }
  }
  console.log('\n===== 全部题型旅程结束 =====');
}

main().catch((e) => {
  console.error('FULL-TYPEN FAILED:', e.message);
  process.exit(1);
});
