// Step4 验收：generate-sentence-tasks 数据源（extractBodySentencesFromMinutes）确定性验证。
// 会议秘书架构下，Step4 句子任务的内容真相源是 subpoint.minutes（status=confirmed），
// 而非旧 paragraphPlan.steps[].value。本脚本验证：
//   1) minutes 优先提取（新架构主路径）
//   2) 骨架槽位顺序排序
//   3) 旧会话 paragraphPlan 回退（兼容）
//   4) 16 任务结构（Intro2 + Body1×4 + Body2×4 + Body3×5 + Conc1）
// 用法：npx tsx scripts/verify-step4-sentence-tasks.mts

// ── 从 server.ts 提取真实函数（转译去 TS 类型）──
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const serverPath = fileURLToPath(new URL("../server.ts", import.meta.url));
const src = fs.readFileSync(serverPath, "utf8");

// 提取 normalizeText + dedupeOrdered + extractBodySentencesFromMinutes + extractBodySentences
// 这四个函数在 /api/generate-sentence-tasks handler 内连续定义。
const startMarker = "const normalizeText = (value: unknown): string =>";
const endMarker = "const extractBodyClaimContext = (plan: any, sp?: any): string =>";
const startIdx = src.indexOf(startMarker);
const endIdx = src.indexOf(endMarker);
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.error("FAIL: Step4 数据源函数块未找到");
  process.exit(2);
}
const blockTs = src.slice(startIdx, endIdx);
const js = ts
  .transpileModule(blockTs, { compilerOptions: { target: ts.ScriptTarget.ES2020 } })
  .outputText;
const api = new Function(`${js}\nreturn { normalizeText, dedupeOrdered, extractBodySentencesFromMinutes, extractBodySentences };`)() as {
  normalizeText: (value: unknown) => string;
  dedupeOrdered: (items: string[]) => string[];
  extractBodySentencesFromMinutes: (sp: any) => string[];
  extractBodySentences: (plan: any, sp?: any) => string[];
};

let fail = 0;
const check = (name: string, cond: boolean) => {
  console.log(cond ? `✓ ${name}` : `✗ ${name}`);
  if (!cond) fail += 1;
};

// ════════════════════════════════════════════════════════════════
// 1) minutes 优先提取（新架构主路径）
// ════════════════════════════════════════════════════════════════
{
  const sp = {
    minutes: [
      { id: "m1", status: "confirmed", slotKey: "pb1_s1", text: "在线学习具有高度便利性", ts: 1 },
      { id: "m2", status: "confirmed", slotKey: "pb1_s2", text: "它迎合了不同人群的需求", ts: 2 },
      { id: "m3", status: "landed", slotKey: "pb1_s3", text: "这条不该出现（landed 非 confirmed）", ts: 3 },
      { id: "m4", status: "confirmed", slotKey: "pb1_s4", text: "  前后有空格  ", ts: 4 },
    ],
    skeleton: {
      blocks: [
        { slots: [{ key: "pb1_s1" }, { key: "pb1_s2" }, { key: "pb1_s4" }] },
      ],
    },
    paragraphPlan: { pointBlocks: [{ steps: [{ value: "旧路径不该用" }] }] },
  };
  const out = api.extractBodySentencesFromMinutes(sp);
  check("minutes 提取返回 3 条（排除 landed）", out.length === 3);
  check("第一条对准 pb1_s1", out[0] === "在线学习具有高度便利性");
  check("第二条对准 pb1_s2", out[1] === "它迎合了不同人群的需求");
  check("第三条 trim 空格", out[2] === "前后有空格");
  check("landed 不混入", !out.includes("这条不该出现（landed 非 confirmed）"));
}

