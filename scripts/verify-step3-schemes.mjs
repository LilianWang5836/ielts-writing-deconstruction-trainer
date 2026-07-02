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

const cases = [
  {
    name: "Concession (Discuss Both Views)",
    question:
      "With the rapid development of Artificial Intelligence (AI), some think it will bring more benefits to workers, while others fear it will cause widespread unemployment. Discuss both views and give your opinion.",
    userMessage:
      "我想论证：虽然 AI 会取代部分重复性岗位，但总体上它为劳动者创造了更多新型的、更有价值的工作机会。",
  },
  {
    name: "Problem-Solution",
    question:
      "The increasing consumption of sugar-rich foods and drinks is leading to serious health problems worldwide. What are the causes of this issue, and what solutions can be implemented to solve it?",
    userMessage:
      "我想写其中一个主体段：高糖食品消费过量导致肥胖和糖尿病激增，应当通过征收糖税和强制营养标签来缓解。",
  },
  {
    name: "Deductive (Agree/Disagree)",
    question:
      "Some people think that governments should ban smoking in all public places to protect non-smokers. To what extent do you agree or disagree?",
    userMessage:
      "我想论证：在公共场所全面禁烟能够直接保护非吸烟者免受二手烟的健康危害。",
  },
];

async function runCase(c) {
  const body = {
    question: c.question,
    step: 3,
    userMessage: c.userMessage,
    messages: [],
    stepContext: { subpoints: [] },
    session: {
      step3: { subpoints: [], activeSubpointId: null },
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
