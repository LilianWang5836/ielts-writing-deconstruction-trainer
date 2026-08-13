/**
 * E2E（多题型 · 我扮演学生）：对 3 种 IELTS Task 2 题型各驱动一次完整旅程。
 *
 * 与 replay-full-typen 的区别：学生应答器按教练 P2 的语义分类作答（题型识别/
 * 维度/补论点/详略采纳/立场/确认进入下一步/Step3 各槽/Step4 场景），并且
 * Step3 素材围绕"当前 body 的 mapped point"动态构造（不再用固定的在线学习
 * 素材，避免答非所问）。尽量走完；中途问题先记录到 /tmp/student-issues.log，
 * 跑完后再分析。
 *
 * Run: npx tsx scripts/replay-student-multi.mjs   （默认跑 3 题型）
 *      ONLY_TYPE=discussion npx tsx scripts/replay-student-multi.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.PROBE_BASE_URL || 'http://localhost:3000';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.join(scriptDir, '..', 'docs', 'recorded-sessions');
fs.mkdirSync(docsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const ISSUES = '/tmp/student-issues.log';
fs.writeFileSync(ISSUES, '', 'utf8');
const issue = (typeSlug, step, msg) => {
  const line = `[${typeSlug}][step${step}] ${msg}`;
  try { fs.appendFileSync(ISSUES, `${line}\n`); } catch (e) { /* ignore */ }
  console.log(`    ⚠️  ${msg}`);
};

let CURRENT_QUESTION = '';
let CURRENT_TYPE = null;

// ---- 3 种题型配置（含 Step3 按题型模板） ----
const TYPES = [
  {
    slug: 'agree-disagree',
    name: 'Agree/Disagree（在线学习）',
    question:
      'Some people believe that online learning is highly beneficial and should replace traditional classroom education entirely. To what extent do you agree or disagree?',
    questionType: 'Agree / Disagree',
    typeName: '这是 Agree/Disagree 题型，要判断在线学习是否应该完全取代线下课堂。',
    coreIssue: '核心争议是线上教育是否应完全取代线下课堂。',
    qualifier: '关键限定词是 entirely（完全），这是很极端的说法，论证时要回应。',
    dims: ['线上学习的灵活性与资源可及性', '线下课堂的互动与监督', '网络普及让更多人能接触线上课程'],
    stance: '我倾向于部分同意：线上优势明显，但不应完全取代线下。',
    points: [
      { cat: 'benefit', text: '在职人员能利用通勤、午休等零散时间在线学习，省去往返线下课堂的时间成本。' },
      { cat: 'benefit', text: '低龄学生在学校有老师现场监督，不易分心；在家上网课则容易走神。' },
      { cat: 'benefit', text: '网络普及让偏远地区也能接触到线上课程，降低了教育资源获取门槛。' },
    ],
    // Step3 各槽模板：接收当前 body 主题（mapped point claim 前段）
    step3: {
      reason: (th) => `因为在职人员平时工作繁忙、通勤耗时，很难按固定时间到线下教室上课；零散时间在线学习正好能把被浪费的通勤和午休利用起来，这正是它对在职人员特别重要的原因。`,
      mechanism: (th) => `具体机制是：平台把课程切成短课时，配合自动记录进度与提醒复习，学习者利用零散时间逐段完成，系统持续追踪。`,
      scenario: (th) => `比如一位在职的家长，通勤路上用手机完成一小节，午休再学一段，周末集中补齐，完全绕开往返教室的硬性时间。`,
      impact: (th) => `这样一来，原本受时空约束无法学习的人也能持续投入，教育资源向更广人群开放，这是替代线下不可得的增量价值。`,
    },
  },
  {
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
    step3: {
      reason: (th) => `因为${th || '这一影响'}的根源在于 AI 擅长处理规则明确、可重复的任务，替代后释放的人力需要向更高阶的技能迁移。`,
      mechanism: (th) => `具体机制是：AI 在效率与成本上优于人力后，企业会扩大自动化投入，被替代岗位的工人经过再培训转向数据标注、算法质检等新岗位。`,
      scenario: (th) => `比如客服岗位的工人转型做数据标注与算法训练的质量审核，流水线质检员转岗到设备维护，这些都是可落地的真实路径。`,
      impact: (th) => `最终效果是岗位结构从低技能重复劳动转向高技能协作，整体生产率与就业质量同时提升，这正是支持面主张成立的关键。`,
    },
  },
  {
    slug: 'problem-solution',
    name: 'Problem/Solution（高糖食品）',
    question:
      'The increasing consumption of sugar-rich foods and drinks is leading to serious health problems worldwide. What are the causes of this issue, and what solutions can be implemented to solve it?',
    questionType: 'Problem/Solution',
    typeName: '这是 Problem/Solution 题型，要分析高糖食品问题的原因并给出解决措施。',
    coreIssue: '核心是高糖食品消费的原因与可落地的解决措施。',
    qualifier: '要同时覆盖 causes 和 solutions 两方面。',
    dims: ['高糖饮食的原因（便利食品/广告）', '缓解措施（糖税/营养标签/教育）', '政府与个人责任分工'],
    stance: '',
    points: [
      { cat: 'cause', text: '含糖食品与饮料更便宜、更易得，加上广告的反复引导，人们逐渐养成高糖饮食习惯。' },
      { cat: 'solution', text: '应通过征收糖税、强制营养标识和公共健康教育来减少含糖食品的摄入。' },
      { cat: 'solution', text: '还应引导食品行业改良配方，在不过度牺牲口味的前提下降低含糖量。' },
    ],
    step3: {
      reason: (th) => `因为${th || '高糖问题的根源'}在于便宜易得与广告诱导共同抬高了含糖食品的消费，糖分摄入远超身体所需。`,
      mechanism: (th) => `具体机制是：便利店与自动售货机让高糖饮品随手可得，营销强化了“快乐/解渴”联想，价格优势又压过健康选项，形成惯性。`,
      scenario: (th) => `比如青少年每天在便利店购买含糖饮料且几乎不受约束，家长与学校干预有限，长期积累导致肥胖和糖尿病高发。`,
      impact: (th) => `通过糖税提高含糖食品价格、强制营养标签与校园健康教育，可改变消费决策环境，从源头抑制高糖摄入。`,
    },
  },
];

