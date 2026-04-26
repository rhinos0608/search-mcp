import { safeResponseJson } from '../httpGuards.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface StackOverflowQuestion {
  questionId: number;
  title: string;
  body: string;
  tags: string[];
  score: number;
  viewCount: number;
  answerCount: number;
  acceptedAnswerId?: number;
  creationDate: Date;
  lastActivityDate: Date;
  owner: {
    userId: number;
    displayName: string;
    reputation: number;
  };
  link: string;
}

export interface StackOverflowAnswer {
  answerId: number;
  questionId: number;
  body: string;
  score: number;
  isAccepted: boolean;
  creationDate: Date;
  lastEditDate?: Date;
  owner: {
    userId: number;
    displayName: string;
    reputation: number;
  };
  link: string;
}

export interface FetchQuestionOptions {
  includeAnswers?: boolean;
  includeBody?: boolean;
  filter?: string; // Stack Exchange API filter
}

export interface FetchAnswersOptions {
  sort?: 'activity' | 'creation' | 'votes';
  order?: 'desc' | 'asc';
  pageSize?: number;
}

// ── API response types ───────────────────────────────────────────────────────

interface SeApiQuestionItem {
  question_id: number;
  title: string;
  body?: string;
  tags: string[];
  score: number;
  view_count: number;
  answer_count: number;
  accepted_answer_id?: number;
  creation_date: number;
  last_activity_date: number;
  owner: { user_id: number; display_name: string; reputation: number };
  link: string;
}

interface SeApiAnswerItem {
  answer_id: number;
  question_id: number;
  body: string;
  score: number;
  is_accepted: boolean;
  creation_date: number;
  last_edit_date?: number;
  owner: { user_id: number; display_name: string; reputation: number };
  link: string;
}

interface SeApiWrapper<T> {
  items: T[];
  has_more?: boolean;
  quota_remaining?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SE_API_BASE = 'https://api.stackexchange.com/2.3';
const DEFAULT_FILTER = 'withbody';

// ── Response mapping ───────────────────────────────────────────────────────

function mapApiQuestion(item: SeApiQuestionItem): StackOverflowQuestion {
  const mapped: StackOverflowQuestion = {
    questionId: item.question_id,
    title: item.title,
    body: item.body ?? '',
    tags: item.tags,
    score: item.score,
    viewCount: item.view_count,
    answerCount: item.answer_count,
    creationDate: new Date(item.creation_date * 1000),
    lastActivityDate: new Date(item.last_activity_date * 1000),
    owner: {
      userId: item.owner.user_id,
      displayName: item.owner.display_name,
      reputation: item.owner.reputation,
    },
    link: item.link,
  };
  if (item.accepted_answer_id !== undefined) {
    mapped.acceptedAnswerId = item.accepted_answer_id;
  }
  return mapped;
}

function mapApiAnswer(item: SeApiAnswerItem): StackOverflowAnswer {
  const mapped: StackOverflowAnswer = {
    answerId: item.answer_id,
    questionId: item.question_id,
    body: item.body,
    score: item.score,
    isAccepted: item.is_accepted,
    creationDate: new Date(item.creation_date * 1000),
    owner: {
      userId: item.owner.user_id,
      displayName: item.owner.display_name,
      reputation: item.owner.reputation,
    },
    link: item.link,
  };
  if (item.last_edit_date !== undefined) {
    mapped.lastEditDate = new Date(item.last_edit_date * 1000);
  }
  return mapped;
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(`${SE_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set('site', 'stackoverflow');
  return url.toString();
}

async function apiGet<T>(url: string): Promise<SeApiWrapper<T>> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Stack Exchange API error: ${String(response.status)} ${response.statusText}`);
  }
  const data = (await safeResponseJson(response, url)) as SeApiWrapper<T>;
  return data;
}

// ── Public functions ───────────────────────────────────────────────────────

