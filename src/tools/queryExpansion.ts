export interface QueryVariation {
  query: string;
  strategy: 'original' | 'question' | 'concept' | 'scope' | 'category';
}

// Stopwords for relevance computation (common English words that dilute token overlap)
const RELEVANCE_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'for',
  'how',
  'is',
  'in',
  'of',
  'on',
  'and',
  'with',
  'from',
  'by',
  'at',
  'this',
  'that',
  'it',
  'my',
  'your',
  'i',
  'me',
  'we',
  'you',
  'what',
  'are',
  'do',
  'can',
  'its',
  'be',
  'or',
  'not',
  'no',
  'so',
  'if',
  'but',
  'about',
  'all',
  'just',
  'get',
  'has',
  'have',
  'was',
  'will',
]);

// Generic query words that should not carry relevance on their own.
// They still help when paired with stronger entity/topic matches.
const LOW_SIGNAL_TOKENS = new Set([
  'advice',
  'animation',
  'animations',
  'best',
  'chance',
  'chances',
  'code',
  'compare',
  'comparison',
  'differences',
  'explain',
  'guide',
  'guides',
  'how',
  'latest',
  'news',
  'odds',
  'opinion',
  'opinions',
  'prediction',
  'predictions',
  'probability',
  'probabilities',
  'prompt',
  'prompting',
  'prompts',
  'rate',
  'review',
  'reviews',
  'thoughts',
  'tip',
  'tips',
  'tricks',
  'tutorial',
  'tutorials',
  'update',
  'updates',
  'use',
  'using',
  'versus',
  'vs',
  'worth',
]);

/**
 * Lowercase, strip punctuation, remove stopwords, drop single-char tokens.
 */
function relevanceTokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !RELEVANCE_STOPWORDS.has(w));
  return new Set(words);
}

function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .join(' ');
}

/**
 * Precomputed query shape reused across items in a stream.
 * Built once per ranking query; reused by relevanceScore so per-item
 * tokenize/score loops don't re-tokenize the same query N times.
 */
export class PreparedQuery {
  readonly raw: string;
  readonly tokens: Set<string>;
  readonly informativeTokens: Set<string>;
  readonly normalizedPhrase: string;

  constructor(query: string) {
    this.raw = query;
    this.tokens = relevanceTokenize(query);
    // Filter out low-signal tokens; fall back to all tokens if nothing remains
    const informative = new Set([...this.tokens].filter((t) => !LOW_SIGNAL_TOKENS.has(t)));
    this.informativeTokens = informative.size > 0 ? informative : this.tokens;
    this.normalizedPhrase = normalizePhrase(query);
  }

  /** Token overlap score between this query and target text (0-1) */
  relevanceScore(text: string): number {
    const textTokens = relevanceTokenize(text);
    if (this.tokens.size === 0) return 0.5;

    const overlap = new Set([...this.tokens].filter((t) => textTokens.has(t)));
    if (overlap.size === 0) return 0;

    const coverage = overlap.size / this.tokens.size;
    const informativeMatched =
      this.informativeTokens.size > 0
        ? new Set([...this.informativeTokens].filter((t) => textTokens.has(t)))
        : new Set<string>();
    const informativeOverlap =
      this.informativeTokens.size > 0 ? informativeMatched.size / this.informativeTokens.size : 0;
    const precisionDenom = Math.min(textTokens.size, this.tokens.size + 4) || 1;
    const precision = overlap.size / precisionDenom;

    const base = 0.55 * Math.pow(coverage, 1.35) + 0.25 * informativeOverlap + 0.2 * precision;

    // Cap if only low-signal tokens matched
    if (this.informativeTokens.size > 0 && informativeMatched.size === 0) {
      return Math.min(0.24, base);
    }

    return Math.min(1.0, base);
  }
}

/** Returns true if the query consists entirely of low-signal tokens */
export function isLowSignalQuery(query: string): boolean {
  const words = query
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (words.length === 0) return false;
  return words.every((w) => LOW_SIGNAL_TOKENS.has(w));
}

