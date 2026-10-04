import type { ActorAgency } from '@forge/contracts/permissions';
import { db, type Tx } from '../db/client.js';
import { permissionFactsOf } from '../permissions/index.js';
import { readProjectDocument, staleBase } from '../project-config/index.js';
import { notFound } from './access.js';
import type { ImpactLink } from './contract/impact.js';
import { storedAs } from './ecosystem-service.js';
import { heldInterface } from './interface-service.js';
import {
  type BuilderRunWorld,
  type BuilderSource,
  builderRunIdentityRefusals,
  builderSourceOf,
  checkBuilderRun,
  checkLink,
  contractKey,
  type DeclaredWithoutCallSite,
  declaredWithoutCallSite,
  isOpenRun,
  type LinkWorld,
  linkIdentityRefusals,
  openedRun,
  parseBuilderRun,
  parseLink,
  stepsStale,
  writerRefusal,
} from './link-rules.js';
import {
  type BuilderRunWrite,
  builderRunWriteSchema,
  type LinkWrite,
  linkWriteSchema,
} from './link-schema.js';
import {
  builderRunsOf,
  insertBuilderRun,
  insertLink,
  linkHolding,
  linksWhere,
  openBuilderRunOf,
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
  | { ok: true; held: Held<W>; created: boolean; report?: RunReport }
  | { ok: false; refusals: EcosystemRefusal[] };

interface RecordKind<W> {
  what: string;
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

async function writerMiss(kind: RecordKind<unknown>, writer: RecordWriter, projectId: string) {
  const refusal = writerRefusal(
    await permissionFactsOf(writer.userId, projectId),
    `writing a ${kind.what}`,
  );
  return refusal ? { ok: false as const, refusals: [refusal] } : null;
}

interface WriteInput {
  projectId: string;
  writer: RecordWriter;
  baseRevision: number | null;
  raw: unknown;
}

async function createRecord<W>(kind: RecordKind<W>, input: WriteInput): Promise<RecordOutcome<W>> {
  const { projectId, writer, baseRevision, raw } = input;
  const denied = await writerMiss(kind as RecordKind<unknown>, writer, projectId);
  if (denied) return denied;
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
  const denied = await writerMiss(kind as RecordKind<unknown>, writer, projectId);
  if (denied) return denied;
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

/** Where the project's code lives, read from its project document. */
export async function sourceOf(projectId: string): Promise<BuilderSource> {
  return builderSourceOf((await readProjectDocument(projectId))?.document);
}

async function linkWorld(tx: Tx, doc: LinkWrite, selfId: string | null): Promise<LinkWorld> {
  const consumer = doc.consumer.project;
  const provider = doc.contract.provider;
  const [active, providers, versions, holding, consumerSource] = await Promise.all([
    activeEcosystemIdsOf(tx, [consumer, provider]),
    projectsWhere(tx, { ids: [provider] }),
    recordedVersions(tx, [provider]),
    linkHolding(tx, doc),
    sourceOf(consumer),
  ]);
  const activeIn = (p: string) =>
    new Set(active.filter((a) => a.projectId === p).map((a) => a.ecosystemId));
  const declared = providers.length > 0 ? await readInterface(tx, provider) : null;
  return {
    consumerSource,
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
  parse: parseLink,
  stored: (row) => storedAs(linkWriteSchema, row.document, `link ${row.id}`),
  identity: linkIdentityRefusals,
  check: async (tx, doc, selfId) => checkLink(doc, await linkWorld(tx, doc, selfId)),
  read: readLink,
  insert: insertLink,
  replace: replaceLink,
};

async function builderRunWorld(
  tx: Tx,
  doc: BuilderRunWrite,
  selfId: string | null,
): Promise<BuilderRunWorld> {
  const [active, members, links, openRun, source] = await Promise.all([
    activeEcosystemIdsOf(tx, [doc.project]),
    activeMembersOf(tx, doc.ecosystem),
    linksWhere(tx, { consumerId: doc.project, ecosystemIds: [doc.ecosystem] }),
    openBuilderRunOf(tx, { projectId: doc.project, ecosystemId: doc.ecosystem, exceptId: selfId }),
    sourceOf(doc.project),
  ]);
  const published = new Set<string>();
  for (const [provider, stored] of await readInterfaces(tx, members)) {
    for (const [slug, pub] of Object.entries(heldInterface(stored, provider).document.publishes)) {
      if (pub.ecosystems.includes(doc.ecosystem)) published.add(contractKey({ provider, slug }));
    }
  }
  return {
    source,
    projectActiveIn: new Set(active.map((a) => a.ecosystemId)),
    published,
    links: new Set(links.map((l) => l.id)),
    openRun,
    creating: selfId === null,
  };
}

const BUILDER_RUN: RecordKind<BuilderRunWrite> = {
  what: 'builder run',
  parse: parseBuilderRun,
  stored: (row) => storedAs(builderRunWriteSchema, row.document, `builder run ${row.id}`),
  identity: builderRunIdentityRefusals,
  check: async (tx, doc, selfId) => checkBuilderRun(doc, await builderRunWorld(tx, doc, selfId)),
  read: readBuilderRun,
  insert: insertBuilderRun,
  replace: replaceBuilderRun,
};

export const createLink = (input: WriteInput) => createRecord(LINK, input);
export const updateLink = (input: WriteInput & { id: string }) => updateRecord(LINK, input);
export type RunReport = Awaited<ReturnType<typeof finishedRunReport>>;

async function reported(
  outcome: RecordOutcome<BuilderRunWrite>,
): Promise<RecordOutcome<BuilderRunWrite>> {
  if (!outcome.ok) return outcome;
  return { ...outcome, report: await finishedRunReport(outcome.held.document) };
}

export const createBuilderRun = async (input: WriteInput) =>
  reported(await createRecord(BUILDER_RUN, input));
export const updateBuilderRun = async (input: WriteInput & { id: string }) =>
  reported(await updateRecord(BUILDER_RUN, input));

export const storedLink = LINK.stored;
export const storedBuilderRun = BUILDER_RUN.stored;

/**
 * Open the run a join or a push owes this project, inside the caller's transaction, or answer
 * the run already open: a project works one run per ecosystem at a time, so a push landing
 * while one is open is folded into it rather than stacked beside it.
 */
export async function openOwedRun(
  tx: Tx,
  input: {
    ecosystemId: string;
    projectId: string;
    trigger: BuilderRunWrite['trigger'];
    userId: string;
  },
): Promise<{ id: string; opened: boolean }> {
  const { ecosystemId, projectId, trigger, userId } = input;
  await lockKeys(tx, [`${BUILDER_RUN.what}:${projectId}`]);
  const open = await openBuilderRunOf(tx, { projectId, ecosystemId, exceptId: null });
  if (open) return { id: open, opened: false };
  const source = await sourceOf(projectId);
  const doc = openedRun({ ecosystem: ecosystemId, project: projectId, trigger, source });
  const row = await insertBuilderRun(tx, doc, userId);
  return { id: row.id, opened: true };
}

/** What a finished run leaves unsaid by its own findings: each declared consumption no link it holds calls. */
export async function finishedRunReport(
  doc: BuilderRunWrite,
): Promise<{ open: boolean; declaredWithoutCallSite: DeclaredWithoutCallSite[] }> {
  if (isOpenRun(doc)) return { open: true, declaredWithoutCallSite: [] };
  const stored = await readInterface(db, doc.project);
  if (!stored) return { open: false, declaredWithoutCallSite: [] };
  const consumes = heldInterface(stored, doc.project).document.consumes;
  const links = await linksWhere(db, { consumerId: doc.project, ecosystemIds: [doc.ecosystem] });
  const providers = await projectsWhere(db, { ids: links.map((l) => l.providerProjectId) });
  const slugOf = new Map(providers.map((p) => [p.id, p.slug]));
  const called = new Set(
    links
      .filter((l) => storedLink(l).callSites.length > 0)
      .map((l) => `${slugOf.get(l.providerProjectId) ?? l.providerProjectId}/${l.contractSlug}`),
  );
  return {
    open: false,
    declaredWithoutCallSite: declaredWithoutCallSite({
      ecosystem: doc.ecosystem,
      consumes,
      called,
    }),
  };
}

/** Every builder run this project still owes, oldest first: the work its box nudges its master for. */
export async function openRunsOf(projectId: string): Promise<
  {
    id: string;
    ecosystem: string;
    trigger: BuilderRunWrite['trigger'];
    steps: number;
    done: number;
    stepsStale: boolean;
  }[]
> {
  const rows = await builderRunsOf(db, projectId);
  const source = await sourceOf(projectId);
  return rows
    .map((row) => ({ row, doc: storedBuilderRun(row) }))
    .filter(({ doc }) => isOpenRun(doc))
    .reverse()
    .map(({ row, doc }) => ({
      id: row.id,
      ecosystem: doc.ecosystem,
      trigger: doc.trigger,
      steps: doc.steps.length,
      done: doc.steps.filter((s) => !['pending', 'running'].includes(s.status)).length,
      stepsStale: stepsStale(doc, source),
    }));
}

export function impactLink(
  row: StoredLink,
): ImpactLink & { provider: string; contractSlug: string } {
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
