/**
 * Replay: ② 单一真相源 — applyRetentionRolesFromUserPoints 结构化优先。
 * 验证：userPoints 文本不再覆盖已确认的结构化 retentionRole（含 dropped），
 * 仅对未标注的点做补缺。消除"双写不同步"的分叉方向。
 * Run: npx tsx scripts/replay-single-truth.mjs
 */
import assert from 'node:assert/strict';
import { applyRetentionRolesFromUserPoints } from '../src/server/step2/planner-payload.ts';

const pt = (o) => ({
  id: o.id,
  claim: o.claim,
  quality: 'ready',
  elaboration: o.elaboration || '',
  leanTags: ['general'],
  ...o,
});

const check = (name, fn) => {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    throw e;
  }
};

const CORPUS =
  'A面：西方文化（影视渗透）（已选详写）；数字化（网络加速）（已选略写）；用户放弃的旧点（用户放弃）';

check('结构化 detail 不被字符串 brief 覆盖', () => {
  const points = applyRetentionRolesFromUserPoints(
    [pt({ id: '1', claim: '西方文化', retentionRole: 'detail' })],
    CORPUS,
  );
  assert.equal(points[0].retentionRole, 'detail');
});

check('结构化 dropped 不被字符串复活', () => {
  const points = applyRetentionRolesFromUserPoints(
    [pt({ id: '2', claim: '用户放弃的旧点', retentionRole: 'dropped' })],
    CORPUS,
  );
  assert.equal(points[0].retentionRole, 'dropped');
});

check('未标注的点由文本补缺（兼容旧会话）', () => {
  const points = applyRetentionRolesFromUserPoints(
    [pt({ id: '3', claim: '数字化' }), pt({ id: '4', claim: '西方文化' })],
    CORPUS,
  );
  assert.equal(points[0].retentionRole, 'brief');
  assert.equal(points[1].retentionRole, 'detail');
});

check('supersededBy 的点不处理', () => {
  const points = applyRetentionRolesFromUserPoints(
    [pt({ id: '5', claim: '西方文化', supersededBy: '1' })],
    CORPUS,
  );
  assert.equal(points[0].retentionRole, undefined);
});
