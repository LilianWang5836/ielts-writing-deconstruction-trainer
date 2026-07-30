import React from 'react';
import { X, History, Trash2, FileDown, ExternalLink, MessageSquare } from 'lucide-react';
import type { ConversationHistoryItem } from '../historyStorage';
import {
  getHistory,
  deleteHistoryItem,
  exportHistoryAsMarkdown,
  isDebugMode,
} from '../historyStorage';

interface HistoryDialogProps {
  open: boolean;
  onClose: () => void;
  onOpenSession: (item: ConversationHistoryItem) => void;
}

export default function HistoryDialog({ open, onClose, onOpenSession }: HistoryDialogProps) {
  if (!open) return null;

  const [history, setHistory] = React.useState(getHistory());

  // Refresh list when dialog opens
  React.useEffect(() => {
    if (open) setHistory(getHistory());
  }, [open]);

  const handleExport = (item: ConversationHistoryItem) => {
    const markdown = exportHistoryAsMarkdown(item);
    const blob = new Blob([markdown], { type: 'text/markdown; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ielts-${item.id}-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportWithLogs = (item: ConversationHistoryItem) => {
    // Debug 模式：尝试同时下载日志（如果存在）
    if (isDebugMode()) {
      const logDate = new Date().toISOString().slice(0, 10);
      const logUrl = `/api/log/session/${item.id}`;
      window.open(logUrl, '_blank');
    }
    handleExport(item);
  };

  const handleDelete = (id: string) => {
    if (confirm('确定要删除这条对话记录吗？')) {
      deleteHistoryItem(id);
      setHistory(getHistory());
    }
  };

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    } catch {
      return iso.slice(0, 16);
    }
  };

  const stepLabels: Record<number, string> = {
    1: '审题',
    2: '论点',
    3: '论证',
    4: '写作',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[80vh] flex flex-col m-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-2">
            <History className="h-5 w-5 text-indigo-600" />
            <h2 className="font-sans font-bold text-sm text-slate-800">历史对话</h2>
            <span className="text-xs text-slate-400">({history.length})</span>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5 min-h-0">
          {history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <MessageSquare className="h-10 w-10 mb-3 opacity-30" />
              <p className="text-xs">暂无历史对话记录</p>
              <p className="text-[10px] mt-1">开始一次训练后会自动保存</p>
            </div>
          ) : (
            history.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 hover:border-indigo-200 hover:bg-indigo-50/30 transition group"
              >
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <p className="font-sans text-xs font-semibold text-slate-800 truncate">
                    {item.topicQuestion}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                      {item.topicType}
                    </span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      item.isCompleted
                        ? 'bg-emerald-50 text-emerald-600'
                        : 'bg-amber-50 text-amber-600'
                    }`}>
                      {item.isCompleted ? '已完成' : `Step ${item.currentStep}/4`}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {formatDate(item.updatedAt)}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0 opacity-60 group-hover:opacity-100 transition">
                  <button
                    onClick={() => onOpenSession(item)}
                    className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-2.5 py-1.5 text-[10px] font-bold text-white shadow-sm transition"
                  >
                    <ExternalLink className="h-3 w-3" />
                    <span>打开</span>
                  </button>
                  <button
                    onClick={() =>
                      isDebugMode()
                        ? handleExportWithLogs(item)
                        : handleExport(item)
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 px-2 py-1.5 text-[10px] font-semibold text-slate-600 transition"
                    title={
                      isDebugMode()
                        ? '导出对话 + 调用日志'
                        : '导出对话'
                    }
                  >
                    <FileDown className="h-3 w-3" />
                    <span className="hidden sm:inline">{isDebugMode() ? '导出+日志' : '导出'}</span>
                  </button>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition"
                    title="删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
