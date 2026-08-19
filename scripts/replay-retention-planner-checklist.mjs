/**
 * Paper + unit replay of the latest public-transport session path
 * against the retention-lock + planner checklist.
 *
 * Run: npx tsx scripts/replay-retention-planner-checklist.mjs
 */
import assert from "node:assert/strict";
import {
  preserveLockedRetentionInUserPoints,
  userMessageRequestsRetentionChange,
  extractRetentionLocksFromUserPoints,
  suggestPlannerBodyCount,
  expandPackedDetailBodies,
  applyRetentionRolesFromUserPoints,
  isSubstantiveBrainstormContent,
  isStanceOrConfirmOnlyMessage,
  isExplicitSlotAddConfirm,
  isExplicitSlotAddReject,
  resolveSlotAddDecision,
  isStep2SystemOrKickoffMessage,
  scrubStep2KickoffPollution,
  cleanElaboration,
  attachTextToPointId,
  extractFocusClaimFromCoachText,
  findPointIdByClaim,
  shouldClearStep2DeepenFocus,
  normalizeStep2PlannerPayload,
} from "../src/server/step2/planner-payload.ts";

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("\n[Replay] A — retention lock (都详细写 → summary rewrite)\n");

// Turn: student says 都详细写; model tags both detail
const afterBothDetail =
  "A面：环境保护与交通效率（通过多设站点、覆盖主干道、增加车次缩短等待时间，吸引私家车主改乘，缓解拥堵与尾气排放）（已选详写）；居民出行与社会公平（方便没有车或偏远地区居民出行）（已选详写）；";

assert.equal(userMessageRequestsRetentionChange("都详细写"), true);
ok('「都详细写」counts as user retention change');

const locks = extractRetentionLocksFromUserPoints(afterBothDetail);
assert.equal(locks.filter((l) => l.role === "detail").length, 2);
ok("two detail locks extracted from userPoints");

// Later summary model drops 详写 on 环保 (the bug)
const rewrittenDropEnv =
  "A面：环境保护与交通效率（通过多设站点吸引私家车主改乘）；居民出行与社会公平（增开偏远专线）（已选详写）；B面：政府预算分配与公共服务（挤占公园资金）（已选详写）";

const restored = preserveLockedRetentionInUserPoints(
  afterBothDetail,
  rewrittenDropEnv,
  { allowUserChange: false },
);
assert.match(restored, /环境保护[\s\S]*已选详写/);
assert.match(restored, /居民出行[\s\S]*已选详写/);
ok("system rewrite cannot strip 环保 已选详写");

const userChanges = preserveLockedRetentionInUserPoints(
  afterBothDetail,
  "A面：环境保护与交通效率（…）（已选略写）；居民出行与社会公平（…）（已选详写）",
  { allowUserChange: true },
);
assert.match(userChanges, /环境保护[\s\S]*已选略写/);
ok("user-initiated change is allowed when flagged");

console.log("\n[Replay] B — planner bodyCount + no silent demote\n");

const points = [
  {
    id: "p1",
    claim: "环境保护与交通效率",
    elaboration: "加密站点班次吸引车主改乘，缓解拥堵与尾气",
    quality: "ready",
    leanTags: ["environment"],
  },
  {
    id: "p2",
    claim: "居民出行与社会公平",
    elaboration: "偏远专线与低收入票价补贴",
    quality: "ready",
    leanTags: ["society"],
  },
  {
    id: "p3",
    claim: "政府预算分配与公共服务",
    elaboration: "挤占公园图书馆资金影响休闲",
    quality: "ready",
    leanTags: ["economy"],
  },
];

const stamped = applyRetentionRolesFromUserPoints(
  points,
  "A面：环境保护与交通效率（已选详写）；居民出行与社会公平（已选详写）；B面：政府预算分配与公共服务（已选详写）",
);
assert.equal(stamped.every((p) => p.retentionRole === "detail"), true);
ok("all three points stamped detail from locked userPoints");

const payload = { points: stamped, redirects: {} };
assert.equal(suggestPlannerBodyCount(payload), 3);
ok("soft hint bodyCount≈3 for 3 detail+ready (not default 2)");

