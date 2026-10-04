/**
 * ISS-55 — reads and writes of `issue_criteria` and `criterion_verdicts`.
 *
 * Criteria are written whole (a plan's PUT, or a write of `acceptance_criteria` text): a criterion
 * whose number and statement are unchanged keeps its row, a reworded one is retired and re-added so
 * the verdicts on the old wording stop counting, and a removed one is retired. Verdicts are only
 * ever inserted; the latest per live criterion is the one the gate and the UI read.
 */

import type { CriteriaRefusalCode } from '@forge/contracts/issues';
import type { ActorAgency } from '@forge/contracts/permissions';
import type { VerdictCorroboration, VerdictDraftReading } from '@forge/contracts/verdict-identity';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import {
  criterionVerdicts,
  issueCriteria,
  type VerdictIdentityKind,
  type VerdictValue,
} from '../../db/schema-issue-criteria.js';
import { projectWorkflowDesigns } from '../../db/schema-workflows.js';
import { RefusalError, refuser } from '../../lib/refusal.js';
import { dbContractLookup } from '../../messaging/verdict-contract.js';
import { dbDesignLookup } from '../../messaging/verdict-design.js';
import { readProjectDocument } from '../ports.js';
import { writeKernelRecord } from '../record-events/store.js';
import {
  normalizeStatement,
  type ParsedCriterion,
  parseCriteriaText,
  renderCriteriaText,
} from './criteria-text.js';
import {
  corroborationOf,
  type DraftReader,
  environmentFault,
  readSourceDraft,
} from './storefront-draft.js';
import {
  type VerdictDraft,
  type VerdictIdentity,
  type VerdictRefusal,
  verdictDraftFault,
} from './verdict-input.js';
import { type VerdictColumns, verdictActor, verdictRecordFields } from './verdict-record.js';

const refuseCriteria = refuser<CriteriaRefusalCode>('CRITERIA_REFUSED');

const VERDICT_PATHS: Partial<Record<VerdictRefusal['code'], string>> = {
  VERDICT_VALUE_UNKNOWN: '/verdict',
  VERDICT_SKIP_REASON_REQUIRED: '/reason',
  VERDICT_CRITERION_UNKNOWN: '/criterion',
};

