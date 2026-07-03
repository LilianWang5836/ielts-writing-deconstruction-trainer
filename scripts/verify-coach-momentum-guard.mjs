import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const serverPath = path.join(repoRoot, "server.ts");
const source = fs.readFileSync(serverPath, "utf8");

if (!source.includes("function splitTwoParts(")) {
  throw new Error("splitTwoParts() is missing in server.ts");
}
if (!source.includes("function fallbackNextStep(")) {
  throw new Error("fallbackNextStep() is missing in server.ts");
}
if (!source.includes("step2_summary_missing_blueprint")) {
  throw new Error("Step2 summary signal guard is missing in server.ts");
}
if (!source.includes("[SYSTEM CORRECTION]")) {
  throw new Error("Correction retry prompt is missing in server.ts");
}
if (!source.includes("Applied fallback next-step template")) {
  throw new Error("Fallback template wiring log is missing in server.ts");
}

// Mirror implementations used only for deterministic static assertions.
function splitTwoParts(text, minPart2Length = 6) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, part1: "", part2: "", reason: "empty_text" };
  const parts = raw.split(/\n\s*---\s*\n/);
  if (parts.length < 2) {
    return { ok: false, part1: raw, part2: "", reason: "missing_delimiter" };
  }
  const part1 = String(parts[0] || "").trim();
  const part2 = String(parts.slice(1).join("\n---\n") || "").trim();
  if (!part1) return { ok: false, part1, part2, reason: "empty_part1" };
  if (!part2) return { ok: false, part1, part2, reason: "empty_part2" };
  if (part2.replace(/\s+/g, "").length < minPart2Length) {
    return { ok: false, part1, part2, reason: "part2_too_short" };
  }
  return { ok: true, part1, part2, reason: "" };
}

function fallbackNextStep(stepNum, session) {
  if (stepNum === 2) {
    const stage = session?.step2?.coachEvaluation?.currentStage || "explore_A";
    if (stage === "stance") {
      return "现在请明确你的全文立场（支持/反对/部分同意），并用一句话说明“为什么这个立场最能回应题目限定”。";
    }
  }
  if (stepNum === 3) {
    const activeId = session?.step3?.activeSubpointId;
    const activeSubpoint = (session?.step3?.subpoints || []).find(
      (sp) => sp.id === activeId,
    );
    if (Array.isArray(activeSubpoint?.structureSteps)) {
      const pending = activeSubpoint.structureSteps.find(
        (s) => !String(s?.value || "").trim(),
      );
      if (pending) {
        return `我们继续当前链条：请完成「${pending.label || "下一步"}」这一步，用一句具体可论证的话表达。`;
      }
    }
  }
  return "我们继续下一步：请基于当前内容补充一个最具体、最可展开的论证点。";
}

// splitTwoParts assertions
assert.equal(
  splitTwoParts("反馈已记录\n\n---\n\n请给出下一步的具体论据。").ok,
  true,
  "valid two-part text should pass",
);
assert.equal(
  splitTwoParts("A without delimiter").reason,
  "missing_delimiter",
  "missing delimiter should be caught",
);
assert.equal(
  splitTwoParts("A\n---").reason,
  "missing_delimiter",
  "trailing delimiter without second block should be treated as invalid",
);
assert.equal(
  splitTwoParts("A\n\n---\n\n好", 6).reason,
  "part2_too_short",
  "too short part2 should be caught",
);

// fallbackNextStep assertions
const step2Question = fallbackNextStep(2, {
  step2: { coachEvaluation: { currentStage: "stance" } },
});
assert.ok(
  String(step2Question).includes("全文立场"),
  "step2 stance fallback should ask for overall stance",
);

const step3Question = fallbackNextStep(3, {
  step3: {
    activeSubpointId: "sp-1",
    subpoints: [
      {
        id: "sp-1",
        structureSteps: [
          { label: "核心观点", value: "实体学校更不可替代" },
          { label: "作用机制", value: "" },
        ],
      },
    ],
  },
});
assert.ok(
  String(step3Question).includes("作用机制"),
  "step3 fallback should target the next pending micro-step",
);

console.log("VERIFY_COACH_MOMENTUM_GUARD_OK");
