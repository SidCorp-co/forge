import type { ActorAgency } from '@forge/contracts/permissions';
import { db, type Tx } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { emitEvent } from '../outbox/index.js';
import { permissionFactsOf } from '../permissions/index.js';
import { readProjectDocument, staleBase } from '../project-config/index.js';
import { notFound } from './access.js';
import { type HeadRead, projectHead } from './builder-head.js';
import {
  type BuilderRunWorld,
  builderRunIdentityRefusals,
  checkBuilderRun,
  contractKey,
  type DeclaredWithoutCallSite,
  declaredWithoutCallSite,
  isOpenRun,
  openedRun,
  stepsStale,
} from './builder-run-rules.js';
import type { ImpactLink } from './contract/impact.js';
import { storedAs } from './ecosystem-service.js';
import { heldInterface } from './interface-service.js';
import { readInterface, readInterfaces } from './interface-store.js';
import {
  type BuilderSource,
  builderSourceOf,
  checkLink,
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
import { activeEcosystemIdsOf, activeMembersOf } from './membership-store.js';
import type { Checked, EcosystemRefusal } from './refusals.js';
import { lockKeys, projectsWhere, recordedVersions } from './store.js';

export interface RecordWriter {
  userId: string;
  agency: ActorAgency;
}

export interface Held<W> {
  row: StoredRecord;
  document: W;
}

export type RecordOutcome<W> =
  | {
      ok: true;
      held: Held<W>;
      created: boolean;
      /** What an update replaced: the stored document before this write. */
      previous?: W;
      report?: RunReport;
    }
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
      return { ok: true, held: { row, document: stored }, created: false, previous: stored };
    }
    const next = await kind.replace(tx, { id, revision: row.revision, doc, userId: writer.userId });
    return { ok: true, held: { row: next, document: doc }, created: false, previous: stored };
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
    versions: new Map(
      versions
        .filter((v) => v.contractSlug === doc.contract.slug)
        .map((v) => [v.version, v.approval]),
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
export type RunReport = Awaited<ReturnType<typeof finishedRunReport>> & {
  /** Where this write finished the run: the run opened at the head that moved past it, or why none did. */
  next?: NextRun;
};

/** What finishing a run left owed: a run at the branch head it did not map, or why none opened. */
export type NextRun =
  | { opened: string; at: string; mapped: string }
  | { opened: null; why: string };

async function reported(
  outcome: RecordOutcome<BuilderRunWrite>,
  writer: RecordWriter,
): Promise<RecordOutcome<BuilderRunWrite>> {
  if (!outcome.ok) return outcome;
  const report: RunReport = await finishedRunReport(outcome.held.document);
  const doc = outcome.held.document;
  const finished = outcome.previous !== undefined && isOpenRun(outcome.previous) && !isOpenRun(doc);
  if (finished && !doc.supersededBy) {
    const next = await openAtMovedHead(doc, writer.userId);
    if (next) report.next = next;
  }
  return { ...outcome, report };
}

export const createBuilderRun = async (input: WriteInput) =>
  reported(await createRecord(BUILDER_RUN, input), input.writer);
export const updateBuilderRun = async (input: WriteInput & { id: string }) =>
  reported(await updateRecord(BUILDER_RUN, input), input.writer);

/**
 * The run a finished one leaves owed: a push landing while a run is open opens nothing
 * (`openOwedRun` answers the open run), so when the run finishes its project's build branch is read
 * again, and where its head is no longer the commit the run mapped, exactly one run opens at that
 * head (trigger `push`): however many pushes landed meanwhile, they are mapped once, at the latest.
 * Null where nothing is owed (a storefront run names no commit, or the head is still the one mapped).
 * A head that cannot be read opens nothing and says so in the answer, and the next push opens the run.
 */
export async function openAtMovedHead(
  doc: BuilderRunWrite,
  userId: string,
  read: (projectId: string) => Promise<HeadRead> = (id) => projectHead.read(id),
): Promise<NextRun | null> {
  const mapped = doc.trigger.sha;
  if (mapped === null) return null;
  const projectId = doc.project;
  let head: HeadRead;
  try {
    head = await read(projectId);
  } catch (err) {
    head = { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
  if (!head.ok) {
    const why = `the branch this project builds from could not be read after run finished at ${mapped.slice(0, 12)}, so no run opened at a later head: ${head.why}. The next push to it opens one`;
    logger.warn({ projectId, ecosystemId: doc.ecosystem, mapped }, why);
    return { opened: null, why };
  }
  const at = head.value.sha.toLowerCase();
  if (at === mapped.toLowerCase()) return null;
  return db.transaction(async (tx): Promise<NextRun> => {
    const active = await activeEcosystemIdsOf(tx, [projectId]);
    if (!active.some((a) => a.ecosystemId === doc.ecosystem)) {
      return {
        opened: null,
        why: `the head moved to ${at.slice(0, 12)}, and project ${projectId} is no longer an active member of ecosystem ${doc.ecosystem}, so no run opens there`,
      };
    }
    const run = await openOwedRun(tx, {
      ecosystemId: doc.ecosystem,
      projectId,
      trigger: {
        kind: 'push',
        sha: at,
        head: { ref: head.value.ref, readAt: head.value.readAt, via: head.value.via },
      },
      userId,
    });
    await emitEvent(tx, 'ecosystem.buildOwed', { projectId });
    if (!run.opened) {
      return {
        opened: null,
        why: `the head moved to ${at.slice(0, 12)}, and run ${run.id} is already open (a push or a supersede opened it since this one finished), so it is the one that maps the branch`,
      };
    }
    return { opened: run.id, at, mapped };
  });
}

export const storedLink = LINK.stored;
export const storedBuilderRun = BUILDER_RUN.stored;

/**
 * Open the run a join or a push owes this project, inside the caller's transaction, or answer
 * the run already open: a project works one run per ecosystem at a time, so a push landing
 * while one is open opens nothing beside it. The head it brought is mapped when that run finishes
 * (`openAtMovedHead`), once, at whatever the branch holds then.
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
async function finishedRunReport(
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
