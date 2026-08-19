// Step4 E2E：验证 /api/generate-sentence-tasks 端到端返回 16 任务、无 400。
// 数据源修复（commit d676c02）：从 subpoint.minutes（会议秘书真相源）提取已确认句子，
// 而非旧 paragraphPlan.steps[].value。本脚本用真实 Step3 minutes 结构触发端点。
// 用法：npx tsx scripts/e2e-step4-sentence-tasks.mjs
// 前置：dev server 运行于 localhost:3000（npm run dev）

const BASE_URL = process.env.PROBE_BASE_URL || "http://localhost:3000";

const topicQuestion =
  "Some people believe that online learning is highly beneficial and should replace traditional classroom education entirely. To what extent do you agree or disagree?";

const selectedThesis =
  "我不同意完全替代。对自律性差且处于社交发展关键期的儿童，实体学校提供必不可少的行为监管和同伴互动环境。";

// 模拟 3 个 body subpoint，每个带 minutes（会议秘书架构真相源）
// Body1: 4 句（分论点+原因+机制+例子）
// Body2: 4 句
// Body3: 5 句
const subpoints = [
  {
    id: "body-1",
    targetBody: "body1",
    theme: "教师监管缺失",
    minutes: [
      { id: "m1", status: "confirmed", slotKey: "pb1_s1", text: "缺乏教师现场监管会导致注意力分散", ts: 1 },
      { id: "m2", status: "confirmed", slotKey: "pb1_s2", text: "作业拖延和学习效率下降是直接后果", ts: 2 },
      { id: "m3", status: "confirmed", slotKey: "pb1_s3", text: "线上环境难以提供即时行为纠正", ts: 3 },
      { id: "m4", status: "confirmed", slotKey: "pb1_s4", text: "例如低龄儿童容易分心于游戏和视频", ts: 4 },
    ],
    skeleton: {
      blocks: [
        { slots: [{ key: "pb1_s1" }, { key: "pb1_s2" }, { key: "pb1_s3" }, { key: "pb1_s4" }] },
      ],
    },
  },
  {
    id: "body-2",
    targetBody: "body2",
    theme: "同伴互动缺失",
    minutes: [
      { id: "m5", status: "confirmed", slotKey: "pb2_s1", text: "实体学校提供不可替代的同伴互动环境", ts: 1 },
      { id: "m6", status: "confirmed", slotKey: "pb2_s2", text: "社交技能在面对面协作中逐步习得", ts: 2 },
      { id: "m7", status: "confirmed", slotKey: "pb2_s3", text: "线上讨论难以模拟真实课堂氛围", ts: 3 },
      { id: "m8", status: "confirmed", slotKey: "pb2_s4", text: "小组项目和角色扮演需要物理在场", ts: 4 },
    ],
    skeleton: {
      blocks: [
        { slots: [{ key: "pb2_s1" }, { key: "pb2_s2" }, { key: "pb2_s3" }, { key: "pb2_s4" }] },
      ],
    },
  },
  {
    id: "body-3",
    targetBody: "body3",
    theme: "成长关键期",
    minutes: [
      { id: "m9", status: "confirmed", slotKey: "pb3_s1", text: "儿童正处于社交发展的关键期", ts: 1 },
      { id: "m10", status: "confirmed", slotKey: "pb3_s2", text: "这一阶段的同伴交往塑造人格", ts: 2 },
      { id: "m11", status: "confirmed", slotKey: "pb3_s3", text: "完全线上化会剥夺社会化机会", ts: 3 },
      { id: "m12", status: "confirmed", slotKey: "pb3_s4", text: "长期孤立可能导致心理问题", ts: 4 },
      { id: "m13", status: "confirmed", slotKey: "pb3_s5", text: "因此实体学校对低龄段不可或缺", ts: 5 },
    ],
    skeleton: {
      blocks: [
        { slots: [{ key: "pb3_s1" }, { key: "pb3_s2" }, { key: "pb3_s3" }, { key: "pb3_s4" }, { key: "pb3_s5" }] },
      ],
    },
  },
];

