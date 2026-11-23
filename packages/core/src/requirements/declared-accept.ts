// A requirement revision accepted by a speaker a project admin declared by chat identity for `accept`
// (REQ-90 BC-15, ISS-1436). The accept goes through the one acceptance service (`agree.ts:acceptRevision`),
// which records who decided it from here: the chat identity's account and the name the room showed,
// where the person holds no Forge account, on the revision and on the baseline an accept of an agreed
// requirement writes. Once the identity links a Forge account, the user is written beside it, so the
// acceptance reads as theirs and the chat identity stays as the evidence of whose word it was.

import { requirementKey } from '@forge/contracts/requirements';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  requirementBaselines,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { acceptRevision } from './agree.js';
import type { DeclaredAccepter } from './declared-accepter.js';
import { type RequirementActor, rowIn } from './read.js';
import { openRevisionOf } from './revision-write.js';
import type { RequirementOutcome } from './write-tx.js';

/**
 * Accept `ref`'s proposed revision as a declared speaker (`declared`), through the one acceptance
 * service, `actor` being the room's session that makes the move. Refused by name where no revision
 * is proposed, and by the service's own guards otherwise.
 */
export async function acceptAsDeclared(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  reason: string;
  declared: DeclaredAccepter;
}): Promise<RequirementOutcome & { revision?: number }> {
  const row = await rowIn(db, input.projectId, input.ref);
  const open = await openRevisionOf(db, row.id);
  if (open?.state !== 'proposed') {
    return {
      ok: false,
      refusals: [
        {
          code: 'REQUIREMENT_REVISION_NOT_PROPOSED',
          path: '/item',
          detail: `${requirementKey(row.reqSeq)} has no proposed revision${open ? ` (revision ${open.revision} is a draft)` : ''}; only a proposed revision is accepted.`,
        },
      ],
    };
  }
  const accepted = await acceptRevision({ ...input, revision: open.revision });
  return accepted.ok ? { ...accepted, revision: open.revision } : accepted;
}

/**
 * The acceptances a chat identity made before it linked a Forge account, written as `userId`'s
 * (ISS-1436): each revision it decided and each baseline it agreed that names no user yet. A naming
 * that holds in one project (`projectId`) moves that project's alone. Answers how many moved.
 */
export async function moveChatAcceptancesToUser(input: {
  chatAccountId: string;
  userId: string;
  projectId?: string | null | undefined;
}): Promise<number> {
  const inProject = input.projectId
    ? db
        .select({ id: requirements.id })
        .from(requirements)
        .where(eq(requirements.projectId, input.projectId))
    : null;
  return db.transaction(async (tx) => {
    const revisions = await tx
      .update(requirementRevisions)
      .set({ decidedBy: input.userId })
      .where(
        and(
          eq(requirementRevisions.decidedByChatAccount, input.chatAccountId),
          isNull(requirementRevisions.decidedBy),
          ...(inProject ? [inArray(requirementRevisions.requirementId, inProject)] : []),
        ),
      )
      .returning({ id: requirementRevisions.requirementId });
    const baselines = await tx
      .update(requirementBaselines)
      .set({ agreedBy: input.userId })
      .where(
        and(
          eq(requirementBaselines.agreedByChatAccount, input.chatAccountId),
          isNull(requirementBaselines.agreedBy),
          ...(inProject ? [inArray(requirementBaselines.requirementId, inProject)] : []),
        ),
      )
      .returning({ id: requirementBaselines.requirementId });
    return revisions.length + baselines.length;
  });
}
