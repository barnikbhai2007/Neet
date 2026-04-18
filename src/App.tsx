/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { 
  FileUp, 
  Loader2, 
  CheckCircle2, 
  AlertCircle, 
  BookOpen, 
  BrainCircuit, 
  Zap,
  ChevronRight,
  ChevronLeft,
  RefreshCw,
  Clock,
  LayoutDashboard,
  Library,
  History,
  Trash2,
  Calendar,
  Layers,
  Activity
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { processPDF, Question } from './lib/gemini';
import { cn } from './lib/utils';
import { saveExam, getExamHistory, getExamQuestions, deleteExam, SavedExam } from './lib/storage';
import { 
  auth, 
  googleProvider, 
  saveExamToCloud, 
  getCloudExams, 
  deleteCloudExam, 
  syncUserToFirestore,
  RemoteExam
} from './lib/firebase';
import { signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';

type ViewState = 'landing' | 'processing' | 'ready' | 'exam' | 'results' | 'library';

export default function App() {
  const [view, setView] = useState<ViewState>('landing');
  const [history, setHistory] = useState<SavedExam[]>([]);
  const [cloudHistory, setCloudHistory] = useState<RemoteExam[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [selectedSubjects, setSelectedSubjects] = useState<string[]>(['Botany']);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState<Record<number, number>>({});
  const [markedForReview, setMarkedForReview] = useState<Set<number>>(new Set());
  const [reviewSubjectFilter, setReviewSubjectFilter] = useState<string>('All');
  const [questionTimes, setQuestionTimes] = useState<Record<number, number>>({});
  const [lastSwitchTime, setLastSwitchTime] = useState<number>(Date.now());
  const [totalSeconds, setTotalSeconds] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [fileSize, setFileSize] = useState<number>(0);
  const [bytesScanned, setBytesScanned] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check for API Key on mount
  React.useEffect(() => {
    if (!process.env.GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY is missing in environment variables.");
    }
  }, []);

  // User & History Effect
  React.useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        await syncUserToFirestore(u);
        const cloud = await getCloudExams(u.uid);
        setCloudHistory(cloud);
      }
    });

    const loadData = async () => {
      const saved = await getExamHistory();
      setHistory(saved);
    };
    
    loadData();
    return () => unsubscribe();
  }, []);

  const login = async () => {
    try {
      const res = await signInWithPopup(auth, googleProvider);
      if (res.user) {
        const cloud = await getCloudExams(res.user.uid);
        setCloudHistory(cloud);
      }
    } catch (e: any) {
      console.error("Login Error:", e);
      let msg = e.message || "Login failed.";
      if (e.code === 'auth/unauthorized-domain') {
        msg = `Domain Blocked: Add "${window.location.hostname}" to Firebase -> Auth -> Authorized Domains.`;
      } else if (e.code === 'auth/operation-not-allowed') {
        msg = "Google Login is not enabled. Go to Firebase Console -> Auth -> Sign-in Method and enable Google.";
      }
      setError(`${msg} (Code: ${e.code || 'unknown'})`);
    }
  };

  const logout = () => signOut(auth);

  const handleManualImport = () => {
    try {
      const qs = JSON.parse(importText);
      if (!Array.isArray(qs)) throw new Error("JSON must be an array");
      
      const validated = qs.map((q, idx) => ({
        ...q,
        id: q.id || `q-import-${idx}`,
        subject: q.subject || 'Imported',
        correctAnswer: Number(q.correctAnswer),
        options: q.options || [],
        text: q.text || 'Missing text',
        explanation: q.explanation || 'No explanation provided',
        hasDiagram: q.hasDiagram || false,
        pageNumber: q.pageNumber || 1,
        originalQuestionNumber: q.originalQuestionNumber || idx + 1
      }));

      setQuestions(validated);
      setView('ready');
      setIsImportModalOpen(false);
      setImportText('');
    } catch (e) {
      setError("Invalid JSON format. Ensure it follows the NEET Scan question schema.");
    }
  };

  const subjects = [
    { name: 'Botany', icon: BrainCircuit },
    { name: 'Zoology', icon: BrainCircuit },
    { name: 'Physics', icon: Zap },
    { name: 'Chemistry', icon: BookOpen },
  ];

  // Timer Effect
  React.useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if ((view === 'exam' || view === 'ready') && !isPaused) {
      interval = setInterval(() => {
        if (view === 'exam') {
          setTotalSeconds(prev => prev + 1);
          setQuestionTimes(prev => ({
            ...prev,
            [currentQuestionIndex]: (prev[currentQuestionIndex] || 0) + 1
          }));
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [view, isPaused, currentQuestionIndex]);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    if (selectedSubjects.length === 0) {
      setError('Please select at least one subject.');
      return;
    }
    
    const file = acceptedFiles[0];
    if (file.type !== 'application/pdf') {
      setError('Please upload a valid PDF file.');
      return;
    }

    setFileSize(file.size);
    setBytesScanned(0);
    setLoading(true);
    setView('processing');
    setError(null);

    // Simulated scan progress (Gemini Pro takes ~30-60s for a full PDF scan)
    const startTime = Date.now();
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const targetDuration = 60000; // Target 60 seconds for large 180-question parses
      setBytesScanned(prev => {
        // Curve: fast at start, slowing down significantly at 95%
        const ratio = elapsed / targetDuration;
        const targetPercent = ratio < 0.95 ? ratio : 0.95 + (ratio - 0.95) * 0.1;
        const next = Math.min(file.size * 0.98, file.size * targetPercent);
        return next;
      });
    }, 500);

    try {
      const extractedQuestions = await processPDF(file, selectedSubjects);
      clearInterval(progressInterval);
      if (extractedQuestions.length === 0) {
        throw new Error('No questions extracted. Ensure the PDF contains readable text and that you\'ve selected specific subjects like "Botany" or "Zoology" rather than just "Biology".');
      }
      
      // Play success sound
      try {
        const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
        audio.volume = 0.5;
        audio.play();
      } catch (e) {
        console.log('Audio auto-play blocked or failed');
      }

      setQuestions(extractedQuestions);
      setLastSwitchTime(Date.now());
      setLoading(false);
      setBytesScanned(file.size);
      
      // Save to library
      const examName = file.name.replace(/\.[^/.]+$/, "");
      await saveExam(examName, selectedSubjects, extractedQuestions);
      
      // Save to cloud if logged in
      if (user) {
        await saveExamToCloud(user.uid, examName, selectedSubjects, extractedQuestions);
        const cloud = await getCloudExams(user.uid);
        setCloudHistory(cloud);
      }

      const updatedHistory = await getExamHistory();
      setHistory(updatedHistory);
      
      setView('ready');
    } catch (err: any) {
      clearInterval(progressInterval);
      setError(err.message || 'Failed to process PDF. Please try again.');
      setView('landing');
      setLoading(false);
    }
  }, [selectedSubjects]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    multiple: false
  });

  const [isQuestionMapOpen, setIsQuestionMapOpen] = useState(false);

  const toggleSubject = (name: string) => {
    setSelectedSubjects(prev => 
      prev.includes(name) 
        ? prev.filter(s => s !== name) 
        : [...prev, name]
    );
  };

  const updateQuestionTime = () => {
    const now = Date.now();
    const delta = Math.round((now - lastSwitchTime) / 1000);
    setQuestionTimes(prev => ({
      ...prev,
      [currentQuestionIndex]: (prev[currentQuestionIndex] || 0) + delta
    }));
    setLastSwitchTime(now);
  };

  const handleNext = () => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(prev => prev + 1);
    } else {
      setView('results');
    }
  };

  const handlePrev = () => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(prev => prev - 1);
    }
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const calculateNEETScore = () => {
    let total = 0;
    let correct = 0;
    let wrong = 0;
    let skipped = 0;

    questions.forEach((q, idx) => {
      if (userAnswers[idx] === undefined) {
        skipped++;
      } else if (userAnswers[idx] === q.correctAnswer) {
        correct++;
        total += 4;
      } else {
        wrong++;
        total -= 1;
      }
    });

    return { total, correct, wrong, skipped };
  };

  const reset = () => {
    setView('landing');
    setQuestions([]);
    setCurrentQuestionIndex(0);
    setUserAnswers({});
    setMarkedForReview(new Set());
    setReviewSubjectFilter('All');
    setQuestionTimes({});
    setTotalSeconds(0);
    setIsPaused(false);
    setError(null);
  };

  const toggleMarkForReview = (idx: number) => {
    setMarkedForReview(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const uniqueSubjectsInExam = Array.from(new Set(questions.map(q => q.subject)));

  const jumpToSubject = (subjectName: string) => {
    const firstIndex = questions.findIndex(q => q.subject === subjectName);
    if (firstIndex !== -1) {
      setCurrentQuestionIndex(firstIndex);
    }
  };

  const loadFromLibrary = async (id: string) => {
    setLoading(true);
    try {
      const qData = await getExamQuestions(id);
      if (qData) {
        setQuestions(qData);
        setView('ready');
      }
    } catch (e) {
      setError("Failed to load exam from library.");
    } finally {
      setLoading(false);
    }
  };

  const removeExam = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteExam(id);
    const updated = await getExamHistory();
    setHistory(updated);
  };

  return (
    <div className="min-h-screen bg-bg text-text-main flex flex-col">
      {/* Header */}
      <header className="h-[64px] border-b border-border bg-surface sticky top-0 z-20 px-4 md:px-6 flex items-center justify-between">
        <div className="flex items-center gap-3 cursor-pointer shrink-0" onClick={reset}>
          <div className="bg-primary text-white font-bold px-2 py-1 rounded text-[10px] md:text-xs tracking-tight">NEET SCAN</div>
          <div className="font-bold text-sm md:text-lg hidden xs:block">Master Scanner</div>
        </div>
        
        <div className="flex items-center gap-4">
          {user ? (
            <div className="flex items-center gap-3">
              <div className="hidden md:flex flex-col items-end leading-none">
                <span className="text-[10px] font-black uppercase text-text-muted">Account</span>
                <span className="text-xs font-bold truncate max-w-[100px]">{user.displayName || user.email}</span>
              </div>
              <button onClick={logout} className="w-8 h-8 rounded-full overflow-hidden border border-border hover:border-primary transition-colors">
                <img src={user.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.uid}`} referrerPolicy="no-referrer" alt="Avatar" />
              </button>
            </div>
          ) : (
            <button onClick={login} className="btn btn-primary text-[10px] md:text-sm px-3 md:px-5">Login</button>
          )}

          {view === 'landing' && (
            <button 
              onClick={() => setIsImportModalOpen(true)}
              className="btn flex items-center gap-2 text-xs md:text-sm border-border hover:border-primary/50"
            >
              <RefreshCw className="w-4 h-4 text-primary" />
              <span className="hidden sm:inline">Manual Import</span>
            </button>
          )}

          {view === 'landing' && (history.length > 0 || cloudHistory.length > 0) && (
            <button 
              onClick={() => setView('library')}
              className="btn flex items-center gap-2 text-xs md:text-sm border-border hover:border-primary/50"
            >
              <Library className="w-4 h-4 text-primary" />
              <span className="hidden sm:inline">My Library</span>
            </button>
          )}

          {view === 'exam' && (
            <div className="flex items-center gap-2 md:gap-3 text-xs md:text-sm">
              <button 
                onClick={() => setIsPaused(!isPaused)}
                className={cn(
                  "flex items-center gap-1.5 md:gap-2 px-2 md:px-3 py-1.5 rounded-md font-bold transition-all shrink-0",
                  isPaused ? "bg-success text-white" : "bg-warning/20 text-warning border border-warning/30"
                )}
              >
                {isPaused ? <Zap className="w-3.5 h-3.5 md:w-4 h-4" /> : <Clock className="w-3.5 h-3.5 md:w-4 h-4" />}
                <span className="hidden sm:inline">{isPaused ? "RESUME" : "PAUSE"}</span>
              </button>
              <div className="flex flex-col items-end leading-none">
                <span className="text-[9px] text-text-muted hidden md:inline font-black uppercase tracking-widest">Time</span>
                <span className="text-primary font-bold font-mono text-sm md:text-lg tabular-nums">
                  {formatTime(totalSeconds)}
                </span>
              </div>
            </div>
          )}
          <button className="btn px-2.5 py-1.5 sm:px-5 sm:py-2 text-[10px] md:text-sm" onClick={reset}>
            <span className="hidden xs:inline">New PDF</span>
            <span className="xs:hidden">New</span>
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        <AnimatePresence mode="wait">
          {view === 'landing' && (
            <motion.div
              key="landing"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex-1 max-w-4xl mx-auto px-4 py-12 md:py-20 flex flex-col items-center justify-center space-y-12"
            >
              <div className="text-center space-y-4">
                <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-1 rounded-full text-[10px] font-black uppercase tracking-[0.3em] mb-4">
                   <Zap className="w-3 h-3 fill-current" />
                   High Density Extraction
                </div>
                <h1 className="text-5xl md:text-7xl font-black uppercase tracking-tighter italic leading-[0.9] font-serif text-center">
                   Paper to <span className="text-primary">MCQ</span> <br /> In Seconds.
                </h1>
                <p className="text-text-muted font-bold text-sm md:text-base max-w-lg mx-auto leading-relaxed text-center">
                   Upload any NEET practice paper. Our AI deep-scans every diagram, question, and assertion for accurate simulations.
                </p>
              </div>

              {/* History Preview */}
              {history.length > 0 && (
                <div className="w-full max-w-xl bg-surface/50 border border-border p-4 rounded-3xl space-y-4">
                   <div className="flex items-center justify-between px-2">
                      <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-text-muted">
                        <History className="w-3.5 h-3.5" />
                        Recent Scans
                      </div>
                      <button onClick={() => setView('library')} className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline">View All</button>
                   </div>
                   <div className="grid grid-cols-1 gap-2">
                     {history.slice(0, 2).map((item) => (
                       <button 
                         key={item.id} 
                         onClick={() => loadFromLibrary(item.id)}
                         className="flex items-center justify-between p-4 bg-surface border border-border rounded-2xl hover:border-primary/50 transition-all text-left group"
                       >
                          <div className="flex items-center gap-4">
                            <div className="w-10 h-10 bg-primary/5 rounded-xl flex items-center justify-center text-primary">
                               <FileUp className="w-5 h-5" />
                            </div>
                            <div>
                               <p className="font-bold text-sm truncate max-w-[150px] sm:max-w-[250px]">{item.name}</p>
                               <p className="text-[10px] uppercase font-black tracking-widest text-text-muted opacity-60">
                                 {item.questionCount} Qs • {item.subjects.join(', ')}
                               </p>
                            </div>
                          </div>
                          <ChevronRight className="w-4 h-4 text-text-muted group-hover:text-primary transition-colors" />
                       </button>
                     ))}
                   </div>
                </div>
              )}

              <div className="w-full space-y-8">
                <div className="space-y-4">
                  <p className="text-xs font-bold uppercase tracking-widest text-text-muted text-center">Select Exam Subjects (Multi-select)</p>
                  <div className="flex flex-wrap justify-center gap-2 md:gap-3">
                    {subjects.map((sub) => (
                      <button
                        key={sub.name}
                        onClick={() => toggleSubject(sub.name)}
                        className={cn(
                          "tab md:px-8 md:py-3",
                          selectedSubjects.includes(sub.name) && "tab-active"
                        )}
                      >
                        <sub.icon className="inline w-4 h-4 mr-2 mb-0.5" />
                        {sub.name}
                      </button>
                    ))}
                  </div>
                </div>

                <div 
                  {...getRootProps()} 
                  className={cn(
                    "border-2 border-dashed border-border bg-surface rounded-[40px] p-10 md:p-20 text-center transition-all cursor-pointer shadow-2xl relative overflow-hidden group",
                    isDragActive ? "border-primary bg-primary/5" : "hover:border-primary/50"
                  )}
                >
                  <input {...getInputProps()} />
                  <div className="relative z-10">
                    <div className="w-16 h-16 md:w-20 md:h-20 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
                      <FileUp className="w-8 h-8 md:w-10 md:h-10 text-primary" />
                    </div>
                    <h3 className="text-xl md:text-2xl font-bold mb-2">Drop local NEET PDF here</h3>
                    <p className="text-text-muted font-medium">Auto-detects questions and diagrams</p>
                  </div>
                  {error && (
                    <div className="mt-8 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-red-400 justify-center">
                      <AlertCircle className="w-5 h-5 flex-shrink-0" />
                      <p className="text-sm font-bold">{error}</p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {view === 'library' && (
            <motion.div
              key="library"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="flex-1 max-w-5xl mx-auto px-4 py-12 md:py-20 w-full space-y-10"
            >
               <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
                  <div className="space-y-2">
                    <button onClick={() => setView('landing')} className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-text-muted hover:text-primary mb-4 transition-colors">
                       <ChevronLeft className="w-4 h-4" /> Back to Home
                    </button>
                    <h2 className="text-4xl md:text-6xl font-black italic font-serif uppercase tracking-tight">Scan Library</h2>
                    <p className="text-text-muted font-bold tracking-widest uppercase text-[10px]">Your persistent vault of practice sets</p>
                  </div>
                  <div className="bg-primary/10 border border-primary/20 px-6 py-3 rounded-2xl">
                     <p className="text-primary font-black text-2xl leading-none">{history.length}</p>
                     <p className="text-[10px] font-black uppercase tracking-widest opacity-60">Total Sets</p>
                  </div>
               </div>

               <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                 {/* Cloud Exams Section */}
                 {cloudHistory.length > 0 && (
                    <div className="col-span-full space-y-4 mb-8">
                       <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-primary">
                         <LayoutDashboard className="w-4 h-4" /> Cloud Sync Vault
                       </div>
                       <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                          {cloudHistory.map(item => (
                            <div key={item.id} className="bg-primary/5 border border-primary/20 p-6 rounded-3xl flex flex-col justify-between hover:bg-primary/10 transition-colors group">
                               <div className="space-y-4">
                                  <div className="flex items-start justify-between">
                                     <div className="w-12 h-12 bg-primary/20 rounded-2xl flex items-center justify-center text-primary">
                                       <Activity className="w-6 h-6" />
                                     </div>
                                     <button 
                                       onClick={() => deleteCloudExam(user!.uid, item.id).then(() => getCloudExams(user!.uid).then(setCloudHistory))} 
                                       className="p-2 text-text-muted hover:text-red-500 transition-colors"
                                     >
                                       <Trash2 className="w-4 h-4" />
                                     </button>
                                  </div>
                                  <div>
                                     <h4 className="font-bold text-lg line-clamp-1">{item.name}</h4>
                                     <p className="text-[10px] uppercase font-black tracking-widest text-text-muted opacity-60">
                                       {item.questionCount} Questions • Cloud Sync
                                     </p>
                                  </div>
                               </div>
                               <button 
                                 onClick={() => { setQuestions(item.questions); setView('ready'); }}
                                 className="btn w-full mt-8 bg-primary text-white border-primary shadow-lg shadow-primary/10 group-hover:shadow-primary/20"
                               >
                                  Launch Practice
                               </button>
                            </div>
                          ))}
                       </div>
                    </div>
                 )}

                 <div className="col-span-full mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-text-muted">
                   <Library className="w-4 h-4" /> Local Device Scans
                 </div>

                 {history.length > 0 ? history.map((item) => (
                   <motion.div 
                     layout
                     key={item.id} 
                     className="bg-surface border border-border p-6 rounded-3xl hover:border-primary/50 transition-all group flex flex-col justify-between"
                   >
                      <div className="space-y-4">
                        <div className="flex items-start justify-between">
                           <div className="w-12 h-12 bg-primary/10 rounded-2xl flex items-center justify-center text-primary">
                             <Layers className="w-6 h-6" />
                           </div>
                           <button 
                             onClick={(e) => removeExam(e, item.id)}
                             className="p-2 text-text-muted hover:text-red-500 transition-colors"
                           >
                             <Trash2 className="w-4 h-4" />
                           </button>
                        </div>
                        <div>
                           <h4 className="font-bold text-lg line-clamp-1">{item.name}</h4>
                           <div className="flex items-center gap-2 text-[9px] font-black uppercase tracking-[0.15em] text-text-muted mt-1">
                              <Calendar className="w-3 h-3" />
                              {new Date(item.date).toLocaleDateString()}
                           </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                           {item.subjects.map(s => (
                             <span key={s} className="px-2 py-0.5 bg-bg border border-border rounded text-[8px] font-black uppercase tracking-tight">{s}</span>
                           ))}
                        </div>
                      </div>
                      
                      <button 
                        onClick={() => loadFromLibrary(item.id)}
                        className="btn w-full mt-8 bg-bg hover:bg-primary hover:text-white border-border hover:border-primary group-hover:shadow-lg group-hover:shadow-primary/20"
                      >
                         Load Questions ({item.questionCount})
                      </button>
                   </motion.div>
                 )) : (
                   <div className="col-span-full py-20 bg-surface/30 border-2 border-dashed border-border rounded-[40px] flex flex-col items-center justify-center space-y-4">
                      <History className="w-12 h-12 text-border" />
                      <p className="font-black italic uppercase tracking-widest text-text-muted">No saved exams yet</p>
                      <button onClick={() => setView('landing')} className="text-primary font-black uppercase text-[10px] hover:underline">Scan your first PDF</button>
                   </div>
                 )}
               </div>
            </motion.div>
          )}

          {view === 'processing' && (
            <motion.div
              key="processing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex-1 flex flex-col items-center justify-center py-24 space-y-10 px-6 overflow-hidden"
            >
              <div className="relative">
                <div className="w-32 h-32 border-4 border-border rounded-full" />
                <motion.div 
                  className="absolute inset-0 w-32 h-32 border-4 border-primary rounded-full border-t-transparent"
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center text-primary font-bold font-mono">
                  {Math.round((bytesScanned / fileSize) * 100)}%
                </div>
              </div>

              <div className="text-center space-y-2">
                <h3 className="text-2xl font-black tracking-tight uppercase">Scanning Exam Data</h3>
                <div className="flex flex-col items-center gap-1 font-mono text-xs text-text-muted tracking-widest uppercase">
                  <span>Size: {(fileSize / 1024 / 1024).toFixed(2)} MB</span>
                  <span className="text-primary font-bold mt-2">
                    {bytesScanned === fileSize ? "Finalizing Extraction..." : `Est. Time Remaining: ${Math.max(5, Math.ceil(45 * (1 - bytesScanned / fileSize)))}s`}
                  </span>
                </div>
              </div>

              <div className="max-w-md w-full space-y-4">
                <div className="w-full h-2 bg-border rounded-full overflow-hidden">
                  <motion.div 
                    className="h-full bg-primary"
                    animate={{ width: `${(bytesScanned / fileSize) * 100}%` }}
                  />
                </div>
                <div className="space-y-1 text-center">
                  <p className="text-[10px] text-text-muted uppercase tracking-[0.3em] font-bold">Deep Subject Parsing: {selectedSubjects.join(' + ')}</p>
                  <p className="text-[9px] text-primary/60 italic uppercase tracking-widest leading-relaxed px-10">
                    Targeting 180 total questions across all sections. We are extracting each subject in parallel for maximum density and speed.
                  </p>
                </div>
              </div>
            </motion.div>
          )}

          {view === 'ready' && (
            <motion.div
              key="ready"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex-1 flex flex-col items-center justify-center py-24 space-y-12 px-6"
            >
              <div className="relative">
                <div className="w-40 h-40 bg-success/10 rounded-full flex items-center justify-center border-4 border-success/20">
                  <CheckCircle2 className="w-20 h-20 text-success" />
                </div>
                <motion.div 
                  className="absolute -top-2 -right-2 bg-primary text-white text-[10px] font-black px-2 py-1 rounded-full shadow-lg"
                  animate={{ y: [0, -5, 0] }}
                  transition={{ repeat: Infinity, duration: 2 }}
                >
                  SCAN COMPLETE
                </motion.div>
              </div>

              <div className="text-center space-y-4 max-w-lg">
                <h3 className="text-4xl font-black tracking-tighter italic font-serif">Deep Extraction Successful</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-surface border border-border rounded-2xl">
                    <p className="text-2xl font-black text-primary">{questions.length}</p>
                    <p className="text-[10px] font-bold uppercase tracking-widest opacity-40">Questions Found</p>
                  </div>
                  <div className="p-4 bg-surface border border-border rounded-2xl">
                    <p className="text-2xl font-black text-success">{selectedSubjects.length}</p>
                    <p className="text-[10px] font-bold uppercase tracking-widest opacity-40">Subjects Parsed</p>
                  </div>
                </div>
                <p className="text-text-muted font-medium pt-4">Your personalized exam environment is pre-loaded and secure. Proceed when ready.</p>
              </div>

              <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
                <button 
                  onClick={() => { setView('exam'); setLastSwitchTime(Date.now()); }}
                  className="btn btn-primary flex-1 py-5 rounded-2xl text-xl font-black uppercase tracking-[0.2em] transform hover:scale-105 active:scale-95"
                >
                  Start Exam Now
                </button>
                <button onClick={reset} className="btn py-5 rounded-2xl font-bold uppercase tracking-widest bg-surface/50">Discard</button>
              </div>
            </motion.div>
          )}

          {view === 'exam' && questions.length > 0 && (
            <motion.div
              key="exam"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex-1 flex flex-col h-full bg-bg relative overflow-hidden"
            >
              {isPaused && (
                <div className="absolute inset-0 z-50 bg-bg/95 backdrop-blur-md flex flex-col items-center justify-center space-y-6">
                  <div className="w-20 h-20 bg-warning/10 rounded-full flex items-center justify-center">
                    <Clock className="w-10 h-10 text-warning animate-pulse" />
                  </div>
                  <h2 className="text-3xl font-black italic font-serif">Exam Paused</h2>
                  <p className="text-text-muted font-bold text-center max-w-xs">Your progress is safe. Take a breath and resume whenever you're ready.</p>
                  <button 
                    onClick={() => setIsPaused(false)}
                    className="btn btn-primary px-12 py-3 rounded-xl text-lg font-black uppercase tracking-widest"
                  >
                    Resume Test
                  </button>
                </div>
              )}
              <div className="flex flex-1 overflow-hidden relative">
                {/* Mobile Drawer Overlay */}
                <AnimatePresence>
                  {isQuestionMapOpen && (
                    <motion.div 
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      onClick={() => setIsQuestionMapOpen(false)}
                      className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
                    />
                  )}
                </AnimatePresence>

                {/* Question Map - Side (Desktop) & Drawer (Mobile) */}
                <aside className={cn(
                  "bg-surface border-r border-border p-6 flex flex-col overflow-y-auto shrink-0 transition-transform duration-300 z-50",
                  "fixed inset-y-0 left-0 w-[280px] lg:relative lg:translate-x-0 lg:w-[300px]",
                  isQuestionMapOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
                )}>
                  <div className="text-[10px] font-black uppercase tracking-[0.2em] text-text-muted mb-6 flex justify-between items-center">
                    <span>Question Map</span>
                    <button onClick={() => setIsQuestionMapOpen(false)} className="lg:hidden p-1 text-primary">
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    <span className="hidden lg:inline text-primary">{questions.length} Items</span>
                  </div>
                  
                  <div className="grid grid-cols-5 gap-2">
                    {questions.map((q, idx) => (
                      <button
                        key={idx}
                        onClick={() => { setCurrentQuestionIndex(idx); setIsQuestionMapOpen(false); }}
                        className={cn(
                          "aspect-square flex flex-col items-center justify-center text-xs rounded-lg border-2 transition-all p-1 relative",
                          idx === currentQuestionIndex ? "border-primary bg-primary/10 font-black" : "border-border",
                          userAnswers[idx] !== undefined ? "bg-success border-success text-white" : "bg-surface",
                          markedForReview.has(idx) && userAnswers[idx] === undefined ? "border-warning ring-1 ring-warning" : "",
                          markedForReview.has(idx) && userAnswers[idx] !== undefined ? "ring-2 ring-warning ring-offset-2 ring-offset-surface" : ""
                        )}
                      >
                        <span className="leading-none mb-1">{idx + 1}</span>
                        <div className="flex gap-0.5">
                          {q.hasDiagram && <div className="w-1 h-1 rounded-full bg-warning" />}
                          {markedForReview.has(idx) && <div className="w-1 h-1 rounded-full bg-blue-400" />}
                        </div>
                      </button>
                    ))}
                  </div>
                  
                  <div className="mt-auto pt-8 space-y-3">
                    <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                      <span className="w-2.5 h-2.5 rounded bg-success" />
                      Answered
                    </div>
                    <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                      <span className="w-2.5 h-2.5 rounded border-2 border-warning" />
                      Marked for Review
                    </div>
                    <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                      <span className="w-2.5 h-2.5 rounded bg-warning" />
                      Diagram Included
                    </div>
                  </div>
                </aside>

                {/* Main Content */}
                <div className="flex-1 flex flex-col overflow-y-auto px-4 py-6 md:px-10">
                  <div className="max-w-4xl w-full mx-auto flex flex-col h-full">
                    
                    {/* Subject Switcher Toolbar */}
                    <div className="flex items-center gap-2 overflow-x-auto pb-4 no-scrollbar shrink-0 border-b border-border/50 mb-6">
                      <button 
                        onClick={() => setIsQuestionMapOpen(true)}
                        className="lg:hidden p-2 rounded-lg bg-surface border border-border text-primary shrink-0"
                      >
                         <LayoutDashboard className="w-5 h-5" />
                      </button>
                      <div className="w-px h-6 bg-border mx-1 lg:hidden shrink-0" />
                      {uniqueSubjectsInExam.map(subj => (
                        <button
                          key={subj}
                          onClick={() => jumpToSubject(subj)}
                          className={cn(
                            "px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest transition-all shrink-0 border whitespace-nowrap",
                            questions[currentQuestionIndex].subject === subj
                              ? "bg-primary text-white border-primary shadow-lg shadow-primary/20 scale-105"
                              : "bg-surface text-text-muted border-border hover:border-primary/50"
                          )}
                        >
                          {subj}
                        </button>
                      ))}
                    </div>

                    <div className="card-minimal flex-1 p-5 md:p-10 flex flex-col mb-24 lg:mb-0">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-6 mb-8 border-b border-border gap-4">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                             <span className="bg-primary/20 text-primary px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest">{questions[currentQuestionIndex].subject}</span>
                             <span className="text-text-muted text-[10px] font-bold uppercase tracking-widest">Page {questions[currentQuestionIndex].pageNumber}</span>
                          </div>
                          <div className="text-xl md:text-2xl font-black italic font-serif">Question #{currentQuestionIndex + 1}</div>
                        </div>
                        <div className="flex items-center gap-3">
                          <Clock className="w-4 h-4 text-text-muted" />
                          <span className="font-mono text-sm tabular-nums text-text-muted">
                            {formatTime(questionTimes[currentQuestionIndex] || 0)} spent here
                          </span>
                        </div>
                      </div>

                      <div className="text-xl md:text-2xl leading-relaxed mb-12 selection:bg-primary/20 prose prose-invert max-w-none prose-p:mb-6 prose-table:my-8 prose-table:border-2 prose-table:border-primary/50 prose-th:bg-primary/10 prose-th:p-4 prose-td:p-4 prose-td:border prose-td:border-primary/20">
                        <ReactMarkdown 
                          remarkPlugins={[remarkGfm]} 
                          rehypePlugins={[rehypeRaw, rehypeSanitize]}
                        >
                          {questions[currentQuestionIndex].text
                            .replace(/\\n/g, '\n')
                            // Force new lines for labeled statements (A), (B), (C), etc. if missing
                            .replace(/([.!?])\s+(\([A-D]\))/g, '$1\n\n$2')
                            // Ensure Assertion/Reason labels are on new lines
                            .replace(/(Assertion\s*\(A\):|Reason\s*\(R\):)/gi, '\n\n$1')
                            // Fix table rendering
                            .replace(/(\n\|.*\|)\n+(?=\|)/g, '$1\n')
                            .replace(/([^\n])\n(\|.*\|)/g, '$1\n\n$2')
                            // Remove triple+ line breaks
                            .replace(/\n{3,}/g, '\n\n')
                          }
                        </ReactMarkdown>
                      </div>

                      <div className="grid grid-cols-1 gap-4 mt-auto">
                        {questions[currentQuestionIndex].options.map((option, idx) => (
                          <button
                            key={idx}
                            onClick={() => setUserAnswers(prev => ({ ...prev, [currentQuestionIndex]: idx }))}
                            className={cn(
                              "flex items-center gap-6 p-6 rounded-2xl border-2 transition-all text-left group relative overflow-hidden",
                              userAnswers[currentQuestionIndex] === idx
                                ? "border-primary bg-primary/10 shadow-[0_0_20px_rgba(59,130,246,0.1)] translate-x-2"
                                : "border-border hover:border-primary/30 bg-surface/50"
                            )}
                          >
                            <div className={cn(
                              "w-10 h-10 rounded-xl flex items-center justify-center font-black text-sm shrink-0 transition-all",
                              userAnswers[currentQuestionIndex] === idx
                                ? "bg-primary text-white scale-110 rotate-3"
                                : "bg-bg text-text-muted border border-border group-hover:border-primary/50"
                            )}>
                              {String.fromCharCode(65 + idx)}
                            </div>
                            <span className={cn(
                              "text-base md:text-lg font-bold leading-tight",
                              userAnswers[currentQuestionIndex] === idx ? "text-primary" : "text-text-main"
                            )}>{option}</span>
                            {userAnswers[currentQuestionIndex] === idx && (
                              <motion.div 
                                layoutId="active-indicator"
                                className="absolute left-0 top-0 bottom-0 w-1 bg-primary"
                              />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Sticky Footer */}
              <div className="fixed bottom-0 left-0 right-0 lg:relative h-[auto] py-4 lg:h-[80px] bg-surface/95 backdrop-blur-md border-t border-border px-4 md:px-12 flex flex-col lg:flex-row items-center justify-between gap-4 z-30">
                <div className="flex gap-2 w-full lg:w-auto">
                  <button 
                    onClick={handlePrev} 
                    disabled={currentQuestionIndex === 0}
                    className="btn flex-1 lg:flex-none justify-center"
                  >
                    <ChevronLeft className="w-5 h-5 mr-1" />
                    <span className="lg:hidden">Prev</span>
                  </button>
                  <button className="btn hidden sm:block" onClick={() => setUserAnswers(prev => {
                    const newState = { ...prev };
                    delete newState[currentQuestionIndex];
                    return newState;
                  })}>Clear</button>
                  <button 
                    onClick={() => toggleMarkForReview(currentQuestionIndex)}
                    className={cn(
                      "btn flex-1 lg:flex-none justify-center",
                      markedForReview.has(currentQuestionIndex) ? "bg-warning/20 border-warning text-warning" : ""
                    )}
                  >
                    <span className="hidden sm:inline">Mark for Review</span>
                    <span className="sm:hidden">Mark</span>
                  </button>
                </div>
                
                <div className="flex gap-2 w-full lg:w-auto items-center">
                  <div className="hidden lg:flex flex-col items-end mr-4 opacity-50 text-[10px] font-black uppercase tracking-widest leading-none">
                    <span>NEET</span>
                    <span>Pro</span>
                  </div>
                  <button
                    onClick={handleNext}
                    className="btn btn-primary flex-1 lg:flex-none px-8 py-3 lg:py-2 flex items-center justify-center gap-2 text-lg lg:text-sm"
                  >
                    {currentQuestionIndex === questions.length - 1 ? "Submit Exam" : "Save & Next"}
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {view === 'results' && (
            <motion.div
              key="results"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex-1 max-w-5xl mx-auto px-4 md:px-6 py-12 md:py-20 space-y-16"
            >
              <div className="text-center space-y-8">
                <div className="space-y-2">
                  <h2 className="text-4xl md:text-6xl font-black uppercase tracking-tighter italic font-serif">Submission Report</h2>
                  <p className="text-xs font-black tracking-[0.4em] uppercase text-text-muted">NEET Pattern Simulation Analytics</p>
                </div>

                <div className="grid grid-cols-2 xs:grid-cols-3 lg:grid-cols-5 gap-2 md:gap-3">
                   {[
                     { label: 'Marks', value: calculateNEETScore().total, color: calculateNEETScore().total >= 0 ? 'text-success' : 'text-red-500' },
                     { label: 'Correct', value: calculateNEETScore().correct, color: 'text-success' },
                     { label: 'Wrong', value: calculateNEETScore().wrong, color: 'text-red-500' },
                     { label: 'Skipped', value: calculateNEETScore().skipped, color: 'text-text-muted' },
                     { label: 'Time', value: formatTime(totalSeconds), color: 'text-text-main' }
                   ].map((stat, i) => (
                     <div key={i} className="bg-surface border border-border p-3 md:p-6 rounded-2xl md:rounded-3xl space-y-1">
                        <p className={cn("text-xl md:text-3xl lg:text-4xl font-black font-serif truncate", stat.color)}>{stat.value}</p>
                        <p className="text-[8px] md:text-[10px] font-black uppercase tracking-widest opacity-40 truncate">{stat.label}</p>
                     </div>
                   ))}
                </div>
              </div>

              <div className="space-y-8">
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-bold uppercase tracking-wider italic flex items-center gap-3">
                    <LayoutDashboard className="w-5 h-5 text-primary" />
                    Subject Performance
                  </h3>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {selectedSubjects.map(sub => {
                    const subQs = questions.filter(q => q.subject === sub);
                    const correct = subQs.filter((q) => userAnswers[questions.indexOf(q)] === q.correctAnswer).length;
                    return (
                      <div key={sub} className="bg-surface border border-border p-6 rounded-2xl flex items-center justify-between">
                        <div>
                          <p className="font-black text-lg">{sub}</p>
                          <p className="text-xs font-bold text-text-muted uppercase tracking-widest">{correct} / {subQs.length} Correct</p>
                        </div>
                        <div className="text-right">
                           <p className="text-2xl font-black font-serif text-primary">{Math.round((correct / (subQs.length || 1)) * 100)}%</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-8">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <h3 className="text-xl font-bold uppercase tracking-wider italic">Review & Explanations</h3>
                  
                  {/* Review Subject Filter */}
                  <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar scroll-smooth">
                    {['All', ...uniqueSubjectsInExam].map(subj => (
                      <button
                        key={subj}
                        onClick={() => setReviewSubjectFilter(subj)}
                        className={cn(
                          "px-5 py-2 rounded-full text-[10px] font-black uppercase tracking-widest transition-all border whitespace-nowrap",
                          reviewSubjectFilter === subj
                            ? "bg-primary text-white border-primary shadow-lg shadow-primary/20 scale-105"
                            : "bg-surface text-text-muted border-border hover:border-primary/50"
                        )}
                      >
                        {subj}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-8">
                  {questions
                    .filter(q => reviewSubjectFilter === 'All' || q.subject === reviewSubjectFilter)
                    .map((q) => {
                      const originalIdx = questions.findIndex(origQ => origQ.id === q.id);
                      const isCorrect = userAnswers[originalIdx] === q.correctAnswer;
                      const isSkipped = userAnswers[originalIdx] === undefined;
                      return (
                        <div 
                          key={q.id} 
                          className={cn(
                            "card-minimal p-6 md:p-8 space-y-6 relative overflow-hidden",
                            isCorrect ? "border-success/20 bg-success/5" : isSkipped ? "border-border/40 bg-surface/5" : "border-red-500/20 bg-red-500/5"
                          )}
                        >
                          <div className="flex justify-between items-start">
                            <div className="flex items-center gap-3">
                               <span className={cn(
                                 "w-6 h-6 rounded flex items-center justify-center text-[10px] font-black shrink-0",
                                 isCorrect ? "bg-success text-white" : isSkipped ? "bg-text-muted text-white" : "bg-red-500 text-white"
                               )}>{originalIdx + 1}</span>
                               <span className="text-[10px] uppercase font-black tracking-widest text-text-muted">
                                 {q.subject} • Page {q.pageNumber} • Time: {formatTime(questionTimes[originalIdx] || 0)}
                               </span>
                            </div>
                            <div className="flex gap-2">
                              {markedForReview.has(originalIdx) && <span className="bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest">Marked</span>}
                              {q.hasDiagram && <span className="bg-warning/20 text-warning px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest">Diagram Ref</span>}
                            </div>
                          </div>

                          <div className="text-lg font-bold leading-relaxed prose prose-invert max-w-none prose-p:mb-4 prose-table:my-6 prose-table:border prose-table:border-white/10 prose-td:border prose-td:border-white/10">
                             <ReactMarkdown 
                               remarkPlugins={[remarkGfm]}
                               rehypePlugins={[rehypeRaw, rehypeSanitize]}
                             >
                               {q.text
                                .replace(/\\n/g, '\n')
                                .replace(/([.!?])\s+(\([A-D]\))/g, '$1\n\n$2')
                                .replace(/(Assertion\s*\(A\):|Reason\s*\(R\):)/gi, '\n\n$1')
                                .replace(/(\r\n|\r|\n)(?=\|)/g, '\n\n')
                                .replace(/\n{3,}/g, '\n\n')
                               }
                             </ReactMarkdown>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {q.options.map((opt, optIdx) => (
                               <div 
                                 key={optIdx} 
                                 className={cn(
                                   "p-4 rounded-xl border text-sm flex items-center gap-3",
                                   optIdx === q.correctAnswer ? "border-success bg-success/20 font-bold" :
                                   userAnswers[originalIdx] === optIdx ? "border-red-500 bg-red-500/20" : "border-border bg-surface opacity-60"
                                 )}
                               >
                                 <span className="w-5 h-5 flex-shrink-0 rounded-full border border-current font-black text-[9px] flex items-center justify-center">
                                   {String.fromCharCode(65 + optIdx)}
                                 </span>
                                 {opt}
                               </div>
                            ))}
                          </div>

                          <div className="p-5 bg-surface rounded-xl border border-border shadow-inner">
                             <p className="text-[10px] font-black uppercase tracking-widest text-primary mb-2">Technical Insight:</p>
                             <p className="text-sm italic font-medium leading-relaxed text-text-muted">{q.explanation}</p>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>

              <div className="flex flex-col items-center gap-4 pt-12">
                <button
                  onClick={reset}
                  className="btn btn-primary px-12 py-4 rounded-2xl text-lg font-black uppercase tracking-[0.2em]"
                >
                  New Exam Session
                </button>
                <p className="text-[10px] text-text-muted uppercase font-bold tracking-widest">Analytics preserved for this session only</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Manual Import Modal */}
      <AnimatePresence>
        {isImportModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-surface border border-border w-full max-w-2xl rounded-[32px] overflow-hidden flex flex-col h-[80vh]"
            >
              <div className="p-6 border-b border-border flex items-center justify-between">
                <div>
                  <h3 className="text-xl font-bold uppercase tracking-tight">Manual Question Import</h3>
                  <p className="text-[10px] font-black uppercase tracking-widest text-text-muted">Bypass scanner for custom JSON or Text</p>
                </div>
                <button onClick={() => setIsImportModalOpen(false)} className="btn p-2 rounded-full"><Trash2 className="w-4 h-4" /></button>
              </div>
              <div className="flex-1 p-6 space-y-4">
                <p className="text-xs text-text-muted">Paste your questions in JSON format. Use the NEET Scan schema (text, options[], correctAnswer, explanation, etc.)</p>
                <textarea 
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  className="w-full h-full bg-bg border border-border rounded-2xl p-4 font-mono text-xs focus:ring-2 focus:ring-primary outline-none resize-none"
                  placeholder='[ { "text": "What is Mitochondria?", "options": ["Powerhouse", "Kitchen", "Storage", "Guard"], "correctAnswer": 0, "explanation": "ATP generation" } ]'
                />
              </div>
              <div className="p-6 border-t border-border flex gap-3">
                <button onClick={() => setIsImportModalOpen(false)} className="btn flex-1">Cancel</button>
                <button 
                  onClick={handleManualImport}
                  className="btn btn-primary flex-1"
                >
                  Import & Validate
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
