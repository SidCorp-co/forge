import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import { ISSUE_ADMIT_PERMISSION, ISSUE_INITIAL_STATUSES } from '@forge/contracts/issue-machine';
import type { IssueCreateRefusalCode } from '@forge/contracts/issues';
import type { WrittenLang } from '@forge/contracts/written-lang';
import { eq } from 'drizzle-orm';
import type { BodyFormat } from '../body/formats.js';
import { prepareBody } from '../body/prepare.js';
import { currentPatScope } from '../credentials/pat-scope.js';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issueLabels, issues } from '../db/schema.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { RefusalError, refuser } from '../lib/refusal.js';
import { writtenLangFor } from '../lib/written-lang.js';
import { emitEvent } from '../outbox/index.js';
import { actorFor, permissionRefusalFor, projectResource } from '../permissions/index.js';
import type { Actor } from './activity.js';
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
import { scrubIssueText } from './patch-fields.js';
import { chatDoorOfToken } from './ports.js';
import {
  type AppliedIssueRelation,
  type IssueRelationInput,
  type PendingIssueRelation,
  writeIssueRelations,
} from './relations-service.js';
import { leaseWriteTakes } from './session-claim.js';
import { splitSessionContext, writeSplitSessionContext } from './work-state.js';

const refuse = refuser<IssueCreateRefusalCode>('ISSUE_CREATE_REFUSED');

/**
 * The only statuses an issue may be born at (`ISSUE_MACHINE.initial`): `open` for an actor holding
 * `issues.admit`, `draft` otherwise. Every other status change goes through the transition surface
 * so the state machine and activity log run.
 */
const CREATE_ENTRY_STATUSES = ISSUE_INITIAL_STATUSES;

type CreateEntryStatus = (typeof CREATE_ENTRY_STATUSES)[number];

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
  /** The language the title and body are written in, as the writer declared it; absent, the writer's own (`writtenLangFor`). */
  writtenLang?: WrittenLang | null | undefined;
};

/**
 * Who is creating. `createdVia` is the channel the origin classifier reads
 * (`creator.ts`), so it must name the real transport, never a default.
 */
type IssueCreateWriter = {
  createdById: string;
  /** The paired box whose credential files it, or null for an account's own write. */
  createdByDeviceId: string | null;
  createdVia: IssueCreatedVia;
  actor: Actor;
  /** The schedule fire whose session or inline run files it; absent for any other create. */
  scheduleRunId?: string | null;
};

type IssueCreateRow = typeof issues.$inferSelect;

/** The channel column's own union — a create must name a real transport. */
type IssueCreatedVia = NonNullable<IssueCreateRow['createdVia']>;

type CreateIssueResult =
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
 * The one insert into `issues`, inside the caller's transaction, with its `issue.created` outbox
 * event in that same transaction: a write that files issues as the effect of another act (a
 * feedback route, an accepted breakdown) commits the issue and its event together.
 */
export async function insertIssueRow(
  tx: Tx,
  values: typeof issues.$inferInsert,
  by: { actor: Actor; labelIds?: readonly string[] },
): Promise<IssueCreateRow> {
  await refuseChatDoorFiling();
  // the language its title and body were written in: the caller's where it copies them from a row
  // that holds one, else the writer's (`writtenLangFor`)
  const writtenLang =
    values.writtenLang !== undefined
      ? values.writtenLang
      : await writtenLangFor(
          { userId: by.actor.type === 'user' ? by.actor.id : null, agency: by.actor.agency },
          values.projectId,
          null,
          tx,
          [values.title, values.description].join('\n'),
        );
  const [inserted] = await tx
    .insert(issues)
    .values({ ...values, writtenLang })
    .returning();
  if (!inserted) throw new Error('issues: insert returned no row');
  await emitEvent(tx, 'issue.created', {
    issueId: inserted.id,
    projectId: inserted.projectId,
    actor: by.actor,
    status: inserted.status as IssueStatus,
    snapshot: {
      title: inserted.title,
      description: inserted.description,
      descriptionFormat: inserted.descriptionFormat,
      priority: inserted.priority,
      category: inserted.category,
      reportedBy: inserted.reportedBy,
      assigneeId: inserted.assigneeId,
      labels: [...(by.labelIds ?? [])],
    },
  });
  return inserted;
}