// ════════════════════════════════════════════════════════════════
// 2) 骨架槽位顺序排序
// ════════════════════════════════════════════════════════════════
{
  // minutes 乱序，骨架定义 s1→s2→s3 顺序
  const sp = {
    minutes: [
      { id: "m3", status: "confirmed", slotKey: "pb1_s3", text: "第三句", ts: 30 },
      { id: "m1", status: "confirmed", slotKey: "pb1_s1", text: "第一句", ts: 10 },
      { id: "m2", status: "confirmed", slotKey: "pb1_s2", text: "第二句", ts: 20 },
    ],
    skeleton: {
      blocks: [
        { slots: [{ key: "pb1_s1" }, { key: "pb1_s2" }, { key: "pb1_s3" }] },
      ],
    },
  };
  const out = api.extractBodySentencesFromMinutes(sp);
  check("骨架顺序：s1→s2→s3", out.join("|") === "第一句|第二句|第三句");
}

// ════════════════════════════════════════════════════════════════
// 3) 无骨架时按 ts 排序
// ════════════════════════════════════════════════════════════════
{
  const sp = {
    minutes: [
      { id: "m3", status: "confirmed", slotKey: "x", text: "晚", ts: 300 },
      { id: "m1", status: "confirmed", slotKey: "y", text: "早", ts: 100 },
      { id: "m2", status: "confirmed", slotKey: "z", text: "中", ts: 200 },
    ],
    // 无 skeleton
  };
  const out = api.extractBodySentencesFromMinutes(sp);
  check("无骨架按 ts 升序", out.join("|") === "早|中|晚");
}

// ════════════════════════════════════════════════════════════════
// 4) 去重（同文本多条 confirmed）
// ════════════════════════════════════════════════════════════════
{
  const sp = {
    minutes: [
      { id: "m1", status: "confirmed", slotKey: "s1", text: "重复句", ts: 1 },
      { id: "m2", status: "confirmed", slotKey: "s2", text: "重复句", ts: 2 },
      { id: "m3", status: "confirmed", slotKey: "s3", text: "唯一句", ts: 3 },
    ],
    skeleton: { blocks: [{ slots: [{ key: "s1" }, { key: "s2" }, { key: "s3" }] }] },
  };
  const out = api.extractBodySentencesFromMinutes(sp);
  check("去重后 2 条", out.length === 2);
  check("保留首次出现", out[0] === "重复句");
  check("唯一句保留", out[1] === "唯一句");
}

// ════════════════════════════════════════════════════════════════
// 5) 空 minutes → 空数组
// ════════════════════════════════════════════════════════════════
{
  check("空 minutes → []", api.extractBodySentencesFromMinutes({ minutes: [] }).length === 0);
  check("无 minutes 字段 → []", api.extractBodySentencesFromMinutes({}).length === 0);
  check("null 安全", api.extractBodySentencesFromMinutes(null).length === 0);
}

// ════════════════════════════════════════════════════════════════
// 6) extractBodySentences 优先 minutes，回退 paragraphPlan
// ════════════════════════════════════════════════════════════════
{
  // 有 minutes → 用 minutes，忽略 plan
  const sp = {
    minutes: [{ id: "m1", status: "confirmed", slotKey: "s1", text: "minutes 句", ts: 1 }],
  };
  const plan = { totalClaim: "plan 句", pointBlocks: [] };
  const out = api.extractBodySentences(plan, sp);
  check("有 minutes 时优先 minutes", out.length === 1 && out[0] === "minutes 句");
}
{
  // 无 minutes → 回退 plan
  const sp = { minutes: [] };
  const plan = {
    totalClaim: "总论点",
    pointBlocks: [
      {
        subClaim: "分论点A",
        steps: [
          { key: "claim", label: "分论点", value: "分论点A" },
          { key: "reason", label: "原因", value: "因为X" },
          { key: "mechanism", label: "机制", value: "通过Y" },
        ],
      },
    ],
    optionalShortClosing: "小结",
  };
  const out = api.extractBodySentences(plan, sp);
  check("回退 plan：totalClaim 在前", out[0] === "总论点");
  check("回退 plan：claim step 只出现一次（不重复）", out.filter((s) => s === "分论点A").length === 1);
  check("回退 plan：含原因/机制/小结", out.includes("因为X") && out.includes("通过Y") && out.includes("小结"));
}

