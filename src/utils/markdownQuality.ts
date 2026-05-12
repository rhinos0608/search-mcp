/**
 * Comprehensive markdown quality classifier.
 *
 * Assesses whether crawled markdown content is "meaningful" (has real semantic
 * payload) or is dominated by boilerplate — nav/chrome, consent banners, auth
 * walls, JS shells, error pages, search/listing shells, directory card spam,
 * docs sidebars, or social/footer noise.
 *
 * Returns a structured assessment with:
 *  - A 9-class classification (not just binary)
 *  - Weighted positive/negative signal scores
 *  - Per-family boilerplate detection
 *  - Platform-specific hints (GitHub, Docusaurus, Next.js, etc.)
 *  - Recovery recommendations for the middleware chain
 *  - Detailed signal breakdown for before/after quality comparison
 */

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Quality classification categories.
 * Ordered from most meaningful to least.
 */
export type QualityClassification =
   | 'meaningful'
   | 'nav_heavy'
   | 'auth_wall'
   | 'consent_wall'
   | 'js_shell'
   | 'search_shell'
   | 'directory_listing'
   | 'error_or_challenge'
   | 'too_thin'
   | 'mixed_low_confidence';

/** Named boilerplate families detected in the content. */
export type BoilerplateFamily =
   | 'navigation_chrome'
   | 'consent_compliance'
   | 'auth_permission'
   | 'search_listing_shell'
   | 'spa_js_shell'
   | 'marketplace_directory'
   | 'docs_sidebar'
   | 'error_placeholder'
   | 'social_share_footer';

/** Known platform hints for context-aware handling. */
export type PlatformHint =
   | 'github'
   | 'gitlab'
   | 'bitbucket'
   | 'docusaurus'
   | 'mintlify'
   | 'nextra'
   | 'readme'
   | 'gitbook'
   | 'vitepress'
   | 'mkdocs'
   | 'sphinx'
   | 'nextjs'
   | 'cloudflare'
   | 'medium'
   | 'substack'
   | 'stackoverflow'
   | 'stackexchange'
   | 'reddit'
   | 'hackernews'
   | 'npm'
   | 'pypi'
   | null;

export interface PlatformHintResult {
   platform: PlatformHint;
   confidence: number; // 0-1
}

/** A single computed quality signal (0-1 normalized). */
export interface QualitySignal {
   name: string;
   value: number;
   weight: number;
}

/** Aggregated positive and negative scores. */
export interface QualityScore {
   /** Weighted positive score 0-100. Higher = more semantic content. */
   positive: number;
   /** Weighted negative score 0-100. Higher = more boilerplate. */
   negative: number;
   /** overall = positive - negative. Negative values indicate poor quality. */
   overall: number;
   /** Individual positive signal breakdown. */
   positiveSignals: QualitySignal[];
   /** Individual negative signal breakdown. */
   negativeSignals: QualitySignal[];
}

/** Recovery routing recommendation based on classification. */
export interface RecoveryRecommendation {
   /** Retry with aggressive render (JS scrolling, longer wait). */
   retryAggressiveRender: boolean;
   /** Attempt cookie/consent dismissal if browser actions are available. */
   attemptConsentDismissal: boolean;
   /** Attempt Wayback Machine / Google Cache fallback. */
   attemptExternalRecovery: boolean;
   /** Stop retrying — auth walls, hard errors won't resolve with more render attempts. */
   stopRetrying: boolean;
   /** Accept the content as-is (e.g. directory listing for discovery tools). */
   acceptAsIs: boolean;
}

/** Structured result from assessMarkdownQuality. */
export interface MarkdownQualityAssessment {
   /** Whether the content is semantically meaningful for extraction. */
   meaningful: boolean;
   /** Detailed classification. */
   classification: QualityClassification;
   /** Human-readable reasons for the assessment. */
   reasons: string[];
   /** Weighted quality scores. */
   score: QualityScore;
   /** Detected platform hint, if any. */
   platformHint: PlatformHintResult;
   /** Recovery routing recommendation. */
   recovery: RecoveryRecommendation;
   /** Boilerplate families detected in the content. */
   boilerplateFamilies: BoilerplateFamily[];
}

/** Context for assessment — improves accuracy for domain-specific content. */
export interface AssessmentContext {
   /** The intended use of the content. */
   intent?: 'article' | 'documentation' | 'repository_readme' | 'search_results' | 'directory' | 'qa' | 'code_reference' | 'unknown';
   /** URL of the crawled page (for platform detection). */
   url?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_MEANINGFUL_CHARS = 40;
const SHORT_LINE_THRESHOLD = 35;
const LONG_PARAGRAPH_MIN_CHARS = 100;

// ── Empty / trivial checks ───────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS: RegExp[] = [
   /^loading\.?\.?\.?$/i,
   /^please wait$/i,
   /^just a moment$/i,
   /^enable javascript$/i,
   /^you need to enable javascript$/i,
   /^this page requires javascript$/i,
   /^loading content$/i,
];

// ── Boilerplate family patterns ──────────────────────────────────────────────

/** Each family has an array of regex patterns and a detection weight. */
export interface BoilerplateFamilyDetector {
   family: BoilerplateFamily;
   patterns: RegExp[];
   /**
    * Weight for how strongly a match in this family contributes to
    * the negative score. 1.0 = normal, >1.0 = stronger signal.
    */
   weight: number;
}

/**
 * Line-level patterns organized by boilerplate family.
 * Each pattern is tested against a single trimmed line.
 */
