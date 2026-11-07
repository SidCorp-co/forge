// Recording one verdict on a live criterion: the identity it was judged against, resolved and
// refused by name, the row, and its kernel record.

import type { CriterionClass, CriterionJudge } from '@forge/contracts/issue-design';
import type { ActorAgency } from '@forge/contracts/permissions';
import { type ReleaseIdentityFault, releaseIdentityOf } from '@forge/contracts/released-line';
import type { NotCounted } from '@forge/contracts/verified-rule';
import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import {
  criterionVerdicts,
  issueCriteria,
  type VerdictValue,
} from '../../db/schema-issue-criteria.js';
import { projectWorkflowDesigns } from '../../db/schema-workflows.js';
import { contractLookup } from '../../messaging/verdict-contract.js';
import { designLookup } from '../../messaging/verdict-design.js';
import { emitEvent } from '../../outbox/index.js';
import type { Actor } from '../activity.js';
import { criterionRoutesOf } from '../design-record.js';
import { readProjectDocument } from '../ports.js';
import type { RecordEventField } from '../record-events/store.js';
import { writeKernelRecord } from '../record-events/store.js';
import { releasedLineOf, releaseVersionOf } from '../released-line-reads.js';
import { clipFault } from './clip-citation.js';
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
import { countingOfOne } from './verdict-counting.js';
import {
  storefrontPartsOf,
  type VerdictDraft,
  type VerdictIdentity,
  type VerdictRefusal,
  verdictDraftFault,
} from './verdict-input.js';
import { offLandingFault } from './verdict-landing.js';
import { verdictRefused } from './verdict-refused.js';
import { repeatedVerdict } from './verdict-repeat.js';
import { declaredRunOf, judgeDoors, judgeRoleFault } from './verdict-role.js';

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
  ['releaseVersion', 'release'],
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

// this door's name for each fault the shared release rule reads; keyed on its declared type, so a
// fault the rule gains and this door does not name fails the typecheck rather than passing unnamed
const RELEASE_REFUSALS = {
  shape: 'VERDICT_RELEASE_SHAPE',
  unused: 'VERDICT_RELEASE_UNUSED',
  unknown: 'VERDICT_RELEASE_UNKNOWN',
} as const satisfies Record<ReleaseIdentityFault, VerdictRefusal['code']>;

/**
 * A verdict judged on a release (ISS-900): accepted only where the project's production names no
 * commit it serves, at a version the project recorded as shipped, by the rule a requirement's verdict
 * door asks too (`@forge/contracts/released-line:releaseIdentityOf`). Nothing reads production.
 */