// Planner wrongly packed two A-side details into dual_point minor
const packed = [
  {
    id: "body-1",
    targetBody: "Body Paragraph 1",
    mappedPointIds: ["p1", "p2"],
    paragraphDensity: "dual_point",
    paragraphPlan: {
      mode: "direct_points",
      pointBlocks: [
        { id: "pb1", role: "major", label: "公平", steps: [] },
        { id: "pb2", role: "minor", label: "环保", steps: [] },
      ],
    },
  },
  {
    id: "body-2",
    targetBody: "Body Paragraph 2",
    mappedPointIds: ["p3"],
    paragraphDensity: "single_point",
    paragraphPlan: {
      mode: "single_point",
      pointBlocks: [{ id: "pb3", role: "major", label: "预算", steps: [] }],
    },
  },
];

const expanded = expandPackedDetailBodies(packed, payload);
assert.equal(expanded.length, 3);
const minorLeft = expanded.some((bp) =>
  (bp.paragraphPlan?.pointBlocks || []).some(
    (b) => b.role === "minor" && (bp.mappedPointIds || []).some((id) => id === "p1" || id === "p2"),
  ),
);
assert.equal(minorLeft, false);
ok("packed dual_point with 2 detail points splits to 3 bodies; no detail-as-minor");

console.log("\n[Replay] C — Step3 whole-step CTA regression (source scan)\n");
import fs from "node:fs";
import path from "node:path";
const serverSrc = fs.readFileSync(
  path.resolve("server.ts"),
  "utf8",
);
const coachSrc = fs.readFileSync(
  path.resolve("src/components/CoachChat.tsx"),
  "utf8",
);
assert.match(serverSrc, /rewriteStep3WholeStepJumpCta/);
assert.match(serverSrc, /Real incomplete sibling body label, or null when none remain/);
assert.match(serverSrc, /Never invent "下一段"/);
ok("Step3 jump-CTA fix still present (no fake 下一段)");

console.log("\n[Replay] D — Step2 activePoint + confirm slot-add\n");

assert.equal(isSubstantiveBrainstormContent("可以"), false);
assert.equal(isSubstantiveBrainstormContent("好的"), false);
assert.equal(
  isSubstantiveBrainstormContent(
    "大的品牌为了扩大市场份额，会做很多的商业广告增加曝光",
  ),
  true,
);
ok("substantive content detector separates filler from elaborations");

assert.equal(isExplicitSlotAddConfirm("可以"), false);
assert.equal(isExplicitSlotAddConfirm("好的"), false);
assert.equal(isExplicitSlotAddConfirm("同意"), true);
assert.equal(isExplicitSlotAddConfirm("加上这条"), true);
ok("slot-add confirm requires explicit agree, not bare 可以");

const focus = extractFocusClaimFromCoachText(
  "「消费与品牌全球化」目前还偏薄：请补 1–2 句具体场景。",
);
assert.equal(focus, "消费与品牌全球化");
ok("thin-ask text extracts focus claim");

const boardPts = [
  {
    id: "p3",
    claim: "消费与品牌全球化",
    elaboration: "",
    leanTags: ["general"],
    quality: "thin",
  },
];
const hung = attachTextToPointId(
  boardPts,
  "p3",
  "大的品牌为了扩大市场份额，会做很多的商业广告增加曝光",
);
assert.match(String(hung[0].elaboration || ""), /商业广告/);
assert.equal(hung[0].quality, "ready");
ok("activePoint attach hangs elaboration and marks ready");

const normalized = normalizeStep2PlannerPayload({
  session: {
    step1: {
      coachEvaluation: {
        suggestedDimensions: [
          "消费与品牌全球化（可展开）（已探测）",
          "技术与网络（可展开）（已探测）",
        ],
      },
    },
    step2: {
      coachEvaluation: {
        plannerPayload: {
          version: 1,
          status: "draft",
          updatedAt: "",
          questionType: "Two-part",
          requiresStance: true,
          slotsLocked: true,
          fixedClaims: ["消费与品牌全球化", "技术与网络"],
          activePointId: "p1",
          pendingSlotAdd: { claim: "文化多样性与国家认同削弱" },
          points: [
            {
              id: "p1",
              claim: "消费与品牌全球化",
              elaboration: "",
              leanTags: ["cause"],
              quality: "thin",
            },
            {
              id: "p2",
              claim: "技术与网络",
              elaboration: "互联网传播流行文化",
              leanTags: ["cause"],
              quality: "ready",
            },
          ],
          redirects: {},
          dimensionDispositions: [],
          stance: { text: "", polarity: "unknown", strength: "unknown" },
          coverage: {
            passed: false,
            requiredBuckets: [],
            filledBuckets: [],
            missingBuckets: [],
            softMissingBuckets: [],
          },
          exitGate: {
            canComplete: false,
            canForceExit: false,
            forceExitUsed: false,
          },
        },
      },
    },
  },
  step2Data: {
    userPoints: "A面：消费与品牌全球化；技术与网络 ［待新增：claim=文化多样性与国家认同削弱］",
    plannerPayload: null,
  },
  questionType: "Two-part essay",
  requiresStance: true,
  userMessage: "同意",
  coachText: "「消费与品牌全球化」目前还偏薄：请补一句。",
});
assert.ok(
  (normalized.extraClaims || []).some((c) => /文化多样性|国家认同/.test(c)),
);
assert.ok(
  normalized.points.some(
    (p) => !p.supersededBy && /文化多样性|国家认同/.test(p.claim),
  ),
);
assert.equal(normalized.pendingSlotAdd, null);
ok("explicit 同意 confirms pending slot-add and grows locked board");