/** A verdict refused by name, in the envelope both doors answer. */
export function verdictRefused(refusal: VerdictRefusal): RefusalError {
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

// status-tuple: differs — not TERMINAL_FOR_DISPATCH: where verdicts were earned, so the wording is frozen
const LOCKED_STATUSES: ReadonlySet<string> = new Set(['awaiting_release', 'closed', 'dropped']);

export interface CriterionInput {
  readonly n: number;
  readonly statement: string;
  readonly requirementCriterionId?: string | null | undefined;
}

export interface LatestVerdict {
  readonly id: string;
  readonly verdict: VerdictValue;
  readonly reason: string | null;
  readonly identityKind: VerdictIdentityKind | null;
  readonly commitSha: string | null;
  readonly runtimeRef: string | null;
  readonly designWorkflowId: string | null;
  readonly designFlow: string | null;
  readonly designRevision: number | null;
  readonly contractRef: string | null;
  readonly contractVersion: string | null;
  readonly storefrontWorkflowId: string | null;
  readonly storefrontDraftVersion: string | null;
  readonly storefrontEnvironment: string | null;
  readonly corroboration: VerdictDraftReading | null;
  readonly corroborationNote: string | null;
  readonly evidence: readonly string[];
  readonly authorAgency: ActorAgency;
  readonly backfilled: boolean;
  readonly createdAt: string;
}

export interface CriterionWithVerdict {
  readonly id: string;
  readonly n: number;
  readonly statement: string;
  readonly position: number;
  readonly requirementCriterionId: string | null;
  readonly latest: LatestVerdict | null;
}

type LiveRow = { id: string; n: number; statement: string };

async function liveRows(tx: Tx, issueId: string): Promise<LiveRow[]> {
  return tx
    .select({ id: issueCriteria.id, n: issueCriteria.n, statement: issueCriteria.statement })
    .from(issueCriteria)
    .where(and(eq(issueCriteria.issueId, issueId), isNull(issueCriteria.retiredAt)));
}

/** Whether a desired set says the same thing as the live rows: same numbers, same statements. */
function unchanged(live: readonly LiveRow[], desired: readonly CriterionInput[]): boolean {
  if (live.length !== desired.length) return false;
  const byN = new Map(live.map((row) => [row.n, normalizeStatement(row.statement)]));
  return desired.every((c) => byN.get(c.n) === normalizeStatement(c.statement));
}

/**
 * Make the issue's live criteria exactly `desired`, in its order. Refused CRITERIA_LOCKED where the
 * set would change at a status whose verdicts were earned on it.
 */
export async function applyCriteria(
  tx: Tx,
  issue: { id: string; status: string },
  desired: readonly CriterionInput[],
): Promise<void> {
  const live = await liveRows(tx, issue.id);
  const same = unchanged(live, desired);
  if (!same && LOCKED_STATUSES.has(issue.status)) {
    throw refuseCriteria(
      'CRITERIA_LOCKED',
      `this issue is at \`${issue.status}\`, where its criteria are the ones its verdicts were earned on; reopen it to change them`,
    );
  }
  const keep = new Map<number, string>();
  for (const row of live) {
    const wanted = desired.find((c) => c.n === row.n);
    if (wanted && normalizeStatement(wanted.statement) === normalizeStatement(row.statement)) {
      keep.set(row.n, row.id);
      continue;
    }
    await tx
      .update(issueCriteria)
      .set({ retiredAt: sql`now()` })
      .where(eq(issueCriteria.id, row.id));
  }
  for (const [position, c] of desired.entries()) {
    const kept = keep.get(c.n);
    const requirement =
      c.requirementCriterionId === undefined
        ? {}
        : { requirementCriterionId: c.requirementCriterionId };
    if (kept) {
      await tx
        .update(issueCriteria)
        .set({ position, ...requirement })
        .where(eq(issueCriteria.id, kept));
      continue;
    }
    await tx.insert(issueCriteria).values({
      issueId: issue.id,
      n: c.n,
      statement: c.statement.trim(),
      position,
      ...requirement,
    });
  }
}

/** Refuse a desired set whose numbers repeat or fall below 1, or whose statements are blank. */
function inputFault(desired: readonly CriterionInput[]): string | null {
  const seen = new Set<number>();
  for (const c of desired) {
    if (!Number.isSafeInteger(c.n) || c.n < 1) return `criterion number ${c.n} is not 1 or more`;
    if (seen.has(c.n)) return `criterion ${c.n} is named twice`;
    if (!c.statement.trim()) return `criterion ${c.n} has no statement`;
    seen.add(c.n);
  }
  return null;
}

async function lockIssue(tx: Tx, issueId: string): Promise<{ id: string; status: string } | null> {
  const [row] = await tx
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .for('update');
  return row ?? null;
}

/**
 * The plan step's write: replace the criteria, and render `acceptance_criteria` from them so the
 * text a reader of the plain field reads says the same thing.
 */
export async function putCriteria(
  tx: Tx,
  issueId: string,
  desired: readonly CriterionInput[],
): Promise<boolean> {
  const fault = inputFault(desired);
  if (fault) throw refuseCriteria('CRITERIA_INPUT_INVALID', fault, '/criteria');
  const issue = await lockIssue(tx, issueId);
  if (!issue) return false;
  await applyCriteria(tx, issue, desired);
  const text = renderCriteriaText(
    desired.map(({ n, statement }) => ({ n, statement: statement.trim() })),
  );
  await tx
    .update(issues)
    .set({ acceptanceCriteria: text === '' ? null : text })
    .where(eq(issues.id, issueId));
  return true;
}

/**
 * cm:hack — the text dual path. forge-plugin 3.36.542 writes criteria as `acceptance_criteria`
 * text, so every write of that text is read into rows here, in the write's own transaction. A text
 * with a repeated or blank number is refused by name rather than half-read. Exit: the plugin's plan
 * step calls `PUT /api/issues/:id/criteria` (plugin-followups.md); then the text is rendered only.
 */
export async function syncCriteriaFromText(
  tx: Tx,
  issueId: string,
  text: string | null,
): Promise<void> {
  const [issue] = await tx
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue) return;
  const parsed = parseCriteriaText(text);
  if (parsed.faults.length > 0) {
    throw refuseCriteria(
      'CRITERIA_TEXT_UNPARSEABLE',
      `acceptanceCriteria cannot be read as numbered criteria: ${parsed.faults.map((f) => f.why).join('; ')}. Number each criterion once (\`1. …\`, \`2. …\`).`,
      '/acceptanceCriteria',
    );
  }
  await applyCriteria(tx, issue, parsed.criteria as ParsedCriterion[]);
}

const LIST_SQL = (issueIds: readonly string[]) => sql`
  SELECT c.issue_id, c.id, c.n, c.statement, c.position, c.requirement_criterion_id,
         v.id AS v_id, v.verdict, v.reason, v.identity_kind, v.commit_sha, v.runtime_ref,
         v.design_workflow_id, w.flow AS design_flow, v.design_revision, v.contract_ref,
         v.contract_version, v.storefront_workflow_id, v.storefront_draft_version,
         v.storefront_environment, v.corroboration, v.corroboration_note, v.evidence, v.author_agency, v.backfilled, v.created_at AS v_created_at
    FROM issue_criteria c
    LEFT JOIN LATERAL (
      SELECT * FROM criterion_verdicts cv
       WHERE cv.criterion_id = c.id
       ORDER BY cv.created_at DESC, cv.id DESC
       LIMIT 1
    ) v ON true
    LEFT JOIN project_workflows w ON w.id = v.design_workflow_id
   WHERE c.issue_id IN (${sql.join(
     issueIds.map((id) => sql`${id}::uuid`),
     sql`, `,
   )}) AND c.retired_at IS NULL
   ORDER BY c.issue_id, c.position, c.n`;

