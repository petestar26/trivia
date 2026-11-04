/** Server-only practice content. These IDs are never normal reward-game IDs. */
export const BUILTIN_PRACTICE_PREFIX = 'builtin-practice-';
export const BUILTIN_PRACTICE_QUESTIONS = [
  {
    id: 'builtin-practice-001',
    question: 'What is 2 + 2?',
    choices: ['3', '4', '5', '6'],
    correctIndex: 1,
    category: 'math',
    difficulty: 1,
  },
  {
    id: 'builtin-practice-002',
    question: 'How many days are in one week?',
    choices: ['5', '6', '7', '8'],
    correctIndex: 2,
    category: 'general',
    difficulty: 1,
  },
  {
    id: 'builtin-practice-003',
    question: 'Which shape has three sides?',
    choices: ['Circle', 'Square', 'Triangle', 'Hexagon'],
    correctIndex: 2,
    category: 'general',
    difficulty: 1,
  },
  {
    id: 'builtin-practice-004',
    question: 'How many minutes are in one hour?',
    choices: ['30', '45', '60', '90'],
    correctIndex: 2,
    category: 'general',
    difficulty: 1,
  },
  {
    id: 'builtin-practice-005',
    question: 'What is 10 multiplied by 5?',
    choices: ['15', '25', '50', '100'],
    correctIndex: 2,
    category: 'math',
    difficulty: 1,
  },
  {
    id: 'builtin-practice-006',
    question: 'Which word is the opposite of hot?',
    choices: ['Warm', 'Cold', 'Bright', 'Fast'],
    correctIndex: 1,
    category: 'general',
    difficulty: 1,
  },
  {
    id: 'builtin-practice-007',
    question: 'Which letter comes immediately after A in the English alphabet?',
    choices: ['B', 'C', 'D', 'E'],
    correctIndex: 0,
    category: 'general',
    difficulty: 1,
  },
  {
    id: 'builtin-practice-008',
    question: 'What is half of 20?',
    choices: ['5', '10', '15', '40'],
    correctIndex: 1,
    category: 'math',
    difficulty: 1,
  },
  {
    id: 'builtin-practice-009',
    question: 'How many centimetres are in one metre?',
    choices: ['10', '50', '100', '1000'],
    correctIndex: 2,
    category: 'math',
    difficulty: 1,
  },
  {
    id: 'builtin-practice-010',
    question: 'How many sides does a hexagon have?',
    choices: ['4', '5', '6', '8'],
    correctIndex: 2,
    category: 'math',
    difficulty: 1,
  },
  {
    id: 'builtin-practice-011',
    question: 'What is the smallest prime number?',
    choices: ['0', '1', '2', '3'],
    correctIndex: 2,
    category: 'math',
    difficulty: 1,
  },
  {
    id: 'builtin-practice-012',
    question: 'What is 3 squared?',
    choices: ['6', '8', '9', '12'],
    correctIndex: 2,
    category: 'math',
    difficulty: 1,
  },
] as const;

export function findBuiltInPracticeQuestion(id: string) {
  return BUILTIN_PRACTICE_QUESTIONS.find((question) => question.id === id);
}

export function publicBuiltInPracticeQuestions() {
  return BUILTIN_PRACTICE_QUESTIONS.map((question) => ({
    id: question.id,
    question: question.question,
    choices: [...question.choices],
    category: question.category,
    difficulty: question.difficulty,
  }));
}
