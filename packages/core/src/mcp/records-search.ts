/**
 * `search` and `fetch`, the two tools ChatGPT's connector and deep research look for by name
 * (ISS-773): a keyword search over the issues, requirements and knowledge of the projects the caller
 * reads, and one of those items read whole by the id the search returned.
 *
 * Only a project the token reads is searched or fetched: an item of any other is not found, never
 * shown. Every title and text passes the project's data policy for its surface
 * (`lib/data-egress.ts:egressShown`), since both hand content to a model, and the secret scrubber,
 * so a credential pasted into an item never leaves with it.
 */

import type { Refusal } from '@forge/contracts/refusal';
import { scrubSecretsDeep } from '@forge/observability';
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, knowledgeEntries, projects } from '../db/schema.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';
import { type EgressSurface, egressShown } from '../lib/data-egress.js';
import { RefusalError } from '../lib/refusal.js';
import { loadVisibleProjectIdsForPrincipal } from '../lib/tool.js';
import { webBaseUrl } from '../lib/web-base-url.js';
import type { McpPrincipal } from '../middleware/require-pat.js';

const KINDS = ['issue', 'requirement', 'knowledge'] as const;
type Kind = (typeof KINDS)[number];
const SURFACE: Record<Kind, EgressSurface> = {
  issue: 'issue',
  requirement: 'requirement',
  knowledge: 'knowledge',
};
const PER_KIND = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SearchResult = { id: string; title: string; url: string };
export type FetchedRecord = {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata: Record<string, unknown>;
};

const like = (query: string) => `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const link = (path: string) => `${webBaseUrl() ?? ''}${path}`;

async function slugsOf(projectIds: readonly string[]): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map();
  const rows = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.id, [...projectIds]));
  return new Map(rows.map((r) => [r.id, r.slug]));
}

/** The issues, requirements and knowledge entries of the caller's projects whose title or text holds `query`. */
export async function searchRecords(
  principal: McpPrincipal,
  query: string,
): Promise<{ results: SearchResult[] }> {
  const visible = await loadVisibleProjectIdsForPrincipal(principal);
  if (visible.length === 0) return { results: [] };
  const words = like(query.trim());
  const [issueRows, requirementRows, knowledgeRows] = await Promise.all([
    db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        seq: issues.issSeq,
        title: issues.title,
      })
      .from(issues)
      .where(
        and(
          inArray(issues.projectId, visible),
          or(ilike(issues.title, words), ilike(issues.description, words)),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(PER_KIND),
    db
      .select({
        id: requirements.id,
        projectId: requirements.projectId,
        seq: requirements.reqSeq,
        title: requirements.title,
      })
      .from(requirements)
      .where(and(inArray(requirements.projectId, visible), ilike(requirements.title, words)))
      .orderBy(desc(requirements.updatedAt))
      .limit(PER_KIND),
    db
      .select({
        id: knowledgeEntries.id,
        projectId: knowledgeEntries.projectId,
        title: knowledgeEntries.title,
      })
      .from(knowledgeEntries)
      .where(
        and(
          inArray(knowledgeEntries.projectId, visible),
          or(ilike(knowledgeEntries.title, words), ilike(knowledgeEntries.body, words)),
        ),
      )
      .limit(PER_KIND),
  ]);
  const slugs = await slugsOf([
    ...new Set([...issueRows, ...requirementRows, ...knowledgeRows].map((r) => r.projectId)),
  ]);
  const shown = async (kind: Kind, projectId: string, title: string) =>
    (await egressShown(projectId, SURFACE[kind], { title }, `${kind} title`)).title;
  const results: SearchResult[] = [];
  for (const r of issueRows) {
    const slug = slugs.get(r.projectId) ?? '';
    results.push({
      id: `issue:${r.id}`,
      title: `ISS-${r.seq} · ${await shown('issue', r.projectId, r.title)}`,
      url: link(`/projects/${slug}/issues/${r.id}`),
    });
  }
  for (const r of requirementRows) {
    const slug = slugs.get(r.projectId) ?? '';
    results.push({
      id: `requirement:${r.id}`,
      title: `REQ-${r.seq} · ${await shown('requirement', r.projectId, r.title)}`,
      url: link(`/projects/${slug}/requirements/REQ-${r.seq}`),
    });
  }
  for (const r of knowledgeRows) {
    const slug = slugs.get(r.projectId) ?? '';
    results.push({
      id: `knowledge:${r.id}`,
      title: await shown('knowledge', r.projectId, r.title),
      url: link(`/projects/${slug}/memory`),
    });
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
      `\`${id.slice(0, 80)}\` is not an id search returns; an id is issue:<uuid>, requirement:<uuid> or knowledge:<uuid>`,
    );
  }
  return { kind: kind as Kind, uuid };
}

const notFound = (id: string): never =>
  refused('MCP_FETCH_NOT_FOUND', `${id} names no item in a project this token reads`);

/** One item `searchRecords` returned, read whole, where the caller reads its project. */
export async function fetchRecord(principal: McpPrincipal, id: string): Promise<FetchedRecord> {
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
  } else {
    const [row] = await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, uuid));
    if (!row || !visible.has(row.projectId)) return notFound(id);
    projectId = row.projectId;
    title = row.title;
    text = row.body;
    path = () => '/memory';
    metadata = { kind: row.kind, slug: row.slug };
  }
  const slug = (await slugsOf([projectId])).get(projectId) ?? '';
  const content = await egressShown(projectId, SURFACE[kind], { title, text }, kind);
  const at = path(slug);
  // what a person pasted into an item (a token in a description) never reaches the client's model
  return scrubSecretsDeep({
    id,
    title: content.title,
    text: content.text,
    url: link(at.startsWith('/projects/') ? at : `/projects/${slug}${at}`),
    metadata: { project: slug, ...metadata },
  });
}
