// ISS-1117 / ISS-55 — the release hold's reading of every criterion's latest verdict, off
// `issue_criteria` and `criterion_verdicts` (`criteria/store.ts`), the same rows the
// `awaiting_release` gate reads (`release-evidence.ts`), so the two never disagree about a verdict.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { commentAttachments, comments, issueAttachments, issues, projects } from '../db/schema.js';
import { contractVersions } from '../db/schema-ecosystem.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { type ForgeRecord, parseForgeRecord } from '../messaging/forge-record.js';
import { criterionBlocksIn, longestSpelling } from '../messaging/verdict-identity.js';
import type { ServingReading } from '../release-batch/serving-reading.js';
import { type CriterionWithVerdict, type LatestVerdict, listCriteria } from './criteria/store.js';
import { type CitationReport, citationSentence, unresolvedCitations } from './evidence-standing.js';
import {
  type IssueIdentities,
  issueIdentities,
  standingSentence,
  type VerdictIdentity,
  type VerdictStanding,
  verdictStanding,
} from './verdict-standing.js';

// `short` is the CLI's own "met short of its wording, judged not to block" — a real judgement.
const EARNED_VERDICTS: ReadonlySet<string> = new Set(['pass', 'short']);

// A verdict nothing could re-read is weaker evidence, not a refusal, so it earns (ISS-1286).
const EARNED_STANDINGS: ReadonlySet<VerdictStanding> = new Set(['stands', 'uncorroborated']);

export interface CriterionVerdict {
  readonly criterion: number;
  readonly verdict: string;
  /** What this verdict names as the thing it held in, or null where it names none. */
  readonly at: VerdictIdentity | null;
  /** What this verdict cites as what it was taken from, in the order written. */
  readonly cited: readonly string[];
}

/** The (criterion, verdict, identity) triples one `verdict`-kind `forge-record` fence names. */
export function verdictPairsIn(body: string): CriterionVerdict[] {
  return verdictPairsOf(parseForgeRecord(body));
}

/** The same triples, read off a record whichever store it came from. */
export function verdictPairsOf(record: ForgeRecord | null): CriterionVerdict[] {
  const out: CriterionVerdict[] = [];
  for (const block of criterionBlocksIn(record)) {
    if (block.verdict === null) continue;
    const at: VerdictIdentity | null =
      block.runtime !== null
        ? { kind: 'runtime', value: block.runtime }
        : block.source !== null
          ? { kind: 'source', value: block.source }
          : block.design !== null
            ? { kind: 'design', value: block.design }
            : block.contract !== null
              ? { kind: 'contract', value: block.contract }
              : null;
    out.push({ criterion: block.criterion, verdict: block.verdict, at, cited: block.cited });
  }
  return out;
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
    default:
      return null;
  }
}

/** Each live criterion's latest verdict, keyed by the criterion's number. */
export function latestByNumber(
  criteria: readonly CriterionWithVerdict[],
): Map<number, CriterionVerdict> {
  const latest = new Map<number, CriterionVerdict>();
  for (const { n, latest: row } of criteria) {
    if (!row) continue;
    latest.set(n, {
      criterion: n,
      verdict: row.verdict,
      at: identityOfRow(row),
      cited: row.evidence,
    });
  }
  return latest;
}

export async function latestCriterionVerdicts(
  issueId: string,
): Promise<Map<number, CriterionVerdict>> {
  return latestByNumber(await listCriteria(db, issueId));
}

/** One criterion an issue does not carry an earned, standing verdict on. */
export interface UnearnedCriterion {
  readonly criterion: number;
  /** The latest verdict's word, or null where no verdict record has ever named this criterion. */
  readonly verdict: string | null;
  /** How that verdict's identity resolved, or null where there is no verdict. */
  readonly standing: VerdictStanding | null;
  readonly why: string;
}

/** One criterion whose verdict cites something the tracker cannot resolve, and which citation. */
export interface BrokenCitations {
  readonly criterion: number;
  readonly unresolved: readonly CitationReport[];
}

