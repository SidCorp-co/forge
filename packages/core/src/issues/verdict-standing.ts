/**
 * What the identity a verdict names is worth once it is stored: which of its issue's own
 * identities it resolves against, and what an operator is told when it resolves against none.
 * The shapes that identity may be written in live at the write door, in
 * `messaging/verdict-identity.ts`.
 */

import { sameIdentity } from '../messaging/verdict-identity.js';

/** `source` is a commit that was read, which cannot say the code was ever running. */
export interface VerdictIdentity {
  readonly kind: 'runtime' | 'source';
  readonly value: string;
}

export interface IssueIdentities {
  /** What the issue records as serving it. */
  readonly serving: string | null;
  /** The source the issue stands at. */
  readonly source: string | null;
}

/** How a verdict's identity resolves. `stands` is the only one a criterion can be earned on. */
export type VerdictStanding = 'stands' | 'superseded' | 'unwitnessed' | 'unanchored';

interface LandingBlock {
  deployment?: unknown;
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
  return {
    serving: textOrNull(landing.deployment),
    source: textOrNull(row.mergedCommitSha) ?? textOrNull(landing.head),
  };
}

export function verdictStanding(
  at: VerdictIdentity | null,
  identities: IssueIdentities,
): VerdictStanding {
  if (!at) return 'unanchored';
  if (identities.serving === null && identities.source === null) return 'unanchored';
  if (at.kind === 'runtime') {
    return sameIdentity(at.value, identities.serving) ? 'stands' : 'superseded';
  }
  if (identities.source === null) return 'superseded';
  return sameIdentity(at.value, identities.source, { abbreviating: true })
    ? 'unwitnessed'
    : 'superseded';
}

function named(value: string | null): string {
  return value ?? 'nothing';
}

export function standingSentence(
  standing: VerdictStanding,
  at: VerdictIdentity | null,
  identities: IssueIdentities,
): string {
  if (standing === 'stands') {
    return `judged at the runtime this issue records as serving it, ${named(identities.serving)}`;
  }
  if (standing === 'unanchored') {
    return at
      ? `judged at ${at.value}, and this issue records no identity of its own to resolve that against`
      : 'judged without naming what it was judged against, so nothing says where it held';
  }
  if (standing === 'unwitnessed') {
    return `judged against source ${named(at?.value ?? null)}, which is still the source this issue stands at, but no runtime witnessed it — a source identity says which code was read, never that the code was running`;
  }
  const stands = at?.kind === 'runtime' ? named(identities.serving) : named(identities.source);
  return `judged at ${named(at?.value ?? null)}, and this issue now stands at ${stands}`;
}