// ---- Step4 英文素材（题型相关） ----
const STEP4_POOL = {
  'agree-disagree': [
    'This approach offers learners the flexibility to study at their own pace, which makes it more accessible for many groups.',
    'People can fit learning around their daily routine because the content is available anytime and anywhere.',
    'A working parent can study on the phone during the daily commute and catch up on assignments at the weekend.',
  ],
  discussion: [
    'Artificial intelligence can take over repetitive tasks and free workers to move into more creative and collaborative roles.',
    'Companies that adopt AI tend to expand hiring in new areas such as data labelling and quality control.',
    'Governments and firms should join forces to retrain displaced workers for the jobs the new technology creates.',
  ],
  'problem-solution': [
    'The low price and easy availability of sugary products, reinforced by advertising, drive excessive sugar consumption.',
    'A sugar tax combined with clear nutrition labels can discourage the purchase of unhealthy food and drinks.',
    'Public education in schools can help young people develop healthier eating habits from an early age.',
  ],
};

function splitText(text = '') {
  const parts = String(text).split(/\n\s*---\s*\n/);
  return { p1: String(parts[0] || '').trim(), p2: parts.length > 1 ? parts.slice(1).join('---').trim() : '' };
}

// ---- 单题型运行状态 ----
let turnCount = 0;
let archiveFile = '';
let logLine = () => {};
let step2Idx = 0;
let usedPoints = new Set();
let step3RoleCount = {};
let step3Stalls = 0;
let lastStep3P2 = '';
let step4Idx = 0;
let step4PasteCount = 0;
let pendingDecision = null;

function activeSubpoint(session) {
  return (session?.step3?.subpoints || []).find(
    (s) => String(s.id) === String(session?.step3?.activeSubpointId || ''),
  );
}

/** 当前 body 的主题（mapped point claim 或 subpoint content）。 */
function subpointTheme(session) {
  const sp = activeSubpoint(session);
  const pts = Array.isArray(sp?.points) ? sp.points.filter(Boolean) : [];
  if (pts.length) return String(pts[0]).replace(/[（(][^）)]*[）)]/g, '').trim().slice(0, 30);
  return String(sp?.content || '').trim().slice(0, 30);
}

