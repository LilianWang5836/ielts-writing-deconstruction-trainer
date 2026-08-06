/**
 * 结构化日志工具 — 系统日志 + 业务日志 + 对话导出
 *
 * 环境变量控制：
 *   LOG_LEVEL=debug|info|warn|error  （默认 prod 时为 info, dev 时为 debug）
 *   LOG_TO_FILE=true                  （写入 logs/ 目录，默认仅 console）
 *
 * 使用示例：
 *   import { log } from './logger';
 *   log.info('system', 'Server started', { port: 3000 });
 *   log.llmRequest('gemini-3.5-flash', prompt, turnId);
 *   log.llmResponse('gemini-3.5-flash', rawText, turnId);
 *   log.startTurn(turnId, '用户消息文本');
 *   log.endTurn(turnId, 'Coach 回复文本', { progressUpdate });
 */

import * as fs from 'fs';
import * as path from 'path';

// ── 类型 ──────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogCategory = 'system' | 'llm' | 'business' | 'conversation' | 'guard';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: unknown;
  turnId?: string;
}

interface TurnRecord {
  turnId: string;
  step: number;
  userMessage: string;
  coachMessage: string;
  llmRequests: Array<{ model: string; promptPreview: string }>;
  llmResponses: Array<{ model: string; rawOutput: string }>;
  progressUpdate?: unknown;
  logs: LogEntry[];
}

// ── 配置 ──────────────────────────────────────────────────

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveLogLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_RANK) return env as LogLevel;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

const currentLevel: LogLevel = resolveLogLevel();
const logToFile: boolean = process.env.LOG_TO_FILE === 'true';
const LOG_DIR = path.join(process.cwd(), 'logs');

// ── 对话记录存储（内存） ──────────────────────────────────

const turns = new Map<string, TurnRecord>();
let currentTurnId: string | null = null;