const deepen = normalizeStep2PlannerPayload({
  session: {
    step1: {
      coachEvaluation: {
        suggestedDimensions: [
          "消费与品牌全球化（可展开）（已探测）",
          "技术与网络（可展开）（已探测）",
        ],
      },
    },
    step2: {
      coachEvaluation: {
        plannerPayload: {
          version: 1,
          status: "draft",
          updatedAt: "",
          questionType: "Two-part",
          requiresStance: true,
          slotsLocked: true,
          fixedClaims: ["消费与品牌全球化", "技术与网络"],
          activePointId: findPointIdByClaim(
            [
              {
                id: "p1",
                claim: "消费与品牌全球化",
                leanTags: [],
                quality: "thin",
              },
            ],
            "消费与品牌全球化",
          ),
          points: [
            {
              id: "p1",
              claim: "消费与品牌全球化",
              elaboration: "",
              leanTags: ["cause"],
              quality: "thin",
            },
            {
              id: "p2",
              claim: "技术与网络",
              elaboration: "互联网传播流行文化",
              leanTags: ["cause"],
              quality: "ready",
            },
          ],
          redirects: {},
          dimensionDispositions: [],
          stance: { text: "", polarity: "unknown", strength: "unknown" },
          coverage: {
            passed: false,
            requiredBuckets: [],
            filledBuckets: [],
            missingBuckets: [],
            softMissingBuckets: [],
          },
          exitGate: {
            canComplete: false,
            canForceExit: false,
            forceExitUsed: false,
          },
        },
      },
    },
  },
  step2Data: { userPoints: "A面：消费与品牌全球化；技术与网络" },
  questionType: "Two-part essay",
  requiresStance: true,
  userMessage:
    "大的品牌为了扩大市场份额，会做很多的商业广告等活动，增加自己的曝光",
  coachText: "「消费与品牌全球化」目前还偏薄：请补 1–2 句。",
});
const pConsume = deepen.points.find(
  (p) => !p.supersededBy && /消费与品牌/.test(p.claim),
);
assert.match(String(pConsume?.elaboration || ""), /商业广告|曝光/);
assert.equal(pConsume?.quality, "ready");
assert.equal(deepen.focusMode, "none");
ok("deepen answer hangs on activePoint even without claim title in message");

assert.equal(isStanceOrConfirmOnlyMessage("弊大于利"), true);
assert.equal(isStanceOrConfirmOnlyMessage("同意"), true);
assert.equal(
  shouldClearStep2DeepenFocus(
    "目前材料池有：① 技术 ② 消费。第二问是积极还是消极发展？",
  ),
  true,
);
ok("stance/summary clears deepen; short stance is not hard-hung");

