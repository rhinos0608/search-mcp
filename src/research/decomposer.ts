/**
 * QueryDecomposer — Phase 1 of the deep research pipeline.
 *
 * Classifies the user query into one of eight query types, then generates
 * 3–7 template-based sub-questions tailored to that classification.
 *
 * This is a rule-based / template approach (no LLM calls) per the MVP scope.
 */

import { randomUUID } from 'node:crypto';
import type { QueryClassification, SubQuestion, SubQuestionStatus, SourceType } from './types.js';
import type { DeepResearchLlmClient } from './llm/chat.js';
import type { ResearchStateEngine } from './state.js';
import { ORCHESTRATOR_DECOMPOSE } from './llm/prompts.js';

import { logger } from '../logger.js';
// ── Helpers ──────────────────────────────────────────────────────────────────

function makeId(): string {
   return randomUUID().slice(0, 12);
}

// ── Classification rules ─────────────────────────────────────────────────────

interface ClassificationRule {
   classification: QueryClassification;
   patterns: RegExp[];
}

/**
 * Rules evaluated in priority order (first match wins).
 * More specific patterns are listed before generic ones per classification group,
 * and more specific classification groups are listed before broader ones.
 */
const CLASSIFICATION_RULES: ClassificationRule[] = [
   {
      classification: 'comparative',
      patterns: [
         /\b(vs|versus)\b/i,
         /^compare\b/i,
         /\b(difference|differences) (between|among)\b/i,
         /\b(tradeoff|trade-offs|tradeoffs)\b/i,
         /\bpros and cons\b/i,
         /\b(better|best|faster|more efficient|more scalable) (than|between)\b/i,
         /\bwhich (is|are) (a better|the best|more suitable)\b/i,
         /\balternatives?\b/i,
      ],
   },
   {
      classification: 'decision-support',
      patterns: [
         /^should (i|we|they)\b/i,
         /\b(choose|select|pick|decide|recommend|recommendation)\b/i,
         /\bwhich (option|tool|framework|approach|technology|solution)\b/i,
         /\bdecision (framework|matrix|model|guide)\b/i,
         /\b(go with|go for)\b/i,
      ],
   },
   {
      classification: 'technical',
      patterns: [
         /\b(how (to|do|can|would) (i|we|you) )\b/i,
         /\b(implement|implementation)\b/i,
         /\b(architecture|architectural)\b/i,
         /\b(mechanism|mechanisms)\b/i,
         /\bconfiguration|configuring|setup\b/i,
         /\b(deploy|deployment|deploying)\b/i,
         /\bperformance (characteristics?|benchmark|optimization)\b/i,
         /\b(technical details?|internals?|deep dive)\b/i,
      ],
   },
   {
      classification: 'applied-practitioner',
      patterns: [
         /\b(production|real.world|practical)\b/i,
         /\bbest practices?\b/i,
         /\b(lessons learned|experience)\b/i,
         /\b(pitfalls?|gotchas?|common mistakes)\b/i,
         /\b(adoption|migration) (experience|story|path|journey)\b/i,
         /\bhow (companies|teams|organizations?|people) (use|build|adopt)\b/i,
      ],
   },
   {
      classification: 'current-events',
      patterns: [
         /\b(202\d|20[2-9]\d)\b.*\b(advances?|releases?|announcements?|developments?|updates?|breakthroughs?|innovations?|capabilities?)\b/i,
         /\b(advances?|releases?|announcements?|developments?|updates?|breakthroughs?|innovations?|capabilities?)\b.*\b(202\d|20[2-9]\d)\b/i,
         /\b(latest|recent|new|upcoming|emerging)\b.*\b(advances?|releases?|developments?|updates?|models?|features?|capabilities?|breakthroughs?|innovations?)\b/i,
         /^(what are|what is|what were|what have been).*\b(202\d|this year|recently|so far)\b/i,
         /\bso far\b.*\b(202\d|this year)\b/i,
      ],
   },
   {
      classification: 'historical-timeline',
      patterns: [
         /\bhistory\b/i,
         /\b(timeline|evolution)\b/i,
         /\b(origin|origins)\b/i,
         /\b(historical|historic)\b/i,
         /\bhow (did|has) .+ (evolve|change|develop)\b/i,
         /\b(milestone|milestones)\b/i,
         /\b(chronological|timeline)\b/i,
      ],
   },
   {
      classification: 'market-ecosystem',
      patterns: [
         /\b(market|marketplace)\b/i,
         /\b(ecosystem|landscape)\b/i,
         /\b(players?|vendors?|providers?)\b/i,
         /\b(products?|tools?) (for|in)\b/i,
         /\b(adoption rate|market share)\b/i,
         /\b(industry|commercial)\b/i,
      ],
   },
   {
      classification: 'literature-review',
      patterns: [
         /\b(literature|literary)\b/i,
         /\b(research|paper|papers|study|studies)\b/i,
         /\b(state of the art|sota)\b/i,
         /\b(academic|scholarly)\b/i,
         /\b(survey|survey papers?)\b/i,
         /\b(publications?|citations?)\b/i,
      ],
   },
   {
      classification: 'explainer',
      patterns: [
         /^what (is|are|does|was|were)\b/i,
         /^explain\b/i,
         /^define\b/i,
         /\boverview\b/i,
         /\bintroduction\b/i,
         /\b(understand|understanding)\b/i,
         /\b(fundamentals?|basics?|essentials?)\b/i,
         /^tell me about\b/i,
      ],
   },
];

