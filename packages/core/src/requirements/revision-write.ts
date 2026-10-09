/**
 * The requirement writes that run inside a caller's transaction, under the project's requirement
 * lock: REQ-n at revision 1, and a new revision on the head; a revision's criteria as rows are
 * `revision-criteria.ts`.
 * `service.ts` composes them into its own transactions; an accepted suggestion composes them into
 * the transaction that marks it accepted (ISS-58).
 */

import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import {
  type DraftPicture,
  pictureWithAlt,
  type RequirementKind,
} from '@forge/contracts/requirement-pictures';
import { type RequirementSpec, requirementKey } from '@forge/contracts/requirements';
import type { WrittenLang } from '@forge/contracts/written-lang';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import {
  type RevisionState,
  requirementRevisions,
  requirements,
  requirementWorkflows,
} from '../db/schema-requirements.js';
import { dataPolicyOf, storedDeep, storedText } from '../lib/data-egress.js';
import { writtenLangFor } from '../lib/written-lang.js';
import { emitEvent } from '../outbox/index.js';
import { withAskedQuestions } from './clarity.js';
import { draftPictureRefusals, landingIn, NEW_REQUIREMENT } from './draft-picture.js';
import { drawIn, pictureFitsKind } from './picture.js';
import type { RequirementActor } from './read.js';
import { resetDraftCriteria, writeCriteria } from './revision-criteria.js';
import {
  type CriterionInput,
  openRevisionRefusal,
  type RequirementRefusal,
  staleBaseRefusal,
  stateRefusal,
} from './rules.js';

export interface RevisionWrite {
  reason: string;
  spec?: RequirementSpec | undefined;
  tldr?: string | null | undefined;
  changeSummary?: string | null | undefined;
  criteria: CriterionInput[];
  /** The accepted suggestion this revision is the effect of (suggestion-lifecycle step accepted). */
  fromSuggestionId?: string | undefined;
  /** The language its reason, summary and spec are written in, as declared; absent, derived. */
  writtenLang?: WrittenLang | undefined;
  /** What the requirement is (REQ-35): absent keeps what is there (the head's, on a new revision), null clears it. */
  kind?: RequirementKind | null | undefined;
  /** The picture drawn with this draft (REQ-35 BC-10), shown the moment the revision is written. */
  picture?: DraftPicture | undefined;
}

export const specOf = (spec: RequirementSpec | undefined) => spec ?? {};

/** A revision's text as it is stored at the project's data policy: scrubbed on write at redact and
 *  no_egress, the way comments and issues are (personal-data-flow#ds-issues). */
export function storedWrite(level: SensitiveDataLevel, write: RevisionWrite): RevisionWrite {
  if (level === 'off') return write;
  const text = (v: string) => storedText(level, v).text;
  return {
    ...write,
    reason: text(write.reason),
    spec: write.spec === undefined ? undefined : storedDeep(level, write.spec),
    tldr: write.tldr == null ? write.tldr : text(write.tldr),
    changeSummary: write.changeSummary == null ? write.changeSummary : text(write.changeSummary),
    criteria: write.criteria.map((c) => ({ ...c, body: text(c.body) })),
  };
}

