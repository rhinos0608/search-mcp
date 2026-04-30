export interface QueryVariation {
  query: string;
  strategy: 'original' | 'question' | 'concept' | 'scope' | 'opposition';
}

const CONCEPT_MAP: Record<string, string[]> = {
  // Tech
  'api': ['rest', 'graphql', 'endpoint', 'integration', 'sdk'],
  'database': ['sql', 'nosql', 'postgres', 'mysql', 'mongodb', 'indexing', 'query'],
  'security': ['vulnerability', 'authentication', 'authorization', 'encryption', 'xss', 'csrf'],
  'testing': ['unit test', 'integration test', 'e2e', 'coverage', 'mocking', 'assertion'],
  'deployment': ['ci/cd', 'docker', 'kubernetes', 'release', 'rollback', 'pipeline'],
  'monitoring': ['observability', 'logging', 'metrics', 'alerting', 'tracing', 'dashboard'],
  'frontend': ['react', 'vue', 'angular', 'svelte', 'dom', 'css', 'rendering'],
  'backend': ['server', 'middleware', 'routing', 'caching', 'queue', 'worker'],
  'machine-learning': ['neural network', 'training', 'inference', 'transformer', 'llm', 'fine-tuning'],
  'cloud': ['aws', 'azure', 'gcp', 'serverless', 'lambda', 's3', 'ec2'],
  'compiler': ['parser', 'lexer', 'ast', 'optimization', 'codegen', 'jit', 'llvm'],
  'networking': ['tcp', 'http', 'dns', 'proxy', 'load balancer', 'cdn'],
  'cryptography': ['hash', 'signature', 'certificate', 'key exchange', 'zero-knowledge'],
  'os': ['kernel', 'scheduler', 'memory management', 'file system', 'syscall'],
  'distributed': ['consensus', 'raft', 'paxos', 'sharding', 'replication', 'cap'],
  'devops': ['terraform', 'ansible', 'pulumi', 'infrastructure as code', 'gitops'],
  'storage': ['ssd', 'block', 'object', 'nfs', 'redundancy', 'raid'],
  'mobile': ['ios', 'android', 'swift', 'kotlin', 'react native', 'flutter'],

  // Business
  'startup': ['funding', 'vc', 'series a', 'pitch deck', 'mrr', 'growth', 'churn'],
  'marketing': ['seo', 'content', 'social media', 'email', 'conversion', 'funnel', 'brand'],
  'sales': ['b2b', 'outbound', 'pipeline', 'crm', 'demo', 'negotiation', 'closing'],
  'finance': ['accounting', 'valuation', 'cap table', 'equity', 'revenue', 'profit'],
  'product': ['roadmap', 'sprint', 'backlog', 'user story', 'mvp', 'iteration', 'okr'],
  'management': ['leadership', 'delegation', 'feedback', '1:1', 'performance', 'hiring'],
  'legal': ['contract', 'nda', 'ip', 'compliance', 'gdpr', 'terms of service'],
  'support': ['ticket', 'sla', 'on-call', 'escalation', 'kb', 'faq'],

  // Manufacturing / Systems
  'manufacturing': ['supply chain', 'inventory', 'procurement', 'logistics', 'warehouse'],
  'safety': ['hazard', 'ppe', 'iso', 'audit', 'incident', 'compliance'],
  'quality': ['qa', 'qc', 'six sigma', 'inspection', 'tolerance', 'defect'],
  'maintenance': ['preventive', 'predictive', 'downtime', 'asset', 'cmms'],
  'engineering': ['cad', 'simulation', 'prototype', 'tolerance', 'material'],
  'automation': ['plc', 'scada', 'robot', 'sensor', 'actuator', 'hmi'],
  'energy': ['renewable', 'solar', 'battery', 'grid', 'efficiency', 'emissions'],
  'aerospace': ['avionics', 'propulsion', 'aerodynamics', 'composite', 'satellite'],
};

const OPPOSITION_PAIRS: Record<string, string> = {
  'pros': 'cons', 'cons': 'pros',
  'advantages': 'disadvantages', 'disadvantages': 'advantages',
  'benefits': 'drawbacks', 'drawbacks': 'benefits',
  'best': 'worst', 'worst': 'best',
  'good': 'bad', 'bad': 'good',
  'fast': 'slow', 'slow': 'fast',
  'increase': 'decrease', 'decrease': 'increase',
  'performance': 'performance bottleneck',
  'scalability': 'scalability limits',
  'security': 'security vulnerability',
  'reliability': 'failure modes',
  'simplicity': 'complexity tradeoffs',
};

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
  const qLower = query.toLowerCase();

  for (const [term, opposite] of Object.entries(OPPOSITION_PAIRS)) {
    if (qLower.includes(term)) {
      return query.replace(new RegExp(term, 'i'), opposite);
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

  return variations;
}