// ── Sub-question templates ──────────────────────────────────────────────────

interface SubQuestionTemplate {
   textTemplate: string;
   evidenceType: string;
   preferredSources: SourceType[];
   freshnessRequirement: string;
   failureModes: string[];
   budgetPriority: number;
}

const SUB_QUESTION_TEMPLATES: Record<QueryClassification, SubQuestionTemplate[]> = {
   explainer: [
      {
         textTemplate: 'What are the fundamental concepts and core definitions of {topic}?',
         evidenceType: 'definitional',
         preferredSources: ['documentation', 'web', 'academic', 'youtube', 'wikipedia'],
         freshnessRequirement: 'any',
         failureModes: ['no sources found', 'contradictory definitions across sources'],
         budgetPriority: 1,
      },
      {
         textTemplate:
            'How does {topic} work at a high level — what is the core mechanism or process?',
         evidenceType: 'mechanism',
         preferredSources: ['documentation', 'web', 'youtube'],
         freshnessRequirement: 'any',
         failureModes: ['oversimplification', 'no accessible introductory sources'],
         budgetPriority: 2,
      },
      {
         textTemplate: 'What are the key components, sub-areas, or dimensions of {topic}?',
         evidenceType: 'taxonomic',
         preferredSources: ['documentation', 'web', 'academic'],
         freshnessRequirement: 'any',
         failureModes: ['overlapping categories', 'incomplete coverage'],
         budgetPriority: 3,
      },
      {
         textTemplate:
            'Why is {topic} important — what problems does it solve or what value does it provide?',
         evidenceType: 'motivational',
         preferredSources: ['web', 'news', 'academic'],
         freshnessRequirement: 'within 2 years',
         failureModes: ['opinion-heavy without evidence', 'dated relevance arguments'],
         budgetPriority: 4,
      },
      {
         textTemplate: 'What is the current state or latest developments in {topic}?',
         evidenceType: 'current-state',
         preferredSources: ['news', 'web', 'academic', 'hackernews'],
         freshnessRequirement: 'within 1 year',
         failureModes: ['stale information', 'rapidly evolving field outpaces sources'],
         budgetPriority: 5,
      },
   ],
   comparative: [
      {
         textTemplate:
            'How do the main options or approaches for {topic} differ from each other?',
         evidenceType: 'comparative',
         preferredSources: ['web', 'documentation', 'academic', 'wikipedia'],
         freshnessRequirement: 'within 2 years',
         failureModes: ['superficial comparison', 'biased comparison favoring one option'],
         budgetPriority: 1,
      },
      {
         textTemplate:
            'What are the strengths, weaknesses, and tradeoffs of each approach to {topic}?',
         evidenceType: 'evaluative',
         preferredSources: ['web', 'reddit', 'hackernews', 'stackoverflow'],
         freshnessRequirement: 'within 2 years',
         failureModes: [
            'missing objective criteria',
            'anecdotal claims without evidence',
            'biased sources',
         ],
         budgetPriority: 2,
      },
      {
         textTemplate:
            'Under what conditions or use cases is each option for {topic} most appropriate?',
         evidenceType: 'contextual',
         preferredSources: ['documentation', 'web', 'stackoverflow'],
         freshnessRequirement: 'within 2 years',
         failureModes: ['missing context-specific guidance', 'outdated recommendations'],
         budgetPriority: 3,
      },
      {
         textTemplate:
            'What objective benchmarks, metrics, or case studies compare options in {topic}?',
         evidenceType: 'empirical',
         preferredSources: ['academic', 'web', 'github', 'news'],
         freshnessRequirement: 'within 3 years',
         failureModes: [
            'inconsistent benchmarks',
            'vendor-produced benchmarks',
            'benchmark not reproducible',
         ],
         budgetPriority: 4,
      },
      {
         textTemplate:
            'What do real users and practitioners report about their experience with different {topic} options?',
         evidenceType: 'practitioner',
         preferredSources: ['reddit', 'hackernews', 'stackoverflow', 'web'],
         freshnessRequirement: 'within 1 year',
         failureModes: ['small sample size', 'selection bias in reviews', 'dated experiences'],
         budgetPriority: 5,
      },
   ],
   technical: [
      {
         textTemplate: 'What is the core architecture or design of {topic}?',
         evidenceType: 'architectural',
         preferredSources: ['documentation', 'github', 'academic'],
         freshnessRequirement: 'within 2 years',
         failureModes: ['incomplete architecture docs', 'version-skewed descriptions'],
         budgetPriority: 1,
      },
      {
         textTemplate:
            'What are the specific implementation patterns and code-level details for {topic}?',
         evidenceType: 'implementation',
         preferredSources: ['documentation', 'github', 'stackoverflow'],
         freshnessRequirement: 'within 1 year',
         failureModes: ['code examples out of date', 'missing edge cases in examples'],
         budgetPriority: 2,
      },
      {
         textTemplate: 'How is {topic} configured, deployed, and operated in practice?',
         evidenceType: 'operational',
         preferredSources: ['documentation', 'github', 'web'],
         freshnessRequirement: 'within 1 year',
         failureModes: ['environment-specific configs not documented', 'outdated deployment guidance'],
         budgetPriority: 3,
      },
      {
         textTemplate:
            'What are the performance characteristics, scalability limits, and optimization strategies for {topic}?',
         evidenceType: 'performance',
         preferredSources: ['academic', 'github', 'web', 'documentation'],
         freshnessRequirement: 'within 2 years',
         failureModes: [
            'benchmark not reproducible',
            'performance varies by workload',
            'stale numbers',
         ],
         budgetPriority: 4,
      },
      {
         textTemplate:
            'What are common pitfalls, gotchas, and failure modes when working with {topic}?',
         evidenceType: 'pitfalls',
         preferredSources: ['stackoverflow', 'reddit', 'hackernews', 'github'],
         freshnessRequirement: 'within 1 year',
         failureModes: ['outdated workarounds', 'version-specific issues not documented'],
         budgetPriority: 5,
      },
   ],
   'applied-practitioner': [
      {
         textTemplate: 'How is {topic} actually used in real-world production environments?',
         evidenceType: 'production-practice',
         preferredSources: ['web', 'reddit', 'hackernews', 'github'],
         freshnessRequirement: 'within 1 year',
         failureModes: [
            'academic-only coverage with no production evidence',
            'theoretical vs actual divergence',
         ],
         budgetPriority: 1,
      },
      {
         textTemplate: 'What are the established best practices and lessons learned for {topic}?',
         evidenceType: 'best-practice',
         preferredSources: ['documentation', 'web', 'github', 'stackoverflow'],
         freshnessRequirement: 'within 2 years',
         failureModes: [
            'outdated best practices',
            'organization-specific practices presented as universal',
         ],
         budgetPriority: 2,
      },
      {
         textTemplate: 'What common mistakes, anti-patterns, and pitfalls exist in {topic}?',
         evidenceType: 'pitfalls',
         preferredSources: ['stackoverflow', 'reddit', 'hackernews', 'web'],
         freshnessRequirement: 'within 1 year',
         failureModes: ['anecdotal without prevalence data', 'version-specific pitfalls not marked'],
         budgetPriority: 3,
      },
      {
         textTemplate: 'What is the tooling, ecosystem, and support landscape around {topic}?',
         evidenceType: 'ecosystem',
         preferredSources: ['github', 'web', 'producthunt', 'documentation'],
         freshnessRequirement: 'within 1 year',
         failureModes: ['rapidly changing ecosystem', 'missing emerging tools'],
         budgetPriority: 4,
      },
      {
         textTemplate:
            'What are the migration paths, adoption stories, and organizational impacts of {topic}?',
         evidenceType: 'migration',
         preferredSources: ['web', 'reddit', 'hackernews', 'youtube'],
         freshnessRequirement: 'within 2 years',
         failureModes: ['survivorship bias in success stories', 'missing failure case studies'],
         budgetPriority: 5,
      },
   ],
   'current-events': [
      {
         textTemplate: 'What specific products, releases, or announcements have been made in {topic}?',
         evidenceType: 'chronological',
         preferredSources: ['news', 'web', 'hackernews'],
         freshnessRequirement: 'within 3 months',
         failureModes: ['no major announcements found', 'outdated information', 'vendor-driven announcements without independent verification'],
         budgetPriority: 1,
      },
      {
         textTemplate: 'What concrete capability improvements, features, or performance gains have been demonstrated in {topic}?',
         evidenceType: 'empirical',
         preferredSources: ['news', 'web', 'hackernews', 'reddit'],
         freshnessRequirement: 'within 3 months',
         failureModes: ['capability claims not independently verified', 'benchmarks not reproducible', 'marketing vs reality gap'],
         budgetPriority: 2,
      },
      {
         textTemplate: 'What benchmarks, evaluation results, or performance metrics have been reported for {topic}?',
         evidenceType: 'benchmark',
         preferredSources: ['web', 'news', 'academic', 'github'],
         freshnessRequirement: 'within 6 months',
         failureModes: ['benchmarks not standardized', 'conflicting benchmark results', 'vendor-produced benchmarks'],
         budgetPriority: 3,
      },
      {
         textTemplate: 'How have industry experts, practitioners, and the community responded to developments in {topic}?',
         evidenceType: 'practitioner',
         preferredSources: ['reddit', 'hackernews', 'web', 'news'],
         freshnessRequirement: 'within 3 months',
         failureModes: ['echo chamber effects', 'small sample size in community reactions', 'selection bias'],
         budgetPriority: 4,
      },
      {
         textTemplate: 'What are the broader implications, adoption trends, and expected next developments for {topic}?',
         evidenceType: 'trend',
         preferredSources: ['news', 'web', 'academic', 'hackernews'],
         freshnessRequirement: 'within 6 months',
         failureModes: ['speculative predictions not marked as such', 'hype-driven analysis', 'limited adoption data'],
         budgetPriority: 5,
      },
   ],
   'historical-timeline': [
      {
         textTemplate: 'What are the origins and early development of {topic}?',
         evidenceType: 'historical',
         preferredSources: ['web', 'academic'],
         freshnessRequirement: 'any',
         failureModes: [
            'rewritten history',
            'missing primary sources',
            'multiple conflicting origin stories',
         ],
         budgetPriority: 1,
      },
      {
         textTemplate: 'What were the key milestones and turning points in the evolution of {topic}?',
         evidenceType: 'chronological',
         preferredSources: ['web', 'academic', 'news'],
         freshnessRequirement: 'any',
         failureModes: ['missing important milestones', 'biased selection of events'],
         budgetPriority: 2,
      },
      {
         textTemplate: 'What major paradigm shifts or disruptive changes have occurred in {topic}?',
         evidenceType: 'transformational',
         preferredSources: ['academic', 'web', 'news'],
         freshnessRequirement: 'any',
         failureModes: ['hard to identify paradigm shifts in real time', 'retrospective bias'],
         budgetPriority: 3,
      },
      {
         textTemplate: 'What are the current trends and trajectory of {topic}?',
         evidenceType: 'trend',
         preferredSources: ['news', 'web', 'academic', 'hackernews'],
         freshnessRequirement: 'within 1 year',
         failureModes: ['noise vs signal in current trends', 'hype-driven analysis'],
         budgetPriority: 4,
      },
      {
         textTemplate: 'What is the projected future direction and next horizon for {topic}?',
         evidenceType: 'forward-looking',
         preferredSources: ['academic', 'web', 'news', 'podcast'],
         freshnessRequirement: 'within 1 year',
         failureModes: ['speculative claims not marked as such', 'overly optimistic projections'],
         budgetPriority: 5,
      },
   ],
   'market-ecosystem': [
      {
         textTemplate: 'What is the current market landscape and size for {topic}?',
         evidenceType: 'market-data',
         preferredSources: ['web', 'news', 'podcast'],
         freshnessRequirement: 'within 1 year',
         failureModes: [
            'outdated market data',
            'contradictory market size estimates',
            'vendor-biased reports',
         ],
         budgetPriority: 1,
      },
      {
         textTemplate: 'Who are the key players, vendors, and products in the {topic} space?',
         evidenceType: 'competitive',
         preferredSources: ['web', 'producthunt', 'news', 'github'],
         freshnessRequirement: 'within 1 year',
         failureModes: ['missing new entrants', 'over-focus on incumbents'],
         budgetPriority: 2,
      },
      {
         textTemplate:
            'What are the adoption patterns, growth rates, and community dynamics of {topic}?',
         evidenceType: 'adoption',
         preferredSources: ['web', 'news', 'github', 'academic'],
         freshnessRequirement: 'within 1 year',
         failureModes: [
            'self-reported adoption not reliable',
            'survivorship bias in community metrics',
         ],
         budgetPriority: 3,
      },
      {
         textTemplate:
            'What are the pricing models, licensing options, and total cost considerations for {topic}?',
         evidenceType: 'commercial',
         preferredSources: ['web', 'producthunt'],
         freshnessRequirement: 'within 1 year',
         failureModes: ['pricing not transparent', 'hidden costs not documented'],
         budgetPriority: 4,
      },
      {
         textTemplate: 'How healthy is the community, talent pool, and ecosystem around {topic}?',
         evidenceType: 'ecosystem-health',
         preferredSources: ['github', 'reddit', 'web', 'hackernews'],
         freshnessRequirement: 'within 6 months',
         failureModes: ['vanity metrics', 'activity not equal to health'],
         budgetPriority: 5,
      },
   ],
   'literature-review': [
      {
         textTemplate:
            'What are the foundational papers, seminal works, and key references for {topic}?',
         evidenceType: 'foundational',
         preferredSources: ['academic', 'pubmed'],
         freshnessRequirement: 'any',
         failureModes: ['missing seminal papers', 'citation bias toward recent work'],
         budgetPriority: 1,
      },
      {
         textTemplate:
            'What is the current research frontier and what are the most active areas of investigation in {topic}?',
         evidenceType: 'research-frontier',
         preferredSources: ['academic'],
         freshnessRequirement: 'within 2 years',
         failureModes: [
            'rapidly moving frontier outpaces recent publications',
            'conference vs journal lag',
         ],
         budgetPriority: 2,
      },
      {
         textTemplate:
            'What are the key findings, established results, and areas of consensus in {topic} research?',
         evidenceType: 'consensus',
         preferredSources: ['academic', 'pubmed'],
         freshnessRequirement: 'within 3 years',
         failureModes: ['overstated consensus', 'seminal results not replicated'],
         budgetPriority: 3,
      },
      {
         textTemplate: 'What are the open questions, debates, and unresolved problems in {topic}?',
         evidenceType: 'open-problems',
         preferredSources: ['academic'],
         freshnessRequirement: 'within 2 years',
         failureModes: ['outdated open problems already solved', 'missing recent debate shifts'],
         budgetPriority: 4,
      },
      {
         textTemplate: 'What meta-analyses, surveys, and comprehensive reviews exist for {topic}?',
         evidenceType: 'survey',
         preferredSources: ['academic', 'pubmed'],
         freshnessRequirement: 'within 3 years',
         failureModes: ['survey may be outdated', 'survey may have selection bias'],
         budgetPriority: 5,
      },
   ],
   'decision-support': [
      {
         textTemplate:
            'What are the key evaluation criteria and decision factors for choosing in {topic}?',
         evidenceType: 'criteria',
         preferredSources: ['web', 'documentation', 'academic'],
         freshnessRequirement: 'within 2 years',
         failureModes: ['missing important criteria', 'generic criteria not specific to context'],
         budgetPriority: 1,
      },
      {
         textTemplate:
            'What are the available options, their features, and how do they compare on key criteria for {topic}?',
         evidenceType: 'comparative',
         preferredSources: ['web', 'reddit', 'hackernews', 'stackoverflow', 'documentation'],
         freshnessRequirement: 'within 1 year',
         failureModes: ['feature matrix not comprehensive', 'biased comparisons from vendors'],
         budgetPriority: 2,
      },
      {
         textTemplate:
            'What decision framework or methodology should be used to evaluate {topic} choices?',
         evidenceType: 'decision-framework',
         preferredSources: ['web', 'academic'],
         freshnessRequirement: 'within 3 years',
         failureModes: ['framework too general', 'framework assumes equal weighting'],
         budgetPriority: 3,
      },
      {
         textTemplate:
            'What are real-world success stories, failure cases, and outcomes from different {topic} decisions?',
         evidenceType: 'case-study',
         preferredSources: ['web', 'reddit', 'hackernews', 'youtube'],
         freshnessRequirement: 'within 2 years',
         failureModes: [
            'survivorship bias',
            'attribution unclear',
            'confounding factors not controlled',
         ],
         budgetPriority: 4,
      },
      {
         textTemplate:
            'What are the implementation risks, migration costs, and ongoing operational considerations for {topic}?',
         evidenceType: 'risk-assessment',
         preferredSources: ['stackoverflow', 'reddit', 'github', 'documentation', 'web'],
         freshnessRequirement: 'within 1 year',
         failureModes: ['hidden costs not surfaced', 'risk probabilities not quantified'],
         budgetPriority: 5,
      },
   ],
};

