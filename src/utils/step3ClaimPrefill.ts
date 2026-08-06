/** Claim-slot labels that inherit from pointBlock.subClaim. */
const CLAIM_SLOT_LABEL_RE = /分论点|核心观点|核心主张|主张|论点|观点|claim/i;

/**
 * Sync pointBlock.subClaim → first empty claim-type step (confirmed + inherited).
 * Safe to call repeatedly; no-ops when value already present or subClaim too short.
 *
 * Fixes the board gap where coach/planner keeps the claim in `subClaim` (shown
 * above the chain) but leaves `steps[0].value` empty → UI 「待填写」 while chat
 * already asks the next beat.
 */
export function prefillClaimSlotsFromSubClaims(plan: any): number {
  if (!plan || !Array.isArray(plan?.pointBlocks)) return 0;
  let filled = 0;
  for (const block of plan.pointBlocks) {
    const subClaim = String(block?.subClaim || "").trim();
    if (subClaim.length < 8) continue;
    if (!Array.isArray(block?.steps) || block.steps.length === 0) continue;
    const first = block.steps[0];
    if (!first) continue;
    const label = String(first.label || "").trim();
    if (!CLAIM_SLOT_LABEL_RE.test(label)) continue;
    if (String(first.value || "").trim()) continue;
    first.value = subClaim;
    first.status = "confirmed";
    first.inheritedFromStep2 = true;
    // Avoid placeholder-echo wipe: if placeholder ≈ subClaim, use a generic hint.
    const ph = String(first.placeholder || "").trim();
    if (
      ph &&
      (ph === subClaim || subClaim.includes(ph) || ph.includes(subClaim))
    ) {
      first.placeholder = "用一句话写出本段核心主张（已从第二步预填）";
    }
    filled += 1;
  }
  return filled;
}
