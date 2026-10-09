// Recording one verdict on a live criterion: the identity it was judged against, resolved and
// refused by name, the row, and its kernel record.

import type { CriterionClass, CriterionJudge } from '@forge/contracts/issue-design';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import {
  criterionVerdicts,
  issueCriteria,
  type VerdictValue,
} from '../../db/schema-issue-criteria.js';
import { projectWorkflowDesigns } from '../../db/schema-workflows.js';
import { RefusalError } from '../../lib/refusal.js';
import { contractLookup } from '../../messaging/verdict-contract.js';
import { designLookup } from '../../messaging/verdict-design.js';
import { emitEvent } from '../../outbox/index.js';
import type { Actor } from '../activity.js';
import { criterionRoutesOf } from '../design-record.js';
import { readProjectDocument } from '../ports.js';
import type { RecordEventField } from '../record-events/store.js';
import { writeKernelRecord } from '../record-events/store.js';
import { probeNote } from './probe-rules.js';
import { probeOfVerdict } from './probes.js';
import { liveRows } from './store.js';
import {
  corroborationOf,
  type DraftReader,
  environmentFault,
  readSourceDrafts,
} from './storefront-draft.js';
import {
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
  ['storefrontWorkflowId', 'storefront-workflow'],
  ['storefrontDraftVersion', 'draft-version'],
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
  const reason = draft.reason?.trim();
  if (reason) fields.push({ key: 'why', value: reason });
  for (const cited of draft.evidence) fields.push({ key: 'evidence', value: cited });
  return fields;
}

const VERDICT_PATHS: Partial<Record<VerdictRefusal['code'], string>> = {
  VERDICT_JUDGED_BY_REVIEW: '/judge',
  VERDICT_JUDGED_BY_QA: '/judge',
  VERDICT_VALUE_UNKNOWN: '/verdict',
  VERDICT_SKIP_REASON_REQUIRED: '/reason',
  VERDICT_CRITERION_UNKNOWN: '/criterion',
};

/** A verdict refused by name, in the envelope both doors answer. */
function verdictRefused(refusal: VerdictRefusal): RefusalError {
  return new RefusalError(
    [
      {
        code: refusal.code,
        path: VERDICT_PATHS[refusal.code] ?? '/identity',
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
  const workflowId = identity.workflowId.trim();
  const reading = (await readDraft(document, [workflowId])).get(workflowId) ?? {
    kind: 'unreadable',
    detail: `the draft reader answered no reading of workflow \`${workflowId}\``,
  };
  const found = corroborationOf(identity, reading);
  return {
    identityKind: 'storefront_draft',
    storefrontWorkflowId: workflowId,
    storefrontDraftVersion: identity.draftVersion.trim(),
    storefrontEnvironment: environment,
    corroboration: found.corroboration,
    corroborationNote: found.note,
  };
}

/** The identity columns a draft writes, the design resolved to its workflow row. */
async function identityColumns(
  tx: Tx,
  projectId: string,
  draft: VerdictDraft,
  readDraft: DraftReader,
): Promise<VerdictColumns> {
  const identity = draft.identity;
  if (identity === null) return {};
  switch (identity.kind) {
    case 'storefront_draft':
      return storefrontColumns(projectId, draft.criterion, identity, readDraft);
    case 'commit':
      return { identityKind: 'commit', commitSha: identity.sha.trim().toLowerCase() };
    case 'runtime':
      return { identityKind: 'runtime', runtimeRef: identity.ref.trim().toLowerCase() };
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

/** Insert one verdict, refused by name where the draft, its criterion or its design is wrong. */
export async function recordVerdict(
  tx: Tx,
  args: {
    issue: { id: string; projectId: string };
    draft: VerdictDraft;
    author: VerdictAuthor;
    commentId?: string | null;
    readDraft?: DraftReader;
  },
): Promise<{ id: string }> {
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
  const identity = await identityColumns(
    tx,
    issue.projectId,
    draft,
    args.readDraft ?? readSourceDrafts,
  );
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
    })
    .returning({ id: criterionVerdicts.id });
  if (!row) throw new Error('criterion_verdicts insert returned no row');
  await writeKernelRecord(tx, {
    issueId: issue.id,
    actor: verdictActor(author),
    kind: 'verdict',
    fields: [
      ...verdictRecordFields({ id: row.id, draft, identity }),
      { key: 'judge', value: judge },
      ...probeField(draft.verdict, route?.class ?? null, probeId),
    ],
    commentId: args.commentId ?? null,
  });
  // a verdict against a commit changes what a release page carrying the issue may claim (REQ-40 BC-13)
  if (identity.identityKind === 'commit' && identity.commitSha) {
    await emitEvent(tx, 'verdict.recorded', {
      projectId: issue.projectId,
      issueId: issue.id,
      verdictId: row.id,
      commitSha: identity.commitSha,
    });
  }
  return row;
}