// ── Topic extraction ─────────────────────────────────────────────────────────

const TOPIC_PREFIX_PATTERNS: RegExp[] = [
   /^(what (is|are|does)|explain|define)\s+/i,
   /^(how (does|do|can|to|would|is))\s+/i,
   /^(why (does|do|is|are|would|should))\s+/i,
   /^(compare (and contrast )?|compare\s+)/i,
   /^(should (i|we|they))\s+/i,
   /^(tell me about|give me (an|a) (overview|introduction) (of|to))\s+/i,
   /^(i want to (know|understand|learn) (about|more about))\s+/i,
];

/**
 * Strip known question-prefix patterns to extract the core topic.
 * Falls back to the original query when nothing matches.
 */
function extractTopic(query: string): string {
   let topic = query.trim();
   for (const pattern of TOPIC_PREFIX_PATTERNS) {
      topic = topic.replace(pattern, '');
   }
   topic = topic.replace(/[?.!]+$/, '').trim();
   topic = topic.replace(/\s+(about|of|the)\s*$/i, '').trim();
   return topic || query;
}

// ── Entity extraction ────────────────────────────────────────────────────────

/**
 * Known domain entities (projects, organizations, facilities, key concepts)
 * mapped to their domains. When detected in the query, entity-targeted
 * sub-questions are appended to ensure coverage.
 */
