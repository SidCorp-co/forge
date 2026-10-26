// Recording one verdict on a live criterion: the identity it was judged against, resolved and
// refused by name, the row, and its kernel record.

import type { CriterionClass, CriterionJudge } from '@forge/contracts/issue-design';
import type { ActorAgency } from '@forge/contracts/permissions';
import { RELEASE_CLIP_MIMES } from '@forge/contracts/release-page';
import { countedUnderCutover, type NotCounted, notCountedOf } from '@forge/contracts/verified-rule';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import {
  criterionVerdicts,
  issueCriteria,
  type VerdictValue,
} from '../../db/schema-issue-criteria.js';
import { issueAttachments } from '../../db/schema-issues.js';
import { projectWorkflowDesigns } from '../../db/schema-workflows.js';
import { RefusalError } from '../../lib/refusal.js';
import { contractLookup } from '../../messaging/verdict-contract.js';
import { designLookup } from '../../messaging/verdict-design.js';
import { emitEvent } from '../../outbox/index.js';
import type { Actor } from '../activity.js';
import { verdictByBuilderSql } from '../built-by.js';
import { criterionRoutesOf } from '../design-record.js';
import { readJudge, readProjectDocument } from '../ports.js';
import type { RecordEventField } from '../record-events/store.js';
import { writeKernelRecord } from '../record-events/store.js';
import { probeNote } from './probe-rules.js';
import { probeOfVerdict } from './probes.js';
import { recordingSessionOf } from './recording-session.js';
import { liveRows } from './store.js';
import {
  corroborationOf,
  type DraftReader,
  environmentFault,
  readSourceDrafts,
} from './storefront-draft.js';
import { unobservedRuntimeFault } from './unobserved-runtime.js';
import { keepFailAsCorrection } from './verdict-correction.js';
import {
  storefrontPartsOf,
  type VerdictDraft,
  type VerdictIdentity,
  type VerdictRefusal,
  verdictDraftFault,
} from './verdict-input.js';

type VerdictColumns = Partial<typeof criterionVerdicts.$inferInsert>;

function verdictActor(author: VerdictAuthor): Actor {
  if (author.deviceId) return { type: 'device', id: author.deviceId, agency: author.agency };
  if (author.userId) return { type: 'user', id: author.userId, agency: author.agency };
  throw new Error('a verdict names its author: an account or a device, and this one names neither');
}

const IDENTITY_FIELDS: ReadonlyArray<readonly [keyof VerdictColumns, string]> = [
  ['identityKind', 'identity'],
  ['commitSha', 'commit'],
  ['runtimeRef', 'runtime'],
  ['designWorkflowId', 'design-workflow'],
  ['designRevision', 'design-revision'],
  ['contractRef', 'contract'],
  ['contractVersion', 'contract-version'],
  ['storefrontEnvironment', 'environment'],
  ['corroboration', 'corroboration'],
];

function verdictRecordFields(args: {
  id: string;
  draft: VerdictDraft;
  identity: VerdictColumns;
}): RecordEventField[] {
  const { id, draft, identity } = args;
  const fields: RecordEventField[] = [
    { key: 'verdict-id', value: id },
    { key: 'criterion', value: String(draft.criterion) },
    { key: 'verdict', value: draft.verdict },
  ];
  for (const [column, key] of IDENTITY_FIELDS) {
    const value = identity[column];
    if (value !== undefined && value !== null) fields.push({ key, value: String(value) });
  }
  // one field per workflow draft judged, in the order written (ISS-613)
  for (const part of identity.storefrontDrafts ?? []) {
    fields.push({
      key: 'storefront-draft',
      value: `${part.workflowId}@draft:${part.draftVersion}`,
    });
  }
  const reason = draft.reason?.trim();
  if (reason) fields.push({ key: 'why', value: reason });
  const withoutClip = draft.withoutClip?.trim();
  if (withoutClip) fields.push({ key: 'without-clip', value: withoutClip });
  for (const cited of draft.evidence) fields.push({ key: 'evidence', value: cited });
  return fields;
}