export const BOILERPLATE_FAMILIES: BoilerplateFamilyDetector[] = [
   // ── Navigation/chrome ────────────────────────────────────────────────────
   {
      family: 'navigation_chrome',
      weight: 1.0,
      patterns: [
         // Skip / accessibility links
         /^skip to (?:main )?content$/i,
         /^skip to navigation$/i,
         // Toggle / menu labels
         /^toggle (?:navigation|menu|sidebar|theme)$/i,
         /^(?:open|close) (?:menu|navigation|sidebar|search)$/i,
         /^(?:menu|navigation)$/i,
         /^main navigation$/i,
         /^(?:navigation|footer)\s*(?:menu)?$/i,
         // Table of contents / on this page
         /^table of contents$/i,
         /^on this page$/i,
         /^in this article$/i,
         // Feedback / edit
         /^was this page helpful\??$/i,
         /^edit this page$/i,
         // Prev / next navigation
         /^previous$/i,
         /^next$/i,
         /^back to top$/i,
         // Generic nav labels
         /^(?:home|about|contact|login|logout|register|signup|pricing|features|docs|blog|faq|help|support|status|community|careers|press|partners|sitemap)\s*$/i,
         // Nav section bullets
         /^\s*[*\-+]\s+(?:platform|solutions|resources|products|company|explore|learn|more from|tools|developer|partners|support|enterprise|team|pricing|blog|docs|help|status|community|about|careers|press|contact|terms|privacy|cookies)\s*$/i,
         // By-something
         /^\s*[*\-+]\s+by\s+\w+/i,
         // Capitalized nav headings
         /^\s*[*\-+]\s+(?:ai|ci\/cd|developer|application|api|code|devops|devsecops|security|explore|why)\s+\w+/i,
         // Heading-level nav markers
         /^##+\s+(?:navigation|footer|sidebar|menu|search|provide feedback)/i,
         // Footer nav headings
         /^###\s+footer navigation/i,
         // Search UI
         /^search (?:or jump|code|repositories|docs|documentation)$/i,
         /^search syntax tips$/i,
         /^provide feedback$/i,
         // Breadcrumbs
         /^[a-z][a-z\s]*\s*>\s*[a-z]/i,
         // Last updated / modified
         /^last (?:updated|modified|edited)\s*:?/i,
         /^posted (?:on|by|at)\b/i,
         /^published (?:on|by|at)\b/i,
         /^updated (?:on|by|at)\b/i,
         /^modified (?:on|by|at)\b/i,
         /^version\s*\d/i,
         /^language\s*:?/i,
         // Markdown link wrapped content (e.g. "[Sign in](url)")
         /^\[skip to (?:content|main|text|navigation)\]/i,
         /^\[sign\s+(?:in|up)\]/i,
         /^\[cancel\]/i,
         // GitHub/boilerplate UI text (no $ anchor)
         /^sign\s+(?:in|up)/i,
         /^search (?:or jump|code|repositories)/i,
         /^provide feedback/i,
         /^manage cookies/i,
         /^do not share/i,
         /^include my email/i,
         /^we read every piece/i,
         /^appearance settings/i,
         /^search syntax tips/i,
         // Bracket-nav markers: [Cancel] [Feedback] etc
         /^\[[^\]]+\]\s*\[[^\]]+\]/i,
         // Single bullet links: * [Link](url)
         /^\s*[*\-+]\s+\[[^\]]+\]\([^)]+\)\s*$/,
         // Nav rows: [Link] | [Link] • [Link]
         /^(?:\[[^\]]+\]\([^)]+\)\s*[|•·*/]\s*)*\[[^\]]+\]\([^)]+\)$/,
         // Bullet nav rows: * [Link] | [Link] • [Link]
         /^\s*[*\-+]\s+\[[^\]]+\]\([^)]+\)(?:\s*[|•·*/]\s*\[[^\]]+\]\([^)]+\))+/,
      ],
   },

   // ── Consent / compliance ─────────────────────────────────────────────────
   {
      family: 'consent_compliance',
      weight: 1.2,
      patterns: [
         /^accept (?:all )?(?:cookies)?$/i,
         /^reject (?:all )?(?:cookies)?$/i,
         /^manage (?:cookies|preferences|privacy)$/i,
         /^privacy (?:policy|settings|preferences)$/i,
         /^cookies? policy$/i,
         /^terms(?: of service)?$/i,
         /^cookie policy$/i,
         /^do not sell/i,
         /^your privacy choices$/i,
         /^(?:we use cookies|this site uses cookies)/i,
         /^cookie settings$/i,
         /^accept cookies$/i,
         /^reject cookies$/i,
         /^customize cookies$/i,
      ],
   },

   // ── Auth / permission walls ──────────────────────────────────────────────
   {
      family: 'auth_permission',
      weight: 1.5, // Strong signal — few false positives
      patterns: [
         /^sign\s+(?:in|up)/i,
         /^log\s+in/i,
         /^log\s+out/i,
         /^create account$/i,
         /^register$/i,
         /^continue with\s+(?:google|github|apple|twitter|facebook|microsoft|linkedin)/i,
         /^you must (?:be logged in|sign in|have an account)/i,
         /^access denied/i,
         /^private (?:repository|page|content)/i,
         /^enable cookies to (?:continue|sign in)/i,
         /^sign in to (?:your account|continue)/i,
         /^login$/i,
      ],
   },

   // ── Search / listing shells ──────────────────────────────────────────────
   {
      family: 'search_listing_shell',
      weight: 0.8,
      patterns: [
         /^search$/i,
         /^search docs$/i,
         /^search documentation$/i,
         /^filter by/i,
         /^sort by/i,
         /^show more$/i,
         /^show less$/i,
         /^no results/i,
         /^showing results for/i,
         /^related searches/i,
         /^popular searches/i,
         /^did you mean/i,
         /^search results for/i,
         /^refine by/i,
         /^clear all filters/i,
         /^no (?:results|items|posts|articles) found/i,
      ],
   },

   // ── SPA / JS shells ──────────────────────────────────────────────────────
   {
      family: 'spa_js_shell',
      weight: 1.3,
      patterns: [
         /^enable javascript$/i,
         /^please enable javascript$/i,
         /^loading\.{0,3}$/i,
         /^please wait$/i,
         /^this page requires javascript/i,
         /^loading content$/i,
         /^loading\.\.\.$/i,
         /^javascript required/i,
         /^your browser does not support javascript/i,
      ],
   },

   // ── Marketplace / directory card spam ────────────────────────────────────
   {
      family: 'marketplace_directory',
      weight: 0.7,
      patterns: [
         /^learn more$/i,
         /^read more$/i,
         /^view details$/i,
         /^view all$/i,
         /^(?:stars?|forks?|watchers?):?\s*\d/i,
         /^install$/i,
         /^pricing$/i,
         /^category$/i,
         /^buy now$/i,
         /^get started$/i,
         /^try (?:now|free|for free)$/i,
         /^subscribe$/i,
         /^copy$/i,
         /^share$/i,
         /^follow$/i,
         /^download$/i,
         /^open$/i,
         /^star\s*\d+/i,
         /^fork\s*\d+/i,
      ],
   },

   // ── Docs sidebar ─────────────────────────────────────────────────────────
   {
      family: 'docs_sidebar',
      weight: 0.9,
      patterns: [
         /^getting started$/i,
         /^quickstart$/i,
         /^api reference$/i,
         /^api docs$/i,
         /^sdk\//i,
         /^cli\//i,
         /^changelog$/i,
         /^examples$/i,
         /^tutorials$/i,
         /^migration guide/i,
         /^faq$/i,
         /^release notes/i,
         /^contributing$/i,
         /^code of conduct/i,
         /^license$/i,
      ],
   },

   // ── Error / placeholder pages ────────────────────────────────────────────
   {
      family: 'error_placeholder',
      weight: 1.5,
      patterns: [
         /^404$/i,
         /^#\s*404/i,
         /^403$/i,
         /^#\s*403/i,
         /^not found$/i,
         /^access denied$/i,
         /^too many requests$/i,
         /^checking your browser/i,
         /^verify you are human/i,
         /^captcha$/i,
         /^(?:this )?page (?:could )?not be found/i,
         /^something went wrong/i,
         /^temporarily unavailable/i,
         /^service unavailable/i,
         /^(?:performance & security by|protected by) cloudflare/i,
         /^ray id:/i,
         /^(?:just a moment|please stand by)/i,
         /^checking if the site connection is secure/i,
      ],
   },

   // ── Social / share / footer ──────────────────────────────────────────────
   {
      family: 'social_share_footer',
      weight: 0.6,
      patterns: [
         /^share (?:on|this)/i,
         /^tweet/i,
         /^post to/i,
         /^(?:follow|share|connect|subscribe)\s*(?:us)?\s*:?/i,
         /^newsletter/i,
         /^subscribe/i,
         /^copyright\s/i,
         /^©/i,
         /^all rights reserved/i,
         /^powered by/i,
         /^built with/i,
         /^contact (?:us|support|sales)/i,
         /^careers?$/i,
      ],
   },
];

