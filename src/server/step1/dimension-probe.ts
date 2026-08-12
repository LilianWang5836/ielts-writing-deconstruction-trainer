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
  /[（(]\s*(可展开|空标签|质量待确认|已探测|已询退出)\s*[）)]/g;

export function stripStep1StatusTags(dim: string): string {
  return String(dim || '')
    .replace(STATUS_TAG_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
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
    const core = stripStep1StatusTags(String(d || '')).toLowerCase();
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
    const core = stripStep1StatusTags(raw).toLowerCase();
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
    const core = stripStep1StatusTags(raw).toLowerCase();
    if (!core) return raw;
    seenCores.add(core);
    const prior = priorByCore.get(core);
    if (!prior) return raw;
    let stamped = stripStep1StatusTags(raw) || raw;
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
  const oldCores = collectCores(priorDims);
  const strippedCores: string[] = [];
  const next = (dims || []).map((d) => {
    const raw = String(d || '').trim();
    if (!raw) return raw;
    const core = stripStep1StatusTags(raw).toLowerCase();
    if (!core || oldCores.has(core)) return raw;
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
 * After a server-forced probe ask: stamp target from probeVerdict.
 * Strips any model self-tags on the target first; missing verdict → 空标签.
 */
export function resolvePendingProbeAnswer(
  dims: string[],
  pendingCore: string,
  verdict?: unknown,
): string[] {
  const core = stripStep1StatusTags(pendingCore).toLowerCase();
  if (!core) return dims;
  const v = normalizeProbeVerdict(verdict);
  return (dims || []).map((d) => {
    const raw = String(d || '').trim();
    if (stripStep1StatusTags(raw).toLowerCase() !== core) return raw;
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
  const label = stripStep1StatusTags(dim) || String(dim || '').trim() || '这个角度';
  return (
    `『${label}』这个角度你脑子里已经有具体场景或例子的苗头了吗？` +
    `有的话简单说一句信号即可；还没有的话我们再换一个角度。`
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
  const label = stripStep1StatusTags(dim);
  if (!label || label.length < 2) return false;
  const core = label.replace(/（[^）]*）|\([^)]*\)/g, '').trim();
  const hitLabel =
    part2.includes(label) || (core.length >= 2 && part2.includes(core));
  const hitProbe = /苗头|具体场景|例子|可展开|有没有.*场景/.test(part2);
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