const VERDICT_PATHS: Partial<Record<VerdictRefusal['code'], string>> = {
  VERDICT_JUDGED_BY_REVIEW: '/judge',
  VERDICT_JUDGED_BY_QA: '/judge',
  VERDICT_VALUE_UNKNOWN: '/verdict',
  VERDICT_SKIP_REASON_REQUIRED: '/reason',
  VERDICT_CLIP_REQUIRED: '/evidence',
  VERDICT_CRITERION_UNKNOWN: '/criterion',
  VERDICT_RUN_UNKNOWN: '/run',
  VERDICT_SESSION_NOT_ADMITTED: '/run',
};

/** The judgements of an observable criterion that owe a clip: every one but a skip, which judged nothing. */
const CLIPPED_VERDICTS: ReadonlySet<string> = new Set(['pass', 'short', 'fail']);

/**
 * REQ-40 BC-4: a judgement of a criterion the design classes observable cites a screen clip of the
 * run that shows it (a WebM or MP4 attached to the issue, named in `evidence`), so a release page has
 * something to show; one judged without a clip says why in `withoutClip`. A verdict's `reason` is
 * what it found, which every judge writes, so it never stands in for that why.
 */
async function clipFault(
  tx: Tx,
  issueId: string,
  draft: {
    criterion: number;
    verdict: string;
    evidence: readonly string[];
    withoutClip?: string | null | undefined;
  },
  criterionClass: CriterionClass | null,
): Promise<VerdictRefusal | null> {
  if (criterionClass !== 'observable' || !CLIPPED_VERDICTS.has(draft.verdict)) return null;
  if (draft.withoutClip?.trim()) return null;
  const cited = draft.evidence.map((e) => e.trim()).filter(Boolean);
  if (cited.length > 0) {
    const clips = await tx
      .select({ name: issueAttachments.name })
      .from(issueAttachments)
      .where(
        and(
          eq(issueAttachments.issueId, issueId),
          inArray(issueAttachments.name, cited),
          inArray(issueAttachments.mime, [...RELEASE_CLIP_MIMES]),
        ),
      )
      .limit(1);
    if (clips.length > 0) return null;
  }
  return {
    code: 'VERDICT_CLIP_REQUIRED',
    criterion: draft.criterion,
    detail: `criterion ${draft.criterion} is observable on the running build, and a \`${draft.verdict}\` on it cites a screen clip of the run that shows it: record one (the project's knowledge names its recorder), attach the WebM or MP4 to the issue (\`POST /api/issues/:id/attachments\`, field \`file\`) and name it in \`evidence\`; or say why it was judged without one in \`withoutClip\` (a \`without-clip\` line in a record). \`reason\` says what was found and never stands in for it`,
  };
}

/** A verdict refused by name, in the envelope both doors answer. */
function verdictRefused(refusal: VerdictRefusal): RefusalError {
  return new RefusalError(
    [
      {
        code: refusal.code,
        path: refusal.path ?? VERDICT_PATHS[refusal.code] ?? '/identity',
        detail: refusal.detail,
      },
    ],
    'VERDICT_REFUSED',
  );
}

export interface VerdictAuthor {
  readonly userId: string | null;
  readonly deviceId: string | null;
  readonly agency: ActorAgency;
}

async function storefrontColumns(
  projectId: string,
  criterion: number,
  identity: Extract<VerdictIdentity, { kind: 'storefront_draft' }>,
  readDraft: DraftReader,
): Promise<VerdictColumns> {
  const document = (await readProjectDocument(projectId))?.document ?? null;
  const environment = identity.environment.trim();
  const unknown = environmentFault(criterion, document, environment);
  if (unknown) throw verdictRefused(unknown);
  const parts = storefrontPartsOf(identity);
  const readings = await readDraft(
    document,
    parts.map((p) => p.workflowId),
  );
  const found = corroborationOf(parts, readings);
  return {
    identityKind: 'storefront_draft',
    storefrontDrafts: parts,
    storefrontEnvironment: environment,
    corroboration: found.corroboration,
    corroborationNote: found.note,
  };
}

