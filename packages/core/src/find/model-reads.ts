// What the find door reads of the module map's model (ISS-1256), in one place: the module labels and
// their tree, the glossary's terms with their aliases, and the module each record is placed in. The
// model's columns are the model's (`contracts/module-map.ts`): a term's aliases in
// `knowledge_entries.term`, a record's module in its `module_id`, an issue's in its primary module
// label. Nothing here infers a module: a record no agent placed reads as unplaced.

import type { FindHitModule, FindRelation } from '@forge/contracts/find';
import type { TermAliases } from '@forge/contracts/module-map';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

type ModuleRow = { id: string; slug: string; name: string; parent_id: string | null };

const uuidList = (ids: readonly string[]) =>
  sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;

/**
 * Every module label of the projects, each as the hit names it: its business module (the root of
 * its parents) and the slug path from that root down to it.
 */
export async function moduleTree(
  projectIds: readonly string[],
): Promise<Map<string, FindHitModule>> {
  if (projectIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT id, slug, name, parent_id FROM labels
    WHERE kind = 'module' AND project_id = ANY(${uuidList(projectIds)})`)) as unknown as ModuleRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, FindHitModule>();
  for (const row of rows) {
    const chain: ModuleRow[] = [row];
    const seen = new Set([row.id]);
    let parent = row.parent_id ? byId.get(row.parent_id) : undefined;
    while (parent && !seen.has(parent.id)) {
      chain.unshift(parent);
      seen.add(parent.id);
      parent = parent.parent_id ? byId.get(parent.parent_id) : undefined;
    }
    const root = chain[0] ?? row;
    out.set(row.id, { slug: root.slug, name: root.name, path: chain.map((m) => m.slug).join('/') });
  }
  return out;
}

/** A glossary term as the query's expansion reads it. */
export interface GlossaryTerm {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  body: string;
  aliases: string[];
  moduleId: string | null;
}

/** Every alias a term's fields hold, Vietnamese, code and industry names alike. */
export function aliasesOf(term: unknown): string[] {
  const aliases = (term as { aliases?: Partial<TermAliases> } | null)?.aliases;
  if (!aliases || typeof aliases !== 'object') return [];
  return [aliases.vi, aliases.code, aliases.industry].flatMap((list) =>
    Array.isArray(list)
      ? list.filter((a): a is string => typeof a === 'string' && a.trim() !== '')
      : [],
  );
}

type TermRow = {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  body: string;
  term: unknown;
  module_id: string | null;
};

/** The live glossary terms of the projects that carry at least one alias. */
export async function glossaryTerms(projectIds: readonly string[]): Promise<GlossaryTerm[]> {
  if (projectIds.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT id, project_id, slug, title, body, term, module_id FROM knowledge_entries
    WHERE kind = 'glossary' AND archived_at IS NULL AND term IS NOT NULL
      AND project_id = ANY(${uuidList(projectIds)})`)) as unknown as TermRow[];
  return rows.flatMap((r) => {
    const aliases = aliasesOf(r.term);
    return aliases.length === 0
      ? []
      : [
          {
            id: r.id,
            projectId: r.project_id,
            slug: r.slug,
            title: r.title,
            body: r.body,
            aliases,
            moduleId: r.module_id,
          },
        ];
  });
}

/** The record kinds whose module is a `module_id` column of their own row. */
export type PlacedKind = 'knowledge' | 'requirement' | 'reference' | 'decision' | 'issue';

const PLACED_BY: Record<PlacedKind, ReturnType<typeof sql>> = {
  knowledge: sql`SELECT id, module_id FROM knowledge_entries WHERE id = ANY`,
  requirement: sql`SELECT id, module_id FROM requirements WHERE id = ANY`,
  reference: sql`SELECT id, module_id FROM reference_sources WHERE id = ANY`,
  decision: sql`SELECT id, module_id FROM comments WHERE intent = 'decision' AND id = ANY`,
  // an issue's module is its primary module label, as the issue screens show it
  issue: sql`SELECT DISTINCT ON (il.issue_id) il.issue_id AS id, il.label_id AS module_id
    FROM issue_labels il JOIN labels l ON l.id = il.label_id AND l.kind = 'module'
    WHERE il.issue_id = ANY`,
};

/** The module label each record of `kind` is placed in; a record placed in none is absent. */
export async function placementsOf(
  kind: PlacedKind,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const order = kind === 'issue' ? sql` ORDER BY il.issue_id, il.is_primary DESC` : sql``;
  const rows = (await db.execute(sql`${PLACED_BY[kind]}(${uuidList(ids)})${order}`)) as unknown as {
    id: string;
    module_id: string | null;
  }[];
  return new Map(rows.flatMap((r) => (r.module_id ? [[r.id, r.module_id] as const] : [])));
}

type RelationRow = {
  kind: FindRelation['kind'];
  direction: 'out' | 'in';
  type: string;
  ref: string;
};

/**
 * The relations of one term or rule (`knowledge_relations`): those it starts, and those naming it as
 * their other end, by its slug.
 */
export async function relationsOf(entry: {
  id: string;
  projectId: string;
  slug: string;
  type: 'term' | 'rule';
}): Promise<FindRelation[]> {
  const rows = (await db.execute(sql`
    SELECT kind, 'out' AS direction, to_type AS type, to_ref AS ref, created_at FROM knowledge_relations
    WHERE from_entry_id = ${entry.id}
    UNION ALL
    SELECT r.kind, 'in', CASE WHEN k.kind = 'glossary' THEN 'term' ELSE k.kind END, k.slug, r.created_at
    FROM knowledge_relations r JOIN knowledge_entries k ON k.id = r.from_entry_id
    WHERE r.project_id = ${entry.projectId} AND r.to_type = ${entry.type} AND r.to_ref = ${entry.slug}
    ORDER BY 1, 5`)) as unknown as RelationRow[];
  return rows.map(({ kind, direction, type, ref }) => ({ kind, direction, type, ref }));
}