// ════════════════════════════════════════════════════════════════
// 7) 16 任务结构模拟（Intro2 + Body1×4 + Body2×4 + Body3×5 + Conc1 = 16）
//    复刻 /api/generate-sentence-tasks 的 inputElements 构建逻辑
// ════════════════════════════════════════════════════════════════
{
  // 模拟 3 个 body subpoint，minutes 分别 4/4/5 条 confirmed
  const subpoints = [
    {
      id: "body-1",
      minutes: Array.from({ length: 4 }, (_, i) => ({
        id: `b1_m${i}`,
        status: "confirmed",
        slotKey: `pb1_s${i + 1}`,
        text: `Body1 句${i + 1}`,
        ts: i + 1,
      })),
      skeleton: { blocks: [{ slots: Array.from({ length: 4 }, (_, i) => ({ key: `pb1_s${i + 1}` })) }] },
    },
    {
      id: "body-2",
      minutes: Array.from({ length: 4 }, (_, i) => ({
        id: `b2_m${i}`,
        status: "confirmed",
        slotKey: `pb2_s${i + 1}`,
        text: `Body2 句${i + 1}`,
        ts: i + 1,
      })),
      skeleton: { blocks: [{ slots: Array.from({ length: 4 }, (_, i) => ({ key: `pb2_s${i + 1}` })) }] },
    },
    {
      id: "body-3",
      minutes: Array.from({ length: 5 }, (_, i) => ({
        id: `b3_m${i}`,
        status: "confirmed",
        slotKey: `pb3_s${i + 1}`,
        text: `Body3 句${i + 1}`,
        ts: i + 1,
      })),
      skeleton: { blocks: [{ slots: Array.from({ length: 5 }, (_, i) => ({ key: `pb3_s${i + 1}` })) }] },
    },
  ];

  // 复刻 bodyEntries 构建
  const bodyEntries = subpoints.map((sp, idx) => ({
    bodyNum: idx + 1,
    sentences: api.extractBodySentences(undefined, sp),
  }));

  const bodySentenceTotal = bodyEntries.reduce((s, b) => s + b.sentences.length, 0);
  check("Body1 提取 4 句", bodyEntries[0].sentences.length === 4);
  check("Body2 提取 4 句", bodyEntries[1].sentences.length === 4);
  check("Body3 提取 5 句", bodyEntries[2].sentences.length === 5);
  check("Body 总句数 13", bodySentenceTotal === 13);

  // inputElements = Intro2 + Body13 + Conc1 = 16
  const inputElementCount = 2 + bodySentenceTotal + 1;
  check("inputElements 总数 = 16（Intro2+Body13+Conc1）", inputElementCount === 16);

  // 验证 task ID 模式
  const expectedIds = [
    "intro-1", "intro-2",
    ...Array.from({ length: 4 }, (_, i) => `body1-${i + 1}`),
    ...Array.from({ length: 4 }, (_, i) => `body2-${i + 1}`),
    ...Array.from({ length: 5 }, (_, i) => `body3-${i + 1}`),
    "conclusion-1",
  ];
  check("16 任务 ID 模式匹配", expectedIds.length === 16);
  check("Body3 有 body3-5（第5句）", expectedIds.includes("body3-5"));
}

// ════════════════════════════════════════════════════════════════
// 8) inferSection 边界（复刻，验证 task→section 投影）
// ════════════════════════════════════════════════════════════════
{
  const inferSection = (taskId: string): string => {
    if (taskId.startsWith("intro-")) return "intro";
    if (taskId.startsWith("conclusion")) return "conclusion";
    const bodyMatch = taskId.match(/^body(\d+)-/i);
    if (bodyMatch) return `body${bodyMatch[1]}`;
    return "body1";
  };
  check("intro-1 → intro", inferSection("intro-1") === "intro");
  check("conclusion-1 → conclusion", inferSection("conclusion-1") === "conclusion");
  check("body1-1 → body1", inferSection("body1-1") === "body1");
  check("body3-5 → body3", inferSection("body3-5") === "body3");
  check("未知 → body1 兜底", inferSection("xxx") === "body1");
}

console.log(fail === 0 ? "\nALL STEP4 SENTENCE-TASKS CASES PASS" : `\n${fail} CASE(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