/** Flatten all patterns from all families for quick classification. */
export const ALL_BOILERPLATE_PATTERNS: readonly {
   pattern: RegExp;
   family: BoilerplateFamily;
   weight: number;
}[] = BOILERPLATE_FAMILIES.flatMap((f) =>
   f.patterns.map((p) => ({ pattern: p, family: f.family, weight: f.weight })),
);

// ── Platform-specific hints ──────────────────────────────────────────────────

interface PlatformDetector {
   platform: PlatformHint;
   /** Patterns tested against trimmed lines. */
   linePatterns: RegExp[];
   /** Patterns tested against the full document (for framework/data markers). */
   docPatterns: RegExp[];
   priority: number;
}

const PLATFORM_DETECTORS: PlatformDetector[] = [
   {
      platform: 'github',
      priority: 10,
      linePatterns: [
         /^repository (?:nav|navigation)$/i,
         /^(?:issues|pull requests|actions|projects|security|insights|code|blame|raw|permalink)$/i,
      ],
      docPatterns: [
         /github\.com\/[^/]+\/[^/]+/,
         /__NEXT_DATA__/,
      ],
   },
   {
      platform: 'gitlab',
      priority: 10,
      linePatterns: [
         /^repository$/i,
         /^merge requests/i,
         /^ci\/cd/i,
         /^deploy tokens/i,
      ],
      docPatterns: [/gitlab\.com\//],
   },
   {
      platform: 'docusaurus',
      priority: 5,
      linePatterns: [],
      docPatterns: [/docusaurus/i, /@docusaurus/i, /docusaurus_version/i],
   },
   {
      platform: 'mintlify',
      priority: 5,
      linePatterns: [],
      docPatterns: [/mintlify/i, /mint\.json/i],
   },
   {
      platform: 'nextra',
      priority: 5,
      linePatterns: [],
      docPatterns: [/nextra/i, /themeconfig/i],
   },
   {
      platform: 'nextjs',
      priority: 5,
      linePatterns: [],
      docPatterns: [/__NEXT_DATA__/i, /self\.__next_f\.push/i],
   },
   {
      platform: 'cloudflare',
      priority: 10,
      linePatterns: [],
      docPatterns: [
         /cloudflare/i,
         /checking if the site connection is secure/i,
         /ray id:/i,
      ],
   },
   {
      platform: 'medium',
      priority: 5,
      linePatterns: [/^open in app$/i, /^member[-\s]only story$/i, /^continue reading$/i],
      docPatterns: [/medium\.com\//],
   },
   {
      platform: 'substack',
      priority: 5,
      linePatterns: [/^subscribe$/i, /^listen to this post/i],
      docPatterns: [/substack\.com\//, /substackcdn\.com\//],
   },
   {
      platform: 'stackoverflow',
      priority: 10,
      linePatterns: [
         /^teams$/i,
         /^ask questions?$/i,
         /^collectives$/i,
         /^products$/i,
         /^overflowai/i,
      ],
      docPatterns: [/stackoverflow\.com\//, /stackexchange\.com\//],
   },
   {
      platform: 'stackexchange',
      priority: 5,
      linePatterns: [],
      docPatterns: [/stackexchange\.com\//],
   },
   {
      platform: 'reddit',
      priority: 5,
      linePatterns: [],
      docPatterns: [/reddit\.com\//, /redd\.it\//],
   },
   {
      platform: 'hackernews',
      priority: 5,
      linePatterns: [],
      docPatterns: [/news\.ycombinator\.com\//, /hn\.algolia\.com\//],
   },
   {
      platform: 'npm',
      priority: 5,
      linePatterns: [],
      docPatterns: [/npmjs\.com\//, /npm\.js\//],
   },
   {
      platform: 'pypi',
      priority: 5,
      linePatterns: [],
      docPatterns: [/pypi\.org\//, /pypi\.python\.org\//],
   },
];

// ── Structural smell detectors ───────────────────────────────────────────────

interface StructuralSignals {
   /** Ratio of lines matching boilerplate patterns. */
   boilerplateLineRatio: number;
   /** Characters consumed by markdown links / total chars. */
   linkCharRatio: number;
   /** Ratio of non-empty lines under SHORT_LINE_THRESHOLD chars. */
   shortLineRatio: number;
   /** Ratio of lines that are action-oriented button/card phrases. */
   actionLineRatio: number;
   /** Count of lines matching auth patterns. */
   authLineCount: number;
   /** Count of lines matching consent patterns. */
   consentLineCount: number;
   /** Count of lines matching JS shell patterns. */
   jsShellLineCount: number;
   /** Count of lines matching error patterns. */
   errorLineCount: number;
   /** Score for repeated 2-5 word phrases (0-1). */
   repeatedPhraseScore: number;
   /** Ratio of headings that have little or no body after them. */
   headingWithoutBodyRatio: number;
   /** Ratio of duplicate lines among non-empty lines. */
   duplicateLineRatio: number;
   /** Lines that look like markdown link navigation rows. */
   linkNavRowCount: number;
   /** Lines that look like single bullet links. */
   bulletLinkCount: number;
   /** Lines that are markdown bracket groups (e.g., [Cancel] [Feedback]). */
   bracketNavCount: number;
}

// ── Positive content signals ─────────────────────────────────────────────────

export const README_SECTION_PATTERNS = [
   /^##\s+(?:installation|getting started|quickstart|usage|examples?|api|configuration|setup|guide|tutorials?|contributing|license|changelog|roadmap|known issues|faq)/i,
];

export const DOMAIN_CONTENT_PATTERNS: Record<string, RegExp[]> = {
   // Software docs
   documentation: [/^```/, /^## (?:api|usage|examples?|installation|configuration|reference)/i],
   // Academic
   academic: [/^abstract$/i, /^introduction$/i, /^methodology$/i, /^results$/i, /^conclusion$/i, /^references$/i],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function countLines(markdown: string): string[] {
   return markdown.split('\n');
}

function nonEmptyLines(lines: string[]): string[] {
   return lines.filter((l) => l.trim().length > 0);
}



/** Count sentence-ending punctuation in a text. */
function countSentences(text: string): number {
   const matches = text.match(/[.!?](?:\s|$)/g);
   return matches ? matches.length : 0;
}

/** Count code blocks (fenced). */
function countCodeBlocks(lines: string[]): number {
   let count = 0;
   let inFence = false;
   for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
         if (inFence) {
            inFence = false;
         } else {
            inFence = true;
            count++;
         }
      }
   }
   return count;
}

/** Count table rows (lines starting with |). */
function countTableRows(lines: string[]): number {
   return lines.filter((l) => l.trimStart().startsWith('|')).length;
}

/** Count deep headings (h2+) that are followed by substantial body text. */
function countDeepHeadingsWithBody(lines: string[]): number {
   let count = 0;
   for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? "").trim();
      // Skip navigation/boilerplate headings
      if (/^##+\s+(?:navigation|footer|sidebar|menu|search|provide feedback)/i.test(line)) continue;
      if (/^##+\s+(?:on this page|table of contents|in this article)/i.test(line)) continue;
      if (/^#{2,6}\s/.test(line)) {
         // Look at next non-empty, non-heading lines
         let bodyChars = 0;
         for (let j = i + 1; j < lines.length; j++) {
            const next = (lines[j] ?? "").trim();
            if (/^#{1,6}\s/.test(next) || next.length === 0) break;
            bodyChars += next.length;
         }
         if (bodyChars > 50) count++;
      }
   }
   return count;
}

/** Count long paragraphs (runs of non-heading, non-empty text >100 chars). */
/** Check if a line looks like boilerplate nav content (bullet link, section marker, etc.). */
function isNavLikeLine(trimmed: string): boolean {
   if (trimmed.length === 0) return false;
   // Bullet links: * [Link](url)
   if (/^\s*[*\-+]\s+\[[^\]]+\]\([^)]+\)/.test(trimmed)) return true;
   // Bullet nav sections: * Platform, * Solutions
   if (/^\s*[*\-+]\s+(?:platform|solutions|resources|products|company|explore|learn|more from|tools|developer|partners|support|enterprise|team|pricing|blog|docs|help|status|community|about|careers|press|contact|terms|privacy|cookies|by\s+\w+)/i.test(trimmed)) return true;
   // Nav rows: [Link] | [Link]
   if (/^(?:\[[^\]]+\]\([^)]+\)\s*[|•·*/]\s*)+/.test(trimmed)) return true;
   // Pure nav links: [Link](url) without prose
   if (/^\[[^\]]+\]\([^)]+\)$/.test(trimmed)) return true;
   return false;
}

function countLongParagraphs(lines: string[]): number {
   let count = 0;
   let currentPara = '';
   for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || /^#{1,6}\s/.test(trimmed) || trimmed.startsWith("|") || trimmed.startsWith('```') || isNavLikeLine(trimmed)) {
         if (currentPara.length >= LONG_PARAGRAPH_MIN_CHARS) count++;
         currentPara = '';
      } else {
         currentPara += ' ' + trimmed;
      }
   }
   if (currentPara.length >= LONG_PARAGRAPH_MIN_CHARS) count++;
   return count;
}

/** Compute repeated phrase score (0-1). */
function computeRepeatedPhraseScore(lines: string[]): number {
   // Check for repeated 2-5 word phrases across lines
   const phrases = new Map<string, number>();
   for (const line of lines) {
      const trimmed = line.trim().toLowerCase();
      const words = trimmed.split(/\s+/).filter(Boolean);
      // Extract 2-4 word subsequences
      for (let len = 2; len <= 4; len++) {
         for (let i = 0; i <= words.length - len; i++) {
            const phrase = words.slice(i, i + len).join(' ');
            if (phrase.length > 5) {
               // Only meaningful phrases
               phrases.set(phrase, (phrases.get(phrase) ?? 0) + 1);
            }
         }
      }
   }
   // Count phrases that appear 3+ times
   let repeatedCount = 0;
   let totalPhrases = 0;
   for (const count of phrases.values()) {
      totalPhrases++;
      if (count >= 3) repeatedCount++;
   }
   if (totalPhrases === 0) return 0;
   const ratio = repeatedCount / totalPhrases;
   // Cap at 1.0; typical meaningful docs have <0.1
   return Math.min(ratio * 3, 1);
}

/** Compute duplicate line ratio. */
function computeDuplicateLineRatio(lines: string[]): number {
   if (lines.length === 0) return 0;
   const seen = new Map<string, number>();
   for (const line of lines) {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.length > 5) {
         // Ignore very short duplicates
         seen.set(trimmed, (seen.get(trimmed) ?? 0) + 1);
      }
   }
   let duplicates = 0;
   for (const count of seen.values()) {
      if (count >= 2) duplicates += count - 1;
   }
   return duplicates / lines.length;
}

// ── Platform detection ───────────────────────────────────────────────────────

function detectPlatform(markdown: string): PlatformHintResult {
   const lines = countLines(markdown);
   const detected: { platform: PlatformHint; confidence: number; priority: number }[] = [];

   for (const detector of PLATFORM_DETECTORS) {
      let hits = 0;
      // Line patterns
      for (const line of lines) {
         const trimmed = line.trim();
         for (const pattern of detector.linePatterns) {
            if (pattern.test(trimmed)) hits++;
         }
      }
      // Doc patterns
      for (const pattern of detector.docPatterns) {
         if (pattern.test(markdown)) hits += 2; // Doc patterns are stronger
      }
      if (hits > 0) {
         detected.push({
            platform: detector.platform,
            confidence: Math.min(hits / 5, 1),
            priority: detector.priority,
         });
      }
   }

   if (detected.length === 0) {
      return { platform: null, confidence: 0 };
   }

   // Pick highest confidence, then highest priority
   detected.sort((a, b) => b.confidence - a.confidence || b.priority - a.priority);
   return { platform: detected[0]?.platform ?? null, confidence: detected[0]?.confidence ?? 0 };
}

// ── Structural smell computation ─────────────────────────────────────────────

function computeStructuralSignals(lines: string[], nonEmpty: string[], markdown: string): StructuralSignals {
   const normalized = markdown.replace(/\s+/g, ' ').trim();
   const totalLines = nonEmpty.length;

   // Boilerplate line ratio (per-family, summed)
   let boilerplateLineCount = 0;
   for (const line of nonEmpty) {
      const trimmed = line.trim();
      for (const entry of ALL_BOILERPLATE_PATTERNS) {
         if (entry.pattern.test(trimmed)) {
            boilerplateLineCount++;
            break; // Count each line once
         }
      }
   }

   // Link char ratio
   const linkMatches = normalized.match(/\[[^\]]+\]\([^)]+\)/g);
   const linkChars = linkMatches ? linkMatches.reduce((sum, m) => sum + m.length, 0) : 0;
   const linkCharRatio = normalized.length > 0 ? linkChars / normalized.length : 0;

   // Short line ratio (excluding fence lines because code has short lines)
   const shortLines = nonEmpty.filter((l) => {
      const trimmed = l.trim();
      return trimmed.length > 0 && trimmed.length < SHORT_LINE_THRESHOLD && !trimmed.startsWith('```') && !trimmed.startsWith('~~~');
   });

   // Action line ratio
   const ACTION_PATTERNS = [
      /^(?:learn more|read more|view details|view all|install|buy now|get started|try (?:now|free)|subscribe|copy|share|follow|download|open|star|fork|sign up|sign in|log in|create account)/i,
   ];
   const actionLines = nonEmpty.filter((l) => ACTION_PATTERNS.some((p) => p.test(l.trim())));

   // Family-specific counts
   const authLines = nonEmpty.filter((l) => {
      const trimmed = l.trim();
      return BOILERPLATE_FAMILIES
         .find((f) => f.family === 'auth_permission')
         ?.patterns.some((p) => p.test(trimmed));
   });

   const consentLines = nonEmpty.filter((l) => {
      const trimmed = l.trim();
      return BOILERPLATE_FAMILIES
         .find((f) => f.family === 'consent_compliance')
         ?.patterns.some((p) => p.test(trimmed));
   });

   const jsShellLines = nonEmpty.filter((l) => {
      const trimmed = l.trim();
      return BOILERPLATE_FAMILIES
         .find((f) => f.family === 'spa_js_shell')
         ?.patterns.some((p) => p.test(trimmed));
   });

   const errorLines = nonEmpty.filter((l) => {
      const trimmed = l.trim();
      return BOILERPLATE_FAMILIES
         .find((f) => f.family === 'error_placeholder')
         ?.patterns.some((p) => p.test(trimmed));
   });

   // Repeated phrase score
   const repeatedPhraseScore = computeRepeatedPhraseScore(nonEmpty);

   // Heading without body ratio
   let headingWithoutBody = 0;
   let totalHeadings = 0;
   for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? "").trim();
      if (/^#{1,6}\s/.test(line)) {
         totalHeadings++;
         // Check next non-empty line
         let hasBody = false;
         for (let j = i + 1; j < lines.length; j++) {
            const next = (lines[j] ?? "").trim();
            if (next.length === 0) continue;
            if (/^#{1,6}\s/.test(next)) break;
            if (next.length > 40) {
               hasBody = true;
               break;
            }
            break; // Only check first non-empty line after heading
         }
         if (!hasBody) headingWithoutBody++;
      }
   }

   // Duplicate line ratio
   const duplicateLineRatio = computeDuplicateLineRatio(nonEmpty);

   // Link nav rows (3+ inline links)
   let linkNavRowCount = 0;
   for (const line of nonEmpty) {
      const linkM = line.match(/\[[^\]]+\]\([^)]+\)/g);
      if (linkM && linkM.length >= 3) {
         const lc = linkM.reduce((s, m) => s + m.length, 0);
         if (lc / line.length > 0.5) linkNavRowCount++;
      }
   }

   // Bullet links (single)
   const bulletLinkCount = nonEmpty.filter((l) => /^\s*[*\-+]\s+\[[^\]]+\]\([^)]+\)\s*$/.test(l.trim())).length;

   // Bracket nav
   const bracketNavCount = nonEmpty.filter((l) => /^\[[^\]]+\]\s*\[[^\]]+\]/i.test(l.trim())).length;

   return {
      boilerplateLineRatio: totalLines > 0 ? boilerplateLineCount / totalLines : 0,
      linkCharRatio,
      shortLineRatio: totalLines > 0 ? shortLines.length / totalLines : 0,
      actionLineRatio: totalLines > 0 ? actionLines.length / totalLines : 0,
      authLineCount: authLines.length,
      consentLineCount: consentLines.length,
      jsShellLineCount: jsShellLines.length,
      errorLineCount: errorLines.length,
      repeatedPhraseScore,
      headingWithoutBodyRatio: totalHeadings > 0 ? headingWithoutBody / totalHeadings : 0,
      duplicateLineRatio,
      linkNavRowCount,
      bulletLinkCount,
      bracketNavCount,
   };
}

