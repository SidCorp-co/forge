/**
 * ISS-705 (FB-295) — a person corrects which issues a change request delivers.
 *
 * The links are derived: every delivery rewrites them from the request's branch and description
 * (`projection.ts:writeIssueLinks`), and the merge stamps each one (`merge.ts`, `issues/host-merge.ts`).
 * A description cannot be edited through Forge and the host refuses a second request for the same
 * head, so a stray link had no way off. An unlink here is kept on its own row, which the rewrite
 * reads, so the next delivery does not put it back; a relink records itself on that row and
 * restores the link with the kind it had.
 *
 * Nothing here calls the host. The caller resolves which binding and which issue it means.
 */

import type { ChangeRequestLinkRefusalCode } from '@forge/contracts/integrations';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, asc, eq, isNull, max } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import {
  type ChangeRequestLinkKind,
  type PullRequestState,
  repoPullRequestIssues,
  repoPullRequestIssueUnlinks,
  repoPullRequests,
} from '../../db/schema-repo-projection.js';

export interface ChangeRequestLinks {
  number: number;
  state: PullRequestState;
  /** In the order the request names them; the first is its primary issue. */
  linked: Array<{ issueId: string; linkedBy: ChangeRequestLinkKind }>;
  /** Each issue a person took off this request and has not put back. */
  unlinked: Array<{
    issueId: string;
    linkedBy: ChangeRequestLinkKind;
    unlinkedAt: string;
    unlinkedBy: string;
  }>;
}

type LinksOutcome =
  | { ok: true; links: ChangeRequestLinks }
  | { ok: false; code: ChangeRequestLinkRefusalCode; detail: string };

interface RequestRef {
  bindingId: string;
  number: number;
  /** How the host writes the number (`!1979`, `#12`), for the refusal's sentence. */
  label: string;
}

interface LinkAct extends RequestRef {
  issueId: string;
  /** The issue's key, for the refusal's sentence. */
  issueKey: string;
  actor: { id: string; agency: ActorAgency };
}

const notFound = (ref: RequestRef): LinksOutcome => ({
  ok: false,
  code: 'CHANGE_REQUEST_NOT_FOUND',
  detail: `Forge holds no record of ${ref.label} on this project's repository: open it through Forge or let the host's hook deliver it first`,
});

async function requestRow(executor: Tx, ref: RequestRef, lock: boolean) {
  const query = executor
    .select({ id: repoPullRequests.id, state: repoPullRequests.state })
    .from(repoPullRequests)
    .where(
      and(eq(repoPullRequests.bindingId, ref.bindingId), eq(repoPullRequests.number, ref.number)),
    )
    .limit(1);
  const [row] = lock ? await query.for('update') : await query;
  return row ?? null;
}

async function linksOf(
  executor: Tx,
  pullRequestId: string,
  number: number,
  state: PullRequestState,
): Promise<ChangeRequestLinks> {
  const linked = await executor
    .select({ issueId: repoPullRequestIssues.issueId, linkedBy: repoPullRequestIssues.linkedBy })
    .from(repoPullRequestIssues)
    .where(eq(repoPullRequestIssues.pullRequestId, pullRequestId))
    .orderBy(asc(repoPullRequestIssues.position), asc(repoPullRequestIssues.issueId));
  const unlinked = await executor
    .select({
      issueId: repoPullRequestIssueUnlinks.issueId,
      linkedBy: repoPullRequestIssueUnlinks.linkedBy,
      unlinkedAt: repoPullRequestIssueUnlinks.unlinkedAt,
      unlinkedBy: repoPullRequestIssueUnlinks.unlinkedBy,
    })
    .from(repoPullRequestIssueUnlinks)
    .where(
      and(
        eq(repoPullRequestIssueUnlinks.pullRequestId, pullRequestId),
        isNull(repoPullRequestIssueUnlinks.relinkedAt),
      ),
    )
    .orderBy(asc(repoPullRequestIssueUnlinks.unlinkedAt));
  return {
    number,
    state,
    linked,
    unlinked: unlinked.map((u) => ({ ...u, unlinkedAt: u.unlinkedAt.toISOString() })),
  };
}

