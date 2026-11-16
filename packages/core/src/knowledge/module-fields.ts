// What an entry carries on the module map (ISS-1256): the module it belongs to (`module_id`, a module
// label), a term's aliases and who named it (`term`, a glossary entry's only), and the four relations
// that start at a term or a rule (`knowledge_relations`). Each is written by an agent's or a person's
// call: the entry write sends `module`, `term` and `anchor`, and the module map's doors (`labels`)
// place an entry and relate it through the setters here. Nothing here infers a module or a relation.

import {
  CODE_ANCHOR_PATTERN,
  CODE_ANCHOR_SHAPE,
  type ModuleMapRefusalCode,
  type ModuleStoredRelationKind,
  type TermFields,
  termFieldsSchema,
} from '@forge/contracts/module-map';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEntries, knowledgeRelations } from '../db/schema.js';
import { RefusalError, refuser } from '../lib/refusal.js';
import { knowledgePort } from './ports.js';

const refuse = refuser<ModuleMapRefusalCode>('MODULE_MAP_REFUSED');

/** Who wrote a relation: the caller's user and whether a person or an agent made the call. */
export interface MapWriter {
  userId: string | null;
  agency: 'human' | 'agent';
}

/** What an entry write sends for the map: absent leaves what is stored, `null` clears it. */
export interface EntryMapFields {
  module?: string | null | undefined;
  term?: unknown;
  anchor?: string | undefined;
}

/** A code anchor as written, or the refusal naming the shape that is valid. */
export function codeAnchorOf(raw: string, path = '/anchor'): string {
  const anchor = raw.trim().replace(/^\.\//, '');
  if (!CODE_ANCHOR_PATTERN.test(anchor)) {
    throw refuse(
      'MODULE_MAP_ANCHOR_SHAPE',
      `"${raw}" is not a code anchor. Valid: ${CODE_ANCHOR_SHAPE}.`,
      path,
    );
  }
  return anchor;
}

/** A term's fields as sent, judged; `null` clears them, and only a glossary entry carries them. */
export function termOf(kind: string, raw: unknown): TermFields | null {
  if (raw === null) return null;
  if (kind !== 'glossary') {
    throw refuse(
      'MODULE_MAP_TERM_NOT_GLOSSARY',
      `\`term\` (aliases, namedBy) is a glossary entry's; this entry is kind ${kind}. Write the term as kind glossary.`,
      '/term',
    );
  }
  const parsed = termFieldsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RefusalError(
      parsed.error.issues.map((i) => ({
        code: 'MODULE_MAP_REFUSED',
        path: `/term/${i.path.join('/')}`,
        detail: `${i.message}. Valid: { aliases?: { vi?: string[], code?: string[], industry?: string[] }, namedBy?: { who, quote } }`,
      })),
      'MODULE_MAP_REFUSED',
    );
  }
  return parsed.data;
}

/** The module label a slug names in the project, by the module map's own resolver. */
const moduleIdOf = (projectId: string, slug: string) =>
  knowledgePort('moduleIdOf')(projectId, slug);

/**
 * Judge an entry write's map fields before anything is written; what to apply once the entry is.
 * A module no label of the project names is refused `MODULE_MAP_MODULE_UNKNOWN`.
 */
export async function judgeEntryMapFields(
  projectId: string,
  kind: string,
  fields: EntryMapFields,
): Promise<{ moduleId?: string | null; term?: TermFields | null; anchor?: string } | null> {
  if (fields.module === undefined && fields.term === undefined && fields.anchor === undefined) {
    return null;
  }
  return {
    ...(fields.module !== undefined
      ? { moduleId: fields.module === null ? null : await moduleIdOf(projectId, fields.module) }
      : {}),
    ...(fields.term !== undefined ? { term: termOf(kind, fields.term) } : {}),
    ...(fields.anchor !== undefined ? { anchor: codeAnchorOf(fields.anchor) } : {}),
  };
}

