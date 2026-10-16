/**
 * Feedback a person outside Forge files through a channel the project opened (`feedback-triage`
 * `intake`): a widget visitor on a client site. The item is the same row `createFeedback` writes,
 * through the same preparation and the same insert under the project's feedback lock; what differs
 * is who stands behind it. A visitor is never a Forge user, so the row's reporter is the channel's
 * own account (a widget binding's, `widget_principals`), which is a member of nothing and so holds
 * no permission to ask `can()` about: the channel's session, checked by the caller against the
 * binding a project admin created, is the authority, as a Sentry binding is for error intake.
 * Beside the row goes the external reporter record: who the visitor said they are, the page, and the
 * SHA-256 of their private status link.
 */

import { type CreateFeedbackRequest, feedbackKey } from '@forge/contracts/feedback';
import type { FeedbackExternalChannel } from '@forge/contracts/widget';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { users } from '../db/schema-auth.js';
import { feedback, feedbackExternalReporters } from '../db/schema-feedback.js';
import { dataPolicyOf, storedDeep, storedText } from '../lib/data-egress.js';
import type { Refusal } from '../lib/refusal.js';
import { embedFeedbackLater } from './embeddings.js';
import { phaseOfRow } from './list-read.js';
import type { Row } from './read.js';
import { insertFeedbackIn, inTx, lockFeedback, preparedFeedback } from './service.js';

/** Who filed an item from outside Forge, as the channel identified them. */
export interface ExternalReporter {
  channel: FeedbackExternalChannel;
  bindingId: string;
  visitorId: string;
  email: string | null;
  name: string | null;
  signedUserId: string | null;
  /** Where they were, as the host page reported it: stored as data. */
  pageContext: Record<string, unknown> | null;
  /** The SHA-256 of the status link the visitor is handed once. */
  statusTokenHash: string;
}

export type ExternalFiling =
  | { ok: true; id: string; key: string; created: boolean }
  | { ok: false; refusals: Refusal[] };

/**
 * File one item for an external reporter. `within.before` runs first inside the transaction and may
 * refuse, which files nothing; `within.after` writes the channel's own record of the filing in the
 * same transaction, so the item and that record land together or not at all.
 */
export async function fileExternalFeedback(input: {
  projectId: string;
  /** The channel's own account the row names as its reporter. */
  filedAs: string;
  request: CreateFeedbackRequest;
  reporter: ExternalReporter;
  /** One item per key: the channel's own id for what it files, so a retried confirm files nothing twice. */
  dedupKey: string;
  within?: {
    before?: (tx: Tx) => Promise<Refusal | null>;
    after?: (tx: Tx, filed: { id: string; key: string }) => Promise<void>;
  };
}): Promise<ExternalFiling> {
  const { projectId, reporter } = input;
  const [account] = await db
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, input.filedAs))
    .limit(1);
  if (account?.kind !== 'agent') {
    // a person's account is never the stand-in for somebody outside Forge: their name would be on
    // an item they did not file, and their permissions would be what the channel ran under
    throw new Error(
      `feedback: an external reporter is filed as a channel's own agent account, and ${input.filedAs} is ${account ? 'a person' : 'no account'}`,
    );
  }
  const actor = { userId: input.filedAs, agency: 'agent' as const };
  const prepared = await preparedFeedback(projectId, actor, input.request);
  if (!prepared.ok) return prepared;
  const level = await dataPolicyOf(projectId);
  const kept = (text: string | null) => (text === null ? null : storedText(level, text).text);
  let id = '';
  let key = '';
  let created = true;
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const refused = await input.within?.before?.(tx);
    if (refused) return [refused];
    const [twin] = await tx
      .select({ id: feedback.id, seq: feedback.fbSeq })
      .from(feedback)
      .where(and(eq(feedback.projectId, projectId), eq(feedback.dedupKey, input.dedupKey)));
    if (twin) {
      id = twin.id;
      key = feedbackKey(twin.seq);
      created = false;
    } else {
      id = await insertFeedbackIn(tx, { ...prepared.values, dedupKey: input.dedupKey });
      const [row] = await tx
        .select({ seq: feedback.fbSeq })
        .from(feedback)
        .where(eq(feedback.id, id));
      key = feedbackKey(row?.seq ?? 0);
      await tx.insert(feedbackExternalReporters).values({
        feedbackId: id,
        projectId,
        channel: reporter.channel,
        bindingId: reporter.bindingId,
        visitorId: reporter.visitorId,
        email: kept(reporter.email),
        name: kept(reporter.name),
        signedUserId: kept(reporter.signedUserId),
        pageContext: reporter.pageContext ? storedDeep(level, reporter.pageContext) : null,
        statusTokenHash: reporter.statusTokenHash,
      });
    }
    await input.within?.after?.(tx, { id, key });
    return null;
  });
  if (refusals) return { ok: false, refusals };
  if (created) embedFeedbackLater(id);
  return { ok: true, id, key, created };
}

/** What a status link may say of the item it was handed for, and nothing of who handles it. */
export interface ExternalFeedbackStatus {
  key: string;
  title: string;
  phase: Awaited<ReturnType<typeof phaseOfRow>>;
  route: Row['route'];
  redacted: boolean;
  filedAt: Date;
  updatedAt: Date;
}

/** The item a status link's SHA-256 names, or null where none does. */
export async function externalFeedbackStatus(
  statusTokenHash: string,
): Promise<ExternalFeedbackStatus | null> {
  const [hit] = await db
    .select({ row: feedback })
    .from(feedbackExternalReporters)
    .innerJoin(feedback, eq(feedback.id, feedbackExternalReporters.feedbackId))
    .where(eq(feedbackExternalReporters.statusTokenHash, statusTokenHash))
    .limit(1);
  if (!hit) return null;
  const { row } = hit;
  return {
    key: feedbackKey(row.fbSeq),
    title: row.title,
    phase: await phaseOfRow(row.projectId, row),
    route: row.route,
    redacted: row.redactedAt !== null,
    filedAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A redaction takes the external reporter's own data with the rest of what they gave (UC15). */
export async function redactExternalReporterIn(tx: Tx, feedbackId: string): Promise<void> {
  await tx
    .update(feedbackExternalReporters)
    .set({ email: null, name: null, signedUserId: null, pageContext: null })
    .where(eq(feedbackExternalReporters.feedbackId, feedbackId));
}
