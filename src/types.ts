export interface Topic {
  id: string;
  question: string;
  topic: 'Education' | 'Technology' | 'Environment' | 'Government' | 'Health' | 'Media' | 'Crime' | 'Culture' | 'Work';
  questionType: 'Agree / Disagree' | 'Discuss Both Views' | 'Advantages / Disadvantages' | 'Two-part Question' | 'Problem / Solution';
  difficulty: 'Easy' | 'Medium' | 'Hard';
}

export interface TopicAnalysis {
  questionType: string;
  isCorrectType: boolean;
  correctType: string;
  coreIssue: string;
  constraints: string[];
  explanation: string;
}

export interface Dimension {
  id: string;
  name: string;
  prompt: string; // e.g. "accessibility (who can access)"
  selected: boolean;
  isCustom?: boolean;
}

export interface ArgumentSeed {
  id: string;
  dimension: string;
  direction: 'SUPPORT' | 'AGAINST' | 'MIXED';
  mechanism: string; // e.g. "more rural students reach education"
  scope: string; // e.g. "removes distance constraint"
}

export interface ArgumentBundle {
  id: string;
  name: string; // e.g. "Option A"
  seeds: ArgumentSeed[];
  implicitImpact: string; // e.g. "positive impact"
}

export interface ThesisOption {
  id: string;
  thesis: string;
  strength: string; // "Strong" | "Balanced" | "Weak"
  logicFlow: string;
}

export interface Template {
  id: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  name: string;
  structure: string; // e.g. "Claim -> Reason -> Mechanism -> Result"
  description: string;
  exampleTopic: string;
  exampleElements: {
    claim: string;
    reason: string;
    mechanism?: string;
    example?: string;
    result?: string;
    contrast?: string;
    concession?: string;
    definition?: string;
    affectedGroup?: string;
    evaluation?: string;
  };
  keywords: string[];
}

export interface ArgumentationFeedback {
  structure: {
    claim: boolean;
    reason: boolean;
    mechanism: boolean;
    example: boolean;
    result: boolean;
    evaluation: boolean;
    concession: boolean;
    contrast: boolean;
    definition: boolean;
    affectedGroup: boolean;
  };
  missingElements: string[];
  socraticQuestions: string[];
  suggestedChain: {
    claim: string;
    reason: string;
    mechanism?: string;
    example?: string;
    result?: string;
    evaluation?: string;
    concession?: string;
    contrast?: string;
    definition?: string;
    affectedGroup?: string;
  };
  critique: string;
}

export interface SentencePracticeTask {
  id: string;
  concept: string; // e.g. "Students have the flexibility to manage their study schedules"
  section: 'intro' | 'body1' | 'body2' | 'conclusion';
  prompts: string[]; // Lexical cues: "have the flexibility to...", "manage study schedules"
  userDraft?: string;
  confirmedSentence?: string;
  confirmed?: boolean;
  hasBeenChecked?: boolean;
  contentAlignment?: {
    status: 'aligned' | 'partial' | 'mismatched';
    summary: string;
    coveredPoints: string[];
    missingPoints: string[];
    extraPoints: string[];
  };
  annotations?: {
    text: string;
    category: 'grammar' | 'lexical' | 'wordOrder' | 'expression' | 'meaning';
    explanation: string;
  }[];
}

export interface InlineGuidanceResult {
  category: 'vocabulary' | 'grammar' | 'wordOrder' | 'expression';
  issue: string;
  hint: string;
}

export interface ChatMessage {
  id: string;
  sender: 'ai' | 'user';
  text: string;
  timestamp: string;
  isSplit?: boolean;
}

export interface LogicStep {
  key: string;
  label: string;
  placeholder: string;
  value?: string;
}

export interface ParagraphPointBlock {
  id: string;
  label: string;
  subClaim: string;
  role: 'major' | 'minor';
  expansionStrategy: 'explanation' | 'example' | 'mechanism' | 'impact' | 'contrast' | 'hybrid';
  steps: LogicStep[];
}

export interface ParagraphPlan {
  mode: 'single_point' | 'total_then_points' | 'direct_points';
  diagnosis: string;
  totalClaim?: string;
  pointBlocks: ParagraphPointBlock[];
  optionalShortClosing?: string;
}

export interface PracticeSession {
  id: string;
  topic: Topic;
  currentStep: number; // 1 to 4
  step1: {
    selectedType?: string;
    userCoreIssue?: string;
    analysis?: TopicAnalysis;
    userAnalysisNotes?: string; // User self-written analysis
    coachEvaluation?: {
      correctType: string;
      coreIssue: string;
      constraints: string[];
      critique: string;
      score: number;
      writingTask?: string;
      keyQualifier?: string;
      suggestedDimensions?: string[];
    };
    isCompleted: boolean;
    chatHistory?: ChatMessage[];
  };
  step2: {
    dimensions: Dimension[];
    seeds: ArgumentSeed[];
    bundles: ArgumentBundle[];
    selectedBundleId?: string;
    thesisOptions: ThesisOption[];
    selectedThesis?: string;
    userStance?: string; // User self-written overall stance
    userPoints?: string; // User self-written sub-arguments
    currentStage?: 'explore_A' | 'explore_B' | 'stance' | 'summary';
    coachEvaluation?: {
      userStance: string;
      userPoints: string;
      currentStage?: 'explore_A' | 'explore_B' | 'stance' | 'summary';
      critique: string;
      suggestions: string[];
      suggestedStance: string;
      suggestedPoints: string;
      blueprint?: {
        question: string;
        position: string;
        body1?: string;
        body2?: string;
        bodies?: { title: string; content: string }[];
      };
      clustering?: {
        totalPoints: number;
        pointsList: string[];
        clusters: {
          theme: string;
          points: string[];
          targetBody: string;
          content: string;
        }[];
        outliers?: {
          point: string;
          suggestion: string;
        }[];
      };
      onlinePros?: string[];
      offlinePros?: string[];
      positionCheckPassed?: boolean;
      positionCheckDesc?: string;
      coverageCheckPassed?: boolean;
      coverageCheckDesc?: string;
      structureCheckPassed?: boolean;
      structureCheckDesc?: string;
    };
    isCompleted: boolean;
    chatHistory?: ChatMessage[];
  };
  step3: {
    selectedTemplateId?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
    userDraft?: string;
    subpoints: {
      id: string;
      content: string;
      points?: string[];
      targetBody?: string;
      theme?: string;
      draft?: string;
      hint?: string;
      isCompleted: boolean;
      claim?: string;
      mechanism?: string;
      result?: string;
      reason?: string;
      supportType?: 'example' | 'mechanism' | 'scenario';
      supportContent?: string;
      impact?: string;
      completenessChecks?: { label: string; passed: boolean; desc: string }[];
      transitionChecks?: { label: string; passed: boolean; desc: string }[];
      sufficiencyCheck?: { label: string; passed: boolean; desc: string };
      paragraphPlan?: ParagraphPlan;
      structureSteps?: LogicStep[];
      chatHistory?: ChatMessage[];
    }[];
    activeSubpointId?: string;
    isCompleted: boolean;
    chatHistory?: ChatMessage[];
  };
  step4: {
    tasks: SentencePracticeTask[];
    isCompleted: boolean;
    chatHistory?: ChatMessage[];
  };
  createdAt: string;
}
