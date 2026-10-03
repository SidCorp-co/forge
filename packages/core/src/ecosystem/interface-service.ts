import { db, type Tx } from '../db/client.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { isRecord, parseVersionedDocument, staleBase } from '../project-config/documents.js';
import { notFound } from './access.js';
import { versionsOf } from './contract/store.js';
import { heldEcosystem, storedAs } from './ecosystem-service.js';
import {
  checkInterface,
  type InterfaceWorld,
  type ProviderView,
  splitContractRef,
  versionKey,
} from './interface-rules.js';
import {
  type CommitmentsSetter,
  commitmentsRefusal,
  commitmentsSetterOf,
  type ProviderWriterCode,
  providerWriterRefusal,
} from './provider-writer-rules.js';
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
  interfaceRevisionsBy,
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

export interface ProviderWriter {
  userId: string;
  agency: ActorAgency;
}

/** The refusal, under its code, of a writer that is neither the project's own agent nor a person holding admin on it. */
export async function providerWriterMiss(
  writer: ProviderWriter,
  projectId: string,
  code: ProviderWriterCode,
): Promise<EcosystemRefusal | null> {
  const role = (await effectiveProjectRole(writer.userId, projectId))?.role ?? null;
  return providerWriterRefusal({ ...writer, role }, projectId, code);
}

/** Who set the commitments the interface makes now, so a reader can tell an agent's proposal from a person's decision. */
export async function commitmentsSetter(projectId: string): Promise<CommitmentsSetter | null> {
  return commitmentsSetterOf(await interfaceRevisionsBy(db, projectId));
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
  const [active, interfaces, versions, consumers, indexed] = await Promise.all([
    activeEcosystemIdsOf(tx, ids),
    readInterfaces(
      tx,
      providers.map((p) => p.id),
    ),
    recordedVersions(tx, ids),
    consumersOf(tx, self.id),
    versionsOf(tx, ids),
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
    elements: new Map(
      indexed.map((v) => [
        `${versionKey(v.providerProjectId, v.contractSlug)}@${v.version}`,
        v.elements ? new Set(v.elements) : null,
      ]),
    ),
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
  // cm:why an in-project consumption is no ecosystem edge: `ecosystem_consumptions` holds what one project consumes of another, and the project's own modules reach its contract through the interface and its in-project links
  return doc.consumes.flatMap((c) => {
    const ecosystemId = c.ecosystem;
    if (ecosystemId === undefined) return [];
    const { provider, contract } = splitContractRef(c.contract);
    const row = providers.find((p) => p.slug === provider);
    if (!row) throw new Error(`ecosystem: ${c.contract} passed the rules with no provider row`);
    return [
      {
        consumerProjectId: self,
        providerProjectId: row.id,
        contractSlug: contract,
        ecosystemId,
        builtAgainst: c.builtAgainst,
      },
    ];
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
  writer: ProviderWriter;
  baseRevision: number | null;
  raw: unknown;
}): Promise<InterfaceOutcome> {
  const { projectId, writer, baseRevision, raw } = input;
  const userId = writer.userId;
  const denied = await providerWriterMiss(writer, projectId, 'INTERFACE_WRITER_NOT_PROJECT');
  if (denied) return { ok: false, refusals: [denied] };
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
    const setter = current ? commitmentsSetterOf(await interfaceRevisionsBy(tx, projectId)) : null;
    const commitments = commitmentsRefusal(writer, setter, current?.document, doc);
    const refusals = [
      ...(commitments ? [commitments] : []),
      ...checkInterface(doc, await buildWorld(tx, self, providers)),
    ];
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