// ── Positive content signals ─────────────────────────────────────────────────

interface ContentSignals {
   longParagraphCount: number;
   sentenceCount: number;
   contentWordCount: number;
   codeBlockCount: number;
   tableRowCount: number;
   deepHeadingWithBodyCount: number;
   readmeSectionHits: number;
   domainContentHits: number;
}

function computeContentSignals(lines: string[], markdown: string): ContentSignals {
   return {
      longParagraphCount: countLongParagraphs(lines),
      sentenceCount: countSentences(markdown),
      contentWordCount: markdown.replace(/\s+/g, ' ').trim().split(/\s+/).filter(Boolean).length,
      codeBlockCount: countCodeBlocks(lines),
      tableRowCount: countTableRows(lines),
      deepHeadingWithBodyCount: countDeepHeadingsWithBody(lines),
      readmeSectionHits: README_SECTION_PATTERNS.filter((p) => p.test(markdown)).length,
      domainContentHits: 0, // Simplified: could be extended
   };
}

// ── Scoring model ────────────────────────────────────────────────────────────

/** Compute weighted positive score (0-100). */
function computePositiveScore(signals: ContentSignals): { score: number; signals: QualitySignal[] } {
   // Normalize each signal to 0-1, then multiply by weight
   const raw: QualitySignal[] = [
      { name: 'longParagraphs', value: Math.min(signals.longParagraphCount / 5, 1), weight: 25 },
      { name: 'sentenceDensity', value: Math.min(signals.sentenceCount / 20, 1), weight: 15 },
      { name: 'contentWords', value: Math.min(signals.contentWordCount / 200, 1), weight: 10 },
      { name: 'codeBlocks', value: Math.min(signals.codeBlockCount / 3, 1), weight: 10 },
      { name: 'tableRows', value: Math.min(signals.tableRowCount / 8, 1), weight: 5 },
      { name: 'deepHeadingsWithBody', value: Math.min(signals.deepHeadingWithBodyCount / 4, 1), weight: 15 },
      { name: 'readmeSections', value: Math.min(signals.readmeSectionHits / 3, 1), weight: 10 },
      { name: 'domainContent', value: Math.min(signals.domainContentHits / 3, 1), weight: 10 },
   ];

   const totalWeight = raw.reduce((sum, s) => sum + s.weight, 0);
   const weightedSum = raw.reduce((sum, s) => sum + s.value * s.weight, 0);
   const score = totalWeight > 0 ? (weightedSum / totalWeight) * 100 : 0;

   return { score, signals: raw };
}

