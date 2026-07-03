const BASE_URL = process.env.PROBE_BASE_URL || "http://localhost:3000";

const topicQuestion =
  "Some people believe that online learning is highly beneficial and should replace traditional classroom education entirely. To what extent do you agree or disagree?";

const rounds = [
  {
    label: "Step1-R1",
    step: 1,
    userMessage:
      "我认为线上学习不应该完全取代线下学校，特别是对自律差、正在成长中的儿童来说。",
    stepContext: {},
  },
  {
    label: "Step2-R1",
    step: 2,
    userMessage:
      "我的立场是不同意完全替代。主要论点有两个：教师监管与同伴互动都很难在纯线上环境中实现。",
    stepContext: {},
  },
  {
    label: "Step2-R2",
    step: 2,
    userMessage:
      "先展开第一个角度：缺乏教师现场监管会导致注意力分散、作业拖延和学习效率下降。",
    stepContext: {},
  },
  {
    label: "Step3-R1",
    step: 3,
    userMessage:
      "我想论证这个主体段：对于自律性差且处于社交发展关键期的儿童，实体学校提供必不可少的行为监管和同伴互动环境。",
    stepContext: {
      subpoints: [
        {
          id: "body-1",
          content:
            "对于自律性差且处于社交发展关键期的儿童，实体学校提供必不可少的行为监管和同伴互动环境。",
          isCompleted: false,
        },
      ],
    },
  },
];

function ensureStepSession(step, session) {
  if (step === 1) session.step1 ??= {};
  if (step === 2) session.step2 ??= {};
  if (step === 3) session.step3 ??= {};
}

function updateSessionFromProgress(step, progressUpdate, session, userMessage) {
  ensureStepSession(step, session);

  if (step === 1) {
    session.step1.userAnalysisNotes = userMessage;
    session.step1.coachEvaluation = {
      ...(session.step1.coachEvaluation || {}),
      ...progressUpdate,
    };
  }

  if (step === 2) {
    session.step2.coachEvaluation = {
      ...(session.step2.coachEvaluation || {}),
      ...progressUpdate,
    };
    if (progressUpdate?.userStance) {
      session.step2.userStance = progressUpdate.userStance;
    }
    if (progressUpdate?.userPoints) {
      session.step2.userPoints = progressUpdate.userPoints;
    }
  }

  if (step === 3) {
    const existingSubpoints = session.step3.subpoints || [];
    const incomingSubpoints = progressUpdate?.subpoints || [];
    session.step3.subpoints =
      incomingSubpoints.length > 0 ? incomingSubpoints : existingSubpoints;
    if (!session.step3.activeSubpointId && session.step3.subpoints?.length > 0) {
      session.step3.activeSubpointId = session.step3.subpoints[0].id;
    }
  }
}

async function callCoach({ step, userMessage, stepContext, messages, session }) {
  const payload = {
    question: topicQuestion,
    step,
    userMessage,
    stepContext,
    messages,
    session,
  };

  const res = await fetch(`${BASE_URL}/api/coach/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${data.error || "Unknown error"}`);
  }
  if (data?.error) {
    throw new Error(data.error);
  }
  return data;
}

async function main() {
  const session = {
    step1: { chatHistory: [] },
    step2: { chatHistory: [] },
    step3: {
      chatHistory: [],
      subpoints: [],
      activeSubpointId: null,
    },
  };

  const messagesByStep = {
    1: [],
    2: [],
    3: [],
  };

  for (const round of rounds) {
    const stepMessages = messagesByStep[round.step];
    stepMessages.push({ sender: "user", text: round.userMessage });

    if (round.step === 3 && round.stepContext?.subpoints?.length) {
      session.step3.subpoints = round.stepContext.subpoints;
      session.step3.activeSubpointId = round.stepContext.subpoints[0].id;
    }

    const data = await callCoach({
      step: round.step,
      userMessage: round.userMessage,
      stepContext: round.stepContext,
      messages: stepMessages,
      session,
    });

    const coachText = data?.text || "<empty>";
    stepMessages.push({ sender: "ai", text: coachText });
    updateSessionFromProgress(round.step, data?.progressUpdate || {}, session, round.userMessage);

    console.log("\n============================================================");
    console.log(`[${round.label}] Step ${round.step}`);
    console.log("Coach Reply:");
    console.log(
      String(coachText)
        .split("\n")
        .map((line) => `| ${line}`)
        .join("\n"),
    );
    console.log("------------------------------------------------------------");
    if (data?.progressUpdate?.currentStage) {
      console.log(`currentStage: ${data.progressUpdate.currentStage}`);
    }
    if (data?.progressUpdate?.paragraphPlan?.mode) {
      console.log(`paragraphPlan.mode: ${data.progressUpdate.paragraphPlan.mode}`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
