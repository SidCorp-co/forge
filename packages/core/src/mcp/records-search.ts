/**
 * `search` and `fetch`, the two tools ChatGPT's connector and deep research look for by name
 * (ISS-773): the find door over the issues, requirements and knowledge of the projects the caller
 * reads (ISS-1256), and one of those items read whole by the id the search returned.
 *
 * Only a project the token reads is searched or fetched: an item of any other is not found, never
 * shown. Every title and text passes the project's data policy for its surface
 * (`lib/data-egress.ts:egressShown`), since both hand content to a model, and the secret scrubber,
 * so a credential pasted into an item never leaves with it.
 */

import type { Refusal } from '@forge/contracts/refusal';
import { scrubSecretsDeep } from '@forge/observability';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, knowledgeEntries, orgKnowledgeEntries, projects } from '../db/schema.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';
import { runFind } from '../find/index.js';
import { getGuide, listGuides, servedGuideBody } from '../guides/index.js';
import { type EgressSurface, egressShown } from '../lib/data-egress.js';
import { RefusalError } from '../lib/refusal.js';
import { loadVisibleProjectIdsForPrincipal, projectReaderOf } from '../lib/tool.js';
import { webBaseUrl } from '../lib/web-base-url.js';
import type { McpPrincipal } from '../middleware/require-pat.js';

const KINDS = ['issue', 'requirement', 'knowledge', 'org'] as const;
type Kind = (typeof KINDS)[number];
const SURFACE: Record<Kind, EgressSurface> = {
  issue: 'issue',
  requirement: 'requirement',
  knowledge: 'knowledge',
  org: 'knowledge',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SearchResult = { id: string; title: string; url: string };
export type FetchedRecord = {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata: Record<string, unknown>;
};

const link = (path: string) => `${webBaseUrl() ?? ''}${path}`;

async function slugsOf(projectIds: readonly string[]): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map();
  const rows = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.id, [...projectIds]));
  return new Map(rows.map((r) => [r.id, r.slug]));
}

/** The record types MCP `search` answers: the ones `fetch` reads whole. */
const SEARCHED = ['issue', 'requirement', 'term', 'rule', 'lesson', 'knowledge'] as const;
const PER_SEARCH = 24;

/** A find hit as the id `fetch` reads: an org ruling under `org:`, any other entry under `knowledge:`. */
function fetchIdOf(type: (typeof SEARCHED)[number], ref: string): string {
  if (ref.startsWith('org:')) return ref;
  return type === 'issue' || type === 'requirement' ? `${type}:${ref}` : `knowledge:${ref}`;
}

/**
 * The issues, requirements and knowledge of the caller's projects that match `query`, as a filter of
 * the find door (ISS-1256): the same ranks `forge_find` and the REST find answer, the query expanded
 * through the glossary, knowledge recalled by meaning (REQ-89 BC-7) beside the org's rulings, so a
 * paraphrase or a Vietnamese question finds the ruling it asks about. A retired or superseded entry
 * is never a hit.
 */
export async function searchRecords(
  principal: McpPrincipal,
  query: string,
): Promise<{ results: SearchResult[] }> {
  const visible = await loadVisibleProjectIdsForPrincipal(principal);
  const home = principal.boundProjectId ?? (visible.length === 1 ? visible[0] : undefined);
  const [first] = visible;
  if (!first) return { results: [] };
  const { kept } = await runFind({
    projectId: home ?? first,
    projectIds: visible,
    query: { q: query.trim(), type: [...SEARCHED], limit: PER_SEARCH },
    reader: projectReaderOf(principal),
    askedBy: principal.agency === 'agent' ? 'agent' : 'person',
    recordsGap: home !== undefined,
  });
  const slugs = await slugsOf([
    ...new Set(kept.flatMap((c) => (c.projectId ? [c.projectId] : []))),
  ]);
  const shown = async (kind: Kind, projectId: string, title: string) =>
    (await egressShown(projectId, SURFACE[kind], { title }, `${kind} title`)).title;
  const results: SearchResult[] = [];
  // the hits the door's filter over these types keeps, in its order: no other is a candidate here
  for (const c of kept) {
    const type = c.type as (typeof SEARCHED)[number];
    const id = fetchIdOf(type, c.ref);
    const slug = c.projectId ? (slugs.get(c.projectId) ?? '') : '';
    if (!c.projectId) {
      // an org ruling reaches every project of its org; the org page is where it is read
      const ruling = c.native as { type?: string } | undefined;
      results.push({
        id,
        title: `${c.key} · ${c.title} (org ${ruling?.type ?? 'convention'})`,
        url: link('/org'),
      });
    } else if (type === 'issue') {
      results.push({
        id,
        title: `${c.key} · ${await shown('issue', c.projectId, c.title)}`,
        url: link(`/projects/${slug}/issues/${c.ref}`),
      });
    } else if (type === 'requirement') {
      results.push({
        id,
        title: `${c.key} · ${await shown('requirement', c.projectId, c.title)}`,
        url: link(`/projects/${slug}/requirements/${c.key}`),
      });
    } else {
      const entry = c.native as { type?: string | null } | undefined;
      results.push({
        id,
        title: `${await shown('knowledge', c.projectId, c.title)}${entry?.type ? ` (${entry.type})` : ''}`,
        url: link(`/projects/${slug}/memory`),
      });
    }
  }
  return scrubSecretsDeep({ results });
}

const refused = (code: string, detail: string): never => {
  const refusal: Refusal = { code, path: '/id', detail };
  throw new RefusalError([refusal], code);
};

