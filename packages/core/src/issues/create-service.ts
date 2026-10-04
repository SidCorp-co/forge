import { eq } from 'drizzle-orm';
import type { BodyFormat } from '../body/formats.js';
import { prepareBody } from '../body/prepare.js';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issueLabels, issues } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { Actor } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { leaseWriteTakes } from '../pipeline/session-claim.js';
import {
  type AttachmentErrorEntry,
  type Base64AttachmentInput,
  type DecodedAttachment,
  decodeAndValidateAttachments,
  type PersistedIssueAttachment,
  persistDecodedIssueAttachments,
} from './attachment-service.js';
import { refuseHeldTake } from './blocked-by.js';
import { syncCriteriaFromText } from './criteria/store.js';
import { claimDetectorKey, isValidDetectorKey } from './detector-key.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import {
  type LabelAttachInput,
  type ResolvedLabelAttach,
  resolveLabelIdsForWrite,
} from './label-service.js';
import {
  type AppliedIssueRelation,
  flushIssueRelationEffects,
  type IssueRelationInput,
  type PendingIssueRelation,
  writeIssueRelations,
} from './relations-service.js';
import { splitSessionContext, writeSplitSessionContext } from './work-state.js';

export type IssueCreateErrorCode = 'INVALID_STATUS' | 'INVALID_DETECTOR_KEY';

export class IssueCreateError extends Error {
  constructor(
    readonly code: IssueCreateErrorCode,
    readonly value: string,
  ) {
    super(code);
    this.name = 'IssueCreateError';
  }
}

/**
 * ISS-130 / ISS-236 — the only statuses an issue may be born at. `open` is the
 * normal triage entry, `on_hold` parks it before triage, `draft` holds an
 * AI-generated proposal for human promote/discard. Every other status change
 * goes through the transition surface so the state machine and activity log run.
 */
export const CREATE_ENTRY_STATUSES = ['open', 'on_hold', 'draft'] as const;

export type CreateEntryStatus = (typeof CREATE_ENTRY_STATUSES)[number];

export type CreateIssueInput = {
  projectId: string;
  title: string;
  description?: string | null | undefined;
  descriptionFormat?: BodyFormat | null | undefined;
  priority?: string | undefined;
  category?: string | null | undefined;
  complexity?: string | null | undefined;
  reportedBy?: string | null | undefined;
  assigneeId?: string | null | undefined;
  status?: string | undefined;
  labels?: readonly LabelAttachInput[] | undefined;
  attachments?: readonly Base64AttachmentInput[] | undefined;
  detectorKey?: string | null | undefined;
  relations?: readonly IssueRelationInput[] | undefined;
  plan?: string | null | undefined;
  acceptanceCriteria?: string | null | undefined;
  sessionContext?: unknown;
  releaseNotes?: unknown;
};

/**
 * Who is creating. `createdVia` is the channel the origin classifier reads
 * (`creator.ts`), so it must name the real transport, never a default.
 */
export type IssueCreateWriter = {
  createdById: string;
  /** The paired box whose credential files it, or null for an account's own write. */
  createdByDeviceId: string | null;
  createdVia: IssueCreatedVia;
  actor: Actor;
};

export type IssueCreateRow = typeof issues.$inferSelect;

/** The channel column's own union — a create must name a real transport. */
export type IssueCreatedVia = NonNullable<IssueCreateRow['createdVia']>;

export type CreateIssueResult =
  | {
      deduped: true;
      detectorKey: string;
      existingIssueId: string;
      existingIssueDisplayId: string | null;
      existingIssueStatus: string | null;
    }
  | {
      deduped: false;
      issue: IssueCreateRow;
      labelIds: ResolvedLabelAttach[];
      relations: AppliedIssueRelation[];
      attachments: PersistedIssueAttachment[];
      attachmentErrors: AttachmentErrorEntry[];
      /** What the body sanitizer removed from the description on the way in. */
      bodyWarnings: string[];
    };

/**
 * The one insert into `issues`, inside the caller's transaction. A write that files issues as the
 * effect of another act (a feedback route, an accepted breakdown) calls it in that act's own
 * transaction, then `announceIssueCreated` once it committed, as `createIssue` does.
 */
export async function insertIssueRow(
  tx: Tx,
  values: typeof issues.$inferInsert,
): Promise<IssueCreateRow> {
  const [inserted] = await tx.insert(issues).values(values).returning();
  if (!inserted) throw new Error('issues: insert returned no row');
  return inserted;
}

/** After the create committed: the hook every issue create emits (activity, WS, memory, dispatch). */
export async function announceIssueCreated(
  created: IssueCreateRow,
  actor: Actor,
  labelIds: readonly string[] = [],
): Promise<void> {
  await hooks.emit('issueCreated', {
    issueId: created.id,
    projectId: created.projectId,
    actor,
    status: created.status as IssueStatus,
    snapshot: {
      title: created.title,
      description: created.description,
      descriptionFormat: created.descriptionFormat,
      priority: created.priority,
      category: created.category,
      reportedBy: created.reportedBy,
      assigneeId: created.assigneeId,
      labels: [...labelIds],
    },
  });
}

