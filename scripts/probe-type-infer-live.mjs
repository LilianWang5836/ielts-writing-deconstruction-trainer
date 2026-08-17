/**
 * probe-type-infer-live.mjs — 实机验证题型推断修复：
 * 含 "cause" 的 Discuss Both Views 题目（学生题型识别答 "Discussion"）应走「观点A/观点B」，
 * 而非被误判为 Problem/Solution 的「原因/成因、解决措施」。
 */
const BASE = 'http://localhost:3000/api/coach/chat';
const QUESTION =
  'With the rapid development of Artificial Intelligence (AI), some think it will bring more benefits to workers, while others fear it will cause widespread unemployment. Discuss both views and give your opinion.';

const session = {
  topic: { question: QUESTION, questionType: '' },
  currentStep: 'step2',
  step1: {
    isCompleted: true,
    coachEvaluation: {
      correctType: 'Discussion', // 学生题型识别结果
      coreIssue: 'AI 对工人利大于弊还是失业',
      constraints: ['both views', 'opinion'],
      suggestedDimensions: ['AI 提升生产力', 'AI 导致失业'],
      dimensionsSufficient: true,
      exitOffered: true,
    },
    chatHistory: [],
  },
  step2: { isCompleted: false, coachEvaluation: {}, chatHistory: [] },
  step3: { isCompleted: false, subpoints: [], activeSubpointId: null, chatHistory: [] },
  step4: { isCompleted: false },
};

const res = await fetch(BASE, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    question: QUESTION,
    step: 2,
    userMessage: 'AI能让工人更高效，减少重复劳动，这是一方观点。',
    messages: [{ sender: 'user', text: 'AI能让工人更高效，减少重复劳动，这是一方观点。' }],
    stepContext: {},
    session,
  }),
});
const data = await res.json();
const text = data?.text || '';
console.log('P1:', String(text).split('---')[0].trim());
console.log('P2:', (String(text).split('---')[1] || '').trim());

const usesBothViews = /观点A|观点B|A面|B面/.test(text);
const usesPS = /原因\/成因|解决措施|原因|措施/.test(text);
console.log('\n[结论] Step2 使用「观点A/观点B」双面口径: ', usesBothViews ? 'YES ✅' : 'NO ❌');
console.log('[结论] Step2 误用「原因/措施」(P/S 口径): ', usesPS ? 'YES ❌' : 'NO ✅');
const sd = data?.progressUpdate?.step2Data || {};
console.log('[step2Data] currentStage=', sd.currentStage, '| userStance=', sd.userStance, '| questionType=', sd.questionType, '| blueprint.questionType=', sd.blueprint?.questionType);
process.exit(usesBothViews && !usesPS ? 0 : 1);
