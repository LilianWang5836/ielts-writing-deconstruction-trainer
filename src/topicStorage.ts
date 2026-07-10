import { Topic } from './types';

const STORAGE_KEY = 'ielts_imported_topics';

export function normalizeQuestionText(question: string): string {
  return String(question || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function getImportedTopics(): Topic[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: any) => ({
        id: String(item?.id || '').trim(),
        question: String(item?.question || '').trim(),
        topic: item?.topic,
        questionType: item?.questionType,
        difficulty: item?.difficulty,
      }))
      .filter(
        (item: Topic) =>
          item.id &&
          item.question &&
          item.topic &&
          item.questionType &&
          item.difficulty,
      );
  } catch {
    return [];
  }
}

export function saveImportedTopics(topics: Topic[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(topics));
}

/** Merge new topics into storage; skip duplicates by normalized question text. */
export function mergeImportedTopics(incoming: Topic[]): {
  added: Topic[];
  skipped: number;
  all: Topic[];
} {
  const existing = getImportedTopics();
  const seen = new Set(existing.map((t) => normalizeQuestionText(t.question)));
  const added: Topic[] = [];

  for (const topic of incoming) {
    const key = normalizeQuestionText(topic.question);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added.push(topic);
  }

  const all = [...existing, ...added];
  saveImportedTopics(all);
  return { added, skipped: incoming.length - added.length, all };
}

export function downloadTopicsJson(topics: Topic[], filename = 'ielts-topics.json') {
  const blob = new Blob([JSON.stringify(topics, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
