import { safeResponseJson } from '../httpGuards.js';
import { getUserAgent } from '../version.js';

const V2EX_API = 'https://www.v2ex.com/api';
const REQUEST_TIMEOUT_MS = 10_000;

export interface V2EXTopic {
  title: string;
  url: string;
  content: string;
  replies: number;
  created: string;
  lastModified: string;
  node: {
    name: string;
    title: string;
  };
  member: {
    username: string;
    url: string;
  };
}

interface V2EXApiTopic {
  title?: string;
  url?: string;
  content?: string;
  content_rendered?: string;
  replies?: number;
  created?: number;
  last_modified?: number;
  node?: { name?: string; title?: string };
  member?: { username?: string; url?: string };
}

export type V2EXMode = 'hot' | 'latest' | 'node';

function dateFromUnix(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '';
  return new Date(seconds * 1000).toISOString();
}

function normalizeTopic(topic: V2EXApiTopic): V2EXTopic {
  return {
    title: topic.title ?? '',
    url: topic.url ?? '',
    content: topic.content ?? topic.content_rendered ?? '',
    replies: topic.replies ?? 0,
    created: dateFromUnix(topic.created),
    lastModified: dateFromUnix(topic.last_modified),
    node: {
      name: topic.node?.name ?? '',
      title: topic.node?.title ?? '',
    },
    member: {
      username: topic.member?.username ?? '',
      url: topic.member?.url ?? '',
    },
  };
}

function matchesQuery(topic: V2EXTopic, query: string): boolean {
  const needle = query.toLowerCase();
  const haystack = [
    topic.title,
    topic.content,
    topic.url,
    topic.node.name,
    topic.node.title,
    topic.member.username,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

async function fetchV2EX(
  path: string,
  params: Record<string, string> = {},
): Promise<V2EXApiTopic[]> {
  const url = new URL(`${V2EX_API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': getUserAgent('v2ex'),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`V2EX API returned HTTP ${String(res.status)}`);
  }
  const data = await safeResponseJson(res, url.toString());
  if (!Array.isArray(data)) return [];
  return data as V2EXApiTopic[];
}

export async function v2exSearch(
  query: string | undefined,
  mode: V2EXMode,
  node: string | undefined,
  limit: number,
): Promise<V2EXTopic[]> {
  const effectiveMode: V2EXMode = node !== undefined && node.length > 0 ? 'node' : mode;
  const rawTopics = await (effectiveMode === 'node'
    ? fetchV2EX('/topics/show.json', { node_name: node ?? '' })
    : fetchV2EX(`/topics/${effectiveMode}.json`));

  const normalized = rawTopics.map(normalizeTopic);
  const filtered =
    query && query.trim().length > 0
      ? normalized.filter((topic) => matchesQuery(topic, query))
      : normalized;
  return filtered.slice(0, limit);
}