export interface CategoryExpansion {
  categoryId: string;
  peerCommunities: string[];
}

/**
 * Product-category→peer-community map for query expansion.
 * Ported from last30days categories.py.
 * First-match-wins — categories ordered most-specific to least-specific.
 */
const CATEGORY_PEERS: Record<string, { patterns: string[]; peers: string[] }> = {
  ai_image_generation: {
    patterns: [
      'image generation',
      'image gen',
      'text to image',
      'text-to-image',
      'gpt image',
      'gpt-image',
      'midjourney',
      'stable diffusion',
      'stablediffusion',
      'dall-e',
      'dalle',
      'flux.1',
      'flux schnell',
      'imagen',
      'seedance',
      'ideogram',
      'recraft',
    ],
    peers: ['StableDiffusion', 'midjourney', 'dalle2', 'aiArt', 'PromptEngineering'],
  },
  ai_video_generation: {
    patterns: [
      'video generation',
      'text to video',
      'text-to-video',
      'sora',
      'veo 3',
      'veo3',
      'runway gen',
      'kling',
      'pika labs',
      'luma dream machine',
      'hailuo',
    ],
    peers: ['aivideo', 'StableDiffusion', 'runwayml', 'singularity'],
  },
  ai_music_generation: {
    patterns: ['music generation', 'ai music', 'suno', 'udio', 'riffusion', 'stable audio'],
    peers: ['SunoAI', 'udiomusic', 'aimusic', 'artificial'],
  },
  ai_coding_agent: {
    patterns: [
      'claude code',
      'cursor ide',
      'github copilot',
      'windsurf',
      'aider',
      'cline',
      'openclaw',
      'hermes agent',
      'continue.dev',
      'codeium',
      'sweep ai',
      'devin ai',
      'coding agent',
      'coding assistant',
    ],
    peers: ['ChatGPTCoding', 'LocalLLaMA', 'singularity', 'PromptEngineering'],
  },
  ai_agent_framework: {
    patterns: [
      'agent framework',
      'agentic framework',
      'langchain',
      'langgraph',
      'crewai',
      'autogen',
      'llamaindex',
      'dspy',
      'smolagents',
    ],
    peers: ['LangChain', 'LocalLLaMA', 'AI_Agents', 'MachineLearning'],
  },
  ai_chat_model: {
    patterns: [
      'gpt-5',
      'gpt-4',
      'claude opus',
      'claude sonnet',
      'claude haiku',
      'gemini pro',
      'gemini flash',
      'llama 3',
      'llama 4',
      'deepseek',
      'qwen',
      'mistral large',
      'grok',
    ],
    peers: ['LocalLLaMA', 'ChatGPT', 'ClaudeAI', 'singularity', 'artificial'],
  },
  saas_screen_recording: {
    patterns: [
      'screen recording',
      'screen recorder',
      'loom video',
      'tella screen',
      'vidyard',
      'screen capture tool',
    ],
    peers: ['SaaS', 'screenrecording', 'productivity', 'Entrepreneur'],
  },
  saas_productivity: {
    patterns: [
      'notion app',
      'obsidian plugin',
      'obsidian app',
      'linear app',
      'asana',
      'clickup',
      'productivity app',
    ],
    peers: ['productivity', 'SaaS', 'ObsidianMD', 'Notion'],
  },
  prediction_markets: {
    patterns: ['polymarket', 'kalshi', 'prediction market', 'event contracts', 'manifold markets'],
    peers: ['Polymarket', 'Kalshi', 'predictionmarkets'],
  },
  crypto_defi: {
    patterns: [
      'defi protocol',
      'yield farming',
      'liquidity pool',
      'stablecoin',
      'ethereum layer',
      'layer 2',
      'l2 rollup',
    ],
    peers: ['defi', 'ethfinance', 'CryptoCurrency', 'ethereum'],
  },
  dev_tool_cli: {
    patterns: ['cli tool', 'command line tool', 'terminal app', 'dev tool'],
    peers: ['commandline', 'programming', 'webdev'],
  },
};

