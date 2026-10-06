import type { Tx } from '../db/client.js';
import { type ChannelWorld, today } from './channel-rules.js';
import {
  type ChannelDocument,
  documentSchema,
  HOLD_SCHEMA_ID,
  holdSchema,
  type ThreadHold,
} from './channel-schema.js';
import {
  type DocumentRow,
  type EventRow,
  eventsOf,
  type HoldRow,
  holdsOn,
  readNumbered,
} from './channel-store.js';
import { loadContractFacts } from './contract/element-rules.js';
import { heldEcosystem, storedAs } from './ecosystem-service.js';
import { versionKey } from './interface-rules.js';
import { heldInterface } from './interface-service.js';
import { edgesIn, readInterfaces } from './interface-store.js';
import { impactLink } from './link-service.js';
import { linksWhere } from './link-store.js';
import { activeMembersOf } from './membership-store.js';
import type { InterfaceDocument } from './schema.js';
import { projectsWhere, readEcosystem, recordedVersions } from './store.js';

export interface ServedDocument {
  id: string;
  document: ChannelDocument;
  events: EventRow[];
}

// a published row is write-once, so withdrawn and superseded are read from its one end event and never written onto it
export function serve(row: DocumentRow, events: readonly EventRow[]): ServedDocument {
  const stored = storedAs(documentSchema, row.document, `channel document ${row.id}`);
  const mine = events.filter((e) => e.documentId === row.id);
  const end = mine.find((e) => e.verb === 'withdraw' || e.verb === 'supersede');
  const document: ChannelDocument =
    end?.verb === 'withdraw'
      ? { ...stored, state: 'withdrawn', withdrawnReason: end.reason ?? '' }
      : end?.verb === 'supersede'
        ? { ...stored, state: 'superseded', supersededBy: end.supersededBy ?? '' }
        : stored;
  return { id: row.id, document, events: mine };
}

export async function serveAll(tx: Tx, rows: readonly DocumentRow[]): Promise<ServedDocument[]> {
  const events = await eventsOf(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => serve(r, events));
}

export function holdOf(row: HoldRow): ThreadHold {
  return storedAs(
    holdSchema,
    {
      $schema: HOLD_SCHEMA_ID,
      version: 1,
      id: row.id,
      ecosystem: row.ecosystemId,
      thread: row.thread,
      action: row.action,
      by: { kind: row.byKind, id: row.byId, via: row.byVia },
      side: row.sideProjectId,
      at: row.at.toISOString(),
      ...(row.reason === null ? {} : { reason: row.reason }),
    },
    `hold ${row.id}`,
  );
}

export async function publishedChain(
  tx: Tx,
  ecosystemId: string,
  from: string | null | undefined,
): Promise<Map<string, ChannelDocument>> {
  const out = new Map<string, ChannelDocument>();
  let next = from ?? null;
  while (next && !out.has(next)) {
    const row = await readNumbered(tx, next);
    if (row?.state !== 'published' || row.ecosystemId !== ecosystemId) break;
    const [served] = await serveAll(tx, [row]);
    if (!served) break;
    out.set(next, served.document);
    next = row.inReplyTo;
  }
  return out;
}

export async function loadWorld(
  tx: Tx,
  input: {
    ecosystemId: string;
    from: string;
    documents: ReadonlyMap<string, ChannelDocument>;
    threads: readonly string[];
    cites?: ChannelDocument;
  },
): Promise<ChannelWorld> {
  const ecoRow = await readEcosystem(tx, input.ecosystemId);
  if (!ecoRow) throw new Error(`channel: ecosystem ${input.ecosystemId} vanished under its lock`);
  const [members, edges, versions, holds, links] = await Promise.all([
    activeMembersOf(tx, input.ecosystemId),
    edgesIn(tx, [input.ecosystemId]),
    recordedVersions(tx, [input.from]),
    holdsOn(tx, input.threads),
    linksWhere(tx, { ecosystemIds: [input.ecosystemId] }),
  ]);
  const active = new Set(members);
  const live = edges.filter(
    (e) => active.has(e.consumerProjectId) && active.has(e.providerProjectId),
  );
  const ids = [
    ...new Set([
      input.from,
      ...active,
      ...live.flatMap((e) => [e.consumerProjectId, e.providerProjectId]),
    ]),
  ];
  const [projects, stored] = await Promise.all([
    projectsWhere(tx, { ids }),
    readInterfaces(tx, [input.from]),
  ]);
  const interfaces = new Map<string, InterfaceDocument>(
    [...stored].map(([id, row]) => [id, heldInterface(row, id).document]),
  );
  const slugOf = new Map(projects.map((p) => [p.id, p.slug]));
  const contracts = await loadContractFacts(
    tx,
    slugOf,
    input.cites ? { doc: input.cites, documents: input.documents } : null,
  );
  const versionSets = new Map<string, Set<string>>();
  for (const v of versions) {
    const key = versionKey(v.providerProjectId, v.contractSlug);
    versionSets.set(key, (versionSets.get(key) ?? new Set()).add(v.version));
  }
  return {
    today: today(),
    ecosystemId: input.ecosystemId,
    ecosystem: heldEcosystem(ecoRow).document,
    active,
    slugOf,
    interfaces,
    edges: live,
    links: links.filter((l) => l.providerProjectId === input.from).map(impactLink),
    versions: versionSets,
    contracts,
    documents: input.documents,
    holds: holds.map(holdOf),
  };
}
