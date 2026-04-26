import test from 'node:test';
import assert from 'node:assert/strict';
import { createQAAdapter, stackOverflowToRawDocument } from '../src/rag/adapters/qa.js';

const mockQuestion = {
  questionId: 12345,
  title: 'How to use TypeScript with React?',
  body: '<p>I want to use TypeScript with React...</p><pre><code>const App: React.FC = () => {}</code></pre>',
  tags: ['typescript', 'react', 'javascript'],
  score: 50,
  viewCount: 1000,
  answerCount: 3,
  acceptedAnswerId: 12346,
  creationDate: new Date('2023-01-01'),
  lastActivityDate: new Date('2023-06-01'),
  owner: { userId: 1, displayName: 'John', reputation: 5000 },
  link: 'https://stackoverflow.com/q/12345',
};

const mockAnswer = {
  answerId: 12346,
  questionId: 12345,
  body: '<p>You can use TypeScript with React like this:</p><pre><code>const App: React.FC = () => { return <div>Hello</div>; };</code></pre>',
  score: 25,
  isAccepted: true,
  creationDate: new Date('2023-01-02'),
  owner: { userId: 2, displayName: 'Jane', reputation: 3000 },
  link: 'https://stackoverflow.com/a/12346',
};

// ── createQAAdapter ──────────────────────────────────────────────────────────

test('chunk creates chunks from Stack Overflow documents', () => {
  const adapter = createQAAdapter();
  const doc = stackOverflowToRawDocument(mockQuestion, [mockAnswer]);
  const chunks = adapter.chunk([doc]);

  assert.ok(chunks.length > 0);
  assert.equal(chunks[0]!.postType, 'question');
  assert.equal(chunks[0]!.questionId, 12345);
});

test('chunk preserves code blocks in chunks', () => {
  const adapter = createQAAdapter();
  const doc = stackOverflowToRawDocument(mockQuestion);
  const chunks = adapter.chunk([doc]);

  const questionChunk = chunks.find((c) => c.postType === 'question');
  assert.ok(questionChunk);
  assert.ok(questionChunk!.codeBlocks.length > 0);
  assert.ok(questionChunk!.codeBlocks[0]!.code.includes('const App'));
});

test('linkAnswers links answers to their question', () => {
  const adapter = createQAAdapter();
  const questionChunk = adapter.buildQuestionChunk(mockQuestion);
  const answerChunk = adapter.buildAnswerChunk(mockAnswer, mockQuestion);

  const linked = adapter.linkAnswers(questionChunk, [answerChunk]);
  assert.equal(linked.question.questionId, 12345);
  assert.equal(linked.answers.length, 1);
  assert.equal(linked.acceptedAnswer?.answerId, 12346);
  assert.equal(linked.topAnswer?.answerId, 12346);
});

test('buildQuestionChunk creates question chunk', () => {
  const adapter = createQAAdapter();
  const chunk = adapter.buildQuestionChunk(mockQuestion);
  assert.equal(chunk.postType, 'question');
  assert.equal(chunk.score, 50);
  assert.equal(chunk.tags.length, 3);
});

test('buildAnswerChunk creates answer chunk', () => {
  const adapter = createQAAdapter();
  const chunk = adapter.buildAnswerChunk(mockAnswer, mockQuestion);
  assert.equal(chunk.postType, 'answer');
  assert.equal(chunk.answerId, 12346);
  assert.equal(chunk.isAccepted, true);
});

test('stackOverflowToRawDocument builds document', () => {
  const doc = stackOverflowToRawDocument(mockQuestion, [mockAnswer]);
  assert.equal(doc.adapter, 'qa');
  assert.ok(doc.text.includes(mockQuestion.title));
  assert.ok(doc.text.includes(String(mockAnswer.score)));
});
