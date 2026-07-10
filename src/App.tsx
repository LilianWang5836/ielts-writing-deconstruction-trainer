import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Header from './components/Header';
import TopicSelector from './components/TopicSelector';
import TopicImporter from './components/TopicImporter';
import Step1Analysis from './components/Step1Analysis';
import Step2Brainstorm from './components/Step2Brainstorm';
import Step3Drafting from './components/Step3Drafting';
import Step4SentencePractice from './components/Step4SentencePractice';
import { Topic, PracticeSession } from './types';

export default function App() {
  const [activeTopic, setActiveTopic] = useState<Topic | null>(null);
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [apiKeyMissing, setApiKeyMissing] = useState(false);
  const [autoRedirectedSteps, setAutoRedirectedSteps] = useState<number[]>([]);
  const [viewMode, setViewMode] = useState<'select' | 'import'>('select');
  const [topicListVersion, setTopicListVersion] = useState(0);

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
        
        // Only skip auto-redirect for steps the user already advanced past (manual back-nav).
        // If step1.isCompleted but currentStep is still 1, we must allow auto-redirect.
        const completed: number[] = [];
        const cur = parsed.currentStep || 1;
        if (parsed.step1?.isCompleted && cur > 1) completed.push(1);
        if (parsed.step2?.isCompleted && cur > 2) completed.push(2);
        const step3Completed = parsed.step3?.isCompleted || (parsed.step3?.subpoints?.length > 0 && parsed.step3.subpoints.every((s: any) => s.isCompleted));
        if (step3Completed && cur > 3) completed.push(3);
        if (parsed.step4?.isCompleted && cur > 4) completed.push(4);
        setAutoRedirectedSteps(completed);
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
    setAutoRedirectedSteps([]);
    localStorage.setItem('ielts_deconstruct_session', JSON.stringify(initialSession));
  };

  const handleUpdateSession = (updates: Partial<PracticeSession> | ((prev: PracticeSession) => Partial<PracticeSession>)) => {
    setSession((prev) => {
      if (!prev) return null;
      const resolvedUpdates = typeof updates === 'function' ? updates(prev) : updates;
      const updated = { ...prev, ...resolvedUpdates };
      localStorage.setItem('ielts_deconstruct_session', JSON.stringify(updated));
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
    setAutoRedirectedSteps([]);
    localStorage.removeItem('ielts_deconstruct_session');
  };

  // Auto-transition to next step when completed while active on that step
  useEffect(() => {
    if (!session) return;
    const { currentStep } = session;
    
    let timer: NodeJS.Timeout;
    
    if (currentStep === 1 && session.step1.isCompleted && !autoRedirectedSteps.includes(1)) {
      timer = setTimeout(() => {
        setAutoRedirectedSteps(prev => [...prev, 1]);
        handleSetStep(2);
      }, 2500);
    } else if (currentStep === 2 && session.step2.isCompleted && !autoRedirectedSteps.includes(2)) {
      timer = setTimeout(() => {
        setAutoRedirectedSteps(prev => [...prev, 2]);
        handleSetStep(3);
      }, 2500);
    } else if (currentStep === 3 && (session.step3.isCompleted || (session.step3.subpoints?.length > 0 && session.step3.subpoints.every((s: any) => s.isCompleted))) && !autoRedirectedSteps.includes(3)) {
      timer = setTimeout(() => {
        setAutoRedirectedSteps(prev => [...prev, 3]);
        handleSetStep(4);
      }, 2500);
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [
    session?.currentStep,
    session?.step1.isCompleted,
    session?.step2.isCompleted,
    session?.step3.isCompleted,
    session?.step3.subpoints,
    session?.step4.isCompleted,
    autoRedirectedSteps
  ]);

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden bg-slate-50/50 flex flex-col">
      {/* Header */}
      <Header
        activeTopic={activeTopic}
        currentStep={session?.currentStep || 1}
        onStepClick={handleSetStep}
        onReset={handleResetSession}
        apiKeyMissing={apiKeyMissing}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 pb-4 min-h-0 flex flex-col lg:overflow-hidden">
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
