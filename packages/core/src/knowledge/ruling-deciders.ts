// Who decides an act, as the project's rulings record it (ISS-1042): a `rule` knowledge entry whose
// `metadata.deciders` names members and the acts each decides. A master or orchestrator writes it
// from a ruling through the knowledge door, which refuses a malformed list by name; a support room
// reads it for its brief and its agreement rule alike, so the two never disagree. A member declared by
// chat identity (`speaker`, REQ-90 BC-15) is a project admin's delegation: only a project admin writes
// one, so the door refuses any other writer's change to who is declared, or for what.

import type { KnowledgeRefusalCode } from '@forge/contracts/knowledge';
import {
  RULING_DECIDERS_KEY,
  RULING_DECIDERS_SHAPE,
  type RulingDecider,
  rulingDecidersSchema,
} from '@forge/contracts/support-channel';
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEntries } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { type RefusalError, refuser } from '../lib/refusal.js';
import { actorFor, permissionRefusalFor, projectResource } from '../permissions/index.js';

const refuse = refuser<KnowledgeRefusalCode>('KNOWLEDGE_REFUSED');

/** One member a ruling names, with the ruling that names them. */
export interface RulingDeciderRead extends RulingDecider {
  /** The ruling's slug, as `knowledge:<slug>` cites it. */
  ruling: string;
  title: string;
  /** When the ruling was last written: the revision a reader of it was given (REQ-90). */
  updatedAt: Date;
}

/**
 * The refusal of a write whose `metadata.deciders` is not a list of `{ member, acts }`, or sits on an
 * entry that is not a rule; null where the write names no deciders or names them well.
 */
export function rulingDecidersRefusal(input: {
  slug: string;
  kind: string;
  metadata?: Record<string, unknown> | undefined;
}): RefusalError | null {
  if (!input.metadata || !(RULING_DECIDERS_KEY in input.metadata)) return null;
  const at = `/metadata/${RULING_DECIDERS_KEY}`;
  if (input.kind !== 'rule') {
    return refuse(
      'KNOWLEDGE_DECIDERS_SHAPE',
      `\`${input.slug}\` is a ${input.kind}: only a ruling, an entry of kind \`rule\`, names who decides an act. Valid: ${RULING_DECIDERS_SHAPE}.`,
      at,
    );
  }
  const parsed = rulingDecidersSchema.safeParse(input.metadata[RULING_DECIDERS_KEY]);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${at}/${issue.path.join('/')}` : at;
  return refuse(
    'KNOWLEDGE_DECIDERS_SHAPE',
    `\`${input.slug}\` names its deciders wrongly at ${where}: ${issue?.message ?? 'not a list'}. Valid: ${RULING_DECIDERS_SHAPE}.`,
    where,
  );
}

/** Each member declared by chat identity, with the acts and targets declared, as one comparable key. */
function declaredOf(deciders: unknown): Set<string> {
  const parsed = rulingDecidersSchema.safeParse(deciders);
  if (!parsed.success) return new Set();
  return new Set(
    parsed.data
      .filter((d) => d.speaker)
      .map((d) =>
        JSON.stringify([
          d.speaker?.source,
          d.speaker?.externalId,
          [...d.acts].sort(),
          [...(d.targets ?? [])].sort(),
        ]),
      ),
  );
}

/**
 * The refusal of a write that declares, changes or withdraws a decider by chat identity (REQ-90
 * BC-15) by a writer who holds no project.admin on the project: the declaration lends that speaker
 * the acts it names with no Forge account, so only a project admin makes it. Null where the write
 * leaves the declared members as stored, or its writer is a project admin.
 */
export async function declarationRefusal(
  input: { projectId: string; slug: string; metadata?: Record<string, unknown> | undefined },
  writer: { userId: string | null } | undefined,
): Promise<RefusalError | null> {
  const [stored] = await db
    .select({ deciders: sql<unknown>`${knowledgeEntries.metadata} -> ${RULING_DECIDERS_KEY}` })
    .from(knowledgeEntries)
    .where(
      and(eq(knowledgeEntries.projectId, input.projectId), eq(knowledgeEntries.slug, input.slug)),
    )
    .limit(1);
  const before = declaredOf(stored?.deciders);
  // a write that sends no metadata leaves what is stored
  if (!input.metadata) return null;
  const after = declaredOf(input.metadata[RULING_DECIDERS_KEY]);
  if (before.size === after.size && [...after].every((k) => before.has(k))) return null;
  const denied = writer?.userId
    ? await permissionRefusalFor(
        actorFor(writer.userId),
        'project.admin',
        projectResource(input.projectId),
        'declaring a decider by chat identity',
      )
    : true;
  if (!denied) return null;
  return refuse(
    'KNOWLEDGE_DECLARATION_NOT_ADMIN',
    `\`${input.slug}\` declares, changes or withdraws a decider by chat identity (metadata.${RULING_DECIDERS_KEY}[].speaker), and ${writer?.userId ? `account ${writer.userId} holds no project.admin on this project` : 'this write names no writer'}: a declaration lends that speaker the acts it names with no Forge account, so only a project admin writes it. Ask a project admin to declare it; nothing was written.`,
    `/metadata/${RULING_DECIDERS_KEY}`,
  );
}

/**
 * Every member the project's live rulings name as a decider, oldest ruling first by slug. A ruling
 * archived or marked `deprecated` names nobody. A list the door would refuse (written past it, in the
 * database) is logged by its slug and names nobody, never a guess at what it meant.
 */
export async function rulingDecidersOf(projectId: string): Promise<RulingDeciderRead[]> {
  return (await rulingDecidersOfProjects([projectId])).get(projectId) ?? [];
}

/**
 * `rulingDecidersOf` for several projects in one statement, so a read across many projects (a
 * release page per project, a person's attention) asks once, not once per project.
 */
export async function rulingDecidersOfProjects(
  projectIds: readonly string[],
): Promise<Map<string, RulingDeciderRead[]>> {
  const out = new Map<string, RulingDeciderRead[]>(projectIds.map((id) => [id, []]));
  if (projectIds.length === 0) return out;
  const rows = await db
    .select({
      projectId: knowledgeEntries.projectId,
      slug: knowledgeEntries.slug,
      title: knowledgeEntries.title,
      updatedAt: knowledgeEntries.updatedAt,
      deciders: sql<unknown>`${knowledgeEntries.metadata} -> ${RULING_DECIDERS_KEY}`,
    })
    .from(knowledgeEntries)
    .where(
      and(
        inArray(knowledgeEntries.projectId, [...projectIds]),
        eq(knowledgeEntries.kind, 'rule'),
        isNull(knowledgeEntries.archivedAt),
        ne(knowledgeEntries.confidence, 'deprecated'),
        isNotNull(sql`${knowledgeEntries.metadata} -> ${RULING_DECIDERS_KEY}`),
      ),
    )
    .orderBy(asc(knowledgeEntries.slug));
  for (const row of rows) {
    const parsed = rulingDecidersSchema.safeParse(row.deciders);
    if (!parsed.success) {
      logger.error(
        { projectId: row.projectId, slug: row.slug, issues: parsed.error.issues },
        'knowledge: a ruling names its deciders in a shape the door refuses; it names nobody',
      );
      continue;
    }
    const named = out.get(row.projectId ?? '');
    if (!named) continue;
    for (const d of parsed.data)
      named.push({ ...d, ruling: row.slug, title: row.title, updatedAt: row.updatedAt });
  }
  return out;
}
