/**
 * Deep Research Benchmark Dataset — SimpleQA-style factual questions.
 *
 * 51 questions across 15 domains. Each has a short, unambiguous ground-truth
 * answer. Designed to test factuality of deep research output.
 *
 * Selection criteria:
 * - Answer must be a verifiable fact (not opinion or interpretation).
 * - Question must be answerable from public web sources.
 * - Answer must be stable over time (no fast-changing trivia).
 * - Diverse domains to exercise the full research pipeline.
 */

import type { BenchmarkQuestion } from './types.js';

export const benchmarkQuestions: readonly BenchmarkQuestion[] = [
  // ── Science ─────────────────────────────────────────────────────────────
  {
    id: 'sci-001',
    question: 'What element has the highest melting point?',
    answer: 'Tungsten (W), at 3422°C (6192°F).',
    domain: 'science',
    difficulty: 'easy',
    requiredTerms: ['tungsten', '3422'],
  },
  {
    id: 'sci-002',
    question: 'What is the speed of light in vacuum in meters per second?',
    answer: '299,792,458 m/s.',
    domain: 'physics',
    difficulty: 'easy',
    requiredTerms: ['299792458', '299,792,458'],
  },
  {
    id: 'sci-003',
    question: 'Who discovered penicillin?',
    answer: 'Alexander Fleming in 1928.',
    domain: 'science',
    difficulty: 'easy',
    requiredTerms: ['fleming'],
  },
  {
    id: 'sci-004',
    question: 'What is the chemical symbol for gold?',
    answer: 'Au.',
    domain: 'science',
    difficulty: 'easy',
    requiredTerms: ['Au'],
  },

  // ── Biology ─────────────────────────────────────────────────────────────
  {
    id: 'bio-001',
    question: 'How many chromosomes do humans have?',
    answer: '46 chromosomes (23 pairs).',
    domain: 'biology',
    difficulty: 'easy',
    requiredTerms: ['46'],
  },
  {
    id: 'bio-002',
    question: 'What is the largest organ in the human body?',
    answer: 'The skin.',
    domain: 'biology',
    difficulty: 'easy',
    requiredTerms: ['skin'],
  },
  {
    id: 'bio-003',
    question: 'What blood type is considered the universal donor?',
    answer: 'O negative (O−).',
    domain: 'biology',
    difficulty: 'easy',
    requiredTerms: ['O-', 'O negative', 'type O'],
  },

  // ── Physics ─────────────────────────────────────────────────────────────
  {
    id: 'phy-001',
    question: 'What does E=mc² represent?',
    answer: 'Energy equals mass times the speed of light squared — mass-energy equivalence.',
    domain: 'physics',
    difficulty: 'easy',
    requiredTerms: ['energy', 'mass'],
  },
  {
    id: 'phy-002',
    question: 'Who formulated the theory of general relativity?',
    answer: 'Albert Einstein, published in 1915.',
    domain: 'physics',
    difficulty: 'easy',
    requiredTerms: ['einstein'],
  },

  // ── Math ────────────────────────────────────────────────────────────────
  {
    id: 'mat-001',
    question: 'What is the value of pi to two decimal places?',
    answer: '3.14.',
    domain: 'math',
    difficulty: 'easy',
    requiredTerms: ['3.14'],
  },
  {
    id: 'mat-002',
    question: 'What is the Pythagorean theorem?',
    answer: 'a² + b² = c², where c is the hypotenuse of a right triangle.',
    domain: 'math',
    difficulty: 'easy',
    requiredTerms: ['a^2', 'b^2', 'c^2'],
  },

  // ── History ─────────────────────────────────────────────────────────────
  {
    id: 'his-001',
    question: 'In what year did World War II end?',
    answer: '1945.',
    domain: 'history',
    difficulty: 'easy',
    requiredTerms: ['1945'],
  },
  {
    id: 'his-002',
    question: 'Who was the first President of the United States?',
    answer: 'George Washington, serving from 1789 to 1797.',
    domain: 'history',
    difficulty: 'easy',
    requiredTerms: ['washington'],
  },
  {
    id: 'his-003',
    question: 'What ancient civilization built the pyramids at Giza?',
    answer: 'The ancient Egyptians, during the Old Kingdom period.',
    domain: 'history',
    difficulty: 'easy',
    requiredTerms: ['egypt'],
  },
  {
    id: 'his-004',
    question: 'In what year did the Berlin Wall fall?',
    answer: '1989.',
    domain: 'history',
    difficulty: 'medium',
    requiredTerms: ['1989'],
  },
  {
    id: 'his-005',
    question: 'What was the name of the ship that brought the Pilgrims to America in 1620?',
    answer: 'The Mayflower.',
    domain: 'history',
    difficulty: 'medium',
    requiredTerms: ['mayflower'],
  },

  // ── Geography ───────────────────────────────────────────────────────────
  {
    id: 'geo-001',
    question: 'What is the capital of France?',
    answer: 'Paris.',
    domain: 'geography',
    difficulty: 'easy',
    requiredTerms: ['paris'],
  },
  {
    id: 'geo-002',
    question: 'What is the largest country by land area?',
    answer: 'Russia, with approximately 17.1 million square kilometers.',
    domain: 'geography',
    difficulty: 'easy',
    requiredTerms: ['russia'],
  },
  {
    id: 'geo-003',
    question: 'What is the longest river in the world?',
    answer: 'The Nile River, at approximately 6,650 km (4,130 miles).',
    domain: 'geography',
    difficulty: 'medium',
    requiredTerms: ['nile'],
  },
  {
    id: 'geo-004',
    question: 'How many continents are there?',
    answer:
      'Seven: Africa, Antarctica, Asia, Australia/Oceania, Europe, North America, South America.',
    domain: 'geography',
    difficulty: 'easy',
    requiredTerms: ['seven', '7'],
  },

  // ── Technology ──────────────────────────────────────────────────────────
  {
    id: 'tec-001',
    question: 'In what year was the World Wide Web invented?',
    answer: '1989, by Tim Berners-Lee.',
    domain: 'technology',
    difficulty: 'medium',
    requiredTerms: ['1989', 'berners-lee'],
  },
  {
    id: 'tec-002',
    question: 'Who co-founded Apple Inc. alongside Steve Jobs and Ronald Wayne?',
    answer: 'Steve Wozniak.',
    domain: 'technology',
    difficulty: 'medium',
    requiredTerms: ['wozniak'],
  },
  {
    id: 'tec-003',
    question: 'What programming language was created by Guido van Rossum?',
    answer: 'Python.',
    domain: 'technology',
    difficulty: 'easy',
    requiredTerms: ['python'],
  },
  {
    id: 'tec-004',
    question: 'What company developed the Android operating system?',
    answer:
      'Android Inc., later acquired by Google. Google now develops it through the Open Handset Alliance.',
    domain: 'technology',
    difficulty: 'medium',
    requiredTerms: ['google'],
  },
  {
    id: 'tec-005',
    question: 'What does HTTP stand for?',
    answer: 'HyperText Transfer Protocol.',
    domain: 'technology',
    difficulty: 'easy',
    requiredTerms: ['hypertext', 'transfer', 'protocol'],
  },

  // ── Pop Culture ─────────────────────────────────────────────────────────
  {
    id: 'pop-001',
    question: 'Who directed the 1994 film Pulp Fiction?',
    answer: 'Quentin Tarantino.',
    domain: 'pop_culture',
    difficulty: 'easy',
    requiredTerms: ['tarantino'],
  },
  {
    id: 'pop-002',
    question:
      'Which band performed at the first-ever Woodstock festival in 1969 as the closing act?',
    answer: 'Jimi Hendrix.',
    domain: 'music',
    difficulty: 'medium',
    requiredTerms: ['hendrix'],
  },

  // ── Sports ──────────────────────────────────────────────────────────────
  {
    id: 'spo-001',
    question: 'Which country has won the most FIFA World Cup titles?',
    answer: 'Brazil, with 5 titles (1958, 1962, 1970, 1994, 2002).',
    domain: 'sports',
    difficulty: 'easy',
    requiredTerms: ['brazil'],
  },
  {
    id: 'spo-002',
    question: 'How many players are on a standard basketball team on the court at once?',
    answer: 'Five players per team.',
    domain: 'sports',
    difficulty: 'easy',
    requiredTerms: ['five', '5'],
  },
  {
    id: 'spo-003',
    question: 'In what city were the first modern Olympic Games held in 1896?',
    answer: 'Athens, Greece.',
    domain: 'sports',
    difficulty: 'medium',
    requiredTerms: ['athens'],
  },

  // ── Economics ───────────────────────────────────────────────────────────
  {
    id: 'eco-001',
    question: 'What currency is used in Japan?',
    answer: 'The Japanese yen (¥, JPY).',
    domain: 'economics',
    difficulty: 'easy',
    requiredTerms: ['yen'],
  },
  {
    id: 'eco-002',
    question: 'What is the name of the central bank of the United States?',
    answer: 'The Federal Reserve System (the Fed).',
    domain: 'economics',
    difficulty: 'medium',
    requiredTerms: ['federal reserve', 'fed'],
  },
  {
    id: 'eco-003',
    question: 'What economic term describes a general increase in prices over time?',
    answer: 'Inflation.',
    domain: 'economics',
    difficulty: 'easy',
    requiredTerms: ['inflation'],
  },

  // ── Literature ──────────────────────────────────────────────────────────
  {
    id: 'lit-001',
    question: 'Who wrote the novel "1984"?',
    answer: 'George Orwell.',
    domain: 'literature',
    difficulty: 'easy',
    requiredTerms: ['orwell'],
  },
  {
    id: 'lit-002',
    question: 'What is the first book of the Bible?',
    answer: 'Genesis.',
    domain: 'literature',
    difficulty: 'easy',
    requiredTerms: ['genesis'],
  },
  {
    id: 'lit-003',
    question: 'Who wrote "Romeo and Juliet"?',
    answer: 'William Shakespeare.',
    domain: 'literature',
    difficulty: 'easy',
    requiredTerms: ['shakespeare'],
  },
  {
    id: 'lit-004',
    question: 'What is the best-selling book series of all time?',
    answer: 'The Harry Potter series by J.K. Rowling, with over 500 million copies sold.',
    domain: 'literature',
    difficulty: 'medium',
    requiredTerms: ['harry potter'],
  },

  // ── Politics ────────────────────────────────────────────────────────────
  {
    id: 'pol-001',
    question: 'How many member states are in the United Nations?',
    answer: '193 member states.',
    domain: 'politics',
    difficulty: 'medium',
    requiredTerms: ['193'],
  },
  {
    id: 'pol-002',
    question: 'What year did the United States declare independence?',
    answer: '1776.',
    domain: 'politics',
    difficulty: 'easy',
    requiredTerms: ['1776'],
  },

  // ── Music ───────────────────────────────────────────────────────────────
  {
    id: 'mus-001',
    question: 'Who composed the "Moonlight Sonata"?',
    answer: 'Ludwig van Beethoven.',
    domain: 'music',
    difficulty: 'medium',
    requiredTerms: ['beethoven'],
  },
  {
    id: 'mus-002',
    question: 'What is the best-selling album of all time?',
    answer: '"Thriller" by Michael Jackson, with estimated sales over 70 million copies.',
    domain: 'music',
    difficulty: 'medium',
    requiredTerms: ['thriller', 'jackson'],
  },
  {
    id: 'mus-003',
    question: 'Which band released the album "Abbey Road"?',
    answer: 'The Beatles.',
    domain: 'music',
    difficulty: 'easy',
    requiredTerms: ['beatles'],
  },

  // ── Film ────────────────────────────────────────────────────────────────
  {
    id: 'fil-001',
    question: 'What was the first feature-length animated film?',
    answer: '"Snow White and the Seven Dwarfs" by Disney, released in 1937.',
    domain: 'film',
    difficulty: 'medium',
    requiredTerms: ['snow white'],
  },
  {
    id: 'fil-002',
    question: 'Who played the character of Jack Dawson in the 1997 film Titanic?',
    answer: 'Leonardo DiCaprio.',
    domain: 'film',
    difficulty: 'easy',
    requiredTerms: ['dicaprio'],
  },
  {
    id: 'fil-003',
    question: 'Which film won the Academy Award for Best Picture in 2020?',
    answer: '"Parasite", directed by Bong Joon-ho.',
    domain: 'film',
    difficulty: 'medium',
    requiredTerms: ['parasite'],
  },

  // ── Art ─────────────────────────────────────────────────────────────────
  {
    id: 'art-001',
    question: 'Who painted the Mona Lisa?',
    answer: 'Leonardo da Vinci, painted between 1503 and 1506.',
    domain: 'art',
    difficulty: 'easy',
    requiredTerms: ['da vinci'],
  },
  {
    id: 'art-002',
    question: 'What art movement is Salvador Dalí associated with?',
    answer: 'Surrealism.',
    domain: 'art',
    difficulty: 'easy',
    requiredTerms: ['surrealism'],
  },
  {
    id: 'art-003',
    question: 'In which museum is the Mona Lisa displayed?',
    answer: 'The Louvre Museum in Paris, France.',
    domain: 'art',
    difficulty: 'easy',
    requiredTerms: ['louvre'],
  },

  // ── Hard questions ──────────────────────────────────────────────────────
  {
    id: 'sci-005',
    question: 'What is the Chandrasekhar limit?',
    answer: 'The maximum mass of a stable white dwarf star, approximately 1.4 solar masses.',
    domain: 'physics',
    difficulty: 'hard',
    requiredTerms: ['chandrasekhar', '1.4', 'white dwarf'],
  },
  {
    id: 'his-006',
    question: 'What was the name of the 1917 encrypted telegram that helped bring the US into WWI?',
    answer: 'The Zimmermann Telegram.',
    domain: 'history',
    difficulty: 'hard',
    requiredTerms: ['zimmermann'],
  },
  {
    id: 'sci-006',
    question: 'What is the Krebs cycle also known as?',
    answer: 'The citric acid cycle or TCA (tricarboxylic acid) cycle.',
    domain: 'biology',
    difficulty: 'hard',
    requiredTerms: ['citric acid', 'TCA'],
  },
];

/** Total number of benchmark questions. */
export const questionCount = benchmarkQuestions.length;
