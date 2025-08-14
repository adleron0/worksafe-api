export interface ExamOption {
  text: string;
  isCorrect?: boolean;
  isSelected?: boolean;
  isUserCorrect?: boolean;
}

export interface ExamQuestion {
  question: string;
  options: ExamOption[];
}

export interface ExamResult {
  questions: ExamQuestion[];
  nota: number;
  passed: boolean;
  correctAnswers: number;
  totalQuestions: number;
}

/**
 * Remove as respostas corretas do exame para enviar ao aluno
 */
export function removeCorrectAnswers(examJson: any): any[] {
  if (!examJson) {
    return [];
  }
  
  // Se não for array, tenta verificar se é string JSON
  let examData = examJson;
  if (!Array.isArray(examJson)) {
    // Se for string, tenta fazer parse
    if (typeof examJson === 'string') {
      try {
        examData = JSON.parse(examJson);
      } catch (e) {
        return [];
      }
    }
    
    // Verifica novamente se agora é array
    if (!Array.isArray(examData)) {
      return [];
    }
  }

  const result = examData.map(question => ({
    question: question.question,
    options: question.options ? question.options.map(option => ({
      text: option.text,
      // Remove completamente o campo isCorrect
    })) : [],
  }));
  
  return result;
}

/**
 * Corrige o exame do aluno comparando com o gabarito
 * Retorna o exame corrigido com nota de 0 a 10
 */
export function correctExam(
  originalExam: any,
  studentResponse: any,
  passingGrade: number = 7,
): ExamResult {
  console.log('correctExam - originalExam:', originalExam);
  console.log('correctExam - studentResponse:', studentResponse);
  
  // Se originalExam for string, fazer parse
  let examData = originalExam;
  if (typeof originalExam === 'string') {
    try {
      examData = JSON.parse(originalExam);
      console.log('Parsed original exam');
    } catch (e) {
      console.log('Failed to parse original exam:', e);
      return {
        questions: [],
        nota: 0,
        passed: false,
        correctAnswers: 0,
        totalQuestions: 0,
      };
    }
  }
  
  if (!examData || !Array.isArray(examData)) {
    console.log('Original exam is invalid after parsing');
    return {
      questions: [],
      nota: 0,
      passed: false,
      correctAnswers: 0,
      totalQuestions: 0,
    };
  }

  // Extrair as respostas do formato enviado pelo aluno
  let studentData = studentResponse;
  
  // Se studentResponse for string JSON, fazer parse
  if (typeof studentResponse === 'string') {
    try {
      studentData = JSON.parse(studentResponse);
      console.log('Parsed student response');
    } catch (e) {
      console.log('Failed to parse student response:', e);
      return {
        questions: [],
        nota: 0,
        passed: false,
        correctAnswers: 0,
        totalQuestions: 0,
      };
    }
  }
  
  const studentAnswers = studentData?.answers || studentData;
  
  if (!studentAnswers || !Array.isArray(studentAnswers)) {
    console.log('Student answers is invalid - not an array');
    console.log('Student data type:', typeof studentData);
    console.log('Student data:', studentData);
    return {
      questions: [],
      nota: 0,
      passed: false,
      correctAnswers: 0,
      totalQuestions: 0,
    };
  }

  const totalQuestions = examData.length;
  let correctAnswers = 0;

  const correctedExam = examData.map((originalQuestion, questionIndex) => {
    // Encontrar a resposta do aluno para esta questão
    const studentAnswer = studentAnswers.find(ans => ans.questionIndex === questionIndex);
    
    let questionCorrect = false;
    
    const correctedOptions = originalQuestion.options.map((originalOption, optionIndex) => {
      // Verificar se esta opção foi selecionada pelo aluno
      const isSelected = studentAnswer && studentAnswer.selectedOption === optionIndex;
      
      // Verificar se a resposta está correta
      if (isSelected && originalOption.isCorrect === true) {
        questionCorrect = true;
      }
      
      return {
        text: originalOption.text,
        isCorrect: originalOption.isCorrect,
        isSelected: isSelected,
        isUserCorrect: isSelected && originalOption.isCorrect === true,
      };
    });

    if (questionCorrect) {
      correctAnswers++;
      console.log(`Question ${questionIndex} is correct!`);
    }

    return {
      question: originalQuestion.question,
      options: correctedOptions,
    };
  });

  const nota = totalQuestions > 0 ? (correctAnswers / totalQuestions) * 10 : 0;
  const passed = nota >= passingGrade;

  console.log('Exam correction result:', {
    correctAnswers,
    totalQuestions,
    nota,
    passed
  });

  return {
    questions: correctedExam,
    nota: Number(nota.toFixed(2)),
    passed,
    correctAnswers,
    totalQuestions,
  };
}