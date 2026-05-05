/**
 * LanguageDetector — auto-detect query language and style for prompt parameterization.
 */

import type { LanguageProfile } from './types.js';
import type { DeepResearchLlmClient } from './llm/chat.js';

const KNOWN_LANGS: Record<string, string> = {
   en: 'English',
   zh: 'Chinese',
   de: 'German',
   fr: 'French',
   es: 'Spanish',
   ja: 'Japanese',
   ko: 'Korean',
   pt: 'Portuguese',
   it: 'Italian',
   nl: 'Dutch',
   ru: 'Russian',
   ar: 'Arabic',
   hi: 'Hindi',
};

// eslint-disable-next-line no-control-regex
const LATIN_RANGE = /^[\x00-\x7F\s\p{P}]+$/u;

/**
 * Identify likely script ranges to guess language without LLM calls.
 */
function hasNonLatinChars(text: string): boolean {
   return Array.from(text).some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x7F && code !== 0x200B; // non-ASCII, non-ZWSP
   });
}

/** Estimate tone style from query structure. */
function detectStyle(query: string): string {
   const lower = query.toLowerCase();
   if (/\b(compare|vs|versus|difference|better|best|worst)\b/.test(lower)) return 'comparative';
   if (/\b(how|steps|guide|tutorial|build|implement|create)\b/.test(lower)) return 'technical';
   if (/\b(why|explain|reason|meaning|purpose)\b/.test(lower)) return 'explanatory';
   if (/\b(recommend|opinion|review|worth|should)\b/.test(lower)) return 'persuasive';
   return 'formal';
}

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class LanguageDetector {
   /**
    * Detect language from query text.
    * Fast path: ASCII-only → English.
    * Slow path: non-Latin chars → call LLM or default to English.
    */
   static async detect(
      query: string,
      llm?: DeepResearchLlmClient,
   ): Promise<LanguageProfile> {
      const style = detectStyle(query);

      // Fast path: pure ASCII → English
      if (!hasNonLatinChars(query) && LATIN_RANGE.test(query)) {
         return { code: 'en', style };
      }

      // LLM detection path
      if (llm) {
         try {
            const result = await llm.callJSON<{ langCode: string; langStyle: string }>({
               model: 'worker',
               messages: [
                  {
                     role: 'system',
                     content: `You detect the language and writing style of a query. Output ONLY valid JSON: { "langCode": "en|zh|de|...", "langStyle": "formal|technical|casual|persuasive|explanatory" }.`,
                  },
                  {
                     role: 'user',
                     content: `Detect the language and style of: "${query.slice(0, 200)}"`,
                  },
               ],
               temperature: 0.1,
            });
            if (result.success && result.data.langCode) {
               // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
               const detectedStyle: string = result.data.langStyle ?? style;
               return {
                  code: result.data.langCode,
                  style: detectedStyle,
               };
            }
         } catch {
            // fall through to default
         }
      }

      // Fallback to English
      return { code: 'en', style };
   }

   /** Parameterize a prompt string for a given language profile. */
   static parameterize(prompt: string, lang: LanguageProfile): string {
      const langName = KNOWN_LANGS[lang.code] ?? 'English';
      const prefix = `[Language: ${langName}, Style: ${lang.style}]\n`;
      const suffix =
         lang.code !== 'en'
            ? `\n\nIMPORTANT: Respond in ${langName}. Use writing style: ${lang.style}.`
            : '';
      return prefix + prompt + suffix;
   }
}
