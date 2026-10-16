import { withArticle } from '@forge/contracts/articles';
import { SCHEMA_BASE } from '@forge/contracts/project-config';
import type { BindingRole as RowRole } from '../db/release-axes.js';
import type { IntegrationConnectionRow } from '../integrations/index.js';
import { bindEffects } from './bind-effects.js';
import { drizzleBindingStore, type StoredBinding } from './binding-store.js';
import { decodeTarget, encodeTarget } from './binding-target-codec.js';
import { type ApiRefusal, isRecord, parseVersionedDocument, staleBase } from './documents.js';
import { type BindingDocument, bindingDocumentSchema } from './schema.js';
import { readProjectConfig } from './service.js';

const store = drizzleBindingStore;

type HeldBinding = { revision: number; document: BindingDocument };

type BindingRead = { ok: true; held: HeldBinding } | { ok: false; unrepresentable: string };

function toDocument(row: StoredBinding): BindingRead {
  const decoded = decodeTarget(row);
  if (!decoded.ok) return { ok: false, unrepresentable: decoded.reason };
  return {
    ok: true,
    held: {
      revision: row.revision,
      document: {
        $schema: `${SCHEMA_BASE}/binding-v1.json`,
        version: 1,
        id: row.id,
        role: row.role,
        connection: row.connectionId,
        agentAccess: row.agentAccess,
        active: row.active,
        ...(row.instructions === null ? {} : { instructions: row.instructions }),
        target: decoded.target,
      },
    },
  };
}

export async function readBinding(projectId: string, id: string): Promise<BindingRead | null> {
  const row = await store.readBinding(id);
  if (!row || row.projectId !== projectId) return null;
  return toDocument(row);
}

export async function listBindings(projectId: string) {
  const rows = await store.listProjectBindings(projectId);
  const held: HeldBinding[] = [];
  const unrepresentable: {
    id: string;
    provider: string;
    role: string;
    revision: number;
    reason: string;
  }[] = [];
  for (const row of rows) {
    const read = toDocument(row);
    if (read.ok) held.push(read.held);
    else
      unrepresentable.push({
        id: row.id,
        provider: row.provider,
        role: row.role,
        revision: row.revision,
        reason: read.unrepresentable,
      });
  }
  return { held, unrepresentable };
}

async function referencedAs(projectId: string, bindingId: string) {
  const project = await readProjectConfig(projectId);
  if (!project) return [];
  const out: { path: string; role: RowRole }[] = [];
  const { source, environments } = project.document;
  if (source.type === 'storefront' && source.storefront.binding === bindingId) {
    out.push({ path: '/source/storefront/binding', role: 'source' });
  }
  for (const [name, env] of Object.entries(environments)) {
    if ('binding' in env.deployment && env.deployment.binding === bindingId) {
      out.push({ path: `/environments/${name}/deployment/binding`, role: 'deploy' });
    }
  }
  return out;
}

async function connectionRefusals(
  projectId: string,
  userId: string,
  doc: BindingDocument,
  heldConnection: string | null,
  pending: IntegrationConnectionRow | null,
): Promise<ApiRefusal[]> {
  const connection =
    pending?.id === doc.connection ? pending : await store.readConnection(doc.connection);
  const notFound = (why: string): ApiRefusal[] => [
    {
      code: 'CONNECTION_NOT_FOUND',
      path: '/connection',
      detail: `connection ${doc.connection} ${why}; bind a connection you own, one of this project's organisation that you administer, or this Forge's own App.`,
    },
  ];
  if (!connection) return notFound('does not exist');
  if (!connection.active) return notFound('is deactivated');
  const alreadyHeld = heldConnection === connection.id;
  if (connection.ownerType === 'user' && connection.ownerId !== userId && !alreadyHeld) {
    return notFound("is another person's");
  }
  // the instance's own App is any project's to bind; which installation it binds is the provider's
  // check (`verifyBindingTarget`), against what was recorded for this project's org
  if (connection.ownerType === 'org') {
    const orgId = await store.projectOrgId(projectId);
    if (orgId !== connection.ownerId)
      return notFound("belongs to another organisation than this project's");
    if (!alreadyHeld && !(await store.isOrgAdmin(orgId, userId))) {
      return notFound('is an organisation connection, and binding one takes an organisation admin');
    }
  }
  if (connection.provider !== doc.target.provider) {
    return [
      {
        code: 'CONNECTION_PROVIDER_MISMATCH',
        path: '/target/provider',
        detail: `target.provider is "${doc.target.provider}", and connection ${doc.connection} is a "${connection.provider}" connection.`,
      },
    ];
  }
  return [];
}