const KNOWN_ENTITIES: { pattern: RegExp; name: string; domain: string; queryContext: string; contextTerms?: string[] }[] = [
   // Fusion energy
   { pattern: /\bITER\b/i, name: 'ITER', domain: 'fusion energy', queryContext: 'ITER international tokamak experimental reactor project status and timeline' },
   { pattern: /\bSPARC\b/i, name: 'SPARC', domain: 'fusion energy', queryContext: 'SPARC compact fusion reactor by Commonwealth Fusion Systems progress and milestones' },
   { pattern: /\bJET\b/i, name: 'JET', domain: 'fusion energy', queryContext: 'JET Joint European Torus fusion experiment results and decommissioning', contextTerms: ['fusion', 'tokamak', 'plasma', 'iter', 'nuclear'] },
   { pattern: /\bNIF\b/i, name: 'NIF', domain: 'fusion energy', queryContext: 'NIF National Ignition Facility inertial confinement fusion breakthroughs' },
   { pattern: /\b(tokamak|stellarator)\b/i, name: 'tokamak/stellarator', domain: 'fusion energy', queryContext: 'tokamak and stellarator magnetic confinement fusion reactor designs latest advances' },
   // Quantum computing
   { pattern: /\bIBM\s+Quantum\b/i, name: 'IBM Quantum', domain: 'quantum computing', queryContext: 'IBM Quantum computing roadmap and processor milestones' },
   { pattern: /\bSycamore\b/i, name: 'Sycamore', domain: 'quantum computing', queryContext: 'Google Sycamore quantum processor quantum supremacy experiment' },
   // Space
   { pattern: /\b(JWST|James Webb)\b/i, name: 'JWST', domain: 'space telescopes', queryContext: 'James Webb Space Telescope latest discoveries and observations' },
   { pattern: /\bArtemis\b/i, name: 'Artemis', domain: 'space exploration', queryContext: 'NASA Artemis program Moon mission timeline and progress', contextTerms: ['nasa', 'moon', 'lunar', 'orion', 'sls'] },
   { pattern: /\bStarship\b/i, name: 'Starship', domain: 'space exploration', queryContext: 'SpaceX Starship development test flights and milestones', contextTerms: ['spacex', 'rocket', 'launch', 'mars', 'elon'] },
   // AI/ML
   { pattern: /\bGPT-?4\b/i, name: 'GPT-4', domain: 'AI models', queryContext: 'GPT-4 capabilities benchmarks and technical specifications' },
   { pattern: /\bClaude\b/i, name: 'Claude', domain: 'AI models', queryContext: 'Anthropic Claude AI model capabilities and releases', contextTerms: ['ai', 'anthropic', 'llm', 'model', 'gpt'] },
   { pattern: /\bGemini\b/i, name: 'Gemini', domain: 'AI models', queryContext: 'Google Gemini multimodal AI model capabilities and benchmarks', contextTerms: ['ai', 'google', 'llm', 'model', 'gpt'] },
   // Climate/Energy
   { pattern: /\bCOP\d{2}\b/i, name: 'COP', domain: 'climate policy', queryContext: 'UN climate conference outcomes and agreements' },
   { pattern: /\bIPCC\b/i, name: 'IPCC', domain: 'climate science', queryContext: 'IPCC assessment report findings and climate projections' },
];

