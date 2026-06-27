/**
 * AgentStrategy — LLM-driven ReAct agent for deep research.
 */

import type { ResearchStrategy, StrategyContext } from './types.js';
import type { AgentTool, ToolResult } from './agentTools.js';
import { buildAgentTools, describeTools } from './agentTools.js';
import { CitationCollector } from '../citationCollector.js';
import type { ResearchResult, ResearchReport, ResearchProgress, SourceType } from '../types.js';
import { curateEvidenceSources } from '../sourceQuality.js';
import { logger } from '../../logger.js';
import { randomUUID } from 'node:crypto';
import type { DomainRoute } from '../domainRouter.js';
import type { ExtractedEntities } from '../entityExtractor.js';
import { extractEntities, generateEntityBasedQueries } from '../entityExtractor.js';
import { routeQuery } from '../domainRouter.js';
import { extractJsonCandidates } from '../../utils/jsonFromText.js';
import {
  extractFindingsFromAnswerLlm,
  extractFindingsFromAnswerRuleBased,
  type AnswerFindingInput,
} from './answerFindings.js';

// ── Constants ────────────────────────────────────────────────────────────

const FALLBACK_SYNTHESIS_MAX_TOKENS = 4000;

// ── Balanced-brace JSON extractor ───────────────────────────────────────

/**
 * Extracts the JSON object following "ARGUMENTS:".
 * Tolerates markdown fences, extra whitespace/newlines, and escaped
 * characters by delegating to extractJsonCandidates.
 *
 * Prefers a *valid* JSON object, but will return a malformed object-shaped
 * candidate so the caller can emit a precise "Invalid JSON" error rather than
 * a generic "no ARGUMENTS found" message.
 */
export function extractJsonArg(text: string): string | null {
  const idx = text.indexOf('ARGUMENTS:');
  if (idx === -1) return null;

  // Grab everything after ARGUMENTS: up to the next section marker
  const after = text.slice(idx + 'ARGUMENTS:'.length);
  const nextSection = /\n(?:THOUGHT|ACTION|ANSWER):/i.exec(after);
  const candidateBlock = nextSection ? after.slice(0, nextSection.index) : after;

  // 1. Try a direct parse of the trimmed block
  const trimmed = candidateBlock.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      if (trimmed.startsWith('{')) return trimmed;
      // arrays are not valid tool arguments
    } catch {
      // fall through to candidate extraction
    }
  }

  // 2. Use the robust fence-aware extractor
  const candidates = extractJsonCandidates(candidateBlock);
  let firstObjectCandidate: string | null = null;

  for (const candidate of candidates) {
    if (!candidate.trim().startsWith('{')) continue;
    firstObjectCandidate ??= candidate;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return candidate;
      }
    } catch {
      // malformed JSON — keep firstObjectCandidate and continue
    }
  }

  // Return the malformed candidate so the caller can report a precise parse error
  return firstObjectCandidate;
}

// ── Response parser ──────────────────────────────────────────────────────

export interface ParsedResponse {
  type: 'action' | 'answer' | 'error';
  thought: string;
  tool?: string;
  args?: Record<string, unknown>;
  content?: string;
  message?: string;
  raw?: string;
}

export function parseAgentResponse(text: string): ParsedResponse {
  const thoughtMatch = /THOUGHT:\s*([\s\S]*?)(?=\n?\s*(?:ACTION|ANSWER):|$)/i.exec(text);
  const actionMatch = /ACTION:\s*(\S+)/i.exec(text);
  const argsJson = extractJsonArg(text);
  const answerMatch = /ANSWER:\s*([\s\S]*)/i.exec(text);

  if (answerMatch) {
    return {
      type: 'answer',
      content: (answerMatch[1] ?? '').trim(),
      thought: thoughtMatch?.[1]?.trim() ?? '',
      raw: text,
    };
  }

  if (actionMatch && argsJson) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      // JSON parse failed — pass raw text through so the orchestrator can
      // synthesise from it later instead of dropping the iteration entirely.
      args = { _rawArgs: argsJson };
    }
    return {
      type: 'action',
      thought: thoughtMatch?.[1]?.trim() ?? '',
      tool: (actionMatch[1] ?? '').trim(),
      args,
      raw: text,
    };
  }

  if (actionMatch && !argsJson) {
    return {
      type: 'error',
      message:
        'ACTION specified but no ARGUMENTS found. Format: ACTION: tool_name\nARGUMENTS: {"key": "value"}',
      thought: thoughtMatch?.[1]?.trim() ?? '',
      raw: text,
    };
  }

  return {
    type: 'error',
    message: 'Could not parse response. Use THOUGHT/ACTION/ARGUMENTS or ANSWER format.',
    thought: thoughtMatch?.[1]?.trim() ?? '',
    content: text,
    raw: text,
  };
}