/** A binding the project document names cannot be switched off under it: the document would name an inactive one. */
function inUse(at: string, path: string): ApiRefusal {
  return {
    code: 'BINDING_IN_USE',
    path,
    detail: `the project document names this binding at ${at}; remove it from the project document before switching the binding off.`,
  };
}

type BindingWriteOutcome =
  | { ok: true; held: HeldBinding; created: boolean; effects: Record<string, unknown> }
  | { ok: false; refusals: ApiRefusal[] };

/** Why the stored row cannot take this write at all: another project's, unrepresentable, or stale. */
function heldRefusal(
  current: Awaited<ReturnType<typeof store.readBinding>>,
  projectId: string,
  bindingId: string,
  baseRevision: number | null,
): ApiRefusal | null {
  if (current && current.projectId !== projectId) {
    return {
      code: 'BINDING_ID_MISMATCH',
      path: '/id',
      detail: `binding ${bindingId} is another project's; choose a new id for this project's binding.`,
    };
  }
  const decoded = current ? decodeTarget(current) : null;
  if (decoded && !decoded.ok && decoded.wouldDrop) {
    return {
      code: 'BINDING_NOT_REPRESENTABLE',
      path: '',
      detail: `binding ${bindingId} has no binding-document form, so a document cannot replace it without losing what it holds: ${decoded.reason}.`,
    };
  }
  const storedRevision = current?.revision ?? null;
  return storedRevision === baseRevision ? null : staleBase(baseRevision, storedRevision);
}

/** Every reason this document cannot be written as it stands, the cheap checks first. */
async function documentRefusals(args: {
  projectId: string;
  userId: string;
  bindingId: string;
  doc: BindingDocument;
  current: Awaited<ReturnType<typeof store.readBinding>>;
  encoded: ReturnType<typeof encodeTarget>;
  pending: IntegrationConnectionRow | null;
}): Promise<ApiRefusal[]> {
  const { projectId, userId, bindingId, doc, current, encoded, pending } = args;
  const refusals: ApiRefusal[] = [];
  if (doc.id !== bindingId) {
    refusals.push({
      code: 'BINDING_ID_MISMATCH',
      path: '/id',
      detail: `id "${doc.id}" is not the binding this URL writes (${bindingId}).`,
    });
  }
  const agentAccess = doc.agentAccess ?? 'none';
  const active = doc.active ?? true;
  refusals.push(
    ...(await connectionRefusals(projectId, userId, doc, current?.connectionId ?? null, pending)),
  );
  refusals.push(
    ...(await bindEffects.refusals({
      userId,
      projectId,
      provider: encoded.provider,
      label: encoded.label,
      agentAccess,
    })),
  );
  for (const ref of await referencedAs(projectId, bindingId)) {
    if (ref.role !== doc.role) {
      refusals.push({
        code: 'BINDING_IN_USE',
        path: '/role',
        detail: `the project document names this binding at ${ref.path}, which needs role "${ref.role}"; change the project document before the role.`,
      });
    }
    if (!active) refusals.push(inUse(ref.path, '/active'));
  }
  return refusals;
}

