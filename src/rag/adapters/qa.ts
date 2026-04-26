import type { RawDocument, RagChunk } from '../types.js';
import type {
  StackOverflowQuestion,
  StackOverflowAnswer,
} from '../../tools/stackoverflowAnswers.js';
import { extractCodeBlocks } from '../../tools/stackoverflowAnswers.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface QAChunk extends RagChunk {
  questionId: number;
  answerId?: number;
  postType: 'question' | 'answer';
  score: number;
  isAccepted: boolean;
  language?: string;
  tags: string[];
  codeBlocks: { language?: string; code: string }[];
  questionTitle?: string;
  questionBody?: string;
  answerCount?: number;
  viewCount?: number;
}

export interface QAAdapterOptions {
  includeAnswers?: boolean;
  includeCodeBlocks?: boolean;
  minScore?: number;
  preferredTags?: string[];
}

export interface LinkedQA {
  question: QAChunk;
  answers: QAChunk[];
  acceptedAnswer?: QAChunk;
  topAnswer?: QAChunk;
  totalScore: number;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createQAAdapter(options?: QAAdapterOptions): {
  type: 'qa';
  options: QAAdapterOptions;
  chunk: (docs: RawDocument[]) => QAChunk[];
  linkAnswers: (question: QAChunk, answers: QAChunk[]) => LinkedQA;
  buildQuestionChunk: (question: StackOverflowQuestion) => QAChunk;
  buildAnswerChunk: (answer: StackOverflowAnswer, question: StackOverflowQuestion) => QAChunk;
} {
  const opts: Required<QAAdapterOptions> = {
    includeAnswers: options?.includeAnswers ?? true,
    includeCodeBlocks: options?.includeCodeBlocks ?? true,
    minScore: options?.minScore ?? -999,
    preferredTags: options?.preferredTags ?? [],
  };

  return {
    type: 'qa',
    options: opts,
    chunk: (docs: RawDocument[]): QAChunk[] => {
      const chunks: QAChunk[] = [];

      for (const doc of docs) {
        const meta = doc.metadata ?? {};
        const postType = (meta.postType as 'question' | 'answer' | undefined) ?? 'question';
        const questionId = (meta.questionId as number | undefined) ?? 0;
        const answerId = meta.answerId as number | undefined;
        const score = (meta.score as number | undefined) ?? 0;
        const isAccepted = (meta.isAccepted as boolean | undefined) ?? false;
        const tags = (meta.tags as string[] | undefined) ?? [];
        const codeBlocks = opts.includeCodeBlocks ? extractCodeBlocks(doc.text) : [];

        if (score < opts.minScore) continue;

        const chunk: QAChunk = {
          text: doc.text,
          url: doc.url,
          section: postType,
          charOffset: 0,
          chunkIndex: chunks.length,
          totalChunks: 0, // Will be set after counting
          metadata: doc.metadata,
          questionId,
          postType,
          score,
          isAccepted,
          tags,
          codeBlocks,
        };
        const qt = meta.questionTitle as string | undefined;
        if (qt !== undefined) chunk.questionTitle = qt;
        const qb = meta.questionBody as string | undefined;
        if (qb !== undefined) chunk.questionBody = qb;
        const ac = meta.answerCount as number | undefined;
        if (ac !== undefined) chunk.answerCount = ac;
        const vc = meta.viewCount as number | undefined;
        if (vc !== undefined) chunk.viewCount = vc;
        if (answerId !== undefined) {
          chunk.answerId = answerId;
        }
        chunks.push(chunk);
      }

      // Set totalChunks
      for (const chunk of chunks) {
        chunk.totalChunks = chunks.length;
      }

      return chunks;
    },

    linkAnswers: (question: QAChunk, answers: QAChunk[]): LinkedQA => {
      const filtered = answers.filter((a) => a.questionId === question.questionId);
      const accepted = filtered.find((a) => a.isAccepted);
      const sorted = [...filtered].sort((a, b) => b.score - a.score);
      const top = sorted[0];
      const totalScore = question.score + filtered.reduce((sum, a) => sum + a.score, 0);

      const linked: LinkedQA = {
        question,
        answers: filtered,
        totalScore,
      };
      if (accepted) {
        linked.acceptedAnswer = accepted;
      }
      if (top) {
        linked.topAnswer = top;
      }
      return linked;
    },

    buildQuestionChunk: (question: StackOverflowQuestion): QAChunk => {
      const codeBlocks = opts.includeCodeBlocks ? extractCodeBlocks(question.body) : [];
      return {
        text: question.body,
        url: question.link,
        section: 'question',
        charOffset: 0,
        chunkIndex: 0,
        totalChunks: 1,
        questionId: question.questionId,
        postType: 'question',
        score: question.score,
        isAccepted: false,
        tags: question.tags,
        codeBlocks,
        questionTitle: question.title,
        questionBody: question.body,
        answerCount: question.answerCount,
        viewCount: question.viewCount,
      };
    },

    buildAnswerChunk: (answer: StackOverflowAnswer, question: StackOverflowQuestion): QAChunk => {
      const codeBlocks = opts.includeCodeBlocks ? extractCodeBlocks(answer.body) : [];
      return {
        text: answer.body,
        url: answer.link,
        section: 'answer',
        charOffset: 0,
        chunkIndex: 0,
        totalChunks: 1,
        questionId: answer.questionId,
        answerId: answer.answerId,
        postType: 'answer',
        score: answer.score,
        isAccepted: answer.isAccepted,
        tags: [],
        codeBlocks,
        questionTitle: question.title,
        questionBody: question.body,
        answerCount: question.answerCount,
        viewCount: question.viewCount,
      };
    },
  };
}

// ── Document conversion ────────────────────────────────────────────────────────

export function stackOverflowToRawDocument(
  question: StackOverflowQuestion,
  answers?: StackOverflowAnswer[],
): RawDocument {
  const parts: string[] = [`# ${question.title}\n\n${question.body}`];

  if (answers && answers.length > 0) {
    for (const answer of answers) {
      parts.push(`\n\n---\n\n## Answer (score: ${String(answer.score)})\n\n${answer.body}`);
    }
  }

  return {
    id: `so-q-${String(question.questionId)}`,
    adapter: 'qa' as const,
    text: parts.join(''),
    url: question.link,
    title: question.title,
    metadata: {
      questionId: question.questionId,
      postType: 'question',
      score: question.score,
      isAccepted: false,
      tags: question.tags,
      answerCount: question.answerCount,
      viewCount: question.viewCount,
      questionTitle: question.title,
      questionBody: question.body,
      answers:
        answers?.map((a) => ({
          answerId: a.answerId,
          questionId: a.questionId,
          score: a.score,
          isAccepted: a.isAccepted,
          body: a.body,
          link: a.link,
        })) ?? [],
    },
  };
}
