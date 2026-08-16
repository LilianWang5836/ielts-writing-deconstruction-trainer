/**
 * 诊断：DeepSeek 的 polishedText 为何被 validatePolishedText 拒绝（polished=no）。
 * 用真实 LLM + 真实学生原话复现 Step3 整理层，逐条检查校验规则。
 *
 * 运行：npx tsx scripts/diag-polish.mts
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePolishedText } from '../src/server/step3/secretary.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const apiKey = process.env.OPENAI_API_KEY;
const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1').trim().replace(/\/+$/, '');
const model = String(process.env.OPENAI_MODEL || 'deepseek-chat').trim();

if (!apiKey || apiKey === 'MY_OPENAI_API_KEY') {
  console.error('OPENAI_API_KEY 未配置（.env.local）。');
  process.exit(1);
}

/** 复刻 server.ts 的 step3Assessment 请求（仅精简，聚焦 polishedText）。 */
async function askPolish(raw: string, slotLabel: string): Promise<string> {
  const sys = `你是雅思写作教练的“会议秘书整理层”。学生刚回答了一个论证槽位。请把学生原话做“仅语言层面的轻整理”（去掉口头语、顺语序、补省略主语），用于看板展示。\n严禁新增任何学生没说过的事实/观点/细节。\n如果原话已通顺无需整理，返回原话原样。\n只返回整理后的文本，不要任何解释。`;
  const body = {
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `当前槽位：${slotLabel}\n学生原话：${raw}\n请输出轻整理版：` },
    ],
    temperature: 0.3,
    max_tokens: 300,
  };
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${t.slice(0, 200)}`);
  }
  const data: any = await res.json();
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

const cases: Array<{ slot: string; raw: string }> = [
  {
    slot: '让步段·承认对方合理处（claim）',
    raw: '线上学习确实缺少那种面对面的师生互动，不过老师可以靠直播连麦还有课后的在线答疑来补上这个不足。',
  },
  {
    slot: '分论点·主张（claim）',
    raw: '在线学习最大的好处就是它特别灵活，学生可以自己安排什么时间学，在哪学都行。',
  },
  {
    slot: '展开原因（reason）',
    raw: '因为通勤时间省下来了，学生就能把这些时间用来多刷几遍难点视频，学习效果自然更好。',
  },
];

console.log(`LLM: ${model} @ ${baseUrl}\n`);

let allPass = 0;
for (const c of cases) {
  try {
    const polished = await askPolish(c.raw, c.slot);
    const ok = validatePolishedText(c.raw, polished, c.slot);
    console.log(`── 槽位：${c.slot}`);
    console.log(`  原话   : ${c.raw}`);
    console.log(`  润色   : ${polished}`);
    console.log(`  校验   : ${ok ? '✓ 通过（看板将显示润色稿）' : '✗ 拒绝（回退原话）'}`);
    if (ok && ok !== c.raw) allPass++;
    console.log('');
  } catch (e: any) {
    console.error(`  调用失败: ${e?.message || e}\n`);
  }
}

console.log(allPass > 0 ? `\n结论：存在可落板的真实润色（${allPass} 例）——问题在阈值过紧。` : '\n结论：所有润色均被拒/无需整理。');
