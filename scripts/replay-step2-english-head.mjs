/**
 * Replay: Step2 英文/数字开头论点的解析与挂载（Discussion/AI 死锁回归）。
 *
 * 背景：Discussion 题型论点以 "AI …"（英文）开头时，dimensionHead 只匹配
 * 中文字头 → 返回空 → parseClaimElaboration 把整句当 claim、elaboration 为空
 * → upsertPointsFromClaims 的空壳守卫（rawClaim === dim 且无 elab）把点丢弃
 * → payload.points 恒为空 → ready<2 → Step2 永远"材料还不够写满两处论据"。
 *
 * 本测试锁定修复：
 * 1) dimensionHead 识别 "AI 接管重复性劳动" 这种英文/数字开头 head；
 * 2) parseClaimElaboration 能拆出 claim + elaboration；
 * 3) upsertPointsFromClaims 能挂载出 ready 点（不再被空壳守卫误杀）；
 * 4) 真正的短空标签（如 "人际关系"）仍被跳过（不回归）。
 *
 * Run: npx tsx scripts/replay-step2-english-head.mjs
 */
import assert from 'node:assert/strict';
import {
  dimensionHead,
  parseClaimElaboration,
  splitClaimChunks,
  upsertPointsFromClaims,
  scorePointQuality,
} from '../src/server/step2/planner-payload.ts';

const check = (name, fn) => {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    throw e;
  }
};

/** 提取 A 面 section（与 normalizeStep2PlannerPayload 内部一致）。 */
function extractSideSection(userPoints, side) {
  const text = String(userPoints || '');
  if (!text.trim()) return '';
  const sideRe =
    side === 'A'
      ? /A面[^：:]*[：:]([\s\S]*?)(?=B面[^：:]*[：:]|$)/
      : /B面[^：:]*[：:]([\s\S]*)$/;
  return String(text.match(sideRe)?.[1] || '').trim();
}

/** 模拟 attachChunk 最小路径（claim/elab/fromDimension 语义与源码一致）。 */
function attachChunk(points, chunk, questionType, side) {
  const { claim: c, elaboration: e } = parseClaimElaboration(chunk);
  if (!c && !e) return points;
  return upsertPointsFromClaims(
    points,
    [
      {
        claim: c || chunk,
        elaboration: e || '',
        leanTags: ['general'],
        fromDimension: dimensionHead(c) || c,
      },
    ],
    { allowCreate: true, seedContext: false },
  );
}

// ---------- 1) dimensionHead 英文/数字开头 ----------
check('dimensionHead: "AI 接管重复性劳动，工人转型…" → head "AI 接管重复性劳动"', () => {
  assert.equal(dimensionHead('AI 接管重复性劳动，工人转型到数据标注等新岗位（已展开）'), 'AI 接管重复性劳动');
});

check('dimensionHead: "AI 取代标准化岗位导致短期失业" → head 非空', () => {
  const h = dimensionHead('AI 取代标准化岗位导致短期失业');
  assert.ok(h && h.length >= 2, `got "${h}"`);
});

check('dimensionHead: 中文开头不受影响', () => {
  assert.equal(dimensionHead('相关人群可以利用通勤、午休等零散时间通过便捷渠道学习或办事'), '相关人群可以利用通勤、午休等零散时间通过');
});

// ---------- 2) parseClaimElaboration 拆出 claim + elab ----------
check('parseClaimElaboration: "AI 接管…，工人转型…" 拆出 claim + elab', () => {
  const { claim, elaboration } = parseClaimElaboration('AI 接管重复性劳动，工人转型到数据标注等新岗位');
  assert.equal(claim, 'AI 接管重复性劳动');
  assert.ok(elaboration.length >= 4, `elab="${elaboration}"`);
});

check('parseClaimElaboration: 整句长 claim 保留（不因无冒号丢 elab 判定）', () => {
  const { claim, elaboration } = parseClaimElaboration('AI 提升整体生产效率和企业竞争力后，企业利润增长带动更多相关岗位扩张');
  assert.ok(claim.length >= 2);
});

// ---------- 3) upsertPointsFromClaims 挂载出 ready 点 ----------
check('挂载：AI 开头单个论点 → 1 个 ready 点', () => {
  let points = [];
  points = attachChunk(points, 'A面：AI 接管重复性劳动，工人转型到数据标注等新岗位（已展开）', 'Discussion', 'A');
  assert.equal(points.length, 1);
  assert.equal(points[0].quality, 'ready');
  assert.ok(points[0].elaboration.length >= 4);
});

check('挂载：三个 AI 开头论点 → 3 个点且 ≥2 ready（不再空壳误杀）', () => {
  const userPoints =
    'A面：AI 接管重复性劳动，工人转型到数据标注等新岗位（已展开）；' +
    'A面：AI 取代标准化岗位导致短期失业（已展开）；' +
    'A面：政府与企业联合推出再培训计划，帮助受冲击的工人学习数据分析等新技能（已展开）';
  const section = extractSideSection(userPoints, 'A');
  const chunks = splitClaimChunks(section);
  let points = [];
  for (const ch of chunks) {
    points = attachChunk(points, ch, 'Discussion', 'A');
  }
  assert.ok(points.length >= 2, `got ${points.length}`);
  const ready = points.filter((p) => p.quality === 'ready').length;
  assert.ok(ready >= 2, `ready=${ready}`);
});

// ---------- 4) 真正短空标签仍被跳过（不回归） ----------
check('挂载：短空标签 "人际关系" 仍被跳过（不创建空壳点）', () => {
  // 真实路径：userPoints → extractSideSection 剥掉 A面： 前缀 → chunk
  const section = extractSideSection('A面：人际关系', 'A');
  const chunks = splitClaimChunks(section);
  let points = [];
  for (const ch of chunks) {
    points = attachChunk(points, ch, 'Discussion', 'A');
  }
  assert.equal(points.length, 0);
});

// ---------- 5) scorePointQuality 短 elab 不误报 ready ----------
check('quality：elab 为空的长 claim 不误判 ready（语义保留由后续展开）', () => {
  const q = scorePointQuality('AI 取代标准化岗位导致短期失业', '');
  assert.equal(q, 'thin');
});

console.log('\n✅ replay-step2-english-head 全部通过');