/** The refusal for a write the compare-and-set did not take. */
export function casRefusal(
  result: Extract<Awaited<ReturnType<typeof store.casBinding>>, { ok: false }>,
  ctx: {
    baseRevision: number | null;
    bindingId: string;
    doc: BindingDocument;
    encoded: ReturnType<typeof encodeTarget>;
  },
): ApiRefusal {
  if (result.reason === 'stale') return staleBase(ctx.baseRevision, result.storedRevision);
  if (result.reason === 'site-key-taken') {
    // two creates naming one key at once: the index took the first, and this is the second
    return {
      code: 'WIDGET_SITE_KEY_TAKEN',
      path: '/target/siteKey',
      detail: 'another widget binding holds this site key; mint a new key for this one.',
    };
  }
  if (result.reason === 'foreign') {
    return {
      code: 'BINDING_ID_MISMATCH',
      path: '/id',
      detail: `binding ${ctx.bindingId} is another project's.`,
    };
  }
  return {
    code: 'BINDING_IN_USE',
    path: '/role',
    detail: `this project already has ${withArticle(ctx.doc.target.provider)} service binding labelled "${ctx.encoded.label}", switched on or off; a service binding is one per provider and label, so write that binding's document, or give this one its own \`target.label\`.`,
  };
}

/** A binding write every check passed, ready for the store. */
export interface PlannedBinding {
  projectId: string;
  bindingId: string;
  baseRevision: number | null;
  doc: BindingDocument;
  encoded: ReturnType<typeof encodeTarget>;
  agentAccess: NonNullable<BindingDocument['agentAccess']>;
  active: boolean;
}

export type BindingPlan =
  | { ok: true; plan: PlannedBinding }
  | { ok: false; refusals: ApiRefusal[] };

/**
 * Every check a binding document meets before it is written, with nothing written. `pending` is a
 * connection the same call creates and has not stored yet: the document may name it, and its
 * target is verified through it.
 */
export async function planBinding(input: {
  projectId: string;
  bindingId: string;
  userId: string;
  baseRevision: number | null;
  raw: unknown;
  pending?: IntegrationConnectionRow | null;
}): Promise<BindingPlan> {
  const { projectId, bindingId, userId, baseRevision, raw } = input;
  const pending = input.pending ?? null;
  const current = await store.readBinding(bindingId);
  const held = heldRefusal(current, projectId, bindingId, baseRevision);
  if (held) return { ok: false, refusals: [held] };
  const parsed = parseVersionedDocument(bindingDocumentSchema, raw, 'binding');
  if (!parsed.ok) return parsed;
  const doc = parsed.value;

  const settled = await bindEffects.settleConfig({
    bindingId,
    provider: doc.target.provider,
    config: encodeTarget(doc.target).config,
    held:
      current?.provider === doc.target.provider && isRecord(current.config) ? current.config : null,
  });
  if (!settled.ok) return settled;
  const encoded = { ...encodeTarget(doc.target), config: settled.config };
  const agentAccess = doc.agentAccess ?? 'none';
  const active = doc.active ?? true;
  const refusals = await documentRefusals({
    projectId,
    userId,
    bindingId,
    doc,
    current,
    encoded,
    pending,
  });
  if (refusals.length > 0) return { ok: false, refusals };
  const unverified = await bindEffects.targetRefusals({
    projectId,
    connectionId: doc.connection,
    provider: encoded.provider,
    config: encoded.config,
    held:
      current?.connectionId === doc.connection && isRecord(current.config) ? current.config : null,
    ...(pending?.id === doc.connection ? { connection: pending } : {}),
  });
  if (unverified.length > 0) return { ok: false, refusals: unverified };
  return {
    ok: true,
    plan: { projectId, bindingId, baseRevision, doc, encoded, agentAccess, active },
  };
}

/**
 * The document a write answers with: what was sent, with the target read back off the config as it
 * is stored, so a value the provider settled on bind (a widget's minted site key) is in the answer.
 */
export function writtenDocumentOf(plan: PlannedBinding): BindingDocument {
  const decoded = decodeTarget({
    provider: plan.encoded.provider,
    config: plan.encoded.config,
    label: plan.encoded.label,
  });
  return {
    ...plan.doc,
    agentAccess: plan.agentAccess,
    active: plan.active,
    target: decoded.ok ? decoded.target : plan.doc.target,
  };
}