// ── Agent history entry ──────────────────────────────────────────────────

interface AgentHistoryEntry {
  role: 'assistant' | 'tool' | 'system';
  thought?: string | undefined;
  action?: string | undefined;
  args?: Record<string, unknown> | undefined;
  tool?: string | undefined;
  content?: string | undefined;
  error?: string | undefined;
}

// ── AgentStrategy ────────────────────────────────────────────────────────

export class AgentStrategy implements ResearchStrategy {
  readonly name = 'agent';
  readonly description =
    'LLM-driven ReAct agent with tool-calling. Adapts research approach based on findings.';
  readonly requiresLlm = true;

  private maxIterations: number;
  private tools: AgentTool[];
  private collector: CitationCollector;
  private history: AgentHistoryEntry[] = [];
  private seededQueries: string[] = [];

  constructor(ctx: StrategyContext, collector?: CitationCollector) {
    this.maxIterations = ctx.config.agentMaxIterations;
    this.collector = collector ?? new CitationCollector();
    this.tools = buildAgentTools(ctx, this.collector);
  }

  async analyze(query: string, ctx: StrategyContext): Promise<ResearchResult> {
    void ctx.onProgress?.(5, `Agent starting research: ${query.slice(0, 80)}`, 'agent_init', {
      classification: 'explainer',
      subQuestionCount: ctx.state.getSubQuestions().length,
      sourceCount: 0,
      findingCount: 0,
    });

    const entities = ctx.entities ?? extractEntities(query);
    const route = ctx.route ?? routeQuery(query, entities);
    const seededQueries = generateEntityBasedQueries(entities, 3, query);
    this.seededQueries = seededQueries;

    // Create a default sub-question for agent findings so they are visible to coverage/gap analysis
    const existingSq = ctx.state.getSubQuestions().find((sq) => sq.text === query);
    const defaultSqId = existingSq?.id ?? `agent-${randomUUID().slice(0, 12)}`;
    if (!existingSq) {
      ctx.state.addSubQuestion({
        id: defaultSqId,
        text: query,
        classification: 'explainer' as const,
        evidenceType: 'general',
        preferredSources: [],
        freshnessRequirement: 'any',
        failureModes: [],
        budgetPriority: 1,
        status: 'pending' as const,
      });
    }

    const systemPrompt = this.buildSystemPrompt(route, entities);
    let iteration = 0;
    let finalAnswer: string | null = null;

    while (iteration < this.maxIterations) {
      if (ctx.abortSignal?.aborted) {
        logger.info('Agent aborted');
        break;
      }
      iteration++;

      try {
        const response = await this.callLlm(systemPrompt, query, ctx);
        if (response === null) {
          logger.warn({ iteration }, 'LLM call returned null, breaking loop');
          break;
        }

        const parsed = parseAgentResponse(response);

        if (parsed.type === 'answer') {
          finalAnswer = parsed.content ?? 'No answer provided.';
          logger.info({ iteration }, 'Agent produced final answer');
          break;
        }

        if (parsed.type === 'action' && parsed.tool) {
          const toolResult = await this.executeTool(parsed.tool, parsed.args ?? {});
          this.history.push({
            role: 'assistant',
            thought: parsed.thought || undefined,
            action: parsed.tool,
            args: parsed.args,
          });
          this.history.push({
            role: 'tool',
            tool: parsed.tool,
            content: toolResult.content.slice(0, 8000),
          });

          const progress = 5 + Math.round((iteration / this.maxIterations) * 85);
          void ctx.onProgress?.(
            progress,
            `Agent step ${String(iteration)}/${String(this.maxIterations)}: ${parsed.tool}`,
            'agent_step',
            {
              sourceCount: this.collector.count,
              findingCount: ctx.state.findingCount(),
            },
          );
          continue;
        }

        if (parsed.type === 'error') {
          this.history.push({
            role: 'assistant',
            thought: parsed.thought || undefined,
            content: response, // Keep raw response for synthesis & history
            error: parsed.message,
          });
          logger.warn({ iteration, error: parsed.message }, 'Agent parse error');

          // Record as observation in state diary to ensure it reaches final synthesis
          if (response.trim().length > 50) {
            ctx.state.appendDiary(
              `[Agent Observation - Iteration ${String(iteration)}]: ${response.trim()}`,
            );
          }
        }
      } catch (err) {
        logger.error({ err, iteration }, 'Agent loop error');
        this.history.push({
          role: 'system',
          error: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // ── Fallback synthesis ────────────────────────────────────────────
    if (!finalAnswer) {
      const hadToolResults = this.history.some((h) => h.role === 'tool');
      if (!hadToolResults) {
        // LLM failed before any tools ran — signal unusable LLM to the orchestrator
        logger.info(
          { iterations: iteration, sources: this.collector.count },
          'Agent LLM unusable (no tool results collected), signalling for pipeline fallback',
        );
        const report: ResearchReport = {
          query,
          classification: 'explainer' as const,
          depth: ctx.depth,
          degradationMode: 'source_note_synthesis' as const,
          executiveSummary:
            'LLM was unavailable. Research could not proceed with the agent strategy.',
          narrativeMarkdown:
            'Deep research could not be completed: the LLM was unavailable or timed out before any research tools could be executed.' +
            '\n\nA deterministic pipeline fallback should be used instead.',
          themes: [],
          contradictions: [],
          uncertainties: ['LLM unavailable for agent strategy'],
          sourceNotes: [],
          openQuestions: [query],
          limitations: ['Agent strategy failed due to LLM unavailability.'],
          sourceCount: 0,
          findingCount: 0,
          sourceTypeCount: 0,
          sourceDiversity: [],
          evidenceSources: [],
        };
        return { report, timeline: [{ phase: 'complete' }] };
      }

      logger.info(
        { iterations: iteration, sources: this.collector.count },
        'Agent max iterations exceeded, falling back to synthesis',
      );
      finalAnswer = await this.synthesizeFallback(query, ctx);
    }

    const answerWithSources = this.formatFinalAnswer(finalAnswer);

    // Sync collector sources to state to enable findings attribution
    const citations = this.collector.getAll();
    const sourceMap = new Map<number, string>(); // citation index -> state source id

    for (const citation of citations) {
      const existing = ctx.state.getSources().find((s) => s.url === citation.url);
      if (existing) {
        sourceMap.set(citation.index, existing.id);
        continue;
      }

      let domain: string;
      try {
        domain = new URL(citation.url).hostname.replace(/^www\./, '');
      } catch {
        domain = citation.url;
      }
      const sourceId = ctx.state.addSource({
        id: randomUUID().slice(0, 12),
        title: citation.title,
        url: citation.url,
        sourceType: citation.sourceType as SourceType,
        domain,
        accessDate: new Date().toISOString(),
        isPrimary: false, // Will be updated by classifySourceTier if used
        relevantSubQuestions: [],
        extractionStatus: 'extracted',
        subQuestionId: '',
      });
      sourceMap.set(citation.index, sourceId);
    }

    // Extract findings from final answer and populate state
    await this.extractFindingsFromAnswer(finalAnswer, ctx, sourceMap, defaultSqId);

    const sourceTypeCounts = new Map<string, number>();
    for (const citation of citations) {
      sourceTypeCounts.set(
        citation.sourceType,
        (sourceTypeCounts.get(citation.sourceType) ?? 0) + 1,
      );
    }

    void ctx.onProgress?.(95, 'Agent research complete', 'agent_complete');

    // Build ResearchResult
    const report: ResearchReport = {
      query,
      classification: 'explainer',
      depth: ctx.depth,
      degradationMode:
        ctx.state.findingCount() === 0 ? ('source_note_synthesis' as const) : ('deep' as const),
      executiveSummary: answerWithSources.slice(0, 500),
      narrativeMarkdown: answerWithSources,
      themes:
        ctx.state.getState().findings.length > 0
          ? [
              {
                title: 'Key Findings',
                narrative: 'Extracted results from agent research.',
                findings: ctx.state.getFindings().map((f) => f.claim),
              },
            ]
          : [],
      contradictions: ctx.state.getState().contradictions,
      uncertainties: ctx.state.getState().openQuestions,
      sourceNotes: this.collector.count > 0 ? [this.collector.formatSourceList()] : [],
      openQuestions: [],
      limitations: ['Agent-driven research — limited by tool availability and iteration budget.'],
      sourceCount: this.collector.count,
      findingCount: ctx.state.findingCount(),
      sourceTypeCount: sourceTypeCounts.size,
      sourceDiversity: [...sourceTypeCounts.entries()].map(([type, count]) => ({ type, count })),
      evidenceSources: curateEvidenceSources(ctx.state.getSources(), ctx.state.getFindings()).map(
        (c, i) => ({
          index: i + 1,
          title: c.source.title,
          url: c.source.url,
          sourceType: c.source.sourceType,
          tier: c.tier,
          domain: c.source.domain,
        }),
      ),
    };

    const timeline: ResearchProgress[] = [{ phase: 'complete' }];

    return { report, timeline, canonicalFindings: [...ctx.state.getFindings()] };
  }

  async close(): Promise<void> {
    this.collector.reset();
    this.history = [];
  }

  // ── Private ─────────────────────────────────────────────────────────

  private buildSystemPrompt(route?: DomainRoute, entities?: ExtractedEntities): string {
    const today = new Date().toISOString().slice(0, 10);
    const toolDesc = describeTools(this.tools);

    let preamble = '';
    if (route) {
      preamble += `\nQuery domain: ${route.category} (confidence: ${route.confidence.toFixed(2)})\n`;
      preamble += `Preferred source types: ${route.primaryBackends.join(', ')}\n`;
    }
    if (entities) {
      preamble += `Extracted entities: ${JSON.stringify(entities)}\n`;
    }

    return `You are an exhaustive research agent conducting deep multi-source investigation. Today's date: ${today}.${preamble}

CRITICAL RULES:
1. You MUST search for information before answering. Do NOT answer from memory.
2. DECOMPOSE the question into distinct sub-topics and research each one.
3. Use AT LEAST 5 DIFFERENT TOOL TYPES — never rely on search_web alone. You have access to dedicated connectors: search_arxiv, search_hackernews, search_stackexchange, search_semantic_scholar, search_pubmed, search_wikipedia, search_academic and more. A web-only answer is INCOMPLETE — actively pull from community, video, and primary literature sources, not just generic web pages.
4. Search each sub-topic across MULTIPLE source categories (e.g., academic papers, community discussions, code repositories, documentation).
5. Use the research_subtopic tool for large questions with multiple facets.
6. Keep researching until you have broad coverage across source types and sub-topics. Do NOT stop after finding a few web results.
7. When you have 15+ quality sources spanning at least 4 different source types, you may synthesize your final answer.
8. **DATE PRECISION**: Never state definitive exact dates (e.g., "January 15th, 2026") unless a source explicitly provides that exact date. Use approximate time periods instead: "toward the beginning of 2026," "mid-2025," "late 2024," "around Q3 2025." This prevents false precision when sources only provide month or year granularity.

RESPONSE FORMAT:
To use a tool:
THOUGHT: <your reasoning about what to do next>
ACTION: <tool_name>
ARGUMENTS: {"key": "value", ...}

To provide your final answer:
THOUGHT: <brief summary of what you found>
ANSWER: <comprehensive answer with source citations like [1], [2]>

Available tools:
${toolDesc}

Search strategy tips:
- For each sub-topic, query at least 3 different source backends
- Prefer search_academic for broad literature coverage over individual backend tools
- Cross-reference claims: verify important facts across different source types`;
  }

  /**
   * Turn the agent's cited answer into atomic, source-grounded findings.
   * Prefers LLM-based atomic decomposition; falls back to a deterministic
   * splitter that drops the references list and strips citation markers so
   * reference-list fragments never leak into the findings array.
   */
  private async extractFindingsFromAnswer(
    answer: string,
    ctx: StrategyContext,
    sourceMap: Map<number, string>,
    defaultSqId?: string,
  ): Promise<void> {
    const input: AnswerFindingInput = {
      answer,
      sourceMap,
      subQuestionIds: defaultSqId ? [defaultSqId] : [],
    };

    let drafts;
    try {
      drafts = ctx.llm
        ? await extractFindingsFromAnswerLlm(ctx.llm, input)
        : extractFindingsFromAnswerRuleBased(input);
    } catch (err) {
      logger.warn({ err }, 'Agent finding extraction failed, using rule-based fallback');
      drafts = extractFindingsFromAnswerRuleBased(input);
    }

    for (const draft of drafts) {
      ctx.state.addFinding(draft);
    }
  }

  private async callLlm(
    systemPrompt: string,
    query: string,
    ctx: StrategyContext,
  ): Promise<string | null> {
    if (!ctx.llm) return null;

    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add recent history (last 8 entries)
    const recentHistory = this.history.slice(-8);
    for (const entry of recentHistory) {
      if (entry.role === 'assistant') {
        if (entry.action) {
          messages.push({
            role: 'assistant',
            content: `THOUGHT: ${entry.thought ?? ''}\nACTION: ${entry.action ?? ''}\nARGUMENTS: ${JSON.stringify(entry.args ?? {})}`,
          });
        } else if (entry.content) {
          // Preserve unparsed/malformed assistant responses in history
          messages.push({
            role: 'assistant',
            content: entry.content,
          });
        } else if (entry.thought) {
          messages.push({
            role: 'assistant',
            content: `THOUGHT: ${entry.thought}`,
          });
        }
      } else if (entry.role === 'tool') {
        messages.push({
          role: 'user',
          content: `[Tool result from ${entry.tool ?? 'unknown'}]:\n${entry.content ?? ''}`,
        });
      } else if (entry.error) {
        messages.push({
          role: 'user',
          content: `[Error]: ${entry.error}`,
        });
      }
    }

    // Add current prompt
    if (this.history.length === 0) {
      let userContent = `Research question: ${query}\n\n`;
      if (this.seededQueries.length > 0) {
        userContent += `Suggested initial search queries:\n${this.seededQueries.map((q, i) => `${String(i + 1)}. ${q}`).join('\n')}\n\n`;
      }
      userContent += 'Begin by searching for information. Use the tools available to you.';
      messages.push({
        role: 'user',
        content: userContent,
      });
    } else {
      messages.push({
        role: 'user',
        content: 'Continue your research. If you have enough information, provide your ANSWER.',
      });
    }

    const resp = await ctx.llm.callOrchestrator({
      messages,
      temperature: 0.7,
      maxTokens: 4000,
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    });

    if (!resp.success) {
      logger.warn({ error: resp.error }, 'LLM call failed');
      return null;
    }

    return resp.content;
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      const available = this.tools.map((t) => t.name).join(', ');
      return {
        content: `Unknown tool: ${name}. Available: ${available}`,
        error: 'unknown tool',
      };
    }

    logger.info({ tool: name, args }, 'Agent executing tool');
    try {
      return await tool.execute(args);
    } catch (err) {
      return {
        content: `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        error: 'tool error',
      };
    }
  }

  private async synthesizeFallback(query: string, ctx: StrategyContext): Promise<string> {
    const sources = this.collector.formatForLlm();

    // Include any intermediate insights from malformed responses or deep thoughts
    const intermediateInsights = this.history
      .filter(
        (h) =>
          h.role === 'assistant' &&
          !h.action &&
          (h.content !== undefined || h.thought !== undefined),
      )
      .map((h) => h.content ?? h.thought)
      .join('\n\n');

    if (!ctx.llm) {
      return `Research could not be completed without an LLM. Found ${String(this.collector.count)} sources:\n\n${sources}${intermediateInsights ? `\n\nIntermediate insights:\n${intermediateInsights}` : ''}`;
    }

    const insightPrompt = intermediateInsights
      ? `\n\nIntermediate research observations:\n${intermediateInsights}`
      : '';

    const resp = await ctx.llm.callOrchestrator({
      messages: [
        {
          role: 'system',
          content:
            'You synthesize research findings into a comprehensive answer. Use source citations like [1], [2].',
        },
        {
          role: 'user',
          content: `Research question: ${query}\n\nCollected sources:\n${sources}${insightPrompt}\n\nSynthesize a comprehensive answer from these sources. Cite sources using [N] notation.`,
        },
      ],
      temperature: 0.5,
      maxTokens: FALLBACK_SYNTHESIS_MAX_TOKENS,
    });

    if (!resp.success || !resp.content) {
      return `Research incomplete. Found ${String(this.collector.count)} sources but could not synthesize.\n\n${sources}`;
    }

    return resp.content;
  }

  private formatFinalAnswer(answer: string): string {
    const sources = this.collector.formatSourceList();
    if (!sources) return answer;
    return `${answer}\n\n---\nSources:\n${sources}`;
  }
}