type ListRow = {
  issue_id: string;
  id: string;
  n: number;
  statement: string;
  position: number;
  requirement_criterion_id: string | null;
  v_id: string | null;
  verdict: VerdictValue | null;
  reason: string | null;
  identity_kind: VerdictIdentityKind | null;
  commit_sha: string | null;
  runtime_ref: string | null;
  design_workflow_id: string | null;
  design_flow: string | null;
  design_revision: number | null;
  contract_ref: string | null;
  contract_version: string | null;
  storefront_workflow_id: string | null;
  storefront_draft_version: string | null;
  storefront_environment: string | null;
  corroboration: VerdictCorroboration | null;
  corroboration_note: string | null;
  evidence: string[] | null;
  author_agency: ActorAgency | null;
  backfilled: boolean | null;
  v_created_at: Date | string | null;
};

function latestOf(row: ListRow): LatestVerdict | null {
  if (row.v_id === null || row.verdict === null) return null;
  return {
    id: row.v_id,
    verdict: row.verdict,
    reason: row.reason,
    identityKind: row.identity_kind,
    commitSha: row.commit_sha,
    runtimeRef: row.runtime_ref,
    designWorkflowId: row.design_workflow_id,
    designFlow: row.design_flow,
    designRevision: row.design_revision,
    contractRef: row.contract_ref,
    contractVersion: row.contract_version,
    storefrontWorkflowId: row.storefront_workflow_id,
    storefrontDraftVersion: row.storefront_draft_version,
    storefrontEnvironment: row.storefront_environment,
    corroboration: row.corroboration,
    corroborationNote: row.corroboration_note,
    evidence: row.evidence ?? [],
    authorAgency: row.author_agency ?? 'human',
    backfilled: row.backfilled === true,
    createdAt: new Date(row.v_created_at ?? 0).toISOString(),
  };
}

function criterionOf(row: ListRow): CriterionWithVerdict {
  return {
    id: row.id,
    n: row.n,
    statement: row.statement,
    position: row.position,
    requirementCriterionId: row.requirement_criterion_id,
    latest: latestOf(row),
  };
}

/** Every live criterion of an issue, in order, each with its latest verdict or null. */
export async function listCriteria(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
): Promise<CriterionWithVerdict[]> {
  const rows = (await executor.execute(LIST_SQL([issueId]))) as unknown as ListRow[];
  return [...rows].map(criterionOf);
}

export async function listCriteriaOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
): Promise<Map<string, CriterionWithVerdict[]>> {
  const out = new Map<string, CriterionWithVerdict[]>(issueIds.map((id) => [id, []]));
  if (issueIds.length === 0) return out;
  const rows = (await executor.execute(LIST_SQL(issueIds))) as unknown as ListRow[];
  for (const row of rows) out.get(row.issue_id)?.push(criterionOf(row));
  return out;
}

export interface VerdictAuthor {
  readonly userId: string | null;
  readonly deviceId: string | null;
  readonly agency: ActorAgency;
}

type Columns = VerdictColumns;

async function storefrontColumns(
  projectId: string,
  criterion: number,
  identity: Extract<VerdictIdentity, { kind: 'storefront_draft' }>,
  readDraft: DraftReader,
): Promise<Columns> {
  const document = (await readProjectDocument(projectId))?.document ?? null;
  const environment = identity.environment.trim();
  const unknown = environmentFault(criterion, document, environment);
  if (unknown) throw verdictRefused(unknown);
  const workflowId = identity.workflowId.trim();
  const found = corroborationOf(identity, await readDraft(document, workflowId));
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
): Promise<Columns> {
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
      const held = await dbContractLookup(tx)(projectId, {
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
      const found = await dbDesignLookup(tx)(projectId, identity.workflow);
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
  const identity = await identityColumns(
    tx,
    issue.projectId,
    draft,
    args.readDraft ?? readSourceDraft,
  );
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
    })
    .returning({ id: criterionVerdicts.id });
  if (!row) throw new Error('criterion_verdicts insert returned no row');
  await writeKernelRecord(tx, {
    issueId: issue.id,
    actor: verdictActor(author),
    kind: 'verdict',
    fields: verdictRecordFields({ id: row.id, draft, identity }),
    commentId: args.commentId ?? null,
  });
  return row;
}