const noDump = normalizeStep2PlannerPayload({
  session: {
    step1: {
      coachEvaluation: {
        suggestedDimensions: [
          "技术与网络普及（可展开）（已探测）",
          "消费与品牌全球化（可展开）（已探测）",
          "跨境交流便利（可展开）（已探测）",
        ],
      },
    },
    step2: {
      coachEvaluation: {
        plannerPayload: {
          version: 1,
          status: "draft",
          updatedAt: "",
          questionType: "Two-part",
          requiresStance: true,
          slotsLocked: true,
          focusMode: "deepen",
          activePointId: "p1",
          fixedClaims: [
            "技术与网络普及",
            "消费与品牌全球化",
            "跨境交流便利",
          ],
          points: [
            {
              id: "p1",
              claim: "技术与网络普及",
              elaboration: "数字网络加速传播",
              leanTags: ["cause"],
              quality: "ready",
            },
            {
              id: "p2",
              claim: "消费与品牌全球化",
              elaboration: "",
              leanTags: ["cause"],
              quality: "thin",
            },
            {
              id: "p3",
              claim: "跨境交流便利",
              elaboration: "",
              leanTags: ["positive"],
              quality: "thin",
            },
          ],
          redirects: {},
          dimensionDispositions: [],
          stance: { text: "", polarity: "unknown", strength: "unknown" },
          coverage: {
            passed: false,
            requiredBuckets: [],
            filledBuckets: [],
            missingBuckets: [],
            softMissingBuckets: [],
          },
          exitGate: {
            canComplete: false,
            canForceExit: false,
            forceExitUsed: false,
          },
        },
      },
    },
  },
  step2Data: {
    userPoints:
      "A面：技术与网络普及（数字网络加速传播）；消费与品牌全球化；跨境交流便利",
  },
  questionType: "Two-part essay",
  requiresStance: true,
  userMessage:
    "文化多样性减少，旅游变得无聊，个人和国家的文化认同也会削弱",
  coachText:
    "目前材料池有：① 技术与网络普及 ② 消费与品牌全球化 ③ 跨境交流便利。接下来看第二问：积极还是消极？",
});
const tech = noDump.points.find(
  (p) => !p.supersededBy && /技术与网络/.test(p.claim),
);
assert.equal(noDump.focusMode, "none");
assert.doesNotMatch(
  String(tech?.elaboration || ""),
  /文化多样性|旅游|认同/,
);
// Without propose_new_parallel_claim intent: do NOT dump onto slot1 and do NOT invent pending
assert.equal(noDump.pendingSlotAdd, null);
ok("summary/multi-point turn does NOT dump eval content onto point 1");

const proposeNew = normalizeStep2PlannerPayload({
  session: noDump._session || {
    step1: {
      coachEvaluation: {
        suggestedDimensions: [
          "技术与网络普及（可展开）（已探测）",
          "消费与品牌全球化（可展开）（已探测）",
          "跨境交流便利（可展开）（已探测）",
        ],
      },
    },
    step2: {
      coachEvaluation: {
        plannerPayload: {
          version: 1,
          status: "draft",
          updatedAt: "",
          questionType: "Two-part",
          requiresStance: true,
          slotsLocked: true,
          focusMode: "none",
          fixedClaims: [
            "技术与网络普及",
            "消费与品牌全球化",
            "跨境交流便利",
          ],
          points: [
            {
              id: "p1",
              claim: "技术与网络普及",
              elaboration: "数字网络加速传播",
              leanTags: ["cause"],
              quality: "ready",
            },
            {
              id: "p2",
              claim: "消费与品牌全球化",
              elaboration: "",
              leanTags: ["cause"],
              quality: "thin",
            },
            {
              id: "p3",
              claim: "跨境交流便利",
              elaboration: "",
              leanTags: ["positive"],
              quality: "thin",
            },
          ],
          redirects: {},
          dimensionDispositions: [],
          stance: { text: "", polarity: "unknown", strength: "unknown" },
          coverage: {
            passed: false,
            requiredBuckets: [],
            filledBuckets: [],
            missingBuckets: [],
            softMissingBuckets: [],
          },
          exitGate: {
            canComplete: false,
            canForceExit: false,
            forceExitUsed: false,
          },
        },
      },
    },
  },
  step2Data: {
    userPoints:
      "A面：技术与网络普及（数字网络加速传播）；消费与品牌全球化；跨境交流便利",
  },
  questionType: "Two-part essay",
  requiresStance: true,
  userMessage:
    "文化多样性减少，旅游变得无聊，个人和国家的文化认同也会削弱",
  coachText: "还有没有别的平行论点？",
  studentTurnIntent: {
    kind: "propose_new_parallel_claim",
    claimHint: "文化多样性与国家认同削弱",
    confidence: 1,
    source: "heuristic",
  },
});
assert.ok(
  proposeNew.pendingSlotAdd?.claim &&
    /文化|认同|多样性/.test(proposeNew.pendingSlotAdd.claim),
  "propose_new_parallel_claim intent may open pendingSlotAdd",
);
ok("new parallel claim only via propose intent → pendingSlotAdd");

