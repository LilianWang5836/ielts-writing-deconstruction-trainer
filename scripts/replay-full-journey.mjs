/**
 * E2E 全流程：用本地 DeepSeek key 真实驱动一次完整教练交互
 * （Step1 拆题 → Step2 立场论点 → Planner → Step3 段落逻辑链 → Step4 逐句练习）。
 * 内置"模拟学生"，按教练 part2 的问题关键字作答；完整记录对话与状态。
 *
 * 运行前提：本地服务 3000 端口 + .env.local 已配 LLM key。
 * Run: npx tsx scripts/replay-full-journey.mjs
 *
 * 存档：对话记录按时间戳写入 docs/recorded-session-<时间戳>.txt（与项目记录
 * 同路径归档，保留多轮历史）；同时继续写 /tmp/journey-transcript.log 便于
 * 运行中实时 tail。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.PROBE_BASE_URL || 'http://localhost:3000';
const QUESTION =
  'Some people believe that online learning is highly beneficial and should replace traditional classroom education entirely. To what extent do you agree or disagree?';

let turnCount = 0;
const transcript = [];
// 存档到项目 docs/（部署路径），时间戳精确到秒以便保留多轮历史
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.join(scriptDir, '..', 'docs');
const stamp = new Date()
  .toISOString()
  .replace(/[-:T]/g, '')
  .slice(0, 14); // YYYYMMDDHHmmss
const TRANSCRIPT_FILE =
  process.env.TRANSCRIPT_FILE || path.join(docsDir, `recorded-session-${stamp}.txt`);
const LIVE_FILE = '/tmp/journey-transcript.log';
fs.mkdirSync(docsDir, { recursive: true });
function logLine(line) {
  try { fs.appendFileSync(TRANSCRIPT_FILE, `${line}\n`); } catch (e) { /* ignore */ }
  try { fs.appendFileSync(LIVE_FILE, `${line}\n`); } catch (e) { /* ignore */ }
}
logLine(`# 模拟教练对话 · ${new Date().toISOString()} · step1→step4 全流程（本地 DeepSeek）`);

