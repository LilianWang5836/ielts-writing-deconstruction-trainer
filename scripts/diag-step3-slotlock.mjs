/**
 * 诊断：Step3 slotEval activeKey-lock 死循环。
 *
 * 复用 replay-student-multi 的 Step1/2 应答器走通前置流程，进入 Step3 后按
 * 真实交互存档（recorded-session-discussion-interactive-20260813012503.txt）的
 * 学生消息序列回放，每轮打印服务端返回的：
 *   - step3SlotEval（activeKey / mode / qualified / pendingText / rejectReason）
 *   - paragraphPlan 每个 pointBlock 的完整 steps（key/label/status/value）
 *   - step3LastRejectCode
 *
 * 目的：定位「确认后槽位丢失 / firstEmpty 反复回到 pb1_claim」的精确轮次与原因。
 *
 * Run: npx tsx scripts/diag-step3-slotlock.mjs
 * 需本地服务 3000 + LLM key。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.PROBE_BASE_URL || 'http://localhost:3000';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

let turnCount = 0;

// ---- Discussion 题型（与 replay-student-multi 一致） ----
const TYPE = {
  slug: 'discussion',
  name: 'Discuss both views（AI）',
  question:
    'With the rapid development of Artificial Intelligence (AI), some think it will bring more benefits to workers, while others fear it will cause widespread unemployment. Discuss both views and give your opinion.',
  questionType: 'Discussion',
  typeName: '这是 Discussion 题型，要分别讨论 AI 的好处与失业风险，再给出个人观点。',
  coreIssue: '核心是 AI 对劳动者是利大于弊还是导致失业，需要权衡双方。',
  qualifier: '要同时覆盖 both views（双方观点）并给出自己的 opinion。',
  dims: ['AI 提升生产力并催生新型高价值岗位', 'AI 取代重复性岗位导致短期失业', '配套再培训以缓冲冲击'],
  stance: '我认为 AI 总体利大于弊，但需配套再培训来缓冲失业。',
  points: [
    { cat: 'benefit', text: 'AI 接管重复性劳动后，把人们解放出来转向创意与协作型工作，催生更多新型高价值岗位。' },
    { cat: 'cause', text: 'AI 会取代制造业、客服等标准化程度高的岗位，导致部分工人短期失业。' },
    { cat: 'solution', text: '应通过政府与企业联合的再培训计划，帮助受冲击的工人学习新技能并转岗。' },
  ],
};

// ---- 真实交互存档的学生消息序列（仅 Step3 部分） ----
// 从 recorded-session-discussion-interactive-20260813012503.txt 提取。
const STEP3_REPLAY = [
  '我们开始写第一个主体段吧。',
  '确认',
  '因为 AI 相比人工在重复性任务上成本更低、速度更快且不易出错，比如机器视觉质检一天能检查的件数远超人工，企业为降本增效自然会用 AI 替代这类岗位。',
  '确认',
  '分论点是：AI 会替代大量重复性、标准化的工作岗位，比如流水线质检和客服，导致部分工人短期失业。',
  '机制是：企业先在一个车间试点部署视觉检测系统，记录它的准确率和效率数据，确认达标后逐步扩大替代范围——先接管夜班和高峰期质检，再推广到全部产线，原质检员的工作量随之减少，最终被完全替代。',
  '确认',
  '结果是：被替代的工人如果技能单一、缺乏再培训机会，会陷入长期失业，家庭收入下降、生活压力增大，而且年龄偏大的工人转岗更难，可能被排斥在劳动力市场之外。',
  '确认',
  '客服岗也是典型例子：企业先上线智能客服机器人处理常见咨询，比如查订单、改地址这类高频问题，人工客服只处理剩余的低频复杂问题，随着机器人准确率提升，客服中心逐步缩减人工坐席，大批客服人员面临转岗或失业。',
  '分论点就是：AI 会替代大量重复性、标准化的工作岗位，导致部分工人失业。',
  '确认',
  '好的，分论点就是：AI 会替代大量重复性、标准化的工作岗位，导致部分工人失业。这个逻辑链已经完整了，我们可以看下一个主体段了。',
];

// ---- Step1/2 应答器（精简版，与 replay-student-multi 一致） ----
let step2Idx = 0;
let usedPoints = new Set();
let pendingDecision = null;

function splitText(text = '') {
  const parts = String(text).split(/\n\s*---\s*\n/);
  return { p1: String(parts[0] || '').trim(), p2: parts.length > 1 ? parts.slice(1).join('---').trim() : '' };
}

function studentStep1(p2) {
  if (/维度|几个方面|哪几|分类|角度/.test(p2)) return '可以从劳动者、企业和社会三个角度来拆解这个题目。';
  if (/关键词|限定|qualifier|entirely|极端/.test(p2)) return '关键是要回应 both views，并给出自己的判断。';
  if (/同意|倾向|立场|观点/.test(p2)) return '我倾向于认为 AI 利大于弊，但要配套措施。';
  if (/进入下一步|确认|够|足够|继续/.test(p2)) return '确认进入下一步';
  return '我先把题目里的关键概念和涉及的方面梳理一下。';
}

function studentStep2(p2) {
  if (pendingDecision) return { text: '采纳', decision: pendingDecision };
  if (/采纳|确认|立场|倾向|锁定|同意/.test(p2)) return { text: '采纳', decision: { action: 'accept', stance: TYPE.stance } };
  if (/进入下一步|确认进入|材料.*够|足够|继续/.test(p2)) return '确认进入下一步';
  if (/补|展开|具体|例子|场景|细化|再给/.test(p2)) {
    const point = TYPE.points[step2Idx % TYPE.points.length];
    step2Idx += 1;
    return `${point.text} 具体例子是：比如制造业流水线质检被视觉检测系统替代，客服坐席被智能客服机器人分流。`;
  }
  if (/还有|其他|还有哪些|受益/.test(p2)) {
    const point = TYPE.points[step2Idx % TYPE.points.length];
    step2Idx += 1;
    return point.text;
  }
  if (/立场|观点/.test(p2)) return TYPE.stance;
  return '这些材料已经足够具体了，我确认这些论点并进入下一步。';
}

// ---- HTTP ----
async function postCoach({ step, userMessage, session, messages, decision, isHiddenKickoff }) {
  turnCount += 1;
  const body = {
    question: TYPE.question,
    step,
    userMessage,
    messages: messages || [{ sender: 'user', text: userMessage }],
    stepContext: {},
    session,
    ...(decision ? { decision } : {}),
    ...(isHiddenKickoff ? { isHiddenKickoff } : {}),
  };
  let res = null;
  let data = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${BASE}/api/coach/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      data = await res.json().catch(() => ({}));
      if (res.ok && !data.error) break;
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!res || !res.ok || data?.error) {
    throw new Error(`HTTP ${res?.status} step${step}: ${data?.error || 'unknown'}`);
  }
  return data;
}

// ---- 状态合并（对齐客户端） ----
function applyProgress(session, stepKey, pu) {
  if (!pu) return;
  if (stepKey === 1 && pu.step1Data) {
    session.step1 = { ...session.step1, coachEvaluation: { ...(session.step1.coachEvaluation || {}), ...pu.step1Data }, isCompleted: pu.isCompleted === false ? false : Boolean(pu.isCompleted || session.step1.isCompleted) };
  } else if (stepKey === 2 && pu.step2Data) {
    session.step2 = { ...session.step2, userStance: pu.step2Data.userStance || session.step2.userStance || '', userPoints: pu.step2Data.userPoints || session.step2.userPoints || '', selectedThesis: pu.step2Data.suggestedStance || session.step2.selectedThesis || '', coachEvaluation: { ...(session.step2.coachEvaluation || {}), ...pu.step2Data }, isCompleted: pu.isCompleted === false ? false : Boolean(pu.isCompleted || session.step2.isCompleted) };
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
    session.step3 = { ...currentStep3, ...(pu.step3Data || {}), subpoints: updatedSubpoints, activeSubpointId: step3Ui?.nextActiveSubpointId || activeId, isCompleted: pu.isCompleted === false ? false : Boolean((step3Ui && step3Ui.isStep3Finished === true) || pu.isCompleted || currentStep3.isCompleted) };
  }
}

// ---- Step3 详细 dump ----
function dumpStep3State(label, resp, session) {
  const pu = resp.progressUpdate || {};
  const ev = pu.step3SlotEval;
  console.log(`\n──── [${label}] ────`);
  console.log(`  slotEval: ${JSON.stringify(ev)}`);
  console.log(`  step3LastRejectCode: ${JSON.stringify(pu.step3LastRejectCode || '')}`);
  console.log(`  step3KickoffPendingDrafts: ${JSON.stringify(pu.step3KickoffPendingDrafts || [])}`);
  console.log(`  isCompleted: ${!!pu.isCompleted}  step3SubpointCompleted: ${!!pu.step3SubpointCompleted}`);
  const plan = pu.paragraphPlan;
  if (plan && Array.isArray(plan.pointBlocks)) {
    plan.pointBlocks.forEach((b, i) => {
      const steps = (b.steps || []).map((s) => {
        const v = String(s?.value || '').trim();
        return `[${s.key}]「${s.label}」status=${s.status || '-'} value=${v ? v.slice(0, 24) + (v.length > 24 ? '…' : '') : '(空)'}`;
      }).join('\n            ');
      console.log(`  block${i} id=${b.id} label=${String(b.label || b.subClaim || '').slice(0, 16)} role=${b.role || '-'} expansion=${b.expansionStrategy || '-'} mode=${plan.mode || '-'}`);
      console.log(`        ${steps}`);
    });
  } else {
    console.log(`  paragraphPlan: ${JSON.stringify(plan).slice(0, 300)}`);
  }
  if (pu.step3SubpointSteps) {
    console.log(`  step3SubpointSteps(${pu.step3SubpointSteps.length}): ${pu.step3SubpointSteps.map((s) => `[${s.key}]${s.label}:${s.status || '-'}`).join(' ')}`);
  }
}

// ---- 驱动 Step1/2 ----
async function runStep(session, step, opening, responder, maxTurns) {
  pendingDecision = null;
  let msgs = [{ sender: 'user', text: opening }];
  for (let i = 0; i < maxTurns; i++) {
    const lastUser = msgs[msgs.length - 1].text;
    const resp = await postCoach({ step, userMessage: lastUser, session, messages: msgs, ...(pendingDecision ? { decision: pendingDecision } : {}) });
    pendingDecision = null;
    const { p2 } = splitText(resp.text);
    applyProgress(session, step, resp.progressUpdate);
    const st = session[`step${step}`];
    if (st?.isCompleted) {
      console.log(`    ✅ step${step} 完成（${i + 1} 轮）`);
      return;
    }
    const ans = responder(p2);
    const replyText = typeof ans === 'string' ? ans : ans.text;
    if (ans && typeof ans === 'object' && ans.decision) pendingDecision = ans.decision;
    msgs = [...msgs, { sender: 'ai', text: resp.text }, { sender: 'user', text: replyText }];
  }
  console.log(`    ⏸ step${step} 达轮次上限`);
}

// ---- main ----
async function main() {
  const session = {
    topic: { question: TYPE.question, questionType: TYPE.questionType },
    currentStep: 1,
    step1: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
    step2: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
    step3: { isCompleted: false, subpoints: [], activeSubpointId: '', chatHistory: [] },
    step4: { isCompleted: false, tasks: [], chatHistory: [] },
  };

  console.log('# STEP 1');
  if (process.env.SKIP_PRE === '1') {
    console.log('    ⏭ 跳过 Step1（SKIP_PRE=1）');
    session.step1.isCompleted = true;
  } else {
    await runStep(session, 1, '我想分析一下这个 IELTS 题目。', studentStep1, 8);
  }

  console.log('# STEP 2');
  if (process.env.SKIP_PRE === '1') {
    console.log('    ⏭ 跳过 Step2（SKIP_PRE=1）');
    session.step2.isCompleted = true;
    session.step2.coachEvaluation = {};
  } else {
    await runStep(session, 2, '我来说说我对这个题目的立场和一些论点。', studentStep2, 16);
  }

  console.log('# PLANNER');
  const plannerRes = await fetch(`${BASE}/api/planner/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, question: TYPE.question }),
  });
  const planner = await plannerRes.json().catch(() => ({}));
  const bodyPlans = planner.step2_5?.bodyPlans || [];
  console.log(`    planner status=${planner.step2_5?.status} degraded=${planner.step2_5?.degraded} bodies=${bodyPlans.length}`);
  session.step2_5 = planner.step2_5;
  session.step3.subpoints = bodyPlans.map((bp) => ({
    id: bp.id,
    content: bp.paragraphPlan?.pointBlocks?.[0]?.subClaim || bp.theme || bp.targetBody,
    points: Array.isArray(bp.mappedPoints) ? bp.mappedPoints : [],
    targetBody: bp.targetBody,
    theme: bp.theme || bp.role,
    paragraphPlan: bp.paragraphPlan,
    // 注意：不设置 frameworkSignature（模拟真实前端匹配的情况）。
    // 真实前端用 computeSubpointFrameworkSignature() 计算；脚本曾错误使用
    // `${bp.id}-${bp.argumentRelation}`，会导致 frameworkDrifted=true → merge 被跳过。
    isCompleted: false,
    chatHistory: [],
  }));
  session.step3.activeSubpointId = session.step3.subpoints[0]?.id || '';
  session.step3.currentStep = 3;

  // 打印骨架（planner bodyPlans[0].paragraphPlan 与 bodyPlans 数量/结构）
  const bp0 = bodyPlans[0];
  console.log('\n── 骨架 skeleton（bodyPlans[0]）──');
  if (bp0?.paragraphPlan?.pointBlocks) {
    bp0.paragraphPlan.pointBlocks.forEach((b, bi) => {
      const steps = (b.steps || []).map((s) => `[${s.key}]「${s.label}」`).join(' ');
      console.log(`  block${bi} id=${b.id} label=${String(b.label || '').slice(0, 16)} :: ${steps}`);
    });
  } else {
    console.log(`  无骨架 paragraphPlan: ${JSON.stringify(bp0).slice(0, 300)}`);
  }
  console.log(`  bodyPlans 总数=${bodyPlans.length}, 各 id: ${bodyPlans.map((b) => b.id).join(', ')}`);

  console.log('# STEP 3（回放真实学生序列）');
  let msgs = [{ sender: 'user', text: STEP3_REPLAY[0] }];
  for (let i = 0; i < STEP3_REPLAY.length; i++) {
    // 打印发送给服务端的 prevPlan（session 中 activeSubpoint.paragraphPlan）
    const spPrev = (session.step3.subpoints || []).find(
      (s) => String(s.id) === String(session.step3.activeSubpointId || ''),
    );
    if (spPrev?.paragraphPlan) {
      const pp = spPrev.paragraphPlan;
      console.log(`\n── 发送前 prevPlan（activeSubpoint=${session.step3.activeSubpointId}）──`);
      (pp.pointBlocks || []).forEach((b, bi) => {
        const steps = (b.steps || []).map((s) => `[${s.key}]「${s.label}」${s.status || '-'}${String(s.value || '').trim() ? `=${String(s.value).slice(0, 16)}` : '(空)'}`).join(' ');
        console.log(`  block${bi} ${steps}`);
      });
      console.log(`  总确认槽: ${(pp.pointBlocks || []).flatMap((b) => b.steps || []).filter((s) => s.status === 'confirmed').length}`);
    } else {
      console.log('\n── 发送前 prevPlan：无 paragraphPlan ──');
    }
    const lastUser = msgs[msgs.length - 1].text;
    // 完全复刻 interactive-student.mjs：不传 isHiddenKickoff（真实交互走普通路径）
    const resp = await postCoach({
      step: 3,
      userMessage: lastUser,
      session,
      messages: msgs,
    });
    // 打印服务端返回的 confirmed 槽数
    const respPlan = resp.progressUpdate?.paragraphPlan;
    const respConfirmed = respPlan?.pointBlocks?.flatMap((b) => b.steps || []).filter((s) => s?.status === 'confirmed').length || 0;
    console.log(`  响应 confirmed槽=${respConfirmed} step3SubpointCompleted=${!!resp.progressUpdate?.step3SubpointCompleted} isCompleted=${!!resp.progressUpdate?.isCompleted}`);
    if (respPlan?.pointBlocks?.[0]?.steps) {
      console.log(`  响应 plan[0]: ${respPlan.pointBlocks[0].steps.map((s) => `[${s.key}]${s.label}:${s.status || '-'}`).join(' ')}`);
    }
    // 打印 applyProgress 后 session 里的状态
    const spAfter = (session.step3.subpoints || []).find(
      (s) => String(s.id) === String(session.step3.activeSubpointId || ''),
    );
    const afterPlan = spAfter?.paragraphPlan;
    const afterConfirmed = afterPlan?.pointBlocks?.flatMap((b) => b.steps || []).filter((s) => s?.status === 'confirmed').length || 0;
    console.log(`  发送前session confirmed槽=${afterConfirmed} activeSubpointId=${session.step3.activeSubpointId}`);
    const { p1, p2 } = splitText(resp.text);
    applyProgress(session, 3, resp.progressUpdate);
    dumpStep3State(`学生「${STEP3_REPLAY[i].slice(0, 30)}${STEP3_REPLAY[i].length > 30 ? '…' : ''}」`, resp, session);
    console.log(`    P1: ${(p1 || '(空)').slice(0, 120)}`);
    console.log(`    P2: ${(p2 || '(空)').slice(0, 120)}`);
    const st = session.step3;
    if (st?.isCompleted) {
      console.log('\n  ✅ STEP3 完成');
      return;
    }
    const next = STEP3_REPLAY[i + 1];
    if (!next) {
      console.log('\n  ⏸ 真实序列已放完但 Step3 未完成（复现死循环）');
      return;
    }
    msgs = [...msgs, { sender: 'ai', text: resp.text }, { sender: 'user', text: next }];
  }
  console.log('\n  ⏸ 序列结束');
}

main().catch((e) => {
  console.error('DIAG FAILED:', e.message);
  process.exit(1);
});
