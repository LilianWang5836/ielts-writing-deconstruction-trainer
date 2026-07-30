import React from 'react';
import { BookOpen, RefreshCw, Layers, ArrowLeft, Share2, History } from 'lucide-react';
import { Topic } from '../types';

interface HeaderProps {
  activeTopic: Topic | null;
  currentStep: number;
  onStepClick: (step: number) => void;
  onReset: () => void;
  apiKeyMissing: boolean;
  onOpenHistory?: () => void;
}

const STEPS = [
  { num: 1, label: '审题训练', desc: 'Identify & Extract' },
  { num: 2, label: '观点生成', desc: 'Brainstorm & Thesis' },
  { num: 3, label: '论证拆解', desc: 'Structure & Draft' },
  { num: 4, label: '逐句写作', desc: 'Express & Collocate' },
];

export default function Header({
  activeTopic,
  currentStep,
  onStepClick,
  onReset,
  apiKeyMissing,
  onOpenHistory,
}: HeaderProps) {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-200 bg-white/95 backdrop-blur-md px-6 py-4">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 md:flex-row md:items-center md:justify-between">
        {/* Title and Back Link */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
            <Layers className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-sans font-bold text-lg tracking-tight text-slate-900">
                雅思写作“拆解式”训练营
              </h1>
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 font-mono text-[10px] font-semibold text-indigo-700">
                MVP v1.0
              </span>
            </div>
            <p className="text-xs text-slate-500">IELTS Writing Task 2 Deconstruction Trainer</p>
          </div>
        </div>

        {/* Topic details and Action */}
        {activeTopic && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-slate-100 px-2 py-1 font-sans text-xs font-medium text-slate-700">
              {activeTopic.topic}
            </span>
            <span className="rounded bg-indigo-50 px-2 py-1 font-sans text-xs font-medium text-indigo-700">
              {activeTopic.questionType}
            </span>
            <span className={`rounded px-2 py-1 font-sans text-xs font-medium ${
              activeTopic.difficulty === 'Easy' ? 'bg-emerald-50 text-emerald-700' :
              activeTopic.difficulty === 'Medium' ? 'bg-amber-50 text-amber-700' :
              'bg-rose-50 text-rose-700'
            }`}>
              {activeTopic.difficulty}
            </span>
            <button
              onClick={onReset}
              className="ml-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-sans text-xs font-medium text-slate-600 shadow-sm transition hover:bg-slate-50 hover:text-slate-900"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>更换题目</span>
            </button>
            {onOpenHistory && (
              <button
                onClick={onOpenHistory}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-sans text-xs font-medium text-slate-600 shadow-sm transition hover:bg-indigo-50 hover:text-indigo-700"
                title="查看历史对话记录"
              >
                <History className="h-3.5 w-3.5" />
                <span>历史对话</span>
              </button>
            )}
            <button
              onClick={() => {
                try {
                  const raw = localStorage.getItem('ielts_deconstruct_session');
                  if (!raw) { alert('没有可导出的对话记录'); return; }
                  const session = JSON.parse(raw);
                  const lines: string[] = [
                    `# 雅思写作拆解训练 — 对话导出`,
                    `- **题目**: ${session.topic?.question || '未知'}`,
                    `- **题型**: ${session.topic?.questionType || '未知'}`,
                    `- **导出时间**: ${new Date().toISOString()}`,
                    '',
                    '---',
                    '',
                  ];
                  // 收集所有 step 的对话历史
                  for (const stepKey of ['step1', 'step2', 'step3', 'step4']) {
                    const step = session[stepKey]?.chatHistory || [];
                    if (stepKey === 'step3' && Array.isArray(session.step3?.subpoints)) {
                      for (const sp of session.step3.subpoints) {
                        if (Array.isArray(sp.chatHistory)) {
                          lines.push(`## ${sp.targetBody || sp.theme || 'Body Subpoint'}\n`);
                          for (const msg of sp.chatHistory) {
                            const role = msg.sender === 'ai' ? '**Coach**' : '**User**';
                            lines.push(`${role}: ${msg.text}\n`);
                          }
                        }
                      }
                    }
                    if (step.length > 0) {
                      lines.push(`## Step ${stepKey.slice(-1)} 对话\n`);
                      for (const msg of step) {
                        const role = msg.sender === 'ai' ? '**Coach**' : '**User**';
                        lines.push(`${role}: ${msg.text}\n`);
                      }
                    }
                  }
                  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `ielts-conversation-${Date.now()}.md`;
                  a.click();
                  URL.revokeObjectURL(url);
                } catch (e) {
                  console.error('导出失败:', e);
                  alert('导出对话失败');
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-sans text-xs font-medium text-slate-600 shadow-sm transition hover:bg-indigo-50 hover:text-indigo-700"
              title="导出对话记录为 Markdown"
            >
              <Share2 className="h-3.5 w-3.5" />
              <span>分享对话</span>
            </button>
          </div>
        )}
      </div>

      {apiKeyMissing && (
        <div className="mx-auto mt-3 max-w-7xl rounded-lg bg-amber-50 p-3 text-xs text-amber-800 border border-amber-200 flex items-center justify-between">
          <span>
            <strong>⚠️ 提示:</strong> 尚未检测到可用的 <code>GEMINI_API_KEY</code> 环境变量。
            为了体验真实的 AI 审题、观点生成和逻辑诊断反馈，请点击 <strong>Settings &gt; Secrets</strong> 面板配置您的 API Key。
          </span>
        </div>
      )}

      {/* Progress Steps bar */}
      {activeTopic && (
        <div className="mx-auto mt-4 max-w-7xl">
          <div className="grid grid-cols-4 gap-2">
            {STEPS.map((step) => {
              const isActive = currentStep === step.num;
              const isCompleted = currentStep > step.num;
              return (
                <button
                  key={step.num}
                  disabled={!isCompleted && !isActive}
                  onClick={() => onStepClick(step.num)}
                  className={`group relative flex flex-col items-start gap-1 rounded-lg border p-2 text-left transition ${
                    isActive
                      ? 'border-indigo-600 bg-indigo-50/40 shadow-sm'
                      : isCompleted
                      ? 'border-slate-200 bg-slate-50/50 hover:bg-slate-50'
                      : 'border-slate-100 bg-white opacity-40 cursor-not-allowed'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold ${
                      isActive ? 'bg-indigo-600 text-white' :
                      isCompleted ? 'bg-slate-700 text-white' :
                      'bg-slate-200 text-slate-500'
                    }`}>
                      {step.num}
                    </span>
                    <span className={`font-sans text-xs font-semibold ${
                      isActive ? 'text-indigo-900' :
                      isCompleted ? 'text-slate-800 group-hover:text-slate-900' :
                      'text-slate-400'
                    }`}>
                      {step.label}
                    </span>
                  </div>
                  <span className="hidden font-mono text-[9px] text-slate-400 md:block">
                    {step.desc}
                  </span>
                  
                  {/* Bottom indicator line */}
                  <div className={`absolute bottom-0 left-0 h-1 rounded-b-lg transition-all ${
                    isActive ? 'w-full bg-indigo-600' :
                    isCompleted ? 'w-full bg-slate-500' :
                    'w-0 bg-slate-200'
                  }`} />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </header>
  );
}
