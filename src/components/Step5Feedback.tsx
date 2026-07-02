import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { CheckCircle2, AlertCircle, ArrowRight, Loader2, BookOpen, Award, Layers, Sparkles, RefreshCw, ChevronRight, TrendingUp } from 'lucide-react';
import { Topic, PracticeSession, OverallFeedback } from '../types';
import CoachChat from './CoachChat';

interface Step5FeedbackProps {
  topic: Topic;
  session: PracticeSession;
  onUpdateSession: (updates: Partial<PracticeSession>) => void;
  onRestart: () => void;
}

export default function Step5Feedback({
  topic,
  session,
  onUpdateSession,
  onRestart,
}: Step5FeedbackProps) {
  const [feedback, setFeedback] = useState<OverallFeedback | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [activeTab, setActiveTab] = useState<'step1' | 'step2' | 'step3' | 'step4'>('step3');

  useEffect(() => {
    setActiveTab('step3');
    if (session.step5.overallFeedback) {
      setFeedback(session.step5.overallFeedback);
    } else {
      generateOverallFeedback();
    }
  }, []);

  const generateOverallFeedback = async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const sentenceDrafts = session.step4.tasks.map((t) => ({
        concept: t.concept,
        draft: t.userDraft || '',
        score: t.aiFeedback?.score || 6.0,
        improved: t.aiFeedback?.improved || '',
      }));

      const res = await fetch('/api/overall-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: topic.question,
          thesis: session.step2.selectedThesis || session.step2.userStance || '',
          paragraphDraft: session.step3.userDraft || '',
          sentenceDrafts,
        }),
      });
      const data: any = await res.json();
      if (!res.ok || data.error) {
        setErrorMsg(data.error || '生成评估报告失败，请检查 API 密钥设置。');
        return;
      }
      setFeedback(data);
      onUpdateSession({
        step5: {
          ...session.step5,
          overallFeedback: data,
          isCompleted: true,
        },
      });
    } catch (e: any) {
      console.error(e);
      setErrorMsg('生成最终报告时发生网络错误：' + (e.message || ''));
    } finally {
      setLoading(false);
    }
  };

  const isFeedbackValid = feedback && !('error' in feedback) && typeof feedback.bandScore === 'number';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 md:gap-6 h-full min-h-0 w-full flex-1">
      {/* LEFT COLUMN: AI Coach Dialogue Area */}
      <div className="lg:col-span-5 xl:col-span-5 h-[480px] lg:h-full flex flex-col min-h-0">
        <CoachChat
          topic={topic}
          step={5}
          stepKey="step5"
          session={session}
          onUpdateSession={onUpdateSession}
          stepContext={{ overallFeedback: feedback }}
          welcomeMessage={`【雅思写作原题 (Topic)】
${topic.question}

【第五步：特训合议评估 🎉】
恭喜你完成了本次雅思写作特训！

👉 **我已经为你生成了一份综合诊断报告，请在右侧查看你的得分与改进建议。**

如果你对这次练习的得分、逻辑论证或词汇语法有任何疑问，请随时在下方提问，我们一起探讨提分细节！`}
        >
          {loading ? (
            <div className="flex flex-col items-center justify-center h-48 text-center p-6 space-y-3">
              <Loader2 className="h-8 w-8 text-indigo-600 animate-spin" />
              <div className="space-y-1">
                <h4 className="font-sans font-bold text-slate-800 text-sm">考官深度合议阅卷中...</h4>
                <p className="font-sans text-[11px] text-slate-500 leading-relaxed max-w-xs">
                  正在交叉分析您的审题、立场的一致性、主体段落的逻辑因果链以及精进句式的表达深度，并对照 IELTS 官方写作大纲的四大核心标准输出估分。
                </p>
              </div>
            </div>
          ) : errorMsg ? (
            <div className="bg-rose-50 border border-rose-100 rounded-lg p-4 space-y-2 text-rose-800 text-xs mt-4">
              <div className="flex items-center gap-2 font-bold">
                <AlertCircle className="h-4.5 w-4.5 text-rose-500" />
                <span>AI 评估遇到阻碍</span>
              </div>
              <p>{errorMsg}</p>
              <button
                onClick={generateOverallFeedback}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-1.5 text-[11px] font-semibold text-white hover:bg-rose-700 transition"
              >
                <RefreshCw className="h-3 w-3" />
                <span>重新生成报告</span>
              </button>
            </div>
          ) : isFeedbackValid && feedback ? (
            <div className="space-y-4 mt-4">
              {/* Overall Band */}
              <div className="rounded-xl border border-slate-200/60 bg-slate-50/50 p-5 text-center space-y-2 flex flex-col items-center">
                <span className="font-sans text-[9px] font-bold text-slate-400 uppercase tracking-wider block">
                  预计雅思写作得分 (Estimated Band Score)
                </span>
                
                <div className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-dashed border-indigo-600 bg-indigo-50/40">
                  <span className="font-sans text-3xl font-black text-indigo-700">
                    {feedback.bandScore.toFixed(1)}
                  </span>
                </div>

                <div className="space-y-0.5">
                  <h4 className="font-sans font-bold text-slate-800 text-xs">拆解力特训阶段成果</h4>
                  <p className="font-sans text-[10px] text-slate-400">
                    此得分基于您本次练习各步骤的核心逻辑产出。
                  </p>
                </div>
              </div>

              {/* Subscores criteria list */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                <span className="font-sans text-[9px] font-bold text-slate-400 uppercase tracking-wider block border-b border-slate-100 pb-1.5">
                  评分维度细分 (IELTS Writing Criteria)
                </span>

                <div className="space-y-2.5 font-sans text-xs">
                  {/* TA */}
                  <div className="flex items-center justify-between">
                    <div>
                      <strong className="text-slate-700 block">Task Achievement (任务回应)</strong>
                      <span className="text-[9px] text-slate-400">立场及分论点扣题深度</span>
                    </div>
                    <span className="rounded bg-indigo-50 border border-indigo-100 px-2 py-0.5 font-mono font-bold text-indigo-700">
                      {feedback.taScore.toFixed(1)}
                    </span>
                  </div>
                  {/* CC */}
                  <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                    <div>
                      <strong className="text-slate-700 block">Coherence & Cohesion (连贯与衔接)</strong>
                      <span className="text-[9px] text-slate-400">段落功能句因果逻辑连贯性</span>
                    </div>
                    <span className="rounded bg-indigo-50 border border-indigo-100 px-2 py-0.5 font-mono font-bold text-indigo-700">
                      {feedback.ccScore.toFixed(1)}
                    </span>
                  </div>
                  {/* LR */}
                  <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                    <div>
                      <strong className="text-slate-700 block">Lexical Resource (词汇丰富性)</strong>
                      <span className="text-[9px] text-slate-400">词汇搭配的学术与准确度</span>
                    </div>
                    <span className="rounded bg-indigo-50 border border-indigo-100 px-2 py-0.5 font-mono font-bold text-indigo-700">
                      {feedback.lrScore.toFixed(1)}
                    </span>
                  </div>
                  {/* GRA */}
                  <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                    <div>
                      <strong className="text-slate-700 block">Grammatical Range (语法准确性)</strong>
                      <span className="text-[9px] text-slate-400">复杂学术句式的精准组合度</span>
                    </div>
                    <span className="rounded bg-indigo-50 border border-indigo-100 px-2 py-0.5 font-mono font-bold text-indigo-700">
                      {feedback.graScore.toFixed(1)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Diagnosis and Critique */}
              <div className="space-y-3 font-sans text-xs">
                <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-3.5 space-y-1">
                  <span className="font-sans text-[9px] font-bold text-indigo-600 uppercase tracking-wider block">📐 行文逻辑链诊断 (Structure Diagnosis)</span>
                  <p className="text-slate-700 leading-relaxed whitespace-pre-wrap">{feedback.structureDiagnosis}</p>
                </div>

                <div className="bg-indigo-50/25 border border-indigo-100/60 rounded-xl p-3.5 space-y-1">
                  <span className="font-sans text-[9px] font-bold text-indigo-950 uppercase tracking-wider block">🎓 逻辑深度总点评 (Critique)</span>
                  <p className="text-slate-700 leading-relaxed whitespace-pre-wrap">{feedback.logicCritique}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center p-8 text-slate-400 font-sans text-xs mt-4">
              未能获取合议阅卷报告。
            </div>
          )}

          {/* Coach Controls / Action bar */}
          <div className="mt-4 flex gap-3 justify-end items-center border-t border-slate-100 pt-3">
            <button
              onClick={generateOverallFeedback}
              disabled={loading}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-sans text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 transition disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3 text-indigo-600" />
              <span>重新诊断评估</span>
            </button>
            
            <button
              onClick={onRestart}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 font-sans text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 transition"
            >
              <span>开启下一道题</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </CoachChat>
      </div>

      {/* RIGHT COLUMN: Persistent Writing Editor (Portfolio mode) */}
      <div className="lg:col-span-7 xl:col-span-7 flex flex-col h-[480px] lg:h-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden min-h-0">
        {/* Pinned Topic Banner */}
        <div className="bg-slate-50/80 border-b border-slate-200 p-4 shrink-0 backdrop-blur-sm">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="flex h-1.5 w-1.5 rounded-full bg-indigo-600 animate-pulse" />
            <span className="text-[10px] font-sans font-bold text-slate-500 uppercase tracking-wider">
              IELTS Writing Prompt / 雅思写作原题
            </span>
          </div>
          <p className="font-serif italic text-slate-800 text-xs leading-relaxed font-semibold">
            {topic.question}
          </p>
        </div>

        {/* Editor Tabs Header */}
        <div className="flex bg-slate-50 border-b border-slate-200 px-2 overflow-x-auto select-none shrink-0">
          <button
            onClick={() => setActiveTab('step1')}
            className={`flex items-center gap-1 px-4 py-3 font-sans text-xs font-bold border-b-2 transition shrink-0 ${
              activeTab === 'step1'
                ? 'border-indigo-600 text-indigo-700 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <BookOpen className="h-3.5 w-3.5 text-slate-400" />
            <span>📝 审题笔记</span>
          </button>
          <button
            onClick={() => setActiveTab('step2')}
            className={`flex items-center gap-1 px-4 py-3 font-sans text-xs font-bold border-b-2 transition shrink-0 ${
              activeTab === 'step2'
                ? 'border-indigo-600 text-indigo-700 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Layers className="h-3.5 w-3.5 text-slate-400" />
            <span>💡 逻辑论点</span>
          </button>
          <button
            onClick={() => setActiveTab('step3')}
            className={`flex items-center gap-1 px-4 py-3 font-sans text-xs font-bold border-b-2 transition shrink-0 ${
              activeTab === 'step3'
                ? 'border-indigo-600 text-indigo-700 bg-white font-extrabold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Layers className="h-3.5 w-3.5 text-indigo-600" />
            <span>✍️ 正文起草</span>
          </button>
          <button
            onClick={() => setActiveTab('step4')}
            className={`flex items-center gap-1 px-4 py-3 font-sans text-xs font-bold border-b-2 transition shrink-0 ${
              activeTab === 'step4'
                ? 'border-indigo-600 text-indigo-700 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Award className="h-3.5 w-3.5 text-slate-400" />
            <span>🎯 句式精进</span>
          </button>
        </div>

        {/* Editor Body */}
        <div className="flex-1 p-5 flex flex-col min-h-0 overflow-y-auto">
          {activeTab === 'step1' ? (
            <div className="flex-1 flex flex-col min-h-0">
              <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                审题笔记归档
              </span>
              <textarea
                value={session.step1.userAnalysisNotes || '未填写。'}
                readOnly
                className="flex-1 w-full p-4 border border-slate-200 rounded-lg font-sans text-sm text-slate-500 bg-slate-50/50 resize-none leading-relaxed focus:outline-none"
              />
            </div>
          ) : activeTab === 'step2' ? (
            <div className="flex-1 flex flex-col min-h-0 space-y-4">
              <div>
                <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  全文总立场归档
                </span>
                <div className="p-3 border border-slate-200 rounded-lg font-sans text-sm text-slate-500 bg-slate-50/50 whitespace-pre-wrap">
                  {session.step2.userStance || '未填写。'}
                </div>
              </div>
              <div className="flex-1 flex flex-col min-h-0">
                <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  分论点归档
                </span>
                <div className="flex-1 p-3 border border-slate-200 rounded-lg font-sans text-sm text-slate-500 bg-slate-50/50 whitespace-pre-wrap overflow-y-auto">
                  {session.step2.userPoints || '未填写。'}
                </div>
              </div>
            </div>
          ) : activeTab === 'step3' ? (
            <div className="flex-1 flex flex-col min-h-0 space-y-4">
              <div className="flex items-center justify-between">
                <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  原起草主体段落 (Your Original Draft)
                </span>
                <span className="font-mono text-[9px] text-slate-400">
                  {session.step3.userDraft?.split(/\s+/).filter(Boolean).length || 0} 词
                </span>
              </div>
              <textarea
                value={session.step3.userDraft || '未起草草稿。'}
                readOnly
                className="w-full h-32 p-4 border border-slate-200 rounded-lg font-serif italic text-sm text-slate-500 bg-slate-50/50 resize-none leading-relaxed focus:outline-none"
              />

              {isFeedbackValid && feedback?.revisions && feedback.revisions.length > 0 && (
                <div className="flex-1 flex flex-col min-h-0">
                  <span className="font-sans text-[10px] font-bold text-indigo-900 uppercase tracking-wider block mb-2">
                    ✍️ 考官重构句式保分精选 (Academic Revision Highlights)
                  </span>
                  <div className="flex-1 overflow-y-auto space-y-3 font-sans text-xs">
                    {feedback.revisions.map((rev, idx) => (
                      <div key={idx} className="border border-indigo-100 rounded-lg p-3 bg-indigo-50/15 space-y-2">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <div>
                            <span className="text-[9px] font-bold text-rose-500 uppercase tracking-wider block mb-0.5">优化前</span>
                            <p className="font-serif italic text-slate-400 line-through text-[11px]">"{rev.before}"</p>
                          </div>
                          <div>
                            <span className="text-[9px] font-bold text-emerald-600 uppercase tracking-wider block mb-0.5">重构后 (Band 8.0+)</span>
                            <p className="font-serif italic text-slate-800 font-bold text-[11px]">"{rev.after}"</p>
                          </div>
                        </div>
                        <div className="bg-white/80 p-2 rounded text-[10px] text-slate-600 leading-relaxed border border-slate-100">
                          <strong>学术演进点解析:</strong> {rev.explanation}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0 space-y-3 font-sans text-xs">
              <span className="font-sans text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                句式精进练习结果归档 (Completed Exercises)
              </span>
              <div className="flex-1 overflow-y-auto space-y-3">
                {session.step4.tasks.map((task, idx) => (
                  <div key={idx} className="border border-slate-200 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                      <span className="font-semibold text-slate-900">练习 {idx + 1}：{task.concept}</span>
                      <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded text-[10px] font-mono">
                        估分: {task.aiFeedback?.score || 6.0}
                      </span>
                    </div>
                    <div>
                      <span className="text-[9px] text-slate-400 uppercase block">我的英文作答</span>
                      <p className="font-serif italic text-slate-600 text-[11px]">"{task.userDraft}"</p>
                    </div>
                    <div className="bg-slate-50 p-2 rounded">
                      <span className="text-[9px] text-emerald-600 uppercase block font-bold">考官升级示范</span>
                      <p className="font-serif italic text-slate-800 font-bold text-[11px]">"{task.aiFeedback?.improved || task.userDraft}"</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
