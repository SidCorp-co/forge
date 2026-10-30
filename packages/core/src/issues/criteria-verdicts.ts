// ISS-1117 / ISS-55 — the release hold's reading of the verdict every criterion stands on, off
// `issue_criteria` and `criterion_verdicts` (`criteria/store.ts`), read against the issue's move
// history (`release-evidence.ts`). Verdicts are judged here, on the release (REQ-45 BC-2). What
// proves a criterion is the verified rule every count of proof reads (contracts
// `verified-rule.ts:verifiedOf`, REQ-35 decision 7b261fca): "Ship only proven work" holds a short,
// and the builder's own pass, as the release record counts them unproven.

import { projectGate } from '@forge/contracts/gate-profiles';
import type { ServingReading } from '@forge/contracts/releases';
import { verdictEarns } from '@forge/contracts/verdict-identity';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { commentAttachments, comments, issueAttachments, issues } from '../db/schema.js';
import { longestSpelling } from '../messaging/verdict-identity.js';
import { type CriterionWithVerdict, type LatestVerdict, listCriteria } from './criteria/store.js';
import { withCurrentDrafts } from './criteria/storefront-draft.js';
import { currentContracts, designRevisions, pinnedAnchorsOf } from './criteria-anchors.js';
import { type CitationReport, citationSentence, unresolvedCitations } from './evidence-standing.js';
import { readJudge, readProjectDocument } from './ports.js';
import {
  type OwedRuntimes,
  owedRuntimes,
  type WeighedOn,
  type WeighedVerdict,
  weighedOn,
  weighVerdict,
} from './runtime-standing.js';
import { declaresProduction, standingOn } from './standing-on.js';
import {
  carriedSentence,
  EARNED_STANDINGS,
  type IssueIdentities,
  issueIdentities,
  standingSentence,
  type VerdictIdentity,
  type VerdictStanding,
} from './verdict-standing.js';
import { type RuntimeReading, UNWEIGHED, type Weighing } from './weighing.js';

export interface CriterionVerdict {
  readonly criterion: number;
  readonly verdict: string;
  /** What this verdict names as the thing it held in, or null where it names none. */
  readonly at: VerdictIdentity | null;
  /** What this verdict cites as what it was taken from, in the order written. */
  readonly cited: readonly string[];
  /** Where it is a pass or short the verified rule does not count as proven, why; else null. */
  readonly unverified: string | null;
}
/**
 * The identity a stored verdict is weighed on. A backfilled `commit_unresolved` abbreviation is
 * weighed as naming none: its amnesty covers the closed issue it was read from, not a release.
 */
function identityOfRow(row: LatestVerdict): VerdictIdentity | null {
  switch (row.identityKind) {
    case 'commit':
      return row.commitSha ? { kind: 'source', value: row.commitSha } : null;
    case 'runtime':
      return row.runtimeRef ? { kind: 'runtime', value: row.runtimeRef } : null;
    case 'design':
      return row.designRevision
        ? {
            kind: 'design',
            value: `${row.designFlow ?? row.designWorkflowId} rev ${row.designRevision}`,
          }
        : null;
    case 'contract':
      return row.contractRef && row.contractVersion
        ? { kind: 'contract', value: `${row.contractRef}@${row.contractVersion}` }
        : null;
    case 'storefront_draft':
      return row.storefrontDrafts && row.storefrontDrafts.length > 0
        ? {
            kind: 'storefront_draft',
            value: `${row.storefrontDrafts.map((p) => `${p.workflowId}@draft:${p.draftVersion}`).join(', ')} on \`${row.storefrontEnvironment}\``,
            corroboration: row.corroboration,
            corroborationNote:
              row.corroboration === 'corroborated'
                ? null
                : (row.corroborationNote ?? 'no reading recorded'),
          }
        : null;
    default:
      return null;
  }
}

/** Each live criterion's verdict it stands on, keyed by the criterion's number. */
export function latestByNumber(
  criteria: readonly CriterionWithVerdict[],
  unverified: ReadonlyMap<number, string | null>,
): Map<number, CriterionVerdict> {
  const latest = new Map<number, CriterionVerdict>();
  for (const { n, latest: row } of criteria) {
    if (!row) continue;
    latest.set(n, {
      criterion: n,
      verdict: row.verdict,
      at: identityOfRow(row),
      cited: row.evidence,
      unverified: unverified.get(n) ?? null,
    });
  }
  return latest;
}