/** Compute weighted negative score (0-100). */
function computeNegativeScore(structural: StructuralSignals): { score: number; signals: QualitySignal[] } {
   const raw: QualitySignal[] = [
      { name: 'boilerplateLineRatio', value: structural.boilerplateLineRatio, weight: 20 },
      { name: 'linkCharRatio', value: structural.linkCharRatio, weight: 15 },
      { name: 'shortLineRatio', value: structural.shortLineRatio, weight: 10 },
      { name: 'actionLineRatio', value: structural.actionLineRatio, weight: 10 },
      { name: 'authLineCount', value: Math.min(structural.authLineCount / 3, 1), weight: 10 },
      { name: 'consentLineCount', value: Math.min(structural.consentLineCount / 3, 1), weight: 5 },
      { name: 'jsShellLineCount', value: Math.min(structural.jsShellLineCount / 2, 1), weight: 10 },
      { name: 'errorLineCount', value: Math.min(structural.errorLineCount / 2, 1), weight: 10 },
      { name: 'repeatedPhraseScore', value: structural.repeatedPhraseScore, weight: 5 },
      { name: 'headingWithoutBodyRatio', value: structural.headingWithoutBodyRatio, weight: 5 },
   ];

   const totalWeight = raw.reduce((sum, s) => sum + s.weight, 0);
   const weightedSum = raw.reduce((sum, s) => sum + s.value * s.weight, 0);
   const score = totalWeight > 0 ? (weightedSum / totalWeight) * 100 : 0;

   return { score, signals: raw };
}

