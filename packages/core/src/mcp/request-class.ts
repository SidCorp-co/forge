import type { MiddlewareHandler } from 'hono';
import type { PatRequestClass } from '../lib/rate-limits.js';
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

const READ_ACTIONS: ReadonlySet<string> = new Set([
  'list',
  'get',
  'design',
  'search',
  'status',
  'state',
  'logs',
  'runtime-logs',
  'applications',
  'targets',
  'rollback-images',
]);

/** Read-only tools that take no `action` argument, so nothing in their arguments identifies them. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['forge_storefront_target']);

/** The class of one JSON-RPC envelope, whatever shape it turned out to be. */
function classifyMcpEnvelope(envelope: unknown): PatRequestClass {
  if (!envelope || typeof envelope !== 'object') return 'write';
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
 * What in one envelope makes it write-class, named as the caller wrote it
 * (`forge_issues action=update`, a method), so a refusal says which call.
 */
export function writeCallsOf(envelope: unknown): string[] {
  if (Array.isArray(envelope)) return envelope.flatMap(writeCallsOf);
  if (classifyMcpEnvelope(envelope) === 'read') return [];
  if (!envelope || typeof envelope !== 'object') return ['a request that is not a JSON-RPC envelope'];
  const { method, params } = envelope as { method?: unknown; params?: unknown };
  if (typeof method !== 'string') return ['a request with no method'];
  if (method !== 'tools/call') return [method];
  const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof call.name !== 'string') return ['tools/call with no tool name'];
  const action = ((call.arguments ?? {}) as { action?: unknown }).action;
  return [typeof action === 'string' ? `${call.name} action=${action}` : call.name];
}

/**
 * Classify the request and hand the answer to `requirePat`.
 *
 * Mounted on `/mcp` ABOVE `requirePat`, which is the whole of the coupling:
 * the var has to be set before the middleware that charges the bucket runs.
 */
export function mcpRequestClass(): MiddlewareHandler<{ Variables: PrincipalVars }> {
  return async (c, next) => {
    if (c.req.method !== 'POST') {
      c.set('patRequestClass', 'read');
      await next();
      return;
    }
    let requestClass: PatRequestClass = 'write';
    let calls: string[] = ['a body that is not JSON'];
    try {
      const envelope = await c.req.raw.clone().json();
      requestClass = classifyMcpEnvelope(envelope);
      calls = writeCallsOf(envelope);
    } catch {}
    c.set('patRequestClass', requestClass);
    c.set('patRequestWrites', calls);
    await next();
  };
}