const CHAT_DOOR_SAYS = {
  'assistant-turn': 'the assistant answering in a conversation',
  'box-session':
    'a chat session on a paired box (Agent mode, the Agents screen or a room escalation)',
  agreement: 'the write of one record a person agreed to in a chat',
} as const;

/**
 * No chat door files an issue (owner ruling 2026-10-08): a person's report or wish enters as
 * Feedback or a Requirement, and issues are produced from those by triage or breakdown. Read from
 * the credential this request arrived on, so the assistant's `forge` CLI, its in-process tools and
 * an Agent-mode shell's `forge-runner api` all meet it, whatever route reaches the insert.
 */
async function refuseChatDoorFiling(): Promise<void> {
  const scope = currentPatScope();
  if (!scope) return;
  const chat = await chatDoorOfToken(scope.tokenId);
  if (!chat) return;
  throw refuse(
    'CHAT_FILES_FEEDBACK_NOT_ISSUES',
    `this credential belongs to ${CHAT_DOOR_SAYS[chat.door]}, and a chat files no issue: issues come from requirement breakdown or feedback triage. Record a problem or a wish as Feedback (\`POST /api/projects/:id/feedback\`, kind bug | change_request | idea | question, linked to the requirement it touches) or draft a Requirement (\`POST /api/projects/:id/requirements\`) or a revision of one (\`POST /api/projects/:id/requirements/REQ-n/revisions\`), after the person confirms.`,
  );
}

/** `open` needs `issues.admit`: named, it is refused without it; unnamed, the issue is born at `draft`. */
async function birthStatus(
  projectId: string,
  userId: string,
  named: CreateEntryStatus | undefined,
): Promise<CreateEntryStatus> {
  if (named === 'draft') return 'draft';
  const denied = await permissionRefusalFor(
    actorFor(userId),
    ISSUE_ADMIT_PERMISSION,
    projectResource(projectId),
    'filing an issue at `open`',
  );
  if (!denied) return 'open';
  if (named === undefined) return 'draft';
  throw new RefusalError(
    [
      {
        ...denied,
        detail: `${denied.detail} File it at \`draft\` instead; a holder of ${ISSUE_ADMIT_PERMISSION} promotes it.`,
      },
    ],
    denied.code,
  );
}

type Deduped = Extract<CreateIssueResult, { deduped: true }>;

function refuseBirthStatus(status: string | undefined): void {
  if (status === undefined || (CREATE_ENTRY_STATUSES as readonly string[]).includes(status)) return;
  throw refuse(
    'INVALID_STATUS',
    `an issue is born at ${CREATE_ENTRY_STATUSES.map((st) => `\`${st}\``).join(' or ')}, not \`${status}\`; every other status is reached by a transition`,
    '/status',
  );
}

/** A detector key already claimed answers the issue holding it instead of filing a second. */
async function dedupeByDetectorKey(
  projectId: string,
  detectorKey: string,
): Promise<Deduped | null> {
  if (!isValidDetectorKey(detectorKey)) {
    throw refuse(
      'INVALID_DETECTOR_KEY',
      `detectorKey \`${detectorKey}\` is not a detector key: lowercase slash-separated slugs, at most 120 characters (e.g. \`doc-drift/architecture\`)`,
      '/detectorKey',
    );
  }
  const { existingIssueId } = await claimDetectorKey(projectId, detectorKey);
  if (!existingIssueId) return null;
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
      ? formatIssueRef(await activeIssuePrefix(projectId), live.issSeq)
      : null,
    existingIssueStatus: live?.status ?? null,
  };
}

type Birth = {
  input: CreateIssueInput;
  writer: IssueCreateWriter;
  status: CreateEntryStatus;
  labelIds: ResolvedLabelAttach[];
  prepared: ReturnType<typeof prepareBody> | null;
  detectorKey: string | null;
  level: SensitiveDataLevel;
};

