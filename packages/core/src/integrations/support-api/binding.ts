import {
  type SupportApiConnectionConfig,
  type SupportTool,
  supportApiBindingConfigSchema,
  supportApiConnectionConfigSchema,
  supportApiSecretsSchema,
} from '@forge/contracts/support';
import {
  type AdapterContext,
  type BindingWithConnection,
  buildContextFromBinding,
  listActiveBindingsForProjectProvider,
} from '../index.js';
import { credentialValuesOf } from './call.js';

/**
 * One support-api binding of a project, as the support door calls it: one product API (one
 * Agenfold workspace, say) with its own credential and host grant. A project may bind several, each
 * with its own credential, so each tool is called with its own binding's headers and nothing else.
 */
export interface SupportApi {
  bindingId: string;
  /** What the room and its people call this binding: its label, else its connection's name. */
  name: string;
  config: SupportApiConnectionConfig;
  tools: readonly SupportTool[];
  /** The credential: header name → value. Handed only to `callGranted`. */
  headers: Record<string, string>;
}

/** A granted tool, named with the binding whose host and credential it is called with. */
export type BoundSupportTool = SupportTool & { binding: string };

/** Every binding a project's support door serves, and every tool of them, each labelled with its binding. */
export interface SupportApis {
  bindings: readonly SupportApi[];
  tools: readonly BoundSupportTool[];
}

/** One binding as stored: callable, or the fault that keeps the door from calling it. */
export type SupportApiRead =
  | { ok: true; api: SupportApi; secrets: string[] }
  | { ok: false; bindingId: string; name: string; fault: string; secrets: string[] };

/** The name a support-api binding goes by: the label it was bound under, else its connection's name. */
export function supportApiNameOf(label: string, displayName: string | null | undefined): string {
  return label || displayName?.trim() || 'support-api';
}

function readOne(pair: BindingWithConnection): SupportApiRead {
  const name = supportApiNameOf(pair.binding.label, pair.connection.displayName);
  let ctx: AdapterContext<Record<string, unknown>, Record<string, unknown>>;
  try {
    ctx = buildContextFromBinding<Record<string, unknown>, Record<string, unknown>>(pair);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      bindingId: pair.binding.id,
      name,
      fault: `secrets: the sealed credential could not be opened (${why})`,
      secrets: [],
    };
  }
  const config = supportApiConnectionConfigSchema.safeParse({
    baseUrl: ctx.config.baseUrl,
    ...(ctx.config.hosts ? { hosts: ctx.config.hosts } : {}),
  });
  const tools = supportApiBindingConfigSchema.safeParse({ tools: ctx.config.tools });
  const secrets = supportApiSecretsSchema.safeParse(ctx.secrets);
  // what a line must never carry is every credential value the row holds, even where it is malformed
  const held = (ctx.secrets as { headers?: unknown }).headers;
  const values =
    held && typeof held === 'object'
      ? credentialValuesOf(
          Object.fromEntries(
            Object.entries(held).filter((e): e is [string, string] => typeof e[1] === 'string'),
          ),
        )
      : [];
  if (config.success && tools.success && secrets.success) {
    return {
      ok: true,
      api: {
        bindingId: pair.binding.id,
        name,
        config: config.data,
        tools: tools.data.tools,
        headers: secrets.data.headers,
      },
      secrets: values,
    };
  }
  const faults = [
    ...(config.success ? [] : config.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)),
    ...(tools.success
      ? []
      : tools.error.issues.map((i) => `tools.${i.path.join('.')}: ${i.message}`)),
    ...(secrets.success ? [] : ['secrets.headers: missing or malformed']),
  ];
  return { ok: false, bindingId: pair.binding.id, name, fault: faults.join('; '), secrets: values };
}

/**
 * Every active support-api binding of the project, oldest first, each read as the door would call
 * it or with the fault that keeps it from being called. A tool whose name an earlier binding already
 * grants is a fault of the later binding: one name never reaches two APIs, and neither shadows the
 * other. A config write refuses that (`SUPPORT_TOOL_NAME_TAKEN`); this names a row stored around it.
 */
export async function readSupportApis(projectId: string): Promise<SupportApiRead[]> {
  const reads = (await listActiveBindingsForProjectProvider(projectId, 'support-api')).map(readOne);
  const holder = new Map<string, SupportApiRead & { ok: true }>();
  return reads.map((read) => {
    if (!read.ok) return read;
    const taken = read.api.tools.flatMap((t) => {
      const other = holder.get(t.name);
      return other
        ? [`${t.name} is also a tool of binding ${other.api.bindingId} (${other.api.name})`]
        : [];
    });
    if (taken.length > 0) {
      return {
        ok: false,
        bindingId: read.api.bindingId,
        name: read.api.name,
        fault: `${taken.join('; ')}: a tool name names one tool across the project's support APIs`,
        secrets: read.secrets,
      };
    }
    for (const t of read.api.tools) holder.set(t.name, read);
    return read;
  });
}

/**
 * Every support API the project grants, each tool labelled with its binding; none where it grants
 * none. A stored binding that no longer parses, or that grants a name another binding grants, is a
 * fault in what was written: thrown naming each such binding and what is wrong, never served around
 * and never skipped while the others are served.
 */
export async function supportApisOf(projectId: string): Promise<SupportApis> {
  const reads = await readSupportApis(projectId);
  const faults = reads.flatMap((r) => (r.ok ? [] : [r]));
  if (faults.length > 0) {
    throw new Error(
      `support-api: ${faults
        .map(
          (f) =>
            `binding ${f.bindingId} (${f.name}) holds a configuration the support door cannot call (${f.fault})`,
        )
        .join('; ')}`,
    );
  }
  const bindings = reads.flatMap((r) => (r.ok ? [r.api] : []));
  return {
    bindings,
    tools: bindings.flatMap((b) => b.tools.map((t) => ({ ...t, binding: b.name }))),
  };
}

/** Every credential value any of the project's support APIs holds, for scrubbing a line before it is posted. */
export async function supportApiSecretsOf(projectId: string): Promise<string[]> {
  return [...new Set((await readSupportApis(projectId)).flatMap((r) => r.secrets))];
}