/** Apply judged map fields to the entry just written. */
export async function applyEntryMapFields(
  projectId: string,
  entryId: string,
  judged: Awaited<ReturnType<typeof judgeEntryMapFields>>,
  writer: MapWriter,
): Promise<void> {
  if (!judged) return;
  const set: Record<string, unknown> = {};
  if (judged.moduleId !== undefined) set.moduleId = judged.moduleId;
  if (judged.term !== undefined) set.term = judged.term;
  if (Object.keys(set).length > 0) {
    await db.update(knowledgeEntries).set(set).where(eq(knowledgeEntries.id, entryId));
  }
  if (judged.anchor !== undefined) {
    await writeKnowledgeRelation({
      projectId,
      fromEntryId: entryId,
      kind: 'anchored_at',
      toType: 'code',
      toRef: judged.anchor,
      writer,
    });
  }
}

/** One live entry by slug, as the map's doors read it before a write. */
export async function entryForMap(
  projectId: string,
  slug: string,
): Promise<{ id: string; kind: string; title: string; moduleId: string | null } | null> {
  const [row] = await db
    .select({
      id: knowledgeEntries.id,
      kind: knowledgeEntries.kind,
      title: knowledgeEntries.title,
      moduleId: knowledgeEntries.moduleId,
    })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        eq(knowledgeEntries.slug, slug),
        sql`${knowledgeEntries.archivedAt} IS NULL`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Set the module an entry belongs to; the module it was in before. */
export async function setKnowledgeModule(
  entryId: string,
  moduleId: string | null,
): Promise<string | null> {
  const [before] = await db
    .select({ moduleId: knowledgeEntries.moduleId })
    .from(knowledgeEntries)
    .where(eq(knowledgeEntries.id, entryId));
  await db.update(knowledgeEntries).set({ moduleId }).where(eq(knowledgeEntries.id, entryId));
  return before?.moduleId ?? null;
}

/** Write one stored relation; the same relation written again answers the standing one. */
export async function writeKnowledgeRelation(input: {
  projectId: string;
  fromEntryId: string;
  kind: ModuleStoredRelationKind;
  toType: 'term' | 'rule' | 'capability' | 'requirement' | 'decision' | 'code';
  toRef: string;
  writer: MapWriter;
}): Promise<{ id: string; created: boolean }> {
  const [made] = await db
    .insert(knowledgeRelations)
    .values({
      projectId: input.projectId,
      fromEntryId: input.fromEntryId,
      kind: input.kind,
      toType: input.toType,
      toRef: input.toRef,
      writtenBy: input.writer.userId,
      writtenAgency: input.writer.agency,
    })
    .onConflictDoNothing()
    .returning({ id: knowledgeRelations.id });
  if (made) return { id: made.id, created: true };
  const [standing] = await db
    .select({ id: knowledgeRelations.id })
    .from(knowledgeRelations)
    .where(
      and(
        eq(knowledgeRelations.fromEntryId, input.fromEntryId),
        eq(knowledgeRelations.kind, input.kind),
        eq(knowledgeRelations.toType, input.toType),
        eq(knowledgeRelations.toRef, input.toRef),
      ),
    );
  if (!standing) throw new Error('knowledge: a relation neither inserted nor stands');
  return { id: standing.id, created: false };
}

/** Remove one stored relation of the project; whether it stood. */
export async function removeKnowledgeRelation(projectId: string, id: string): Promise<boolean> {
  const gone = await db
    .delete(knowledgeRelations)
    .where(and(eq(knowledgeRelations.projectId, projectId), eq(knowledgeRelations.id, id)))
    .returning({ id: knowledgeRelations.id });
  return gone.length > 0;
}

/** Each code anchor (`anchored_at`) of the project's entries, by entry id. */
export async function anchorsByEntry(projectId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ entryId: knowledgeRelations.fromEntryId, ref: knowledgeRelations.toRef })
    .from(knowledgeRelations)
    .where(
      and(eq(knowledgeRelations.projectId, projectId), eq(knowledgeRelations.kind, 'anchored_at')),
    );
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.entryId, [...(out.get(r.entryId) ?? []), r.ref]);
  return out;
}
