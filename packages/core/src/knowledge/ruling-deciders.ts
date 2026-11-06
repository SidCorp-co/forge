// Who decides an act, as the project's rulings record it (ISS-1042): a `rule` knowledge entry whose
// `metadata.deciders` names members and the acts each decides. A master or orchestrator writes it
// from a ruling through the knowledge door, which refuses a malformed list by name; a support room
// reads it for its brief and its agreement rule alike, so the two never disagree.

import type { KnowledgeRefusalCode } from '@forge/contracts/knowledge';
import {
  RULING_DECIDERS_KEY,
  RULING_DECIDERS_SHAPE,
  type RulingDecider,
  rulingDecidersSchema,
} from '@forge/contracts/support-channel';
import { and, asc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEntries } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { type RefusalError, refuser } from '../lib/refusal.js';

const refuse = refuser<KnowledgeRefusalCode>('KNOWLEDGE_REFUSED');

/** One member a ruling names, with the ruling that names them. */
export interface RulingDeciderRead extends RulingDecider {
  /** The ruling's slug, as `knowledge:<slug>` cites it. */
  ruling: string;
  title: string;
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

/**
 * Every member the project's live rulings name as a decider, oldest ruling first by slug. A ruling
 * archived or marked `deprecated` names nobody. A list the door would refuse (written past it, in the
 * database) is logged by its slug and names nobody, never a guess at what it meant.
 */
export async function rulingDecidersOf(projectId: string): Promise<RulingDeciderRead[]> {
  const rows = await db
    .select({
      slug: knowledgeEntries.slug,
      title: knowledgeEntries.title,
      deciders: sql<unknown>`${knowledgeEntries.metadata} -> ${RULING_DECIDERS_KEY}`,
    })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        eq(knowledgeEntries.kind, 'rule'),
        isNull(knowledgeEntries.archivedAt),
        ne(knowledgeEntries.confidence, 'deprecated'),
        isNotNull(sql`${knowledgeEntries.metadata} -> ${RULING_DECIDERS_KEY}`),
      ),
    )
    .orderBy(asc(knowledgeEntries.slug));
  const out: RulingDeciderRead[] = [];
  for (const row of rows) {
    const parsed = rulingDecidersSchema.safeParse(row.deciders);
    if (!parsed.success) {
      logger.error(
        { projectId, slug: row.slug, issues: parsed.error.issues },
        'knowledge: a ruling names its deciders in a shape the door refuses; it names nobody',
      );
      continue;
    }
    for (const d of parsed.data) out.push({ ...d, ruling: row.slug, title: row.title });
  }
  return out;
}