function toFullClaim(theme) {
  const t = String(theme || '').trim();
  if (!t) return '这个分论点需要围绕主要价值展开。';
  if (
    t.length >= 10 &&
    /(是|能|可以|会|应该|必须|通过|因为|所以|导致|使得|提升|降低|改善|减少|带来|造成|有助于|推动|催生|促进|缓解|盛行|流行|取代)/.test(t)
  ) {
    return t;
  }
  // 紧扣主题词生成完整主张句（不再用"对相关人群产生显著影响"这种空泛模板）
  if (/原因|成因|为什么/.test(t)) return `高糖饮食之所以盛行，主要是因为价格低廉、随处可得，加上广告反复引导，人们逐渐养成高糖摄入的习惯。`;
  if (/失业|取代|岗位/.test(t)) return `AI 会取代制造业、客服等标准化程度高的岗位，导致部分工人短期失业，需要配套再培训来缓冲冲击。`;
  if (/在线学习|线上|灵活|便利/.test(t)) return `在线学习让学习者能自主安排时间，因此像在职人员这样的群体可以利用通勤、午休等零散时间学习。`;
  return `${t}对相关人群产生显著影响，需要通过针对性措施来落实和保障。`;
}

// ---- 我扮演学生：Step1 ----
function studentStep1(p2, type, session) {
  if (/题型|题目类型|属于|分类|哪一种/.test(p2)) return type.typeName;
  if (/核心|争议|议题|问题|中心|争论/.test(p2)) return type.coreIssue;
  if (/限定|qualif|关键词|entirely|完全|both views|extreme/.test(p2)) return type.qualifier;
  if (/维度|方面|角度|比较|展开|哪几个/.test(p2)) {
    return type.dims.join('、') + '。';
  }
  if (/任务|完成什么|一句话/.test(p2)) {
    return type.slug === 'problem-solution'
      ? '要说明高糖食品问题的原因，并给出可行的解决措施。'
      : type.slug === 'discussion'
        ? '要分别讨论 AI 对劳动者的好处与失业风险，再给出我的观点。'
        : '要判断在线学习是否应完全取代线下课堂，并论证我的立场。';
  }
  return '我觉得可以从几个核心方面来展开分析。';
}

// ---- 我扮演学生：Step2 ----
function studentStep2(p2, type, session) {
  if (pendingDecision) return { text: '采纳', decision: pendingDecision };
  const payload = CURRENT_TYPE ? {} : {};
  // 确认进入下一步（优先判断，避免被"立场"字样误命中）
  if (/材料池和立场已经齐了|确认进入下一步|请确认进入|没有要改|全部齐了/.test(p2)) {
    return '确认进入下一步';
  }
  // 立场推荐 → 采纳（或用题型立场句，若教练在询问）
  if (/推荐立场|采纳.*立场|锁定.*立场|你更倾向|同意还是不同意|利大于弊|弊大于利/.test(p2)) {
    if (type.stance && /你更倾向|同意还是不同意|写一下|说出|用一句话/.test(p2)) return type.stance;
    return '采纳';
  }
  // 详略方案采纳
  if (/采纳|详写|略写|方案|锁定/.test(p2) && !/推荐立场/.test(p2)) {
    return '采纳';
  }
  // seedOnly 展开提示："「某点」目前还偏薄：请补 1–2 句具体场景、机制或受影响对象"
  if (/目前还偏薄|还偏薄|请补\s*1\s*[–-]?\s*2\s*句|方便写成可展开的论据|在第一步你提到过/.test(p2)) {
    // 点名了某个点 → 给该点的具体展开；否则给下一个未用点
    const pool = Array.isArray(type.points) ? type.points : [];
    const next = pool.find((pt) => !usedPoints.has(pt.text));
    if (next) {
      usedPoints.add(next.text);
      return `这个论点可以展开为：${next.text}`;
    }
    return '我把它展开为：正因为不受固定时间地点限制，相关人群能真正利用零散时间投入学习，从而长期坚持。';
  }
  // 开放性补点："还有没有其他受益人群或具体场景/比如..."
  if (/还有没有|还有哪些|其他受益|其他.*人群|具体场景|比如.*偏远|比如.*人群|别的.*角度/.test(p2)) {
    const pool = Array.isArray(type.points) ? type.points : [];
    const next = pool.find((pt) => !usedPoints.has(pt.text));
    if (next) {
      usedPoints.add(next.text);
      return next.text;
    }
    return '这些材料已经足够具体了，我确认这些论点并进入下一步。';
  }
  // 补论点（含"缺失材料类别 / 请给出至少 1 个"这类 bucket 提示）
  if (
    /材料还不够|请再给出|至少再展开|写满两处|补\s*1\s*个|再展开\s*1|缺失的材料类别|请给出至少 1 个具体主张|只补真正缺失/.test(p2)
  ) {
    // 定向：教练点名补哪类材料 → 优先给对应类别，其次给未用点
    const wantCause = /原因|成因/.test(p2);
    const wantSolution = /解决|措施/.test(p2);
    const pool = Array.isArray(type.points) ? type.points : [];
    let next = null;
    if (wantCause || wantSolution) {
      next = pool.find(
        (pt) =>
          !usedPoints.has(pt.text) &&
          (wantCause ? pt.cat === 'cause' || pt.cat === 'solution' : pt.cat === 'solution'),
      );
    }
    if (!next) next = pool.find((pt) => !usedPoints.has(pt.text));
    if (next) {
      usedPoints.add(next.text);
      return next.text;
    }
    return '这些材料已经足够具体了，我确认这些论点并进入下一步。';
  }
  if (/立场|倾向|观点/.test(p2)) return type.stance || '采纳';
  if (/进入下一步|确认完成|足够|整理.*进入/.test(p2)) return '确认进入下一步';
  return '好的，我们继续。';
}