/** Where one criterion's verdict was weighed: the declared runtime that decided (null for the
 *  deployment), and the judged-on environment the deployment's reading was taken from (null for
 *  production). Null both where no verdict was weighed. */
interface WeighedWhere {
  readonly runtime: string | null;
  readonly environment: string | null;
}

/** One criterion an issue does not carry an earned, standing verdict on. */
interface UnearnedCriterion extends WeighedWhere {
  readonly criterion: number;
  /** The latest verdict's word, or null where no verdict record has ever named this criterion. */
  readonly verdict: string | null;
  /** How that verdict's identity resolved, or null where there is no verdict. */
  readonly standing: VerdictStanding | null;
  readonly why: string;
  /** Whether its only reason is that nothing could say whether what is served carries it
   *  (`unread`): a weighing that asked would decide it, so it is neither earned nor refused. */
  readonly undecided: boolean;
}

/** One criterion an issue carries an earned, standing verdict on, and what earned it. */
export interface EarnedCriterion extends WeighedWhere {
  readonly criterion: number;
  readonly verdict: string;
  /** `stands` or `uncorroborated` (`EARNED_STANDINGS`). */
  readonly standing: VerdictStanding;
  /** Where a served commit other than the judged one carries it, which and how; else null. */
  readonly carried: string | null;
  readonly why: string;
}

/** One criterion whose verdict cites something the tracker cannot resolve, and which citation. */
interface BrokenCitations {
  readonly criterion: number;
  readonly unresolved: readonly CitationReport[];
}

export interface IssueCriteriaReport {
  readonly issueId: string;
  readonly unearned: readonly UnearnedCriterion[];
  /** Every criterion `unearned` does not name, with the sentence saying what earned it. */
  readonly earned: readonly EarnedCriterion[];
  /** Named beside `unearned` so a reader gets the citation and not only the consequence. */
  readonly broken: readonly BrokenCitations[];
  /** What the project's declared probes answered when these verdicts were weighed: the judged-on
   *  environment's for an unreleased issue (`weighedOn`), else production's. */
  readonly serving: ServingReading;
  /** The judged-on environment `serving` was read from, or null where it is production's. */
  readonly weighedOn: string | null;
  /** Each release runtime the project declares beside its deployment, as read then (ISS-1368). */
  readonly runtimes: readonly RuntimeReading[];
  /** Criteria earned on a runtime nothing could re-read: earned, and weaker than a checked one. */
  readonly uncorroborated: readonly number[];
}

/** Every name the tracker holds an attachment under for this issue, its comments' included. */
async function heldAttachmentNames(issueId: string): Promise<Set<string>> {
  const own = await db
    .select({ name: issueAttachments.name })
    .from(issueAttachments)
    .where(eq(issueAttachments.issueId, issueId));
  const onComments = await db
    .select({ name: commentAttachments.name })
    .from(commentAttachments)
    .innerJoin(comments, eq(comments.id, commentAttachments.commentId))
    .where(eq(comments.issueId, issueId));
  return new Set([...own, ...onComments].map((row) => row.name));
}

const NEVER_JUDGED = 'no verdict was recorded for it';

// a storefront draft nothing could read back is not earned, unlike a runtime (FB-56)
const unconfirmedDraft = (pair: CriterionVerdict, standing: VerdictStanding) =>
  pair.at?.kind === 'storefront_draft' && standing === 'uncorroborated';

/** Every reason this criterion is not shown earned, in the order they are read. */
function reasonsAgainst(
  pair: CriterionVerdict,
  weighed: WeighedVerdict,
  identities: IssueIdentities,
  unresolved: readonly CitationReport[],
): string[] {
  const out: string[] = [];
  const { standing, serving, runtime, environment, beside } = weighed;
  if (pair.unverified) {
    out.push(pair.unverified);
  } else if (!verdictEarns(pair.verdict)) {
    out.push(`its verdict is \`${pair.verdict}\`, which is not earned`);
  } else if (!EARNED_STANDINGS.has(standing) || unconfirmedDraft(pair, standing)) {
    const said = standingSentence(standing, pair.at, serving, identities, runtime, environment);
    out.push(beside.length === 0 ? said : `${said} — ${beside.join('; ')}`);
  }
  if (unresolved.length > 0) out.push(citationSentence(unresolved));
  return out;
}

interface CriteriaFindings {
  readonly unearned: UnearnedCriterion[];
  readonly earned: EarnedCriterion[];
  readonly broken: BrokenCitations[];
  readonly uncorroborated: number[];
}

