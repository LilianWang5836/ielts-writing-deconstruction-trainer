const BASE = process.env.PROBE_BASE_URL || "http://localhost:3000";

async function postCoach(body) {
  const res = await fetch(`${BASE}/api/coach/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`HTTP ${res.status}: ${data.error || "unknown error"}`);
  }
  return data;
}

function printCase(title, userMessage, data) {
  console.log("\n=====================================================");
  console.log(`CASE: ${title}`);
  console.log(`User: ${userMessage}`);
  console.log("Coach:");
  console.log(
    String(data?.text || "")
      .split("\n")
      .map((line) => `| ${line}`)
      .join("\n"),
  );
  if (data?.progressUpdate?.step2Data?.currentStage) {
    console.log(`currentStage => ${data.progressUpdate.step2Data.currentStage}`);
  }
}

function hasLikelyFollowupQuestion(text = "") {
  const part2 = String(text).split(/\n\s*---\s*\n/)[1] || "";
  return /[？?]/.test(part2);
}

function hasForbiddenAutofill(text = "") {
  const badPhrases = [
    "即时沟通与答疑",
    "跨越千山万水",
    "打破了传统学校在地理空间上的界限",
  ];
  return badPhrases.some((p) => String(text).includes(p));
}

async function main() {
  const question =
    "Some people believe that online learning is highly beneficial and should replace traditional classroom education entirely. To what extent do you agree or disagree?";

  // Case 1: Step2 bad-case replay (label repeat in explore_B should trigger follow-up, not AI autofill)
  const case1User = "面对面互动，教师即时监督与纪律管理";
  const case1 = await postCoach({
    question,
    step: 2,
    userMessage: case1User,
    messages: [{ sender: "user", text: case1User }],
    stepContext: {},
    session: {
      step1: {
        coachEvaluation: {
          correctType: "Agree or Disagree",
          coreIssue: "线上教育是否应完全替代线下课堂",
          constraints: ["entirely", "replace"],
          critique: "ok",
          score: 7,
          suggestedDimensions: [
            "线上灵活性与资源可及性 (打破地理限制，时间自由)",
            "线下不可替代性 (面对面互动，教师即时监督与纪律管理)",
          ],
        },
      },
      step2: {
        coachEvaluation: {
          currentStage: "explore_B",
          userStance: "",
          userPoints: "A面：线上灵活性与资源可及性",
          critique: "",
          suggestions: [],
          suggestedStance: "",
          suggestedPoints: "",
        },
      },
    },
  });
  printCase("Step2 explore_B label-repeat", case1User, case1);
  console.log(
    `Check: has follow-up question in Part2 => ${hasLikelyFollowupQuestion(case1.text) ? "YES" : "NO"}`,
  );
  console.log(
    `Check: contains forbidden autofill phrase => ${hasForbiddenAutofill(case1.text) ? "YES (BAD)" : "NO (GOOD)"}`,
  );

  // Case 2: Step3 bad-case replay (fragment should trigger follow-up, not auto-complete causal chain)
  const case2User = "User 现在有很多edtech的平台，会和知名学校";
  const case2 = await postCoach({
    question,
    step: 3,
    userMessage: case2User,
    messages: [{ sender: "user", text: case2User }],
    stepContext: {
      subpoints: [
        {
          id: "body-1",
          content: "线上教育能通过资源连接提升教育公平",
          isCompleted: false,
        },
      ],
    },
    session: {
      step3: {
        subpoints: [
          {
            id: "body-1",
            content: "线上教育能通过资源连接提升教育公平",
            isCompleted: false,
          },
        ],
        activeSubpointId: "body-1",
      },
    },
  });
  printCase("Step3 fragment input", case2User, case2);
  console.log(
    `Check: has follow-up question in Part2 => ${hasLikelyFollowupQuestion(case2.text) ? "YES" : "NO"}`,
  );
  console.log(
    `Check: contains forbidden autofill phrase => ${hasForbiddenAutofill(case2.text) ? "YES (BAD)" : "NO (GOOD)"}`,
  );

  // Case 3: Step3 good-case replay (complete logic should allow polish)
  const case3User =
    "对工作的人来说，这种方式能够让他们兼顾职业与学业，并且通过学习进一步提升工作技能，促进职业发展。";
  const case3 = await postCoach({
    question,
    step: 3,
    userMessage: case3User,
    messages: [{ sender: "user", text: case3User }],
    stepContext: {
      subpoints: [
        {
          id: "body-1",
          content: "线上教育对在职人群的时间与职业发展价值",
          isCompleted: false,
        },
      ],
    },
    session: {
      step3: {
        subpoints: [
          {
            id: "body-1",
            content: "线上教育对在职人群的时间与职业发展价值",
            isCompleted: false,
          },
        ],
        activeSubpointId: "body-1",
      },
    },
  });
  printCase("Step3 complete logic input", case3User, case3);
  console.log(
    `Check: has follow-up question in Part2 => ${hasLikelyFollowupQuestion(case3.text) ? "YES" : "NO"}`,
  );

  // Case 4: Step3 two-point claim -> length budget should avoid two 'major' points
  const case4User =
    "传统课堂所提供的即时人际互动与必不可少的教学监管，是线上教育无法企及且不可替代的。";
  const case4 = await postCoach({
    question,
    step: 3,
    userMessage: case4User,
    messages: [{ sender: "user", text: case4User }],
    stepContext: {
      subpoints: [{ id: "body-1", content: case4User, isCompleted: false }],
    },
    session: {
      step3: {
        subpoints: [{ id: "body-1", content: case4User, isCompleted: false }],
        activeSubpointId: "body-1",
      },
    },
  });
  printCase("Step3 two-point claim (length budget)", case4User, case4);
  const plan4 = case4?.progressUpdate?.paragraphPlan;
  if (plan4 && Array.isArray(plan4.pointBlocks)) {
    const roles = plan4.pointBlocks.map((b) => b.role);
    const majorCount = roles.filter((r) => r === "major").length;
    console.log(`paragraphPlan.mode => ${plan4.mode}`);
    console.log(`pointBlock roles => ${JSON.stringify(roles)}`);
    console.log(
      `Check: not both 'major' (length budget respected) => ${
        plan4.pointBlocks.length >= 2 && majorCount >= 2 ? "NO (BAD)" : "YES (GOOD)"
      }`,
    );
  } else {
    console.log("paragraphPlan missing or has no pointBlocks");
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
