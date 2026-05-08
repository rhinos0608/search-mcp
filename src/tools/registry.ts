/**
 * Tool family registration infrastructure.
 *
 * A "tool family" groups related actions under a common namespace (e.g. youtube
 * with actions "search", "transcript", "semantic"). Each action is registered
 * as a separate MCP tool named `family.action` so that the JSON Schema for
 * each action's parameters is fully visible to AI clients.
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
import {
   makeResult,
   errorResponse,
   successResponse,
   type ToolWrappedResponse,
} from './response.js';

/** Zod v4's discriminatedUnion requires a tuple of at least one discriminable ZodType. */
// The schemas built by action families all include { action: z.literal(...) } so
// they're $ZodTypeDiscriminable at runtime — the cast below is intentional.
type ZodSchemaArray = [z.core.$ZodTypeDiscriminable<string>, ...z.core.$ZodTypeDiscriminable<string>[]];

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
   const actionMap = new Map(family.actions.map((a) => [a.name, a]));

   // Pre-compute config issues at registration time
   const issueMap = new Map<string, string | null>();
   for (const action of family.actions) {
      issueMap.set(action.name, action.configIssue?.(cfg) ?? null);
   }

   // Build a single discriminated-union schema from all action schemas
   const schemas = family.actions.map(
      (a) => a.schema,
   ) as unknown as ZodSchemaArray;
   const unionSchema = z.discriminatedUnion('action', schemas);

   server.registerTool(
      family.name,
      {
         description: family.description,
         inputSchema: unionSchema,
      },
      async (rawArgs: unknown, extra: unknown) => {
         const args = rawArgs as Record<string, unknown>;
         const actionName = args.action as string | undefined;

         if (!actionName) {
            return errorResponse(
               new Error(
                  `Missing "action" field. Available actions: ${family.actions.map((a) => a.name).join(', ')}`,
               ),
            );
         }

         const actionEntry = actionMap.get(actionName);
         if (!actionEntry) {
            return errorResponse(
               new Error(
                  `Unknown action "${actionName}". Available actions: ${family.actions.map((a) => a.name).join(', ')}`,
               ),
            );
         }

         const issue = issueMap.get(actionName);
         if (issue) {
            logger.warn({ tool: family.name, action: actionName, issue }, 'Action unavailable');
            return errorResponse(
               new Error(`${family.name}.${actionName} unavailable: ${issue}`),
            );
         }

         const start = Date.now();
         logger.info({ tool: family.name, action: actionName }, `${family.name}.${actionName} invoked`);

         try {
            const result = await actionEntry.handler(
               rawArgs as Record<string, unknown>,
               cfg,
               extra,
            );

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
               `${family.name}.${actionName}`,
               responseData,
               Date.now() - start,
               ws !== undefined ? { warnings: ws } : undefined,
            );
            return successResponse(full);
         } catch (err: unknown) {
            logger.error({ err, tool: family.name, action: actionName }, 'Action failed');
            return errorResponse(err);
         }
      },
   );

   logger.info(
      { tool: family.name, actions: family.actions.map((a) => a.name) },
      'Family registered',
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