function parseId(id: string): { kind: Kind; uuid: string } {
  const [kind, uuid] = id.split(':');
  if (!KINDS.includes(kind as Kind) || !uuid || !UUID.test(uuid)) {
    return refused(
      'MCP_FETCH_ID_INVALID',
      `\`${id.slice(0, 80)}\` is not an id fetch reads; an id is issue:<uuid>, requirement:<uuid>, knowledge:<uuid> or org:<uuid> as search returns it, or guide:<slug> (guide:index lists the guides)`,
    );
  }
  return { kind: kind as Kind, uuid };
}

const notFound = (id: string): never =>
  refused('MCP_FETCH_NOT_FOUND', `${id} names no item in a project this token reads`);

const GUIDE = 'guide:';

/**
 * A Forge guide read over MCP (REQ-78 BC-11), so a client with no web access follows the pointer a
 * describe or a refusal gives it: `guide:index` lists the corpus, `guide:<slug>` reads one whole.
 * The corpus is public, so no project fence applies.
 */
function fetchGuide(id: string): FetchedRecord {
  const slug = id.slice(GUIDE.length);
  if (slug === 'index') {
    const guides = listGuides();
    return {
      id,
      title: 'Forge guides',
      text: guides.map((g) => `- guide:${g.slug} — ${g.title}: ${g.summary}`).join('\n'),
      url: link('/guides'),
      metadata: { count: guides.length },
    };
  }
  const guide = getGuide(slug);
  if (!guide) {
    return refused(
      'MCP_FETCH_GUIDE_UNKNOWN',
      `\`${slug.slice(0, 80)}\` names no Forge guide; fetch { id: "guide:index" } lists them`,
    );
  }
  return {
    id,
    title: guide.title,
    text: servedGuideBody(guide),
    url: link(`/guides/${guide.slug}`),
    metadata: { slug: guide.slug, version: guide.version, audience: guide.audience },
  };
}

/** One item `searchRecords` returned, or a guide, read whole, where the caller reads its project. */
export async function fetchRecord(principal: McpPrincipal, id: string): Promise<FetchedRecord> {
  if (id.startsWith(GUIDE)) return fetchGuide(id);
  const { kind, uuid } = parseId(id);
  const visible = new Set(await loadVisibleProjectIdsForPrincipal(principal));
  let projectId: string;
  let title: string;
  let text: string;
  let path: (slug: string) => string;
  let metadata: Record<string, unknown>;
  if (kind === 'issue') {
    const [row] = await db.select().from(issues).where(eq(issues.id, uuid));
    if (!row || !visible.has(row.projectId)) return notFound(id);
    projectId = row.projectId;
    title = `ISS-${row.issSeq} · ${row.title}`;
    text = row.description ?? '';
    path = (slug) => `/projects/${slug}/issues/${row.id}`;
    metadata = { key: `ISS-${row.issSeq}`, status: row.status, priority: row.priority };
  } else if (kind === 'requirement') {
    const [row] = await db.select().from(requirements).where(eq(requirements.id, uuid));
    if (!row || !visible.has(row.projectId)) return notFound(id);
    const [revision] = await db
      .select()
      .from(requirementRevisions)
      .where(
        row.currentRevision === null
          ? eq(requirementRevisions.requirementId, row.id)
          : and(
              eq(requirementRevisions.requirementId, row.id),
              eq(requirementRevisions.revision, row.currentRevision),
            ),
      )
      .orderBy(desc(requirementRevisions.revision))
      .limit(1);
    projectId = row.projectId;
    title = `REQ-${row.reqSeq} · ${row.title}`;
    text = [revision?.tldr, revision ? JSON.stringify(revision.spec, null, 2) : null]
      .filter(Boolean)
      .join('\n\n');
    path = () => `/requirements/REQ-${row.reqSeq}`;
    metadata = {
      key: `REQ-${row.reqSeq}`,
      status: row.status,
      revision: revision?.revision ?? null,
    };
  } else if (kind === 'knowledge') {
    const [row] = await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, uuid));
    if (!row || !visible.has(row.projectId)) return notFound(id);
    projectId = row.projectId;
    title = row.title;
    text = row.body;
    path = () => '/memory';
    metadata = {
      origin: 'project',
      kind: row.kind,
      slug: row.slug,
      type: row.entryType,
      scope: row.scope,
      recheckWhen: row.recheckWhen,
      current: row.archivedAt === null,
    };
  } else {
    // an org ruling, read whole (an on-demand `-full` guide included) where a visible project is of its org
    const [row] = await db
      .select({ entry: orgKnowledgeEntries, projectId: projects.id })
      .from(orgKnowledgeEntries)
      .innerJoin(projects, eq(projects.orgId, orgKnowledgeEntries.orgId))
      .where(and(eq(orgKnowledgeEntries.id, uuid), inArray(projects.id, [...visible])))
      .limit(1);
    if (!row) return notFound(id);
    projectId = row.projectId;
    title = `${row.entry.slug} · ${row.entry.title}`;
    text = row.entry.body;
    path = () => '/org';
    metadata = {
      origin: 'org',
      kind: 'rule',
      slug: row.entry.slug,
      type: 'convention',
      scope: row.entry.scope,
      recheckWhen: row.entry.recheckWhen,
      injection: row.entry.injection,
      current: true,
    };
  }
  const slug = (await slugsOf([projectId])).get(projectId) ?? '';
  const content = await egressShown(projectId, SURFACE[kind], { title, text }, kind);
  const at = path(slug);
  // what a person pasted into an item (a token in a description) never reaches the client's model
  return scrubSecretsDeep({
    id,
    title: content.title,
    text: content.text,
    url: link(at.startsWith('/projects/') || at === '/org' ? at : `/projects/${slug}${at}`),
    metadata: { project: slug, ...metadata },
  });
}
