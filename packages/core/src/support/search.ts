// Search for a how-to answer (REQ-75 BC-2): the project's records through the one find door
// (ISS-1256), filtered to the types a room may read, and the operations of its current published
// OpenAPI contracts, a contract lookup beside the search rather than a record type of it. Each hit
// carries the source the session cites.

import type { FindType } from '@forge/contracts/find';
import { db } from '../db/client.js';
import { findRecords } from '../knowledge/index.js';
import { contractVersionReads } from '../lib/contract-versions.js';
import type { Found } from '../run-context/index.js';
import { namedProject } from './ops-scope.js';
import type { Outcome } from './outcome.js';
import { noteRoomReached } from './room-reaches.js';
import type { RoomRow } from './store.js';
import { scrubbedForRoom } from './thread.js';

export interface SearchHit {
  /** What the session cites the hit as, in brackets. */
  cite: string;
  title: string;
  excerpt: string;
}

const words = (q: string) =>
  q
    .toLowerCase()
    .split(/[^a-z0-9{}/_-]+/)
    .filter((w) => w.length >= 3);

/** The operations of the project's current OpenAPI contracts that the query's words name. */
async function openApiHits(projectId: string, query: string): Promise<SearchHit[]> {
  const reads = contractVersionReads();
  const current = (await reads.currentVersionsOf(db, [projectId])).filter(
    (v) => v.contractType === 'openapi' && v.artifactSha256,
  );
  if (current.length === 0) return [];
  const artifacts = await reads.artifactsOf(current.map((v) => v.artifactSha256 as string));
  const wanted = words(query);
  const hits: { score: number; hit: SearchHit }[] = [];
  for (const v of current) {
    let doc: { paths?: Record<string, Record<string, unknown>> };
    try {
      doc = JSON.parse(artifacts.get(v.artifactSha256 as string) ?? '{}');
    } catch {
      continue;
    }
    for (const [path, ops] of Object.entries(doc.paths ?? {})) {
      for (const [method, raw] of Object.entries(ops ?? {})) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        const op = (raw ?? {}) as { summary?: string; description?: string; operationId?: string };
        const text =
          `${path} ${op.summary ?? ''} ${op.description ?? ''} ${op.operationId ?? ''}`.toLowerCase();
        const score = wanted.filter((w) => text.includes(w)).length;
        if (score === 0) continue;
        hits.push({
          score,
          hit: {
            cite: `openapi:${v.contractSlug}@${v.version} ${method.toUpperCase()} ${path}`,
            title: op.summary ?? op.operationId ?? `${method.toUpperCase()} ${path}`,
            excerpt: (op.description ?? op.summary ?? '').slice(0, 600),
          },
        });
      }
    }
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((h) => h.hit);
}

/**
 * The record types a room's search reads: the project's knowledge (its terms, rules, entries and
 * lessons, and its org's rulings) and the reference sources it follows, as every room reads them
 * through its own acts. Issues, requirements and feedback are an operations grant's reads, memory and
 * decisions the project's agents' own, and a capability card is a door the room does not call.
 */
const ROOM_FIND_TYPES = [
  'term',
  'rule',
  'knowledge',
  'lesson',
  'reference',
] as const satisfies readonly FindType[];
const ROOM_FIND_LIMIT = 8;
/** The knowledge kind a knowledge type's record is, as the run-context record keeps it. */
const KNOWLEDGE_KINDS: Partial<Record<FindType, string>> = {
  term: 'glossary',
  rule: 'rule',
  knowledge: 'knowledge',
  lesson: 'lesson',
};

/**
 * The project's records and published API, for a how-to answer that cites its sources: the home
 * project's, or a project a channel agent follows that `project` names (ISS-874), whose hits cite it.
 * The records are the find door's, in its ranks, over that one project alone.
 */
export async function search(
  room: RoomRow,
  query: string,
  project?: string,
): Promise<Outcome<SearchHit[]>> {
  const named = await namedProject(room, project);
  if (!named.ok) return named;
  const { id: projectId } = named.value;
  const from = projectId === room.projectId ? '' : `${named.value.slug}/`;
  const records = await findRecords({
    projectId,
    reader: { userId: room.principalUserId, fence: [projectId] },
    query,
    types: ROOM_FIND_TYPES,
    limit: ROOM_FIND_LIMIT,
    askedBy: 'agent',
  });
  // what the room's agent read, kept as a run's search is (ISS-1251)
  const found: Found = {
    knowledge: records.flatMap((c) => {
      const kind = KNOWLEDGE_KINDS[c.type];
      return kind && c.key ? [{ slug: c.key, kind, body: c.text }] : [];
    }),
    records: records.flatMap((c) =>
      c.type === 'reference' ? [{ kind: 'reference' as const, ref: c.ref, text: c.text }] : [],
    ),
  };
  noteRoomReached(room, projectId, 'search', found);
  const api = (await openApiHits(projectId, query)).map((h) =>
    from ? { ...h, cite: h.cite.replace(/^openapi:/, `openapi:${from}`) } : h,
  );
  const hits = [
    // a knowledge entry is cited by its slug, a reference source by its id
    ...records.map((c) => ({
      cite:
        c.type === 'reference' ? `reference:${from}${c.ref}` : `knowledge:${from}${c.key ?? c.ref}`,
      title: c.title,
      excerpt: c.text.slice(0, 1200),
    })),
    ...api,
  ];
  const scrubbed = await Promise.all(
    hits.map(async (h) => ({ ...h, excerpt: await scrubbedForRoom(room, h.excerpt) })),
  );
  return { ok: true, value: scrubbed };
}
