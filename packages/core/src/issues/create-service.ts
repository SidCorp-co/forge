/**
 * The one create path for `issues`.
 *
 * ISS-889 — REST (`routes.ts`) and MCP (`forge-issues.ts`) each carried their
 * own `insert(issues)`, and the two had drifted: only MCP claimed a
 * `detectorKey`, resolved labels by name, or applied `relations`; only REST
 * wrapped the insert and its labels in one transaction, and persisted
 * attachments before the `issueCreated` emit rather than after it.
 *
 * This module owns the ordering and the domain rules. Authorization, request
 * validation and serialization stay at the transport edge — including the
 * MCP-only `markUntrusted` framing, which is deliberate (see the `cm:guard`
 * in `mcp/tools/forge-issues.ts`).
 */

import { eq } from 'drizzle-orm';
import type { BodyFormat } from '../body/formats.js';
import { prepareBody } from '../body/prepare.js';
import { db } from '../db/client.js';
import { type IssueStatus, issueLabels, issues } from '../db/schema.js';
import type { Actor } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import {
  type AttachmentErrorEntry,
  type Base64AttachmentInput,
  type DecodedAttachment,
  decodeAndValidateAttachments,
  type PersistedIssueAttachment,
  persistDecodedIssueAttachments,
} from './attachment-service.js';
import { claimDetectorKey, isValidDetectorKey } from './detector-key.js';
import { applyIntakeGate, finalizeIntake } from './intake-gate.js';
import { resolveLabelIdsForWrite } from './label-service.js';
import {
  type AppliedIssueRelation,
  flushIssueRelationEffects,
  type IssueRelationInput,
  type PendingIssueRelation,
  writeIssueRelations,
} from './relations-service.js';

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
  labels?: readonly string[] | undefined;
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
// cm:guard `createdVia` and `actor` must describe the SAME principal — `buildOriginCondition` splits the Backlog/Findings views on `created_via`, so a web create labelled `mcp` (or the reverse) files the issue under the wrong origin and it vanishes from the list its author is watching
export type IssueCreateWriter = {
  createdById: string;
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
      labelIds: string[];
      relations: AppliedIssueRelation[];
      attachments: PersistedIssueAttachment[];
      attachmentErrors: AttachmentErrorEntry[];
      /** What the body sanitizer removed from the description on the way in. */
      bodyWarnings: string[];
    };

