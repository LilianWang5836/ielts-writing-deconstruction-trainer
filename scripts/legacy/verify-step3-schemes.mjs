// TEMPORARY verification probe for the "Dynamic Step 3 Logic Chain" change.
// It posts three Step-3 openings (each likely to need a different logic-chain
// scheme) to /api/coach/chat and prints the keys/labels the model returns in
// progressUpdate.step3SubpointSteps.
//
// Usage:
//   1. In one terminal:  GEMINI_API_KEY=your_key npm run dev
//   2. In another:       node scripts/verify-step3-schemes.mjs
//
// Pass criterion: the concession and problem-solution cases should return
// non-deductive step keys/labels (i.e. NOT claim/reason/support/impact),
// confirming the Coach is choosing the structure per argument.
//
// This file is throwaway; delete it once verified.

const BASE = process.env.PROBE_BASE_URL || "http://localhost:3000";

const FORBIDDEN_CHAT_JARGON = [
  "total_then_points",
  "direct_points",
  "single_point",
  "paragraphPlan",
  "pointBlock",
  "step3SubpointSteps",
  "expansionStrategy",
  "progressUpdate",
  "explore_A",
  "explore_B",
  "currentStage",
  "KEEP_MINOR",
  "EXPAND_BOTH",
  "correctType",
  "suggestedDimensions",
];

function chatTextHasForbiddenJargon(text = "") {
  const lower = String(text).toLowerCase();
  return FORBIDDEN_CHAT_JARGON.filter((term) =>
    lower.includes(term.toLowerCase()),
  );
}

const cases = [
  {
  name: "Teacher Feedback + Peer Competition",
  question:
    "Some people believe that online learning is highly beneficial and should replace traditional classroom education entirely. To what extent do you agree or disagree?",
  userMessage:
    "我想论证这个分论点：传统课堂不仅能提供教师即时反馈，也能通过同伴竞争激发学生的学习动力。",
  subpointContent:
    "传统课堂不仅能提供教师即时反馈，也能通过同伴竞争激发学生的学习动力。",

  expectedPlanMode: "multi_point",
  expectedPointCount: 2,
  expectedPointKeywords: ["教师即时反馈", "同伴竞争"],
  printFull: true,
},
  {
    name: "Multi-Point Claim (School Supervision + Peer Interaction)",
    question:
      "Some people believe that online learning is highly beneficial and should replace traditional classroom education entirely. To what extent do you agree or disagree?",
    userMessage:
      "我想论证这个分论点：对于自律性差且处于社交发展关键期的儿童，实体学校提供必不可少的行为监管和同伴互动环境。",
    subpointContent:
      "对于自律性差且处于社交发展关键期的儿童，实体学校提供必不可少的行为监管和同伴互动环境。",
    expectMultiPoint: true,
    printFull: true,
  },
  {
    name: "Symmetric Two-Benefit Claim (allow dual major)",
    question:
      "Some people believe that online learning is highly beneficial and should replace traditional classroom education entirely. To what extent do you agree or disagree?",
    userMessage:
      "我想论证这个分论点：线上学习既能打破地理限制帮助偏远地区学生，也能给在职人员提供灵活学习时间。",
    subpointContent:
      "线上学习既能打破地理限制帮助偏远地区学生，也能给在职人员提供灵活学习时间。",
    expectMultiPoint: true,
    expectedAllowDualMajor: true,
    expectedPointKeywords: ["偏远", "在职"],
    expectedBridgeLanguage: true,
    printFull: true,
  },
  {
    name: "Concession (Discuss Both Views)",
    question:
      "With the rapid development of Artificial Intelligence (AI), some think it will bring more benefits to workers, while others fear it will cause widespread unemployment. Discuss both views and give your opinion.",
    userMessage:
      "我想论证：虽然 AI 会取代部分重复性岗位，但总体上它为劳动者创造了更多新型的、更有价值的工作机会。",
    subpointContent:
      "虽然 AI 会取代部分重复性岗位，但总体上它为劳动者创造了更多新型的、更有价值的工作机会。",
  },
  {
    name: "Problem-Solution",
    question:
      "The increasing consumption of sugar-rich foods and drinks is leading to serious health problems worldwide. What are the causes of this issue, and what solutions can be implemented to solve it?",
    userMessage:
      "我想写其中一个主体段：高糖食品消费过量导致肥胖和糖尿病激增，应当通过征收糖税和强制营养标签来缓解。",
    subpointContent:
      "高糖食品消费过量导致肥胖和糖尿病激增，应当通过征收糖税和强制营养标签来缓解。",
  },
  {
    name: "Deductive (Agree/Disagree)",
    question:
      "Some people think that governments should ban smoking in all public places to protect non-smokers. To what extent do you agree or disagree?",
    userMessage:
      "我想论证：在公共场所全面禁烟能够直接保护非吸烟者免受二手烟的健康危害。",
    subpointContent:
      "在公共场所全面禁烟能够直接保护非吸烟者免受二手烟的健康危害。",
  },
];

