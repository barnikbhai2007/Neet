import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, collection, query, where, getDocs, deleteDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const googleProvider = new GoogleAuthProvider();

export interface RemoteExam {
  id: string;
  name: string;
  subjects: string[];
  questionCount: number;
  createdAt: any; // Using any for Timestamp/number compatibility
  userId: string;
  questions: any[];
}

export function handleFirestoreError(error: any, operationType: string, path: string | null = null) {
  if (error && error.code === 'permission-denied') {
    const errorInfo = {
      error: error.message,
      operationType,
      path,
      authInfo: {
        userId: auth.currentUser?.uid || 'unauthenticated',
        email: auth.currentUser?.email || '',
        emailVerified: auth.currentUser?.emailVerified || false,
        isAnonymous: auth.currentUser?.isAnonymous || false,
        providerInfo: auth.currentUser?.providerData.map(p => ({
          providerId: p.providerId,
          displayName: p.displayName,
          email: p.email
        })) || []
      }
    };
    console.error("Firestore Permission Denied:", errorInfo);
    throw new Error(JSON.stringify(errorInfo));
  }
  
  if (error && error.code === 'unavailable') {
    throw new Error("Could not reach the database. Please check your internet connection.");
  }

  throw error;
}

export async function syncUserToFirestore(user: User) {
  try {
    const userRef = doc(db, 'users', user.uid);
    const snap = await getDoc(userRef);
    
    if (!snap.exists()) {
      await setDoc(userRef, {
        email: user.email,
        displayName: user.displayName,
        createdAt: serverTimestamp(),
        lastLogin: serverTimestamp()
      });
    } else {
      await setDoc(userRef, { lastLogin: serverTimestamp() }, { merge: true });
    }
  } catch (e) {
    handleFirestoreError(e, 'syncUser', `users/${user.uid}`);
  }
}

export async function saveExamToCloud(userId: string, name: string, subjects: string[], questions: any[]) {
  const examId = `exam-${Date.now()}`;
  const examRef = doc(db, 'users', userId, 'exams', examId);
  
  const data = {
    id: examId,
    userId,
    name,
    subjects,
    questionCount: questions.length,
    questions,
    createdAt: serverTimestamp()
  };

  try {
    await setDoc(examRef, data);
    return examId;
  } catch (e) {
    handleFirestoreError(e, 'create', `users/${userId}/exams/${examId}`);
  }
}

export async function getCloudExams(userId: string): Promise<RemoteExam[]> {
  try {
    const examsRef = collection(db, 'users', userId, 'exams');
    const snap = await getDocs(examsRef);
    return snap.docs.map(d => {
      const data = d.data();
      return {
        ...data,
        createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : data.createdAt
      } as RemoteExam;
    });
  } catch (e) {
    handleFirestoreError(e, 'list', `users/${userId}/exams`);
    return [];
  }
}

export async function deleteCloudExam(userId: string, examId: string) {
  try {
    const examRef = doc(db, 'users', userId, 'exams', examId);
    await deleteDoc(examRef);
  } catch (e) {
    handleFirestoreError(e, 'delete', `users/${userId}/exams/${examId}`);
  }
}