interface ExtractedEntity {
   name: string;
   domain: string;
   queryContext: string;
}

/**
 * Extract known entities from the query.
 * Returns entities sorted by match priority (earlier match = higher).
 * Deduplicates overlapping matches.
 */
function extractEntities(query: string): ExtractedEntity[] {
   const matches: { entity: (typeof KNOWN_ENTITIES)[number]; index: number }[] = [];
   for (const entity of KNOWN_ENTITIES) {
      const match = entity.pattern.exec(query);
      if (match) {
         // If contextTerms are defined and non-empty, require at least one to appear as a word in the query
         if (entity.contextTerms && entity.contextTerms.length > 0) {
            const hasContext = entity.contextTerms.some((term) => new RegExp(`\\b${term}\\b`, 'i').test(query));
            if (!hasContext) {
               continue;
            }
         }
         matches.push({ entity, index: match.index });
      }
   }
   // Sort by match position (earlier in query = more likely the subject)
   matches.sort((a, b) => a.index - b.index);
   // Deduplicate by name
   const seen = new Set<string>();
   const entities: ExtractedEntity[] = [];
   for (const { entity } of matches) {
      if (!seen.has(entity.name)) {
         seen.add(entity.name);
         entities.push({ name: entity.name, domain: entity.domain, queryContext: entity.queryContext });
      }
   }
   return entities.slice(0, 5); // cap at 5 entities
}