export function detectCategory(query: string): CategoryExpansion | null {
  if (!query) return null;
  for (const [categoryId, entry] of Object.entries(CATEGORY_PEERS)) {
    for (const pattern of entry.patterns) {
      // Word-boundary matching prevents false positives like 'mydalle' matching 'dalle'
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      if (re.test(query)) {
        return { categoryId, peerCommunities: [...entry.peers] };
      }
    }
  }
  return null;
}

const CONCEPT_MAP: Record<string, string[]> = {
  // Tech
  api: ['rest', 'graphql', 'endpoint', 'integration', 'sdk'],
  database: ['sql', 'nosql', 'postgres', 'mysql', 'mongodb', 'indexing', 'query'],
  security: ['vulnerability', 'authentication', 'authorization', 'encryption', 'xss', 'csrf'],
  testing: ['unit test', 'integration test', 'e2e', 'coverage', 'mocking', 'assertion'],
  deployment: ['ci/cd', 'docker', 'kubernetes', 'release', 'rollback', 'pipeline'],
  monitoring: ['observability', 'logging', 'metrics', 'alerting', 'tracing', 'dashboard'],
  frontend: ['react', 'vue', 'angular', 'svelte', 'dom', 'css', 'rendering'],
  backend: ['server', 'middleware', 'routing', 'caching', 'queue', 'worker'],
  'machine-learning': [
    'neural network',
    'training',
    'inference',
    'transformer',
    'llm',
    'fine-tuning',
  ],
  cloud: ['aws', 'azure', 'gcp', 'serverless', 'lambda', 's3', 'ec2'],
  compiler: ['parser', 'lexer', 'ast', 'optimization', 'codegen', 'jit', 'llvm'],
  networking: ['tcp', 'http', 'dns', 'proxy', 'load balancer', 'cdn'],
  cryptography: ['hash', 'signature', 'certificate', 'key exchange', 'zero-knowledge'],
  os: ['kernel', 'scheduler', 'memory management', 'file system', 'syscall'],
  distributed: ['consensus', 'raft', 'paxos', 'sharding', 'replication', 'cap'],
  devops: ['terraform', 'ansible', 'pulumi', 'infrastructure as code', 'gitops'],
  storage: ['ssd', 'block', 'object', 'nfs', 'redundancy', 'raid'],
  mobile: ['ios', 'android', 'swift', 'kotlin', 'react native', 'flutter'],

  // Business
  startup: ['funding', 'vc', 'series a', 'pitch deck', 'mrr', 'growth', 'churn'],
  marketing: ['seo', 'content', 'social media', 'email', 'conversion', 'funnel', 'brand'],
  sales: ['b2b', 'outbound', 'pipeline', 'crm', 'demo', 'negotiation', 'closing'],
  finance: ['accounting', 'valuation', 'cap table', 'equity', 'revenue', 'profit'],
  product: ['roadmap', 'sprint', 'backlog', 'user story', 'mvp', 'iteration', 'okr'],
  management: ['leadership', 'delegation', 'feedback', '1:1', 'performance', 'hiring'],
  legal: ['contract', 'nda', 'ip', 'compliance', 'gdpr', 'terms of service'],
  support: ['ticket', 'sla', 'on-call', 'escalation', 'kb', 'faq'],

  // Manufacturing / Systems
  manufacturing: ['supply chain', 'inventory', 'procurement', 'logistics', 'warehouse'],
  safety: ['hazard', 'ppe', 'iso', 'audit', 'incident', 'compliance'],
  quality: ['qa', 'qc', 'six sigma', 'inspection', 'tolerance', 'defect'],
  maintenance: ['preventive', 'predictive', 'downtime', 'asset', 'cmms'],
  engineering: ['cad', 'simulation', 'prototype', 'tolerance', 'material'],
  automation: ['plc', 'scada', 'robot', 'sensor', 'actuator', 'hmi'],
  energy: ['renewable', 'solar', 'battery', 'grid', 'efficiency', 'emissions'],
  aerospace: ['avionics', 'propulsion', 'aerodynamics', 'composite', 'satellite'],
};