/** The identity columns a draft writes, the design resolved to its workflow row. */
async function identityColumns(
  tx: Tx,
  issue: { id: string; projectId: string },
  draft: VerdictDraft,
  readDraft: DraftReader,
): Promise<VerdictColumns> {
  const { projectId } = issue;
  const identity = draft.identity;
  if (identity === null) return {};
  switch (identity.kind) {
    case 'storefront_draft':
      return storefrontColumns(projectId, draft.criterion, identity, readDraft);
    case 'commit':
      return { identityKind: 'commit', commitSha: identity.sha.trim().toLowerCase() };
    case 'runtime': {
      const ref = identity.ref.trim().toLowerCase();
      const unobserved = await unobservedRuntimeFault(issue, draft.criterion, ref);
      if (unobserved) throw verdictRefused(unobserved);
      return { identityKind: 'runtime', runtimeRef: ref };
    }
    case 'contract': {
      const [project = '', contract = ''] = identity.ref.trim().split('/');
      const held = await contractLookup(tx)(projectId, {
        project,
        contract,
        version: identity.version.trim(),
      });
      if (!held.named) {
        throw verdictRefused({
          code: 'VERDICT_CONTRACT_UNKNOWN',
          criterion: draft.criterion,
          detail: `criterion ${draft.criterion} names contract \`${identity.ref}@${identity.version}\`, which this issue's project (\`${held.projectSlug}\`) has not recorded; versions recorded: ${held.versions.join(', ') || 'none'}.`,
        });
      }
      return {
        identityKind: 'contract',
        contractRef: identity.ref.trim(),
        contractVersion: identity.version.trim(),
      };
    }
    case 'design': {
      const found = await designLookup(tx)(projectId, identity.workflow);
      if (
        found.kind === 'missing' ||
        found.design.projectId !== projectId ||
        !found.design.revisions.includes(identity.revision)
      ) {
        throw verdictRefused({
          code: 'VERDICT_DESIGN_UNKNOWN',
          criterion: draft.criterion,
          detail: `criterion ${draft.criterion} names design \`${identity.workflow}\` rev ${identity.revision}, which this issue's project does not hold${found.kind === 'found' ? ` (revisions held: ${found.design.revisions.join(', ')})` : ''}.`,
        });
      }
      // a verdict judged against a revision nobody approved would read as earned on a drawing the
      // approver never accepted (REQ-17 BC-6)
      const [approved] = await tx
        .select({ revision: projectWorkflowDesigns.revision })
        .from(projectWorkflowDesigns)
        .where(
          and(
            eq(projectWorkflowDesigns.workflowId, found.design.id),
            eq(projectWorkflowDesigns.revision, identity.revision),
            eq(projectWorkflowDesigns.decision, 'approve'),
          ),
        );
      if (!approved) {
        throw verdictRefused({
          code: 'VERDICT_DESIGN_UNAPPROVED',
          criterion: draft.criterion,
          detail: `criterion ${draft.criterion} names design \`${identity.workflow}\` rev ${identity.revision}, which was never approved; a verdict is judged against an approved revision.`,
        });
      }
      return {
        identityKind: 'design',
        designWorkflowId: found.design.id,
        designRevision: identity.revision,
      };
    }
  }
}

/**
 * A verdict recorded by the judge the criterion's class does not route to (REQ-36 BC-13): a code
 * property is the review's, judged against the diff; an observable criterion is QA's, judged on the
 * running build.
 */
