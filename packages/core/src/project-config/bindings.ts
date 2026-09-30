import type { BindingRole as RowRole } from '../db/release-axes.js';
import { type BindingStore, drizzleBindingStore, type StoredBinding } from './binding-store.js';
import { decodeTarget, encodeTarget } from './binding-target-codec.js';
import { type ApiRefusal, parseVersionedDocument, staleBase } from './documents.js';
import { type BindingDocument, bindingDocumentSchema, SCHEMA_BASE } from './schema.js';
import { readProjectConfig } from './service.js';

const store: BindingStore = drizzleBindingStore;

// cm:why one deploy binding serves one environment (BINDING_IN_USE), so the environment's tier
// says where it ships; the row still owes the stage column its check demands, and live is the
// stage whose flows run only on an explicit release.
const DEPLOY_STAGES = ['live'];

export type HeldBinding = { revision: number; document: BindingDocument };

export type BindingRead = { ok: true; held: HeldBinding } | { ok: false; unrepresentable: string };

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
        target: decoded.target,
      },
    },
  };
}

export async function readBinding(projectId: string, id: string): Promise<BindingRead | null> {
  const row = await store.readBinding(id);
  if (!row || row.projectId !== projectId || !row.active) return null;
  return toDocument(row);
}

export async function listBindings(projectId: string) {
  const rows = (await store.listProjectBindings(projectId)).filter((r) => r.active);
  const held: HeldBinding[] = [];
  const unrepresentable: { id: string; provider: string; role: string; reason: string }[] = [];
  for (const row of rows) {
    const read = toDocument(row);
    if (read.ok) held.push(read.held);
    else
      unrepresentable.push({
        id: row.id,
        provider: row.provider,
        role: row.role,
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
): Promise<ApiRefusal[]> {
  const connection = await store.readConnection(doc.connection);
  const notFound = (why: string): ApiRefusal[] => [
    {
      code: 'CONNECTION_NOT_FOUND',
      path: '/connection',
      detail: `connection ${doc.connection} ${why}; bind a connection you own, or one of this project's organisation that you administer.`,
    },
  ];
  if (!connection) return notFound('does not exist');
  if (!connection.active) return notFound('is deactivated');
  if (connection.ownerType === 'user' && connection.ownerId !== userId) {
    return notFound("is another person's");
  }
  if (connection.ownerType === 'org') {
    const orgId = await store.projectOrgId(projectId);
    if (orgId !== connection.ownerId)
      return notFound("belongs to another organisation than this project's");
    if (!(await store.isOrgAdmin(orgId, userId))) {
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

export type BindingWriteOutcome =
  | { ok: true; held: HeldBinding; created: boolean }
  | { ok: false; refusals: ApiRefusal[] };

export async function writeBinding(input: {
  projectId: string;
  bindingId: string;
  userId: string;
  baseRevision: number | null;
  raw: unknown;
}): Promise<BindingWriteOutcome> {
  const { projectId, bindingId, userId, baseRevision, raw } = input;
  const current = await store.readBinding(bindingId);
  if (current && current.projectId !== projectId) {
    return {
      ok: false,
      refusals: [
        {
          code: 'BINDING_ID_MISMATCH',
          path: '/id',
          detail: `binding ${bindingId} is another project's; choose a new id for this project's binding.`,
        },
      ],
    };
  }
  const storedRevision = current?.revision ?? null;
  if (storedRevision !== baseRevision) {
    return { ok: false, refusals: [staleBase(baseRevision, storedRevision)] };
  }
  const parsed = parseVersionedDocument(bindingDocumentSchema, raw, 'binding');
  if (!parsed.ok) return parsed;
  const doc = parsed.value;

  const refusals: ApiRefusal[] = [];
  if (doc.id !== bindingId) {
    refusals.push({
      code: 'BINDING_ID_MISMATCH',
      path: '/id',
      detail: `id "${doc.id}" is not the binding this URL writes (${bindingId}).`,
    });
  }
  const encoded = encodeTarget(doc.target);
  if (!encoded.ok) refusals.push(encoded.refusal);
  refusals.push(...(await connectionRefusals(projectId, userId, doc)));
  for (const ref of await referencedAs(projectId, bindingId)) {
    if (ref.role !== doc.role) {
      refusals.push({
        code: 'BINDING_IN_USE',
        path: '/role',
        detail: `the project document names this binding at ${ref.path}, which needs role "${ref.role}"; change the project document before the role.`,
      });
    }
  }
  if (refusals.length > 0 || !encoded.ok) return { ok: false, refusals };

  const result = await store.casBinding({
    id: bindingId,
    projectId,
    connectionId: doc.connection,
    provider: encoded.provider,
    role: doc.role,
    stages: doc.role === 'deploy' ? DEPLOY_STAGES : [],
    config: encoded.config,
    baseRevision,
  });
  if (!result.ok) {
    if (result.reason === 'stale') {
      return { ok: false, refusals: [staleBase(baseRevision, result.storedRevision)] };
    }
    return {
      ok: false,
      refusals: [
        result.reason === 'foreign'
          ? {
              code: 'BINDING_ID_MISMATCH',
              path: '/id',
              detail: `binding ${bindingId} is another project's.`,
            }
          : {
              code: 'BINDING_IN_USE',
              path: '/role',
              detail: `this project already has an active ${doc.target.provider} service binding; one service binding per provider.`,
            },
      ],
    };
  }
  return {
    ok: true,
    held: { revision: result.stored.revision, document: doc },
    created: result.created,
  };
}
