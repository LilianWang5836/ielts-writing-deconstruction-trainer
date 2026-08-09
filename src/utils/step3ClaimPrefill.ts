/** Claim-slot labels that inherit from pointBlock.subClaim. */
export const CLAIM_SLOT_LABEL_RE = /分论点|核心观点|核心主张|主张|论点|观点|claim/i;

/**
 * True when text is a full claim sentence suitable for the 论点 slot.
 * Bare dimension heads (环境保护 / 人际关系) are theme labels only — not claims.
 */
export function isClaimSentence(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  const hasCjk = /[\u4e00-\u9fff]/.test(t);
  if (hasCjk) {
    // Pure short noun / topic head (2–10 chars, no clause)
    if (/^[\u4e00-\u9fffA-Za-z0-9·、／/\s]{2,10}$/.test(t) && t.length <= 10) {
      return false;
    }
    if (t.length < 8) return false;
    if (t.length >= 14) return true;
    return /(是|能|可以|会|应该|必须|通过|因为|所以|导致|使得|提升|降低|改善|减少|带来|造成|有助于|无法|不能)/.test(
      t,
    );
  }
  // English: need a short clause, not a single token
  return t.length >= 12 && /\s/.test(t);
}

/** Theme / dimension head only (word or short phrase, not a claim sentence). */
export function isThemeHeadOnly(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  return !isClaimSentence(t);
}

/**
 * If subClaim is only a theme head, demote it to block.label / body.theme
 * and clear subClaim so Step3 asks for a real 论点句 first.
 */
export function demoteThemeHeadSubClaims(plan: any, bodyTheme?: { theme?: string }): number {
  if (!plan || !Array.isArray(plan?.pointBlocks)) return 0;
  let n = 0;
  for (const block of plan.pointBlocks) {
    const sub = String(block?.subClaim || '').trim();
    if (!sub || isClaimSentence(sub)) continue;
    const head = sub;
    const label = String(block.label || '').trim();
    // Prefer a richer theme label (环境保护投入) over bare head when already set
    if (!label) {
      block.label = head;
    } else if (label === head) {
      /* keep */
    } else if (isThemeHeadOnly(label) && !label.includes(head) && head.length >= 2) {
      block.label = head;
    }
    if (bodyTheme && (!bodyTheme.theme || isThemeHeadOnly(String(bodyTheme.theme)))) {
      bodyTheme.theme = head;
    }
    block.subClaim = '';
    n += 1;
  }
  return n;
}

/**
 * Resolve the display 论点句 for a pointBlock:
 * confirmed claim-step value > pending > full-sentence subClaim (display hint only).
 * Theme heads never count.
 */
export function resolveBlockClaimSentence(
  block: any,
  pendingByKey?: Map<string, string>,
): string {
  if (!block) return '';
  const steps = Array.isArray(block.steps) ? block.steps : [];
  for (const step of steps) {
    const label = String(step?.label || '');
    if (!CLAIM_SLOT_LABEL_RE.test(label)) continue;
    const v = String(step?.value || '').trim();
    if (isClaimSentence(v)) return v;
    const key = String(step?.key || '');
    const pend = pendingByKey?.get(key);
    if (pend && isClaimSentence(pend)) return pend;
  }
  const sub = String(block.subClaim || '').trim();
  return isClaimSentence(sub) ? sub : '';
}

/** Theme label for a block (short head), never a full claim sentence. */
export function resolveBlockThemeLabel(block: any, fallback = ''): string {
  const label = String(block?.label || '').trim();
  const sub = String(block?.subClaim || '').trim();
  if (label && isThemeHeadOnly(label)) return label;
  if (sub && isThemeHeadOnly(sub)) return sub;
  if (label && !isClaimSentence(label) && label.length <= 16) return label;
  return String(fallback || '').trim();
}

export type SubClaimPendingDraft = {
  key: string;
  label: string;
  text: string;
  blockIndex: number;
  stepIndex: number;
};

/**
 * Build pending drafts from full-sentence subClaims for empty claim slots.
 * Does NOT write steps[].value — caller must stage pending → student confirm.
 */
export function buildPendingDraftsFromFullSubClaims(
  plan: any,
): SubClaimPendingDraft[] {
  if (!plan || !Array.isArray(plan?.pointBlocks)) return [];
  const out: SubClaimPendingDraft[] = [];
  for (let bi = 0; bi < plan.pointBlocks.length; bi++) {
    const block = plan.pointBlocks[bi];
    const subClaim = String(block?.subClaim || '').trim();
    if (!isClaimSentence(subClaim)) continue;
    if (!Array.isArray(block?.steps) || !block.steps.length) continue;
    const first = block.steps[0];
    if (!first) continue;
    const label = String(first.label || '').trim();
    if (!CLAIM_SLOT_LABEL_RE.test(label)) continue;
    if (String(first.value || '').trim()) continue;
    out.push({
      key: String(first.key || `${bi}:0`),
      label: label || '分论点',
      text: subClaim,
      blockIndex: bi,
      stepIndex: 0,
    });
  }
  return out;
}

/**
 * @deprecated Silent board writes are forbidden (pending → confirm → write).
 * Kept as a no-op so old call sites do not auto-confirm claim slots.
 */
export function prefillClaimSlotsFromSubClaims(_plan: any): number {
  return 0;
}