// Semantic: 强势文化 → frozen 文化全球化 (not string-equal)
const semanticCulture = normalizeStep2PlannerPayload({
  session: {
    step1: {
      coachEvaluation: {
        suggestedDimensions: [
          "文化全球化（可展开）（已探测）",
          "互联网普及（可展开）（已探测）",
          "消费主义与商业化（可展开）（已探测）",
        ],
      },
    },
    step2: {
      coachEvaluation: {
        plannerPayload: {
          version: 1,
          status: "draft",
          updatedAt: "",
          questionType: "Two-part",
          requiresStance: true,
          slotsLocked: true,
          focusMode: "deepen",
          activePointId: "p1",
          fixedClaims: ["文化全球化", "互联网普及", "消费主义与商业化"],
          points: [
            {
              id: "p1",
              claim: "文化全球化",
              elaboration: "",
              leanTags: ["cause"],
              quality: "thin",
            },
            {
              id: "p2",
              claim: "互联网普及",
              elaboration: "",
              leanTags: ["cause"],
              quality: "thin",
            },
            {
              id: "p3",
              claim: "消费主义与商业化",
              elaboration: "",
              leanTags: ["cause"],
              quality: "thin",
            },
          ],
          redirects: {},
          dimensionDispositions: [],
          stance: { text: "", polarity: "unknown", strength: "unknown" },
          coverage: {
            passed: false,
            requiredBuckets: [],
            filledBuckets: [],
            missingBuckets: [],
            softMissingBuckets: [],
          },
          exitGate: {
            canComplete: false,
            canForceExit: false,
            forceExitUsed: false,
          },
        },
      },
    },
  },
  step2Data: {
    userPoints: "A面：文化全球化；互联网普及；消费主义与商业化",
  },
  questionType: "Two-part essay",
  requiresStance: true,
  userMessage:
    "强势文化通过影视和品牌不断输入，年轻人更认同外来文化，本土传统被边缘化",
  coachText: "「文化全球化」目前还偏薄：请补 1–2 句具体场景。",
});
const cultureSlot = semanticCulture.points.find(
  (p) => !p.supersededBy && p.claim === "文化全球化",
);
const netSlot = semanticCulture.points.find(
  (p) => !p.supersededBy && p.claim === "互联网普及",
);
assert.match(String(cultureSlot?.elaboration || ""), /强势文化|外来文化|边缘化/);
assert.doesNotMatch(String(netSlot?.elaboration || ""), /强势文化|边缘化/);
ok("semantic mount: 强势文化 hangs on 文化全球化, not dropped / not on internet slot");

// Circled ①② userPoints + coach named-dimension ask must not dump onto slot 1
// or invent pendingSlotAdd for an already-frozen Step1 claim.
const circledMount = normalizeStep2PlannerPayload({
  session: {
    step1: {
      coachEvaluation: {
        suggestedDimensions: [
          "西方强势文化冲击（原因）（可展开）（已探测）",
          "数字化与网络普及（原因）（可展开）（已探测）",
          "国际交流便利性（评价）（可展开）（已探测）",
        ],
      },
    },
    step2: {
      coachEvaluation: {
        plannerPayload: {
          version: 1,
          status: "draft",
          updatedAt: "",
          questionType: "Two-part",
          requiresStance: false,
          slotsLocked: true,
          focusMode: "deepen",
          activePointId: "p1",
          fixedClaims: [
            "西方强势文化冲击（原因）",
            "数字化与网络普及（原因）",
            "国际交流便利性（评价）",
          ],
          points: [
            {
              id: "p1",
              claim: "西方强势文化冲击（原因）",
              elaboration: "青年人偏爱迪士尼",
              leanTags: ["cause"],
              quality: "ready",
              fromDimension: "西方强势文化冲击（原因）",
            },
            {
              id: "p2",
              claim: "数字化与网络普及（原因）",
              elaboration: "",
              leanTags: ["cause"],
              quality: "thin",
              fromDimension: "数字化与网络普及（原因）",
            },
            {
              id: "p3",
              claim: "国际交流便利性（评价）",
              elaboration: "",
              leanTags: ["part_2"],
              quality: "thin",
              fromDimension: "国际交流便利性（评价）",
            },
          ],
          redirects: {},
          dimensionDispositions: [],
          stance: { text: "", polarity: "unknown", strength: "unknown" },
          coverage: {
            passed: false,
            requiredBuckets: [],
            filledBuckets: [],
            missingBuckets: [],
            softMissingBuckets: [],
          },
          exitGate: {
            canComplete: false,
            canForceExit: false,
            forceExitUsed: false,
          },
        },
      },
    },
  },
  step2Data: {
    userPoints:
      "A面（原因）：\n① 西方强势文化冲击：青年人偏爱迪士尼电影与欧美流行音乐，视外来文化为新潮、传统文化为落后过时\n② 数字化与网络普及：网络和数字普及使跨国文化传播极快、触达极广，传统文化因传播力不足易被淹没",
  },
  questionType: "Two-part Question",
  requiresStance: false,
  userMessage:
    "网络和数字的普及，导致文化的传播变快，触达的面积变大，传统文化很容易被新兴的跨国的文化所淹没，传播力不足",
  coachText:
    "那关于另外一个你提到的原因维度——**「数字化与网络普及」**，在互联网或数字媒体时代，有哪些具体的技术特点或日常生活场景，也正在加速传统文化或语言的流失呢？",
});
const westCircled = circledMount.points.find(
  (p) => !p.supersededBy && /西方强势文化/.test(p.claim),
);
const digCircled = circledMount.points.find(
  (p) => !p.supersededBy && /数字化与网络/.test(p.claim),
);
assert.doesNotMatch(
  String(westCircled?.elaboration || ""),
  /网络和数字普及使跨国|传播极快、触达极广/,
);
assert.match(
  String(digCircled?.elaboration || ""),
  /网络和数字|传播极快|触达/,
);
assert.equal(circledMount.pendingSlotAdd, null);
assert.equal(
  extractFocusClaimFromCoachText(
    "那关于另外一个你提到的原因维度——**「数字化与网络普及」**，有哪些具体场景？",
  ),
  "数字化与网络普及",
);
ok("circled ①② lines hang on matching slots; no false slot-add for existing 数字化");