// ---- 我扮演学生：Step3（按当前 body 主题动态展开） ----
/** 当前第一个 value 为空的 Step3 槽 label（从 paragraphPlan 读取）。 */
function pendingStep3Slot(session) {
  const sp = activeSubpoint(session);
  const plan = sp?.paragraphPlan;
  if (plan && Array.isArray(plan.pointBlocks)) {
    for (const b of plan.pointBlocks) {
      if (!Array.isArray(b?.steps)) continue;
      for (const s of b.steps) {
        if (!String(s?.value || '').trim()) {
          return { block: String(b?.label || ''), slot: String(s?.label || '展开') };
        }
      }
    }
  }
  if (Array.isArray(sp?.structureSteps)) {
    const p = sp.structureSteps.find((s) => !String(s?.value || '').trim());
    if (p) return { block: String(sp?.content || '').slice(0, 16), slot: String(p?.label || '展开') };
  }
  return null;
}

function studentStep3(p2, type, session) {
  if (pendingDecision) return { text: '采纳', decision: pendingDecision };
  if (/采纳|确认|对吗|可以吗|对不对|同意|确认写入|点击.*确认/.test(p2)) return '对';
  if (!String(p2 || '').trim()) return '对';

  // 看板 truth 优先：第一个空槽决定该答什么（服务端 P2 常滞后，不能只信 P2）。
  const pending = pendingStep3Slot(session);
  const slotLabel = pending?.slot || '';
  let role = 'meta';
  if (/分论点|核心观点|论点|主张|观点句|claim/.test(slotLabel)) role = 'claim';
  else if (/展开原因|原因|为什么|起因/.test(slotLabel)) role = 'reason';
  else if (/机制|过程|怎么发生|链条|操作|实现/.test(slotLabel)) role = 'mechanism';
  else if (/结果|影响|后果|好处|作用|效果/.test(slotLabel)) role = 'impact';
  else if (/场景|例子|举例|典型|人群/.test(slotLabel)) role = 'scenario';

  // P2 点名了具体的槽（且与空槽不同）时，以 P2 为准（reclass 场景）。
  if (/分论点|核心观点|论点|主张|claim/.test(p2)) role = 'claim';
  else if (/展开原因|原因|为什么|起因/.test(p2)) role = 'reason';
  else if (/机制|过程|怎么发生|链条|具体是怎么|操作|实现/.test(p2)) role = 'mechanism';
  else if (/结果|影响|后果|好处|作用|效果/.test(p2)) role = 'impact';
  else if (/场景|例子|举例|典型|人群|具体做/.test(p2)) role = 'scenario';

  step3RoleCount[role] = (step3RoleCount[role] || 0) + 1;
  const theme = subpointTheme(session);
  const tpl = (type.step3 || {})[role];

  if (role === 'claim') {
    const claim = toFullClaim(theme);
    return step3RoleCount[role] >= 2 ? `我指的分论点就是：${claim}` : claim;
  }
  if (role === 'meta' && step3RoleCount[role] >= 2) {
    return ['我觉得可以这样展开：先讲原因，再用一个具体场景说明。', '本质上就是：它降低了门槛，让更多人能按自己的节奏参与。'][(step3RoleCount[role] - 2) % 2];
  }
  if (typeof tpl === 'function') {
    // 紧扣槽主题（slotLabel）与 body 主题，避免答非所问被模型拒绝。
    let ans = tpl(theme, slotLabel);
    if (String(p2) === lastStep3P2) {
      step3Stalls += 1;
      if (step3Stalls >= 3) {
        issue(CURRENT_TYPE?.slug, 3, `Step3 同一追问 ${step3Stalls} 次未推进（role=${role} slot=${slotLabel}）`);
      }
      ans = `${ans} 具体到这条分论点，核心就是围绕「${theme}」展开。`;
    }
    return ans;
  }
  return '这一步我按逻辑顺序推进，先讲原因再给场景。';
}

