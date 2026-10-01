import type { ImpactLink } from './contract/impact.js';
import { db, type Tx } from '../db/client.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { staleBase } from '../project-config/documents.js';
import { notFound, refusedBy } from './access.js';
import { storedAs } from './ecosystem-service.js';
import { heldInterface } from './interface-service.js';
import {
  type BuilderRunWorld,
  builderRunIdentityRefusals,
  checkBuilderRun,
  checkLink,
  contractKey,
  type LinkWorld,
  linkIdentityRefusals,
  parseBuilderRun,
  parseLink,
  writerRefusal,
} from './link-rules.js';
import {
  type BuilderRunWrite,
  builderRunWriteSchema,
  type LinkWrite,
  linkWriteSchema,
} from './link-schema.js';
import {
  insertBuilderRun,
  insertLink,
  linkHolding,
  linksWhere,
  readBuilderRun,
  readLink,
  replaceBuilderRun,
  replaceLink,
  type StoredLink,
  type StoredRecord,
} from './link-store.js';
import type { Checked, EcosystemRefusal } from './refusals.js';
import {
  activeEcosystemIdsOf,
  activeMembersOf,
  lockKeys,
  projectsWhere,
  readInterface,
  readInterfaces,
  recordedVersions,
} from './store.js';

export interface RecordWriter {
  userId: string;
  agency: ActorAgency;
}

export interface Held<W> {
  row: StoredRecord;
  document: W;
}

export type RecordOutcome<W> =
  | { ok: true; held: Held<W>; created: boolean }
  | { ok: false; refusals: EcosystemRefusal[] };

interface RecordKind<W> {
  what: string;
  writerCode: 'LINK_WRITER_NOT_CONSUMER' | 'BUILDER_RUN_WRITER_NOT_PROJECT';
  parse(raw: unknown, projectId: string): Checked<W>;
  stored(row: StoredRecord): W;
  identity(stored: W, next: W): EcosystemRefusal[];
  check(tx: Tx, doc: W, selfId: string | null): Promise<EcosystemRefusal[]>;
  read(tx: Tx, id: string): Promise<StoredRecord | null>;
  insert(tx: Tx, doc: W, userId: string): Promise<StoredRecord>;
  replace(
    tx: Tx,
    input: { id: string; revision: number; doc: W; userId: string },
  ): Promise<StoredRecord>;
}

async function assertWriter(kind: RecordKind<unknown>, writer: RecordWriter, projectId: string) {
  const role = (await effectiveProjectRole(writer.userId, projectId))?.role ?? null;
  const refusal = writerRefusal({ ...writer, role }, projectId, kind.writerCode);
  if (refusal) throw refusedBy(refusal);
}

interface WriteInput {
  projectId: string;
  writer: RecordWriter;
  baseRevision: number | null;
  raw: unknown;
}

async function createRecord<W>(kind: RecordKind<W>, input: WriteInput): Promise<RecordOutcome<W>> {
  const { projectId, writer, baseRevision, raw } = input;
  await assertWriter(kind as RecordKind<unknown>, writer, projectId);
  if (baseRevision !== null) {
    return {
      ok: false,
      refusals: [
        {
          code: 'STALE_BASE',
          path: '/baseRevision',
          detail: `this creates a ${kind.what}, which has no revision to base on; send baseRevision null, not ${baseRevision}.`,
        },
      ],
    };
  }
  const parsed = kind.parse(raw, projectId);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  return db.transaction(async (tx) => {
    await lockKeys(tx, [`${kind.what}:${projectId}`]);
    const refusals = await kind.check(tx, doc, null);
    if (refusals.length > 0) return { ok: false, refusals };
    const row = await kind.insert(tx, doc, writer.userId);
    return { ok: true, held: { row, document: doc }, created: true };
  });
}

async function updateRecord<W>(
  kind: RecordKind<W>,
  input: WriteInput & { id: string },
): Promise<RecordOutcome<W>> {
  const { projectId, writer, baseRevision, raw, id } = input;
  await assertWriter(kind as RecordKind<unknown>, writer, projectId);
  const parsed = kind.parse(raw, projectId);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  return db.transaction(async (tx) => {
    await lockKeys(tx, [`${kind.what}:${projectId}`]);
    const row = await kind.read(tx, id);
    if (!row || row.projectId !== projectId) {
      throw notFound(`project ${projectId} holds no ${kind.what} ${id}`);
    }
    if (row.revision !== baseRevision) {
      return { ok: false, refusals: [staleBase(baseRevision, row.revision)] };
    }
    const stored = kind.stored(row);
    const refusals = [...kind.identity(stored, doc), ...(await kind.check(tx, doc, row.id))];
    if (refusals.length > 0) return { ok: false, refusals };
    if (JSON.stringify(stored) === JSON.stringify(doc)) {
      return { ok: true, held: { row, document: stored }, created: false };
    }
    const next = await kind.replace(tx, { id, revision: row.revision, doc, userId: writer.userId });
    return { ok: true, held: { row: next, document: doc }, created: false };
  });
}

