/**
 * 端到端验证：Discussion Step1→Step2→Planner 真实推进。
 * 用交互存档的真实学生回答驱动服务端，打印 Step2 是否完成 + points 状态。
 * Step3 不跑（脚本素材与题型不匹配会卡，是脚本问题，与本次修复无关）。
 *
 * Run: npx tsx scripts/verify-discussion-step2.mjs
 */
const BASE = process.env.PROBE_BASE_URL || 'http://localhost:3000';
const QUESTION =
  'With the rapid development of Artificial Intelligence (AI), some think it will bring more benefits to workers, while others fear it will cause widespread unemployment. Discuss both views and give your opinion.';

function makeSession() {
  return {
    topic: { question: QUESTION, questionType: 'Discussion' },
    currentStep: 1,
    step1: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
    step2: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
    step3: { isCompleted: false, subpoints: [], activeSubpointId: '', chatHistory: [] },
    step4: { isCompleted: false, tasks: [], chatHistory: [] },
  };
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
  }
}

async function postCoach({ step, userMessage, session, messages, decision }) {
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
  if (!res.ok || data.error) throw new Error(`HTTP ${res.status} step${step}: ${data.error || 'unknown'}`);
  return data;
}

// 模拟学生：根据教练 P2 决定回复（对话式，非写死轮次）
async function main() {
  const session = makeSession();
  const messages = [];

  // ---- Step1 ----
  let msg = '我想分析一下这个 IELTS 题目。';
  messages.push({ sender: 'user', text: msg });
  let resp = await postCoach({ step: 1, userMessage: msg, session, messages });
  applyProgress(session, 1, resp.progressUpdate);
  messages.push({ sender: 'ai', text: resp.text });
  let p2 = String(resp.text).split(/\n\s*---\s*\n/).slice(1).join('---').trim();
  console.log('[step1] 学生:', msg.slice(0, 30));
  console.log('[step1] 教练P2:', p2.slice(0, 60));

  msg = '这道题是 Discussion 题型，要分别讨论 AI 对劳动者带来的好处和失业风险，再给出我自己的观点。';
  messages.push({ sender: 'user', text: msg });
  resp = await postCoach({ step: 1, userMessage: msg, session, messages });
  applyProgress(session, 1, resp.progressUpdate);
  messages.push({ sender: 'ai', text: resp.text });
  p2 = String(resp.text).split(/\n\s*---\s*\n/).slice(1).join('---').trim();
  console.log('[step1] 学生: Discussion 题型...');
  console.log('[step1] 教练P2:', p2.slice(0, 60));
  console.log('step1 isCompleted =', !!session.step1.isCompleted);

  // ---- Step2：对话式驱动 ----
  const studentPoints = [
    '我认为 AI 总体利大于弊，但需要配套再培训来缓冲失业冲击。第一个论点：AI 接管重复性劳动后，把人们解放出来转向创意与协作型工作，比如客服岗位的工人经过培训后转型做数据标注和算法训练的质量审核，催生了更多新型高价值岗位。',
    '第二个论点：AI 会取代制造业、客服等标准化程度高的岗位，导致部分工人短期失业，比如流水线上的质检员被机器视觉系统替代后需要重新找工作。第三个论点：应对办法是政府与企业联合推出再培训计划，帮助受冲击的工人学习数据分析、人机协作等新技能，比如德国针对汽车工人的转岗培训。',
  ];
  const extra = [
    '还有一个论点：AI 提升整体生产效率和企业竞争力后，企业利润增长会带动更多相关岗位的扩张，比如电商用 AI 优化供应链后，仓储物流和售后客服反而招了更多人手。',
    '还有一个论点：AI 在教育、医疗等公共服务领域能显著提升服务质量和覆盖面，比如智能辅导系统让偏远地区的学生也能获得个性化学习支持，缩小了教育资源差距。',
  ];
  let pi = 0;
  msg = '我来说说我对这个题目的立场和一些论点。';
  messages.push({ sender: 'user', text: msg });
  let step2Completed = false;
  for (let t = 0; t < 32; t++) {
    resp = await postCoach({ step: 2, userMessage: msg, session, messages });
    applyProgress(session, 2, resp.progressUpdate);
    messages.push({ sender: 'ai', text: resp.text });
    const text = String(resp.text || '');
    const parts = text.split(/\n\s*---\s*\n/);
    const p1 = parts[0] || '';
    p2 = parts.slice(1).join('---').trim();
    const payload = session.step2?.coachEvaluation?.plannerPayload || {};
    const ready = (payload.points || []).filter((p) => !p.supersededBy && p.quality === 'ready').length;
    const nPoints = (payload.points || []).filter((p) => !p.supersededBy).length;
    console.log(`\n[t${t}] isCompleted=${!!session.step2.isCompleted} points=${nPoints} ready=${ready}`);
    console.log(`[t${t}] 学生: ${msg.slice(0, 40)}${msg.length > 40 ? '…' : ''}`);
    console.log(`[t${t}] 教练P2: ${p2.slice(0, 90) || '(空)'}`);

    if (session.step2.isCompleted) { step2Completed = true; console.log('\n>>> Step2 完成！'); break; }

    // 决策下一步回复（顺序重要：先识别"确认进入下一步"，再识别立场/采纳）
    if (/材料池和立场已经齐了|确认进入下一步|请确认进入|确认完成|全部齐了|没有要改/.test(p2)) {
      msg = '确认进入下一步';
      messages.push({ sender: 'user', text: msg });
      continue;
    }
    // 教练明确在补缺侧材料（含刚锁定一侧详略后的"接下来只补真正缺失的材料类别"）：
    // 必须给点，不能回"采纳"。置于"采纳/详略"分支之前，否则"已锁定"会抢先命中。
    if (/缺失的材料类别|只补真正缺失|「观点A」当前|「观点B」当前|还差至少|请给出至少 1 个具体主张/.test(p2)) {
      msg = pi < studentPoints.length ? studentPoints[pi++] : (extra.shift() || '再补一个：AI 会推动企业重塑组织架构，把裁员视为最后手段，转而通过内部转岗消化冲击，所以长期就业总量未必下降。');
      messages.push({ sender: 'user', text: msg });
      continue;
    }
    if (/采纳|推荐立场|锁定/.test(p2) && /推荐立场|采纳.*立场/.test(p2)) {
      msg = '采纳';
      messages.push({ sender: 'user', text: msg });
      continue;
    }
    if (/采纳|详写|略写|方案|锁定/.test(p2) && !/推荐立场/.test(p2)) {
      msg = '采纳';
      messages.push({ sender: 'user', text: msg });
      continue;
    }
    if (/材料还不够|请再给出|至少再展开|补\s*1|写满两处/.test(p2)) {
      msg = pi < studentPoints.length ? studentPoints[pi++] : (extra.shift() || '这些已经足够具体了，我确认这些论点并进入下一步。');
      messages.push({ sender: 'user', text: msg });
      continue;
    }
    if (/立场|倾向|同意还是不同意|利大于弊|弊大于利|部分同意/.test(p2)) {
      msg = '采纳';
      messages.push({ sender: 'user', text: msg });
      continue;
    }
    if (/进入下一步|足够|整理.*进入/.test(p2)) {
      msg = '确认进入下一步';
      messages.push({ sender: 'user', text: msg });
      continue;
    }
    // 默认：确认
    msg = '好的，我们继续。';
    messages.push({ sender: 'user', text: msg });
  }
  console.log('\nstep2 isCompleted =', !!session.step2.isCompleted, step2Completed ? '✅' : '❌');

  // ---- Planner ----
  if (session.step2.isCompleted) {
    const plannerRes = await fetch(`${BASE}/api/planner/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, question: QUESTION }),
    });
    const planner = await plannerRes.json().catch(() => ({}));
    if (!plannerRes.ok || planner.error) {
      console.log('❌ planner 失败:', planner.error || plannerRes.status);
    } else {
      console.log('planner status=', planner.step2_5?.status, 'degraded=', planner.step2_5?.degraded, 'bodies=', (planner.step2_5?.bodyPlans || []).length);
    }
  }
  process.exit(session.step2.isCompleted ? 0 : 1);
}

main().catch((e) => { console.error('验证失败:', e.message); process.exit(1); });
