import { CHANNEL_READS } from '@forge/contracts/ecosystem';
import {
  DESIGN_TOOL_READS,
  ISSUES_TOOL_READS,
  QUESTIONS_TOOL_READS,
  RELEASES_TOOL_READS,
} from '@forge/contracts/mcp-product';
import type { McpToolName } from '@forge/contracts/mcp-tools';
import type { MiddlewareHandler } from 'hono';
import { ECOSYSTEM_READS } from '../ecosystem/index.js';
import { FORGE_FEEDBACK_READ_ACTIONS } from '../forge-door/index.js';
import type { PatRequestClass } from '../lib/rate-limits.js';
import type { PrincipalVars } from '../middleware/require-pat.js';
import { SUPPORT_TOOL_READS } from '../support/index.js';
import { PROJECT_FEEDBACK_READ_ACTIONS } from './feedback-tool.js';
import { REQUIREMENT_READ_ACTIONS } from './requirements-tool.js';

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
 * Each served tool's read actions; every other action is write-class. Typed against the served
 * names, so a tool added to the registry declares its reads or does not compile, and a name no tool
 * serves is write-class (it is refused on the server either way).
 */
const READ_ACTIONS = {
  forge_uploads: new Set(['fetch']),
  forge_channel: new Set<string>(CHANNEL_READS),
  forge_ecosystem: new Set<string>(ECOSYSTEM_READS),
  forge_requirements: new Set(REQUIREMENT_READ_ACTIONS),
  project_feedback: new Set(PROJECT_FEEDBACK_READ_ACTIONS),
  forge_feedback: new Set(FORGE_FEEDBACK_READ_ACTIONS),
  forge_releases: new Set<string>(RELEASES_TOOL_READS),
  forge_design: new Set<string>(DESIGN_TOOL_READS),
  forge_questions: new Set<string>(QUESTIONS_TOOL_READS),
  forge_issues: new Set<string>(ISSUES_TOOL_READS),
  forge_support: new Set<string>(SUPPORT_TOOL_READS),
} satisfies Record<McpToolName, ReadonlySet<string>>;

/** The action a tool takes when the call names none — its schema's own default. */
const DEFAULT_ACTION: Partial<Record<McpToolName, string>> = { forge_uploads: 'fetch' };

const isServed = (name: string): name is McpToolName => Object.hasOwn(READ_ACTIONS, name);

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
  if (!isServed(call.name)) return 'write';
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const action = args.action ?? DEFAULT_ACTION[call.name];
  return typeof action === 'string' && READ_ACTIONS[call.name].has(action) ? 'read' : 'write';
}

/**
 * What in one envelope makes it write-class, named as the caller wrote it
 * (`forge_feedback action=submit`, a method), so a refusal says which call.
 */
function writeCallsOf(envelope: unknown): string[] {
  if (Array.isArray(envelope)) return envelope.flatMap(writeCallsOf);
  if (classifyMcpEnvelope(envelope) === 'read') return [];
  if (!envelope || typeof envelope !== 'object')
    return ['a request that is not a JSON-RPC envelope'];
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