/** REQ-n at revision 1 (draft), numbered max+1 under that lock. */
export async function createRequirementIn(
  tx: Tx,
  input: {
    projectId: string;
    actor: RequirementActor;
    title: string;
    write: RevisionWrite;
    ownerId?: string | null;
    /** Who wrote revision 1's content when not the actor: an accepted suggestion's producer. */
    author?: RequirementActor | undefined;
    /** The designs it is drawn with from the start; the next agree pins their approved revisions. */
    designs?: readonly string[] | undefined;
  },
): Promise<{ id: string; refusals: RequirementRefusal[] | null }> {
  const { projectId, actor } = input;
  const level = await dataPolicyOf(projectId);
  const write = storedWrite(level, input.write);
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${requirements.reqSeq}), 0)::int + 1` })
    .from(requirements)
    .where(eq(requirements.projectId, projectId));
  const unfit = draftPictureRefusals(
    { ...NEW_REQUIREMENT, key: requirementKey(next) },
    write,
    false,
  );
  if (unfit.length) return { id: '', refusals: unfit };
  const [row] = await tx
    .insert(requirements)
    .values({
      projectId,
      reqSeq: next,
      title: storedText(level, input.title.trim()).text,
      ownerId: input.ownerId === undefined ? actor.userId : input.ownerId,
    })
    .returning({ id: requirements.id });
  if (!row) throw new Error('requirements: the insert returned no row');
  const asked = await withAskedQuestions(tx, {
    projectId,
    requirementId: row.id,
    spec: specOf(write.spec),
  });
  if ('refusals' in asked) return { id: row.id, refusals: asked.refusals };
  await tx.insert(requirementRevisions).values({
    requirementId: row.id,
    revision: 1,
    spec: asked.spec,
    tldr: write.tldr ?? null,
    changeSummary: write.changeSummary ?? null,
    reason: write.reason.trim(),
    kind: write.kind ?? null,
    authorId: (input.author ?? actor).userId,
    authorAgency: (input.author ?? actor).agency,
    fromSuggestionId: write.fromSuggestionId ?? null,
    writtenLang: await writtenLangFor(
      input.author ?? actor,
      projectId,
      write.writtenLang,
      tx,
      [write.reason, write.changeSummary, write.tldr].join('\n'),
    ),
  });
  if (write.picture) {
    await drawIn(tx, {
      requirementId: row.id,
      revision: 1,
      picture: pictureWithAlt(write.picture),
      author: input.author ?? actor,
      level,
    });
  }
  if (input.designs?.length) {
    await tx.insert(requirementWorkflows).values(
      input.designs.map((workflowId) => ({
        requirementId: row.id,
        workflowId,
        linkedBy: actor.userId,
      })),
    );
  }
  const refusals = await writeCriteria(tx, row.id, 1, write.criteria);
  // every door creates through here, so every new requirement starts the intake draft (REQ-34 BC-10)
  if (!refusals) {
    await emitEvent(tx, 'requirement.created', {
      projectId,
      requirementId: row.id,
      key: requirementKey(next),
    });
  }
  return { id: row.id, refusals };
}

/** Where a new revision lands: a draft its author proposes, or proposed already by the person whose
 *  accept of a revision_diff suggestion is its propose (feedback-triage `revision`). */
export type RevisionLanding = { state: 'draft' } | { state: 'proposed'; proposedBy: string };

/** The revision row a new revision is inserted as, at `landing`. */
export function newRevisionRow(input: {
  requirementId: string;
  revision: number;
  head: number | null;
  author: RequirementActor;
  write: RevisionWrite;
  landing: RevisionLanding;
  at: Date;
  /** What the head carries over: its kind, and its picture where the new revision keeps that kind. */
  carried?: { kind: RequirementKind | null; pictureId: string | null } | undefined;
}) {
  const { write, landing } = input;
  const kind = write.kind === undefined ? (input.carried?.kind ?? null) : write.kind;
  return {
    requirementId: input.requirementId,
    revision: input.revision,
    baseRevision: input.head,
    authorId: input.author.userId,
    authorAgency: input.author.agency,
    spec: specOf(write.spec),
    tldr: write.tldr ?? null,
    changeSummary: write.changeSummary ?? null,
    reason: write.reason.trim(),
    fromSuggestionId: write.fromSuggestionId ?? null,
    kind,
    pictureId: input.carried && kind === input.carried.kind ? input.carried.pictureId : null,
    state: landing.state,
    proposedAt: landing.state === 'proposed' ? input.at : null,
    proposedBy: landing.state === 'proposed' ? landing.proposedBy : null,
  };
}

/** A new revision on the head at `landing`: refused while another is open, or when `baseRevision` moved. */
export async function newRevisionIn(
  tx: Tx,
  input: {
    requirementId: string;
    head: number | null;
    baseRevision: number | null;
    actor: RequirementActor;
    write: RevisionWrite;
    landing: RevisionLanding;
  },
): Promise<RequirementRefusal[] | null> {
  const { requirementId } = input;
  const [owner] = await tx
    .select({ projectId: requirements.projectId })
    .from(requirements)
    .where(eq(requirements.id, requirementId));
  if (!owner) throw new Error(`requirements: ${requirementId} has no row`);
  const level = await dataPolicyOf(owner.projectId);
  const write = storedWrite(level, input.write);
  const refusal =
    openRevisionRefusal(await openRevisionOf(tx, requirementId)) ??
    staleBaseRefusal(input.baseRevision, input.head);
  if (refusal) return [refusal];
  const unfit = draftPictureRefusals(
    await landingIn(tx, requirementId, { head: input.head }),
    write,
    false,
  );
  if (unfit.length) return unfit;
  const asked = await withAskedQuestions(tx, {
    projectId: owner.projectId,
    requirementId,
    spec: specOf(write.spec),
  });
  if ('refusals' in asked) return asked.refusals;
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${requirementRevisions.revision}), 0)::int + 1` })
    .from(requirementRevisions)
    .where(eq(requirementRevisions.requirementId, requirementId));
  // a new revision of the head's kind carries the head's picture until it is redrawn or replaced;
  // one of another kind starts with none (Requirement lifecycle r14 `revision.written`)
  const [carried] =
    input.head === null
      ? []
      : await tx
          .select({ kind: requirementRevisions.kind, pictureId: requirementRevisions.pictureId })
          .from(requirementRevisions)
          .where(
            and(
              eq(requirementRevisions.requirementId, requirementId),
              eq(requirementRevisions.revision, input.head),
            ),
          );
  await tx.insert(requirementRevisions).values({
    ...newRevisionRow({
      requirementId,
      revision: next,
      head: input.head,
      author: input.actor,
      write: { ...write, spec: asked.spec },
      landing: input.landing,
      at: new Date(),
      carried: carried && {
        kind: (carried.kind as RequirementKind | null) ?? null,
        pictureId: carried.pictureId,
      },
    }),
    writtenLang: await writtenLangFor(
      input.actor,
      owner.projectId,
      write.writtenLang,
      tx,
      [write.reason, write.changeSummary, write.tldr].join('\n'),
    ),
  });
  if (write.picture) {
    await drawIn(tx, {
      requirementId,
      revision: next,
      picture: pictureWithAlt(write.picture),
      author: input.actor,
      level,
    });
  }
  return writeCriteria(tx, requirementId, next, write.criteria);
}

