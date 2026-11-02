// Search for a how-to answer (REQ-75 BC-2): the project's knowledge and the operations of its
// current published OpenAPI contracts, each hit carrying the source the session cites.

import { db } from '../db/client.js';
import { keywordSearchKnowledge } from '../knowledge/index.js';
import { contractVersionReads } from '../lib/contract-versions.js';
import { namedProject } from './ops-scope.js';
import type { Outcome } from './outcome.js';
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
 * The project's knowledge and published API, for a how-to answer that cites its sources: the home
 * project's, or a project a channel agent follows that `project` names (ISS-874), whose hits cite it.
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
  // any of the words, not all of them: a member's question rarely repeats a page's every word
  const anyWord = words(query).join(' or ');
  const knowledge = anyWord ? await keywordSearchKnowledge(projectId, anyWord, 6) : [];
  const api = (await openApiHits(projectId, query)).map((h) =>
    from ? { ...h, cite: h.cite.replace(/^openapi:/, `openapi:${from}`) } : h,
  );
  const hits = [
    ...knowledge.map((k) => ({
      cite: `knowledge:${from}${k.slug}`,
      title: k.title,
      excerpt: k.body.slice(0, 1200),
    })),
    ...api,
  ];
  const scrubbed = await Promise.all(
    hits.map(async (h) => ({ ...h, excerpt: await scrubbedForRoom(room, h.excerpt) })),
  );
  return { ok: true, value: scrubbed };
}
