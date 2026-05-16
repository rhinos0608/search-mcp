/**
 * Tool family registration infrastructure.
 *
 * A "tool family" groups related actions under a common namespace (e.g. youtube
 * with actions "search", "transcript", "semantic"). The family is registered as
 * a single MCP tool with a discriminated-union `action` field, so AI clients
 * discover one tool per family instead of N individual tools.
 *
 * Each action has its own Zod schema, handler, and optional config check.
 * Action-level availability is checked at runtime — if an action's required
 * config is missing, the handler returns a clear actionable error instead of
 * failing silently or disappearing from the tool list.
 *
 * This module provides the wiring; family definitions live in
 * src/tools/families/*.ts.
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import { logger } from '../logger.js';
import type { KnowledgeGraphHook } from '../knowledge/hook.js';
import {
  makeResult,
  errorResponse,
  successResponse,
  type ToolWrappedResponse,
  type MakeResultOpts,
} from './response.js';
import { correctQuery } from '../utils/fuzzyCorrection.js';
import { applyIntentFilter } from '../utils/intentFilter.js';
import type { IntentFilterResult } from '../utils/intentFilter.js';

// ── Types ──────────────────────────────────────

/**
 * Result that an action handler may return.
 *
 * If the handler needs to surface structured warnings beyond what's in the
 * data itself, return { data, warnings }.  Otherwise return just the data.
 */
export type ActionReturn<T> = T | ToolWrappedResponse<T>;

/** A single action within a tool family.
 * @typeParam TSchema - The Zod schema type for this action's parameters. */
export interface FamilyAction<TSchema extends z.ZodType> {
  /** Canonical action name (e.g. "search", "transcript", "semantic"). */
  name: string;
  /** Short description included in error messages when action is unavailable. */
  description: string;
  /**
   * Full Zod schema for this action's parameters.
   * Must be a z.object that includes { action: z.literal(this.name) }.
   */
  schema: TSchema;
  /**
   * Handler function.  Receives the parsed action params (after Zod validation)
   * and the tool config. Returns the response data (or { data, warnings }).
   * The args type is inferred from the schema, but the container generic erases
   * it at registry time — each handler knows its own shape via destructuring.
   */
  handler: (
    args: Record<string, unknown>,
    cfg: SearchConfig,
    extra?: unknown,
  ) => Promise<ActionReturn<unknown>>;
  /**
   * Optional config check.  Return null if the action is available, or a
   * human-readable remediation string if it isn't (e.g. "Set YOUTUBE_API_KEY").
   */
  configIssue?: (cfg: SearchConfig) => string | null;
}

/**
 * Definition of a tool family.
 */
export interface FamilyDefinition {
  /** MCP tool name (e.g. "youtube"). */
  name: string;
  /** Top-level tool description. */
  description: string;
  /** All actions in this family. */
  actions: FamilyAction<z.ZodType>[];
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Build a flat merged Zod object schema from all action schemas.
 * Combines all properties into a single z.object(). Action becomes
 * a z.enum(); other fields made optional. Passes the SDK's
 * normalizeObjectSchema check (which rejects non-object schemas).
 */
function buildMergedSchema(family: FamilyDefinition): z.ZodObject<z.ZodRawShape> {
  const allFields = new Map<string, unknown>();
  for (const action of family.actions) {
    const objSchema = action.schema as z.ZodObject<z.ZodRawShape>;
    const rawShape = objSchema._zod.def.shape;
    for (const [key, fieldType] of Object.entries(rawShape)) {
      if (key === 'action') {
        if (!allFields.has(key)) allFields.set(key, fieldType);
        continue;
      }
      if (allFields.has(key)) {
        // Different actions often reuse names with incompatible schemas (e.g.
        // `sort`, `repo`, `op`). Keep the discovery schema permissive and let
        // the selected action's strict schema validate in superRefine/runtime.
        allFields.set(key, z.unknown());
      } else {
        allFields.set(key, fieldType);
      }
    }
  }
  const names = family.actions.map((a) => a.name) as [string, ...string[]];
  const merged: Record<string, unknown> = {
    action: z.enum(names).describe(family.name + ' action: ' + names.join(', ')),
    fuzzyCorrect: z.boolean().optional().default(true).describe('Auto-correct typos in query using fuzzy matching'),
    intent: z.string().optional().describe('Natural language intent for result filtering when output exceeds ~5KB'),
  };
  for (const [key, fieldType] of allFields) {
    if (key === 'action') continue;
    merged[key] = (fieldType as z.ZodType).optional();
  }
  return z.object(merged).superRefine((value, ctx) => {
    const actionName = typeof value.action === 'string' ? value.action : '';
    const action = family.actions.find((a) => a.name === actionName);
    if (!action) return;

    const parsed = (action.schema as z.ZodObject<z.ZodRawShape>).safeParse(value);
    if (parsed.success) return;

    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: 'custom',
        path: issue.path,
        message: issue.message,
      });
    }
  }) as z.ZodObject<z.ZodRawShape>;
}