// ── Boilerplate family detection ─────────────────────────────────────────────

function detectBoilerplateFamilies(lines: string[]): {
   families: BoilerplateFamily[];
   familyHits: Map<BoilerplateFamily, number>;
} {
   const hits = new Map<BoilerplateFamily, number>();

   for (const line of lines) {
      const trimmed = line.trim();
      for (const entry of ALL_BOILERPLATE_PATTERNS) {
         if (entry.pattern.test(trimmed)) {
            hits.set(entry.family, (hits.get(entry.family) ?? 0) + 1);
         }
      }
   }

   const families: BoilerplateFamily[] = [];
   for (const [family, count] of hits) {
      if (count >= 2) {
         // Require at least 2 hits to declare a family present
         families.push(family);
      }
   }

   return { families, familyHits: hits };
}

// ── Classification logic ─────────────────────────────────────────────────────

function classifyQuality(
   positiveScore: number,
   negativeScore: number,
   structural: StructuralSignals,
   contentSignals: ContentSignals,
   families: BoilerplateFamily[],
   normalized: string,
): { classification: QualityClassification; reasons: string[] } {
   const reasons: string[] = [];

   // Is the positive score high enough?
   const hasDecentContent = positiveScore >= 35;

   // Is the negative score low enough?
   const isNotTooBoilerplate = negativeScore < 60;

   // Check extreme individual signals
   const extremeNav = structural.boilerplateLineRatio > 0.6;
   const extremeLink = structural.linkCharRatio > 0.5 && contentSignals.contentWordCount < 50;
   const extremeAuth = structural.authLineCount >= 3;
   const extremeConsent = structural.consentLineCount >= 3;
   const extremeJsShell = structural.jsShellLineCount >= 2;
   const extremeError = structural.errorLineCount >= 2;
   const extremeAction = structural.actionLineRatio > 0.3 && contentSignals.contentWordCount < 50;
   const extremeHeadingNoBody = structural.headingWithoutBodyRatio > 0.8 && contentSignals.contentWordCount < 50;

   // Content quality guards: if there are meaningful content elements, override boilerplate signals
   const hasCodeBlocks = contentSignals.codeBlockCount > 0;
   const hasLongParagraphs = contentSignals.longParagraphCount > 0;
   const hasDeepHeadingsWithBody = contentSignals.deepHeadingWithBodyCount >= 2;
   const hasTables = contentSignals.tableRowCount >= 3;
   const hasSentences = contentSignals.sentenceCount >= 10;

   // ── Phase 1: Strong semantic payload overrides boilerplate ───────────────
   // If the content has genuine semantic value (code, tables, long prose),
   // classify as meaningful even if some boilerplate patterns fire.
   const hasStrongPayload = (
      (hasCodeBlocks || hasDeepHeadingsWithBody || hasTables) && hasLongParagraphs
   ) || (hasSentences && hasLongParagraphs);

   if (hasStrongPayload && isNotTooBoilerplate) {
      reasons.push('meaningful content with code/tables/headings');
      return { classification: 'meaningful', reasons };
   }

   // ── Phase 2: Extreme negative signals ────────────────────────────────────
   // Auth walls, error pages, consent walls, JS shells are unambiguous.
   if (extremeAuth || (families.includes('auth_permission') && structural.authLineCount >= 3)) {
      reasons.push(`auth wall detected (${String(structural.authLineCount)} auth lines)`);
      return { classification: 'auth_wall', reasons };
   }

   if (extremeError || (families.includes('error_placeholder') && structural.errorLineCount >= 2)) {
      reasons.push(`error/challenge page (${String(structural.errorLineCount)} error lines)`);
      return { classification: 'error_or_challenge', reasons };
   }

   if (extremeConsent || (families.includes('consent_compliance') && structural.consentLineCount >= 3)) {
      reasons.push(`consent wall detected (${String(structural.consentLineCount)} consent lines)`);
      return { classification: 'consent_wall', reasons };
   }

   if (extremeJsShell) {
      reasons.push(`JS shell page (${String(structural.jsShellLineCount)} JS-required lines)`);
      return { classification: 'js_shell', reasons };
   }

   // ── Phase 3: Combined nav+link detection ─────────────────────────────────
   // When boilerplate line ratio is very high and link density is elevated,
   // classify as nav_heavy even if positive score seems decent.
   const hasHighBoilerplate = structural.boilerplateLineRatio > 0.7;
   const hasNavFamily = families.includes('navigation_chrome');
   const hasElevatedLinks = structural.linkCharRatio > 0.4;
   const hasLowPayload = contentSignals.contentWordCount < 100 && !hasLongParagraphs;

   if (hasHighBoilerplate && hasNavFamily && (hasElevatedLinks || hasLowPayload)) {
      reasons.push(
         `nav-heavy content (${String(Math.round(structural.boilerplateLineRatio * 100))}% boilerplate lines, ` +
         `${String(Math.round(structural.linkCharRatio * 100))}% link chars, ` +
         `${String(contentSignals.contentWordCount)} words)`,
      );
      return { classification: 'nav_heavy', reasons };
   }

   // Strong nav signal without link density
   if (extremeNav) {
      reasons.push(`nav-heavy content (${String(Math.round(structural.boilerplateLineRatio * 100))}% boilerplate lines)`);
      return { classification: 'nav_heavy', reasons };
   }

   // ── Phase 4: Other low-quality patterns ──────────────────────────────────
   if (extremeLink || extremeAction) {
      reasons.push('link/action-dense content with low semantic payload');
      return { classification: 'directory_listing', reasons };
   }

   if (extremeHeadingNoBody) {
      reasons.push('headings without body content');
      return { classification: 'search_shell', reasons };
   }

   if (families.includes('search_listing_shell') && structural.shortLineRatio > 0.5) {
      reasons.push('search/listing shell content');
      return { classification: 'search_shell', reasons };
   }

   // ── Phase 5: Decent content, not excessively boilerplate ────────────────
   if (hasDecentContent && isNotTooBoilerplate) {
      reasons.push('adequate positive signals');
      return { classification: 'meaningful', reasons };
   }

   // ── Phase 6: Content too thin or mixed ──────────────────────────────────
   if (normalized.length < MIN_MEANINGFUL_CHARS && positiveScore < 20) {
      reasons.push(`too little content (${String(normalized.length)} chars, ${String(contentSignals.contentWordCount)} words)`);
      return { classification: 'too_thin', reasons };
   }

   if (!hasDecentContent && negativeScore > 40) {
      reasons.push(`mixed low-quality content (positive=${String(Math.round(positiveScore))}, negative=${String(Math.round(negativeScore))})`);
      return { classification: 'mixed_low_confidence', reasons };
   }

   if (positiveScore < 20) {
      reasons.push(`insufficient content quality (score=${String(Math.round(positiveScore))})`);
      return { classification: 'too_thin', reasons };
   }

   // Fallback: meaningful if we got here
   reasons.push('adequate content quality');
   return { classification: 'meaningful', reasons };
}