/**
 * Rewrites open revision `revision` whole, in place: its text, its author and its criteria, which
 * are reset to what the revisions before it left and re-applied (a code it gave may be named again).
 * A person's edit of their draft keeps its state; an accepted revision_diff built on the open
 * revision lands it at `landing` (REQ-30 BC-3: the BA improves a new requirement's draft).
 */
export async function rewriteRevisionIn(
  tx: Tx,
  input: {
    projectId: string;
    requirementId: string;
    revision: number;
    actor: RequirementActor;
    write: RevisionWrite;
    landing?: RevisionLanding | undefined;
  },
): Promise<RequirementRefusal[] | null> {
  const { projectId, requirementId, revision, actor } = input;
  const level = await dataPolicyOf(projectId);
  const stored = storedWrite(level, input.write);
  const unfit = draftPictureRefusals(
    await landingIn(tx, requirementId, { revision }),
    stored,
    false,
  );
  if (unfit.length) return unfit;
  const asked = await withAskedQuestions(tx, {
    projectId,
    requirementId,
    spec: specOf(stored.spec),
  });
  if ('refusals' in asked) return asked.refusals;
  const { landing } = input;
  const kindSet =
    stored.kind === undefined ? {} : await kindChangeOf(tx, requirementId, revision, stored.kind);
  await tx
    .update(requirementRevisions)
    .set({
      ...kindSet,
      spec: asked.spec,
      tldr: stored.tldr ?? null,
      changeSummary: stored.changeSummary ?? null,
      reason: stored.reason.trim(),
      authorId: actor.userId,
      authorAgency: actor.agency,
      writtenLang: await writtenLangFor(
        actor,
        projectId,
        input.write.writtenLang,
        tx,
        [input.write.reason, input.write.changeSummary, input.write.tldr].join('\n'),
      ),
      ...(stored.fromSuggestionId ? { fromSuggestionId: stored.fromSuggestionId } : {}),
      ...(landing?.state === 'proposed'
        ? { state: 'proposed' as const, proposedAt: new Date(), proposedBy: landing.proposedBy }
        : {}),
    })
    .where(
      and(
        eq(requirementRevisions.requirementId, requirementId),
        eq(requirementRevisions.revision, revision),
      ),
    );
  if (stored.picture) {
    await drawIn(tx, {
      requirementId,
      revision,
      picture: pictureWithAlt(stored.picture),
      author: actor,
      level,
    });
  }
  const own = await resetDraftCriteria(tx, requirementId, revision);
  return writeCriteria(tx, requirementId, revision, stored.criteria, own);
}

