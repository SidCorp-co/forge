import { z } from 'zod';
import { db } from '../db/client.js';
import { comments } from '../db/schema.js';
import type { Actor } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { collectWorkEvidence, findMissingWorkEvidence } from '../pipeline/work-evidence.js';
import type { ActorAgency } from './actor-agency.js';
import {
  clearIssueMerge,
  type MergeRecord,
  observedMergeForIssue,
  recordIssueMerge,
} from './merge-record.js';
import { findIssueById, type IssueRow } from './read-service.js';

export type AuditComment = { id: string; body: string; parentId: string | null };

/**
 * ISS-959 — the commit a merged mark was made at, on both doors.
 *
 * A sha and nothing else: the field exists so "did THIS commit land?" stops
 * being a judgement call read out of prose, and prose in it would put the
 * judgement straight back. Anything a person wants to say about the landing
 * still goes in `note`, which is what `note` is for.
 */
// cm:guard the shape is refused rather than stored — `commit=squashed as abc123` in this column reads as a sha to every consumer and is not one, and a loud 400 costs the caller one retry where a silent accept costs a reader the whole point of the field
export const mergedCommitShaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{7,64}$/i, 'commit must be a git sha: 7 to 64 hex characters, nothing else');

/**
 * ISS-959 — the commit this mark records, when the caller named none.
 *
 * `forge guide contract earning-and-unearning` requires that anything the
 * repository knows is written onto the issue at the step that knew it, and
 * says of this one: *"the merged mark, which today takes no commit and carries
 * it in the prose of its note"*. Prose is not a field, so the note's form was
 * part of the contract. This is the field, and the fallback is what makes it
 * arrive without every client learning it first.
 */
// cm:guard core has NO repo checkout (`git merge-base` returns zero hits under packages/core/src), so the handoff's `commitSha` is the only commit core can know — and it is a recorded claim, not a verified ancestor. Do not let this grow into a git check here; the check belongs where a checkout exists, and a fallback that pretended otherwise would put a verified-sounding sha on an unverified landing.
// cm:guard fails to NULL on any internal error — a mark must never be refused because the convenience that fills one of its fields could not read
async function resolveRecordedCommit(issueId: string): Promise<string | null> {
  try {
    const evidence = await collectWorkEvidence(issueId);
    return evidence.handoffCommitSha;
  } catch {
    return null;
  }
}

export async function writeAuditComment(
  issueId: string,
  authorId: string,
  body: string,
): Promise<AuditComment | null> {
  const [row] = await db
    .insert(comments)
    .values({ issueId, authorId, body, parentId: null })
    .returning({ id: comments.id, body: comments.body, parentId: comments.parentId });
  return row ?? null;
}

export class MergeMarkerError extends Error {
  constructor(
    readonly code: 'NO_WORK_EVIDENCE' | 'ISSUE_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'MergeMarkerError';
  }
}

export type MergeMarkerActor = {
  agency: ActorAgency;
  /** Who the audit comment is attributed to. */
  commentAuthorId: string;
  hookActor: Actor;
};

/**
 * ISS-286 — the whole `merged_at` write, for every surface that offers it.
 *
 * `merged_at` is what the feature-branch barrier reads to release a `blocks`
 * parent, so this is a claim that work shipped, not a field edit.
 *
 * ISS-1073 left this door standing and took its column away. It no longer holds
 * a statement of its own — `merge-record.ts` does — and the commit a caller
 * names no longer reaches `merged_commit_sha`, because that column is now
 * evidence: only a merge Forge watched happen writes one. Where Forge DID watch
 * this issue's pull request merge, the mark ADOPTS that evidence, commit and
 * time both, which is also the repair for the thing ISS-1027's retraction
 * measured — `unmark` then `mark` used to re-stamp the correction's time and no
 * further correcting recovered the landing's.
 */
