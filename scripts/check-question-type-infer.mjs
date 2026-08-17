/**
 * check-question-type-infer.mjs — 静态校验 inferQuestionTypeFromQuestion / normalizeQuestionTypeLabel 修复。
 * 从 server.ts 提取两个函数（transpileModule 去类型）后直接跑关键用例。
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`未找到 ${name}`);
  // 找匹配的右花括号（处理嵌套）——从函数体起始 `{` 开始计数
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 括号不闭合`);
}

const code = `
${extract('normalizeQuestionTypeLabel')}
${extract('inferQuestionTypeFromQuestion')}
`;

const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

// eslint-disable-next-line no-new-func
const ctx = new Function(`"use strict";\n${js}\nreturn { normalizeQuestionTypeLabel, inferQuestionTypeFromQuestion };`)();
const { normalizeQuestionTypeLabel, inferQuestionTypeFromQuestion } = ctx;

const cases = [
  // [question, knownType, expected]
  ['With the rapid development of Artificial Intelligence (AI), some think it will bring more benefits to workers, while others fear it will cause widespread unemployment. Discuss both views and give your opinion.', '', 'Discuss Both Views'],
  ['Some people believe that online learning should replace traditional classrooms. To what extent do you agree or disagree?', '', 'Agree / Disagree'],
  ['The increasing consumption of sugar-rich foods is leading to serious health problems worldwide. What are the causes of this issue, and what solutions can be implemented to solve it?', '', 'Problem / Solution'],
  ['Many people believe that universities should focus on job training rather than academic knowledge. What are the advantages and disadvantages of this?', '', 'Advantages / Disadvantages'],
  ['Some think AI will benefit workers, others fear job losses. Discuss both views and give your opinion.', 'Discussion', 'Discuss Both Views'],
  ['AI is transforming work. Do the advantages outweigh the disadvantages?', '', 'Advantages / Disadvantages'],
  ['Why do young people change jobs so often, and what can be done to encourage loyalty?', '', 'Problem / Solution'],
  // 无显式标记的单问号题 → 兜底 Agree/Disagree（修复前后一致，非 P/N 正则命中）
  ['Does the rapid development of technology bring more benefits or more harm to society?', '', 'Agree / Disagree'],
];

let pass = 0;
for (const [q, known, expected] of cases) {
  const got = inferQuestionTypeFromQuestion(q, known);
  const ok = got === expected;
  if (ok) pass++;
  console.log(`${ok ? '✅' : '❌'} infer(${JSON.stringify(q.slice(0, 40))}..., known=${known || '—'}) = ${got} (期望 ${expected})`);
}
console.log(`\nnormalize('Discussion') = ${normalizeQuestionTypeLabel('Discussion')}`);
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);
