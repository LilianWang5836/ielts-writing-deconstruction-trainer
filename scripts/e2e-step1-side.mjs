/**
 * e2e-step1-side.mjs — T3.1：真实链路验证 Step1 侧签（T1 加固）与「A 侧 3 点 / B 侧 0 点」门禁。
 *
 * 驱动一个干净的 Discuss Both Views 题目（刻意不含 cause/reason 等词，避免 inferQuestionTypeFromQuestion
 * 把题目误判为 Problem/Solution，从而确证 Step1 以「观点A/观点B」双侧门禁运行）。
 *
 * 脚本行为（模拟学生）：
 *   1) 题型识别 → 答「Discussion」（应归一为 Discuss Both Views）
 *   2) 教练要求列维度 → 连续给出 3 个 A 侧（观点A=AI利）角度，0 个 B 侧
 *   3) 观察教练是否在 A3/B0 时指向缺失的 B 侧提示门禁，且不陷入「反复要角度」死循环
 *   4) 检查 Step1 各轮 suggestedDimensions 是否携带侧签、侧签在跨轮改写后是否保留（T1）
 *
 * 用法：npx tsx scripts/e2e-step1-side.mjs   （需 dev server 运行在 :3000）
 */
import { fileURLToPath } from 'node:url';

const BASE = 'http://localhost:3000/api/coach/chat';
const LOGFILE = fileURLToPath(new URL('../docs/recorded-sessions/recorded-e2e-step1-side-20260816.txt', import.meta.url));

// ---- 干净的 Discuss Both Views 题目（避免 cause 误判） ----
const QUESTION = 'Artificial intelligence is transforming the workplace. Some people believe it empowers workers to be more productive, while others worry it will take away their jobs. Discuss both views and give your opinion.';
const QUESTION_TYPE = 'Discuss Both Views';

// ---- 模拟学生 ----
const A_ANGLES = [
  '提高工作效率、减少重复劳动：AI能自动化重复性任务，比如自动处理报表和排班，让员工把时间用在更有创造性的工作上',
  '降低企业运营成本：自动化减少了对基础人力的依赖，企业省下的钱可以投入产品创新，间接让员工获得更好的工具',
  '提升决策质量：AI辅助数据分析帮助工人和管理者更快做出更准确的判断，减少人为失误',
];

const studentReply = (p2, round) => {
  const t = String(p2 || '');
  if (/题型|Task 2|属于哪一|分类/.test(t)) return 'Discussion';
  if (/确认|进入下一步/.test(t)) return '确认';
  if (round < A_ANGLES.length) return A_ANGLES[round];
  // A 侧已给完，B 侧给不出 → 观察门禁
  return '我暂时想不到另一个观点的论点了，就先这些吧';
};

async function chat(session, question, step, userMessage, messages, decision) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question,
      step,
      userMessage,
      messages,
      stepContext: {},
      session,
      decision,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}



const A = (s) => (s || '').split('---').map((x) => x.trim()).filter(Boolean);

function strip(str) {
  return String(str || '').replace(/侧：\s*[AAB]+/g, '').trim();
}

async function main() {  const session = {
    topic: { question: QUESTION, questionType: QUESTION_TYPE },
    currentStep: 'step1',
    step1: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
    step2: { isCompleted: false },
    step3: { isCompleted: false, subpoints: [], activeSubpointId: null, chatHistory: [] },
    step4: { isCompleted: false },
  };

  const lines = [];
  lines.push(`# e2e-step1-side · Discuss Both Views（A 侧 3 点 / B 侧 0 点）· ${new Date().toISOString()}`);
  lines.push(`# 题目: ${QUESTION}`);
  lines.push('');

  let round = 0;
  let sawBHint = false;
  const dimSideTagsSeen = [];
  const allDimLabels = [];

  while (round < 10) {
    const lastUser = [...(session.step1.chatHistory || [])].filter((m) => m.sender === 'user').pop();
    const messages = (session.step1.chatHistory || []).map((m) => ({ sender: m.sender, text: m.text }));
    const reply = studentReply(lastUser ? lastUser.text : '', round);
    lines.push(`>>> 学生(第${round + 1}轮): ${reply}`);

    const data = await chat(
      session,
      QUESTION,
      1,
      reply,
      messages,
      undefined
    );
    const p1 = A(data.text)[0] || '';
    const p2 = A(data.text)[1] || '';
    lines.push(`--- 教练 P1: ${p1}`);
    if (p2) lines.push(`--- 教练 P2: ${p2}`);

    // 合并 progressUpdate：step1Data 为扁平桶（含 suggestedDimensions 等），存入 coachEvaluation
    const pu = data.progressUpdate || {};
    if (pu.step1Data) {
      session.step1.coachEvaluation = { ...session.step1.coachEvaluation, ...pu.step1Data };
    }
    if (Array.isArray(pu.step1Data?.chatHistory)) {
      session.step1.chatHistory = pu.step1Data.chatHistory;
    }

    // 记录维度侧签：从 step1Data.suggestedDimensions（扁平字段）读取
    const dims = Array.isArray(pu.step1Data?.suggestedDimensions)
      ? pu.step1Data.suggestedDimensions
      : Array.isArray(session.step1.coachEvaluation.suggestedDimensions)
        ? session.step1.coachEvaluation.suggestedDimensions
        : [];
    lines.push(`[dims] 原始: ${JSON.stringify(dims)}`);
    dims.forEach((d) => {
      const s = String(typeof d === 'string' ? d : d?.label || d?.dimension || '');
      if (!s) return;
      if (!allDimLabels.includes(strip(s))) allDimLabels.push(strip(s));
      const m = s.match(/[（(]\s*侧[：:]\s*([ABG])\s*[）)]/);
      if (m) dimSideTagsSeen.push(m[1]);
    });

    // 门禁提示：指向缺失的 B 侧
    if (/反方|另一方|观点\s*[Bb]|[Bb]\s*侧|另一个观点|对方的观点|对立面/.test(p1 + p2)) {
      sawBHint = true;
      lines.push(`[门禁] 教练在 A3/B0 后提到 B 侧/反方：${(p1 + p2).slice(0, 120)}`);
    }

    if (pu.isCompleted || pu.step1Data?.isCompleted) {
      lines.push('[结果] Step1 完成，结束。');
      break;
    }
    round += 1;
  }

  lines.push('');
  lines.push('## 观测汇总');
  lines.push(`- 维度标签收集: ${allDimLabels.length} 条 → ${JSON.stringify(allDimLabels, null, 2)}`);
  lines.push(`- 维度条目中携带侧签的次数: ${dimSideTagsSeen.length} → ${JSON.stringify(dimSideTagsSeen)}`);
  lines.push(`- A3/B0 时教练是否指向缺失侧(B): ${sawBHint ? 'YES' : 'NO'}`);
  lines.push(`- 结束轮次: ${round}（cap=10，>6 视为疑似循环）`);

  const fs = await import('node:fs');
  fs.writeFileSync(LOGFILE, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log('\n[已存档]', LOGFILE);
}

main().catch((e) => {
  console.error('[e2e-step1-side 失败]', e);
  process.exit(1);
});
