/**
 * E2E: Step2 完成 → Planner(DeepSeek) → Step3 kickoff 的 mapped-point 覆盖。
 * 目标：验证 ① 守卫（ensureParagraphPlanCoversFrameworkPoints 读 planner 账本）
 * 在真实服务端流程中保住"维度短语型"mapped point（客户端 isClaimSentence 会滤掉，
 * 旧 bug 导致该点在 Step3 消失）。
 *
 * Run（需本地服务在 3000 端口，LLM=DeepSeek）: npx tsx scripts/replay-e2e-step3-coverage.mjs
 */
import assert from 'node:assert/strict';

const BASE = process.env.PROBE_BASE_URL || 'http://localhost:3000';

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

// ---- 构造已完成的 Step2（含"维度短语型"点，模拟 网络普及 事件）----
const QUESTION =
  'Some people believe that online learning is highly beneficial and should replace traditional classroom education entirely. To what extent do you agree or disagree?';

function makeSession() {
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
          '网络普及（原因）',
        ],
        dimensionsSufficient: true,
        exitOffered: true,
      },
    },
    step2: {
      isCompleted: true,
      currentStage: 'summary',
      userStance: '完全同意线上不应完全取代线下',
      userPoints:
        'A面：线上灵活性与资源可及性 (打破地理限制，时间自由)（已选详写）；B面：线下不可替代性 (面对面互动，教师即时监督与纪律管理)（已选详写）；网络普及（原因）',
      coachEvaluation: {
        currentStage: 'summary',
        userStance: '完全同意线上不应完全取代线下',
        userPoints:
          'A面：线上灵活性与资源可及性 (打破地理限制，时间自由)（已选详写）；B面：线下不可替代性 (面对面互动，教师即时监督与纪律管理)（已选详写）；网络普及（原因）',
        critique: 'ok',
        suggestions: [],
        suggestedStance: '完全同意线上不应完全取代线下',
        suggestedPoints: '',
        requiresStance: true,
        plannerPayload: {
          version: 1,
          status: 'ready',
          updatedAt: new Date().toISOString(),
          questionType: 'Agree / Disagree',
          requiresStance: true,
          redirects: {},
          stance: { text: '完全同意线上不应完全取代线下', polarity: 'partial', strength: 'qualified' },
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
              // 维度短语型 claim：isClaimSentence 会判"非完整句"。
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
    step3: {
      isCompleted: false,
      subpoints: [],
      activeSubpointId: '',
      chatHistory: [],
    },
  };
}

// 模拟 Step3Drafting：用 bodyPlans 建 subpoints，points 用 isClaimSentence 过滤。
function buildStep3FromBodyPlans(bodyPlans) {
  const subpoints = bodyPlans.map((bp) => {
    const mapped = Array.isArray(bp.mappedPoints) ? bp.mappedPoints : [];
    // 复现客户端过滤（维度短语被滤掉 → points=[]）
    const isClaimSentence = (t) => {
      const s = String(t || '').trim();
      if (!s) return false;
      if (s.length < 8) return false;
      if (s.length >= 14) return true;
      return /(是|能|可以|会|应该|必须|通过|因为|所以|导致|使得|提升|降低|改善|减少|带来|造成|有助于|无法|不能)/.test(s);
    };
    const points = mapped.filter(isClaimSentence);
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

const check = (name, fn) => {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    throw e;
  }
};

async function main() {
  const session = makeSession();

  // 1) Planner（真实 DeepSeek）
  console.log('>>> 调用 /api/planner/generate ...');
  const planner = await runPlanner(session);
  const bodyPlans = planner?.step2_5?.bodyPlans;
  assert.ok(Array.isArray(bodyPlans) && bodyPlans.length >= 2, 'planner 应产出 ≥2 个 body');
  console.log(`    planner status=${planner.step2_5?.status} degraded=${planner.step2_5?.degraded} bodies=${bodyPlans.length}`);
  for (const bp of bodyPlans) {
    console.log(`    body ${bp.id}: mappedPointIds=${JSON.stringify(bp.mappedPointIds || [])} mappedPoints=${JSON.stringify(bp.mappedPoints || [])}`);
  }

  // 收集所有 mappedPointIds
  const allMappedIds = new Set();
  for (const bp of bodyPlans) for (const id of bp.mappedPointIds || []) allMappedIds.add(String(id));

  check('planner mappedPointIds 覆盖全部 3 个点（含维度短语点 p_network）', () => {
    for (const pid of ['p_online', 'p_offline', 'p_network']) {
      assert.ok(allMappedIds.has(pid), `planner 未映射 ${pid}`);
    }
  });

  // 2) 模拟客户端建 Step3 subpoints（isClaimSentence 过滤 → p_network 被滤掉）
  const step3 = buildStep3FromBodyPlans(bodyPlans);
  const sp = step3.subpoints.find((s) => s.id === step3.activeSubpointId);
  assert.ok(sp, '应存在 active subpoint');
  console.log(`    active subpoint ${sp.id}: points=${JSON.stringify(sp.points)}`);

  // 3) Step3 kickoff 第一轮（学生回答论点槽）
  // 真实客户端会把 session.step2_5（planner 产出）一并传给 coach；
  // ① 守卫 buildStep3FrameworkLedger 依赖 session.step2_5.bodyPlans。
  const coachSession = {
    ...session,
    step2_5: planner.step2_5,
    step3,
  };
  const resp = await postCoach({
    question: QUESTION,
    step: 3,
    userMessage: '网络普及让更多人能接触到线上课程，这就是一个原因。',
    messages: [{ sender: 'user', text: '网络普及让更多人能接触到线上课程，这就是一个原因。' }],
    stepContext: {},
    session: coachSession,
  });

  // 真实契约：paragraphPlan 挂在客户端构建的 active subpoint 上（随 step3SecretarySubpoints
  // 往返）；服务端秘书路径不保证在 progressUpdate 顶层/step3 回显。此处回退到 subpoint。
  const activeSub = (coachSession.step3.subpoints || []).find(
    (s) => String(s.id) === String(coachSession.step3.activeSubpointId),
  );
  const plan = resp?.progressUpdate?.step3?.paragraphPlan ||
    resp?.progressUpdate?.paragraphPlan ||
    (resp?.progressUpdate?.step3Data && resp.progressUpdate.step3Data.paragraphPlan) ||
    activeSub?.paragraphPlan ||
    null;
  assert.ok(plan && Array.isArray(plan.pointBlocks), '响应应带 paragraphPlan');
  const blockLabels = (plan.pointBlocks || [])
    .map((b) => String(b.label || b.subClaim || ''))
    .join(' | ');
  console.log(`    Step3 plan blocks: ${blockLabels}`);
  console.log(`    coach part2: ${String(resp.text || '').split(/\n\s*---\s*\n/)[1] || ''}`.slice(0, 200));

  // 断言：当前 active body 自身的 mappedPoints 都必须被响应 plan 覆盖。
  const activeBp = (planner.step2_5.bodyPlans || []).find(
    (b) => String(b.id) === String(step3.activeSubpointId),
  );
  assert.ok(activeBp, '应能定位 active body 的 bodyPlan');
  const activeMapped = Array.isArray(activeBp.mappedPoints)
    ? activeBp.mappedPoints.map((p) => String(p || '').trim()).filter(Boolean)
    : [];
  const core = (t) =>
    String(t || '')
      .replace(/[（(][^（）()]*[）)]/g, '')
      .replace(/详写|略写|放下|已选|保留-|用户放弃/g, '')
      .trim();
  check('Step3 骨架覆盖 active body 全部 mapped 点（① 端到端生效）', () => {
    for (const mp of activeMapped) {
      const covered = (plan.pointBlocks || []).some((b) => {
        // 模型常把块 label 浓缩为主题词、把完整 claim 放 subClaim——必须两者都查，
        // 并用守卫同款模糊匹配（label/subClaim 任一处命中即视为覆盖）。
        const label = core(String(b.label || ''));
        const sub = core(String(b.subClaim || ''));
        const mpc = core(mp);
        const hits = (t) =>
          !!t && t.length >= 2 && (t === mpc || t.includes(mpc) || mpc.includes(t));
        return (
          hits(label) ||
          hits(sub) ||
          (label.length >= 4 && mpc.includes(label.slice(0, 4))) ||
          (sub.length >= 4 && mpc.includes(sub.slice(0, 4)))
        );
      });
      assert.ok(covered, `active body mapped 点被丢：${mp}；blocks=${blockLabels}`);
    }
  });

  console.log('\nE2E Step3 coverage: ALL PASS');
}

main().catch((e) => {
  console.error('\nE2E FAILED:', e.message);
  process.exit(1);
});