// ── Recovery routing ─────────────────────────────────────────────────────────

function computeRecoveryRecommendation(classification: QualityClassification): RecoveryRecommendation {
   switch (classification) {
      case 'meaningful':
         return {
            retryAggressiveRender: false,
            attemptConsentDismissal: false,
            attemptExternalRecovery: false,
            stopRetrying: false,
            acceptAsIs: true,
         };
      case 'nav_heavy':
         return {
            retryAggressiveRender: true,
            attemptConsentDismissal: false,
            attemptExternalRecovery: false,
            stopRetrying: false,
            acceptAsIs: false,
         };
      case 'js_shell':
         return {
            retryAggressiveRender: true,
            attemptConsentDismissal: false,
            attemptExternalRecovery: false,
            stopRetrying: false,
            acceptAsIs: false,
         };
      case 'consent_wall':
         return {
            retryAggressiveRender: false,
            attemptConsentDismissal: true,
            attemptExternalRecovery: false,
            stopRetrying: false,
            acceptAsIs: false,
         };
      case 'auth_wall':
         return {
            retryAggressiveRender: false,
            attemptConsentDismissal: false,
            attemptExternalRecovery: false,
            stopRetrying: true,
            acceptAsIs: false,
         };
      case 'error_or_challenge':
         return {
            retryAggressiveRender: false,
            attemptConsentDismissal: false,
            attemptExternalRecovery: true,
            stopRetrying: false,
            acceptAsIs: false,
         };
      case 'search_shell':
         return {
            retryAggressiveRender: false,
            attemptConsentDismissal: false,
            attemptExternalRecovery: false,
            stopRetrying: false,
            acceptAsIs: false,
         };
      case 'directory_listing':
         return {
            retryAggressiveRender: false,
            attemptConsentDismissal: false,
            attemptExternalRecovery: false,
            stopRetrying: false,
            acceptAsIs: false,
         };
      case 'too_thin':
         return {
            retryAggressiveRender: true,
            attemptConsentDismissal: false,
            attemptExternalRecovery: false,
            stopRetrying: false,
            acceptAsIs: false,
         };
      case 'mixed_low_confidence':
         return {
            retryAggressiveRender: true,
            attemptConsentDismissal: false,
            attemptExternalRecovery: false,
            stopRetrying: false,
            acceptAsIs: false,
         };
   }
}


/**
 * Assess the quality of crawled markdown content.
 *
 * Returns a structured assessment with classification, scoring, boilerplate
 * family detection, platform hints, and recovery routing recommendations.
 */
export function assessMarkdownQuality(
   markdown: string,
   _context?: AssessmentContext,
): MarkdownQualityAssessment {
   const normalized = markdown.replace(/\s+/g, ' ').trim();

   // Empty / near-empty
   if (normalized.length === 0) {
      return {
         meaningful: false,
         classification: 'too_thin',
         reasons: ['empty content'],
         score: { positive: 0, negative: 0, overall: 0, positiveSignals: [], negativeSignals: [] },
         platformHint: { platform: null, confidence: 0 },
         recovery: computeRecoveryRecommendation('too_thin'),
         boilerplateFamilies: [],
      };
   }

   // Placeholder content (single-line pages that are just "Loading...")
   if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized))) {
      return {
         meaningful: false,
         classification: 'js_shell',
         reasons: ['placeholder content'],
         score: { positive: 0, negative: 0, overall: 0, positiveSignals: [], negativeSignals: [] },
         platformHint: { platform: null, confidence: 0 },
         recovery: computeRecoveryRecommendation('js_shell'),
         boilerplateFamilies: [],
      };
   }

   const lines = countLines(markdown);
   const nonEmpty = nonEmptyLines(lines);

   const structural = computeStructuralSignals(lines, nonEmpty, markdown);
   const contentSignals = computeContentSignals(lines, markdown);
   const { families } = detectBoilerplateFamilies(nonEmpty);

   // ── Weighted scoring ─────────────────────────────────────────────────────
   const { score: positiveScore, signals: positiveSignals } = computePositiveScore(contentSignals);
   const { score: negativeScore, signals: negativeSignals } = computeNegativeScore(structural);
   const overall = positiveScore - negativeScore;

   // ── Classification ───────────────────────────────────────────────────────
   const { classification, reasons } = classifyQuality(
      positiveScore,
      negativeScore,
      structural,
      contentSignals,
      families,
      normalized,
   );

   // ── Platform detection ───────────────────────────────────────────────────
   const platformHint = detectPlatform(markdown);

   // ── Recovery routing ─────────────────────────────────────────────────────
   const recovery = computeRecoveryRecommendation(classification);

   // ── Result ───────────────────────────────────────────────────────────────
   return {
      meaningful: classification === 'meaningful',
      classification,
      reasons,
      score: {
         positive: Math.round(positiveScore * 10) / 10,
         negative: Math.round(negativeScore * 10) / 10,
         overall: Math.round(overall * 10) / 10,
         positiveSignals,
         negativeSignals,
      },
      platformHint,
      recovery,
      boilerplateFamilies: families,
   };
}