/**
 * The identity each verdict's sentence names: its own value, respelled by the longest spelling of
 * the same identity among this issue's verdicts of its kind that resolved alike, so one commit
 * written whole in one comment and abbreviated in another is one reason (ISS-1346, criterion 25).
 * Standing was decided on the verdict's own value before this, so only the words move, and a
 * verdict that resolved otherwise lends no spelling that would say something it did not.
 */
function spokenAt(
  judged: ReadonlyArray<{ pair: CriterionVerdict; standing: VerdictStanding }>,
): (pair: CriterionVerdict, standing: VerdictStanding) => VerdictIdentity | null {
  const pools = new Map<string, string[]>();
  const pool = (at: VerdictIdentity, standing: VerdictStanding) => `${at.kind}\u0000${standing}`;
  for (const { pair, standing } of judged) {
    if (!pair.at) continue;
    const key = pool(pair.at, standing);
    pools.set(key, [...(pools.get(key) ?? []), pair.at.value]);
  }
  return (pair, standing) => {
    if (!pair.at) return null;
    const spelled = longestSpelling(pools.get(pool(pair.at, standing)) ?? []);
    return { ...pair.at, value: spelled(pair.at.value) };
  };
}

interface Weighed {
  readonly serving: ServingReading;
  readonly owed: OwedRuntimes;
  readonly weighing: Weighing;
  readonly on: WeighedOn;
}

function findingsFor(
  numbers: readonly number[],
  latest: ReadonlyMap<number, CriterionVerdict>,
  weigh: Weighed,
  identities: IssueIdentities,
  held: ReadonlySet<string>,
): CriteriaFindings {
  const unearned: UnearnedCriterion[] = [];
  const earned: EarnedCriterion[] = [];
  const broken: BrokenCitations[] = [];
  const uncorroborated: number[] = [];
  const weighed = new Map<number, WeighedVerdict>();
  for (const criterion of numbers) {
    const pair = latest.get(criterion);
    if (!pair) continue;
    weighed.set(
      criterion,
      weighVerdict(pair.at, weigh.serving, identities, weigh.owed, weigh.weighing, weigh.on),
    );
  }
  const spoken = spokenAt(
    [...weighed].map(([criterion, w]) => ({
      pair: latest.get(criterion) as CriterionVerdict,
      standing: w.standing,
    })),
  );
  for (const criterion of numbers) {
    const pair = latest.get(criterion);
    const w = weighed.get(criterion);
    if (!pair || !w) {
      unearned.push({
        criterion,
        verdict: null,
        standing: null,
        why: NEVER_JUDGED,
        runtime: null,
        environment: null,
        undecided: false,
      });
      continue;
    }
    const { standing, runtime, environment } = w;
    const unresolved = unresolvedCitations(pair.cited, held);
    if (unresolved.length > 0) broken.push({ criterion, unresolved });
    const said = { ...pair, at: spoken(pair, standing) };
    const reasons = reasonsAgainst(said, w, identities, unresolved);
    const where = { runtime, environment };
    if (reasons.length > 0) {
      const undecided =
        standing === 'unread' &&
        reasons.length === 1 &&
        !pair.unverified &&
        verdictEarns(pair.verdict);
      unearned.push({
        criterion,
        verdict: pair.verdict,
        standing,
        why: reasons.join('; and '),
        ...where,
        undecided,
      });
      continue;
    }
    if (standing === 'uncorroborated') uncorroborated.push(criterion);
    const why = w.carried
      ? carriedSentence(said.at, w.carried, runtime, environment)
      : standingSentence(standing, said.at, w.serving, identities, runtime, environment);
    earned.push({ criterion, verdict: pair.verdict, standing, carried: w.carried, why, ...where });
  }
  return { unearned, earned, broken, uncorroborated };
}

/** The issue rows this check reads, and the only ones it reads. */
interface CriteriaRow {
  id: string;
  projectId: string;
  acceptanceCriteria: string | null;
  sessionContext: unknown;
  mergedCommitSha: string | null;
  mergedAt?: Date | null;
  status: string;
}

