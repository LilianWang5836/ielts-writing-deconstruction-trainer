/**
 * 本地快速验证：用诊断中观察到的真实输入，测 enforceStep3SkeletonLock +
 * mergeParagraphPlanPreserveBlocks 是否恢复 4 槽。
 */
import {
  enforceStep3SkeletonLock,
  mergeParagraphPlanPreserveBlocks,
} from '../src/utils/step3Quality.ts';

const skeleton = {
  mode: 'single_point',
  totalClaim: '',
  pointBlocks: [
    {
      id: 'pb1',
      label: 'AI替代重复性劳动',
      subClaim: 'AI替代重复性劳动，促使劳动者转向创意与协作型工作，从而催生新型高价值岗位。',
      role: 'major',
      expansionStrategy: 'explanation',
      steps: [
        { key: 'pb1_s1', label: '分论点', placeholder: '', value: '', status: '' },
        { key: 'pb1_s2', label: '展开原因', placeholder: '', value: '', status: '' },
        { key: 'pb1_s3', label: '机制/过程', placeholder: '', value: '', status: '' },
        { key: 'pb1_s4', label: '结果/影响', placeholder: '', value: '', status: '' },
      ],
    },
  ],
};

// prevPlan：学生已确认分论点（第 2 条确认后）
const prevPlan = {
  mode: 'single_point',
  totalClaim: '',
  pointBlocks: [
    {
      id: 'pb1',
      label: 'AI替代重复性劳动',
      subClaim: 'AI替代重复性劳动，促使劳动者转向创意与协作型工作，从而催生新型高价值岗位。',
      role: 'major',
      expansionStrategy: 'explanation',
      steps: [
        { key: 'pb1_s1', label: '分论点', placeholder: '', value: 'AI替代重复性劳动，促使劳动者转向创意与协作型工作，从而催生新型高价值岗位。', status: 'confirmed' },
        { key: 'pb1_s2', label: '展开原因', placeholder: '', value: '', status: '' },
        { key: 'pb1_s3', label: '机制/过程', placeholder: '', value: '', status: '' },
        { key: 'pb1_s4', label: '结果/影响', placeholder: '', value: '', status: '' },
      ],
    },
  ],
};

// 模型第 3 条返回：把 pb1_s1 改成展开原因、删掉 pb1_s2、只留 3 槽
const modelPlan = {
  mode: 'single_point',
  totalClaim: '',
  pointBlocks: [
    {
      id: 'pb1',
      label: 'AI替代重复性劳动',
      subClaim: 'AI替代重复性劳动，促使劳动者转向创意与协作型工作，从而催生新型高价值岗位。',
      role: 'major',
      expansionStrategy: 'explanation',
      steps: [
        { key: 'pb1_s1', label: '展开原因', placeholder: '', value: '', status: '' },
        { key: 'pb1_s3', label: '机制/过程', placeholder: '', value: '', status: '' },
        { key: 'pb1_s4', label: '结果/影响', placeholder: '', value: '', status: '' },
      ],
    },
  ],
};

console.log('== mergeParagraphPlanPreserveBlocks(prevPlan, modelPlan) ==');
const merged = mergeParagraphPlanPreserveBlocks(
  JSON.parse(JSON.stringify(prevPlan)),
  JSON.parse(JSON.stringify(modelPlan)),
);
merged.pointBlocks[0].steps.forEach((s) =>
  console.log(`  [${s.key}]「${s.label}」status=${s.status || '-'} value=${(s.value || '(空)').slice(0, 20)}`),
);

console.log('\n== 再 enforceStep3SkeletonLock(merged, skeleton) ==');
const locked = JSON.parse(JSON.stringify(merged));
const rejected = enforceStep3SkeletonLock(locked, skeleton);
console.log(`  rejectedBlocks=${rejected}`);
locked.pointBlocks.forEach((b, i) => {
  const steps = (b.steps || []).map((s) => `[${s.key}]「${s.label}」status=${s.status || '-'} value=${(s.value || '(空)').slice(0, 20)}`).join(' ');
  console.log(`  block${i} id=${b.id} label=${b.label} :: ${steps}`);
});