/** The kind a rewrite names, and no picture where the one it held was drawn for another kind. */
async function kindChangeOf(
  tx: Tx,
  requirementId: string,
  revision: number,
  kind: RequirementKind | null,
): Promise<{ kind: RequirementKind | null; pictureId?: null }> {
  const [held] = await tx
    .select({ pictureId: requirementRevisions.pictureId })
    .from(requirementRevisions)
    .where(
      and(
        eq(requirementRevisions.requirementId, requirementId),
        eq(requirementRevisions.revision, revision),
      ),
    );
  const keeps = await pictureFitsKind(tx, held?.pictureId ?? null, kind);
  return keeps ? { kind } : { kind, pictureId: null };
}

/** The open (draft or proposed) revision of a requirement, if any. */
export async function openRevisionOf(tx: Tx, requirementId: string) {
  const [open] = await tx
    .select({ revision: requirementRevisions.revision, state: requirementRevisions.state })
    .from(requirementRevisions)
    .where(
      and(
        eq(requirementRevisions.requirementId, requirementId),
        inArray(requirementRevisions.state, ['draft', 'proposed']),
      ),
    );
  return open ? { revision: open.revision, state: open.state as RevisionState } : null;
}

/**
 * Withdraws draft `revision` (REQ-41 BC-12, migration 0481): a terminal state reachable only from
 * draft, with why, by whom and when. What its writes did to the criteria is undone first, so its
 * wordings never read as live at a later revision; its own text stays, frozen, as evidence.
 */
export async function withdrawRevisionIn(
  tx: Tx,
  input: { requirementId: string; revision: number; reason: string; actor: RequirementActor },
): Promise<RequirementRefusal[] | null> {
  const [row] = await tx
    .select({ state: requirementRevisions.state })
    .from(requirementRevisions)
    .where(
      and(
        eq(requirementRevisions.requirementId, input.requirementId),
        eq(requirementRevisions.revision, input.revision),
      ),
    )
    .for('update');
  if (!row)
    throw new Error(`requirements: ${input.requirementId} has no revision ${input.revision}`);
  const notDraft = stateRefusal(input.revision, row.state as RevisionState, 'draft');
  if (notDraft) return [notDraft];
  await resetDraftCriteria(tx, input.requirementId, input.revision);
  await tx
    .update(requirementRevisions)
    .set({
      state: 'withdrawn',
      withdrawnReason: input.reason.trim(),
      withdrawnAt: new Date(),
      withdrawnBy: input.actor.userId,
    })
    .where(
      and(
        eq(requirementRevisions.requirementId, input.requirementId),
        eq(requirementRevisions.revision, input.revision),
      ),
    );
  return null;
}