export function casWriteOf(plan: PlannedBinding, pending: IntegrationConnectionRow | null) {
  const { doc, encoded } = plan;
  return {
    id: plan.bindingId,
    projectId: plan.projectId,
    connectionId: doc.connection,
    provider: encoded.provider,
    role: doc.role,
    config: encoded.config,
    label: encoded.label,
    agentAccess: plan.agentAccess,
    active: plan.active,
    instructions: doc.instructions ?? null,
    baseRevision: plan.baseRevision,
    integrationSecret: () =>
      bindEffects.inboundSecret(doc.connection, pending?.id === doc.connection ? pending : null),
  };
}

export async function effectsOf(
  plan: PlannedBinding,
  result: { created: boolean; changed: boolean },
): Promise<Record<string, unknown>> {
  if (!result.changed) return {};
  return bindEffects.afterWrite({
    bindingId: plan.bindingId,
    projectId: plan.projectId,
    connectionId: plan.doc.connection,
    provider: plan.encoded.provider,
    role: plan.doc.role,
    config: plan.encoded.config,
    created: result.created,
  });
}

export async function writeBinding(input: {
  projectId: string;
  bindingId: string;
  userId: string;
  baseRevision: number | null;
  raw: unknown;
}): Promise<BindingWriteOutcome> {
  const planned = await planBinding(input);
  if (!planned.ok) return planned;
  const { plan } = planned;
  const result = await store.casBinding(casWriteOf(plan, null));
  if (!result.ok) {
    return {
      ok: false,
      refusals: [
        casRefusal(result, {
          baseRevision: plan.baseRevision,
          bindingId: plan.bindingId,
          doc: plan.doc,
          encoded: plan.encoded,
        }),
      ],
    };
  }
  return {
    ok: true,
    held: {
      revision: result.stored.revision,
      document: writtenDocumentOf(plan),
    },
    created: result.created,
    effects: await effectsOf(plan, result),
  };
}

type BindingRemoveOutcome =
  | { ok: true; revision: number }
  | { ok: false; refusals: ApiRefusal[] }
  | { ok: false; notFound: true };

/**
 * Switch a binding off — the one removal there is, since a binding row is kept for the deliveries
 * that name it. The same path as {@link writeBinding}: the revision it was read at, `BINDING_IN_USE`
 * while the project document names it, the revision bump of a write and its effects after. It
 * takes the binding by id and revision alone and never reads it as a document, so a row with no
 * binding-v1 form (`BINDING_NOT_REPRESENTABLE` to a read) can still be disconnected, keeping every
 * key it holds.
 */
export async function removeBinding(input: {
  projectId: string;
  bindingId: string;
  baseRevision: number;
}): Promise<BindingRemoveOutcome> {
  const { projectId, bindingId, baseRevision } = input;
  const current = await store.readBinding(bindingId);
  if (!current || current.projectId !== projectId) return { ok: false, notFound: true };
  if (current.revision !== baseRevision) {
    return { ok: false, refusals: [staleBase(baseRevision, current.revision)] };
  }
  const refs = await referencedAs(projectId, bindingId);
  if (refs.length > 0) return { ok: false, refusals: refs.map((r) => inUse(r.path, r.path)) };
  const config = current.config as Record<string, unknown>;
  const result = await store.casBinding({
    id: bindingId,
    projectId,
    connectionId: current.connectionId,
    provider: current.provider,
    role: current.role,
    config,
    label: current.label,
    agentAccess: current.agentAccess,
    active: false,
    instructions: current.instructions,
    baseRevision,
    integrationSecret: () => {
      throw new Error(`project-config: removing binding ${bindingId} tried to create it`);
    },
  });
  if (!result.ok) {
    if (result.reason === 'stale') {
      return { ok: false, refusals: [staleBase(baseRevision, result.storedRevision)] };
    }
    if (result.reason === 'foreign') return { ok: false, notFound: true };
    throw new Error(`project-config: switching binding ${bindingId} off clashed with another row`);
  }
  if (result.changed) {
    await bindEffects.afterWrite({
      bindingId,
      projectId,
      connectionId: current.connectionId,
      provider: current.provider,
      role: current.role,
      config,
      created: false,
    });
  }
  return { ok: true, revision: result.stored.revision };
}
