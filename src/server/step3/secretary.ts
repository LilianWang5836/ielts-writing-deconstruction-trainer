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
  Step3LandingAuditEntry,
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
    appendAudit(subpoint, minute.id, 'rejected', undefined, dup);
    return { ok: false, minuteId: minute.id, reason: dup };
  }

  minute.status = 'landed';
  minute.slotKey = target.slot.key;
  subpoint.activeSlotIndex = targetIndex;
  appendAudit(subpoint, minute.id, 'landed', target.slot.key);
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
    appendAudit(subpoint, minute.id, 'rejected', minute.slotKey, dup);
    return;
  }
  minute.status = 'confirmed';
  appendAudit(subpoint, minute.id, 'confirmed', minute.slotKey);
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

/** 记录一条落槽审计事件（P1）。确定性：追加到 subpoint.landingLog。 */
function appendAudit(
  subpoint: Step3Subpoint,
  minuteId: string,
  event: Step3LandingAuditEntry['event'],
  slotKey?: string,
  reason?: string,
): void {
  if (!Array.isArray(subpoint.landingLog)) subpoint.landingLog = [];
  subpoint.landingLog.push({
    minuteId,
    event,
    slotKey,
    reason,
    ts: Date.now(),
  });
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

// ------------------------------------------------------------
// 5. 可审计落槽：从 minutes 流水重放（P1 — 可重放 / 诊断）
// ------------------------------------------------------------
//
// 原则：minutes 是唯一真相源，落槽是确定性纯函数。给定相同的 skeleton +
// 相同的学生消息序列（按 ts 顺序），landMinuteToSlot / commitPendingMinute
// 必须复现出与运行时完全一致的落槽结果（slotKey / status / rejectReason）。
// replayLanding 在干净的 subpoint 副本上重放，逐条对比，返回一致性报告。
// 用途：诊断"看板为何如此"、验证未来改动不改变确定性、为审计提供逐槽证据。

export interface LandingReplayRow {
  minuteId: string;
  text: string;
  recorded: {
    slotKey?: string;
    status: Step3Minute['status'];
    rejectReason?: string;
  };
  replayed: {
    slotKey?: string;
    status: Step3Minute['status'];
    rejectReason?: string;
  };
  consistent: boolean;
}

export interface LandingReplayReport {
  rows: LandingReplayRow[];
  allConsistent: boolean;
  board: BoardView;
  /** 审计事件驱动的重放（true）或 minutes 推断驱动（false）。 */
  auditDriven: boolean;
}

/**
 * 从 subpoint 重放落槽决策，验证与运行一致。
 *
 * 优先走 landingLog（P1 审计事件）：按事件顺序精确重放 landed/confirmed/rejected，
 * 不依赖推断，天然一致。旧 session 无 landingLog 时回退到 minutes 推断（近似）。
 */
export function replayLanding(subpoint: Step3Subpoint): LandingReplayReport {
  const skeleton = subpoint.skeleton;
  const minutes = Array.isArray(subpoint.minutes) ? subpoint.minutes : [];
  if (!skeleton || skeleton.blocks.length === 0 || minutes.length === 0) {
    return {
      rows: [],
      allConsistent: true,
      board: renderBoard(subpoint),
      auditDriven: false,
    };
  }

  const log = Array.isArray(subpoint.landingLog) ? subpoint.landingLog : [];
  if (log.length > 0) {
    return replayFromAuditLog(subpoint, log);
  }
  return replayFromMinutes(subpoint);
}

/** 审计日志驱动：按事件顺序精确重放，与运行完全一致。 */
function replayFromAuditLog(
  subpoint: Step3Subpoint,
  log: Step3LandingAuditEntry[],
): LandingReplayReport {
  const minutes = subpoint.minutes || [];
  const sorted = [...log].sort(
    (a, b) => a.ts - b.ts || String(a.minuteId).localeCompare(String(b.minuteId)),
  );

  // 每条 minute 取最终审计事件（last-write-wins：rejected > confirmed > landed 按时间后者胜）。
  const finalByMinute = new Map<string, Step3LandingAuditEntry>();
  for (const entry of sorted) {
    finalByMinute.set(String(entry.minuteId), entry);
  }

  const rows: LandingReplayRow[] = [];
  for (const [minuteId, entry] of finalByMinute) {
    const rec = minutes.find((m) => m.id === minuteId);
    if (!rec) continue;
    const replayed: LandingReplayRow['replayed'] = {
      slotKey: entry.event === 'rejected' ? undefined : entry.slotKey,
      status:
        entry.event === 'confirmed'
          ? 'confirmed'
          : entry.event === 'landed'
            ? 'landed'
            : 'rejected',
      rejectReason: entry.reason,
    };
    const recorded: LandingReplayRow['recorded'] = {
      slotKey: rec.slotKey,
      status: rec.status,
      rejectReason: rec.rejectReason,
    };
    const consistent =
      replayed.status === recorded.status &&
      String(replayed.slotKey || '') === String(recorded.slotKey || '') &&
      String(replayed.rejectReason || '') === String(recorded.rejectReason || '');
    rows.push({
      minuteId: rec.id,
      text: String(rec.text || '').trim(),
      recorded,
      replayed,
      consistent,
    });
  }

  // 重放看板：以当前 skeleton + minutes 为准（已是运行结果）。
  return {
    rows,
    allConsistent: rows.every((r) => r.consistent),
    board: renderBoard(subpoint),
    auditDriven: true,
  };
}

/** minutes 推断驱动（兼容无 landingLog 的旧 session）：近似重放，尽力还原顺序。 */
function replayFromMinutes(subpoint: Step3Subpoint): LandingReplayReport {
  const skeleton = subpoint.skeleton!;
  const minutes = subpoint.minutes || [];

  // 干净的 subpoint 副本（复刻运行时状态机）。
  const replay: Step3Subpoint = {
    ...subpoint,
    minutes: [],
    activeSlotIndex: 0,
  };

  // 只重放学生实质发言（确认/拒绝本身不产生 minute，反映在落槽结果里）。
  // 按 ts 排序；同一秒内按 minuteId 序号保持相对顺序（id 形如 m-<ts>-<seq>）。
  const studentMinutes = minutes
    .filter((m) => m.role === 'student')
    .sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      const seqA = Number(String(a.id).split('-').pop() || 0);
      const seqB = Number(String(b.id).split('-').pop() || 0);
      return seqA - seqB;
    });

  const rows: LandingReplayRow[] = [];
  for (const rec of studentMinutes) {
    const text = String(rec.text || '').trim();
    const minute = appendMinute(replay, 'student', text);
    const land = landMinuteToSlot(replay, minute);
    // 若原记录最终是 confirmed，则重放确认写板（推进 activeSlotIndex）。
    if (rec.status === 'confirmed' && land.ok) {
      commitPendingMinute(replay, minute);
    }
    const replayed = {
      slotKey: minute.slotKey,
      status: minute.status,
      rejectReason: minute.rejectReason,
    };
    const recorded = {
      slotKey: rec.slotKey,
      status: rec.status,
      rejectReason: rec.rejectReason,
    };
    const consistent =
      replayed.status === recorded.status &&
      String(replayed.slotKey || '') === String(recorded.slotKey || '') &&
      String(replayed.rejectReason || '') === String(recorded.rejectReason || '');
    rows.push({
      minuteId: rec.id,
      text,
      recorded,
      replayed,
      consistent,
    });
  }

  return {
    rows,
    allConsistent: rows.every((r) => r.consistent),
    board: renderBoard(replay),
    auditDriven: false,
  };
}

