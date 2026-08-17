/**
 * Step1 dimension probe hygiene (Phase A / v2 / B-lite).
 * Server owns probe targeting + tag stamping; LLM only returns probeVerdict
 * for the server-designated pendingProbeCore.
 */

export const STEP1_PROBE_EXPANDABLE = '可展开';
export const STEP1_PROBE_THIN = '空标签';
export const STEP1_PROBE_QUALITY_PENDING = '质量待确认';
export const STEP1_PROBE_PROBED = '已探测';
export const STEP1_PROBE_EXIT_OFFERED = '已询退出';

export type Step1ProbeVerdict = 'expandable' | 'thin' | '';

const STATUS_TAG_RE =
  /[（(]\s*(可展开|空标签|质量待确认|已探测|已询退出|待探测)\s*[）)]/g;

const SIDE_TAG_RE = /[（(]\s*侧[：:]\s*([ABG])\s*[）)]/;

export function stripStep1StatusTags(dim: string): string {
  return String(dim || '')
    .replace(STATUS_TAG_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 侧别标签（PM 每问/每侧 ≥2 用；侧别不算核心文案）。 */
function stripStep1SideTag(dim: string): string {
  return String(dim || '')
    .replace(SIDE_TAG_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 侧别前缀习语（与 server.ts 的 STEP1_DIM_SIDE_PREFIX_RES 保持一致）：
 *  模型常把侧别写进标签文本，如 "角度A（…）"、"A面…"、"第1问…"。只在词首匹配。 */
const SIDE_PREFIX_RES: [RegExp, 'A' | 'B'][] = [
  [/^(?:角度|观点|方面|立场|侧面|侧)\s*[:：]?\s*A(?=[（(：:、\s]|$)/i, 'A'],
  [/^(?:角度|观点|方面|立场|侧面|侧)\s*[:：]?\s*B(?=[（(：:、\s]|$)/i, 'B'],
  [/^A\s*(?:面|侧|方)(?=[（(：:、\s]|$)/i, 'A'],
  [/^B\s*(?:面|侧|方)(?=[（(：:、\s]|$)/i, 'B'],
  [/^第\s*(?:1|一)\s*问/, 'A'],
  [/^第\s*(?:2|二|两)\s*问/, 'B'],
];

function step1DimensionSide(dim: string): 'A' | 'B' | 'G' | null {
  const m = SIDE_TAG_RE.exec(String(dim || ''));
  if (m) return m[1] as 'A' | 'B' | 'G';
  const t = String(dim || '').trim();
  for (const [re, side] of SIDE_PREFIX_RES) {
    if (re.test(t)) return side;
  }
  return null;
}

/** core = 状态戳与侧别标签都剥掉后的核心文案（用于跨轮匹配）。 */
function stripStep1AllTags(dim: string): string {
  return stripStep1SideTag(stripStep1StatusTags(dim));
}

export function hasStep1StatusTag(dim: string, tag: string): boolean {
  return new RegExp(`[（(]\\s*${tag}\\s*[）)]`).test(String(dim || ''));
}

/** No probe verdict yet — missing 已探测 and missing expandable/thin/pending. */
export function isStep1DimensionUnprobed(dim: string): boolean {
  const t = String(dim || '').trim();
  if (!t) return false;
  if (hasStep1StatusTag(t, STEP1_PROBE_PROBED)) return false;
  if (hasStep1StatusTag(t, STEP1_PROBE_EXPANDABLE)) return false;
  if (hasStep1StatusTag(t, STEP1_PROBE_THIN)) return false;
  if (hasStep1StatusTag(t, STEP1_PROBE_QUALITY_PENDING)) return false;
  return true;
}

export function stampStep1StatusTag(dim: string, tag: string): string {
  const t = String(dim || '').trim();
  if (!t) return t;
  if (hasStep1StatusTag(t, tag)) return t;
  return `${t}（${tag}）`;
}

const PROBE_STATUS_TAGS = [
  STEP1_PROBE_PROBED,
  STEP1_PROBE_EXPANDABLE,
  STEP1_PROBE_THIN,
  STEP1_PROBE_QUALITY_PENDING,
] as const;

function collectCores(dims: string[] | null | undefined): Set<string> {
  const seen = new Set<string>();
  for (const d of dims || []) {
    const core = stripStep1AllTags(String(d || '')).toLowerCase();
    if (core) seen.add(core);
  }
  return seen;
}

function extractProbeStatusTags(dim: string): string[] {
  const tags: string[] = [];
  for (const tag of PROBE_STATUS_TAGS) {
    if (hasStep1StatusTag(dim, tag)) tags.push(tag);
  }
  return tags;
}

/**
 * Confirmed probe stamps are server-owned. Model rewrites of suggestedDimensions
 * must not drop or rewrite them unless the student explicitly renegotiates
 * (handled elsewhere). Prior stamps win; missing probed rows are re-appended.
 */
export function preserveStep1ProbeTags(
  newDims: string[],
  priorDims: string[] | null | undefined,
): {
  dims: string[];
  restoredCores: string[];
  reappendedCores: string[];
} {
  const priorList = (priorDims || []).map((d) => String(d || '').trim()).filter(Boolean);
  const priorByCore = new Map<string, { raw: string; tags: string[] }>();
  for (const raw of priorList) {
    const core = stripStep1AllTags(raw).toLowerCase();
    if (!core) continue;
    const tags = extractProbeStatusTags(raw);
    if (tags.length === 0) continue;
    if (!priorByCore.has(core)) {
      priorByCore.set(core, { raw, tags });
    }
  }

  const restoredCores: string[] = [];
  const seenCores = new Set<string>();
  const next = (newDims || []).map((d) => {
    const raw = String(d || '').trim();
    if (!raw) return raw;
    const core = stripStep1AllTags(raw).toLowerCase();
    if (!core) return raw;
    seenCores.add(core);
    const prior = priorByCore.get(core);
    if (!prior) return raw;
    let stamped = stripStep1StatusTags(raw) || raw;
    // T1：侧别标签与状态戳同级——prior 有侧别而本轮丢失时恢复；LLM 显式换侧则尊重新值。
    const newSide = step1DimensionSide(stamped);
    const priorSide = step1DimensionSide(prior.raw);
    if (!newSide && priorSide) {
      stamped = `${stripStep1SideTag(stamped)}（侧：${priorSide}）`;
    }
    for (const tag of prior.tags) {
      stamped = stampStep1StatusTag(stamped, tag);
    }
    if (stamped !== raw) restoredCores.push(core);
    return stamped;
  });

  const reappendedCores: string[] = [];
  for (const [core, prior] of priorByCore) {
    if (seenCores.has(core)) continue;
    next.push(prior.raw);
    reappendedCores.push(core);
  }

  return { dims: next, restoredCores, reappendedCores };
}

/**
 * Newly introduced labels this turn must not carry self-reported
 * （已探测）/（可展开）/… — strip status tags, keep task suffixes like （原因）.
 */
export function stripIllegalSameTurnProbeTags(
  dims: string[],
  priorDims: string[] | null | undefined,
): { dims: string[]; strippedCores: string[] } {
  // prior 中带合法状态戳的 core：戳由服务端掌管，模型复写时由 preserveStep1ProbeTags
  // 负责恢复，这里不动。prior 中无戳（或不存在）的 core：模型自带的任何状态戳都是
  // 自报 → 剥掉。注意不能只看"core 是否老"：上一轮剥成裸标签入会话后，模型下一轮
  // 又给它贴上自报戳，若按老 core 放行，脏戳就被当作服务端戳永久锁定（实机观测）。
  const legitCores = new Set<string>();
  for (const d of priorDims || []) {
    const raw = String(d || '').trim();
    if (!raw || isStep1DimensionUnprobed(raw)) continue;
    const core = stripStep1AllTags(raw).toLowerCase();
    if (core) legitCores.add(core);
  }
  const strippedCores: string[] = [];
  const next = (dims || []).map((d) => {
    const raw = String(d || '').trim();
    if (!raw) return raw;
    const core = stripStep1AllTags(raw).toLowerCase();
    if (!core || legitCores.has(core)) return raw;
    if (!isStep1DimensionUnprobed(raw)) {
      strippedCores.push(core);
      return stripStep1StatusTags(raw) || raw;
    }
    return raw;
  });
  return { dims: next, strippedCores };
}

export function normalizeProbeVerdict(raw: unknown): Step1ProbeVerdict {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (!s) return '';
  if (
    s === 'expandable' ||
    s === '可展开' ||
    s === 'ready' ||
    s === 'yes' ||
    s === 'true'
  ) {
    return 'expandable';
  }
  if (
    s === 'thin' ||
    s === '空标签' ||
    s === 'empty' ||
    s === 'no' ||
    s === 'false' ||
    s === '质量待确认'
  ) {
    return 'thin';
  }
  return '';
}

/**
 * 服务端探针裁决兜底（实机死锁修复，2026-08-17）：
 * B-lite 依赖模型返回 probeVerdict 来盖章（可展开/空标签），但实测 DeepSeek
 * 经常整轮不返回该字段。若缺省一律判 thin，学生给出的具体场景会被误标（空标签），
 * 进而 effectiveDims=0 → guard 死锁在"当前 0 个有效角度"（真实用户第一轮即卡住）。
 *
 * 因此模型未裁决时由服务端根据学生本轮回答推断：
 *   - 明确拒绝 / 含糊（"没有 / 不清楚 / 想不出来 / 还没想好"等短句）→ thin；
 *   - 任何包含具体内容的回答（哪怕一句场景信号）→ expandable。
 * 设计上偏向 expandable：Step1 探针只是轻量过滤，"任何具体线索"即算可展开，
 * 深度由 Step2/3 把关；误判 expandable 的代价远小于误判 thin 导致的死锁。
 */
const STEP1_THIN_ANSWER_RE =
  /^(?:(?:暂时|还|现在|目前|其实|这个|这方面|这块|我|嗯|呃|em|emm)[，,、\s]*)*(?:没有(?:具体(?:的)?(?:例子|场景|想法|内容|苗头|方向|思路|素材|概念|信号))?|没|不清楚|不知道|想不?出[来]?|想不到|想不好|没想好|不确定|说不好|难说|没什么|不太清楚|没概念|没头绪|没想法|没感觉|不记得|忘了|无法确定|确定不了|没有特别)[。.!！~～…\s]*$/;

export function inferProbeVerdictFromStudentMessage(
  message: string,
): Step1ProbeVerdict {
  const t = String(message || '').trim();
  if (!t) return 'thin';
  if (STEP1_THIN_ANSWER_RE.test(t)) return 'thin';
  return 'expandable';
}

/**
 * After a server-forced probe ask: stamp target from probeVerdict.
 * Strips any model self-tags on the target first; missing verdict → 空标签.
 */
export function resolvePendingProbeAnswer(
  dims: string[],
  pendingCore: string,
  verdict?: unknown,
): string[] {
  const core = stripStep1AllTags(pendingCore).toLowerCase();
  if (!core) return dims;
  const v = normalizeProbeVerdict(verdict);
  return (dims || []).map((d) => {
    const raw = String(d || '').trim();
    if (stripStep1AllTags(raw).toLowerCase() !== core) return raw;
    // Drop self-reported status tags; keep task suffixes (原因/评价/…).
    let next = stripStep1StatusTags(raw) || raw;
    next = stampStep1StatusTag(next, STEP1_PROBE_PROBED);
    if (v === 'expandable') {
      next = stampStep1StatusTag(next, STEP1_PROBE_EXPANDABLE);
    } else {
      next = stampStep1StatusTag(next, STEP1_PROBE_THIN);
    }
    return next;
  });
}

/** Student-exhaust escape only: remaining bare labels → 质量待确认 + 已探测. */
export function stampUnprobedQualityPending(dims: string[]): string[] {
  return (dims || []).map((d) => {
    const raw = String(d || '').trim();
    if (!isStep1DimensionUnprobed(raw)) return raw;
    let next = stampStep1StatusTag(raw, STEP1_PROBE_QUALITY_PENDING);
    next = stampStep1StatusTag(next, STEP1_PROBE_PROBED);
    return next;
  });
}

export function earliestUnprobedDimension(
  dims: string[] | null | undefined,
): string | null {
  for (const d of dims || []) {
    const raw = String(d || '').trim();
    if (isStep1DimensionUnprobed(raw)) return raw;
  }
  return null;
}

export function buildBareDimensionProbeAsk(dim: string): string {
  const label = stripStep1AllTags(dim) || String(dim || '').trim() || '这个角度';
  // 真人口吻（真实用户“非常人机”反馈后自然化）：不用“苗头/信号”这类检查清单式措辞。
  return (
    `「${label}」这个角度，你脑海里有没有浮现出具体的画面或例子？` +
    `哪怕一两句话、说个大概就行；暂时想不出来也没关系，我们就换个角度。`
  );
}

/** True when Part2 already looks like a light probe for this dimension. */
export function textLooksLikeProbeAskForDim(
  text: string,
  dim: string,
): boolean {
  const part2 = String(text || '').includes('---')
    ? String(text || '')
        .split('---')
        .slice(1)
        .join('---')
    : String(text || '');
  const label = stripStep1AllTags(dim);
  if (!label || label.length < 2) return false;
  const core = label.replace(/（[^）]*）|\([^)]*\)/g, '').trim();
  const hitLabel =
    part2.includes(label) || (core.length >= 2 && part2.includes(core));
  // 识别范围放宽到自然问法（“画面/情形/例子/想到/有没有…”），避免模型用真人口吻
  // 提问时被服务端模板覆写（真实用户“非常人机”反馈后自然化）。
  const hitProbe =
    /苗头|具体场景|具体.{0,8}(画面|情形|例子)|想到过|想到\S{0,4}具体|有没有.{0,6}(画面|例子|场景|情形)|可展开|例子/.test(
      part2,
    );
  return hitLabel && hitProbe;
}

export function countUnprobedStep1Dimensions(
  dims: string[] | null | undefined,
): number {
  let n = 0;
  for (const d of dims || []) {
    if (isStep1DimensionUnprobed(String(d || ''))) n += 1;
  }
  return n;
}

/** Cap full + every label already probed → allow exit even if effective < 3. */
export function step1CapProbeComplete(
  dims: string[] | null | undefined,
  maxLabels: number,
): boolean {
  if (!Array.isArray(dims) || dims.length === 0) return false;
  const cores = collectCores(dims);
  if (cores.size < maxLabels) return false;
  return countUnprobedStep1Dimensions(dims) === 0;
}
