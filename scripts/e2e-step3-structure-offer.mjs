/**
 * e2e-step3-structure-offer.mjs — T3.2：真实链路验证 Step3 结构重规划要约（P3/D5 后半）。
 *
 * 场景（经真实 DeepSeek 走 chat + planner）：
 *   A) 学生表达「换第二个论点」→ 教练武装重规划要约（pendingStructureOffer），不落槽、不改结构；
 *   B) §7.6 交错测试：要约武装后，学生先正常作答一段草稿（非确认），再回「对」
 *      → 必须【不】触发重规划（step3StructureReplanned 为假、Step3 未被清空）；
 *   C) 学生再次表达结构变更 → 要约再次武装 → 学生明确「对」→ 触发重规划
 *      （step3StructureReplanned=true、Step3 进度清空、step2_5 标 stale）；
 *   D) 拒绝路径：新会话，学生表达变更 → 要约武装 → 学生回「拒绝」→ 不重规划、结构保留。
 *
 * 用法：npx tsx scripts/e2e-step3-structure-offer.mjs  （需 dev server :3000）
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
const LOGFILE = fileURLToPath(new URL('../docs/recorded-sessions/recorded-e2e-step3-offer-20260816.txt', import.meta.url));

const QUESTION =
  'With the rapid development of Artificial Intelligence (AI), some think it will bring more benefits to workers, while others fear it will cause widespread unemployment. Discuss both views and give your opinion.';

function splitCoachText(text = '') {
  const parts = String(text).split(/\n\s*---\s*\n/);
  return { p1: String(parts[0] || '').trim(), p2: parts.length > 1 ? parts.slice(1).join('---').trim() : '' };
}

async function postCoach(session, userMessage, messages, stepContext = {}) {
  const res = await fetch(`${BASE}/api/coach/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: QUESTION,
      step: 3,
      userMessage,
      messages,
      stepContext,
      session,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`HTTP ${res.status}: ${data.error || 'unknown error'}`);
  return data;
}

async function runPlanner(session) {
  const res = await fetch(`${BASE}/api/planner/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, question: QUESTION }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Planner HTTP ${res.status}: ${data.error || 'unknown error'}`);
  return data;
}

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
  return { subpoints, activeSubpointId: subpoints[0]?.id || '', chatHistory: [] };
}

function makeSession() {
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
        suggestedDimensions: ['AI 提升生产力与创造新型岗位', 'AI 取代重复性岗位导致失业'],
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
              confirmed: true,
            },
            {
              id: 'p_ai_jobloss',
              claim: 'AI 会取代大量重复性岗位导致短期失业',
              elaboration: '制造业与客服等标准化岗位首当其冲。',
              retentionRole: 'detail',
              quality: 'ready',
              leanTags: ['oppose_or_qualify'],
              seedOnly: false,
              confirmed: true,
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

/** 合并 progressUpdate 回 session（Step3：subpoints / activeSubpointId / chatHistory）。 */
function mergeStep3(session, pu) {
  if (!pu) return;
  if (Array.isArray(pu.step3SecretarySubpoints)) session.step3.subpoints = pu.step3SecretarySubpoints;
  if (pu.step3Ui && typeof pu.step3Ui.activeSubpointId === 'string' && pu.step3Ui.activeSubpointId) {
    session.step3.activeSubpointId = pu.step3Ui.activeSubpointId;
  }
  if (Array.isArray(pu.step3Ui?.subpoints)) session.step3.subpoints = pu.step3Ui.subpoints;
}

function activeSubpoint(session) {
  return (session.step3.subpoints || []).find((s) => s.id === session.step3.activeSubpointId) || null;
}

/** 跑一个 Step3 会话，返回 { replanned, cleared, offerSeen, notes } */
async function runOfferJourney(session, messages, lines, tag) {
  // kickoff
  let data = await postCoach(session, '我们开始写第一个主体段吧。', [...messages, { sender: 'user', text: '我们开始写第一个主体段吧。' }]);
  messages.push({ sender: 'user', text: '我们开始写第一个主体段吧。' });
  mergeStep3(session, data.progressUpdate);
  const ko = splitCoachText(data.text);
  lines.push(`[${tag} kickoff P1] ${ko.p1}`);
  if (ko.p2) lines.push(`[${tag} kickoff P2] ${ko.p2}`);

  // 学生先写第一点草稿
  const draft = 'AI提升生产力并催生新型高价值岗位，工人可以把时间放在更有创造性的工作上。';
  messages.push({ sender: 'user', text: draft });
  data = await postCoach(session, draft, messages);
  mergeStep3(session, data.progressUpdate);
  const d = splitCoachText(data.text);
  lines.push(`[${tag}] 学生草稿: ${draft}`);
  lines.push(`[${tag} P1] ${d.p1}`);
  if (d.p2) lines.push(`[${tag} P2] ${d.p2}`);

  return { session, messages, data };
}