function misrouted(criterion: number, routed: CriterionJudge): VerdictRefusal {
  return routed === 'review'
    ? {
        code: 'VERDICT_JUDGED_BY_REVIEW',
        criterion,
        detail: `criterion ${criterion} is a code property in the issue's design, so the review judges it against the diff, not QA on the running build. Record it as the review's (\`judge: "review"\`), or reclass it in the design (PUT /api/issues/:id/design)`,
      }
    : {
        code: 'VERDICT_JUDGED_BY_QA',
        criterion,
        detail: `criterion ${criterion} is observable on the running build in the issue's design, so QA judges it there, not the review. Record it as QA's (omit \`judge\`), or reclass it in the design (PUT /api/issues/:id/design)`,
      };
}

function probeField(
  verdict: string,
  criterionClass: CriterionClass | null,
  probeId: string | null,
): RecordEventField[] {
  const note = probeNote(verdict, criterionClass, probeId);
  return note ? [{ key: 'probe', value: note }] : [];
}

/** The run session recording a verdict, or the refusal naming why none may (`recording-session.ts`). */
async function recordingSession(
  tx: Tx,
  args: Parameters<typeof recordingSessionOf>[1],
): Promise<string | null> {
  const found = await recordingSessionOf(tx, args);
  if (!found.ok) throw verdictRefused(found.refusal);
  return found.session;
}

/**
 * Whether the verdict just written will never count, by name (contracts `verified-rule.ts:notCountedOf`),
 * or counts only under the builder-pass cutover: read through the same builder rule every count of
 * proof reads (`built-by.ts`).
 */
async function countingOf(
  tx: Tx,
  projectId: string,
  verdict: { id: string; value: string },
): Promise<{ notCounted: NotCounted | null; countedUnderCutover: boolean }> {
  if (verdict.value !== 'pass' && verdict.value !== 'short') {
    return { notCounted: null, countedUnderCutover: false };
  }
  const rows = (await tx.execute(sql`
    SELECT ${verdictByBuilderSql({
      issueId: sql`v.issue_id`,
      authorUser: sql`v.author_user_id`,
      authorDevice: sql`v.author_device_id`,
      at: sql`v.created_at`,
      runSession: sql`v.run_session_id`,
    })} AS by_builder, v.created_at AS recorded_at
      FROM criterion_verdicts v WHERE v.id = ${verdict.id}`)) as unknown as {
    by_builder: boolean | null;
    recorded_at: string | Date;
  }[];
  const judge = await readJudge(projectId);
  const read = {
    verdict: verdict.value,
    byBuilder: rows[0]?.by_builder === true,
    authored: true,
    recordedAt: rows[0]?.recorded_at ?? null,
  };
  return {
    notCounted: notCountedOf(read, judge),
    countedUnderCutover: countedUnderCutover(read, judge),
  };
}

/**
 * Insert one verdict, refused by name where the draft, its criterion or its design is wrong. It
 * answers, by name, where the verdict is kept and will never count (`notCounted`), and marks a
 * builder's pass that counts only under the cutover (`countedUnderCutover`).
 */