/**
 * Generate entity-targeted sub-questions for each extracted entity.
 * These augment the classification-based templates with specific coverage.
 */
function generateEntitySubQuestions(entities: ExtractedEntity[]): SubQuestion[] {
   const pendingStatus: SubQuestionStatus = 'pending';
   return entities.map((entity, idx) => ({
      id: makeId(),
      text: `What is the current status, recent progress, and key developments for ${entity.name} (${entity.domain})?`,
      classification: 'current-events',
      evidenceType: 'entity-status',
      preferredSources: ['news', 'web', 'academic', 'github', 'youtube', 'reddit'] as SourceType[],
      freshnessRequirement: 'within 1 year',
      failureModes: ['no recent updates found', 'outdated status information'],
      budgetPriority: idx + 1,
      status: pendingStatus,
   }));
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * Match the query against each classification rule group in priority order.
 * Returns the first matching classification, or 'explainer' as default.
 */
function classifyQuery(query: string): QueryClassification {
   for (const rule of CLASSIFICATION_RULES) {
      for (const pattern of rule.patterns) {
         if (pattern.test(query)) {
            return rule.classification;
         }
      }
   }
   return 'explainer';
}

// ── Sub-question generation ──────────────────────────────────────────────────

function fillTemplate(template: string, topic: string): string {
   return template.replace(/\{topic\}/g, topic);
}

function generateSubQuestions(classification: QueryClassification, topic: string): SubQuestion[] {
   const templates = SUB_QUESTION_TEMPLATES[classification];
   const pendingStatus: SubQuestionStatus = 'pending';

   return templates.map((tpl) => ({
      id: makeId(),
      text: fillTemplate(tpl.textTemplate, topic),
      classification,
      evidenceType: tpl.evidenceType,
      preferredSources: [...tpl.preferredSources],
      freshnessRequirement: tpl.freshnessRequirement,
      failureModes: [...tpl.failureModes],
      budgetPriority: tpl.budgetPriority,
      status: pendingStatus,
   }));
}

// ── Plan description ─────────────────────────────────────────────────────────

const PLAN_DESCRIPTIONS: Record<QueryClassification, string> = {
   explainer:
      'Covering fundamental concepts, mechanisms, key components, importance, and current state.',
   comparative:
      'Identifying main options, their tradeoffs, contextual fit, benchmarks, and practitioner experience.',
   technical:
      'Exploring architecture, implementation patterns, operations, performance, and common pitfalls.',
   'applied-practitioner':
      'Investigating real-world usage, best practices, common pitfalls, tooling ecosystem, and migration experiences.',
   'current-events':
      'Covering recent announcements, capability improvements, benchmarks, community response, and adoption trends.',
   'historical-timeline':
      'Tracing origins, key milestones, paradigm shifts, current trends, and future directions.',
   'market-ecosystem':
      'Analyzing market landscape, key players, adoption patterns, pricing, and community health.',
   'literature-review':
      'Surveying foundational papers, research frontier, key findings, open questions, and existing surveys.',
   'decision-support':
      'Establishing evaluation criteria, comparing options, applying decision frameworks, reviewing case studies, and assessing risks.',
};

function generatePlan(classification: QueryClassification, topic: string): string {
   const description = PLAN_DESCRIPTIONS[classification];
   const label = classification.charAt(0).toUpperCase() + classification.slice(1);
   return `${label} research on "${topic}". ${description}`;
}

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_CLASSIFICATIONS = new Set<string>([
   'explainer',
   'comparative',
   'technical',
   'applied-practitioner',
   'current-events',
   'historical-timeline',
   'market-ecosystem',
   'literature-review',
   'decision-support',
]);

const VALID_SOURCE_TYPES = new Set<string>([
   'academic',
   'web',
   'github',
   'reddit',
   'hackernews',
   'stackoverflow',
   'documentation',
   'news',
   'patent',
   'pubmed',
   'wikipedia',
   'podcast',
   'producthunt',
   'youtube',
]);

function normalizeClassification(raw: string): QueryClassification {
   return VALID_CLASSIFICATIONS.has(raw) ? (raw as QueryClassification) : 'explainer';
}

function normalizeSourceTypes(raw: string[]): SourceType[] {
   return raw.filter((s): s is SourceType => VALID_SOURCE_TYPES.has(s));
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface DecomposeResult {
   classification: QueryClassification;
   subQuestions: SubQuestion[];
   /** Human-readable description of the research approach. */
   plan: string;
   /** Topic after disambiguation (may differ from raw extraction). */
   disambiguatedTopic: string;
   /** Whether the topic was disambiguated. */
   wasDisambiguated: boolean;
   /** Optional note explaining disambiguation. */
   disambiguationNote?: string;
   /** Entities extracted from the query for targeted coverage. */
   extractedEntities: { name: string; domain: string }[];
}

/**
 * Rule-based query decomposer.
 *
 * Classifies the input query, extracts the core topic, and generates
 * a set of sub-questions with evidence strategies from per-classification
 * templates.
 *
 * No LLM calls — pure pattern matching and template filling.
 */
export class QueryDecomposer {
   /**
    * Decompose a research query into a classification, sub-questions, and plan.
    *
    * @param query - The raw user query.
    * @returns Classification, sub-questions, and narrative plan.
    */
   decompose(query: string): DecomposeResult {
      const classification = classifyQuery(query);
      const topic = extractTopic(query);
      const entities = extractEntities(query);

      // Generate classification-based sub-questions
      const subQuestions = generateSubQuestions(classification, topic);

      // Append entity-targeted sub-questions for specific entities found in the query
      if (entities.length > 0) {
         const entitySubQuestions = generateEntitySubQuestions(entities);
         subQuestions.push(...entitySubQuestions);
      }

      // Enforce minimum sub-questions — broad queries need at least 3
      const minSQs = MIN_SUBQUESTIONS_BY_CLASSIFICATION[classification] ?? 2;
      if (subQuestions.length < minSQs) {
         logger.warn(
            { classification, subQuestionCount: subQuestions.length, minRequired: minSQs },
            `Decomposition produced ${String(subQuestions.length)} sub-questions for a ${classification} query — below minimum of ${String(minSQs)}. Consider query expansion.`,
         );
      }

      const plan = generatePlan(classification, topic);
      const entityNote = entities.length > 0
         ? ` Also tracking ${String(entities.length)} specific entit${entities.length === 1 ? 'y' : 'ies'}: ${entities.map((e) => e.name).join(', ')}.`
         : '';

      return {
         classification,
         subQuestions,
         plan: plan + entityNote,
         disambiguatedTopic: topic,
         wasDisambiguated: false,
         extractedEntities: entities.map((e) => ({ name: e.name, domain: e.domain })),
      };
   }

   /**
    * LLM-based query decomposition with rule-based fallback.
    *
    * Uses the orchestrator LLM to generate sub-questions with richer context
    * from optional research state. Falls back to rule-based decompose() when
    * the LLM is unavailable or the call fails.
    *
    * @param query - The raw user query.
    * @param llm - Optional LLM client for AI-powered decomposition.
    * @param state - Optional research state for providing context (sources, findings).
    * @returns Classification, sub-questions, and narrative plan.
    */
   async llmDecompose(
      query: string,
      llm?: DeepResearchLlmClient,
      state?: ResearchStateEngine,
   ): Promise<DecomposeResult> {
      if (!llm) {
         return this.decompose(query);
      }

      // ── Step 1: LLM disambiguation + query expansion + entity extraction ──
      let disambiguatedQuery = query;
      let wasAmbiguous = false;
      let disambiguationNote: string | undefined;
      let queryExpansions: string[] = [];
      let entities: { name: string; domain: string }[] = [];

      try {
         const { ORCHESTRATOR_DISAMBIGUATE } = await import('./llm/prompts.js');
         const disambResult = await llm.callJSON<{
            wasAmbiguous: boolean;
            ambiguityNote: string;
            disambiguatedQuery: string;
            queryExpansions: string[];
            extractedEntities?: { name: string; domain: string }[];
         }>({
            model: 'orchestrator',
            messages: [
               { role: 'system' as const, content: ORCHESTRATOR_DISAMBIGUATE },
               { role: 'user' as const, content: query },
            ],
            temperature: 0.3,
         });

         if (disambResult.success) {
            wasAmbiguous = disambResult.data.wasAmbiguous;
            disambiguationNote = disambResult.data.ambiguityNote || undefined;
            if (disambResult.data.disambiguatedQuery) {
               disambiguatedQuery = disambResult.data.disambiguatedQuery;
            }
            queryExpansions = disambResult.data.queryExpansions;
            // Use LLM-identified entities (handles context-aware disambiguation better than regex)
            entities = disambResult.data.extractedEntities ?? [];
         }
      } catch {
         // Fall through — use raw query without disambiguation
      }

      // Fall back to rule-based entity extraction if LLM returned none
      if (entities.length === 0) {
         const ruleBasedEntities = extractEntities(query);
         entities = ruleBasedEntities.map((e) => ({ name: e.name, domain: e.domain }));
      }

      // Build enriched context for decomposition
      let enrichedQuery = disambiguatedQuery;
      if (wasAmbiguous && disambiguationNote) {
         enrichedQuery += `\n\n[Disambiguation: ${disambiguationNote}]`;
      }
      if (queryExpansions.length > 0) {
         enrichedQuery += `\n\n[Query expansions for broader coverage: ${queryExpansions.join(' | ')}]`;
      }
      if (entities.length > 0) {
         enrichedQuery += `\n\n[Key entities to specifically cover with dedicated sub-questions: ${entities.map((e) => `${e.name} (${e.domain})`).join(', ')}]`;
      }

      // Build optional context from research state
      let context = '';
      if (state) {
         const s = state.getState();
         const sourceCount = s.sources.length;
         const findingCount = s.findings.length;
         if (sourceCount > 0 || findingCount > 0) {
            context = `\n\nCurrent research context:\n- Sources found: ${String(sourceCount)}\n- Findings extracted: ${String(findingCount)}`;
            if (s.subQuestions.length > 0) {
               context += `\n- Existing sub-questions: ${s.subQuestions.map((sq) => sq.text).join(' | ')}`;
            }
         }
      }

      // ── Step 2: LLM decomposition ──────────────────────────────────────
      const result = await llm.callJSON<{
         classification: string;
         subQuestions: {
            id: string;
            text: string;
            classification: string;
            evidenceType: string;
            preferredSources: string[];
            freshnessRequirement: string;
            failureModes: string[];
            budgetPriority: number;
         }[];
      }>({
         model: 'orchestrator',
         messages: [
            { role: 'system' as const, content: ORCHESTRATOR_DECOMPOSE },
            { role: 'user' as const, content: `Research query: ${enrichedQuery}${context}` },
         ],
         temperature: 0.3,
      });

      if (!result.success || !result.data.subQuestions.length) {
         logger.warn(
            { error: result.success ? 'Empty sub-questions from LLM' : result.response.error },
            'LLM decompose failed, falling back to rule-based',
         );
         return this.decompose(query);
      }

      const classification = normalizeClassification(result.data.classification);
      const subQuestions: SubQuestion[] = result.data.subQuestions.map((sq) => ({
         id: sq.id || makeId(),
         text: sq.text,
         classification: normalizeClassification(sq.classification),
         evidenceType: sq.evidenceType,
         preferredSources: normalizeSourceTypes(sq.preferredSources),
         freshnessRequirement: sq.freshnessRequirement || 'within 2 years',
         failureModes: sq.failureModes,
         budgetPriority: typeof sq.budgetPriority === 'number' ? sq.budgetPriority : 1,
         status: 'pending',
      }));

      // Enforce minimum sub-questions for the LLM path too
      const minSQs = MIN_SUBQUESTIONS_BY_CLASSIFICATION[classification] ?? 2;
      if (subQuestions.length < minSQs) {
         logger.warn(
            { classification, subQuestionCount: subQuestions.length, minRequired: minSQs },
            `LLM decomposition produced only ${String(subQuestions.length)} sub-questions for a ${classification} query — below minimum of ${String(minSQs)}. SubQuestionCount of 0 or very low suggests the agent is not properly decomposing.`,
         );
      }
      if (subQuestions.length === 0) {
         // LLM returned zero sub-questions — fall back to rule-based
         logger.warn('LLM decompose returned 0 sub-questions, falling back to rule-based');
         return this.decompose(query);
      }

      // Entity-targeted sub-questions are generated organically by the LLM
      // from the entity hints in the enriched query — no template fallback needed.

      const plan = `${classification.charAt(0).toUpperCase() + classification.slice(1)} research on "${query}". LLM-decomposed into ${String(subQuestions.length)} sub-questions.`;

      return {
         classification,
         subQuestions,
         plan,
         disambiguatedTopic: disambiguatedQuery,
         wasDisambiguated: wasAmbiguous,
         ...(disambiguationNote !== undefined ? { disambiguationNote } : {}),
         extractedEntities: entities.map((e) => ({ name: e.name, domain: e.domain })),
      };
   }
}