/** The row, its criteria, work state, labels and relations, in one transaction. */
async function writeBirth(tx: Tx, birth: Birth) {
  const { input, writer, labelIds, prepared } = birth;
  const split =
    input.sessionContext === undefined ? null : splitSessionContext(input.sessionContext);
  const inserted = await insertIssueRow(
    tx,
    {
      projectId: input.projectId,
      ...scrubIssueText(birth.level, {
        title: input.title,
        description: prepared ? prepared.body : (input.description ?? null),
      }),
      descriptionFormat: prepared?.format ?? 'markdown',
      status: birth.status as IssueStatus,
      priority: (input.priority ?? 'medium') as IssueCreateRow['priority'],
      category: input.category ?? null,
      complexity: (input.complexity ?? null) as IssueCreateRow['complexity'],
      reportedBy: input.reportedBy ?? null,
      assigneeId: input.assigneeId ?? null,
      createdById: writer.createdById,
      createdByDeviceId: writer.createdByDeviceId,
      createdVia: writer.createdVia,
      scheduleRunId: writer.scheduleRunId ?? null,
      detectorKey: birth.detectorKey,
      plan: input.plan ?? null,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      sessionContext: (split?.rest ?? null) as IssueCreateRow['sessionContext'],
      releaseNotes: (input.releaseNotes ?? null) as IssueCreateRow['releaseNotes'],
      ...(input.writtenLang ? { writtenLang: input.writtenLang } : {}),
    },
    { actor: writer.actor, labelIds: labelIds.map((l) => l.labelId) },
  );
  if (inserted.acceptanceCriteria) {
    await syncCriteriaFromText(tx, inserted.id, inserted.acceptanceCriteria);
  }
  // ISS-54 — the lease, branch and head a `sessionContext` names belong to the work state
  // (`work-state.ts:splitSessionContext`), until forge-plugin moves to the 10-status model.
  if (split && (split.lease.present || split.branch !== null || split.headSha !== null)) {
    await writeSplitSessionContext(tx, inserted.id, split);
  }
  if (labelIds.length > 0) {
    await tx
      .insert(issueLabels)
      .values(
        labelIds.map((l) => ({ issueId: inserted.id, labelId: l.labelId, isPrimary: l.isPrimary })),
      );
  }
  const pendingRelations = await writeIssueRelations(
    { actor: writer.actor, createdById: writer.createdById },
    input.projectId,
    inserted.id,
    input.relations,
    tx,
  );
  // An issue filed with a live lease is claimed at birth, so the edges filed with it are read
  // before the claim stands (issues/blocked-by.ts:refuseHeldTake).
  if (split?.lease.present && leaseWriteTakes(null, split.lease.value, new Date())) {
    await refuseHeldTake(tx, inserted.id, 'filing it with a live lease');
  }
  return { created: inserted, pendingRelations };
}

export async function createIssue(
  input: CreateIssueInput,
  writer: IssueCreateWriter,
): Promise<CreateIssueResult> {
  await refuseChatDoorFiling();
  refuseBirthStatus(input.status);
  const status = await birthStatus(
    input.projectId,
    writer.createdById,
    input.status as CreateEntryStatus | undefined,
  );
  const decodedAttachments: DecodedAttachment[] = input.attachments?.length
    ? decodeAndValidateAttachments([...input.attachments])
    : [];
  const labelIds = input.labels?.length
    ? await resolveLabelIdsForWrite(input.projectId, input.labels)
    : [];
  const prepared =
    typeof input.description === 'string' && input.description.trim().length > 0
      ? prepareBody({ raw: input.description, format: input.descriptionFormat })
      : null;
  const detectorKey = input.detectorKey ?? null;
  const level = await dataPolicyOf(input.projectId);
  if (detectorKey) {
    const deduped = await dedupeByDetectorKey(input.projectId, detectorKey);
    if (deduped) return deduped;
  }

  const { created, pendingRelations } = await db.transaction((tx) =>
    writeBirth(tx, { input, writer, status, labelIds, prepared, detectorKey, level }),
  );

  const persisted = decodedAttachments.length
    ? await persistDecodedIssueAttachments(
        created.id,
        decodedAttachments,
        writer.createdById,
        writer.actor.agency,
      )
    : { persisted: [], errors: [] };

  return {
    deduped: false,
    issue: created,
    labelIds,
    relations: pendingRelations.map((p: PendingIssueRelation) => p.applied),
    attachments: persisted.persisted,
    attachmentErrors: persisted.errors,
    bodyWarnings: prepared?.warnings ?? [],
  };
}