export interface IssueCriteriaReport {
  readonly issueId: string;
  readonly unearned: readonly UnearnedCriterion[];
  /** Named beside `unearned` so a reader gets the citation and not only the consequence. */
  readonly broken: readonly BrokenCitations[];
  /** What the project's declared probes answered when these verdicts were weighed. */
  readonly serving: ServingReading;
  /** Criteria earned on a runtime nothing could re-read: earned, and weaker than a checked one. */
  readonly uncorroborated: readonly number[];
}

/** Every name the tracker holds an attachment under for this issue, its comments' included. */
export async function heldAttachmentNames(issueId: string): Promise<Set<string>> {
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

/** Every reason this criterion is not shown earned, in the order they are read. */
function reasonsAgainst(
  pair: CriterionVerdict,
  standing: VerdictStanding,
  serving: ServingReading,
  identities: IssueIdentities,
  unresolved: readonly CitationReport[],
): string[] {
  const out: string[] = [];
  if (!EARNED_VERDICTS.has(pair.verdict)) {
    out.push(`its verdict is \`${pair.verdict}\`, which is not earned`);
  } else if (!EARNED_STANDINGS.has(standing)) {
    out.push(standingSentence(standing, pair.at, serving, identities));
  }
  if (unresolved.length > 0) out.push(citationSentence(unresolved));
  return out;
}

interface CriteriaFindings {
  readonly unearned: UnearnedCriterion[];
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
    return { kind: pair.at.kind, value: spelled(pair.at.value) };
  };
}

function findingsFor(
  numbers: readonly number[],
  latest: ReadonlyMap<number, CriterionVerdict>,
  serving: ServingReading,
  identities: IssueIdentities,
  held: ReadonlySet<string>,
): CriteriaFindings {
  const unearned: UnearnedCriterion[] = [];
  const broken: BrokenCitations[] = [];
  const uncorroborated: number[] = [];
  const standings = new Map<number, VerdictStanding>();
  for (const criterion of numbers) {
    const pair = latest.get(criterion);
    if (pair) standings.set(criterion, verdictStanding(pair.at, serving, identities));
  }
  const spoken = spokenAt(
    [...standings].map(([criterion, standing]) => ({
      pair: latest.get(criterion) as CriterionVerdict,
      standing,
    })),
  );
  for (const criterion of numbers) {
    const pair = latest.get(criterion);
    const standing = standings.get(criterion);
    if (!pair || !standing) {
      unearned.push({ criterion, verdict: null, standing: null, why: NEVER_JUDGED });
      continue;
    }
    const unresolved = unresolvedCitations(pair.cited, held);
    if (unresolved.length > 0) broken.push({ criterion, unresolved });
    const said = { ...pair, at: spoken(pair, standing) };
    const reasons = reasonsAgainst(said, standing, serving, identities, unresolved);
    if (standing === 'uncorroborated' && reasons.length === 0) uncorroborated.push(criterion);
    if (reasons.length === 0) continue;
    unearned.push({ criterion, verdict: pair.verdict, standing, why: reasons.join('; and ') });
  }
  return { unearned, broken, uncorroborated };
}

/** The issue rows this check reads, and the only ones it reads. */
interface CriteriaRow {
  id: string;
  projectId: string;
  acceptanceCriteria: string | null;
  sessionContext: unknown;
  mergedCommitSha: string | null;
  mergedAt?: Date | null;
}

function byMerge(a: CriteriaRow, b: CriteriaRow): number {
  const at = (row: CriteriaRow) => row.mergedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const merged = at(a) - at(b);
  if (merged !== 0 && !Number.isNaN(merged)) return merged;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Each workflow's current revision, under its flow and under its id, for every project named. */
async function designRevisions(projectIds: string[]): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>(projectIds.map((id) => [id, new Map()]));
  if (projectIds.length === 0) return out;
  const rows = await db
    .select({
      id: projectWorkflows.id,
      flow: projectWorkflows.flow,
      projectId: projectWorkflows.projectId,
      revision: projectWorkflows.revision,
    })
    .from(projectWorkflows)
    .where(inArray(projectWorkflows.projectId, projectIds));
  for (const row of rows) {
    const held = out.get(row.projectId);
    held?.set(row.flow, row.revision);
    held?.set(row.id, row.revision);
  }
  return out;
}

