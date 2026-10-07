/**
 * "Tell the reporter now": anyone who holds feedback.approve may tell the reporters of a shipped item
 * nothing told yet that its work shipped, in each reporter's language, naming the release and what
 * the release notes say changed. Kept on the thread as a message to reporters, so `ship-notice.ts`
 * reads the reporter told, by whom and when. Meant above all for an item that shipped before this
 * project's releases sent notices, which owes nobody a relay.
 */

import type { FeedbackView } from '@forge/contracts/feedback';
import { feedbackKey } from '@forge/contracts/feedback';
import { and, asc, eq, ne } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { feedbackMessages, feedbackRouteIssues } from '../db/schema-feedback.js';
import type { Refusal } from '../lib/refusal.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { phaseOfRow } from './list-read.js';
import { type FeedbackActor, type Row, rowIn } from './read.js';
import { reporterLanguageOf, tellReporters } from './reporter-language.js';
import { shippedNotice } from './reporter-notices.js';
import { reportersOf, withBell } from './reporters.js';
import { decideActRefusal, refusal } from './rules.js';
import { answer, inTx, lockFeedback, roleFacts } from './service.js';
import { shipNoticeOf } from './ship-notice.js';

/** What the release notes of the item's carriers say changed for users, oldest carrier first. */
async function saidOf(tx: Tx, feedbackId: string): Promise<string[]> {
  const rows = await tx
    .select({ notes: issues.releaseNotes })
    .from(feedbackRouteIssues)
    .innerJoin(issues, eq(issues.id, feedbackRouteIssues.issueId))
    .where(and(eq(feedbackRouteIssues.feedbackId, feedbackId), ne(issues.status, 'dropped')))
    .orderBy(asc(issues.issSeq));
  return rows.flatMap((r) => {
    const line = r.notes?.userFacing?.trim();
    return line ? [line] : [];
  });
}

async function tellIn(tx: Tx, row: Row, actor: FeedbackActor): Promise<Refusal[] | null> {
  const phase = await phaseOfRow(row.projectId, row);
  const notice = await shipNoticeOf(row.projectId, {
    id: row.id,
    route: row.route,
    phase,
    reporterAgency: row.reporterAgency,
  });
  if (!notice) {
    return [
      refusal(
        'FEEDBACK_NOT_RESOLVED',
        '/phase',
        `the item reads ${phase}; only an item whose issues shipped can be told it shipped.`,
      ),
    ];
  }
  if (notice.state === 'told') {
    return [
      refusal(
        'FEEDBACK_ALREADY_TOLD',
        '/shipNotice',
        `its reporter was already told on ${notice.at.slice(0, 10)}${notice.release ? ` (${notice.release})` : ''}; send a message to reporters to say more.`,
      ),
    ];
  }
  const reached = withBell(await reportersOf(tx, row)).map((r) => r.id);
  if (reached.length === 0) {
    return [
      refusal(
        'FEEDBACK_MESSAGE_NO_RECIPIENT',
        '/audience',
        'no reporter of this item has a bell to tell; tell them where they listen and record it as a message with relayed: true.',
      ),
    ];
  }
  const key = feedbackKey(row.fbSeq);
  const said = await saidOf(tx, row.id);
  const version = notice.shipped.release;
  const first = await reporterLanguageOf(reached[0] as string, row.projectId);
  await tx.insert(feedbackMessages).values({
    projectId: row.projectId,
    feedbackId: row.id,
    audience: 'all_reporters',
    body: shippedNotice(first, key, row.title, version, said).body,
    recipients: reached,
    sentBy: actor.userId,
    sentAgency: actor.agency,
  });
  await tellReporters(
    tx,
    { projectId: row.projectId, feedbackId: row.id, kind: 'message' },
    reached,
    (language) => shippedNotice(language, key, row.title, version, said),
  );
  return null;
}

export async function tellShippedNow(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
}): Promise<{ ok: true; feedback: FeedbackView } | { ok: false; refusals: Refusal[] }> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const forbidden = decideActRefusal(
    await roleFacts(actor, projectId),
    'telling reporters their feedback shipped',
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const first = await rowIn(db, projectId, input.ref);
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    return tellIn(tx, await rowIn(tx, projectId, first.id, true), actor);
  });
  if (refusals) return { ok: false, refusals };
  const out = await answer(projectId, first.id, actor);
  return out.ok ? { ok: true, feedback: out.feedback } : out;
}
