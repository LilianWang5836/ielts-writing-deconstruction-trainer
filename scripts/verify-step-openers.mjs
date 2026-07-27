import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function readSrc(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function assertTrue(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`OK: ${msg}`);
}

const coachChat = readSrc("src/components/CoachChat.tsx");
const step2 = readSrc("src/components/Step2Brainstorm.tsx");
const step3 = readSrc("src/components/Step3Drafting.tsx");

// 1. CoachChat: kickoffContextKey prop exists and replaces hardcoded step3 coupling
assertTrue(
  coachChat.includes("kickoffContextKey?: string"),
  "CoachChat.tsx declares kickoffContextKey prop"
);
assertTrue(
  coachChat.includes("kickoffContextKey = ''"),
  "CoachChat.tsx defaults kickoffContextKey to ''"
);
assertTrue(
  coachChat.includes("const kickoffKey = `${stepKey}:${kickoffContextKey}`;"),
  "CoachChat.tsx kickoff key uses generic kickoffContextKey prop"
);
assertTrue(
  !coachChat.includes("session?.step3?.activeSubpointId || ''"),
  "CoachChat.tsx no longer hardcodes session.step3.activeSubpointId in kickoff key"
);
assertTrue(
  coachChat.includes("kickoffContextKey,") && coachChat.includes("chatHistory,\n    stepKey,\n    kickoffContextKey,"),
  "CoachChat.tsx effect dependency array uses kickoffContextKey instead of session.step3 field"
);

// 2. Step3Drafting: passes kickoffContextKey derived from activeSubpoint
assertTrue(
  step3.includes("kickoffContextKey={activeSubpoint?.id || ''}"),
  "Step3Drafting.tsx passes kickoffContextKey={activeSubpoint?.id || ''}"
);
assertTrue(
  step3.includes("autoKickoff={true}") && step3.includes("kickoffPrompt={kickoffPrompt}"),
  "Step3Drafting.tsx still wires autoKickoff + kickoffPrompt unchanged (regression check)"
);
assertTrue(
  step3.includes("mode=expand") &&
    step3.includes("禁止 mode=confirm") &&
    step3.includes("禁止让我一次性确认"),
  "Step3Drafting kickoffPrompt requires expand and forbids confirm bundle"
);
assertTrue(
  !step3.includes("整理成草稿") && !step3.includes("并先请我一次性确认"),
  "Step3Drafting kickoffPrompt no longer asks to organize drafts for one-shot confirm"
);

// 3. Step2Brainstorm: heuristic keyword branches removed
const heuristicNames = [
  "isReplacementTheme",
  "isGovSpendingTheme",
  "isEnvironmentalTheme",
  "isTechTheme",
  "dynamicQ1",
];
for (const name of heuristicNames) {
  assertTrue(!step2.includes(name), `Step2Brainstorm.tsx no longer references heuristic "${name}"`);
}

// 4. Step2Brainstorm: welcomeMessage is a pure bridge (no committed question mark content)
assertTrue(
  step2.includes("我正在结合你第一步的审题结论，为你定制第一个发散问题") &&
    step2.includes("我正在结合这道题目，为你定制第一个发散问题"),
  "Step2Brainstorm.tsx welcomeMessage is a bridge line without a committed question"
);

// 5. Step2Brainstorm: kickoffPrompt is defined, non-trivial, and explicitly disclaims responding to prior user text
assertTrue(
  step2.includes("const kickoffPrompt = (() => {"),
  "Step2Brainstorm.tsx defines a kickoffPrompt builder"
);
assertTrue(
  step2.includes("请不要假装在回应我说过的内容"),
  "Step2Brainstorm.tsx kickoffPrompt explicitly disclaims responding to prior user text"
);
assertTrue(
  step2.includes("autoKickoff={true}") && step2.includes("kickoffPrompt={kickoffPrompt}"),
  "Step2Brainstorm.tsx wires autoKickoff + kickoffPrompt into <CoachChat>"
);
assertTrue(
  !step2.includes("kickoffContextKey="),
  "Step2Brainstorm.tsx intentionally omits kickoffContextKey (fires once per empty history)"
);

console.log("\nAll step-opener static assertions passed.");