/** The issues the stored request links and the ones a person took off it. */
export async function readChangeRequestLinks(ref: RequestRef): Promise<LinksOutcome> {
  const row = await requestRow(db, ref, false);
  if (!row) return notFound(ref);
  return { ok: true, links: await linksOf(db, row.id, ref.number, row.state) };
}

const merged = (act: LinkAct): LinksOutcome => ({
  ok: false,
  code: 'CHANGE_REQUEST_MERGED',
  detail: `${act.label} is merged, and the issues it stamped are the record of that landing: its links are no longer changed. Correct an issue's landing on the issue itself (DELETE /api/issues/:id/merge)`,
});

/**
 * Take one issue off the request: its link goes, and the unlink is kept so a later delivery does
 * not bring it back. Locks the request row, which the link rewrite also takes, so the two serialise.
 */
export async function unlinkChangeRequestIssue(act: LinkAct): Promise<LinksOutcome> {
  return db.transaction(async (tx) => {
    const row = await requestRow(tx, act, true);
    if (!row) return notFound(act);
    if (row.state === 'merged') return merged(act);
    const [link] = await tx
      .delete(repoPullRequestIssues)
      .where(
        and(
          eq(repoPullRequestIssues.pullRequestId, row.id),
          eq(repoPullRequestIssues.issueId, act.issueId),
        ),
      )
      .returning({ linkedBy: repoPullRequestIssues.linkedBy });
    if (!link) {
      return {
        ok: false,
        code: 'CHANGE_REQUEST_ISSUE_NOT_LINKED',
        detail: `${act.label} does not link ${act.issueKey}, so there is nothing to unlink: GET its issues for the ones it links`,
      };
    }
    const now = new Date();
    await tx
      .insert(repoPullRequestIssueUnlinks)
      .values({
        pullRequestId: row.id,
        issueId: act.issueId,
        linkedBy: link.linkedBy,
        unlinkedAt: now,
        unlinkedBy: act.actor.id,
        unlinkedAgency: act.actor.agency,
      })
      .onConflictDoUpdate({
        target: [repoPullRequestIssueUnlinks.pullRequestId, repoPullRequestIssueUnlinks.issueId],
        set: {
          linkedBy: link.linkedBy,
          unlinkedAt: now,
          unlinkedBy: act.actor.id,
          unlinkedAgency: act.actor.agency,
          relinkedAt: null,
          relinkedBy: null,
          relinkedAgency: null,
        },
      });
    return { ok: true, links: await linksOf(tx, row.id, act.number, row.state) };
  });
}

/** Put back an issue a person took off the request, with the kind of link it had, last in order. */
export async function relinkChangeRequestIssue(act: LinkAct): Promise<LinksOutcome> {
  return db.transaction(async (tx) => {
    const row = await requestRow(tx, act, true);
    if (!row) return notFound(act);
    if (row.state === 'merged') return merged(act);
    const [unlink] = await tx
      .update(repoPullRequestIssueUnlinks)
      .set({ relinkedAt: new Date(), relinkedBy: act.actor.id, relinkedAgency: act.actor.agency })
      .where(
        and(
          eq(repoPullRequestIssueUnlinks.pullRequestId, row.id),
          eq(repoPullRequestIssueUnlinks.issueId, act.issueId),
          isNull(repoPullRequestIssueUnlinks.relinkedAt),
        ),
      )
      .returning({ linkedBy: repoPullRequestIssueUnlinks.linkedBy });
    if (!unlink) {
      return {
        ok: false,
        code: 'CHANGE_REQUEST_ISSUE_NOT_UNLINKED',
        detail: `${act.issueKey} was not unlinked from ${act.label}, so there is nothing to relink: a relink puts back only what an unlink took off, and the branch and description decide the rest`,
      };
    }
    const [last] = await tx
      .select({ at: max(repoPullRequestIssues.position) })
      .from(repoPullRequestIssues)
      .where(eq(repoPullRequestIssues.pullRequestId, row.id));
    await tx
      .insert(repoPullRequestIssues)
      .values({
        pullRequestId: row.id,
        issueId: act.issueId,
        linkedBy: unlink.linkedBy,
        position: last?.at === null || last?.at === undefined ? 0 : last.at + 1,
      })
      .onConflictDoNothing();
    return { ok: true, links: await linksOf(tx, row.id, act.number, row.state) };
  });
}
