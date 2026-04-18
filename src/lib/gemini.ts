import { GoogleGenAI, Type, ThinkingLevel, HarmCategory, HarmBlockThreshold } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
      Instructions:
      1. Scan the ENTIRE provided PDF document very carefully. This is a NEET practice paper.
      2. Extract EVERY SINGLE MCQ (Multiple Choice Question) related to the subject: "${subject}".
      3. Important: Some subjects might be grouped under broader headings like "Biology" (covering Botany/Zoology) or "Science". Search for these too.
      4. The output MUST be in English only. If the original text is bilingual, translate only the question and options to English.
      
      5. FORMATTING & STRUCTURE:
         - Support Assertion-Reason questions with bold labels.
         - Support List Matching questions with Markdown tables.
         - Ensure clean line breaks (\\n) for mathematical equations.
      
      6. IMAGE & DIAGRAM DETECTION: 
         - If a question refers to a diagram, graph, or circuit, set 'hasDiagram' to true.
         - Add a reference in the text: "(See figure/image in question [N] on page [P])".
      
      7. EXHAUSTIVE EXTRACTION GOAL:
         - For this specific subject (${subject}), I expect approximately 45-50 questions. 
         - DO NOT STOP until you have scanned the last page.
         - If no questions are found for this specific subject string, look for section headers that might contain it (e.g., "Part A: Botany").
      
      8. JSON OUTPUT: Return a JSON array of question objects.
    `;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
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
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
          },
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