// cm:guard the caller's own `commit` is recorded in the audit comment and NOT in the column, and the comment SAYS so. Dropping it silently would be the substitution CLAUDE.md prices: a master that passed `--at <sha>` and read the column back would find it empty with nothing anywhere saying why. What is refused here is not the caller — it is the idea that a sha somebody typed is the same kind of fact as a sha GitHub reported.
// cm:guard ONE implementation, and the reason is the whole ISS-786 gate: this lived inside the MCP tool, so `POST /api/issues/:id/merge` could only have been a second copy — and a second copy is where the evidence check gets left out, exactly as it was left out of the batch route's actor. The gate reads `agency`, never device-ness, because a job token is an agent writing as the person who queued it.
export async function applyMergeMarker(args: {
  /** Already loaded AND authorised by the caller — this function does neither. */
  issue: { id: string; projectId: string; mergedAt: Date | null };
  op: 'mark' | 'unmark';
  target?: string;
  note?: string | undefined;
  /** The commit the CALLER says this mark was made at. Recorded in the audit trail; the column
   *  takes only a commit Forge observed. Absent falls back to the recorded handoff sha. */
  commit?: string | undefined;
  mergedAt?: Date | null;
  actor: MergeMarkerActor;
}): Promise<{ issue: IssueRow; action: 'merged' | 'already_merged' | 'unmarked' }> {
  const before = args.issue;

  let stampResult: MergeRecord = { wrote: true, mergedAt: null, commitSha: null };
  /** The commit the caller claimed, where Forge has no merge of its own to put in the column. */
  let claimedCommit: string | null = null;
  if (args.op === 'mark') {
    if (args.actor.agency === 'agent') {
      const missing = await findMissingWorkEvidence(before.id);
      if (missing) throw new MergeMarkerError('NO_WORK_EVIDENCE', missing);
    }
    const observed = await observedMergeForIssue(db, before.id);
    if (observed) {
      // cm:guard the observed time outranks the caller's `mergedAt` and is not a merge of the two. A caller supplying a time is supplying its best guess; GitHub's `merged_at` is when the merge happened. Preferring the caller's would reproduce ISS-1027's defect on an issue where Forge holds the answer.
      stampResult = await recordIssueMerge(db, {
        issueId: before.id,
        evidence: {
          kind: 'observed',
          commitSha: observed.commitSha,
          mergedAt: observed.mergedAt,
          via: 'event',
        },
      });
      const claimed = args.commit ?? null;
      claimedCommit =
        claimed && claimed.toLowerCase() !== observed.commitSha.toLowerCase() ? claimed : null;
    } else {
      stampResult = await recordIssueMerge(db, {
        issueId: before.id,
        evidence: { kind: 'asserted', at: args.mergedAt ?? null, via: 'mark' },
      });
      claimedCommit = args.commit ?? (await resolveRecordedCommit(before.id));
    }
  } else {
    await clearIssueMerge(db, before.id);
  }

  // cm:why the commit goes in the audit label rather than being left to the note — the label is what this module writes and the note is what a caller chose to write, and the commit is now a field either way, so a reader comparing two marks reads one form
  const commitLabel = stampResult.commitSha
    ? ` commit=${stampResult.commitSha}`
    : claimedCommit
      ? ` commit=${claimedCommit}`
      : '';
  const label =
    args.op === 'mark' ? `mark_merged target=${args.target ?? '<unset>'}${commitLabel}` : 'unmark';
  // cm:guard the no-op arm must say the timestamp is SOMEBODY ELSE'S. Without it the trail is a note that reads as this call's justification sitting beside a value this call did not write, and a reader correcting a wrong stamp has no way to see that `unmark` then `mark` is the only route — which itself re-blocks every dependent (`merge-record.ts:clearIssueMerge`).
  // cm:guard and it says so on a LINE OF ITS OWN, because the caller's note is NOT this module's to splice into. A note is a clause list somebody else composed and reads back by clause, and a clause runs to the next `;` or newline — so an advisory joined on with a dash lands inside the caller's LAST clause instead of beside it. Measured 2026-09-14 on ISS-1004: the note's `landing wrote …/proactivity.test.ts` read back as `…/proactivity.test.ts — NOT stamped by this call: merged_at was already …`, and the run was told its change had grown to a path nobody had written. Append after the note, never into it.
  const unchanged =
    args.op === 'mark' && !stampResult.wrote
      ? `\nNOT stamped by this call: merged_at was already ${stampResult.mergedAt?.toISOString() ?? 'set'} and the first stamp wins; \`unmark\` then \`mark\` is the only correction. It does not re-block dependents: those are held by the issue's STATUS and not by this column (ISS-1100)`
      : '';
  // cm:guard the caller is TOLD its commit did not reach the column, on a line of its own, for the same reason the advisory above exists: a mark that answers `merged` while quietly declining half of what it was given is indistinguishable from one that took it. `merged_commit_sha` is evidence since ISS-1073 and a sha nobody watched land is not evidence, so it is kept where a reader can still find it rather than thrown away.
  const asserted =
    args.op === 'mark' && claimedCommit
      ? `\ncommit ${claimedCommit} is recorded here as this call's claim and is NOT in \`merged_commit_sha\`: that column holds only a merge Forge observed${stampResult.commitSha ? `, which for this issue is ${stampResult.commitSha}` : ''}`
      : '';
  const auditComment = await writeAuditComment(
    before.id,
    args.actor.commentAuthorId,
    `${label}${args.note ? ` — ${args.note}` : ''}${unchanged}${asserted}`,
  );
  if (auditComment) {
    await hooks.emit('commentCreated', {
      issueId: before.id,
      projectId: before.projectId,
      actor: args.actor.hookActor,
      // cm:guard `agent` whoever pressed Mark merged: this comment is the machine recording a stamp, and reading it as an answer resumed a parked ISS-962 on 2026-09-08.
      authored: 'agent',
      commentId: auditComment.id,
      body: auditComment.body,
      parentId: auditComment.parentId,
    });
  }

  const issue = await findIssueById(before.id);
  if (!issue) throw new MergeMarkerError('ISSUE_NOT_FOUND', 'issue not found');
  await hooks.emit('issueUpdated', {
    issueId: before.id,
    projectId: before.projectId,
    actor: args.actor.hookActor,
    fields: ['mergedAt', 'mergedCommitSha'],
    before: { mergedAt: before.mergedAt },
    after: { mergedAt: issue.mergedAt, mergedCommitSha: issue.mergedCommitSha },
  });
  // cm:guard beside `issueUpdated` and not instead of it. The merged mark is one of the five criteria `statusEntryCriteria` can declare, and this writer does not go through `updateIssueFields` — it stamps through `merged-at.ts` — so the announcement `update-service.ts` makes would never fire for a mark or an unmark without this line (ISS-1072).
  await hooks.emit('contractInputChanged', {
    projectId: before.projectId,
    issueId: before.id,
    reason: args.op === 'mark' ? 'merged mark written' : 'merged mark cleared',
  });

  // cm:guard the tick is on `mark` ONLY — clearing `merged_at` can only ADD a block, so waking the dispatcher there is work that can never find anything, while skipping it on `mark` leaves a now-unblocked parent waiting out the 60s pg-boss backstop instead of dispatching in ~1s.

  if (args.op !== 'mark') return { issue, action: 'unmarked' };
  return { issue, action: stampResult.wrote ? 'merged' : 'already_merged' };
}
