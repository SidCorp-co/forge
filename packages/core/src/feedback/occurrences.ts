/**
 * A repeat report joins the open item as an occurrence, never a new item (REQ-66 BC-3): one row per
 * report after the filing, naming who reported it, from where, what they said and the screenshot
 * they took, which is one of the item's attachments. The Forge door joins one by its signal key
 * (REQ-47 BC-5), a report made in a project by the agent's reading of it (`report.ts`).
 *
 * A duplicate a triage found later was already an item when it was found: it keeps its row and its
 * key (a keyed row is never deleted) and follows its root through `duplicate_of`, as before. Both are
 * read together wherever an item's reporters are: its own reporter, then its occurrences', then its
 * duplicates' (`reporters.ts`).
 */

import type { FeedbackOccurrenceView } from '@forge/contracts/feedback';
import { asc, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { projects } from '../db/schema.js';
import { feedback, feedbackOccurrences } from '../db/schema-feedback.js';
import { peopleOf } from '../lib/people.js';
import type { FeedbackActor } from './read.js';

/** Where one report came from, already checked against what its reporter may read. */
export interface OccurrenceSource {
  projectId: string | null;
  issueId: string | null;
  runId: string | null;
  clientVersion: string | null;
}

export async function addOccurrenceIn(
  tx: Tx,
  feedbackId: string,
  actor: FeedbackActor,
  source: OccurrenceSource,
  extra: {
    dedupKey?: string | null;
    at?: Date;
    /** What the reporter said, already scrubbed for the project. */
    said?: string | null;
    attachmentId?: string | null;
  } = {},
): Promise<string> {
  const [row] = await tx
    .insert(feedbackOccurrences)
    .values({
      feedbackId,
      reportedBy: actor.userId,
      reporterAgency: actor.agency,
      sourceProjectId: source.projectId,
      sourceIssueId: source.issueId,
      sourceRunId: source.runId,
      clientVersion: source.clientVersion,
      said: extra.said?.trim() ? extra.said : null,
      attachmentId: extra.attachmentId ?? null,
      dedupKey: extra.dedupKey ?? null,
      ...(extra.at ? { createdAt: extra.at } : {}),
    })
    .returning({ id: feedbackOccurrences.id });
  if (!row) throw new Error('feedback: the occurrence insert returned no row');
  await tx.update(feedback).set({ updatedAt: new Date() }).where(eq(feedback.id, feedbackId));
  return row.id;
}

/**
 * The reports that joined `item` after its filing, oldest first. An item filed through the Forge door
 * holds its filing as its first occurrence too; that one is its own reporter's, and is left out.
 */
export async function occurrencesOf(item: {
  id: string;
  projectId: string;
  createdAt: Date;
  reportedBy: string;
}): Promise<FeedbackOccurrenceView[]> {
  const rows = await db
    .select({
      id: feedbackOccurrences.id,
      reportedBy: feedbackOccurrences.reportedBy,
      agency: feedbackOccurrences.reporterAgency,
      said: feedbackOccurrences.said,
      attachmentId: feedbackOccurrences.attachmentId,
      projectId: feedbackOccurrences.sourceProjectId,
      slug: projects.slug,
      name: projects.name,
      at: feedbackOccurrences.createdAt,
    })
    .from(feedbackOccurrences)
    .leftJoin(projects, eq(projects.id, feedbackOccurrences.sourceProjectId))
    .where(eq(feedbackOccurrences.feedbackId, item.id))
    .orderBy(asc(feedbackOccurrences.createdAt), asc(feedbackOccurrences.id));
  const later = rows.filter(
    (r, i) => !(i === 0 && r.reportedBy === item.reportedBy && r.at <= item.createdAt),
  );
  const people = await peopleOf(later.map((r) => r.reportedBy));
  return later.map((r) => ({
    id: r.id,
    reporter: { id: r.reportedBy, name: people.get(r.reportedBy)?.name ?? null, agency: r.agency },
    said: r.said,
    attachmentId: r.attachmentId,
    from:
      r.projectId && r.projectId !== item.projectId && r.slug && r.name
        ? { slug: r.slug, name: r.name }
        : null,
    at: r.at.toISOString(),
  }));
}

/** Who reported `itemId` again after its filing, one entry per occurrence, oldest first. */
export async function occurrenceReportersIn(
  tx: Tx,
  itemId: string,
  ownReporter: string,
): Promise<{ id: string; agency: 'human' | 'agent' }[]> {
  return tx
    .select({ id: feedbackOccurrences.reportedBy, agency: feedbackOccurrences.reporterAgency })
    .from(feedbackOccurrences)
    .where(eq(feedbackOccurrences.feedbackId, itemId))
    .orderBy(asc(feedbackOccurrences.createdAt))
    .then((rows) => rows.filter((r) => r.id !== ownReporter));
}