async function postCoach({ step, userMessage, session, decision, messages }) {
  turnCount += 1;
  const body = {
    question: QUESTION,
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
  const p1 = String(data.text || '').split(/\n\s*---\s*\n/)[0] || '';
  const p2 = String(data.text || '').split(/\n\s*---\s*\n/).slice(1).join('---');
  logLine(`[step${step}][t${turnCount}] 学生: ${userMessage}`);
  logLine(`[step${step}][t${turnCount}] 教练P1: ${p1.trim().slice(0, 300)}`);
  logLine(`[step${step}][t${turnCount}] 教练P2: ${p2.trim().slice(0, 300)}`);
  return data;
}

function part2Of(text) {
  const parts = String(text || '').split(/\n\s*---\s*\n/);
  return parts.length > 1 ? parts.slice(1).join('---') : (parts[0] || '');
}

// ---- 客户端 progressUpdate 合并（step1/step2 足够；step3 用 step3Data）----
function applyProgress(session, stepKey, pu, userMsg) {
  if (!pu) return;
  if (stepKey === 1 && pu.step1Data) {
    session.step1 = {
      ...session.step1,
      coachEvaluation: {
        ...(session.step1.coachEvaluation || {}),
        ...pu.step1Data,
      },
      isCompleted:
        pu.isCompleted === false
          ? false
          : Boolean(pu.isCompleted || session.step1.isCompleted),
    };
  } else if (stepKey === 2 && pu.step2Data) {
    session.step2 = {
      ...session.step2,
      userStance: pu.step2Data.userStance || session.step2.userStance || '',
      userPoints: pu.step2Data.userPoints || session.step2.userPoints || '',
      selectedThesis: pu.step2Data.suggestedStance || session.step2.selectedThesis || '',
      coachEvaluation: {
        ...(session.step2.coachEvaluation || {}),
        ...pu.step2Data,
      },
      isCompleted:
        pu.isCompleted === false
          ? false
          : Boolean(pu.isCompleted || session.step2.isCompleted),
    };
  } else if (stepKey === 3) {
    const currentStep3 = session.step3 || {};
    const subpoints = Array.isArray(currentStep3.subpoints)
      ? currentStep3.subpoints
      : [];
    const activeId =
      currentStep3.activeSubpointId || (subpoints[0] && subpoints[0].id) || '';
    const step3Ui = pu.step3Ui;
    const uiById = new Map(
      (Array.isArray(step3Ui?.bodies) ? step3Ui.bodies : []).map((b) => [
        String(b.id),
        b,
      ]),
    );
    const updatedSubpoints = subpoints.map((sp) => {
      const uiBody = uiById.get(String(sp.id));
      const next = { ...sp };
      if (uiBody) {
        next.isCompleted = !!uiBody.isCompleted;
        next.selectable = !!uiBody.selectable;
      }
      if (String(sp.id) === String(activeId)) {
        if (pu.paragraphPlan) next.paragraphPlan = pu.paragraphPlan;
        if (Array.isArray(pu.step3SubpointSteps) && pu.step3SubpointSteps.length) {
          next.structureSteps = pu.step3SubpointSteps;
        }
        if (pu.step3SlotEval) next.step3SlotEval = pu.step3SlotEval;
        if (Array.isArray(pu.step3KickoffPendingDrafts)) {
          next.kickoffPendingDrafts = pu.step3KickoffPendingDrafts;
        }
      }
      return next;
    });
    session.step3 = {
      ...currentStep3,
      ...(pu.step3Data || {}),
      subpoints: updatedSubpoints,
      activeSubpointId: step3Ui?.nextActiveSubpointId || activeId,
      isCompleted:
        pu.isCompleted === false
          ? false
          : Boolean(
              (step3Ui && step3Ui.isStep3Finished === true) ||
                pu.isCompleted ||
                currentStep3.isCompleted,
            ),
    };
  } else if (stepKey === 4 && pu.step4Data) {
    session.step4 = {
      ...session.step4,
      ...pu.step4Data,
      isCompleted:
        pu.isCompleted === false
          ? false
          : Boolean(pu.isCompleted || session.step4.isCompleted),
    };
  }
}

function makeSession() {
  return {
    topic: { question: QUESTION, questionType: 'Agree / Disagree' },
    currentStep: 1,
    step1: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
    step2: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
    step3: { isCompleted: false, subpoints: [], activeSubpointId: '', chatHistory: [] },
    step4: { isCompleted: false, tasks: [], chatHistory: [] },
  };
}

// ---- 模拟学生：按 part2 关键字作答 ----
const STEP1_DIMS = [
  '线上学习的灵活性与资源可及性（在职人员可以克服时间与空间障碍）',
  '线下课堂的互动与监督（老师能即时反馈并管理纪律）',
  '网络普及让更多人能接触到线上课程',
];
let dimIdx = 0;
// Step2 材料点池：被教练追问"再多展开点"时轮换给出新点，避免复读死循环
const STEP2_POINTS = [
  '在职人员可以在下班后的通勤时间用手机看课程回放，省去每天往返线下课堂的通勤成本。',
  '低龄学生在学校有老师现场盯着，不容易分心、学习效率更高；在家上网课则容易走神。',
  '网络普及降低了教育资源的获取门槛，偏远地区的学生也能通过线上课程接触到优质师资。',
  '线上课程可以反复回看，学生能按自己的节奏复习巩固，这对基础薄弱的学习者尤其有利。',
  '线下课堂的面对面互动是线上难以替代的，老师能即时发现学生的困惑并当面纠正。',
];
let step2PointIdx = 0;

function studentStep1(p2) {
  if (/题型|题目类型|属于|分类|哪一种/.test(p2)) {
    return '我同意这种说法，这是典型的 Agree/Disagree 题型，要讨论线上学习是否应该完全取代线下课堂。';
  }
  if (/核心|争议|议题|问题|中心/.test(p2)) {
    return '核心争议是线上教育是否应该完全取代传统的线下课堂。';
  }
  if (/限定|qualif|关键词|entirely|完全|极端/.test(p2)) {
    return '关键限定词是 entirely，也就是"完全取代"，这是一个很极端的说法。';
  }
  if (/角度|维度|方面|还有|另一个|方向/.test(p2)) {
    const d = STEP1_DIMS[dimIdx % STEP1_DIMS.length];
    dimIdx += 1;
    return d;
  }
  if (/进入第二步|第二步|够了|完成|下一步/.test(p2)) {
    return '没有了，我们进入第二步吧。';
  }
  return '我再补充一个维度：线上课程可以回放复习，这对学习效果有帮助。';
}

function studentStep2(p2, session) {
  const payload = session.step2.coachEvaluation?.plannerPayload;
  const pending = payload?.pendingProposal;
  if (pending) {
    // 提案已 arm（side_settle/stance）→ 直接采纳（走按钮语义的 decision 通道）
    return { text: '采纳', decision: { type: 'proposal', action: 'accept', proposalId: pending.proposalId } };
  }
  if (/立场|同意|不同意|态度|观点|完全同意|部分同意/.test(p2)) {
    return '我基本同意线上不应完全取代线下，但线上可以作为补充。';
  }
  if (/展开|补充|具体|场景|机制|例子|人群|详写|略写|还有|另一个|新点|角度|维度|方面|角度/.test(p2)) {
    // 被追问时轮换给出"新的"材料点，而不是复读同一句（避免 Step2 死循环）
    const pt = STEP2_POINTS[step2PointIdx % STEP2_POINTS.length];
    step2PointIdx += 1;
    return pt;
  }
  return '这个点可以从灵活性和互动性两个层面来展开。';
}

let step3BodyIdx = 0;
function studentStep3(p2, session) {
  const payload = session.step2.coachEvaluation?.plannerPayload;
  const pending = payload?.pendingProposal;
  if (pending) return { text: '采纳', decision: { type: 'proposal', action: 'accept', proposalId: pending.proposalId } };
  if (/确认|对吗|对吗？|可以吗|对不对|同意/.test(p2)) return { text: '对' };
  if (/分论点|核心观点|论点|主张|观点句/.test(p2)) {
    return '线上学习最大的优势是时间与空间上的灵活性，这让它非常适合在职和远程学习者。';
  }
  if (/原因|为什么|起因/.test(p2)) {
    return '因为线上课程把学习拆成了可以随时回放的单元，学生能完全按自己的节奏和通勤时间安排学习，打破了固定课表的限制。';
  }
  if (/机制|如何|怎么发生|通过什么|链条/.test(p2)) {
    return '具体来说，平台把每节课切片成短课，学生下班后在家用手机就能回看，系统还会记录学习进度并推送复习提醒，从而让"随时可学"真正落地。';
  }
  if (/场景|例子|比如|举例|人群|受益/.test(p2)) {
    return '比如一位在职妈妈，每天通勤两小时，她可以在通勤路上用手机看回放、在地铁里做练习题，周末再集中完成作业，这就是线上学习的典型场景。';
  }
  if (/影响|结果|好处|作用|效果/.test(p2)) {
    return '这样一来，很多原本因为时间和地点限制无法接受教育的人都能持续学习，整体上提升了教育资源在不同人群中的可及性。';
  }
  return '这个分论点主要围绕线上学习的灵活性与可及性，先讲原因，再用一个具体场景来说明。';
}

function studentStep4(p2) {
  return 'Online learning offers learners the flexibility to study at their own pace, which makes education more accessible for working adults.';
}

// ---- 驱动一个 step 直到 isCompleted（限轮次）----
async function runStep(session, step, opening, responder, maxTurns = 12) {
  let msgs = [{ sender: 'user', text: opening }];
  let pendingDecision = null;
  for (let i = 0; i < maxTurns; i++) {
    const lastUser = msgs[msgs.length - 1].text;
    const resp = await postCoach({
      step,
      userMessage: lastUser,
      session,
      messages: msgs,
      ...(pendingDecision ? { decision: pendingDecision } : {}),
    });
    pendingDecision = null;
    const p2 = part2Of(resp.text);
    applyProgress(session, step, resp.progressUpdate, lastUser);
    const st = session[`step${step}`];
    if (st?.isCompleted) {
      console.log(`  ✅ step${step} 完成（${i + 1} 轮）`);
      return;
    }
    if (i >= maxTurns - 1) {
      console.log(`  ⏸ step${step} 达轮次上限未完成（isCompleted=${!!st?.isCompleted}）`);
      return;
    }
    const ans = responder(p2, session);
    const replyText = typeof ans === 'string' ? ans : ans.text;
    if (ans && typeof ans === 'object' && ans.decision) pendingDecision = ans.decision;
    msgs = [
      ...msgs,
      { sender: 'ai', text: resp.text },
      { sender: 'user', text: replyText },
    ];
  }
}

async function main() {
  const session = makeSession();

  console.log('\n########## STEP 1 拆题 ##########');
  await runStep(session, 1, '我想分析一下这个 IELTS 题目。', studentStep1, 12);

  console.log('\n########## STEP 2 立场与论点 ##########');
  await runStep(session, 2, '我来说说我对这个题目的立场和一些论点。', studentStep2, 18);

  // Planner
  console.log('\n########## PLANNER ##########');
  const plannerRes = await fetch(`${BASE}/api/planner/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, question: QUESTION }),
  });
  const planner = await plannerRes.json().catch(() => ({}));
  if (!plannerRes.ok || planner.error) {
    console.log('  ❌ planner 失败:', planner.error || plannerRes.status);
  } else {
    console.log(`  planner status=${planner.step2_5?.status} degraded=${planner.step2_5?.degraded} bodies=${(planner.step2_5?.bodyPlans || []).length}`);
    session.step2_5 = planner.step2_5;
    // 模拟 Step3Drafting：从 bodyPlans 建 subpoints
    const bodyPlans = planner.step2_5.bodyPlans || [];
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

  console.log('\n########## STEP 3 段落逻辑链 ##########');
  await runStep(session, 3, '我们开始写第一个主体段吧。', studentStep3, 22);

  console.log('\n########## STEP 4 逐句练习 ##########');
  await runStep(session, 4, '我准备好做逐句练习了。', studentStep4, 10);

  console.log('\n===== 对话记录 =====');
  for (const t of transcript) {
    const p2 = part2Of(t.coach);
    console.log(`\n[step${t.step}] 学生: ${t.user}`);
    console.log(`[step${t.step}] 教练 part1: ${String(t.coach).split(/\n\s*---\s*\n/)[0] || ''}`.slice(0, 220));
    console.log(`[step${t.step}] 教练 part2: ${p2}`.slice(0, 260));
  }
  console.log(`\n共 ${turnCount} 轮，脚本结束。`);
  console.log(`对话记录已存档: ${TRANSCRIPT_FILE}`);
}

main().catch((e) => {
  console.error('\nJOURNEY FAILED:', e.message);
  process.exit(1);
});