const kickoffMsg =
  "这是第二步的开场，我还没有说任何话，请不要假装在回应我说过的内容。请直接结合我第一步的审题结论（核心争议：分析传统文化与语言流失；建议讨论维度：西方强势文化冲击（原因）），直接进入 Explore-A：点名第一步已确认的维度「西方强势文化冲击」，只问一个具体展开问题。FORBIDDEN：禁止再问清单式问题；禁止再确认题型。";
assert.equal(isStep2SystemOrKickoffMessage(kickoffMsg), true);
assert.equal(isSubstantiveBrainstormContent(kickoffMsg), false);
assert.equal(scrubStep2KickoffPollution(kickoffMsg), "");

const kickoffMount = normalizeStep2PlannerPayload({
  session: {
    step1: {
      coachEvaluation: {
        suggestedDimensions: [
          "西方强势文化冲击（可展开）（已探测）",
          "数字化与网络普及（可展开）（已探测）",
        ],
      },
    },
    step2: {
      coachEvaluation: {
        plannerPayload: {
          version: 1,
          status: "draft",
          updatedAt: "",
          questionType: "Two-part",
          requiresStance: true,
          slotsLocked: true,
          fixedClaims: ["西方强势文化冲击", "数字化与网络普及"],
          points: [
            {
              id: "p1",
              claim: "西方强势文化冲击",
              elaboration: "",
              leanTags: ["cause"],
              quality: "thin",
            },
            {
              id: "p2",
              claim: "数字化与网络普及",
              elaboration: "",
              leanTags: ["cause"],
              quality: "thin",
            },
          ],
          redirects: {},
          dimensionDispositions: [],
          stance: { text: "", polarity: "unknown", strength: "unknown" },
          coverage: {
            passed: false,
            requiredBuckets: [],
            filledBuckets: [],
            missingBuckets: [],
            softMissingBuckets: [],
          },
          exitGate: {
            canComplete: false,
            canForceExit: false,
            forceExitUsed: false,
          },
        },
      },
    },
  },
  step2Data: {
    userPoints: "A面：西方强势文化冲击；数字化与网络普及",
  },
  questionType: "Two-part essay",
  requiresStance: true,
  userMessage: kickoffMsg,
  isHiddenKickoff: true,
  coachText: "",
});
const kickoffCulture = kickoffMount.points.find(
  (p) => !p.supersededBy && /西方强势文化/.test(p.claim),
);
assert.equal(String(kickoffCulture?.elaboration || "").trim(), "");
assert.equal(kickoffMount.pendingSlotAdd, null);
ok("hidden kickoff / system opener never mounts onto the right board");

assert.equal(isExplicitSlotAddReject("不用"), true);
assert.equal(isExplicitSlotAddReject("不加入"), true);
assert.equal(resolveSlotAddDecision({ hasPending: true, userMessage: "不用" }), "reject");
assert.equal(
  resolveSlotAddDecision({
    hasPending: true,
    userMessage: "随便说说",
  }),
  "reject",
);
assert.equal(
  resolveSlotAddDecision({
    hasPending: true,
    decision: { type: "slot_add", action: "accept" },
    userMessage: "采纳",
  }),
  "accept",
);
ok("slot-add: only accept counts; unused/自由文本 while pending = reject");