async function runCase(c) {
  // Mimic the real UI flow: a subpoint has already been created and selected,
  // so the Coach must treat it as the active subpoint (activeSubpointId set).
  const subpointContent = c.subpointContent || c.userMessage;
  const subpoint = {
    id: "body-1",
    content: subpointContent,
    isCompleted: false,
  };
  const body = {
    question: c.question,
    step: 3,
    userMessage: c.userMessage,
    messages: [],
    stepContext: { subpoints: [subpoint] },
    session: {
      step3: { subpoints: [subpoint], activeSubpointId: "body-1" },
    },
  };

  const res = await fetch(`${BASE}/api/coach/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  console.log("\n=====================================================");
  console.log(`CASE: ${c.name}`);
  if (!res.ok || data.error) {
    console.log(`  REQUEST FAILED (${res.status}): ${data.error || "unknown"}`);
    return;
  }
  const steps = data?.progressUpdate?.step3SubpointSteps;
  const plan = data?.progressUpdate?.paragraphPlan;

  if (c.printFull && data?.text) {
    console.log("  --- Coach text ---");
    console.log(
      data.text
        .split("\n")
        .map((l) => `  | ${l}`)
        .join("\n"),
    );
    console.log("  ------------------");
  }

  const jargonHits = chatTextHasForbiddenJargon(data?.text);
  console.log(
    `  -> JARGON CHECK (chat text): ${
      jargonHits.length === 0 ? "PASS (no forbidden terms)" : `FAIL (${jargonHits.join(", ")})`
    }`,
  );

  if (plan) {
    console.log("  paragraphPlan:");
    console.log(`    mode=${plan.mode}`);
    console.log(`    diagnosis=${plan.diagnosis}`);
    if (plan.totalClaim) console.log(`    totalClaim=${plan.totalClaim}`);
    if (Array.isArray(plan.pointBlocks)) {
      plan.pointBlocks.forEach((block, i) => {
        console.log(
          `    point ${i + 1}: id=${block.id} | label=${block.label} | role=${block.role} | strategy=${block.expansionStrategy}`,
        );
        console.log(`      subClaim=${block.subClaim}`);
        if (Array.isArray(block.steps)) {
          block.steps.forEach((step, j) => {
            console.log(
              `      ${j + 1}. key=${step.key} | label=${step.label} | value=${step.value || "<empty>"}`,
            );
          });
        }
      });
    }
  } else {
    console.log("  paragraphPlan: <missing>");
  }
  if (Array.isArray(steps) && steps.length > 0) {
    console.log("  step3SubpointSteps:");
    steps.forEach((s, i) =>
      console.log(`    ${i + 1}. key=${s.key} | label=${s.label}`),
    );
    const keys = steps.map((s) => (s.key || "").toLowerCase());
    const deductive = ["claim", "reason", "support", "impact"];
    const isDeductive =
      keys.length === deductive.length &&
      keys.every((k, i) => k.includes(deductive[i]));
    console.log(`  -> classified as: ${isDeductive ? "DEDUCTIVE" : "NON-DEDUCTIVE / CUSTOM"}`);
  } else {
    console.log("  step3SubpointSteps: <missing or empty>");
  }

  if (c.expectMultiPoint) {
    const blocks = Array.isArray(plan?.pointBlocks) ? plan.pointBlocks : [];
    const haystack = JSON.stringify(plan || {});
    const keywordChecks =
      Array.isArray(c.expectedPointKeywords) && c.expectedPointKeywords.length > 0
        ? c.expectedPointKeywords.map((kw) => ({
            kw,
            hit: haystack.includes(kw),
          }))
        : [
            { kw: "监管", hit: haystack.includes("监管") },
            { kw: "同伴/社交", hit: haystack.includes("同伴") || haystack.includes("社交") },
          ];
    const pass =
      blocks.length >= 2 && keywordChecks.every((item) => item.hit);
    console.log(
      `  -> MULTI-POINT ASSERTION: ${pass ? "PASS" : "FAIL"} ` +
        `(pointBlocks=${blocks.length}, ${keywordChecks
          .map((item) => `${item.kw}=${item.hit}`)
          .join(", ")})`,
    );
  }
  if (c.expectedAllowDualMajor) {
    const blocks = Array.isArray(plan?.pointBlocks) ? plan.pointBlocks : [];
    const majorCount = blocks.filter((b) => b?.role === "major").length;
    const dualMajorPass = blocks.length >= 2 && majorCount >= 2;
    console.log(
      `  -> DUAL-MAJOR ALLOWED ASSERTION: ${
        dualMajorPass ? "PASS" : "FAIL"
      } (pointBlocks=${blocks.length}, majorCount=${majorCount})`,
    );

    const point2Text = JSON.stringify(blocks[1] || {});
    const hasBridgeLanguage =
      /同时|也|此外|另外|同样|并且|而且|这也|另一方面|在职|工作/.test(
        point2Text,
      );
    console.log(
      `  -> POINT2 COHERENCE BRIDGE ASSERTION: ${
        hasBridgeLanguage ? "PASS" : "FAIL"
      }`,
    );
  }
}

async function main() {
  for (const c of cases) {
    try {
      await runCase(c);
    } catch (e) {
      console.log(`\nCASE: ${c.name}\n  ERROR: ${e.message}`);
    }
  }
  console.log("\nDone.");
}

main();