// ---- 我扮演学生：Step4 ----------------
// 注：真实 Step4 由前端端点驱动（/api/generate-sentence-tasks + /api/evaluate-sentence-practice），
// 不走 /api/coach/chat。脚本用 coach chat 驱动时，服务端只返回固定兑底 P2
// （"请把你当前最薄弱的那一句先贴出来"），无法推进。因此这里：先贴一句紧扣当前 body 的
// 英文句展示交互；若仍停在兑底 P2，则确认完成退出（记录，不无限循环）。
function studentStep4(p2, type, session) {
  const isFallback = /请把你当前最薄弱的那一句先贴出来/.test(p2);
  if (isFallback) {
    const said = step4PasteCount;
    step4PasteCount += 1;
    if (said >= 1) {
      issue(CURRENT_TYPE?.slug, 4, `Step4 为 coach-chat 兑底（真实 Step4 由前端端点驱动）；贴句 ${said + 1} 次后确认完成`);
      return '我确认完成这一步逐句练习。';
    }
    // 首轮贴一句紧扣当前 body 的英文句
    const pool = STEP4_POOL[type.slug] || [];
    return pool[0] || 'This approach offers learners more flexibility.';
  }
  if (/场景|例子|具体|通勤|午休|地铁|example/.test(p2)) {
    return (STEP4_POOL[type.slug] || [])[2] || 'For example, people can fit learning around their daily routine.';
  }
  if (/主题句|topic|中心句|论点句/.test(p2)) {
    return (STEP4_POOL[type.slug] || [])[0] || 'This approach offers learners more flexibility.';
  }
  const pool = STEP4_POOL[type.slug] || [];
  step4Idx += 1;
  return pool[step4Idx % pool.length];
}

async function postCoach({ step, userMessage, session, messages, decision }) {
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
  let res = null;
  let data = null;
  // D：fetch 重试（网络抖动容错），最多 2 次重试
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${BASE}/api/coach/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      data = await res.json().catch(() => ({}));
      if (res.ok && !data.error) break;
      if (attempt < 2) {
        console.warn(`[postCoach] attempt ${attempt + 1} 非 2xx/错误，重试…`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (e) {
      if (attempt < 2) {
        console.warn(`[postCoach] attempt ${attempt + 1} 网络异常（${e.message}），重试…`);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        throw e;
      }
    }
  }
  if (!res || !res.ok || data?.error) {
    throw new Error(`HTTP ${res?.status} step${step}: ${data?.error || 'unknown'}`);
  }
  if (typeof data.text !== 'string' || !data.text.trim()) {
    throw new Error(`step${step} 响应缺少 text（data=${JSON.stringify(data).slice(0, 120)}）`);
  }
  const { p1, p2 } = splitText(data.text);
  logLine(`[step${step}][t${turnCount}] 学生: ${userMessage.slice(0, 220)}`);
  logLine(`[step${step}][t${turnCount}] 教练P1: ${p1.slice(0, 320)}`);
  logLine(`[step${step}][t${turnCount}] 教练P2: ${p2.slice(0, 320)}`);
  return data;
}

// ---- 客户端 progressUpdate 合并（对齐 CoachChat.tsx）----
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

async function runStep(session, step, opening, responder, type, maxTurns) {
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
    if (i >= maxTurns - 1) {
      console.log(`    ⏸ step${step} 达轮次上限未完成（isCompleted=${!!st?.isCompleted}）`);
      issue(type.slug, step, `达 ${maxTurns} 轮上限未完成；最后P2: ${p2.slice(0, 100)}`);
      return;
    }
    lastStep3P2 = step === 3 ? p2 : '';
    const ans = responder(p2, type, session);
    const replyText = typeof ans === 'string' ? ans : ans.text;
    if (ans && typeof ans === 'object' && ans.decision) pendingDecision = ans.decision;
    msgs = [...msgs, { sender: 'ai', text: resp.text }, { sender: 'user', text: replyText }];
  }
}

