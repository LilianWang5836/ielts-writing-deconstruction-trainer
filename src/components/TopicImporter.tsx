import React, { useMemo, useState } from 'react';
import { ArrowLeft, Download, Loader2, Sparkles, Upload } from 'lucide-react';
import { Topic } from '../types';
import { PRESET_TOPICS } from '../topics';
import {
  downloadTopicsJson,
  getImportedTopics,
  mergeImportedTopics,
  normalizeQuestionText,
} from '../topicStorage';

interface TopicImporterProps {
  onBack: () => void;
  onImported?: () => void;
}

type PreviewRow = {
  question: string;
  topic?: Topic['topic'];
  questionType?: Topic['questionType'];
  difficulty?: Topic['difficulty'];
  status: 'pending' | 'ready' | 'duplicate' | 'error';
  note?: string;
};

const BATCH_SIZE = 10;

function parseQuestions(raw: string): string[] {
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export default function TopicImporter({ onBack, onImported }: TopicImporterProps) {
  const [rawText, setRawText] = useState('');
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [errorMsg, setErrorMsg] = useState('');
  const [importMsg, setImportMsg] = useState('');

  const readyCount = useMemo(
    () => rows.filter((r) => r.status === 'ready').length,
    [rows],
  );

  const markDuplicates = (list: PreviewRow[]): PreviewRow[] => {
    const existingKeys = new Set([
      ...PRESET_TOPICS.map((t) => normalizeQuestionText(t.question)),
      ...getImportedTopics().map((t) => normalizeQuestionText(t.question)),
    ]);
    const batchSeen = new Set<string>();

    return list.map((row) => {
      const key = normalizeQuestionText(row.question);
      if (!key) {
        return { ...row, status: 'error' as const, note: '空题干' };
      }
      if (existingKeys.has(key) || batchSeen.has(key)) {
        return { ...row, status: 'duplicate' as const, note: '已存在，将跳过' };
      }
      batchSeen.add(key);
      return row;
    });
  };

  const handleExtract = async () => {
    const questions = parseQuestions(rawText);
    if (questions.length === 0) {
      setErrorMsg('请先粘贴题目（一行一题）。');
      return;
    }

    setErrorMsg('');
    setImportMsg('');
    setExtracting(true);
    setProgress({ done: 0, total: questions.length });

    const nextRows: PreviewRow[] = questions.map((question) => ({
      question,
      status: 'pending',
    }));

    try {
      for (let i = 0; i < questions.length; i += BATCH_SIZE) {
        const batch = questions.slice(i, i + BATCH_SIZE);
        const res = await fetch('/api/extract-topic-tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questions: batch }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          throw new Error(data.error || '标签生成失败');
        }

        const results = Array.isArray(data.results) ? data.results : [];
        batch.forEach((question, idx) => {
          const item = results[idx] || {};
          const rowIndex = i + idx;
          nextRows[rowIndex] = {
            question,
            topic: item.topic,
            questionType: item.questionType,
            difficulty: item.difficulty,
            status: 'ready',
          };
        });

        setProgress({
          done: Math.min(i + batch.length, questions.length),
          total: questions.length,
        });
        setRows(markDuplicates([...nextRows]));
      }

      setRows(markDuplicates(nextRows));
    } catch (e: any) {
      console.error(e);
      setErrorMsg(e.message || '标签生成失败，请检查 API Key。');
      setRows(markDuplicates(nextRows));
    } finally {
      setExtracting(false);
    }
  };

  const handleImport = () => {
    const toImport: Topic[] = rows
      .filter((r) => r.status === 'ready' && r.topic && r.questionType && r.difficulty)
      .map((r) => ({
        id: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        question: r.question,
        topic: r.topic!,
        questionType: r.questionType!,
        difficulty: r.difficulty!,
      }));

    if (toImport.length === 0) {
      setErrorMsg('没有可导入的题目（可能都是重复项）。');
      return;
    }

    const { added, skipped } = mergeImportedTopics(toImport);
    setImportMsg(
      `已导入 ${added.length} 题${skipped > 0 ? `，跳过重复 ${skipped} 题` : ''}。`,
    );
    setErrorMsg('');
    onImported?.();
  };

  const handleExport = () => {
    const exportable = rows
      .filter((r) => r.status === 'ready' && r.topic && r.questionType && r.difficulty)
      .map((r, idx) => ({
        id: `export-${idx + 1}`,
        question: r.question,
        topic: r.topic!,
        questionType: r.questionType!,
        difficulty: r.difficulty!,
      }));
    if (exportable.length === 0) {
      setErrorMsg('没有可导出的结果，请先生成标签。');
      return;
    }
    downloadTopicsJson(exportable);
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" />
          返回选题
        </button>
        <span className="text-xs font-bold uppercase tracking-wider text-indigo-600">
          题目导入
        </span>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4 shadow-sm">
        <div>
          <h2 className="font-sans text-lg font-bold text-slate-900">粘贴题干，生成标签后导入</h2>
          <p className="mt-1 text-xs text-slate-500">
            一行一题。系统会自动抽取话题 / 题型 / 难度，导入后出现在选题列表。
          </p>
        </div>

        <textarea
          rows={8}
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder={`Some people believe that online learning should replace traditional classrooms. To what extent do you agree or disagree?\n\nMany governments spend large amounts of money on public transport. What are the advantages and disadvantages?`}
          className="w-full rounded-lg border border-slate-200 bg-slate-50/50 p-3 font-sans text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
          disabled={extracting}
        />

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleExtract}
            disabled={extracting || !rawText.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {extracting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                生成中 {progress.done}/{progress.total}
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                生成标签
              </>
            )}
          </button>
          <button
            onClick={handleImport}
            disabled={extracting || readyCount === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" />
            导入（{readyCount}）
          </button>
          <button
            onClick={handleExport}
            disabled={extracting || readyCount === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            导出 JSON
          </button>
        </div>

        {errorMsg && (
          <div className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {errorMsg}
          </div>
        )}
        {importMsg && (
          <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            {importMsg}
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
          <div className="border-b border-slate-100 px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-500">
            预览（{rows.length}）
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">#</th>
                  <th className="px-3 py-2 font-semibold min-w-[280px]">题干</th>
                  <th className="px-3 py-2 font-semibold">话题</th>
                  <th className="px-3 py-2 font-semibold">题型</th>
                  <th className="px-3 py-2 font-semibold">难度</th>
                  <th className="px-3 py-2 font-semibold">状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={`${idx}-${row.question.slice(0, 24)}`} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2 text-slate-400">{idx + 1}</td>
                    <td className="px-3 py-2 text-slate-800 leading-relaxed">{row.question}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{row.topic || '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{row.questionType || '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{row.difficulty || '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {row.status === 'ready' && <span className="text-emerald-600">可导入</span>}
                      {row.status === 'pending' && <span className="text-slate-400">待生成</span>}
                      {row.status === 'duplicate' && <span className="text-amber-600">{row.note || '重复'}</span>}
                      {row.status === 'error' && <span className="text-rose-600">{row.note || '错误'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
