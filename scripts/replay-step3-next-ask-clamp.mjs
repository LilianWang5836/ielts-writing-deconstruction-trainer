/**
 * Replay: P0 — Step3 下一问钳制（模型回退到已确认槽 → 检测）。
 * 验证 step3TextAsksConfirmedSlot：模型文本若在让学生填一个【已确认】的槽
 * （如「请先把「分论点」说具体一点」当分论点已确认），返回 true，服务端据此
 * 钳制到真实 firstEmpty 问句。
 * Run: npx tsx scripts/replay-step3-next-ask-clamp.mjs
 */
import assert from 'node:assert/strict';
import { step3TextAsksConfirmedSlot } from '../src/utils/step3Quality.ts';

// 分论点(pb1_s1) 已确认；firstEmpty 是 原因(pb1_s2)。
const plan = {
  mode: 'direct_points',
  pointBlocks: [
    {
      id: 'pb1',
      label: '分点1',
      steps: [
        { key: 'pb1_s1', label: '分论点', value: '线上学习灵活', status: 'confirmed' },
        { key: 'pb1_s2', label: '展开原因', value: '', status: '' },
        { key: 'pb1_s3', label: '典型场景', value: '', status: '' },
      ],
    },
  ],
};

const check = (name, fn) => {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    throw e;
  }
};

check('回退问已确认的「分论点」→ 检测到（应钳制）', () => {
  assert.equal(
    step3TextAsksConfirmedSlot('请先把「分论点」说具体一点。', plan),
    true,
  );
});

check('「请回答分论点」→ 检测到', () => {
  assert.equal(step3TextAsksConfirmedSlot('请回答「分论点」的内容。', plan), true);
});

check('问真实 firstEmpty「展开原因」→ 不误伤', () => {
  assert.equal(
    step3TextAsksConfirmedSlot('请具体说说「展开原因」：这种灵活性为什么重要？', plan),
    false,
  );
});

check('不含已确认槽 → 不误伤', () => {
  assert.equal(step3TextAsksConfirmedSlot('我们来聊聊下一个主体段。', plan), false);
});

check('无已确认槽 → false', () => {
  const emptyPlan = {
    mode: 'direct_points',
    pointBlocks: [
      {
        id: 'pb1',
        steps: [
          { key: 'pb1_s1', label: '分论点', value: '', status: '' },
          { key: 'pb1_s2', label: '展开原因', value: '', status: '' },
        ],
      },
    ],
  };
  assert.equal(
    step3TextAsksConfirmedSlot('请先把「分论点」说具体一点。', emptyPlan),
    false,
  );
});
