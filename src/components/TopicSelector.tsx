import React, { useMemo, useState } from 'react';
import { Filter, Sparkles, BookOpen, PlusCircle, ChevronRight, HelpCircle, Upload } from 'lucide-react';
import { Topic } from '../types';
import { PRESET_TOPICS } from '../topics';
import { getImportedTopics, normalizeQuestionText } from '../topicStorage';

interface TopicSelectorProps {
  onSelectTopic: (topic: Topic) => void;
  onOpenImporter?: () => void;
}

export default function TopicSelector({ onSelectTopic, onOpenImporter }: TopicSelectorProps) {
  // Filters
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [selectedType, setSelectedType] = useState<string>('All');
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('All');

  // Custom Input State
  const [isCustomMode, setIsCustomMode] = useState(false);
  const [customQuestion, setCustomQuestion] = useState('');
  const [customTopic, setCustomTopic] = useState<Topic['topic']>('Education');
  const [customType, setCustomType] = useState<Topic['questionType']>('Agree / Disagree');
  const [customDifficulty, setCustomDifficulty] = useState<Topic['difficulty']>('Medium');

  // Filter Categories
  const categories = ['All', 'Education', 'Technology', 'Environment', 'Government', 'Health', 'Culture', 'Work'];
  const types = ['All', 'Agree / Disagree', 'Discuss Both Views', 'Advantages / Disadvantages', 'Two-part Question', 'Problem / Solution', 'Positive / Negative', 'Other'];
  const difficulties = ['All', 'Easy', 'Medium', 'Hard'];

  const allTopics = useMemo(() => {
    const imported = getImportedTopics();
    const seen = new Set(PRESET_TOPICS.map((t) => normalizeQuestionText(t.question)));
    const uniqueImported = imported.filter((t) => {
      const key = normalizeQuestionText(t.question);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return [...PRESET_TOPICS, ...uniqueImported];
  }, []);

  // Filter Topics
  const filteredTopics = allTopics.filter((t) => {
    const matchCat = selectedCategory === 'All' || t.topic === selectedCategory;
    const matchType = selectedType === 'All' || t.questionType === selectedType;
    const matchDiff = selectedDifficulty === 'All' || t.difficulty === selectedDifficulty;
    return matchCat && matchType && matchDiff;
  });

  const handleStartCustom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customQuestion.trim()) return;

    const topic: Topic = {
      id: `custom-${Date.now()}`,
      question: customQuestion.trim(),
      topic: customTopic,
      questionType: customType,
      difficulty: customDifficulty,
    };
    onSelectTopic(topic);
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      {/* Intro Banner */}
      <div className="mb-8 rounded-2xl bg-slate-900 p-8 text-white shadow-lg relative overflow-hidden">
        <div className="absolute right-0 top-0 h-64 w-64 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-32 w-32 rounded-full bg-emerald-500/10 blur-2xl" />
        
        <div className="relative max-w-2xl">
          <span className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-indigo-500/20 px-3 py-1 text-xs font-semibold text-indigo-300">
            <Sparkles className="h-3.5 w-3.5" />
            IELTS Task 2 Deconstruction Approach
          </span>
          <h2 className="font-sans text-3xl font-bold tracking-tight text-white md:text-4xl">
            告别盲目铺纸，<span className="text-indigo-300">拆解</span>才是提分钥匙。
          </h2>
          <p className="mt-4 font-sans text-sm leading-relaxed text-slate-300">
            传统备考写完几十篇却不见涨分，因为你是在“重复错误”。
            本产品通过**认知拆解法**（审题识别 → 词向发散 → 种子映射 → 组合推导 → 脚手架论证 → 局部优化），
            训练你像考官一样审视文章。
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex items-center justify-between gap-3 border-b border-slate-200">
        <div className="flex">
          <button
            onClick={() => setIsCustomMode(false)}
            className={`px-4 py-3 font-sans text-sm font-semibold transition border-b-2 ${
              !isCustomMode
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            从经典真题库选择
          </button>
          <button
            onClick={() => setIsCustomMode(true)}
            className={`px-4 py-3 font-sans text-sm font-semibold transition border-b-2 ${
              isCustomMode
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            自定义全新题目
          </button>
        </div>
        {onOpenImporter && (
          <button
            onClick={onOpenImporter}
            className="mb-[-1px] inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 hover:text-indigo-700"
          >
            <Upload className="h-3.5 w-3.5" />
            导入题目
          </button>
        )}
      </div>

      {!isCustomMode ? (
        <div className="space-y-6">
          {/* Filters Bento */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-5 space-y-4">
            <div className="flex items-center gap-2 pb-2 border-b border-slate-200 text-slate-700">
              <Filter className="h-4 w-4 text-slate-400" />
              <span className="font-sans text-xs font-bold uppercase tracking-wider">题目分类过滤器</span>
            </div>

            {/* Category Filter */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-sans text-xs font-medium text-slate-500 min-w-[70px]">话题标签:</span>
              <div className="flex flex-wrap gap-1">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`rounded-full px-3 py-1 font-sans text-xs font-medium transition ${
                      selectedCategory === cat
                        ? 'bg-slate-950 text-white'
                        : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Type Filter */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-sans text-xs font-medium text-slate-500 min-w-[70px]">题型标签:</span>
              <div className="flex flex-wrap gap-1">
                {types.map((t) => (
                  <button
                    key={t}
                    onClick={() => setSelectedType(t)}
                    className={`rounded-full px-3 py-1 font-sans text-xs font-medium transition ${
                      selectedType === t
                        ? 'bg-slate-950 text-white'
                        : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* Difficulty Filter */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-sans text-xs font-medium text-slate-500 min-w-[70px]">难度标签:</span>
              <div className="flex flex-wrap gap-1">
                {difficulties.map((diff) => (
                  <button
                    key={diff}
                    onClick={() => setSelectedDifficulty(diff)}
                    className={`rounded-full px-3 py-1 font-sans text-xs font-medium transition ${
                      selectedDifficulty === diff
                        ? 'bg-slate-950 text-white'
                        : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {diff}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Topic List */}
          <div className="grid gap-4 md:grid-cols-2">
            {filteredTopics.length > 0 ? (
              filteredTopics.map((topic) => (
                <div
                  key={topic.id}
                  onClick={() => onSelectTopic(topic)}
                  className="group relative flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:shadow-md cursor-pointer"
                >
                  <div className="space-y-3">
                    {/* Topic Tags */}
                    <div className="flex flex-wrap gap-1.5">
                      <span className="rounded bg-slate-100 px-2 py-0.5 font-sans text-[10px] font-semibold text-slate-600">
                        {topic.topic}
                      </span>
                      <span className="rounded bg-indigo-50 px-2 py-0.5 font-sans text-[10px] font-semibold text-indigo-700">
                        {topic.questionType}
                      </span>
                      <span className={`rounded px-2 py-0.5 font-sans text-[10px] font-semibold ${
                        topic.difficulty === 'Easy' ? 'bg-emerald-50 text-emerald-700' :
                        topic.difficulty === 'Medium' ? 'bg-amber-50 text-amber-700' :
                        'bg-rose-50 text-rose-700'
                      }`}>
                        {topic.difficulty}
                      </span>
                    </div>

                    <p className="font-sans text-sm font-medium leading-relaxed text-slate-800 group-hover:text-slate-950 transition">
                      {topic.question}
                    </p>
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-indigo-600 font-semibold group-hover:text-indigo-800">
                    <span className="inline-flex items-center gap-1">
                      <BookOpen className="h-3.5 w-3.5" />
                      开始拆解训练
                    </span>
                    <ChevronRight className="h-4 w-4 transform transition group-hover:translate-x-1" />
                  </div>
                </div>
              ))
            ) : (
              <div className="col-span-2 rounded-xl border border-dashed border-slate-300 py-12 text-center">
                <HelpCircle className="mx-auto h-8 w-8 text-slate-300" />
                <p className="mt-2 font-sans text-sm text-slate-500">没有找到符合当前筛选条件的真题。</p>
                <button
                  onClick={() => {
                    setSelectedCategory('All');
                    setSelectedType('All');
                    setSelectedDifficulty('All');
                  }}
                  className="mt-3 text-xs font-semibold text-indigo-600 hover:underline"
                >
                  重置筛选条件
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Custom Topic Creator */
        <form onSubmit={handleStartCustom} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-6">
          <div className="space-y-2">
            <label className="block font-sans text-sm font-bold text-slate-800">
              粘贴或输入您的 IELTS Task 2 写作题目:
            </label>
            <textarea
              required
              rows={4}
              value={customQuestion}
              onChange={(e) => setCustomQuestion(e.target.value)}
              placeholder="e.g., Some people believe that governments should spend money on measures to save languages that are used by few speakers. Others believe this is a waste of financial resources. Discuss both views..."
              className="w-full rounded-lg border border-slate-300 bg-slate-50/50 p-3 font-sans text-sm text-slate-800 placeholder-slate-400 shadow-inner focus:border-indigo-500 focus:bg-white focus:outline-none"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {/* Custom Topic Category */}
            <div className="space-y-1.5">
              <label className="block font-sans text-xs font-bold text-slate-600 uppercase tracking-wider">
                话题分类:
              </label>
              <select
                value={customTopic}
                onChange={(e) => setCustomTopic(e.target.value as Topic['topic'])}
                className="w-full rounded-lg border border-slate-200 bg-white p-2.5 font-sans text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {categories.filter(c => c !== 'All').map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>

            {/* Custom Type */}
            <div className="space-y-1.5">
              <label className="block font-sans text-xs font-bold text-slate-600 uppercase tracking-wider">
                雅思题型:
              </label>
              <select
                value={customType}
                onChange={(e) => setCustomType(e.target.value as Topic['questionType'])}
                className="w-full rounded-lg border border-slate-200 bg-white p-2.5 font-sans text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {types.filter(t => t !== 'All').map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            {/* Custom Difficulty */}
            <div className="space-y-1.5">
              <label className="block font-sans text-xs font-bold text-slate-600 uppercase tracking-wider">
                难度系数:
              </label>
              <select
                value={customDifficulty}
                onChange={(e) => setCustomDifficulty(e.target.value as Topic['difficulty'])}
                className="w-full rounded-lg border border-slate-200 bg-white p-2.5 font-sans text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                <option value="Easy">Easy</option>
                <option value="Medium">Medium</option>
                <option value="Hard">Hard</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end pt-4 border-t border-slate-100">
            <button
              type="submit"
              disabled={!customQuestion.trim()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-950 px-5 py-3 font-sans text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
            >
              <PlusCircle className="h-4 w-4" />
              <span>录入并开启拆解训练</span>
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
