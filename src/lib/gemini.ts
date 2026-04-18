import { GoogleGenAI, Type, ThinkingLevel, HarmCategory, HarmBlockThreshold } from "@google/genai";

const getAI = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing. Please set it in your environment variables.");
  }
  return new GoogleGenAI({ apiKey });
};

export interface Question {
  id: string;
  text: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
  subject: string;
  pageNumber: number;
  originalQuestionNumber: number;
  hasDiagram: boolean;
}

export async function processPDF(file: File, subjects: string[]): Promise<Question[]> {
  const base64Data = await fileToBase64(file);
  
  // Parallel processing for each subject to stay within context limits 
  // and improve extraction speed.
  const extractionTasks = subjects.map(async (subject) => {
    const prompt = `
      Objective: You are a professional medical entrance exam (NEET) digitizer.
      Task: Scan the PROVIDED PDF and extract EVERY Multiple Choice Question (MCQ) for the subject: "${subject}".
      
      CRITICAL INSTRUCTIONS:
      1. SUBJECT MAPPING: Look for "${subject}" sections. Also scan "Biology" for Botany/Zoology. NEET papers often split Biology into these two.
      2. QUESTION IDENTIFICATION: Questions are typically numbered (1, 2, 3...) or have labels like Q1, Q2. Find ALL of them.
      3. COMPLEX PATTERNS:
         - Statement Questions: If a question says "Statement I: ... Statement II: ...", include BOTH statements in the 'text' field using clear line breaks.
         - Assertion-Reason: If it says "Assertion (A): ... Reason (R): ...", label them clearly in the 'text' field.
         - List Matching: If it involves List I and List II, represent the lists as a Markdown table in the 'text' field.
      4. OPTIONS: Extract exactly 4 options. They are usually (1), (2), (3), (4) or (A), (B), (C), (D).
      5. CORRECT ANSWER: Identify the correct option index (0 to 3). Use your medical/subject expertise if the answer key isn't explicitly clear.
      6. EXPLANATION: Provide a concise, high-quality technical explanation for the correct answer based on NEET-level concepts.
      7. DIAGRAMS: If the question refers to a diagram or figure, set 'hasDiagram' to true.
      8. LANGUAGE: ALL output must be in ENGLISH. Translate if necessary.
      
      VOLUME EXPECTATION: NEET subjects typically have 45-50 questions each. Scan the WHOLE document.
      OUTPUT: Return a JSON array of objects.
    `;

    try {
      const response = await getAI().models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  data: base64Data,
                  mimeType: "application/pdf"
                }
              }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          temperature: 0.1,
          topP: 0.95,
          // Removed ThinkingLevel.LOW to allow default (HIGH) reasoning for complex extraction
          safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_NONE }
          ],
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                text: { type: Type.STRING },
                options: { 
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                },
                correctAnswer: { type: Type.INTEGER },
                explanation: { type: Type.STRING },
                subject: { type: Type.STRING },
                pageNumber: { type: Type.INTEGER },
                originalQuestionNumber: { type: Type.INTEGER },
                hasDiagram: { type: Type.BOOLEAN }
              },
              required: ["text", "options", "correctAnswer", "explanation", "subject", "pageNumber", "originalQuestionNumber", "hasDiagram"]
            }
          }
        }
      });

      if (!response.text) {
        console.warn(`Empty response for subject: ${subject}`);
        return [];
      }
      
      const parsed = JSON.parse(response.text);
      console.log(`Success: Extracted ${parsed.length} questions for ${subject}`);
      return parsed;
    } catch (err: any) {
      console.error(`Error extracting ${subject}:`, err);
      // Return empty array instead of failing the whole process
      return [];
    }
  });

  const results = await Promise.all(extractionTasks);
  const allQuestions = results.flat();

  if (allQuestions.length === 0) {
    throw new Error('No questions found. The PDF might be unsupported, the subject names might not match, or the model safety filters blocked the content.');
  }

  // Sort by page number and original question number to maintain exam order
  return allQuestions
    .sort((a, b) => (a.pageNumber - b.pageNumber) || (a.originalQuestionNumber - b.originalQuestionNumber))
    .map((q: any, index: number) => ({
      ...q,
      id: `q-${index}`
    }));
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.onerror = error => reject(error);
  });
}