/**
 * Assess batch quality across multiple markdown pages.
 * Returns the best assessment across all pages.
 */
export function assessMarkdownBatchQuality(
   markdowns: string[],
   context?: AssessmentContext,
): MarkdownQualityAssessment {
   const nonEmpty = markdowns.filter((m) => m.trim().length > 0);
   if (nonEmpty.length === 0) {
      return {
         meaningful: false,
         classification: 'too_thin',
         reasons: ['no successful markdown content'],
         score: { positive: 0, negative: 0, overall: 0, positiveSignals: [], negativeSignals: [] },
         platformHint: { platform: null, confidence: 0 },
         recovery: computeRecoveryRecommendation('too_thin'),
         boilerplateFamilies: [],
      };
   }

   const assessments = nonEmpty.map((m) => assessMarkdownQuality(m, context));
   const meaningfulAssessments = assessments.filter((a) => a.meaningful);

   if (meaningfulAssessments.length > 0) {
      // Return the best meaningful assessment
      const sorted = [...meaningfulAssessments].sort(
        (a, b) => b.score.positive - a.score.positive,
      );
      const best = sorted[0];
      if (!best) throw new Error('Impossible: non-empty array');
      return {
         ...best,
         reasons: [],
      };
   }

   // Aggregate non-meaningful
   const allReasons = assessments.flatMap((a) => a.reasons);
   if (assessments.length === 0) {
      // Should not happen because nonEmpty was already validated
      throw new Error('Impossible: empty assessment array');
   }
   const first = assessments[0];
   // Guaranteed non-empty due to guard above; avoids assertions vs lint rules
   if (!first) throw new Error('Impossible: non-empty assessment array');
   const worst = assessments.reduce<MarkdownQualityAssessment>((min, a) =>
      a.score.overall < min.score.overall ? a : min, first,
   );

   return {
      ...worst,
      meaningful: false,
      reasons: allReasons.length > 0 ? allReasons : ['no meaningful content detected'],
   };
}

/**
 * Compare quality before and after a transformation (e.g., aggressive render).
 * Returns deltas for key metrics.
 */
export interface QualityComparison {
   improved: boolean;
   deltas: {
      positiveScore: number;
      negativeScore: number;
      overallScore: number;
      contentWordCount: number;
      longParagraphCount: number;
      deepHeadingWithBodyCount: number;
      codeBlockCount: number;
      boilerplateLineRatio: number;
      linkCharRatio: number;
   };
   summary: string;
}

/**
 * Compare quality before and after a recovery attempt.
 * Use to decide whether the recovery actually improved semantic quality.
 */
export function compareQuality(
   before: MarkdownQualityAssessment,
   after: MarkdownQualityAssessment,
): QualityComparison {
   const deltas = {
      positiveScore: after.score.positive - before.score.positive,
      negativeScore: after.score.negative - before.score.negative,
      overallScore: after.score.overall - before.score.overall,
      contentWordCount: 0,
      longParagraphCount: 0,
      deepHeadingWithBodyCount: 0,
      codeBlockCount: 0,
      boilerplateLineRatio: 0,
      linkCharRatio: 0,
   };

   // Extract signal deltas where available
   const beforePos = before.score.positiveSignals;
   const afterPos = after.score.positiveSignals;
   if (beforePos.length > 0 && afterPos.length > 0) {
      const findSignal = (signals: QualitySignal[], name: string) =>
         signals.find((s) => s.name === name);

      const bWords = findSignal(beforePos, 'contentWords');
      const aWords = findSignal(afterPos, 'contentWords');
      if (bWords && aWords) deltas.contentWordCount = Math.round((aWords.value - bWords.value) * 200);

      const bParas = findSignal(beforePos, 'longParagraphs');
      const aParas = findSignal(afterPos, 'longParagraphs');
      if (bParas && aParas) deltas.longParagraphCount = Math.round((aParas.value - bParas.value) * 5);

      const bHeadings = findSignal(beforePos, 'deepHeadingsWithBody');
      const aHeadings = findSignal(afterPos, 'deepHeadingsWithBody');
      if (bHeadings && aHeadings) deltas.deepHeadingWithBodyCount = Math.round((aHeadings.value - bHeadings.value) * 4);

      const bCode = findSignal(beforePos, 'codeBlocks');
      const aCode = findSignal(afterPos, 'codeBlocks');
      if (bCode && aCode) deltas.codeBlockCount = Math.round((aCode.value - bCode.value) * 3);
   }

   const beforeNeg = before.score.negativeSignals;
   const afterNeg = after.score.negativeSignals;
   if (beforeNeg.length > 0 && afterNeg.length > 0) {
      const findSignal = (signals: QualitySignal[], name: string) =>
         signals.find((s) => s.name === name);

      const bBoiler = findSignal(beforeNeg, 'boilerplateLineRatio');
      const aBoiler = findSignal(afterNeg, 'boilerplateLineRatio');
      if (bBoiler && aBoiler) deltas.boilerplateLineRatio = Math.round((aBoiler.value - bBoiler.value) * 100);

      const bLink = findSignal(beforeNeg, 'linkCharRatio');
      const aLink = findSignal(afterNeg, 'linkCharRatio');
      if (bLink && aLink) deltas.linkCharRatio = Math.round((aLink.value - bLink.value) * 100);
   }

   const improved = deltas.overallScore > 5 && deltas.positiveScore > 0;
   const summary = improved
      ? `Quality improved: +${String(Math.round(deltas.overallScore))} overall (positive +${String(Math.round(deltas.positiveScore))}, negative ${String(Math.round(deltas.negativeScore))})`
      : `Quality flat or degraded: ${String(Math.round(deltas.overallScore))} overall (positive ${String(Math.round(deltas.positiveScore))}, negative ${String(Math.round(deltas.negativeScore))})`;

   return { improved, deltas, summary };
}
