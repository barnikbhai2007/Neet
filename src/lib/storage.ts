import { get, set, keys, del, clear } from 'idb-keyval';
import { Question } from './gemini';

export interface SavedExam {
  id: string;
  name: string;
  date: number;
  subjects: string[];
  questionCount: number;
}

export async function saveExam(name: string, subjects: string[], questions: Question[]) {
  const id = `exam-${Date.now()}`;
  const examMeta: SavedExam = {
    id,
    name,
    date: Date.now(),
    subjects,
    questionCount: questions.length
  };

  // Store metadata index
  const history = await get<SavedExam[]>('exam-history') || [];
  await set('exam-history', [examMeta, ...history]);

  // Store actual questions in separate key to handle large data
  await set(`questions-${id}`, questions);
  
  return id;
}

export async function getExamHistory(): Promise<SavedExam[]> {
  return await get<SavedExam[]>('exam-history') || [];
}

export async function getExamQuestions(id: string): Promise<Question[] | undefined> {
  return await get<Question[]>(`questions-${id}`);
}

export async function deleteExam(id: string) {
  const history = await get<SavedExam[]>('exam-history') || [];
  await set('exam-history', history.filter(h => h.id !== id));
  await del(`questions-${id}`);
}

export async function clearHistory() {
  await clear();
}