const OPPOSITION_PAIRS: Record<string, string> = {
  pros: 'cons',
  cons: 'pros',
  advantages: 'disadvantages',
  disadvantages: 'advantages',
  benefits: 'drawbacks',
  drawbacks: 'benefits',
  best: 'worst',
  worst: 'best',
  good: 'bad',
  bad: 'good',
  fast: 'slow',
  slow: 'fast',
  increase: 'decrease',
  decrease: 'increase',
  performance: 'performance bottleneck',
  scalability: 'scalability limits',
  security: 'security vulnerability',
  reliability: 'failure modes',
  simplicity: 'complexity tradeoffs',
};

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toQuestion(query: string, words: string[]): string | undefined {
  if (query.length < 5) return undefined;
  const qLower = query.toLowerCase();
  if (qLower.startsWith('how to') || qLower.startsWith('what is') || qLower.startsWith('why ')) {
    return undefined;
  }
  if (qLower.endsWith('?')) return undefined;

  if (words.length <= 5) {
    return `What is ${query}?`;
  }

  const nounWords = words.filter((w) => w.length > 3);
  if (nounWords.length >= 2) {
    return `How does ${nounWords.slice(0, 3).join(' ')} work?`;
  }

  return `What is ${query}?`;
}

function expandConcepts(_query: string, words: string[]): string | undefined {
  const lowerWords = words.map((w) => w.toLowerCase());
  for (const word of lowerWords) {
    const bare = word.replace(/[^a-z0-9-]/g, '');
    const entries = CONCEPT_MAP[bare];
    if (entries !== undefined) {
      return entries.slice(0, 2).join(' ');
    }
  }
  const twoGrams: string[] = [];
  for (let i = 0; i < lowerWords.length - 1; i++) {
    twoGrams.push(`${lowerWords[i] ?? ''}-${lowerWords[i + 1] ?? ''}`);
  }
  for (const gram of twoGrams) {
    const entries = CONCEPT_MAP[gram];
    if (entries !== undefined) {
      return entries.slice(0, 2).join(' ');
    }
  }
  return undefined;
}

function adjustScope(query: string, words: string[]): string | undefined {
  for (const [term, opposite] of Object.entries(OPPOSITION_PAIRS)) {
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i');
    if (pattern.test(query)) {
      return query.replace(pattern, opposite);
    }
  }

  if (words.length > 3) {
    const keyWords = words.filter((w) => w.length > 4);
    if (keyWords.length >= 3) {
      return keyWords.slice(0, 3).join(' ');
    }
  }

  return undefined;
}

export function expandQuery(original: string): QueryVariation[] {
  const words = original.trim().split(/\s+/);
  const variations: QueryVariation[] = [{ query: original, strategy: 'original' }];

  if (words.length === 0 || original.trim().length === 0) {
    return variations;
  }

  const conceptQuery = expandConcepts(original, words);
  if (conceptQuery !== undefined) {
    variations.push({ query: conceptQuery, strategy: 'concept' });
  }

  const questionQuery = toQuestion(original, words);
  if (questionQuery !== undefined) {
    variations.push({ query: questionQuery, strategy: 'question' });
  }

  const scopeQuery = adjustScope(original, words);
  if (scopeQuery !== undefined) {
    variations.push({ query: scopeQuery, strategy: 'scope' });
  }

  const category = detectCategory(original);
  if (category !== null) {
    variations.push({
      query: `${original} ${category.peerCommunities.slice(0, 3).join(' ')}`,
      strategy: 'category',
    });
  }

  return variations;
}
