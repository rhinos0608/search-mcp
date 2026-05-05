/**
 * Tool family registration infrastructure.
 *
 * A "tool family" is a single MCP tool that exposes multiple actions via a
 * discriminated union on the `action` field (e.g. youtube with actions
 * "search", "transcript", "semantic").
 *
 * Each action has its own Zod schema, handler, and optional config check.
 * The family is registered as one MCP tool.  Action-level availability
 * is checked at runtime — if an action's required config is missing,
 * the handler returns a clear actionable error instead of failing silently
 * or disappearing from the tool list.
 *
 * This module provides the wiring; family definitions live in
 * src/tools/families/*.ts.
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  makeResult,
  errorResponse,
  successResponse,
  type ToolWrappedResponse,
} from './response.js';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Result that an action handler may return.
 *
 * If the handler needs to surface structured warnings beyond what's in the
 * data itself, return { data, warnings }.  Otherwise return just the data.
 */
export type ActionReturn<T> = T | ToolWrappedResponse<T>;

/**
 * A single action within a tool family.
 */
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
 * Register a tool family as a single MCP tool with a discriminated-union schema.
 *
 * The tool is always registered (even if every action is unavailable) so that
 * clients always see it in the tool list.  Actions that can't work return
 * actionable errors at runtime.
 */
export function registerFamily(
  server: McpServer,
  family: FamilyDefinition,
  cfg: SearchConfig,
): void {
  const actionSchemas = family.actions.map((a) => a.schema);
  // Each action schema includes { action: z.literal(...) }, satisfying Zod v4's
  // discriminable requirement.  The cast is needed because the generic
  // FamilyAction<TSchema> erases the literal inference at this call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schemas are ZodObjects with action literals but generic erasure loses the proof
  const schema = z.discriminatedUnion('action', actionSchemas as any);

  server.registerTool(
    family.name,
    {
      description: family.description,
      inputSchema: schema,
    },
    // When inputSchema is a Zod schema (not a shape object), the SDK passes
    // unknown args and expects the handler to do its own type narrowing.
    async (rawArgs: unknown, extra: unknown) => {
      const args = rawArgs as Record<string, unknown>;
      const action = family.actions.find((a) => a.name === args.action);
      if (!action) {
        return errorResponse(
          new Error(
            `Unknown action "${String(args.action)}". Valid actions: ${family.actions.map((a) => a.name).join(', ')}`,
          ),
        );
      }

      const issue = action.configIssue?.(cfg);
      if (issue) {
        logger.warn({ tool: family.name, action: action.name, issue }, 'Action unavailable');
        return errorResponse(new Error(`${family.name}.${action.name} unavailable: ${issue}`));
      }

      const start = Date.now();
      const label = `${family.name}.${action.name}`;
      logger.info({ tool: family.name, action: action.name }, `${label} invoked`);

      try {
        const result = await action.handler(rawArgs as Record<string, unknown>, cfg, extra);

        // Unpack branded wrapped response
        const resultObj = result as Record<string, unknown>;
        const isWrapped = resultObj.kind === 'wrapped';
        const responseData = isWrapped ? resultObj.data : result;
        const ws =
          isWrapped &&
          Array.isArray(resultObj.warnings) &&
          (resultObj.warnings as string[]).length > 0
            ? [...(resultObj.warnings as string[])]
            : undefined;

        const full = makeResult(
          family.name,
          responseData,
          Date.now() - start,
          ws !== undefined ? { warnings: ws } : undefined,
        );
        return successResponse(full);
      } catch (err: unknown) {
        logger.error({ err, tool: family.name, action: action.name }, 'Action failed');
        return errorResponse(err);
      }
    },
  );

  logger.info(
    { tool: family.name, actions: family.actions.map((a) => a.name) },
    'Family tool registered',
  );
}

// ── Health / capability helpers ──────────────────────────────────────────────

export interface ActionCapability {
  name: string;
  available: boolean;
  issue: string | null;
}

/**
 * Build a per-action capability report for a family definition.
 */
export function familyCapabilities(
  family: FamilyDefinition,
  cfg: SearchConfig,
): ActionCapability[] {
  return family.actions.map((a) => {
    const issue = a.configIssue?.(cfg) ?? null;
    return { name: a.name, available: issue === null, issue };
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