export async function createIssue(
  input: CreateIssueInput,
  writer: IssueCreateWriter,
): Promise<CreateIssueResult> {
  const requestedStatus = (input.status ?? 'open') as CreateEntryStatus;
  if (!(CREATE_ENTRY_STATUSES as readonly string[]).includes(requestedStatus)) {
    throw new IssueCreateError('INVALID_STATUS', requestedStatus);
  }

  let decodedAttachments: DecodedAttachment[] = [];
  if (input.attachments && input.attachments.length > 0) {
    decodedAttachments = decodeAndValidateAttachments([...input.attachments]);
  }

  const labelIds =
    input.labels && input.labels.length > 0
      ? await resolveLabelIdsForWrite(input.projectId, input.labels)
      : [];

  const prepared =
    typeof input.description === 'string' && input.description.trim().length > 0
      ? prepareBody({ raw: input.description, format: input.descriptionFormat })
      : null;

  const detectorKey = input.detectorKey ?? null;
  if (detectorKey) {
    if (!isValidDetectorKey(detectorKey)) {
      throw new IssueCreateError('INVALID_DETECTOR_KEY', detectorKey);
    }
    const { existingIssueId } = await claimDetectorKey(input.projectId, detectorKey);
    if (existingIssueId) {
      const [live] = await db
        .select({ issSeq: issues.issSeq, status: issues.status })
        .from(issues)
        .where(eq(issues.id, existingIssueId))
        .limit(1);
      return {
        deduped: true,
        detectorKey,
        existingIssueId,
        existingIssueDisplayId: live
          ? formatIssueRef(await activeIssuePrefix(input.projectId), live.issSeq)
          : null,
        existingIssueStatus: live?.status ?? null,
      };
    }
  }

  const split =
    input.sessionContext === undefined ? null : splitSessionContext(input.sessionContext);
  const { created, pendingRelations } = await db.transaction(async (tx) => {
    const inserted = await insertIssueRow(tx, {
      projectId: input.projectId,
      title: input.title,
      description: prepared ? prepared.body : (input.description ?? null),
      descriptionFormat: prepared?.format ?? 'markdown',
      status: requestedStatus as IssueStatus,
      priority: (input.priority ?? 'medium') as IssueCreateRow['priority'],
      category: input.category ?? null,
      complexity: (input.complexity ?? null) as IssueCreateRow['complexity'],
      reportedBy: input.reportedBy ?? null,
      assigneeId: input.assigneeId ?? null,
      createdById: writer.createdById,
      createdByDeviceId: writer.createdByDeviceId,
      createdVia: writer.createdVia,
      detectorKey,
      plan: input.plan ?? null,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      sessionContext: (split?.rest ?? null) as IssueCreateRow['sessionContext'],
      releaseNotes: (input.releaseNotes ?? null) as IssueCreateRow['releaseNotes'],
    });
    if (inserted.acceptanceCriteria) {
      await syncCriteriaFromText(tx, inserted.id, inserted.acceptanceCriteria);
    }
    // ISS-54 cm:hack — the lease, branch and head a `sessionContext` names belong to the work
    // state (`work-state.ts:splitSessionContext`). Exit: until forge-plugin moves to the 10-status
    // model (plugin-followups.md).
    if (split && (split.lease.present || split.branch !== null || split.headSha !== null)) {
      await writeSplitSessionContext(tx, inserted.id, split);
    }

    if (labelIds.length > 0) {
      await tx.insert(issueLabels).values(
        labelIds.map((l) => ({
          issueId: inserted.id,
          labelId: l.labelId,
          isPrimary: l.isPrimary,
        })),
      );
    }
    const pendingRelations = await writeIssueRelations(
      { actor: writer.actor, createdById: writer.createdById },
      input.projectId,
      inserted.id,
      input.relations,
      tx,
    );
    // cm:guard an issue filed with a live lease is claimed at birth, so the edges filed with it are
    // read before the claim stands (issues/blocked-by.ts:refuseHeldTake)
    if (split?.lease.present && leaseWriteTakes(null, split.lease.value, new Date())) {
      await refuseHeldTake(tx, inserted.id, 'filing it with a live lease');
    }
    return { created: inserted, pendingRelations };
  });

  let attachments: PersistedIssueAttachment[] = [];
  let attachmentErrors: AttachmentErrorEntry[] = [];
  if (decodedAttachments.length > 0) {
    const result = await persistDecodedIssueAttachments(
      created.id,
      decodedAttachments,
      writer.createdById,
      writer.actor.agency,
    );
    attachments = result.persisted;
    attachmentErrors = result.errors;
  }

  await flushIssueRelationEffects(
    { actor: writer.actor, createdById: writer.createdById },
    input.projectId,
    pendingRelations,
  );
  const relations = pendingRelations.map((p: PendingIssueRelation) => p.applied);

  await announceIssueCreated(
    created,
    writer.actor,
    labelIds.map((l) => l.labelId),
  );

  return {
    deduped: false,
    issue: created,
    labelIds,
    relations,
    attachments,
    attachmentErrors,
    bodyWarnings: prepared?.warnings ?? [],
  };
}
