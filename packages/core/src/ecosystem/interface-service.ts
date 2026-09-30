import { db, type Tx } from '../db/client.js';
import { isRecord, parseVersionedDocument, staleBase } from '../project-config/documents.js';
import { notFound } from './access.js';
import { heldEcosystem, storedAs } from './ecosystem-service.js';
import {
  checkInterface,
  type InterfaceWorld,
  type ProviderView,
  splitContractRef,
  versionKey,
} from './interface-rules.js';
import { type EcosystemRefusal, renameParseRefusals } from './refusals.js';
import {
  type EcosystemDocument,
  type InterfaceDocument,
  interfaceDocumentSchema,
} from './schema.js';
import {
  activeEcosystemIdsOf,
  consumersOf,
  type EdgeRow,
  lockKeys,
  type ProjectRow,
  projectsWhere,
  putInterface,
  readEcosystems,
  readInterface,
  readInterfaces,
  recordedVersions,
  type StoredDocument,
} from './store.js';

export interface HeldInterface {
  revision: number;
  document: InterfaceDocument;
  updatedBy: string;
  updatedAt: Date;
}

export type InterfaceOutcome =
  | { ok: true; held: HeldInterface; created: boolean }
  | { ok: false; refusals: EcosystemRefusal[] };

export function heldInterface(row: StoredDocument, projectId: string): HeldInterface {
  return {
    ...row,
    document: storedAs(interfaceDocumentSchema, row.document, `interface of ${projectId}`),
  };
}

export async function loadInterface(projectId: string): Promise<HeldInterface | null> {
  const row = await readInterface(db, projectId);
  return row ? heldInterface(row, projectId) : null;
}

async function buildWorld(
  tx: Tx,
  self: ProjectRow,
  providers: readonly ProjectRow[],
): Promise<InterfaceWorld> {
  const ids = [self.id, ...providers.map((p) => p.id)];
  const [active, interfaces, versions, consumers] = await Promise.all([
    activeEcosystemIdsOf(tx, ids),
    readInterfaces(
      tx,
      providers.map((p) => p.id),
    ),
    recordedVersions(
      tx,
      providers.map((p) => p.id),
    ),
    consumersOf(tx, self.id),
  ]);
  const activeIn = (projectId: string) =>
    new Set(active.filter((a) => a.projectId === projectId).map((a) => a.ecosystemId));
  const ecos = await readEcosystems(tx, [...activeIn(self.id)]);
  const versionSets = new Map<string, Set<string>>();
  for (const v of versions) {
    const key = versionKey(v.providerProjectId, v.contractSlug);
    versionSets.set(key, (versionSets.get(key) ?? new Set()).add(v.version));
  }
  return {
    project: { id: self.id, slug: self.slug },
    activeEcosystems: new Map<string, EcosystemDocument>(
      ecos.map((e) => [e.id, heldEcosystem(e).document]),
    ),
    providers: new Map<string, ProviderView>(
      providers.map((p) => {
        const stored = interfaces.get(p.id);
        return [
          p.slug,
          {
            projectId: p.id,
            interface: stored ? heldInterface(stored, p.id).document : null,
            activeIn: activeIn(p.id),
          },
        ];
      }),
    ),
    versions: versionSets,
    consumersOfMine: consumers
      .filter((c) => c.consumerId !== self.id)
      .map((c) => ({
        consumer: { id: c.consumerId, slug: c.consumerSlug },
        contractSlug: c.contractSlug,
        ecosystemId: c.ecosystemId,
      })),
  };
}

function edgesOf(
  doc: InterfaceDocument,
  self: string,
  providers: readonly ProjectRow[],
): EdgeRow[] {
  return doc.consumes.map((c) => {
    const { provider, contract } = splitContractRef(c.contract);
    const row = providers.find((p) => p.slug === provider);
    if (!row) throw new Error(`ecosystem: ${c.contract} passed the rules with no provider row`);
    return {
      consumerProjectId: self,
      providerProjectId: row.id,
      contractSlug: contract,
      ecosystemId: c.ecosystem,
      builtAgainst: c.builtAgainst,
    };
  });
}

function parseInterface(raw: unknown, projectId: string): EcosystemRefusal[] | InterfaceDocument {
  const claimed = isRecord(raw) ? raw.project : undefined;
  const refusals: EcosystemRefusal[] =
    claimed !== undefined && claimed !== projectId
      ? [
          {
            code: 'PROJECT_ID_IMMUTABLE',
            path: '/project',
            detail: `project ${JSON.stringify(claimed)} is not this project; the interface at /api/projects/${projectId}/interface names ${projectId}.`,
          },
        ]
      : [];
  const parsed = parseVersionedDocument(interfaceDocumentSchema, raw, 'interface');
  if (!parsed.ok) return [...refusals, ...renameParseRefusals(parsed.refusals)];
  return refusals.length > 0 ? refusals : parsed.value;
}

export async function writeInterface(input: {
  projectId: string;
  userId: string;
  baseRevision: number | null;
  raw: unknown;
}): Promise<InterfaceOutcome> {
  const { projectId, userId, baseRevision, raw } = input;
  const parsed = parseInterface(raw, projectId);
  if (Array.isArray(parsed)) return { ok: false, refusals: parsed };
  const doc = parsed;
  const [self] = await projectsWhere(db, { ids: [projectId] });
  if (!self) throw notFound(`project ${projectId} does not exist`);
  const slugs = [...new Set(doc.consumes.map((c) => splitContractRef(c.contract).provider))];
  const providers = (await projectsWhere(db, { slugs })).filter((p) => p.id !== self.id);
  return db.transaction(async (tx) => {
    await lockKeys(tx, [`project:${self.id}`, ...providers.map((p) => `project:${p.id}`)]);
    const current = await readInterface(tx, projectId);
    const storedRevision = current?.revision ?? null;
    if (storedRevision !== baseRevision) {
      return { ok: false, refusals: [staleBase(baseRevision, storedRevision)] };
    }
    const refusals = checkInterface(doc, await buildWorld(tx, self, providers));
    if (refusals.length > 0) return { ok: false, refusals };
    if (current && JSON.stringify(current.document) === JSON.stringify(doc)) {
      return { ok: true, held: heldInterface(current, projectId), created: false };
    }
    const row = await putInterface(
      tx,
      { projectId, revision: (storedRevision ?? 0) + 1, userId },
      doc,
      edgesOf(doc, self.id, providers),
    );
    return { ok: true, held: heldInterface(row, projectId), created: current === null };
  });
}
