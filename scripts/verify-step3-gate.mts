/**
 * P0 质量门控 + 整理层 + meta 处理 — 确定性验证（无 LLM）
 *
 * 运行：npx tsx scripts/verify-step3-gate.mts
 *
 * 覆盖（对照终版方案 P0-1/P0-2/P0-6）：
 * 1. resolveLandingGate：ok→land / thin→hold / off_target→hold / duplicate→reject / LLM 覆写
 * 2. validatePolishedText：轻整理通过；加料（新事实）拒绝；超长拒绝；低相似度拒绝
 * 3. thin 一轮追问后放行（held 计数 + thinTag 落槽）
 * 4. landingLog 记录 verdict/source；replayLanding 一致
 */
import {
  appendMinute,
  appendAudit,
  landMinuteToSlot,
  landBatchToSlots,
  commitPendingMinute,
  renderBoard,
  replayLanding,
  countHeldForSlot,
  validatePolishedText,
} from '../src/server/step3/secretary.ts';
import { resolveLandingGate, findSlotDef, confirmedMinutes } from '../src/server/step3/lens.ts';
import { toSkeleton } from '../src/utils/step3Skeleton.ts';
import type { Step3Subpoint } from '../src/types.ts';

const bodyPlan: any = {
  id: 'body-1',
  targetBody: 'Body Paragraph 1',
  role: 'main_argument',
  argumentRelation: 'supports',
  paragraphPlan: {
    mode: 'single_point',
    diagnosis: 'test',
    pointBlocks: [
      {
        id: 'pb1',
        label: '分论点 1',
        subClaim: '在线学习更灵活',
        role: 'major',
        expansionStrategy: 'mechanism',
        steps: [
          { key: 'pb1_s1', label: '分论点', placeholder: '主张', value: '' },
          { key: 'pb1_s2', label: '展开原因', placeholder: '原因', value: '' },
          { key: 'pb1_s3', label: '具体机制', placeholder: '机制', value: '' },
          { key: 'pb1_s4', label: '结果/影响', placeholder: '影响', value: '' },
        ],
      },
    ],
  },
};