export async function fetchQuestionById(
  questionId: number,
  options?: FetchQuestionOptions,
  apiKey?: string,
): Promise<StackOverflowQuestion> {
  const url = buildUrl(`/questions/${String(questionId)}`, {
    filter: options?.includeBody !== false ? (options?.filter ?? DEFAULT_FILTER) : undefined,
    key: apiKey,
  });

  const data = await apiGet<SeApiQuestionItem>(url);
  const item = data.items[0];
  if (!item) {
    throw new Error(`Question ${String(questionId)} not found`);
  }

  return mapApiQuestion(item);
}

export async function fetchAnswersForQuestion(
  questionId: number,
  options?: FetchAnswersOptions,
  apiKey?: string,
): Promise<StackOverflowAnswer[]> {
  const url = buildUrl(`/questions/${String(questionId)}/answers`, {
    filter: DEFAULT_FILTER,
    sort: options?.sort,
    order: options?.order,
    pagesize: options?.pageSize,
    key: apiKey,
  });

  const data = await apiGet<SeApiAnswerItem>(url);
  return data.items.map(mapApiAnswer);
}

export async function fetchQuestionWithAnswers(
  questionId: number,
  options?: { answerOptions?: FetchAnswersOptions; apiKey?: string },
): Promise<{ question: StackOverflowQuestion; answers: StackOverflowAnswer[] }> {
  const [question, answers] = await Promise.all([
    fetchQuestionById(questionId, undefined, options?.apiKey),
    fetchAnswersForQuestion(questionId, options?.answerOptions, options?.apiKey),
  ]);
  return { question, answers };
}

export async function fetchQuestionsBatch(
  questionIds: number[],
  options?: FetchQuestionOptions,
  apiKey?: string,
): Promise<StackOverflowQuestion[]> {
  if (questionIds.length === 0) return [];

  const url = buildUrl(`/questions/${questionIds.join(';')}`, {
    filter: options?.includeBody !== false ? (options?.filter ?? DEFAULT_FILTER) : undefined,
    key: apiKey,
  });

  const data = await apiGet<SeApiQuestionItem>(url);
  return data.items.map(mapApiQuestion);
}

// ── Code extraction ──────────────────────────────────────────────────────────

export function extractCodeBlocks(htmlBody: string): { language?: string; code: string }[] {
  const blocks: { language?: string; code: string }[] = [];

  // Match <pre><code class="language-xxx">...content...</code></pre>
  const preCodeRegex =
    /<pre>\s*<code(?:\s+class="language-([^"]+)")?\s*>([<\s\S]*?)<\/code>\s*<\/pre>/gi;

  let match;
  while ((match = preCodeRegex.exec(htmlBody)) !== null) {
    const language = match[1];
    const code = decodeHtmlEntities(match[2] ?? '').trim();
    if (code) {
      const block: { language?: string; code: string } = { code };
      if (language !== undefined) {
        block.language = language;
      }
      blocks.push(block);
    }
  }

  return blocks;
}

function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ── Search query builder ─────────────────────────────────────────────────────

export function buildSearchQuery(params: {
  intitle?: string;
  tagged?: string[];
  notTagged?: string[];
  minScore?: number;
  hasAnswers?: boolean;
  accepted?: boolean;
}): string {
  const parts: string[] = [];

  if (params.intitle) {
    parts.push(`intitle:${encodeURIComponent(params.intitle)}`);
  }
  if (params.tagged && params.tagged.length > 0) {
    parts.push(`tagged=${encodeURIComponent(params.tagged.join(';'))}`);
  }
  if (params.notTagged && params.notTagged.length > 0) {
    parts.push(`nottagged=${encodeURIComponent(params.notTagged.join(';'))}`);
  }
  if (params.minScore !== undefined) {
    parts.push(`min=${String(params.minScore)}`);
  }
  if (params.hasAnswers) {
    parts.push('answers:1');
  }
  if (params.accepted) {
    parts.push('hasaccepted:yes');
  }

  return parts.join('&');
}