function ensureLogDir(): void {
  if (logToFile && !fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[currentLevel];
}

// ── 输出 ──────────────────────────────────────────────────

function output(entry: LogEntry): void {
  if (!shouldLog(entry.level)) return;

  const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.category}]`;
  let line = `${prefix} ${entry.message}`;
  if (entry.turnId) line += ` (turn=${entry.turnId})`;

  // Console output
  switch (entry.level) {
    case 'error':
      console.error(line, entry.data ?? '');
      break;
    case 'warn':
      console.warn(line, entry.data ?? '');
      break;
    default:
      console.log(line, entry.data ?? '');
  }

  // File output
  if (logToFile) {
    ensureLogDir();
    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = path.join(LOG_DIR, `app-${dateStr}.log`);
    const fileLine = JSON.stringify({ ...entry, data: entry.data ? safeStringify(entry.data) : undefined }) + '\n';
    fs.appendFileSync(filePath, fileLine);
  }

  // Attach to current turn
  if (entry.turnId && turns.has(entry.turnId)) {
    turns.get(entry.turnId)!.logs.push(entry);
  }
}

function safeStringify(data: unknown, maxLen = 2000): string {
  try {
    const s = JSON.stringify(data);
    return s.length > maxLen ? s.slice(0, maxLen) + '…[truncated]' : s;
  } catch {
    return String(data).slice(0, maxLen);
  }
}

// ── 公共 API ──────────────────────────────────────────────

export const log = {
  debug(category: LogCategory, message: string, data?: unknown): void {
    output({ timestamp: formatTimestamp(), level: 'debug', category, message, data, turnId: currentTurnId ?? undefined });
  },

  info(category: LogCategory, message: string, data?: unknown): void {
    output({ timestamp: formatTimestamp(), level: 'info', category, message, data, turnId: currentTurnId ?? undefined });
  },

  warn(category: LogCategory, message: string, data?: unknown): void {
    output({ timestamp: formatTimestamp(), level: 'warn', category, message, data, turnId: currentTurnId ?? undefined });
  },

  error(category: LogCategory, message: string, data?: unknown): void {
    output({ timestamp: formatTimestamp(), level: 'error', category, message, data, turnId: currentTurnId ?? undefined });
  },

  // ── LLM 专用 ──────────────────────────────────────────

  /** LLM 请求发出前 */
  llmRequest(model: string, promptPreview: string, turnId?: string): void {
    const tid = turnId || currentTurnId;
    const preview = promptPreview.length > 300 ? promptPreview.slice(0, 300) + '…' : promptPreview;
    log.info('llm', `→ Request: ${model}`, { model, promptPreview: preview });
    if (tid && turns.has(tid)) {
      turns.get(tid)!.llmRequests.push({ model, promptPreview });
    }
  },

  /** LLM 响应收到后 */
  llmResponse(model: string, rawOutput: string, turnId?: string): void {
    const tid = turnId || currentTurnId;
    log.debug('llm', `← Response: ${model}`, { model, rawOutput: rawOutput.slice(0, 500) });
    if (tid && turns.has(tid)) {
      turns.get(tid)!.llmResponses.push({ model, rawOutput });
    }
  },

  /** LLM 调用失败 */
  llmError(model: string, error: unknown, turnId?: string): void {
    const tid = turnId || currentTurnId;
    log.error('llm', `✗ Failed: ${model}`, { model, error: safeStringify(error) });
  },

  // ── 对话生命周期 ───────────────────────────────────────

  /**
   * 开始一个新的对话轮次。
   * 在 /api/coach/chat 处理开始时调用。
   */
  startTurn(turnId: string, step: number, userMessage: string): void {
    currentTurnId = turnId;
    turns.set(turnId, {
      turnId,
      step,
      userMessage,
      coachMessage: '',
      llmRequests: [],
      llmResponses: [],
      logs: [],
    });
    log.info('conversation', `Turn started (step=${step})`, { userMessage: userMessage.slice(0, 200) });
  },

  /**
   * 结束当前对话轮次。
   * 在 /api/coach/chat 处理完成、返回响应前调用。
   */
  endTurn(turnId: string, coachMessage: string, progressUpdate?: unknown): void {
    const record = turns.get(turnId);
    if (record) {
      record.coachMessage = coachMessage;
      record.progressUpdate = progressUpdate;
    }
    log.info('conversation', `Turn completed`, {
      coachMessagePreview: coachMessage.slice(0, 150),
      progressKeys: progressUpdate ? Object.keys(progressUpdate as object) : [],
    });
    currentTurnId = null;
  },

  // ── 对话导出 ───────────────────────────────────────────

  /**
   * 导出单个对话轮次为 Markdown。
   * Debug/开发阶段使用。
   */
  exportTurn(turnId: string): string {
    const record = turns.get(turnId);
    if (!record) return `<!-- Turn ${turnId} not found -->`;

    const lines: string[] = [
      `# Turn: ${turnId}`,
      `- **Step**: ${record.step}`,
      `- **Timestamp**: ${record.logs[0]?.timestamp || 'unknown'}`,
      '',
      '## User Message',
      '',
      record.userMessage,
      '',
      '## Coach Response',
      '',
      record.coachMessage,
      '',
      '## LLM Calls',
      '',
    ];

    for (let i = 0; i < record.llmRequests.length; i++) {
      const req = record.llmRequests[i];
      const res = record.llmResponses[i];
      lines.push(`### Call ${i + 1}: ${req.model}`, '');
      lines.push('**Prompt Preview:**');
      lines.push('');
      lines.push('```');
      lines.push(req.promptPreview);
      lines.push('```');
      lines.push('');
      if (res) {
        lines.push('**Raw Response:**');
        lines.push('');
        lines.push('```json');
        lines.push(res.rawOutput.length > 2000 ? res.rawOutput.slice(0, 2000) + '\n…[truncated]' : res.rawOutput);
        lines.push('```');
      }
      lines.push('');
    }

    if (record.progressUpdate) {
      lines.push('## Progress Update');
      lines.push('');
      lines.push('```json');
      lines.push(safeStringify(record.progressUpdate, 5000));
      lines.push('```');
      lines.push('');
    }

    if (record.logs.length > 0) {
      lines.push('## Logs');
      lines.push('');
      lines.push('| Time | Level | Category | Message |');
      lines.push('|------|-------|----------|---------|');
      for (const l of record.logs) {
        lines.push(`| ${l.timestamp} | ${l.level} | ${l.category} | ${l.message.slice(0, 80)} |`);
      }
    }

    return lines.join('\n');
  },

  /**
   * 导出整个会话（所有轮次）为 Markdown。
   */
  exportSession(sessionId: string): string {
    const lines: string[] = [
      `# Session: ${sessionId}`,
      `- **Exported**: ${formatTimestamp()}`,
      `- **Total Turns**: ${turns.size}`,
      '',
      '---',
      '',
    ];

    for (const [tid, record] of turns) {
      lines.push(log.exportTurn(tid));
      lines.push('', '---', '');
    }

    return lines.join('\n');
  },

  /**
   * 导出为独立 Markdown 文件。
   */
  exportToFile(filename: string, content: string): string {
    ensureLogDir();
    const filePath = path.join(LOG_DIR, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
    log.info('system', `Exported to ${filePath}`);
    return filePath;
  },

  /**
   * 获取分享链接（生产环境预留）。
   * Debug 阶段返回文件路径，生产阶段返回项目 URL。
   */
  getShareUrl(sessionId: string): string {
    if (process.env.NODE_ENV === 'production') {
      const baseUrl = process.env.APP_URL || 'http://localhost:3000';
      return `${baseUrl}/share/${sessionId}`;
    }
    // Debug: 导出到文件后返回文件路径
    const content = log.exportSession(sessionId);
    const filename = `session-${sessionId}-${new Date().toISOString().slice(0, 10)}.md`;
    return log.exportToFile(filename, content);
  },
};

export default log;