async function main() {
  const lines = [];
  lines.push(`# e2e-step3-structure-offer · ${new Date().toISOString()} · 真实 DeepSeek`);
  lines.push('');

  // ============ Session 1: offer → §7.6 interleave → re-express → confirm replan ============
  lines.push('## Session 1 · 要约 + §7.6 交错 + 再表达 + 确认重规划');
  const s1 = makeSession();
  let planner = await runPlanner(s1);
  const bps1 = planner?.step2_5?.bodyPlans;
  if (!Array.isArray(bps1) || !bps1.length) {
    lines.push(`[FAIL] planner 未产出 bodyPlans (status=${planner?.step2_5?.status})`);
    console.log(lines.join('\n'));
    return;
  }
  lines.push(`[planner] bodies=${bps1.length} status=${planner?.step2_5?.status}`);
  s1.step2_5 = planner.step2_5;
  s1.step3 = buildStep3FromBodyPlans(bps1);
  const messages1 = [];

  // --- 表达结构变更 1（触发要约） ---
  let data = await postCoach(s1, '我想把第二个论点换成：AI虽然会取代部分岗位，但也会催生新的行业和职位。', messages1);
  mergeStep3(s1, data.progressUpdate);
  let t = splitCoachText(data.text);
  lines.push('[S1-1] 学生: 我想把第二个论点换成…');
  lines.push(`[S1-1 P1] ${t.p1}`);
  if (t.p2) lines.push(`[S1-1 P2] ${t.p2}`);
  const offerArmed1 = !!data.progressUpdate?.secretaryStructureOfferHint || /确认.*重规划|重新规划.*确认|请.*确认/.test(data.text);
  lines.push(`[S1-1] 要约是否武装(secretaryStructureOfferHint): ${offerArmed1 ? 'YES' : 'NO'}`);
  messages1.push({ sender: 'user', text: '我想把第二个论点换成：AI虽然会取代部分岗位，但也会催生新的行业和职位。' });

  // --- §7.6 交错：要约武装后，先正常作答，再回「对」 ---
  const normalReply = '政府还可以提供失业保险和过渡补贴，帮助失业工人平稳转型。';
  data = await postCoach(s1, normalReply, messages1);
  mergeStep3(s1, data.progressUpdate);
  t = splitCoachText(data.text);
  lines.push(`[S1-2] 学生正常作答(非确认): ${normalReply}`);
  lines.push(`[S1-2 P1] ${t.p1}`);
  if (t.p2) lines.push(`[S1-2 P2] ${t.p2}`);
  const disarmedCheck = !data.progressUpdate?.secretaryStructureOfferHint && !data.progressUpdate?.step3StructureReplanned;
  lines.push(`[S1-2] 要约是否已解除(正常作答后无重规划): ${disarmedCheck ? 'YES' : 'NO'}`);
  messages1.push({ sender: 'user', text: normalReply });

  data = await postCoach(s1, '对', messages1);
  mergeStep3(s1, data.progressUpdate);
  t = splitCoachText(data.text);
  lines.push('[S1-3] 学生: 对');
  lines.push(`[S1-3 P1] ${t.p1}`);
  if (t.p2) lines.push(`[S1-3 P2] ${t.p2}`);
  const noReplanOnBareYes = !data.progressUpdate?.step3StructureReplanned;
  const step3StillThere = (s1.step3.subpoints || []).length > 0;
  lines.push(`[S1-3] 裸"对"未触发重规划(step3StructureReplanned falsy): ${noReplanOnBareYes ? 'YES' : 'NO ❌'}`);
  lines.push(`[S1-3] Step3 未被清空(subpoints 仍存在): ${step3StillThere ? 'YES' : 'NO ❌'}`);
  messages1.push({ sender: 'user', text: '对' });

  // --- 再次表达结构变更 → 要约再次武装 ---
  data = await postCoach(s1, '我还是想把第二个论点换掉，换成讲AI创造的就业机会。', messages1);
  mergeStep3(s1, data.progressUpdate);
  t = splitCoachText(data.text);
  lines.push('[S1-4] 学生: 我还是想把第二个论点换掉…');
  lines.push(`[S1-4 P1] ${t.p1}`);
  if (t.p2) lines.push(`[S1-4 P2] ${t.p2}`);
  const offerArmed2 = !!data.progressUpdate?.secretaryStructureOfferHint || /确认.*重规划|重新规划.*确认|请.*确认/.test(data.text);
  lines.push(`[S1-4] 要约再次武装: ${offerArmed2 ? 'YES' : 'NO ❌'}`);
  messages1.push({ sender: 'user', text: '我还是想把第二个论点换掉，换成讲AI创造的就业机会。' });

  // --- 明确确认 → 触发重规划 ---
  data = await postCoach(s1, '对', messages1);
  mergeStep3(s1, data.progressUpdate);
  t = splitCoachText(data.text);
  lines.push('[S1-5] 学生: 对（明确确认）');
  lines.push(`[S1-5 P1] ${t.p1}`);
  if (t.p2) lines.push(`[S1-5 P2] ${t.p2}`);
  const replanned = !!data.progressUpdate?.step3StructureReplanned;
  const clearedSubs = Array.isArray(data.progressUpdate?.step3SecretarySubpoints)
    ? data.progressUpdate.step3SecretarySubpoints.every((sp) => !sp.isCompleted && (!Array.isArray(sp.minutes) || sp.minutes.length === 0))
    : false;
  const replanText = /已清空第三步的当前进度/.test(data.text);
  lines.push(`[S1-5] 触发重规划(step3StructureReplanned): ${replanned ? 'YES' : 'NO ❌'}`);
  lines.push(`[S1-5] 返回的 Step3 进度已清空(分钟清空/未完成): ${clearedSubs ? 'YES' : 'NO ❌'}`);
  lines.push(`[S1-5] 确定性重规划文案: ${replanText ? 'YES' : 'NO'}`);
  lines.push(`[S1-5] P1 无矛盾反问(不以"确认/是否"反问结尾): ${!/确认(要这样改吗|要改吗|要换吗)|还是先按现在的结构/.test(data.text.split('---')[0]) ? 'YES' : 'NO ⚠'}`);
  messages1.push({ sender: 'user', text: '对' });

  // --- 前端重建：重跑 planner → 重建 Step3 ---
  if (replanned) {
    planner = await runPlanner(s1);
    const bps2 = planner?.step2_5?.bodyPlans;
    if (Array.isArray(bps2) && bps2.length) {
      s1.step2_5 = planner.step2_5;
      const rebuilt = buildStep3FromBodyPlans(bps2);
      const sigOld = (bps1 || []).map((b) => b.id).join(',');
      const sigNew = bps2.map((b) => b.id).join(',');
      lines.push(`[S1-6] 重建 Step3: bodies=${bps2.length} status=${planner?.step2_5?.status}`);
      lines.push(`[S1-6] body 签名 old=[${sigOld}] new=[${sigNew}] (相同=${sigOld === sigNew ? '是' : '否'})`);
      lines.push(`[S1-6] 新 activeSubpoint=${rebuilt.activeSubpointId} points=${JSON.stringify(rebuilt.subpoints[0]?.points || [])}`);
    } else {
      lines.push('[S1-6] ⚠ planner 重建未产出 bodyPlans（需人工确认）');
    }
  }

  // ============ Session 2: 拒绝路径 ============
  lines.push('');
  lines.push('## Session 2 · 拒绝路径');
  const s2 = makeSession();
  planner = await runPlanner(s2);
  const bpsR = planner?.step2_5?.bodyPlans;
  if (Array.isArray(bpsR) && bpsR.length) {
    s2.step2_5 = planner.step2_5;
    s2.step3 = buildStep3FromBodyPlans(bpsR);
  } else {
    lines.push('[S2] planner 未产出 bodyPlans，跳过');
  }
  const messages2 = [];
  const preRejectSig = (s2.step3.subpoints || []).map((sp) => sp.id).join(',');

  data = await postCoach(s2, '我想把第二个论点换一下', messages2);
  mergeStep3(s2, data.progressUpdate);
  t = splitCoachText(data.text);
  lines.push('[S2-1] 学生: 我想把第二个论点换一下');
  lines.push(`[S2-1 P1] ${t.p1}`);
  if (t.p2) lines.push(`[S2-1 P2] ${t.p2}`);
  const offerArmedR = !!data.progressUpdate?.secretaryStructureOfferHint || /确认.*重规划|重新规划.*确认|请.*确认/.test(data.text);
  lines.push(`[S2-1] 要约是否武装: ${offerArmedR ? 'YES' : 'NO'}`);
  messages2.push({ sender: 'user', text: '我想把第二个论点换一下' });

  data = await postCoach(s2, '拒绝', messages2);
  mergeStep3(s2, data.progressUpdate);
  t = splitCoachText(data.text);
  lines.push('[S2-2] 学生: 拒绝');
  lines.push(`[S2-2 P1] ${t.p1}`);
  if (t.p2) lines.push(`[S2-2 P2] ${t.p2}`);
  const noReplanAfterReject = !data.progressUpdate?.step3StructureReplanned;
  const postRejectSig = (s2.step3.subpoints || []).map((sp) => sp.id).join(',');
  lines.push(`[S2-2] 拒绝后未触发重规划: ${noReplanAfterReject ? 'YES' : 'NO ❌'}`);
  lines.push(`[S2-2] 结构保留(pre=[${preRejectSig}] post=[${postRejectSig}]): ${preRejectSig === postRejectSig ? 'YES' : 'NO ❌'}`);

  fs.writeFileSync(LOGFILE, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log('\n[已存档]', LOGFILE);
}

main().catch((e) => {
  console.error('[e2e-step3-structure-offer 失败]', e);
  process.exit(1);
});