async function releaseColumns(
  projectId: string,
  criterion: number,
  sent: string,
): Promise<VerdictColumns> {
  const line = await releasedLineOf(projectId);
  const read = releaseIdentityOf(`criterion ${criterion}`, sent, line, releaseVersionOf);
  if ('fault' in read) {
    throw verdictRefused({
      code: RELEASE_REFUSALS[read.fault],
      criterion,
      detail: read.detail,
      path: read.path,
    });
  }
  return { identityKind: 'release', releaseVersion: read.version };
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
    case 'commit': {
      const sha = identity.sha.trim().toLowerCase();
      const off = await offLandingFault(tx, issue, draft.criterion, sha);
      if (off) throw verdictRefused(off);
      return { identityKind: 'commit', commitSha: sha };
    }
    case 'release':
      return releaseColumns(projectId, draft.criterion, identity.version);
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
        detail: `criterion ${criterion} is a code property in the issue's design, so the review judges it against the diff, not QA on the running build. A run declared \`--role reviewer\` records it (over an issue that is closed too, carried untaken): through its review (\`POST /api/issues/:id/review\`) while the issue is open, or with ${judgeDoors('review')} and its \`run\`. Or reclass it in the design (PUT /api/issues/:id/design)`,
      }
    : {
        code: 'VERDICT_JUDGED_BY_QA',
        criterion,
        detail: `criterion ${criterion} is observable on the running build in the issue's design, so QA judges it there, not the review. A run declared \`--role qa\` records it as QA's, with ${judgeDoors('qa')} (or no judge at all), or reclass it in the design (PUT /api/issues/:id/design)`,
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

/**
 * Insert one verdict, refused by name where the draft, its criterion or its design is wrong. It
 * answers, by name, where the verdict is kept and will never count (`notCounted`), and marks a
 * builder's pass that counts only under the cutover (`countedUnderCutover`). A run sending its own
 * latest verdict on the criterion again, word for word, is answered that row, `duplicate`, and
 * nothing is written (`verdict-repeat.ts`).
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
    /**
     * Whose judgement a draft naming no `judge` is: QA's (the REST door's documented default), or the
     * recording run's own role's, as a comment's verdict fence reads (ISS-1021), QA's where that run
     * judges as no role.
     */
    omittedJudge?: 'qa' | 'run-role';
  },
): Promise<{
  id: string;
  /** True where this run already holds this very verdict on the criterion, answered and not written. */
  duplicate: boolean;
  notCounted: NotCounted | null;
  countedUnderCutover: boolean;
}> {
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
  // the recording run is read before the judge, which a fence naming none takes from its role; a
  // run that may not record is still refused where it always was, after the criterion's own faults
  const recording = await recordingSessionOf(tx, {
    issue,
    criterion: draft.criterion,
    author,
    run: args.run,
    runSession: args.runSession,
  });
  const declared = recording.ok ? await declaredRunOf(tx, recording.session) : null;
  const judge =
    draft.judge ?? (args.omittedJudge === 'run-role' ? (declared?.judge ?? 'qa') : 'qa');
  const route = (await criterionRoutesOf([criterion.id], tx)).get(criterion.id) ?? null;
  if (route !== null && route.judge !== judge) {
    throw verdictRefused(misrouted(draft.criterion, route.judge));
  }
  const identity = await identityColumns(tx, issue, draft, args.readDraft ?? readSourceDrafts);
  const noClip = await clipFault(tx, issue.id, draft, route?.class ?? null);
  if (noClip) throw verdictRefused(noClip);
  if (!recording.ok) throw verdictRefused(recording.refusal);
  const runSessionId = recording.session;
  const notOwn = judgeRoleFault(declared, {
    criterion: draft.criterion,
    judge,
    routed: route?.judge ?? null,
  });
  if (notOwn) throw verdictRefused(notOwn);
  const repeat = { criterionId: criterion.id, runSessionId, draft, identity, judge };
  const repeated = await repeatedVerdict(tx, repeat);
  if (repeated) {
    return {
      id: repeated,
      duplicate: true,
      ...(await countingOfOne(tx, issue.projectId, { id: repeated, verdict: draft.verdict })),
    };
  }
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
      covers: draft.covers && draft.covers.length > 0 ? [...new Set(draft.covers)] : null,
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
  // read through the same builder rule every count of proof reads, as the criteria read answers it
  const { notCounted, countedUnderCutover: underCutover } = await countingOfOne(
    tx,
    issue.projectId,
    { id: row.id, verdict: draft.verdict },
  );
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
  // a verdict against a commit, or on the running build of one (a release proven on its testing
  // environment, REQ-36 BC-18), changes what a release page carrying the issue may claim (REQ-40
  // BC-13), and a fail sends the issue that owns the work back to reopen, whichever door recorded it
  // (REQ-74 BC-3)
  const commitSha = identity.identityKind === 'commit' ? (identity.commitSha ?? null) : null;
  const runtimeRef = identity.identityKind === 'runtime' ? (identity.runtimeRef ?? null) : null;
  const failed =
    draft.verdict === 'fail'
      ? {
          criterion: draft.criterion,
          requirement: null,
          reason: draft.reason?.trim() || null,
          authorUserId: author.userId,
          authorDeviceId: author.deviceId,
          agency: author.agency,
        }
      : null;
  if (commitSha || runtimeRef || failed) {
    await emitEvent(tx, 'verdict.recorded', {
      projectId: issue.projectId,
      issueId: issue.id,
      verdictId: row.id,
      commitSha,
      runtimeRef,
      failed,
    });
  }
  return { id: row.id, duplicate: false, notCounted, countedUnderCutover: underCutover };
}