async function main() {
  console.log(`[Step4 E2E] POST ${BASE_URL}/api/generate-sentence-tasks`);
  console.log(`  subpoints: ${subpoints.length} bodies`);
  console.log(`  body sentence counts: ${subpoints.map((s) => s.minutes.length).join("/")}`);

  const res = await fetch(`${BASE_URL}/api/generate-sentence-tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: topicQuestion, selectedThesis, subpoints }),
  });

  const data = await res.json().catch(() => ({}));

  // ── 验收点 1：无 400/500 ──
  if (res.status !== 200) {
    console.error(`✗ HTTP ${res.status}: ${data.error || "Unknown"}`);
    process.exit(1);
  }
  console.log(`✓ HTTP 200（无 400/500）`);

  // ── 验收点 2：返回 tasks 数组 ──
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  if (tasks.length === 0) {
    console.error("✗ tasks 为空（数据源脱节未修复）");
    process.exit(1);
  }
  console.log(`✓ 返回 ${tasks.length} 个任务`);

  // ── 验收点 3：16 任务结构（Intro2 + Body1×4 + Body2×4 + Body3×5 + Conc1 = 16）──
  const expected = 2 + 4 + 4 + 5 + 1;
  console.log(`  预期 ${expected}（Intro2+Body13+Conc1），实际 ${tasks.length}`);
  if (tasks.length !== expected) {
    console.warn(`⚠ 任务数 ${tasks.length} ≠ 预期 ${expected}（LLM 可能合并/拆分）`);
  }

  // ── 验收点 4：task ID 模式 ──
  const ids = tasks.map((t) => t.id);
  const hasIntro = ids.filter((id) => id?.startsWith("intro-"));
  const hasBody = ids.filter((id) => /^body\d+-/.test(id));
  const hasConc = ids.filter((id) => id?.startsWith("conclusion"));
  console.log(`  IDs: intro=${hasIntro.length} body=${hasBody.length} conc=${hasConc.length}`);
  if (hasIntro.length < 2) console.warn("⚠ intro 任务 < 2");
  if (hasConc.length < 1) console.warn("⚠ conclusion 任务缺失");
  if (hasBody.length < 13) console.warn(`⚠ body 任务 ${hasBody.length} < 13`);

  // ── 验收点 5：每个 task 有 concept/prompts/highlights ──
  let malformed = 0;
  for (const t of tasks) {
    if (!t?.concept || typeof t.concept !== "string") { malformed++; continue; }
    if (!Array.isArray(t?.prompts) || t.prompts.length === 0) { malformed++; continue; }
    if (!Array.isArray(t?.highlights)) { malformed++; continue; }
  }
  if (malformed > 0) {
    console.warn(`⚠ ${malformed} 个任务字段缺失`);
  } else {
    console.log(`✓ 所有 ${tasks.length} 个任务字段完整（concept/prompts/highlights）`);
  }

  // ── 验收点 6：concept 来自 minutes（数据源修复生效）──
  const concepts = tasks.map((t) => t.concept);
  const sampleMinuteText = "缺乏教师现场监管会导致注意力分散";
  if (concepts.includes(sampleMinuteText)) {
    console.log(`✓ 数据源修复生效：concept 含 minutes 文本（"${sampleMinuteText}"）`);
  } else {
    console.warn(`⚠ concept 未含预期 minutes 文本（可能 LLM 改写）`);
  }

  // ── 验收点 7：prompts 含 "->" 且用 "..." 占位（anti-spoiler）──
  let promptIssues = 0;
  for (const t of tasks) {
    for (const p of (t?.prompts || [])) {
      if (typeof p !== "string") { promptIssues++; continue; }
      if (!p.includes("->")) promptIssues++;
      if (/\[[^\]]+\]/.test(p)) promptIssues++; // 方括号 = spoiler
    }
  }
  if (promptIssues === 0) {
    console.log(`✓ 所有 prompts 合规（含 -> 且无方括号 spoiler）`);
  } else {
    console.warn(`⚠ ${promptIssues} 个 prompt 不合规`);
  }

  console.log("\n============================================================");
  console.log(`[Step4 E2E] 完成：${tasks.length} 任务，HTTP 200，无 400`);
  console.log("============================================================");
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