async function runOneType(type) {
  turnCount = 0;
  step2Idx = 0;
  usedPoints = new Set();
  step3RoleCount = {};
  step3Stalls = 0;
  lastStep3P2 = '';
  step4Idx = 0;
  step4PasteCount = 0;
  CURRENT_TYPE = type;
  archiveFile = path.join(docsDir, `recorded-session-${type.slug}-student-${stamp}.txt`);
  logLine = (line) => {
    try { fs.appendFileSync(archiveFile, `${line}\n`); } catch (e) { /* ignore */ }
  };

  CURRENT_QUESTION = type.question;
  const session = {
    topic: { question: type.question, questionType: type.questionType },
    currentStep: 1,
    step1: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
    step2: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
    step3: { isCompleted: false, subpoints: [], activeSubpointId: '', chatHistory: [] },
    step4: { isCompleted: false, tasks: [], chatHistory: [] },
  };
  logLine(`# 完整旅程(我扮演学生) · ${type.name} · ${new Date().toISOString()}`);
  logLine(`# 题目: ${type.question}`);

  console.log(`\n========== ${type.name} ==========`);
  console.log('  ## STEP 1 ##');
  await runStep(session, 1, '我想分析一下这个 IELTS 题目。', studentStep1, type, 10);

  console.log('  ## STEP 2 ##');
  await runStep(session, 2, '我来说说我对这个题目的立场和一些论点。', studentStep2, type, 20);

  console.log('  ## PLANNER ##');
  const plannerRes = await fetch(`${BASE}/api/planner/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, question: type.question }),
  });
  const planner = await plannerRes.json().catch(() => ({}));
  if (!plannerRes.ok || planner.error) {
    console.log(`    ❌ planner 失败: ${planner.error || plannerRes.status}`);
    issue(type.slug, 'planner', `planner 失败: ${planner.error || plannerRes.status}`);
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
      // 注意：不设置 frameworkSignature。真实前端用 computeSubpointFrameworkSignature()
      // 计算并与服务端一致；脚本若用 `${bp.id}-${bp.argumentRelation}` 这种错误格式，
      // 会导致 frameworkDrifted=true → prevPlan=null → merge 被跳过 → 已确认槽丢失
      // → firstEmpty 回退 → Step3 死循环（见 recorded-session-discussion-student-*）。
      isCompleted: false,
      chatHistory: [],
    }));
    session.step3.activeSubpointId = session.step3.subpoints[0]?.id || '';
    session.step3.currentStep = 3;
  }

  console.log('  ## STEP 3 ##');
  await runStep(session, 3, '我们开始写第一个主体段吧。', studentStep3, type, 20);

  console.log('  ## STEP 4 ##');
  await runStep(session, 4, '我准备好做逐句练习了。', studentStep4, type, 10);

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
      issue(type.slug, 'run', `异常: ${e.message}`);
      console.error(e.stack);
    }
  }
  console.log('\n===== 全部题型旅程结束 =====');
  console.log('问题记录: /tmp/student-issues.log');
}

main().catch((e) => {
  console.error('STUDENT-MULTI FAILED:', e.message);
  process.exit(1);
});
