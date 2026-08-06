import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Header from './components/Header';
import TopicSelector from './components/TopicSelector';
import TopicImporter from './components/TopicImporter';
import Step1Analysis from './components/Step1Analysis';
import Step2Brainstorm from './components/Step2Brainstorm';
import Step3Drafting from './components/Step3Drafting';
import Step4SentencePractice from './components/Step4SentencePractice';
import HistoryDialog from './components/HistoryDialog';
import { Topic, PracticeSession } from './types';
import { saveHistoryItem } from './historyStorage';
import type { ConversationHistoryItem } from './historyStorage';

export default function App() {
  const [activeTopic, setActiveTopic] = useState<Topic | null>(null);
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [apiKeyMissing, setApiKeyMissing] = useState(false);
  const [viewMode, setViewMode] = useState<'select' | 'import'>('select');
  const [topicListVersion, setTopicListVersion] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Check backend health & API key on mount
  useEffect(() => {
    checkHealth();
  }, []);

  const checkHealth = async () => {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      if (!data.hasKey) {
        setApiKeyMissing(true);
      }
    } catch (e) {
      console.error('Failed to check health:', e);
      setApiKeyMissing(true);
    }
  };

  // Restore session from localStorage if present
  useEffect(() => {
    const saved = localStorage.getItem('ielts_deconstruct_session');
    if (saved) {
      try {
        const parsed: PracticeSession = JSON.parse(saved);
        setActiveTopic(parsed.topic);
        setSession(parsed);
      } catch (e) {
        console.error('Failed to restore session:', e);
      }
    }
  }, []);

  const handleSelectTopic = (topic: Topic) => {
    const initialSession: PracticeSession = {
      id: `session-${Date.now()}`,
      topic,
      currentStep: 1,
      step1: { isCompleted: false },
      step2: { dimensions: [], seeds: [], bundles: [], thesisOptions: [], isCompleted: false },
      step3: { userDraft: '', subpoints: [], isCompleted: false },
      step4: { tasks: [], isCompleted: false },
      createdAt: new Date().toISOString(),
    };
    setActiveTopic(topic);
    setSession(initialSession);
    localStorage.setItem('ielts_deconstruct_session', JSON.stringify(initialSession));
    saveHistoryItem(initialSession);
  };

  const handleUpdateSession = (updates: Partial<PracticeSession> | ((prev: PracticeSession) => Partial<PracticeSession>)) => {
    setSession((prev) => {
      if (!prev) return null;
      const resolvedUpdates = typeof updates === 'function' ? updates(prev) : updates;
      const updated = { ...prev, ...resolvedUpdates };
      localStorage.setItem('ielts_deconstruct_session', JSON.stringify(updated));
      // 同步写入历史记录
      saveHistoryItem(updated);
      return updated;
    });
  };

  const handleSetStep = (step: number) => {
    if (!session) return;
    handleUpdateSession({ currentStep: step });
  };

  const handleNextStep = () => {
    if (!session) return;
    const next = Math.min(session.currentStep + 1, 4);
    handleSetStep(next);
  };

  const handleResetSession = () => {
    setActiveTopic(null);
    setSession(null);
    localStorage.removeItem('ielts_deconstruct_session');
  };

  const handleOpenHistorySession = (item: ConversationHistoryItem) => {
    // 先把当前 session 存一下
    if (session) {
      saveHistoryItem(session);
    }
    setActiveTopic(item.session.topic);
    setSession(item.session);
    localStorage.setItem('ielts_deconstruct_session', JSON.stringify(item.session));
    setHistoryOpen(false);
  };

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden bg-slate-50/50 flex flex-col">
      {/* Header */}
      <Header
        activeTopic={activeTopic}
        currentStep={session?.currentStep || 1}
        onStepClick={handleSetStep}
        onReset={handleResetSession}
        apiKeyMissing={apiKeyMissing}
        onOpenHistory={() => setHistoryOpen(true)}
      />

      {/* History Dialog */}
      <HistoryDialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onOpenSession={handleOpenHistorySession}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 pb-4 min-h-0 flex flex-col overflow-y-auto">
        <AnimatePresence mode="wait">
          {!activeTopic || !session ? (
            <motion.div
              key={viewMode === 'import' ? 'importer' : 'selector'}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.25 }}
            >
              {viewMode === 'import' ? (
                <TopicImporter
                  onBack={() => setViewMode('select')}
                  onImported={() => {
                    setTopicListVersion((v) => v + 1);
                    setViewMode('select');
                  }}
                />
              ) : (
                <TopicSelector
                  key={topicListVersion}
                  onSelectTopic={handleSelectTopic}
                  onOpenImporter={() => setViewMode('import')}
                  onOpenHistory={() => setHistoryOpen(true)}
                />
              )}
            </motion.div>
          ) : (
            <motion.div
              key={`step-${session.currentStep}`}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.25 }}
              className="w-full flex-1 min-h-0 flex flex-col lg:overflow-hidden"
            >
              {session.currentStep === 1 && (
                <Step1Analysis
                  topic={activeTopic}
                  session={session}
                  onUpdateSession={handleUpdateSession}
                  onNextStep={handleNextStep}
                />
              )}
              {session.currentStep === 2 && (
                <Step2Brainstorm
                  topic={activeTopic}
                  session={session}
                  onUpdateSession={handleUpdateSession}
                  onNextStep={handleNextStep}
                />
              )}
              {session.currentStep === 3 && (
                <Step3Drafting
                  topic={activeTopic}
                  session={session}
                  onUpdateSession={handleUpdateSession}
                  onNextStep={handleNextStep}
                />
              )}
              {session.currentStep === 4 && (
                <Step4SentencePractice
                  topic={activeTopic}
                  session={session}
                  onUpdateSession={handleUpdateSession}
                  onNextStep={handleNextStep}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
