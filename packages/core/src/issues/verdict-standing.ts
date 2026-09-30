/**
 * What the identity a verdict names is worth once it is stored. A verdict resolves against a
 * READING of what a project is serving — `release-batch/serving-reading.ts` — taken when the
 * verdict is weighed; `sessionContext.landing.deployment` gates nothing, a commit stored on a row
 * being unable to say what a host serves now (ISS-1286). Where that reading names what is running,
 * it decides a verdict written in either field, the observation being Forge's (ISS-1346); where it
 * names nothing, a source verdict resolves against the issue's own source. The shapes an identity
 * may be written in: `messaging/verdict-identity.ts`. Its report says the reading, once (ISS-1346).
 */

import { sameIdentity } from '../messaging/verdict-identity.js';
import { type ServingReading, servedCommits } from '../release-batch/serving-reading.js';

/** `source` is a commit that was read, which cannot say the code was ever running. */
export interface VerdictIdentity {
  readonly kind: 'runtime' | 'source';
  readonly value: string;
}

export interface IssueIdentities {
  /** The source the issue stands at. */
  readonly source: string | null;
}

/** How a verdict's identity resolves; `stands` and `uncorroborated` are the two a criterion is
 *  earned on. `uncorroborated` is a runtime witnessed that nothing here could re-read: absence of
 *  a reading is not a failure, so it earns, under its own word because it is weaker evidence. */
export type VerdictStanding =
  | 'stands'
  | 'superseded'
  | 'unwitnessed'
  | 'uncorroborated'
  | 'unanchored';

interface LandingBlock {
  head?: unknown;
}

function landingOf(sessionContext: unknown): LandingBlock {
  if (typeof sessionContext !== 'object' || sessionContext === null) return {};
  const landing = (sessionContext as Record<string, unknown>).landing;
  if (typeof landing !== 'object' || landing === null) return {};
  return landing as LandingBlock;
}

function textOrNull(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed;
}

// `merged_commit_sha` outranks the landing's head: a merge Forge observed, not a head captured.
export function issueIdentities(row: {
  sessionContext: unknown;
  mergedCommitSha?: string | null;
}): IssueIdentities {
  const landing = landingOf(row.sessionContext);
  return { source: textOrNull(row.mergedCommitSha) ?? textOrNull(landing.head) };
}

/** Whether a runtime verdict names something the reading says is running. Any commit a probe
 *  answered decides, so a fleet mid-rollout and a fleet one probe of which is down both do. */
function runtimeStanding(value: string, serving: ServingReading): VerdictStanding {
  if (serving.kind !== 'serving') return 'uncorroborated';
  return servedCommits(serving).some((commit) => sameIdentity(value, commit))
    ? 'stands'
    : 'superseded';
}

// A source may be abbreviated to seven characters, as the write door lets it be.
function servedSource(value: string, serving: ServingReading): VerdictStanding | null {
  if (serving.kind !== 'serving') return null;
  const served = servedCommits(serving).some((commit) =>
    sameIdentity(value, commit, { abbreviating: true }),
  );
  return served ? 'stands' : 'superseded';
}

export function verdictStanding(
  at: VerdictIdentity | null,
  serving: ServingReading,
  identities: IssueIdentities,
): VerdictStanding {
  if (!at) return 'unanchored';
  if (at.kind === 'runtime') return runtimeStanding(at.value, serving);
  const observed = servedSource(at.value, serving);
  if (observed) return observed;
  if (identities.source === null) return 'unanchored';
  return sameIdentity(at.value, identities.source, { abbreviating: true })
    ? 'unwitnessed'
    : 'superseded';
}

function named(value: string | null): string {
  return value ?? 'nothing';
}

/** What an unreadable reading asked and when, as one clause an operator can go and check. */
function askedClause(serving: ServingReading): string {
  if (serving.kind !== 'unreadable') return '';
  const hosts = serving.hosts.length > 0 ? ` at ${serving.hosts.join(', ')}` : '';
  return `${hosts}, read at ${serving.readAt}`;
}

function uncorroboratedSentence(at: VerdictIdentity | null, serving: ServingReading): string {
  const runtime = named(at?.value ?? null);
  if (serving.kind === 'unreadable') {
    return `judged at the runtime ${runtime}, and nothing could be read from what this project declares${askedClause(serving)}: ${serving.why}. A verdict nothing could check is weaker evidence than one that was checked, and it is not a refusal`;
  }
  return `judged at the runtime ${runtime}, and nothing here can read what this project is serving${missingClause(serving)}, so nothing could check that reading. A verdict nothing could check is weaker evidence than one that was checked, and it is not a refusal`;
}

function missingClause(serving: ServingReading): string {
  return serving.kind === 'undeclared' ? ` — ${serving.missing}` : '';
}

function supersededSentence(
  at: VerdictIdentity | null,
  serving: ServingReading,
  identities: IssueIdentities,
): string {
  const judged = named(at?.value ?? null);
  if (at?.kind !== 'runtime' && serving.kind !== 'serving') {
    return `judged at ${judged}, and this issue now stands at ${named(identities.source)}`;
  }
  if (serving.kind !== 'serving') {
    return `judged at ${judged}, and nothing this project declares answered what it is serving`;
  }
  return `judged at ${judged}, which is not a commit this project is serving`;
}

export function standingSentence(
  standing: VerdictStanding,
  at: VerdictIdentity | null,
  serving: ServingReading,
  identities: IssueIdentities,
): string {
  if (standing === 'stands') {
    return `judged at ${named(at?.value ?? null)}, which this project is serving`;
  }
  if (standing === 'unanchored') {
    return at
      ? `judged at ${at.value}, and this issue records no identity of its own to resolve that against`
      : 'judged without naming what it was judged against, so nothing says where it held';
  }
  if (standing === 'unwitnessed') {
    return `judged against source ${named(at?.value ?? null)}, which is still the source this issue stands at, but no runtime witnessed it — a source identity says which code was read, never that the code was running`;
  }
  if (standing === 'uncorroborated') return uncorroboratedSentence(at, serving);
  return supersededSentence(at, serving, identities);
}
