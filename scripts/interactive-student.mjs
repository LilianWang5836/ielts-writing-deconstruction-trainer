/**
 * 交互式教练测试：由"真人/助手"亲自扮演学生。
 * 脚本驱动真实服务端（Step1→Step2→Planner→Step3→Step4），每轮：
 *   1) 打印教练 P1/P2（及关键状态）；
 *   2) 从 stdin 读"学生回答"；
 *   3) 发回服务端并推进。
 * 这样对话能真正按教练的自然问法给出主题正确、具体的回答，避免写死应答池的死循环。
 *
 * 用法：TYPE=agree-disagree|discussion|problem-solution npx tsx scripts/interactive-student.mjs
 *（需本地服务 3000 + LLM key；逐轮手动输入回答，回车发送）
 */
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.PROBE_BASE_URL || 'http://localhost:3000';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.join(scriptDir, '..', 'docs', 'recorded-sessions');
fs.mkdirSync(docsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

const TYPES = [
  {
    slug: 'agree-disagree',
    name: 'Agree/Disagree（在线学习）',
    question:
      'Some people believe that online learning is highly beneficial and should replace traditional classroom education entirely. To what extent do you agree or disagree?',
    questionType: 'Agree / Disagree',
  },
  {
    slug: 'discussion',
    name: 'Discuss both views（AI）',
    question:
      'With the rapid development of Artificial Intelligence (AI), some think it will bring more benefits to workers, while others fear it will cause widespread unemployment. Discuss both views and give your opinion.',
    questionType: 'Discussion',
  },
  {
    slug: 'problem-solution',
    name: 'Problem/Solution（高糖食品）',
    question:
      'The increasing consumption of sugar-rich foods and drinks is leading to serious health problems worldwide. What are the causes of this issue, and what solutions can be implemented to solve it?',
    questionType: 'Problem/Solution',
  },
];

const type = TYPES.find((t) => t.slug === String(process.env.TYPE || '').trim()) || TYPES[0];
const archiveFile = path.join(docsDir, `recorded-session-${type.slug}-interactive-${stamp}.txt`);
const logLine = (line) => {
  try { fs.appendFileSync(archiveFile, `${line}\n`); } catch (e) { /* ignore */ }
};

function splitText(text = '') {
  const parts = String(text).split(/\n\s*---\s*\n/);
  return { p1: String(parts[0] || '').trim(), p2: parts.length > 1 ? parts.slice(1).join('---').trim() : '' };
}

function makeSession() {
  return {
    topic: { question: type.question, questionType: type.questionType },
    currentStep: 1,
    step1: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
    step2: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
    step3: { isCompleted: false, subpoints: [], activeSubpointId: '', chatHistory: [] },
    step4: { isCompleted: false, tasks: [], chatHistory: [] },
  };
}

async function postCoach({ step, userMessage, session, decision, messages }) {
  const body = {
    question: type.question,
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
  return data;
}

function applyProgress(session, stepKey, pu) {
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

function printStep3State(session) {
  const sp = (session?.step3?.subpoints || []).find((s) => String(s.id) === String(session?.step3?.activeSubpointId || ''));
  if (!sp) return;
  const plan = sp.paragraphPlan;
  if (plan && Array.isArray(plan.pointBlocks)) {
    console.log('  [看板 pointBlocks]');
    plan.pointBlocks.forEach((b, i) => {
      const steps = (b.steps || [])
        .map((s) => `${s.label}:${s.status === 'confirmed' ? '✓' : s.value ? '(草稿)' : '□'}`)
        .join(' | ');
      console.log(`    ${i + 1}. ${String(b.label || b.subClaim || '').slice(0, 20)} :: ${steps}`);
    });
  }
  const ev = sp.step3SlotEval;
  if (ev) console.log(`  [slotEval] activeKey=${ev.activeKey} mode=${ev.mode} qualified=${ev.qualified} reject=${ev.rejectReason || ''}`);
}

async function driveStep(session, step, opening) {
  console.log(`\n================ STEP ${step} ================`);
  let msg = opening;
  const messages = [{ sender: 'user', text: opening }];
  for (;;) {
    const resp = await postCoach({ step, userMessage: msg, session, messages });
    applyProgress(session, step, resp.progressUpdate);
    const { p1, p2 } = splitText(resp.text);
    logLine(`[step${step}] 学生: ${msg}`);
    logLine(`[step${step}] 教练P1: ${p1}`);
    logLine(`[step${step}] 教练P2: ${p2 || '(空)'}`);
    console.log(`\n  ── 教练 P1 ──\n  ${p1 || '(空)'}`);
    console.log(`  ── 教练 P2 ──\n  ${p2 || '(空)'}`);
    if (step === 3) printStep3State(session);
    const st = session[`step${step}`];
    if (st?.isCompleted) {
      console.log(`\n  ✅ STEP ${step} 完成（进入下一步）`);
      return;
    }
    messages.push({ sender: 'ai', text: resp.text });
    msg = await ask('\n  >>> 我（学生）回答: ');
    if (!msg.trim()) msg = '没有了，确认进入下一步。';
    messages.push({ sender: 'user', text: msg });
  }
}

async function main() {
  console.log(`# 交互式测试 · ${type.name} · 存档: ${path.basename(archiveFile)}`);
  console.log(`# 题目: ${type.question}`);
  logLine(`# 交互式测试 · ${type.name} · ${new Date().toISOString()}`);
  logLine(`# 题目: ${type.question}`);

  const session = makeSession();
  await driveStep(session, 1, '我想分析一下这个 IELTS 题目。');
  await driveStep(session, 2, '我来说说我对这个题目的立场和一些论点。');

  // Planner
  console.log('\n================ PLANNER ================');
  const plannerRes = await fetch(`${BASE}/api/planner/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, question: type.question }),
  });
  const planner = await plannerRes.json().catch(() => ({}));
  if (!plannerRes.ok || planner.error) {
    console.log(`  ❌ planner 失败: ${planner.error || plannerRes.status}`);
  } else {
    const bodyPlans = planner.step2_5?.bodyPlans || [];
    console.log(`  planner status=${planner.step2_5?.status} degraded=${planner.step2_5?.degraded} bodies=${bodyPlans.length}`);
    logLine(`# Planner: status=${planner.step2_5?.status} degraded=${planner.step2_5?.degraded} bodies=${bodyPlans.length}`);
    session.step2_5 = planner.step2_5;
    session.step3.subpoints = bodyPlans.map((bp) => ({
      id: bp.id,
      content: bp.paragraphPlan?.pointBlocks?.[0]?.subClaim || bp.theme || bp.targetBody,
      points: Array.isArray(bp.mappedPoints) ? bp.mappedPoints : [],
      targetBody: bp.targetBody,
      theme: bp.theme || bp.role,
      paragraphPlan: bp.paragraphPlan,
      // 注意：不设置 frameworkSignature（错误格式会触发 frameworkDrifted → 死锁）。
      isCompleted: false,
      chatHistory: [],
    }));
    session.step3.activeSubpointId = session.step3.subpoints[0]?.id || '';
    session.step3.currentStep = 3;
  }

  await driveStep(session, 3, '我们开始写第一个主体段吧。');
  await driveStep(session, 4, '我准备好做逐句练习了。');

  console.log(`\n✅ 全部完成。对话已存档: ${path.basename(archiveFile)}`);
  rl.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n交互测试失败:', e.message);
  process.exit(1);
});