function byMerge(a: CriteriaRow, b: CriteriaRow): number {
  const at = (row: CriteriaRow) => row.mergedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const merged = at(a) - at(b);
  if (merged !== 0 && !Number.isNaN(merged)) return merged;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function reportFor(
  row: CriteriaRow,
  serving: ServingReading,
  weighing: Weighing,
  anchors: Pick<IssueIdentities, 'designs' | 'contracts' | 'pinnedBy'>,
  judge: Awaited<ReturnType<typeof readJudge>>,
  production: boolean,
): Promise<IssueCriteriaReport> {
  const { runtimes } = weighing;
  // a closed issue's change was released; until then it is weighed where it was judged
  const on = weighedOn(row.status === 'closed', serving, weighing);
  const placed = { serving: on.serving, weighedOn: on.environment, runtimes };
  // No parseable criteria is a different, already-owned gap, not this check's to refuse.
  const identities = { ...issueIdentities(row), ...anchors };
  const stands = await standingOn(row.id, await listCriteria(db, row.id), judge, production);
  const criteria = await withCurrentDrafts(row.projectId, stands.criteria);
  const numbers = criteria.map((c) => c.n);
  if (numbers.length === 0) {
    return { issueId: row.id, unearned: [], earned: [], broken: [], ...placed, uncorroborated: [] };
  }
  const latest = latestByNumber(criteria, stands.unverified);
  const held = await heldAttachmentNames(row.id);
  const owed = owedRuntimes(row.id, weighing);
  const found = findingsFor(numbers, latest, { serving, owed, weighing, on }, identities, held);
  return {
    issueId: row.id,
    unearned: found.unearned,
    earned: found.earned,
    broken: found.broken,
    ...placed,
    uncorroborated: found.uncorroborated,
  };
}

/**
 * Every criterion these issues cannot be shown to have earned, and why each one is not earned.
 * A project whose document says `delivery.verdictsRequired: false` owes none: its issues report
 * nothing unearned.
 *
 * `serving` is ONE reading the caller took, shared by every issue here: one project, one answer
 * about it, one moment. It is required rather than defaulted, because a missing reading earns every
 * runtime verdict exactly as a project with no probe does, and the two must not look alike.
 *
 * `weighing` (ISS-1368) is read by the caller beside it. It may be left out, because without it a
 * verdict is weighed by equality alone against the deployment, which can hold one and never earn one.
 */
export async function unearnedCriteriaReports(
  issueIds: string[],
  serving: ServingReading,
  weighing: Weighing = UNWEIGHED,
): Promise<IssueCriteriaReport[]> {
  if (issueIds.length === 0) return [];
  const rows = (await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      acceptanceCriteria: issues.acceptanceCriteria,
      sessionContext: issues.sessionContext,
      mergedCommitSha: issues.mergedCommitSha,
      mergedAt: issues.mergedAt,
      status: issues.status,
    })
    .from(issues)
    .where(inArray(issues.id, issueIds))) as CriteriaRow[];
  // Oldest merge first, then id, as the sweep reads the gate: every list of them agrees (ISS-1346).
  const projectIds = [...new Set(rows.map((row) => row.projectId))];
  const [designs, contracts, pinned] = await Promise.all([
    designRevisions(projectIds),
    currentContracts(projectIds),
    pinnedAnchorsOf(rows.map((row) => row.id)),
  ]);
  const required = new Map<string, boolean>();
  const production = new Map<string, boolean>();
  const judges = new Map<string, Awaited<ReturnType<typeof readJudge>>>();
  for (const id of projectIds) {
    const document = (await readProjectDocument(id))?.document;
    // gate `release_criteria` (REQ-76): off owes no verdict; advise and enforce weigh them, and the
    // release hold decides whether an unearned one blocks or warns
    required.set(id, projectGate(document, null, 'release_criteria').mode !== 'off');
    production.set(id, declaresProduction(document));
    judges.set(id, await readJudge(id));
  }
  const out: IssueCriteriaReport[] = [];
  for (const row of [...rows].sort(byMerge)) {
    if (required.get(row.projectId) === false) {
      out.push({
        issueId: row.id,
        unearned: [],
        earned: [],
        broken: [],
        serving,
        weighedOn: null,
        runtimes: weighing.runtimes,
        uncorroborated: [],
      });
      continue;
    }
    const pin = pinned.get(row.id);
    out.push(
      await reportFor(
        row,
        serving,
        weighing,
        pin
          ? { designs: pin.designs, contracts: pin.contracts, pinnedBy: pin.key }
          : {
              designs: designs.get(row.projectId) ?? new Map(),
              contracts: contracts.get(row.projectId) ?? new Map(),
            },
        judges.get(row.projectId) ?? null,
        production.get(row.projectId) ?? true,
      ),
    );
  }
  return out;
}
