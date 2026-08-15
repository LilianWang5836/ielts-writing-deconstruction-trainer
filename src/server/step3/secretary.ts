/**
 * Step3 会议秘书（Meeting Secretary）— restructure 新架构
 *
 * 职责：学生说什么，忠实记录为纪要（minutes），用确定性逻辑落槽到冻结骨架。
 * 后端核心：4 个确定性函数 + 1 个 dup 预检。
 *
 * - appendMinute：记纪要（真相源）
 * - landMinuteToSlot：落槽（找当前槽 → dup 预检 → landed）
 * - commitPendingMinute：确认写板（landed → confirmed，推进 activeSlotIndex）
 * - renderBoard：渲染投影（只读，skeleton + minutes → 看板）
 */

import type {
  Step3Minute,
  Step3Skeleton,
  Step3Subpoint,
} from '../../types';
import {
  skeletonFlatSlots,
  skeletonSlotCount,
} from '../../utils/step3Skeleton';

// ------------------------------------------------------------
// 辅助：内容有效性 / 重复预检（确定性护栏）
// ------------------------------------------------------------

function normalizeForCompare(text: string): string {
  return String(text || '')
    .replace(/[\s，,。.！!？?；;：:""''「」【】\-—]/g, '')
    .toLowerCase();
}

function isSubstantive(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.length < 4) return false;
  // 排除纯确认/指令/占位
  if (/^(对|好|是|嗯|可以|同意|采纳|确认|下一步|就这样|先这样)[。.!！?？]?$/.test(t)) return false;
  return true;
}

function isAffirmative(text: string): boolean {
  const t = String(text || '').trim();
  return /^(对|好|是|嗯|可以|同意|采纳|确认|就按|行)[。.!！?？]?$/.test(t) || /确认写入|点击确认|确认提交/.test(t);
}

function isReject(text: string): boolean {
  const t = String(text || '').trim();
  return /^(不对|不好|不是|重说|重写|换一个|去掉|不要|改一下|重新说)[。.!！?？]?$/.test(t) || /拒绝|否决|撤销/.test(t);
}

/** 字符级相似度（0-1），用于近似重复检测。 */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  const shorter = a === longer ? b : a;
  if (longer.length === 0) return 0;
  // 最长公共子串长度 / 较长者长度（对中文口语近似重复足够敏感）
  const maxLen = longestCommonSubstr(a, b).length;
  return maxLen / longer.length;
}

function longestCommonSubstr(a: string, b: string): string {
  const m = a.length;
  const n = b.length;
  let best = '';
  const dp: number[] = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev + 1;
        if (dp[j] > best.length) {
          best = a.slice(i - dp[j], i);
        }
      } else {
        dp[j] = 0;
      }
      prev = tmp;
    }
  }
  return best;
}

/** dup 预检：与已 confirmed 的兄弟槽内容做语义（归一化 + 相似度）比较。
 *  P0 保守策略：只拦「子串包含」或「高度近似（LCS 相似度≥0.6）」这类明确复读。
 *  拿不准的放行，让教练在对话中引导（避免误杀合理回答）。 */
function checkDuplicate(minutes: Step3Minute[], text: string, excludeMinuteId?: string): string | null {
  const t = normalizeForCompare(text);
  if (!t || t.length < 6) return null;
  for (const m of minutes) {
    if (excludeMinuteId && m.id === excludeMinuteId) continue;
    if (m.status !== 'confirmed') continue;
    const mt = normalizeForCompare(m.text);
    if (!mt || mt.length < 6) continue;
    // 子串包含（真复读）或 LCS 相似度≥0.6（高度近似）判为重复
    if (t.includes(mt) || mt.includes(t) || similarity(t, mt) >= 0.6) {
      return `duplicate_sibling (与已确认内容「${m.text.slice(0, 20)}」重复)`;
    }
  }
  return null;
}

// ------------------------------------------------------------
// 1. 记纪要
// ------------------------------------------------------------

let seq = 0;
function nextMinuteId(ts: number): string {
  seq += 1;
  return `m-${ts}-${seq}`;
}

export function appendMinute(
  subpoint: Step3Subpoint,
  role: 'student' | 'coach',
  text: string,
  opts?: { slotKey?: string; status?: Step3Minute['status']; fromCoachAsk?: string; rejectReason?: string },
): Step3Minute {
  const ts = Date.now();
  const minute: Step3Minute = {
    id: nextMinuteId(ts),
    role,
    text: String(text || ''),
    ts,
    slotKey: opts?.slotKey,
    status: opts?.status || 'recorded',
    ...(opts?.fromCoachAsk ? { fromCoachAsk: opts.fromCoachAsk } : {}),
    ...(opts?.rejectReason ? { rejectReason: opts.rejectReason } : {}),
  };
  subpoint.minutes = Array.isArray(subpoint.minutes) ? subpoint.minutes : [];
  subpoint.minutes.push(minute);
  return minute;
}

// ------------------------------------------------------------
// 2. 落槽（找当前槽 → dup 预检 → landed）
// ------------------------------------------------------------

export interface LandResult {
  ok: boolean;
  minuteId?: string;
  slotKey?: string;
  blockIndex?: number;
  reason?: string;
}