/** Each contract's current (newest approved) version, keyed `<project slug>/<contract slug>`. */
async function currentContracts(projectIds: string[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>(projectIds.map((id) => [id, new Map()]));
  if (projectIds.length === 0) return out;
  const rows = await db
    .select({
      projectId: contractVersions.providerProjectId,
      slug: projects.slug,
      contract: contractVersions.contractSlug,
      version: contractVersions.version,
      recordedAt: contractVersions.recordedAt,
    })
    .from(contractVersions)
    .innerJoin(projects, eq(projects.id, contractVersions.providerProjectId))
    .where(
      and(
        inArray(contractVersions.providerProjectId, projectIds),
        eq(contractVersions.approval, 'approved'),
      ),
    );
  const newestFirst = [...rows].sort(
    (a, b) => (b.recordedAt?.getTime() ?? 0) - (a.recordedAt?.getTime() ?? 0),
  );
  for (const row of newestFirst) {
    const held = out.get(row.projectId);
    const key = `${row.slug}/${row.contract}`;
    if (held && !held.has(key)) held.set(key, row.version);
  }
  return out;
}

async function reportFor(
  row: CriteriaRow,
  serving: ServingReading,
  designs: ReadonlyMap<string, number>,
  contracts: ReadonlyMap<string, string>,
): Promise<IssueCriteriaReport> {
  // No parseable criteria is a different, already-owned gap, not this check's to refuse.
  const identities = { ...issueIdentities(row), designs, contracts };
  const criteria = await listCriteria(db, row.id);
  const numbers = criteria.map((c) => c.n);
  if (numbers.length === 0) {
    return { issueId: row.id, unearned: [], broken: [], serving, uncorroborated: [] };
  }
  const latest = latestByNumber(criteria);
  const held = await heldAttachmentNames(row.id);
  const found = findingsFor(numbers, latest, serving, identities, held);
  return {
    issueId: row.id,
    unearned: found.unearned,
    broken: found.broken,
    serving,
    uncorroborated: found.uncorroborated,
  };
}

/**
 * Every criterion these issues cannot be shown to have earned, and why each one is not earned.
 *
 * `serving` is ONE reading the caller took, shared by every issue here: one project, one answer
 * about it, one moment. It is required rather than defaulted, because a missing reading earns every
 * runtime verdict exactly as a project with no probe does, and the two must not look alike.
 */
export async function unearnedCriteriaReports(
  issueIds: string[],
  serving: ServingReading,
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
    })
    .from(issues)
    .where(inArray(issues.id, issueIds))) as CriteriaRow[];
  // Oldest merge first, then id, as the sweep reads the gate: every list of them agrees (ISS-1346).
  const projectIds = [...new Set(rows.map((row) => row.projectId))];
  const [designs, contracts] = await Promise.all([
    designRevisions(projectIds),
    currentContracts(projectIds),
  ]);
  const out: IssueCriteriaReport[] = [];
  for (const row of [...rows].sort(byMerge)) {
    out.push(
      await reportFor(
        row,
        serving,
        designs.get(row.projectId) ?? new Map(),
        contracts.get(row.projectId) ?? new Map(),
      ),
    );
  }
  return out;
}

/** Issues carrying a criterion that is not earned: never judged, `skipped`, `fail`, or stale. */
export async function issuesWithUnearnedCriteria(
  issueIds: string[],
  serving: ServingReading,
): Promise<string[]> {
  const reports = await unearnedCriteriaReports(issueIds, serving);
  return reports.filter((r) => r.unearned.length > 0).map((r) => r.issueId);
}
