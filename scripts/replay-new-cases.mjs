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

function printJargonCheck(label, text = "") {
  const hits = chatTextHasForbiddenJargon(text);
  console.log(
    `Check: ${label} chat text has no internal jargon => ${
      hits.length === 0 ? "YES (GOOD)" : `NO (BAD: ${hits.join(", ")})`
    }`,
  );
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
  printJargonCheck("case1 step2 explore_B", case1.text);

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
  printJargonCheck("case2 step3 fragment", case2.text);

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
  printJargonCheck("case3 step3 complete logic", case3.text);

  // Case 4: Step3 two-point claim -> symmetric points may both be major when concise
  const case4User =
    "线上学习既能打破地理限制帮助偏远地区学生，也能给在职人员提供灵活学习时间。";
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
  printCase("Step3 two-point claim (dual-major allowed)", case4User, case4);
  const plan4 = case4?.progressUpdate?.paragraphPlan;
  if (plan4 && Array.isArray(plan4.pointBlocks)) {
    const roles = plan4.pointBlocks.map((b) => b.role);
    const majorCount = roles.filter((r) => r === "major").length;
    console.log(`paragraphPlan.mode => ${plan4.mode}`);
    console.log(`pointBlock roles => ${JSON.stringify(roles)}`);
    console.log(
      `Check: can use both 'major' for symmetric two-point claim => ${
        plan4.pointBlocks.length >= 2 && majorCount >= 2 ? "YES (GOOD)" : "NO (REVIEW)"
      }`,
    );
    const point2Text = JSON.stringify(plan4.pointBlocks[1] || {});
    console.log(
      `Check: point2 has bridge/cohesion language => ${
        /同时|也|此外|另外|同样|并且|而且|这也|另一方面/.test(point2Text)
          ? "YES (GOOD)"
          : "NO (REVIEW)"
      }`,
    );
  } else {
    console.log("paragraphPlan missing or has no pointBlocks");
  }
  printJargonCheck("case4 step3 two-point", case4.text);

  // Case 4b: Step3 user override should update recommended plan (non-blocking)
  const case4bUser =
    "我想两个点都详细展开，不要一个主一个次，而且第二点先讲场景再讲结果。";
  const case4b = await postCoach({
    question,
    step: 3,
    userMessage: case4bUser,
    messages: [
      { sender: "user", text: case4User },
      { sender: "ai", text: case4.text },
      { sender: "user", text: case4bUser },
    ],
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
  printCase("Step3 override recommendation -> plan updated", case4bUser, case4b);
  const plan4b = case4b?.progressUpdate?.paragraphPlan;
  if (plan4b && Array.isArray(plan4b.pointBlocks)) {
    const roles = plan4b.pointBlocks.map((b) => b.role);
    const point2 = plan4b.pointBlocks[1] || {};
    const point2StepKeys = Array.isArray(point2.steps)
      ? point2.steps.map((s) => String(s?.key || "").toLowerCase())
      : [];
    const scenarioBeforeImpact =
      point2StepKeys.some((k) => k.includes("scenario") || k.includes("example")) &&
      point2StepKeys.some((k) => k.includes("impact") || k.includes("result"));
    const dualMajor = roles.filter((r) => r === "major").length >= 2;
    const overrideAdopted = dualMajor || scenarioBeforeImpact;
    console.log(
      `Check: override accepted (both points detailed) => ${
        overrideAdopted ? "YES (GOOD)" : "NO (REVIEW)"
      }`,
    );
  } else {
    console.log("Check: override accepted => NO (paragraphPlan missing)");
  }
  console.log(
    `Check: coach acknowledges switch in chat text => ${
      /没问题|按你|按你说|按照你|尊重你的想法|改成|调整|换成|可以/.test(
        String(case4b?.text || ""),
      )
        ? "YES (GOOD)"
        : "NO (REVIEW)"
    }`,
  );
  printJargonCheck("case4b step3 override", case4b.text);

  // Case 5: Step2 Dimension Coverage & Retention (real case replay) — the coach's own
  // question named two sub-dimensions ("面对面互动" + "老师监管"), but the student only
  // develops one (监管, with a concrete beneficiary: young/low-self-control kids). The
  // coach must NOT silently transition to "stance" while dropping the uncovered "互动"
  // dimension, must NOT invent its concrete mechanism/scenario, and once the student makes
  // a retention decision, must transition without re-asking.
  const case5CoachQuestion =
    "你之前提到线下教育的“互动性更强，也有老师监督”。顺着这个思路，哪类具体的课堂场景最能体现这种“面对面互动与监督”的不可替代性？它对哪类特定学生群体（比如年龄或自觉性较低的学习者）影响最大？";
  const case5UserTurn1 =
    "对于年纪小的孩子来说，自律性低，在家里很容易开小差，学校里有老师监管学习效率会更高一些";
  const case5Session = {
    step1: {
      coachEvaluation: {
        correctType: "Agree or Disagree",
        coreIssue: "线上教育是否应完全替代线下课堂",
        constraints: ["entirely", "replace"],
        suggestedDimensions: [
          "线上灵活性与资源可及性 (打破地理限制，时间自由)",
          "线下不可替代性 (面对面互动，教师即时监督)",
        ],
      },
    },
    step2: {
      coachEvaluation: {
        currentStage: "explore_B",
        userStance: "",
        userPoints: "A面：帮助在职人员克服时间与空间障碍，实现灵活学习。",
        critique: "",
        suggestions: [],
        suggestedStance: "",
        suggestedPoints: "",
      },
    },
  };

  const case5Turn1 = await postCoach({
    question,
    step: 2,
    userMessage: case5UserTurn1,
    messages: [
      { sender: "ai", text: `很好\n\n---\n\n${case5CoachQuestion}` },
      { sender: "user", text: case5UserTurn1 },
    ],
    stepContext: {},
    session: case5Session,
  });
  printCase(
    "Step2 dimension coverage & retention (real case, turn 1)",
    case5UserTurn1,
    case5Turn1,
  );
  const stage5Turn1 = case5Turn1?.progressUpdate?.step2Data?.currentStage;
  console.log(
    `Check: stays in explore_B, not silently jumped to stance => ${
      stage5Turn1 === "explore_B" ? "YES (GOOD)" : `NO (BAD, got ${stage5Turn1})`
    }`,
  );
  console.log(
    `Check: mentions the uncovered "互动" dimension => ${
      String(case5Turn1.text).includes("互动") ? "YES (GOOD)" : "NO (BAD)"
    }`,
  );
  console.log(
    `Check: has follow-up/retention question in Part2 => ${
      hasLikelyFollowupQuestion(case5Turn1.text) ? "YES" : "NO"
    }`,
  );
  printJargonCheck("case5 turn1", case5Turn1.text);
  const inventedInteractionPhrases = [
    "小组讨论",
    "协作任务",
    "即时倾听不同的观点",
    "面对面的妥协与协作",
  ];
  const invented = inventedInteractionPhrases.some((p) =>
    String(case5Turn1.text).includes(p),
  );
  console.log(
    `Check: did NOT invent concrete mechanism for "互动" => ${
      invented ? "NO (BAD)" : "YES (GOOD)"
    }`,
  );
  console.log(
    `Check: gives a reasoned default recommendation (not open-ended A/B) => ${
      String(case5Turn1.text).includes("建议") ? "YES (GOOD)" : "NO (BAD)"
    }`,
  );

  const step2DataTurn1 = case5Turn1?.progressUpdate?.step2Data || {};
  const userPointsTurn1 = String(step2DataTurn1.userPoints || "");
  const markerMatch = /［待裁决：([^｜］]+)(?:｜([^］]+))?］/.exec(userPointsTurn1);
  const recommendation = markerMatch ? markerMatch[2] : null;
  console.log(`Recommendation embedded in pending marker => ${recommendation || "(none found)"}`);

  function mergedSession(step2DataOverride) {
    return {
      ...case5Session,
      step2: {
        coachEvaluation: {
          ...case5Session.step2.coachEvaluation,
          ...step2DataOverride,
        },
      },
    };
  }

  // Turn 2a: student gives a VAGUE confirmation ("好的"). Coach must interpret this as
  // ACCEPTING the recommendation that was actually proposed (not always the same fixed
  // outcome regardless of what was recommended), then transition without re-asking.
  const case5UserTurn2a = "好的";
  const case5Turn2a = await postCoach({
    question,
    step: 2,
    userMessage: case5UserTurn2a,
    messages: [
      { sender: "ai", text: `很好\n\n---\n\n${case5CoachQuestion}` },
      { sender: "user", text: case5UserTurn1 },
      { sender: "ai", text: case5Turn1.text },
      { sender: "user", text: case5UserTurn2a },
    ],
    stepContext: {},
    session: mergedSession(step2DataTurn1),
  });
  printCase(
    "Step2 vague confirmation ('好的') -> accepts proposed recommendation (turn 2a)",
    case5UserTurn2a,
    case5Turn2a,
  );
  const stage5Turn2a = case5Turn2a?.progressUpdate?.step2Data?.currentStage;
  const userPointsTurn2a = String(case5Turn2a?.progressUpdate?.step2Data?.userPoints || "");
  console.log(
    `Check: transitions to stance after vague confirmation => ${
      stage5Turn2a === "stance" ? "YES (GOOD)" : `NO (BAD, got ${stage5Turn2a})`
    }`,
  );
  if (recommendation === "KEEP_MINOR") {
    console.log(
      `Check: vague "好的" accepted KEEP_MINOR -> recorded as 保留-略写 => ${
        userPointsTurn2a.includes("保留-略写") ? "YES (GOOD)" : `NO (BAD): ${userPointsTurn2a}`
      }`,
    );
  } else if (recommendation === "DROP") {
    console.log(
      `Check: vague "好的" accepted DROP -> recorded as 用户放弃 => ${
        userPointsTurn2a.includes("用户放弃") ? "YES (GOOD)" : `NO (BAD): ${userPointsTurn2a}`
      }`,
    );
  }
  printJargonCheck("case5 turn2a", case5Turn2a.text);

  // Turn 2b: student EXPLICITLY CONTRADICTS the proposed recommendation. Coach must flip
  // the outcome relative to what was recommended, not just default to one fixed answer.
  const contradictionMessage =
    recommendation === "DROP" ? "还是保留互动，简单提一句作为略写点" : "算了，放弃互动这个点吧";
  const case5Turn2b = await postCoach({
    question,
    step: 2,
    userMessage: contradictionMessage,
    messages: [
      { sender: "ai", text: `很好\n\n---\n\n${case5CoachQuestion}` },
      { sender: "user", text: case5UserTurn1 },
      { sender: "ai", text: case5Turn1.text },
      { sender: "user", text: contradictionMessage },
    ],
    stepContext: {},
    session: mergedSession(step2DataTurn1),
  });
  printCase(
    "Step2 explicit contradiction of recommendation -> flips outcome (turn 2b)",
    contradictionMessage,
    case5Turn2b,
  );
  const userPointsTurn2b = String(case5Turn2b?.progressUpdate?.step2Data?.userPoints || "");
  if (recommendation === "KEEP_MINOR") {
    console.log(
      `Check: explicit "放弃" overrides KEEP_MINOR -> recorded as 用户放弃 => ${
        userPointsTurn2b.includes("用户放弃") ? "YES (GOOD)" : `NO (BAD): ${userPointsTurn2b}`
      }`,
    );
  } else if (recommendation === "DROP") {
    console.log(
      `Check: explicit "保留" overrides DROP -> recorded as 保留-略写 => ${
        userPointsTurn2b.includes("保留-略写") ? "YES (GOOD)" : `NO (BAD): ${userPointsTurn2b}`
      }`,
    );
  }
  printJargonCheck("case5 turn2b", case5Turn2b.text);

  // Turn 2c (original scenario, kept for backward-compatible regression coverage): student
  // makes an explicit "keep as minor" retention decision. Coach must record it and
  // transition to "stance" without re-asking about the same uncovered dimension.
  const case5UserTurn2c = "保留吧，作为一个简单提一下的点就行";
  const case5Turn2c = await postCoach({
    question,
    step: 2,
    userMessage: case5UserTurn2c,
    messages: [
      { sender: "ai", text: `很好\n\n---\n\n${case5CoachQuestion}` },
      { sender: "user", text: case5UserTurn1 },
      { sender: "ai", text: case5Turn1.text },
      { sender: "user", text: case5UserTurn2c },
    ],
    stepContext: {},
    session: mergedSession(step2DataTurn1),
  });
  printCase(
    "Step2 dimension retention decision -> transition (turn 2c)",
    case5UserTurn2c,
    case5Turn2c,
  );
  const stage5Turn2c = case5Turn2c?.progressUpdate?.step2Data?.currentStage;
  console.log(
    `Check: transitions to stance after decision => ${
      stage5Turn2c === "stance" ? "YES (GOOD)" : `NO (BAD, got ${stage5Turn2c})`
    }`,
  );
  const part2Turn2c = String(case5Turn2c.text).split(/\n\s*---\s*\n/)[1] || "";
  console.log(
    `Check: does not repeat the retention question => ${
      !/(保留|放弃).{0,10}[？?]/.test(part2Turn2c) ? "YES (GOOD)" : "NO (possible repeat, review manually)"
    }`,
  );
  printJargonCheck("case5 turn2c", case5Turn2c.text);

  // Case 6: Step1 completion — chat text must not leak internal JSON field names
  const case6User =
    "可以从线上学习的灵活性与资源可及性、以及线下课堂在互动与监管上的不可替代性这几个维度来讨论。";
  const case6 = await postCoach({
    question,
    step: 1,
    userMessage: case6User,
    messages: [
      {
        sender: "ai",
        text:
          "很好！你已经抓住了核心争议。\n\n---\n\n题目里有没有哪些词，限制了讨论范围？请列 1~3 个。",
      },
      { sender: "user", text: "entirely，也就是完全取代，不能部分替代" },
      {
        sender: "ai",
        text:
          "关键限定记下了。\n\n---\n\n为了回答这道题，我们需要比较哪些方面？请列出 2~4 个维度即可。",
      },
      { sender: "user", text: case6User },
    ],
    stepContext: {},
    session: {
      step1: {
        coachEvaluation: {
          correctType: "Agree or Disagree",
          coreIssue: "线上教育是否应完全取代传统课堂",
          constraints: ["entirely (完全取代)"],
          critique: "",
          score: 7,
          suggestedDimensions: [],
        },
      },
    },
  });
  printCase("Step1 completion summary (dimensions filled)", case6User, case6);
  console.log(
    `Check: Step1 completion sets isCompleted => ${
      case6?.progressUpdate?.isCompleted ? "YES (GOOD)" : "NO (review manually)"
    }`,
  );
  printJargonCheck("case6 step1 completion", case6.text);

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