export function landMinuteToSlot(
  subpoint: Step3Subpoint,
  minute: Step3Minute,
): LandResult {
  if (minute.status === 'landed' || minute.status === 'confirmed') {
    return { ok: true, minuteId: minute.id, slotKey: minute.slotKey };
  }
  const skeleton = subpoint.skeleton;
  if (!skeleton || skeleton.blocks.length === 0) {
    return { ok: false, reason: 'no_skeleton' };
  }
  const flat = skeletonFlatSlots(skeleton);
  if (flat.length === 0) return { ok: false, reason: 'no_slots' };

  // 找当前 activeSlot：跳过已 confirmed 的槽
  const confirmedKeys = new Set(
    (subpoint.minutes || [])
      .filter((m) => m.status === 'confirmed' && m.slotKey)
      .map((m) => m.slotKey as string),
  );
  let start = Math.min(Math.max(subpoint.activeSlotIndex || 0, 0), flat.length - 1);
  let targetIndex = -1;
  for (let i = start; i < flat.length; i++) {
    if (!confirmedKeys.has(flat[i].slot.key)) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) {
    return { ok: false, reason: 'all_slots_filled' };
  }

  const target = flat[targetIndex];
  const dup = checkDuplicate(subpoint.minutes || [], minute.text, minute.id);
  if (dup) {
    minute.status = 'rejected';
    minute.rejectReason = dup;
    return { ok: false, minuteId: minute.id, reason: dup };
  }

  minute.status = 'landed';
  minute.slotKey = target.slot.key;
  subpoint.activeSlotIndex = targetIndex;
  return {
    ok: true,
    minuteId: minute.id,
    slotKey: target.slot.key,
    blockIndex: target.blockIndex,
  };
}

// ------------------------------------------------------------
// 3. 确认写板（landed → confirmed，推进 activeSlotIndex）
// ------------------------------------------------------------

export function commitPendingMinute(subpoint: Step3Subpoint, minute: Step3Minute): void {
  if (minute.status !== 'landed') return;
  const dup = checkDuplicate(
    (subpoint.minutes || []).filter((m) => m.id !== minute.id),
    minute.text,
    minute.id,
  );
  if (dup) {
    minute.status = 'rejected';
    minute.rejectReason = dup;
    return;
  }
  minute.status = 'confirmed';
  // 推进到下一个未填槽
  if (subpoint.skeleton) {
    const flat = skeletonFlatSlots(subpoint.skeleton);
    const next = flat.findIndex(
      (f, i) =>
        i > (subpoint.activeSlotIndex || 0) &&
        !(subpoint.minutes || []).some(
          (m) => m.status === 'confirmed' && m.slotKey === f.slot.key,
        ),
    );
    if (next !== -1) subpoint.activeSlotIndex = next;
  }
}

// ------------------------------------------------------------
// 4. 渲染投影（只读，skeleton + minutes → 看板）
// ------------------------------------------------------------

export interface BoardSlotView {
  key: string;
  label: string;
  placeholder: string;
  semantic: string;
  content: string;      // confirmed 内容（无则为空）
  pending: string;      // landed 待确认内容
  status: 'empty' | 'draft' | 'confirmed';
}

export interface BoardBlockView {
  id: string;
  label: string;
  subClaim: string;
  role: string;
  slots: BoardSlotView[];
}

export interface BoardView {
  blocks: BoardBlockView[];
  totalSlots: number;
  filledSlots: number;
  activeSlotKey: string | null;
  isComplete: boolean;
}

export function renderBoard(subpoint: Step3Subpoint): BoardView {
  const skeleton = subpoint.skeleton;
  const minutes = subpoint.minutes || [];
  if (!skeleton || skeleton.blocks.length === 0) {
    return { blocks: [], totalSlots: 0, filledSlots: 0, activeSlotKey: null, isComplete: false };
  }

  const slotView = (slotKey: string): BoardSlotView => {
    const landed = minutes.find(
      (m) => m.status === 'landed' && m.slotKey === slotKey,
    );
    const confirmed = minutes.find(
      (m) => m.status === 'confirmed' && m.slotKey === slotKey,
    );
    return {
      key: slotKey,
      label: '',
      placeholder: '',
      semantic: '',
      content: confirmed ? confirmed.text : '',
      pending: landed ? landed.text : '',
      status: confirmed ? 'confirmed' : landed ? 'draft' : 'empty',
    };
  };

  const blocks = skeleton.blocks.map((b) => {
    const slotViews = b.slots.map((s) => {
      const base = slotView(s.key);
      return { ...base, label: s.label, placeholder: s.placeholder, semantic: s.semantic };
    });
    return {
      id: b.id,
      label: b.label,
      subClaim: b.subClaim,
      role: b.role,
      slots: slotViews,
    };
  });

  const flat = skeletonFlatSlots(skeleton);
  const totalSlots = flat.length;
  const confirmedCount = minutes.filter((m) => m.status === 'confirmed' && m.slotKey).length;
  const confirmedKeys = new Set(
    minutes.filter((m) => m.status === 'confirmed' && m.slotKey).map((m) => m.slotKey as string),
  );
  const activeEntry = flat.find((f) => !confirmedKeys.has(f.slot.key));
  return {
    blocks,
    totalSlots,
    filledSlots: confirmedCount,
    activeSlotKey: activeEntry ? activeEntry.slot.key : null,
    isComplete: confirmedCount >= totalSlots && totalSlots > 0,
  };
}

/** 当前 activeSlot 的 label（教练引导用）。 */
export function activeSlotLabel(subpoint: Step3Subpoint): string {
  const board = renderBoard(subpoint);
  if (board.activeSlotKey) {
    for (const b of board.blocks) {
      const s = b.slots.find((x) => x.key === board.activeSlotKey);
      if (s) return s.label;
    }
  }
  return '';
}

/** 骨架是否已填满（全部槽 confirmed）。 */
export function isSkeletonComplete(subpoint: Step3Subpoint): boolean {
  const board = renderBoard(subpoint);
  return board.isComplete;
}