// ------------------------------------------------------------
// 6. 教练卡死检测（P3 — 只拦确定性无进展）
// ------------------------------------------------------------
//
// 确定性信号：一个 body 里，学生在【同一个槽】连续多次给出实质回答，
// 但始终没有任何一条被确认写板（confirmed 数不增长）→ 对话在该槽原地打转。
// 这通常意味着教练反复问同一槽（或学生始终答不对 / 教练不引导确认）。
//
// 护栏只报警 + 给前端信号，不做"替教练改结构"（护栏不充当模板校验器）。

export interface StallReport {
  stalled: boolean;
  slotKey: string | null;
  slotLabel: string | null;
  /** 该槽连续未确认的实质回答条数。 */
  attempts: number;
  /** 卡死等级：warn=需关注；hard=明确卡死。 */
  level: 'warn' | 'hard';
}

/**
 * 检测当前 subpoint 是否在某个槽上原地打转（连续 landed 未 confirmed）。
 *
 * @param maxAttempts 判为卡死的连续条数（默认 4）
 */
export function detectStall(
  subpoint: Step3Subpoint,
  maxAttempts = 4,
): StallReport {
  const minutes = Array.isArray(subpoint.minutes) ? subpoint.minutes : [];
  const confirmedCount = minutes.filter(
    (m) => m.status === 'confirmed' && m.slotKey,
  ).length;

  // 连续未确认的实质回答，取最近一条 landed 的槽作为"打转槽"。
  // 统计该槽在 minutes 中 landed 但从未 confirmed 的条数。
  const landedOnly = minutes.filter(
    (m) => m.status === 'landed' && m.slotKey,
  );
  if (landedOnly.length === 0) {
    return { stalled: false, slotKey: null, slotLabel: null, attempts: 0, level: 'warn' };
  }

  // 找最近的 landed 槽
  const last = landedOnly[landedOnly.length - 1];
  const slotKey = String(last.slotKey || '');
  const attempts = minutes.filter(
    (m) => m.slotKey === slotKey && m.status === 'landed',
  ).length;

  // 同一槽被多次落槽但从未确认，且整体 confirmed 没增长 → 卡死。
  // 允许 1-2 次正常往返；≥maxAttempts 判卡死。
  const stalled = attempts >= maxAttempts && confirmedCount === 0
    ? true
    : attempts >= maxAttempts;

  // 找槽 label
  let slotLabel: string | null = null;
  const skeleton = subpoint.skeleton;
  if (skeleton) {
    for (const f of skeletonFlatSlots(skeleton)) {
      if (f.slot.key === slotKey) {
        slotLabel = f.slot.label;
        break;
      }
    }
  }

  return {
    stalled,
    slotKey: stalled ? slotKey : null,
    slotLabel: stalled ? slotLabel : null,
    attempts,
    level: attempts >= maxAttempts + 2 ? 'hard' : 'warn',
  };
}