/**
 * Register a tool family as a single MCP tool with a discriminated-union
 * `action` field. Each action becomes a literal option in a Zod union,
 * giving clients a single tool to discover instead of N individual tools.
 *
 * NOTE: inputSchema is a flat merged z.object (not discriminatedUnion)
 * because the SDK's normalizeObjectSchema rejects non-object schemas.
 * Runtime validation uses each action's own handler for strict checking.
 */
export function registerFamily(
  server: McpServer,
  family: FamilyDefinition,
  cfg: SearchConfig,
  kgHook?: KnowledgeGraphHook,
): void {
  const mergedSchema = buildMergedSchema(family);

  server.registerTool(
    family.name,
    {
      description: family.description,
      inputSchema: mergedSchema,
    },
    async (rawArgs: unknown, extra: unknown) => {
      const args = rawArgs as Record<string, string>;
      const actionName: string = args.action ?? '';

      // Find the matching action
      const action = family.actions.find((a) => a.name === actionName);
      if (!action) {
        return errorResponse(new Error(`${family.name}: unknown action "${actionName}"`), family.name);
      }

      // Strict per-action validation — run the selected action's own
      // Zod schema so that missing required fields are caught before
      // the handler runs.  The merged schema has all fields optional
      // for client compatibility; this is the actual runtime gate.
      const parsed = (action.schema as z.ZodObject<z.ZodRawShape>).safeParse(rawArgs);
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (i) => `${(i as { path: (string | number)[] }).path.join('.')}: ${(i as { message: string }).message}`,
        );
        return errorResponse(
          new Error(
            `${family.name}.${actionName} validation error: ${issues.join('; ')}`,
          ),
          `${family.name}.${actionName}`,
        );
      }

      // Check config availability
      const actionIssue = action.configIssue?.(cfg) ?? null;
      if (actionIssue) {
        logger.warn({ tool: family.name, action: actionName, actionIssue }, 'Action unavailable');
        return errorResponse(new Error(`${family.name}.${actionName} unavailable: ${actionIssue}`), `${family.name}.${actionName}`);
      }

      const start = Date.now();
      logger.info(
        { tool: family.name, action: actionName },
        `${family.name}.${actionName} invoked`,
      );

      // ── Context protection: fuzzy correction ──
      let correction: { original: string; corrected: string; changes: { original: string; corrected: string; distance: number }[] } | undefined;
      const fuzzyOpt = parsed.data.fuzzyCorrect !== false;
      const rawQuery = typeof parsed.data.query === 'string' ? parsed.data.query : undefined;
      if (fuzzyOpt && rawQuery) {
        const cr = correctQuery(rawQuery);
        if (cr.changes.length > 0) {
          correction = { original: rawQuery, corrected: cr.corrected, changes: cr.changes };
        }
      }

      // Build handler args from parsed.data (honours Zod defaults)
      const handlerArgs = { ...parsed.data } as Record<string, unknown>;
      if (correction && typeof handlerArgs.query === 'string') {
        handlerArgs.query = correction.corrected;
      }

      try {
        const result = await action.handler(handlerArgs, cfg, extra);

        // Type-narrow the result with a proper guard
        const isWrapped =
          result !== null &&
          typeof result === 'object' &&
          'kind' in result &&
          (result as Record<string, string>).kind === 'wrapped';
        const wrapped: ToolWrappedResponse<unknown> | null = isWrapped
          ? (result as ToolWrappedResponse<unknown>)
          : null;
        let responseData = wrapped !== null ? wrapped.data : result;
        const rawWs = wrapped !== null ? wrapped.warnings : undefined;
        const ws: string[] | undefined =
          rawWs !== undefined && rawWs.length > 0 ? Array.from(rawWs) : undefined;

        const toolLabel = `${family.name}.${actionName}`;
        // ── Context protection: intent filtering ──
        const rawIntent = (rawArgs as Record<string, unknown>).intent;
        let intentFilterResult: IntentFilterResult<unknown> | undefined;
        if (rawIntent && typeof rawIntent === 'string' && rawIntent.trim().length > 0) {
          if (Array.isArray(responseData)) {
            const filtered = applyIntentFilter(
              responseData as unknown[],
              rawIntent,
              5000,
              (item) => JSON.stringify(item),
            );
            if (filtered.filtered) {
              intentFilterResult = filtered;
              responseData = filtered.results;
            }
          } else if (responseData !== null && typeof responseData === 'object') {
            const obj = responseData as Record<string, unknown>;
            const arrayKeys = [
              'results', 'items', 'repositories', 'videos', 'posts', 'comments',
              'papers', 'packages', 'works', 'questions', 'nodes', 'families', 'runs',
            ];
            for (const key of arrayKeys) {
              if (Array.isArray(obj[key]) && (obj[key] as unknown[]).length > 0) {
                const filtered = applyIntentFilter(
                  obj[key] as unknown[],
                  rawIntent,
                  5000,
                  (item) => JSON.stringify(item),
                );
                if (filtered.filtered) {
                  intentFilterResult = filtered;
                  (obj)[key] = filtered.results;
                  break;
                }
              }
            }
            // Fallback: first top-level array if no preferred key matched
            if (!intentFilterResult) {
              const entries = Object.entries(obj).filter(([_, v]) => Array.isArray(v));
              const firstEntry = entries.length > 0 ? entries[0] : undefined;
              if (firstEntry) {
                const firstKey = firstEntry[0];
                const firstVal = firstEntry[1];
                const filtered = applyIntentFilter(
                  firstVal as unknown[],
                  rawIntent,
                  5000,
                  (item) => JSON.stringify(item),
                );
                if (filtered.filtered) {
                  intentFilterResult = filtered;
                  obj[firstKey] = filtered.results;
                }
              }
            }
          }
        }

        const meta: Record<string, unknown> = {};
        if (ws !== undefined) meta.warnings = ws;
        if (correction) meta.correction = correction;
        if (intentFilterResult) {
          meta.intentFilter = {
            filtered: intentFilterResult.filtered,
            totalResults: intentFilterResult.totalResults,
            filteredCount: intentFilterResult.filteredCount,
            searchableTerms: intentFilterResult.searchableTerms,
            bytesBefore: intentFilterResult.bytesBefore,
            bytesAfter: intentFilterResult.bytesAfter,
          };
        }
        const full = makeResult(
          toolLabel,
          responseData,
          Date.now() - start,
          meta as MakeResultOpts,
        );

        // KG passive capture (fire-and-forget, never fails the tool call)
        if (kgHook && cfg.knowledgeGraph.enabled) {
          void kgHook.onToolCall(toolLabel, responseData).catch((err: unknown) => {
            logger.warn({ err, tool: toolLabel }, 'KG passive capture failed (non-fatal)');
          });
        }

        return successResponse(full);
      } catch (err: unknown) {
        logger.error({ err, tool: family.name, action: actionName }, 'Action failed');
        return errorResponse(err, `${family.name}.${actionName}`);
      }
    },
  );

  logger.info({ tool: family.name, actions: family.actions.length }, 'Family tool registered');
}

// ── Health / capability helpers ──────────────────────────────────────────────

export interface ActionCapability {
  name: string;
  available: boolean;
  issue: string | null;
}

/**
 * Build a per-action capability report for a family definition.
 * The name is `family.action` form for granular health tracking.
 */
export function familyCapabilities(
  family: FamilyDefinition,
  cfg: SearchConfig,
): ActionCapability[] {
  return family.actions.map((a) => {
    const issue = a.configIssue?.(cfg) ?? null;
    return { name: `${family.name}.${a.name}`, available: issue === null, issue };
  });
}

/**
 * Determine whether the family tool should be registered at all.
 * Returns true if at least one action is available.
 */
export function shouldRegisterFamily(family: FamilyDefinition, cfg: SearchConfig): boolean {
  return family.actions.some((a) => {
    try {
      return (a.configIssue?.(cfg) ?? null) === null;
    } catch {
      return false;
    }
  });
}