const skeleton = toSkeleton(bodyPlan);
if (!skeleton) { console.error('FAIL: skeleton 生成失败'); process.exit(1); }

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name} ${detail}`));
};

const newSp = (): Step3Subpoint => ({ id: 'body-1', content: '在线学习更灵活', skeleton, minutes: [], activeSlotIndex: 0 } as any);

// ============ 1. resolveLandingGate（质量门控判定）============
console.log('\n== 1. resolveLandingGate ==');
{
  const sp = newSp();
  const slot = findSlotDef(sp.skeleton, 'pb1_s1');

  // ok（完整主张句）→ land
  let g = resolveLandingGate({ text: '在线学习最大的好处是时间灵活，能利用碎片时间随时学。', slot, confirmed: confirmedMinutes(sp), chainType: sp.skeleton?.chainType });
  check('ok → land', g.action === 'land' && g.verdict === 'ok');

  // thin（过短）→ hold
  g = resolveLandingGate({ text: '很灵活。', slot, confirmed: confirmedMinutes(sp) });
  check('thin → hold', g.action === 'hold' && g.verdict === 'thin');

  // off_target（claim 槽答成原因——含"原因是"信号）→ hold
  g = resolveLandingGate({ text: '原因是通勤时间太长，所以节省时间。', slot, confirmed: confirmedMinutes(sp) });
  check('off_target → hold', g.action === 'hold' && g.verdict === 'off_target');

  // duplicate（与已确认兄弟重复）→ reject —— 先落一槽并确认
  const m1 = appendMinute(sp, 'student', '在线学习最大的好处是时间灵活，能利用碎片时间随时学。');
  landMinuteToSlot(sp, m1); commitPendingMinute(sp, m1); // pb1_s1 confirmed
  g = resolveLandingGate({ text: '在线学习最大的好处是时间灵活，能利用碎片时间随时学。', slot, confirmed: confirmedMinutes(sp) });
  check('duplicate → reject', g.action === 'reject' && g.verdict === 'duplicate');

  // LLM 覆写：文本本身薄，但 LLM 判 ok → land
  g = resolveLandingGate({ text: '很灵活。', slot, confirmed: confirmedMinutes(sp), llmVerdict: 'ok' });
  check('LLM ok 覆写 → land', g.action === 'land');
}

// ============ 2. validatePolishedText（整理层防加料）============
console.log('\n== 2. validatePolishedText ==');
{
  const raw = '平台把课程切成短课，学生下班后在家用手机就能回看，系统会记录学习进度。';
  // 轻整理（顺语序、去冗余）→ 通过
  const light = validatePolishedText(raw, '平台把课程切成短课时，学生下班后在家用手机回看，系统会记录学习进度。', '具体机制');
  check('轻整理通过', !!light && light.length > 0);

  // 加料（新增"政府补贴/免费"等学生没说的事实）→ 拒绝
  const invented = validatePolishedText(raw, '平台把课程切成短课，政府补贴让课程免费，偏远地区学生都能报名。', '具体机制');
  check('加料拒绝（回退原文）', invented === null, `got=${invented}`);

  // 超长（>2×）→ 拒绝
  const tooLong = validatePolishedText(raw, raw + raw + raw + '这一段疯狂扩写补充了很多很多无关的废话内容进来堆砌长度。', '具体机制');
  check('超长拒绝', tooLong === null, `got=${tooLong}`);

  // 低相似度（几乎重写）→ 拒绝
  const rewrite = validatePolishedText(raw, '在现代社会，教育体系经历了深刻的变革，在线教学平台逐渐成为主流。', '具体机制');
  check('低相似度拒绝', rewrite === null, `got=${rewrite}`);

  // 空/无整理 → null（看板回退原文）
  check('无整理回退', validatePolishedText(raw, '', '具体机制') === null);
}

// ============ 3. thin 一轮追问后放行（held → thinTag 落槽）============
console.log('\n== 3. thin 一轮追问后放行 ==');
{
  const sp = newSp();
  const claimSlot = findSlotDef(sp.skeleton, 'pb1_s1')!;

  // 第一轮 thin → held（不落槽）
  const thin1 = '很灵活。';
  let gate = resolveLandingGate({ text: thin1, slot: claimSlot, confirmed: confirmedMinutes(sp) });
  check('thin1 → hold', gate.action === 'hold' && gate.verdict === 'thin');
  if (gate.action === 'hold') {
    const m = appendMinute(sp, 'student', thin1);
    appendAudit(sp, m.id, 'held', 'pb1_s1', gate.reason, { verdict: gate.verdict, source: 'content' });
  }
  check('held 后不落槽（无 landed）', (sp.minutes || []).every((mm) => mm.status !== 'landed'));
  check('countHeldForSlot=1', countHeldForSlot(sp, 'pb1_s1') === 1);

  // 第二轮仍 thin → 放行落槽（带 thinTag）
  const thin2 = '时间灵活。';
  gate = resolveLandingGate({ text: thin2, slot: claimSlot, confirmed: confirmedMinutes(sp) });
  check('thin2 → hold（判定本身仍 hold）', gate.action === 'hold' && gate.verdict === 'thin');
  const m2 = appendMinute(sp, 'student', thin2, { thinTag: gate.verdict === 'thin' });
  const land2 = landMinuteToSlot(sp, m2);
  check('thin2 落槽 landed', land2.ok && m2.status === 'landed');
  check('thin2 带 thinTag', m2.thinTag === true);

  // 看板显示（偏薄待补）
  const board = renderBoard(sp);
  check('看板 pending 含偏薄待补', (board.blocks[0].slots[0].pending || '').includes('偏薄待补'));

  // 确认写板
  commitPendingMinute(sp, m2);
  check('thin2 确认后 confirmed', m2.status === 'confirmed');

  // 审计重放一致
  const report = replayLanding(sp);
  check('replay 全部一致', report.auditDriven && report.allConsistent, JSON.stringify(report.rows));
}

// ============ 4. 审计记录 verdict/source + meta 不落槽 ============
console.log('\n== 4. 审计 verdict/source ==');
{
  const sp = newSp();
  const meta = '我前面已经说过了啊。';
  const m = appendMinute(sp, 'student', meta);
  appendAudit(sp, m.id, 'held', undefined, 'meta 发言，不落槽', { verdict: 'meta', source: 'meta' });
  check('meta 不落槽', m.status === 'recorded' && !m.slotKey);
  const held = (sp.landingLog || []).find((e) => e.minuteId === m.id);
  check('meta 审计 verdict=meta source=meta', held?.event === 'held' && held?.verdict === 'meta' && held?.source === 'meta');

  const replay = replayLanding(sp);
  check('meta 重放一致（held→recorded）', replay.auditDriven && replay.allConsistent, JSON.stringify(replay.rows));
}

// ============ 5. P0-4 批量落槽（landBatchToSlots + 一次确认）============
console.log('\n== 5. landBatchToSlots ==');
{
  const sp = newSp();
  // 2 段批量 → 落 pb1_s1 + pb1_s2
  const b1 = landBatchToSlots(sp, [
    '在线学习最灵活，能利用碎片时间随时学。',
    '因为通勤时间长，线下上课要花大量时间在路上。',
  ]);
  check('批量 2 段 ok', b1.ok && b1.landed.length === 2, JSON.stringify(b1));
  check('批量落连续槽', b1.ok && b1.landed[0].slotKey === 'pb1_s1' && b1.landed[1].slotKey === 'pb1_s2');
  check('批量 minutes 均 landed', (sp.minutes || []).filter((m) => m.status === 'landed').length === 2);
  check('批量审计 source=batch', (sp.landingLog || []).filter((e) => e.source === 'batch' && e.event === 'landed').length === 2);

  // 一次确认全过（对应 isAff 批量确认）
  for (const lm of (sp.minutes || []).filter((m) => m.status === 'landed')) commitPendingMinute(sp, lm);
  const board = renderBoard(sp);
  check('批量确认后 2 槽 confirmed', board.filledSlots === 2 && board.blocks[0].slots[0].status === 'confirmed' && board.blocks[0].slots[1].status === 'confirmed');
  const report = replayLanding(sp);
  check('批量重放一致', report.auditDriven && report.allConsistent, JSON.stringify(report.rows));
}
{
  const sp = newSp();
  check('>3 段拒绝', !landBatchToSlots(sp, ['一', '二', '三', '四']).ok);
  check('<2 段拒绝', !landBatchToSlots(sp, ['只有一段内容']).ok);
  const noSk = { id: 'x', content: '', minutes: [] } as any;
  check('无骨架拒绝', !landBatchToSlots(noSk, ['段一内容', '段二内容']).ok);
}
{
  // 跨 block：p1 只有 2 空槽，3 段想跨到 p2 → 拒绝
  const bp2: any = {
    id: 'b',
    role: 'main_argument',
    paragraphPlan: {
      mode: 'single_point',
      pointBlocks: [
        { id: 'p1', label: '分点1', role: 'major', steps: [{ key: 'p1_s1', label: '分论点', value: '' }, { key: 'p1_s2', label: '展开原因', value: '' }] },
        { id: 'p2', label: '分点2', role: 'major', steps: [{ key: 'p2_s1', label: '分论点', value: '' }, { key: 'p2_s2', label: '展开原因', value: '' }] },
      ],
    },
  };
  const sk2 = toSkeleton(bp2);
  const sp2 = { id: 'b', content: 'x', skeleton: sk2, minutes: [], activeSlotIndex: 0 } as any;
  const b3 = landBatchToSlots(sp2, ['一段一', '二段二', '三段三']);
  check('跨 block 批量拒绝', !b3.ok && b3.reason === 'insufficient_consecutive_slots', JSON.stringify(b3));
  const b2 = landBatchToSlots(sp2, ['一段一', '二段二']);
  check('同 block 2 段成功', b2.ok && b2.landed.length === 2 && b2.landed[1].slotKey === 'p1_s2');
}
{
  // 游标语义回归：批量落第二 block 时，activeSlotIndex 必须是槽位下标（flatIndex），
  // 而非 blockIndex（历史瑕疵：曾写成 targets[i].blockIndex）。
  const bp3: any = {
    id: 'b2',
    role: 'main_argument',
    paragraphPlan: {
      mode: 'single_point',
      pointBlocks: [
        { id: 'p1', label: '分点1', role: 'major', steps: [{ key: 'p1_s1', label: '分论点', value: '' }, { key: 'p1_s2', label: '展开原因', value: '' }] },
        { id: 'p2', label: '分点2', role: 'major', steps: [{ key: 'p2_s1', label: '分论点', value: '' }, { key: 'p2_s2', label: '展开原因', value: '' }] },
      ],
    },
  };
  const sk3 = toSkeleton(bp3);
  const sp3 = { id: 'b2', content: 'x', skeleton: sk3, minutes: [], activeSlotIndex: 0 } as any;
  const m1 = appendMinute(sp3, 'student', '第一块的分论点内容。');
  landMinuteToSlot(sp3, m1);
  commitPendingMinute(sp3, m1);
  const m2 = appendMinute(sp3, 'student', '第一块的展开原因内容。');
  landMinuteToSlot(sp3, m2);
  commitPendingMinute(sp3, m2);
  const bb = landBatchToSlots(sp3, ['第二块分论点内容句子', '第二块展开原因内容句子']);
  check('批量落第二 block 成功', bb.ok && bb.landed[0].slotKey === 'p2_s1' && bb.landed[1].slotKey === 'p2_s2', JSON.stringify(bb));
  check('批量游标=槽位下标（非 blockIndex）', sp3.activeSlotIndex === 3, `activeSlotIndex=${sp3.activeSlotIndex}`);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
console.log('全部通过 ✅');