export async function recordVerdict(
  tx: Tx,
  args: {
    issue: { id: string; projectId: string };
    draft: VerdictDraft;
    author: VerdictAuthor;
    commentId?: string | null;
    readDraft?: DraftReader;
    /** The run the call names (the box's run id, or core's session or run id). */
    run?: string | undefined;
    /** The recording session a door already resolved; given, `run` is not read. */
    runSession?: string | null | undefined;
    /** False where the door moves the issue itself on a fail (a release's probe replay). */
    reopens?: boolean;
  },
): Promise<{ id: string; notCounted: NotCounted | null; countedUnderCutover: boolean }> {
  const { issue, draft, author } = args;
  const fault = verdictDraftFault(draft);
  if (fault) throw verdictRefused(fault);
  const [criterion] = await tx
    .select({ id: issueCriteria.id })
    .from(issueCriteria)
    .where(
      and(
        eq(issueCriteria.issueId, issue.id),
        eq(issueCriteria.n, draft.criterion),
        isNull(issueCriteria.retiredAt),
      ),
    )
    .limit(1);
  if (!criterion) {
    const live = await liveRows(tx, issue.id);
    throw verdictRefused({
      code: 'VERDICT_CRITERION_UNKNOWN',
      criterion: draft.criterion,
      detail: `this issue has no criterion ${draft.criterion}; its criteria are ${
        live.length === 0
          ? 'none — write them first (`PUT /api/issues/:id/criteria`, or numbered `acceptanceCriteria`)'
          : live
              .map((r) => r.n)
              .sort((a, b) => a - b)
              .join(', ')
      }.`,
    });
  }
  const judge = draft.judge ?? 'qa';
  const route = (await criterionRoutesOf([criterion.id], tx)).get(criterion.id) ?? null;
  if (route !== null && route.judge !== judge) {
    throw verdictRefused(misrouted(draft.criterion, route.judge));
  }
  const identity = await identityColumns(tx, issue, draft, args.readDraft ?? readSourceDrafts);
  const noClip = await clipFault(tx, issue.id, draft, route?.class ?? null);
  if (noClip) throw verdictRefused(noClip);
  const runSessionId = await recordingSession(tx, {
    issue,
    criterion: draft.criterion,
    author,
    run: args.run,
    runSession: args.runSession,
  });
  const probeId = await probeOfVerdict(tx, {
    issueId: issue.id,
    projectId: issue.projectId,
    criterion: { id: criterion.id, n: draft.criterion, class: route?.class ?? null },
    verdict: draft.verdict,
    probe: draft.probe ?? null,
  });
  const [row] = await tx
    .insert(criterionVerdicts)
    .values({
      criterionId: criterion.id,
      issueId: issue.id,
      verdict: draft.verdict as VerdictValue,
      reason: draft.reason?.trim() || null,
      ...identity,
      evidence: [...draft.evidence],
      authorUserId: author.userId,
      authorDeviceId: author.deviceId,
      authorAgency: author.agency,
      commentId: args.commentId ?? null,
      judge,
      probeId,
      runSessionId,
    })
    .returning({ id: criterionVerdicts.id });
  if (!row) throw new Error('criterion_verdicts insert returned no row');
  const { notCounted, countedUnderCutover: underCutover } = await countingOf(tx, issue.projectId, {
    id: row.id,
    value: draft.verdict,
  });
  await keepFailAsCorrection(tx, {
    issue,
    verdictId: row.id,
    criterion: draft.criterion,
    verdict: draft.verdict,
    reason: draft.reason?.trim() || null,
    author: { userId: author.userId, agency: author.agency },
  });
  await writeKernelRecord(tx, {
    issueId: issue.id,
    actor: verdictActor(author),
    kind: 'verdict',
    fields: [
      ...verdictRecordFields({ id: row.id, draft, identity }),
      { key: 'judge', value: judge },
      ...probeField(draft.verdict, route?.class ?? null, probeId),
      ...(runSessionId ? [{ key: 'run-session', value: runSessionId }] : []),
      ...(notCounted ? [{ key: 'not-counted', value: notCounted.code }] : []),
      ...(underCutover ? [{ key: 'counted-under-cutover', value: 'true' }] : []),
    ],
    commentId: args.commentId ?? null,
  });
  // a verdict against a commit changes what a release page carrying the issue may claim (REQ-40 BC-13),
  // and a fail sends the issue that owns the work back to reopen, whichever door recorded it (REQ-74 BC-3)
  const commitSha = identity.identityKind === 'commit' ? (identity.commitSha ?? null) : null;
  const failed =
    draft.verdict === 'fail' && args.reopens !== false
      ? {
          criterion: draft.criterion,
          requirement: null,
          reason: draft.reason?.trim() || null,
          authorUserId: author.userId,
          authorDeviceId: author.deviceId,
          agency: author.agency,
        }
      : null;
  if (commitSha || failed) {
    await emitEvent(tx, 'verdict.recorded', {
      projectId: issue.projectId,
      issueId: issue.id,
      verdictId: row.id,
      commitSha,
      failed,
    });
  }
  return { id: row.id, notCounted, countedUnderCutover: underCutover };
}