// cm:edge ordering -> packages/core/src/jobs/dispatch-gates.ts — relations MUST commit before the `issueCreated` emit below, which synchronously triggers considerEnqueue→dispatch; an edge written after it is invisible to the L2 blocks-gate on the first tick and the dependent ships ahead of its blocker
// cm:guard decode attachments and resolve labels BEFORE the insert — both reject on bad input, and doing them after would leave a half-created issue with no files and no labels
// cm:edge lockstep -> packages/core/src/issues/routes.ts — the REST POST maps IssueCreateError / LabelResolutionError / AttachmentError to status codes
// cm:edge lockstep -> packages/core/src/mcp/tools/forge-issues.ts — same mapping on the MCP side, to its `CODE: message` string form
export async function createIssue(
  input: CreateIssueInput,
  writer: IssueCreateWriter,
): Promise<CreateIssueResult> {
  const requestedStatus = (input.status ?? 'open') as CreateEntryStatus;
  if (!(CREATE_ENTRY_STATUSES as readonly string[]).includes(requestedStatus)) {
    throw new IssueCreateError('INVALID_STATUS', requestedStatus);
  }

  // cm:why ISS-606 — a gated project parks every would-be `open` create at draft, so the status that lands is the gate's answer, not the caller's request
  const intake = await applyIntakeGate(input.projectId, requestedStatus as IssueStatus);

  let decodedAttachments: DecodedAttachment[] = [];
  if (input.attachments && input.attachments.length > 0) {
    decodedAttachments = decodeAndValidateAttachments([...input.attachments]);
  }

  const labelIds =
    input.labels && input.labels.length > 0
      ? await resolveLabelIdsForWrite(input.projectId, input.labels)
      : [];

  // cm:guard prepared BEFORE the transaction, for the same reason attachments and labels are: `prepareBody` REFUSES an invalid `forge-*` body, and refusing inside the transaction would leave the caller a rolled-back write instead of a 400 naming what to fix
  const prepared =
    typeof input.description === 'string' && input.description.trim().length > 0
      ? prepareBody({ raw: input.description, format: input.descriptionFormat })
      : null;

  const detectorKey = input.detectorKey ?? null;
  if (detectorKey) {
    if (!isValidDetectorKey(detectorKey)) {
      throw new IssueCreateError('INVALID_DETECTOR_KEY', detectorKey);
    }
    // cm:guard one live issue per detector — a recurring finding must land on the issue already tracking it, never as issue N+1
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
        existingIssueDisplayId: live ? `ISS-${live.issSeq}` : null,
        existingIssueStatus: live?.status ?? null,
      };
    }
  }

  // cm:guard the `blocks` edges land INSIDE this transaction with the issue row. Committing the issue first and writing edges after leaves a crash window in which the issue exists at its intake status carrying no blocker: `issueCreated` never fires, so nothing dispatches immediately, but the dispatcher also POLLS — the next tick picks up an `open` issue that looks unblocked and runs it ahead of the thing that was supposed to gate it. The record would say "not blocked" while the intent was blocked, which is exactly what VISION: state-never-lies forbids.
  const { created, pendingRelations } = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(issues)
      .values({
        projectId: input.projectId,
        title: input.title,
        description: prepared ? prepared.body : (input.description ?? null),
        descriptionFormat: prepared?.format ?? 'markdown',
        descriptionTemplate: prepared?.template ?? null,
        status: intake.status,
        priority: (input.priority ?? 'medium') as IssueCreateRow['priority'],
        category: input.category ?? null,
        complexity: (input.complexity ?? null) as IssueCreateRow['complexity'],
        reportedBy: input.reportedBy ?? null,
        assigneeId: input.assigneeId ?? null,
        createdById: writer.createdById,
        createdVia: writer.createdVia,
        detectorKey,
        plan: input.plan ?? null,
        acceptanceCriteria: input.acceptanceCriteria ?? null,
        sessionContext: (input.sessionContext ?? null) as IssueCreateRow['sessionContext'],
        releaseNotes: (input.releaseNotes ?? null) as IssueCreateRow['releaseNotes'],
      })
      .returning();
    if (!inserted) throw new Error('issues: insert returned no row');

    if (labelIds.length > 0) {
      await tx
        .insert(issueLabels)
        .values(labelIds.map((labelId) => ({ issueId: inserted.id, labelId })));
    }
    const pendingRelations = await writeIssueRelations(
      { actor: writer.actor, createdById: writer.createdById },
      input.projectId,
      inserted.id,
      input.relations,
      tx,
    );
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

  // cm:guard finalizeIntake runs ONLY when the gate actually parked the issue — it labels and notifies the owner that something is waiting, and firing it on an ungated create pages them for nothing
  if (intake.gated) await finalizeIntake(input.projectId, { id: created.id, title: created.title });

  // cm:guard the effects still run BEFORE `issueCreated`, unchanged: that hook is what wakes dispatch, and the dependent's health must already be published when it does.
  await flushIssueRelationEffects(
    { actor: writer.actor, createdById: writer.createdById },
    input.projectId,
    pendingRelations,
  );
  const relations = pendingRelations.map((p: PendingIssueRelation) => p.applied);

  await hooks.emit('issueCreated', {
    issueId: created.id,
    projectId: created.projectId,
    actor: writer.actor,
    status: created.status as IssueStatus,
    snapshot: {
      title: created.title,
      description: created.description,
      // cm:edge contract -> packages/core/src/memory/indexer.ts — the indexer embeds `snapshot.description` through the body projection and needs the format to pick a path; without it an `html` component body is embedded as raw markup and the vector describes the template, not the problem
      descriptionFormat: created.descriptionFormat,
      priority: created.priority,
      category: created.category,
      reportedBy: created.reportedBy,
      assigneeId: created.assigneeId,
      labels: labelIds,
    },
  });

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