const rejectPending = normalizeStep2PlannerPayload({
  session: {
    step1: {
      coachEvaluation: {
        suggestedDimensions: [
          "西方强势文化冲击（可展开）（已探测）",
          "数字化与网络普及（可展开）（已探测）",
        ],
      },
    },
    step2: {
      coachEvaluation: {
        plannerPayload: {
          version: 1,
          status: "draft",
          updatedAt: "",
          questionType: "Two-part",
          requiresStance: true,
          slotsLocked: true,
          focusMode: "deepen",
          activePointId: "p1",
          fixedClaims: ["西方强势文化冲击", "数字化与网络普及"],
          pendingSlotAdd: { claim: "追捧潮流文化主流文化的青少年" },
          points: [
            {
              id: "p1",
              claim: "西方强势文化冲击",
              elaboration: "",
              leanTags: ["cause"],
              quality: "thin",
            },
            {
              id: "p2",
              claim: "数字化与网络普及",
              elaboration: "",
              leanTags: ["cause"],
              quality: "thin",
            },
          ],
          redirects: {},
          dimensionDispositions: [],
          stance: { text: "", polarity: "unknown", strength: "unknown" },
          coverage: {
            passed: false,
            requiredBuckets: [],
            filledBuckets: [],
            missingBuckets: [],
            softMissingBuckets: [],
          },
          exitGate: {
            canComplete: false,
            canForceExit: false,
            forceExitUsed: false,
          },
        },
      },
    },
  },
  step2Data: {
    userPoints:
      "A面：西方强势文化冲击；数字化与网络普及 ［待新增：claim=追捧潮流文化主流文化的青少年］",
  },
  questionType: "Two-part essay",
  requiresStance: true,
  userMessage: "不用",
  decision: { type: "slot_add", action: "reject" },
  coachText: "「西方强势文化冲击」目前还偏薄：请补一句。",
});
assert.equal(rejectPending.pendingSlotAdd, null);
assert.ok(
  (rejectPending.declinedSlotClaims || []).some((c) => /青少年|潮流/.test(c)),
);
const cultureAfterReject = rejectPending.points.find(
  (p) => !p.supersededBy && /西方强势文化/.test(p.claim),
);
assert.match(String(cultureAfterReject?.elaboration || ""), /青少年|潮流/);
ok("reject clears pending, records decline, hangs content onto current slot");

assert.equal(
  cleanElaboration("影视节庆［待裁决：详=文化｜略=网络｜默认=KEEP_MINOR］"),
  "影视节庆",
);
assert.doesNotMatch(
  cleanElaboration("场景［；：详写］；节日"),
  /［|待裁决|：详写/,
);
ok("cleanElaboration strips 待裁决 markers instead of mangling to ［；：详写］");

console.log(
  "\n[Replay] H — composite receipt must not steal deepen focus (culture-loss incident)\n",
);

// 08:45 composite coach reply: Part1 = A-side settle receipt (contains 详写『…』),
// Part2 = expand ask for B-side 国际交流. The student's next answer must land
// on 国际交流 (p4), never on 强势文化冲击 (p1).
const compositeAsk = [
  "已记入：「国际交流」。好的，已为你锁定原因部分的详略方案：**详写『强势文化冲击』**，**略写『网络普及』与『全球消费主义』**。这样我们在分析原因时，主次关系会更清晰。",
  "",
  "---",
  "",
  "「国际交流（评价）」在第一步你提到过「- 国际交流（待展开）」。请再展开 1–2 句：具体场景、机制或受影响对象，方便写成可展开的论据。",
].join("\n");

// Bare scheme statement no longer drives focus; the expand-ask template does.
assert.equal(
  extractFocusClaimFromCoachText(
    "建议详略方案：**详写『强势文化冲击』**，略写其余两条。",
  ),
  null,
);
assert.equal(extractFocusClaimFromCoachText(compositeAsk), "国际交流（评价）");
ok("详写『x』 receipt no longer extracts focus; expand-ask template does");

