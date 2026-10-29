// `forge_config` and `forge_bindings`: a project's document and its integration bindings, read and
// written whole over the services `PUT /api/projects/:id/config` and
// `PUT /api/projects/:id/bindings/:bindingId` call, with their envelope, their role and their
// refusals (ISS-767). Reached as the `config.*` and `bindings.*` actions through forge_call (ISS-773).
// No answer carries a credential: a document holds `secret://` references, and whatever a person
// pasted into one passes the secret scrubber before it leaves.

import { scrubSecretsDeep } from '@forge/observability';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RefusalError, requestRefusals } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from '../lib/tool.js';
import { need } from '../lib/tool-args.js';
import { envelopeOf } from '../lib/write-envelope.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { listBindings, readBinding, writeBinding } from './bindings.js';
import { type Held, readProjectConfig, writeProjectConfig } from './service.js';

export const CONFIG_TOOL_READS = ['get'] as const;
export const BINDINGS_TOOL_READS = ['get'] as const;

const envelope = {
  baseRevision: z
    .number()
    .int()
    .min(1)
    .nullable()
    .optional()
    .describe('write: the revision you read, or null for a first write'),
  document: z.unknown().optional().describe('write: the whole document'),
};

const configInput = z.strictObject({
  action: z.enum(['get', 'write']),
  projectId: z.uuid(),
  ...envelope,
});

const bindingsInput = z.strictObject({
  action: z.enum(['get', 'write']),
  projectId: z.uuid(),
  binding: z
    .uuid()
    .optional()
    .describe('get: one binding, every binding when omitted; write: the binding'),
  ...envelope,
});

const CONFIG_SHAPE = '{ action, projectId, baseRevision?, document? }';
const BINDINGS_SHAPE = '{ action, projectId, binding?, baseRevision?, document? }';

const CONFIG_DESCRIPTION = `A project's document, read and written whole: its environments, their URLs, promotions and the testing profile each names (a testing profile holds secret:// references, never a credential).
- get { projectId }: the document with the revision it is at, or declared: false where the project has none.
- write { projectId, baseRevision, document }: the whole document, as PUT /api/projects/:id/config writes it; it takes project.admin. baseRevision is the revision you read, or null for a first write. { base, patch } is refused CONFIG_WRITE_SHAPE: get the document, change it, and write it back whole. A baseRevision the document has moved past is refused by name: get it again.`;

const BINDINGS_DESCRIPTION = `A project's integration bindings, each read and written whole as a binding document (its role, connection, target and instructions; a connection's credential stays in core).
- get { projectId, binding? }: one binding, or every binding with those that have no document form.
- write { projectId, binding, baseRevision, document }: the whole binding document, as PUT /api/projects/:id/bindings/:bindingId writes it; it takes project.admin. { base, patch } is refused CONFIG_WRITE_SHAPE, and a baseRevision the binding has moved past is refused by name: get it again.`;

function parser<S extends z.ZodTypeAny>(schema: S, shape: string) {
  return (args: Record<string, unknown>): z.infer<S> => {
    // `{ base, patch }` is the natural reading of a revisioned write: named, never a key error
    if (args.action === 'write' && ('base' in args || 'patch' in args)) {
      envelopeRefusal(() => envelopeOf({ base: args.base, patch: args.patch }));
    }
    const parsed = schema.safeParse(args);
    if (parsed.success) return parsed.data;
    throw new RefusalError(
      requestRefusals('BAD_REQUEST', shape, parsed.error),
      'BAD_REQUEST',
      shape,
    );
  };
}

/** The envelope of a write, its shape refused under the code its REST door answers. */
function envelopeRefusal<T>(read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (!(err instanceof HTTPException)) throw err;
    const code = (err.cause as { code?: string } | undefined)?.code ?? 'BAD_REQUEST';
    throw new RefusalError([{ code, path: '', detail: err.message }], code);
  }
}

const refused = (refusals: readonly { code: string; path: string; detail: string }[]) =>
  new RefusalError(refusals, 'CONFIG_REFUSED');

const UNDECLARED = { declared: false as const, revision: null, document: null };

const serialise = <T>(held: Held<T>) => ({
  declared: true as const,
  revision: held.revision,
  document: held.document,
  updatedAt: held.updatedAt.toISOString(),
});

const admin = (ctx: McpContext, projectId: string) =>
  requireCan(actorFor(ctx.principal.userId), 'project.admin', projectResource(projectId));
const reader = (ctx: McpContext, projectId: string) =>
  requireCan(actorFor(ctx.principal.userId), 'project.read', projectResource(projectId));

const parseConfig = parser(configInput, CONFIG_SHAPE);
const parseBindings = parser(bindingsInput, BINDINGS_SHAPE);

async function config(ctx: McpContext, args: Record<string, unknown>) {
  const i = parseConfig(args);
  if (i.action === 'get') {
    await reader(ctx, i.projectId);
    const held = await readProjectConfig(i.projectId);
    return held ? serialise(held) : UNDECLARED;
  }
  await admin(ctx, i.projectId);
  const { baseRevision, document } = envelopeRefusal(() =>
    envelopeOf({ baseRevision: i.baseRevision, document: i.document }),
  );
  const outcome = await writeProjectConfig({
    projectId: i.projectId,
    userId: ctx.principal.userId,
    baseRevision,
    raw: document,
  });
  if (!outcome.ok) throw refused(outcome.refusals);
  return { ...serialise(outcome.held), created: outcome.created };
}

async function bindings(ctx: McpContext, args: Record<string, unknown>) {
  const i = parseBindings(args);
  if (i.action === 'get') {
    await reader(ctx, i.projectId);
    if (!i.binding) {
      const { held, unrepresentable } = await listBindings(i.projectId);
      return {
        bindings: held.map((h) => ({ declared: true as const, ...h })),
        unrepresentable,
        returned: held.length,
      };
    }
    const read = await readBinding(i.projectId, i.binding);
    if (!read) return UNDECLARED;
    if (!read.ok) {
      throw refused([
        {
          code: 'BINDING_NOT_REPRESENTABLE',
          path: '/binding',
          detail: `binding ${i.binding} has no binding-document form: ${read.unrepresentable}`,
        },
      ]);
    }
    return { declared: true as const, ...read.held };
  }
  const { binding } = need(i, 'write', 'binding');
  await admin(ctx, i.projectId);
  const { baseRevision, document } = envelopeRefusal(() =>
    envelopeOf({ baseRevision: i.baseRevision, document: i.document }),
  );
  const outcome = await writeBinding({
    projectId: i.projectId,
    bindingId: binding,
    userId: ctx.principal.userId,
    baseRevision,
    raw: document,
  });
  if (!outcome.ok) throw refused(outcome.refusals);
  return { declared: true as const, ...outcome.held, created: outcome.created };
}

export const forgeConfigTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_config',
  description: CONFIG_DESCRIPTION,
  inputSchema: zodToMcpSchema(configInput),
  route: '/api/projects',
  grant: { byAction: { get: 'projects:read', write: 'projects:write' } },
  reach: 'project',
  handler: async (args) => scrubSecretsDeep(await config(ctx, args)),
});

export const forgeBindingsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_bindings',
  description: BINDINGS_DESCRIPTION,
  inputSchema: zodToMcpSchema(bindingsInput),
  route: '/api/projects',
  grant: { byAction: { get: 'projects:read', write: 'projects:write' } },
  reach: 'project',
  handler: async (args) => scrubSecretsDeep(await bindings(ctx, args)),
});
