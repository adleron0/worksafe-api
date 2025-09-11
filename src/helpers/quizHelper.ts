export interface QuizOption {
  text: string;
  isCorrect?: boolean;
}

export interface QuizQuestion {
  id: string;
  question: string;
  type: 'multiple_choice' | 'single_choice' | 'true_false';
  options: string[] | QuizOption[];
  correctAnswer?: number;
  explanation?: string;
}

export interface QuizContent {
  description: string;
  questions: QuizQuestion[];
  passingScore: number;
  maxAttempts?: number;
}

export interface QuizResponse {
  questionId?: string;
  questionIndex?: number;
  selectedOptions: number[];
}

export interface QuizResult {
  score: number;
  maxScore: number;
  percentage: number;
  passed: boolean;
  questions: QuizQuestionResult[];
  attempts?: number;
  submittedAt: string;
}

export interface QuizQuestionResult {
  id: string;
  questionIndex: number;
  question: string;
  type: string;
  options: string[];
  selectedOptions: number[];
  correctAnswer: number;
  isCorrect: boolean;
  explanation?: string;
}

/**
 * Remove as respostas corretas e explicações do quiz antes de enviar ao frontend
 */
export function sanitizeQuizContent(content: any): any {
  if (!content) return null;

  // Parse se for string
  let quizData = content;
  if (typeof content === 'string') {
    try {
      quizData = JSON.parse(content);
    } catch (e) {
      return null;
    }
  }

  return {
    description: quizData.description,
    questions: quizData.questions.map((q: QuizQuestion) => ({
      id: q.id,
      question: q.question,
      type: q.type,
      options: Array.isArray(q.options) ? q.options : [],
      // REMOVIDOS: correctAnswer, explanation
    })),
    passingScore: quizData.passingScore || 70,
    maxAttempts: quizData.maxAttempts || 3,
  };
}

/**
 * Valida as respostas do quiz e calcula a pontuação
 */
export function validateQuizResponses(
  responses: QuizResponse[],
  originalContent: any,
): QuizResult {
  // Parse do conteúdo original se necessário
  let quizData = originalContent;
  if (typeof originalContent === 'string') {
    try {
      quizData = JSON.parse(originalContent);
    } catch (e) {
      return {
        score: 0,
        maxScore: 0,
        percentage: 0,
        passed: false,
        questions: [],
        submittedAt: new Date().toISOString(),
      };
    }
  }

  const questions = quizData.questions || [];
  const passingScore = quizData.passingScore || 70;
  let correctCount = 0;
  const totalQuestions = questions.length;

  // Processar cada questão
  const questionResults: QuizQuestionResult[] = questions.map(
    (question: QuizQuestion, index: number) => {
      // Encontrar a resposta do usuário
      let userResponse = responses.find((r) => r.questionId === question.id);

      // Se não encontrou por ID, tentar por índice
      if (!userResponse && responses[index]) {
        userResponse = responses[index];
      }

      // Verificar se a resposta está correta
      const isCorrect =
        userResponse?.selectedOptions?.[0] === question.correctAnswer;

      if (isCorrect) {
        correctCount++;
      }

      return {
        id: question.id,
        questionIndex: index,
        question: question.question,
        type: question.type,
        options: Array.isArray(question.options) ? question.options : [],
        selectedOptions: userResponse?.selectedOptions || [],
        correctAnswer: question.correctAnswer,
        isCorrect: isCorrect,
        explanation: question.explanation, // Agora incluímos a explicação no resultado
      };
    },
  );

  const percentage =
    totalQuestions > 0 ? (correctCount / totalQuestions) * 100 : 0;
  const passed = percentage >= passingScore;

  return {
    score: correctCount,
    maxScore: totalQuestions,
    percentage: Math.round(percentage),
    passed: passed,
    questions: questionResults,
    submittedAt: new Date().toISOString(),
  };
}

/**
 * Prepara os dados de progresso para salvar no banco
 * Inclui as respostas do usuário e o resultado da validação
 */
export function prepareQuizProgressData(
  responses: QuizResponse[],
  result: QuizResult,
  timeSpent: number,
  previousAttempts?: number,
): any {
  return {
    responses: responses,
    timeSpent: timeSpent,
    score: result.score,
    maxScore: result.maxScore,
    percentage: result.percentage,
    passed: result.passed,
    attempts: (previousAttempts || 0) + 1,
    submittedAt: result.submittedAt,
    // Incluir detalhes das questões para histórico
    questionResults: result.questions.map((q) => ({
      questionId: q.id,
      questionIndex: q.questionIndex,
      isCorrect: q.isCorrect,
      selectedOptions: q.selectedOptions,
      correctAnswer: q.correctAnswer,
    })),
  };
}

/**
 * Formata o resultado do quiz para enviar ao frontend após completar
 * Inclui as explicações e respostas corretas
 */
export function formatQuizResultForFrontend(result: QuizResult): any {
  return {
    passed: result.passed,
    score: result.score,
    maxScore: result.maxScore,
    percentage: result.percentage,
    questions: result.questions.map((q) => ({
      question: q.question,
      options: q.options,
      selectedOption: q.selectedOptions[0],
      correctAnswer: q.correctAnswer,
      isCorrect: q.isCorrect,
      explanation: q.explanation,
    })),
  };
}
