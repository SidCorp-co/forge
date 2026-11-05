// A tool name calls one product API (ISS-1011). A project binds one support API per credential (one
// Agenfold workspace each), and the support door finds a tool's API by its name, so two active
// bindings granting one name would leave the door to pick: a write that would do that is refused,
// naming the tool and both bindings, and neither binding shadows the other.

import {
  type BindingTargetRefusal,
  listActiveBindingsForProjectProvider,
  type VerifyBindingTargetArgs,
} from '../index.js';
import { supportApiNameOf } from './binding.js';

interface Granting {
  bindingId: string;
  name: string;
  tools: string[];
}

/** The tool names a binding config declares, in order; a malformed entry is the schema's to refuse. */
function toolNames(config: unknown): string[] {
  const tools = (config as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((t) =>
    typeof (t as { name?: unknown })?.name === 'string' ? [(t as { name: string }).name] : [],
  );
}

/** Every other active support-api binding of the project, as this write leaves them. */
async function othersOf(args: VerifyBindingTargetArgs): Promise<Granting[]> {
  const written = args.alongside.filter(
    (a) => a.projectId === args.projectId && a.provider === 'support-api',
  );
  const rewritten = new Set(written.map((a) => a.bindingId));
  const stored = (await listActiveBindingsForProjectProvider(args.projectId, 'support-api'))
    .filter((p) => p.binding.id !== args.bindingId && !rewritten.has(p.binding.id))
    .map((p) => ({
      bindingId: p.binding.id,
      name: supportApiNameOf(p.binding.label, p.connection.displayName),
      tools: toolNames(p.binding.config),
    }));
  const alongside = written
    .filter((a) => a.active && a.bindingId !== args.bindingId)
    .map((a) => ({
      bindingId: a.bindingId,
      name: supportApiNameOf(a.label, a.displayName),
      tools: toolNames(a.config),
    }));
  return [...stored, ...alongside];
}

/**
 * Refuse a support-api binding granting a tool name another active support-api binding of the same
 * project grants, stored or written in the same call. A switched-off binding serves nothing, so it
 * clashes with nothing.
 */
export async function verifyToolNames(
  args: VerifyBindingTargetArgs,
): Promise<BindingTargetRefusal[]> {
  if (!args.active) return [];
  const mine = toolNames(args.config);
  if (mine.length === 0) return [];
  const others = await othersOf(args);
  const self = supportApiNameOf(args.label, args.connection.displayName);
  return mine.flatMap((tool, i) => {
    const other = others.find((o) => o.tools.includes(tool));
    if (!other) return [];
    return [
      {
        code: 'SUPPORT_TOOL_NAME_TAKEN' as const,
        path: `/tools/${i}/name`,
        detail: `tool "${tool}" is already granted by support-api binding ${other.bindingId} (${other.name}), so binding ${args.bindingId} (${self}) cannot grant it too: a tool name calls one API. Rename the tool on one of the two bindings.`,
      },
    ];
  });
}