const incidentPrevPoints = [
  { id: "p1", claim: "强势文化冲击（原因）", elaboration: "外来代表新潮", leanTags: ["part_1"], quality: "ready", retentionRole: "detail", seedOnly: false, fromDimension: "强势文化冲击（原因）" },
  { id: "p2", claim: "网络普及（原因）", elaboration: "网络高速传播", leanTags: ["part_1"], quality: "ready", retentionRole: "brief", seedOnly: false, fromDimension: "网络普及（原因）" },
  { id: "p3", claim: "全球消费主义（原因）", elaboration: "圣诞促销", leanTags: ["part_1"], quality: "ready", retentionRole: "brief", seedOnly: false, fromDimension: "全球消费主义（原因）" },
  { id: "p4", claim: "国际交流（评价）", elaboration: "- 国际交流（待展开）", leanTags: ["part_2"], quality: "thin", seedOnly: true, fromDimension: "国际交流（评价）" },
  { id: "p5", claim: "文化多样性（评价）", elaboration: "- 文化多样性（待展开）", leanTags: ["part_2"], quality: "thin", seedOnly: true, fromDimension: "文化多样性（评价）" },
  { id: "p6", claim: "商业发展（评价）", elaboration: "- 商业发展（待展开）", leanTags: ["part_2"], quality: "thin", seedOnly: true, fromDimension: "商业发展（评价）" },
];

const incidentPayload = normalizeStep2PlannerPayload({
  session: {
    step1: {
      coachEvaluation: {
        suggestedDimensions: incidentPrevPoints.map((p) => p.claim),
        correctType: "Two-part Question",
      },
    },
    step2: {
      coachEvaluation: {
        currentStage: "explore_B",
        userPoints: "x",
        plannerPayload: {
          points: incidentPrevPoints,
          fixedClaims: incidentPrevPoints.map((p) => p.claim),
          slotsLocked: true,
          activePointId: "p4",
          focusMode: "deepen",
          stance: { text: "", polarity: "unknown", locked: false },
          coverage: { filledBuckets: [], missingBuckets: [], softMissing: [] },
          exitGate: { ready: false, forceExitUsed: false, blockReason: "" },
          requiresStance: true,
        },
      },
    },
  },
  step2Data: {
    currentStage: "explore_B",
    userPoints:
      "A面：\n- 强势文化冲击（原因）（外来代表新潮）（已选详写）\nB面：\n- 国际交流（评价）（接受相同的全球文化，增加共同语言）（已展开）\n- 文化多样性（评价）（待展开）\n- 商业发展（评价）（待展开）",
    userStance: "",
  },
  questionType: "Two-part Question",
  requiresStance: true,
  forceExitUsed: false,
  userMessage:
    "大家都接受一样的全球文化，共同语言会更多，企业开展跨国的经营活动也更方便",
  coachText: compositeAsk,
  studentTurnIntent: {
    kind: "content_elaboration",
    confidence: 0.95,
    source: "llm",
    claimHint: "国际交流（评价）",
  },
});

const incidentP1 = incidentPayload.points.find((p) => p.id === "p1");
const incidentP4 = incidentPayload.points.find((p) => p.id === "p4");
assert.doesNotMatch(String(incidentP1?.elaboration || ""), /共同语言|跨国的经营/);
assert.match(String(incidentP4?.elaboration || ""), /共同语言|跨国的经营/);
assert.equal(incidentP4?.seedOnly, false);
ok("student expansion lands on 国际交流 (p4), not the Part-1 receipt slot (p1)");

// Board line with a leading bullet + seed placeholder is now recoverable too.
const seedOverridePts = [
  { id: "p4", claim: "国际交流（评价）", elaboration: "- 国际交流（待展开）", leanTags: ["part_2"], quality: "thin", seedOnly: true, fromDimension: "国际交流（评价）" },
];
const seedOverridden = attachTextToPointId(
  seedOverridePts,
  "p4",
  "接受相同的全球文化，增加共同语言",
  "fill",
);
assert.match(String(seedOverridden[0].elaboration || ""), /共同语言/);
assert.doesNotMatch(String(seedOverridden[0].elaboration || ""), /待展开/);
assert.equal(seedOverridden[0].seedOnly, false);
ok("seed placeholder never blocks real content (fill mode overrides)");

assert.match(serverSrc, /ACTIVE POINT FOCUS/);
assert.match(serverSrc, /NEW SLOT ONLY AFTER CONFIRM/);
assert.match(serverSrc, /applyStep2FocusAndSlotAddPostProcess/);
assert.match(serverSrc, /focusMode/);
assert.match(serverSrc, /semantic match/);
assert.match(serverSrc, /isHiddenKickoff/);
assert.match(serverSrc, /采纳/);
assert.match(serverSrc, /resolveSlotAddDecision/);
assert.match(serverSrc, /isRetentionProposalReject/);
assert.match(serverSrc, /PENDING_REJECTED/);
assert.match(coachSrc, /type: 'retention'/);
ok("server wires dual-path focus + slot-add + retention decision");

console.log(`\nAll ${passed} replay checks passed.\n`);
