/**
 * e2e-step3-trigger.mjs — 聚焦验证 Step3 structure_change 触发器的 LLM 识别可靠性。
 * 用更明确的句式（结构不合适 + 换掉分论点）探测 assess LLM 是否会返回 intent=structure_change
 * 并武装 secretaryStructureOfferHint（真实 hint，非文案正则误判）。
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
const LOGFILE = fileURLToPath(new URL('../docs/recorded-sessions/recorded-e2e-step3-trigger-20260816.txt', import.meta.url));
const QUESTION =
  'With the rapid development of Artificial Intelligence (AI), some think it will bring more benefits to workers, while others fear it will cause widespread unemployment. Discuss both views and give your opinion.';

async function postCoach(session, userMessage, messages) {
  const res = await fetch(`${BASE}/api/coach/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: QUESTION, step: 3, userMessage, messages, stepContext: {}, session }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`HTTP ${res.status}: ${data.error || 'unknown'}`);
  return data;
}
async function runPlanner(session) {
  const res = await fetch(`${BASE}/api/planner/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, question: QUESTION }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Planner HTTP ${res.status}`);
  return data;
}
function isClaim(t) {
  const s = String(t || '').trim();
  return s.length >= 8;
}
function makeSession() {
  return {
    topic: { question: QUESTION, questionType: 'Discussion' },
    currentStep: 2,
    step1: { isCompleted: true, coachEvaluation: { correctType: 'Discussion', coreIssue: 'x', constraints: ['both views', 'opinion'], suggestedDimensions: ['a', 'b'], dimensionsSufficient: true, exitOffered: true } },
    step2: { isCompleted: true, currentStage: 'summary', userStance: 'AI 利大于弊', userPoints: 'A面：AI 创造新岗位（已选详写）；B面：AI 导致失业（已选略写）', coachEvaluation: { currentStage: 'summary', userStance: 'AI 利大于弊', requiresStance: true, plannerPayload: {
      version: 1, status: 'ready', updatedAt: new Date().toISOString(), questionType: 'Discussion', requiresStance: true, redirects: {},
      stance: { text: 'AI 利大于弊', polarity: 'agree', strength: 'balanced' },
      points: [
        { id: 'p1', claim: 'AI 提升生产力并催生新型高价值岗位', elaboration: 'AI 接管重复劳动后，工人转向创意与协作型工作。', retentionRole: 'detail', quality: 'ready', leanTags: ['support_main'], seedOnly: false, confirmed: true },
        { id: 'p2', claim: 'AI 会取代大量重复性岗位导致短期失业', elaboration: '制造业与客服等标准化岗位首当其冲。', retentionRole: 'detail', quality: 'ready', leanTags: ['oppose_or_qualify'], seedOnly: false, confirmed: true },
      ],
      coverage: { passed: true, requiredBuckets: ['support_main', 'oppose_or_qualify'], filledBuckets: ['support_main', 'oppose_or_qualify'], missingBuckets: [], softMissingBuckets: [] },
      exitGate: { canComplete: true, canForceExit: false, forceExitUsed: false },
    } } },
    step3: { isCompleted: false, subpoints: [], activeSubpointId: '', chatHistory: [] },
  };
}
function mergeStep3(session, pu) {
  if (!pu) return;
  if (Array.isArray(pu.step3SecretarySubpoints)) session.step3.subpoints = pu.step3SecretarySubpoints;
  if (pu.step3Ui?.activeSubpointId) session.step3.activeSubpointId = pu.step3Ui.activeSubpointId;
}
function split(text = '') {
  const parts = String(text).split(/\n\s*---\s*\n/);
  return { p1: String(parts[0] || '').trim(), p2: parts.length > 1 ? parts.slice(1).join('---').trim() : '' };
}

async function main() {
  const lines = [];
  const s = makeSession();
  const planner = await runPlanner(s);
  const bps = planner?.step2_5?.bodyPlans;
  if (!Array.isArray(bps) || !bps.length) { console.log('[FAIL] no bodyPlans'); return; }
  s.step2_5 = planner.step2_5;
  s.step3 = { subpoints: bps.map((b) => ({ id: b.id, content: b.theme || b.targetBody, points: (b.mappedPoints || []).filter(isClaim), targetBody: b.targetBody, theme: b.theme, frameworkSignature: b.id, isCompleted: false, chatHistory: [] })), activeSubpointId: bps[0]?.id, chatHistory: [] };
  const messages = [];

  const phrases = [
    '我觉得现在的段落结构不太合适，第二个分论点我想换掉，换成一个更有说服力的角度。',
    '我不想按现在的两段结构写了，想重新规划一下。',
  ];

  for (let i = 0; i < phrases.length; i++) {
    messages.push({ sender: 'user', text: phrases[i] });
    const data = await postCoach(s, phrases[i], messages);
    mergeStep3(s, data.progressUpdate);
    const t = split(data.text);
    lines.push(`# 探测 ${i + 1}: ${phrases[i]}`);
    lines.push(`P1: ${t.p1}`);
    if (t.p2) lines.push(`P2: ${t.p2}`);
    const hint = !!data.progressUpdate?.secretaryStructureOfferHint;
    const landed = !!data.progressUpdate?.secretaryActiveSlot; // slot 存在不代表 landed，仅参考
    const subpointState = s.step3.subpoints.find((x) => x.id === s.step3.activeSubpointId);
    const heldCount = (subpointState?.minutes || []).filter((m) => m.status === 'held').length;
    const landedCount = (subpointState?.minutes || []).filter((m) => m.status === 'landed').length;
    lines.push(`→ secretaryStructureOfferHint(真实要约): ${hint ? 'YES' : 'NO'}`);
    lines.push(`→ 该消息落槽: ${landedCount > 0 ? 'YES(landed)' : 'NO'}`);
    lines.push('');
  }

  fs.writeFileSync(LOGFILE, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log('\n[已存档]', LOGFILE);
}
main().catch((e) => { console.error('失败', e); process.exit(1); });
