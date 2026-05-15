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
} from './response.js';

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
      if (!allFields.has(key)) allFields.set(key, fieldType);
    }
  }
  const names = family.actions.map((a) => a.name) as [string, ...string[]];
  const merged: Record<string, unknown> = {
    action: z.enum(names).describe(family.name + ' action: ' + names.join(', ')),
  };
  for (const [key, fieldType] of allFields) {
    if (key === 'action') continue;
    merged[key] = (fieldType as z.ZodType).optional();
  }
  return z.object(merged) as z.ZodObject<z.ZodRawShape>;
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
        return errorResponse(new Error(`${family.name}: unknown action "${actionName}"`));
      }

      // Check config availability
      const actionIssue = action.configIssue?.(cfg) ?? null;
      if (actionIssue) {
        logger.warn({ tool: family.name, action: actionName, actionIssue }, 'Action unavailable');
        return errorResponse(new Error(`${family.name}.${actionName} unavailable: ${actionIssue}`));
      }

      const start = Date.now();
      logger.info(
        { tool: family.name, action: actionName },
        `${family.name}.${actionName} invoked`,
      );

      try {
        const result = await action.handler(rawArgs as Record<string, unknown>, cfg, extra);

        // Type-narrow the result with a proper guard
        const isWrapped =
          result !== null &&
          typeof result === 'object' &&
          'kind' in result &&
          (result as Record<string, string>).kind === 'wrapped';
        const wrapped: ToolWrappedResponse<unknown> | null = isWrapped
          ? (result as ToolWrappedResponse<unknown>)
          : null;
        const responseData = wrapped !== null ? wrapped.data : result;
        const rawWs = wrapped !== null ? wrapped.warnings : undefined;
        const ws: string[] | undefined =
          rawWs !== undefined && rawWs.length > 0 ? Array.from(rawWs) : undefined;

        const toolLabel = `${family.name}.${actionName}`;
        const full = makeResult(
          toolLabel,
          responseData,
          Date.now() - start,
          ws !== undefined ? { warnings: ws } : undefined,
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
        return errorResponse(err);
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
