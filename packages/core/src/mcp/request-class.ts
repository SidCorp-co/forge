/**
 * Which of the two per-token rate-limit budgets an MCP request spends.
 *
 * On the REST data plane the answer is the HTTP method
 * (`middleware/pat-rest-surface.ts:scopeForMethod`). Every MCP call is a
 * `POST /mcp`, so the method says nothing and the answer has to come from the
 * JSON-RPC envelope — which the auth middleware cannot see, because it runs
 * before the transport reads the body. This module reads a CLONE of the body
 * and sets the answer on the context for `authenticatePat` to charge.
 *
 * The default is `write`, the stricter budget. A tool this file does not
 * recognise therefore keeps exactly the ceiling it had before ISS-961, so a
 * newly registered write needs no edit here and a newly registered read
 * degrades to the old number rather than escaping the limiter.
 */

import type { MiddlewareHandler } from 'hono';
import type { PatRequestClass } from '../config/rate-limits.js';
import type { PrincipalVars } from '../middleware/require-pat.js';

/**
 * JSON-RPC methods that read. `tools/call` is absent deliberately — it is the
 * one method whose class depends on its arguments.
 */
const READ_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'prompts/list',
  'prompts/get',
  'resources/list',
  'resources/read',
  'resources/templates/list',
  'completion/complete',
  'logging/setLevel',
]);

/**
 * The `action` values that read, across every action-dispatching tool. One set
 * rather than a per-tool table because the vocabulary is shared: a tool that
 * mutates under one of these names would be misnamed, and the tools that own
 * these verbs (`forge_issues`, `forge_comments`, `forge_knowledge`,
 * `forge_schedules`, `forge_project_pm`, `forge_phase`, …) all use them the
 * same way.
 */
// cm:guard every member here must be non-mutating in EVERY tool that accepts it, because the class is decided from the action alone without consulting the tool. Adding a verb one tool reads and another writes under is how a write starts spending the read budget. `fetch` was here until review caught it: its only consumer, `forge_uploads action=fetch`, calls `assertPrincipalIsWriter` and inserts a `download_tickets` row on every call, so a writer-gated mutation was being charged the read budget. Check the handler, not the verb.
const READ_ACTIONS: ReadonlySet<string> = new Set([
  'list',
  'listTasks',
  'get',
  'search',
  'events',
  'runs',
  'catalog',
  'snapshot',
  'graph',
  'runner_load',
  'resume_point',
  'effective',
  'list_registrations',
  'sync_status',
  'status',
  'logs',
  'runtime-logs',
  'applications',
  'targets',
  'rollback-images',
]);

/**
 * Read-only tools that take no `action` argument, so nothing in their
 * arguments identifies them. Gated by `request-class.test.ts`, which asserts
 * every name here is a tool this core registers — a rename leaves a dead
 * entry that silently stops widening the budget it was added for.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'forge_health',
  'forge_memory.search',
  'forge_memory.get',
  'forge_step_handoff.get',
  'forge_skills.list',
  'forge_skills.get',
  'forge_skills.effective',
  'forge_skills.list_registrations',
  'forge_skills.sync_status',
  'forge_skill_facts.list',
  'forge_skill_facts.get',
  'forge_metrics.project_retry_rescues',
  'forge_metrics.project_step_durations',
  'forge_metrics.project_timeseries',
  'forge_metrics.session_failures',
  'forge_jobs.list',
  'forge_jobs.get',
  'forge_jobs.events',
  'forge_agent_sessions.list',
  'forge_agent_sessions.get',
  'forge_pipeline_runs.get',
  'forge_projects.list',
  'forge_projects.get',
  'forge_orgs.list',
  'forge_orgs.members',
  'forge_storefront_target',
]);

export const MCP_READ_ONLY_TOOLS = READ_ONLY_TOOLS;
export const MCP_READ_ACTIONS = READ_ACTIONS;

/** The class of one JSON-RPC envelope, whatever shape it turned out to be. */
export function classifyMcpEnvelope(envelope: unknown): PatRequestClass {
  if (!envelope || typeof envelope !== 'object') return 'write';
  // cm:why a batch charges `write` unless EVERY member reads: a batch is one HTTP request and one charge, so the mixed case has to pick a side, and the side that cannot under-charge a write is the only safe one.
  if (Array.isArray(envelope)) {
    if (envelope.length === 0) return 'write';
    return envelope.every((one) => classifyMcpEnvelope(one) === 'read') ? 'read' : 'write';
  }

  const { method, params } = envelope as { method?: unknown; params?: unknown };
  if (typeof method !== 'string') return 'write';
  if (READ_METHODS.has(method)) return 'read';
  if (method !== 'tools/call') return 'write';

  const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof call.name !== 'string') return 'write';
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  if (typeof args.action === 'string') {
    return READ_ACTIONS.has(args.action) ? 'read' : 'write';
  }
  return READ_ONLY_TOOLS.has(call.name) ? 'read' : 'write';
}

/**
 * Classify the request and hand the answer to `requirePat`.
 *
 * Mounted on `/mcp` ABOVE `requirePat`, which is the whole of the coupling:
 * the var has to be set before the middleware that charges the bucket runs.
 */
// cm:guard read a CLONE and never `c.req.json()`. Hono caches the parsed body, but the MCP transport is handed `c.req.raw` and reads the stream itself — parsing the original here leaves the transport a used body and every tool call fails with nothing naming this file.
export function mcpRequestClass(): MiddlewareHandler<{ Variables: PrincipalVars }> {
  return async (c, next) => {
    if (c.req.method !== 'POST') {
      c.set('patRequestClass', 'read');
      await next();
      return;
    }
    let requestClass: PatRequestClass = 'write';
    try {
      requestClass = classifyMcpEnvelope(await c.req.raw.clone().json());
      // cm:why swallowed: an unparseable body is the transport's error to report, with its own JSON-RPC envelope, and a 400 raised here would replace that message with one about rate limiting. The stricter budget is already charged, which is the whole of this middleware's business.
    } catch {}
    c.set('patRequestClass', requestClass);
    await next();
  };
}
