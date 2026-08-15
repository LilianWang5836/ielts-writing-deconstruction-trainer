/**
 * P1 诊断脚本 — 基于 minutes 重放落槽审计
 *
 * 运行：
 *   npx tsx scripts/diagnose-step3.mts <subpoint-json-file>
 *
 * 输入：一个 subpoint 的 JSON 文件（含 skeleton / minutes / landingLog，
 * 可从 /api/log/session/:id 或运行中会话导出）。若无参数，跑一个内置样例。
 *
 * 输出：逐分钟审计轨迹（时间线 + 落槽决策 + 与运行一致性）+ 看板汇总。
 */
import {
  replayLanding,
  renderBoard,
} from '../src/server/step3/secretary.ts';
import fs from 'node:fs';

function fmtMinute(minute: any): string {
  const t = String(minute?.text || '').slice(0, 48);
  const key = minute?.slotKey ? ` @${minute.slotKey}` : '';
  const rej = minute?.rejectReason ? ` [${String(minute.rejectReason).slice(0, 40)}]` : '';
  return `[${minute?.role || '?'}] ${t}${key}${rej}`;
}

function run(subpoint: any, label: string) {
  console.log(`\n===== ${label} =====`);
  if (!subpoint || !Array.isArray(subpoint.skeleton?.blocks)) {
    console.log('  (无 skeleton，跳过)');
    return;
  }
  const minutes = Array.isArray(subpoint.minutes) ? subpoint.minutes : [];
  console.log(`骨架: ${subpoint.skeleton.blocks.length} block, ${(subpoint.skeleton.blocks as any[]).reduce((n, b) => n + (b.slots?.length || 0), 0)} slots`);
  console.log(`纪要: ${minutes.length} 条`);

  // 按 ts 输出的原始流水
  const sorted = [...minutes].sort((a: any, b: any) => (a.ts || 0) - (b.ts || 0));
  console.log('\n--- 原始纪要流水 ---');
  for (const m of sorted) console.log('  ' + fmtMinute(m));

  // 重放审计
  const report = replayLanding(subpoint);
  console.log(`\n--- 落槽审计重放 (auditDriven=${report.auditDriven}) ---`);
  let bad = 0;
  for (const row of report.rows) {
    const mark = row.consistent ? '✓' : '✗';
    if (!row.consistent) bad++;
    console.log(
      `  ${mark} ${row.text.slice(0, 40)} | recorded=${row.recorded.status}${row.recorded.slotKey ? ':' + row.recorded.slotKey : ''} | replayed=${row.replayed.status}${row.replayed.slotKey ? ':' + row.replayed.slotKey : ''}${row.replayed.rejectReason ? ' [' + String(row.replayed.rejectReason).slice(0, 30) + ']' : ''}`,
    );
  }
  console.log(`  重放一致性: ${bad === 0 ? '全部一致 ✅' : bad + ' 条不一致 ✗'}`);

  // 看板汇总
  const board = report.board;
  const flat: any[] = [];
  for (const b of board.blocks) {
    for (const s of b.slots) {
      flat.push({ key: s.key, label: s.label, status: s.status, content: s.content || s.pending });
    }
  }
  console.log(`\n--- 看板投影 (${board.filledSlots}/${board.totalSlots} filled, complete=${board.isComplete}) ---`);
  for (const s of flat) {
    console.log(`  [${s.status.padEnd(9)}] ${s.key} ${s.label}: ${String(s.content || '').slice(0, 40)}`);
  }
}

async function main() {
  const file = process.argv[2];
  if (file) {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    // 支持三种形态：直接 subpoint；{ subpoints:[...] }；{ step3:{ subpoints:[...] } }
    if (data?.skeleton || data?.minutes) {
      run(data, 'subpoint');
    } else {
      const subs = data?.subpoints || data?.step3?.subpoints || [];
      for (const [i, sp] of subs.entries()) run(sp, `subpoint[${i}] ${sp?.id || ''}`);
    }
    return;
  }

  // 内置样例（与 verify-replay 相同的流程）
  const { toSkeleton } = await import('../src/utils/step3Skeleton.ts');
  const { appendMinute, landMinuteToSlot, commitPendingMinute } = await import('../src/server/step3/secretary.ts');
  const bodyPlan: any = {
    id: 'body-1', targetBody: 'Body Paragraph 1', role: 'main_argument', argumentRelation: 'supports',
    paragraphPlan: { mode: 'single_point', diagnosis: 'demo', pointBlocks: [{ id: 'pb1', label: '分论点 1', subClaim: '在线学习更灵活', role: 'major', expansionStrategy: 'mechanism', steps: [
      { key: 'pb1_s1', label: '分论点', placeholder: '主张', value: '' },
      { key: 'pb1_s2', label: '展开原因', placeholder: '原因', value: '' },
      { key: 'pb1_s3', label: '具体机制', placeholder: '机制', value: '' },
      { key: 'pb1_s4', label: '结果/影响', placeholder: '影响', value: '' },
    ] }] },
  };
  const sp: any = { id: 'body-1', content: '在线学习更灵活', skeleton: toSkeleton(bodyPlan), minutes: [], activeSlotIndex: 0 };
  const m1 = appendMinute(sp, 'student', '在线学习最大的好处是时间灵活，能利用碎片时间随时学习。');
  landMinuteToSlot(sp, m1); commitPendingMinute(sp, m1);
  const m2 = appendMinute(sp, 'student', '因为通勤时间长，线下上课要花大量时间在路上。');
  landMinuteToSlot(sp, m2); commitPendingMinute(sp, m2);
  const mDup = appendMinute(sp, 'student', '在线学习最大好处就是时间灵活，能利用碎片时间随时学习。');
  landMinuteToSlot(sp, mDup);
  const m3 = appendMinute(sp, 'student', '平台把课程切成短课时，配合进度追踪和自动提醒，逐段完成。');
  landMinuteToSlot(sp, m3); commitPendingMinute(sp, m3);
  const m4 = appendMinute(sp, 'student', '长期坚持学习，职业技能提升，职业竞争力增强。');
  landMinuteToSlot(sp, m4); commitPendingMinute(sp, m4);
  run(sp, '内置样例');
  console.log('\n用法: npx tsx scripts/diagnose-step3.mts <subpoint-json>');
}

main().catch((e) => {
  console.error('诊断失败:', e.message);
  process.exit(1);
});
