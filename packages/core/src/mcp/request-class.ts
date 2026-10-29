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
import { BINDINGS_TOOL_READS, CONFIG_TOOL_READS } from '../project-config/index.js';
import { PROJECTS_TOOL_READS } from '../projects/index.js';
import { SUPPORT_TOOL_READS } from '../support/index.js';
import { PROJECT_FEEDBACK_READ_ACTIONS } from './feedback-tool.js';
import { REQUIREMENT_READ_ACTIONS } from './requirements-tool.js';

/**
 * JSON-RPC methods that read. `tools/call` is absent deliberately — it is the
 * one method whose class depends on its arguments.
 */
const READ_METHODS: ReadonlySet<string> = new Set([
  // 2026-07-28: what the server speaks, and a stream of what changes in it (ISS-768)
  'server/discover',
  'subscriptions/listen',
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
  forge_projects: new Set<string>(PROJECTS_TOOL_READS),
  forge_config: new Set<string>(CONFIG_TOOL_READS),
  forge_bindings: new Set<string>(BINDINGS_TOOL_READS),
} satisfies Record<McpToolName, ReadonlySet<string>>;

/** The action a tool takes when the call names none — its schema's own default. */
const DEFAULT_ACTION: Partial<Record<McpToolName, string>> = { forge_uploads: 'fetch' };

const isServed = (name: string): name is McpToolName => Object.hasOwn(READ_ACTIONS, name);

/** The surface tools that only read: finding, describing, searching and fetching (ISS-773). */
const READ_SURFACE: ReadonlySet<string> = new Set([
  'forge_find',
  'forge_describe',
  'search',
  'fetch',
]);

/**
 * The door tool and arguments a call names: a `forge_call { action: "<door>.<action>", args }` is the
 * call of its door's tool with that action, classed as that call is; any other names itself.
 */
function doorCallOf(call: { name?: unknown; arguments?: unknown }): {
  name: unknown;
  args: Record<string, unknown>;
} {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  if (call.name !== 'forge_call') return { name: call.name, args };
  const id = typeof args.action === 'string' ? args.action : '';
  const dot = id.indexOf('.');
  if (dot <= 0) return { name: null, args: {} };
  const door = id.slice(0, dot);
  const inner = (args.args ?? {}) as Record<string, unknown>;
  return {
    name: isServed(door) ? door : `forge_${door}`,
    args: { ...inner, action: id.slice(dot + 1) },
  };
}

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

  const asked = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof asked.name === 'string' && READ_SURFACE.has(asked.name)) return 'read';
  const { name, args } = doorCallOf(asked);
  if (typeof name !== 'string') return 'write';
  if (!isServed(name)) return 'write';
  const action = args.action ?? DEFAULT_ACTION[name];
  return typeof action === 'string' && READ_ACTIONS[name].has(action) ? 'read' : 'write';
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
  const asked = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof asked.name !== 'string') return ['tools/call with no tool name'];
  const { name, args } = doorCallOf(asked);
  if (typeof name !== 'string') return [`${asked.name} with no <door>.<action>`];
  const action = args.action;
  return [typeof action === 'string' ? `${name} action=${action}` : name];
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
