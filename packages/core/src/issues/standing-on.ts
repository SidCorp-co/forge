// The verdict each live criterion of an issue stands on, by the verified rule (contracts
// `verified-rule.ts:verifiedOf`), read beside the issue's move history: a reopen voids what was
// recorded before it (`release-evidence.ts:reopenedAtOf`), as requirement coverage reads it.

import { verifiedOf } from '@forge/contracts/verified-rule';
import { db } from '../db/client.js';
import { type AuthoredVerdict, liveVerdictsOfIssues } from './criteria/live-verdicts.js';
import { type CriterionWithVerdict, listCriteriaOf } from './criteria/store.js';
import type { readJudge } from './ports.js';
import { reopenedAtOf } from './release-evidence.js';

/** Whether a project declares a production environment, which decides what a reopen voids. */
export function declaresProduction(
  document: { environments?: Record<string, { tier: string }> } | null | undefined,
): boolean {
  return Object.values(document?.environments ?? {}).some((e) => e.tier === 'production');
}

/**
 * Whether the issue's latest reopen voids this verdict, recorded at or before it: evidence about a
 * build the reopen rejected (`release-evidence.ts:reopenedAtOf`), as requirement coverage reads it
 * (`requirements/standing-facts.ts`). On a project with no production environment a commit names its
 * build exactly, so a commit verdict is kept for the commit check (`standing-coverage.ts:standsAtLanding`).
 */
function voidedByReopen(v: AuthoredVerdict, since: number, production: boolean): boolean {
  if (new Date(v.createdAt).getTime() > since) return false;
  return production || v.identityKind !== 'commit';
}

function reopenWhy(v: AuthoredVerdict, reopenedAt: Date): string {
  return `it was recorded at ${new Date(v.createdAt).toISOString()}, before this issue's latest reopen at ${reopenedAt.toISOString()}, which rejected the build it judged, so a verdict recorded since is owed`;
}

/**
 * The verdict each live criterion stands on, by the verified rule: of its verdicts since the issue's
 * last reopen, the judge's (`judgesVerdict`), with why it does not prove the criterion where it is a
 * pass or short the rule does not count. A criterion whose newest verdict the reopen voided shows it,
 * unproven, saying so (`voidedByReopen`). `production`: whether the project declares production.
 */
export async function standingOn(
  issueId: string,
  criteria: readonly CriterionWithVerdict[],
  judge: Awaited<ReturnType<typeof readJudge>>,
  production: boolean,
): Promise<{ criteria: CriterionWithVerdict[]; unverified: Map<number, string | null> }> {
  const [history, reopened] = await Promise.all([
    liveVerdictsOfIssues(db, [issueId]),
    reopenedAtOf(db, [issueId]),
  ]);
  return standingRead(
    criteria,
    history.get(issueId) ?? new Map(),
    reopened.get(issueId) ?? null,
    judge,
    production,
  );
}

type Standing = { criteria: CriterionWithVerdict[]; unverified: Map<number, string | null> };

/** `standingOn` for many issues, each read in one statement for all of them rather than one each. */
export async function standingsOn(
  issueIds: readonly string[],
  judgeOf: (issueId: string) => Awaited<ReturnType<typeof readJudge>>,
  productionOf: (issueId: string) => boolean,
): Promise<Map<string, Standing>> {
  const [criteria, history, reopened] = await Promise.all([
    listCriteriaOf(db, issueIds),
    liveVerdictsOfIssues(db, issueIds),
    reopenedAtOf(db, issueIds),
  ]);
  return new Map(
    issueIds.map((id) => [
      id,
      standingRead(
        criteria.get(id) ?? [],
        history.get(id) ?? new Map(),
        reopened.get(id) ?? null,
        judgeOf(id),
        productionOf(id),
      ),
    ]),
  );
}

function standingRead(
  criteria: readonly CriterionWithVerdict[],
  history: ReadonlyMap<number, readonly AuthoredVerdict[]>,
  reopenedAt: Date | null,
  judge: Awaited<ReturnType<typeof readJudge>>,
  production: boolean,
): Standing {
  const since = reopenedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const unverified = new Map<number, string | null>();
  const read = criteria.map((c) => {
    const [newest, ...earlier] = history.get(c.n) ?? [];
    if (!newest) return c;
    if (reopenedAt && voidedByReopen(newest, since, production)) {
      unverified.set(c.n, reopenWhy(newest, reopenedAt));
      return c;
    }
    const verified = verifiedOf(
      [newest, ...earlier.filter((v) => new Date(v.createdAt).getTime() > since)],
      judge,
    );
    unverified.set(c.n, verified.proven ? null : verified.why);
    return { ...c, latest: verified.stands ?? c.latest };
  });
  return { criteria: read, unverified };
}