async function linkWorld(tx: Tx, doc: LinkWrite, selfId: string | null): Promise<LinkWorld> {
  const consumer = doc.consumer.project;
  const provider = doc.contract.provider;
  const [active, providers, versions, holding] = await Promise.all([
    activeEcosystemIdsOf(tx, [consumer, provider]),
    projectsWhere(tx, { ids: [provider] }),
    recordedVersions(tx, [provider]),
    linkHolding(tx, doc),
  ]);
  const activeIn = (p: string) =>
    new Set(active.filter((a) => a.projectId === p).map((a) => a.ecosystemId));
  const declared = providers.length > 0 ? await readInterface(tx, provider) : null;
  return {
    consumerActiveIn: activeIn(consumer),
    provider:
      providers.length > 0
        ? {
            id: provider,
            activeIn: activeIn(provider),
            interface: declared ? heldInterface(declared, provider).document : null,
          }
        : null,
    versions: new Set(
      versions.filter((v) => v.contractSlug === doc.contract.slug).map((v) => v.version),
    ),
    duplicateOf: holding !== null && holding !== selfId ? holding : null,
  };
}

const LINK: RecordKind<LinkWrite> = {
  what: 'link',
  writerCode: 'LINK_WRITER_NOT_CONSUMER',
  parse: parseLink,
  stored: (row) => storedAs(linkWriteSchema, row.document, `link ${row.id}`),
  identity: linkIdentityRefusals,
  check: async (tx, doc, selfId) => checkLink(doc, await linkWorld(tx, doc, selfId)),
  read: readLink,
  insert: insertLink,
  replace: replaceLink,
};

async function builderRunWorld(tx: Tx, doc: BuilderRunWrite): Promise<BuilderRunWorld> {
  const [active, members, links] = await Promise.all([
    activeEcosystemIdsOf(tx, [doc.project]),
    activeMembersOf(tx, doc.ecosystem),
    linksWhere(tx, { consumerId: doc.project, ecosystemIds: [doc.ecosystem] }),
  ]);
  const published = new Set<string>();
  for (const [provider, stored] of await readInterfaces(tx, members)) {
    for (const [slug, pub] of Object.entries(heldInterface(stored, provider).document.publishes)) {
      if (pub.ecosystems.includes(doc.ecosystem)) published.add(contractKey({ provider, slug }));
    }
  }
  return {
    projectActiveIn: new Set(active.map((a) => a.ecosystemId)),
    published,
    links: new Set(links.map((l) => l.id)),
  };
}

const BUILDER_RUN: RecordKind<BuilderRunWrite> = {
  what: 'builder run',
  writerCode: 'BUILDER_RUN_WRITER_NOT_PROJECT',
  parse: parseBuilderRun,
  stored: (row) => storedAs(builderRunWriteSchema, row.document, `builder run ${row.id}`),
  identity: builderRunIdentityRefusals,
  check: async (tx, doc) => checkBuilderRun(doc, await builderRunWorld(tx, doc)),
  read: readBuilderRun,
  insert: insertBuilderRun,
  replace: replaceBuilderRun,
};

export const createLink = (input: WriteInput) => createRecord(LINK, input);
export const updateLink = (input: WriteInput & { id: string }) => updateRecord(LINK, input);
export const createBuilderRun = (input: WriteInput) => createRecord(BUILDER_RUN, input);
export const updateBuilderRun = (input: WriteInput & { id: string }) =>
  updateRecord(BUILDER_RUN, input);

export const storedLink = LINK.stored;
export const storedBuilderRun = BUILDER_RUN.stored;

export function impactLink(row: StoredLink): ImpactLink & { provider: string; contractSlug: string } {
  const doc = storedLink(row);
  return {
    id: row.id,
    consumer: row.projectId,
    module: row.modulePath,
    pinnedVersion: row.pinnedVersion,
    callSites: doc.callSites,
    fieldsUsed: doc.fieldsUsed,
    outsideContract: doc.outsideContract,
    provider: row.providerProjectId,
    contractSlug: row.contractSlug,
  };
}
