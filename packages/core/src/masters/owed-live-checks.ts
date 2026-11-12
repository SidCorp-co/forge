// The live verdicts a project's latest shipped release owes (ISS-1200): each issue it carries, closed
// by it, whose criteria the release reads open, judged on nothing production serves
// (`release-batch/release-view.ts:proofOf`). It is master work (`masters/owed.ts`), so an outdated
// pane owing only these is replaced rather than drained with nothing placed: drained, the box refuses
// the run declaration the live judge needs. Only the newest shipped release counts, and an issue
// leaves the count once its criteria are judged or moved out, so the count reaches zero.
// A check counts only where a judge can get in (FB-611): the environment judged on names a testing
// profile and no person owes an open question on the issue. Otherwise it waits on a person, said in
// the nudge as that wait, and keeps or replaces no pane. So is an issue whose every criterion still
// open was recorded `skipped` at the release build, for want of a route (ISS-1218): the skips name
// what is missing, and a judging run would only find the same.

import type { ReleaseSummary } from '@forge/contracts/releases';
import { guideCall } from '../guides/index.js';
import { agrees } from '../lib/plural.js';
import {
  type JudgingEnvironmentRead,
  type LiveCheckOwed,
  type LiveCheckWait,
  type LiveCheckWaiting,
  mastersPorts,
} from './ports.js';

/** Of the newest shipped release, the issues it closed that still wait for their live verdict. Pure. */
export function liveChecksOf(release: ReleaseSummary | null): LiveCheckOwed[] {
  if (release?.state !== 'shipped') return [];
  return release.contents.flatMap((group) =>
    group.issues
      .filter((i) => i.status === 'closed' && i.proof === 'open')
      .map((i) => ({
        version: release.version,
        issueId: i.id,
        key: i.key,
        ...(i.unreached ? { unreached: i.unreached } : {}),
      })),
  );
}

/**
 * ISS-1200: the live verdicts a shipped release owes, which no run judges unless the master declares
 * one; then those no judge can get in to take, said as a wait on a person (FB-611).
 */
export function liveChecksLine(
  checks: readonly LiveCheckOwed[],
  waiting: readonly LiveCheckWaiting[] = [],
): string {
  return ownLiveChecksLine(checks) + liveChecksWaitingLine(waiting);
}

function ownLiveChecksLine(checks: readonly LiveCheckOwed[]): string {
  if (checks.length === 0) return '';
  const versions = [...new Set(checks.map((c) => c.version))].join(', ');
  const keys = checks.map((c) => `${c.key} ${c.issueId}`).join(', ');
  return ` ${checks.length} issue${agrees(checks.length, '', 's')} the shipped release ${versions} carried ${agrees(checks.length, 'owes its', 'owe their')} live verdict (${keys}): nothing has judged ${agrees(checks.length, 'its', 'their')} criteria on what production serves. Declare a judging run, \`--role qa\`, to judge each criterion there and record its verdict, or move a criterion that cannot be judged there out on the record; \`${guideCall('qa')}\` is how.`;
}

/**
 * The checks a judge can get in to take, and those waiting on a person with why: the environment
 * judged on names no testing profile, or a person owes an open question on the issue. Pure.
 */
export function liveChecksReach(
  checks: readonly LiveCheckOwed[],
  judging: JudgingEnvironmentRead | null,
  questioned: ReadonlySet<string>,
): { liveChecks: LiveCheckOwed[]; liveChecksWaiting: LiveCheckWaiting[] } {
  const liveChecks: LiveCheckOwed[] = [];
  const liveChecksWaiting: LiveCheckWaiting[] = [];
  for (const check of checks) {
    // a criterion no judge has a route to is skipped naming what is missing (`guides/qa.md`): a
    // judging run would find the same, so it waits on whoever adds the route (ISS-1218)
    const waits: LiveCheckWait | null = check.unreached
      ? { kind: 'skipped', missing: check.unreached }
      : !judging?.testing
        ? { kind: 'no_testing_profile', environment: judging?.name ?? null }
        : questioned.has(check.issueId)
          ? { kind: 'question' }
          : null;
    if (waits) liveChecksWaiting.push({ ...check, waits });
    else liveChecks.push(check);
  }
  return { liveChecks, liveChecksWaiting };
}

/** The live checks the latest shipped release owes, split by whether a judge can get in to take them. */
export async function readLiveChecks(
  projectId: string,
): Promise<{ liveChecks: LiveCheckOwed[]; liveChecksWaiting: LiveCheckWaiting[] }> {
  const { checks, judging, questioned } = await mastersPorts().liveChecksOwed(projectId);
  return liveChecksReach(checks, judging, new Set(questioned));
}

/** A skip's reason, cut to a line: the issue holds it whole. */
const shortReason = (r: string) => (r.length > 160 ? `${r.slice(0, 157)}...` : r);

const waitWhy = (w: LiveCheckWait): string =>
  w.kind === 'question'
    ? 'a person owes an open question on it'
    : w.kind === 'skipped'
      ? `every criterion still open is recorded skipped at the release build, for want of: ${[...new Set(w.missing.map(shortReason))].join('; ')}`
      : w.environment
        ? `\`${w.environment}\` names no testing profile, so no judge can sign in there`
        : 'the project names no environment to judge on';

/** FB-611: a live check no judge can get in to take is a wait on a person, said, never asked of the master. */
function liveChecksWaitingLine(waiting: readonly LiveCheckWaiting[]): string {
  if (waiting.length === 0) return '';
  const items = waiting.map((c) => `${c.key} ${c.issueId} on ${c.version}: ${waitWhy(c.waits)}`);
  return ` ${waiting.length} live verdict${agrees(waiting.length, '', 's')} a shipped release owes ${agrees(waiting.length, 'waits', 'wait')} on a person, not on you (${items.join('; ')}). Nothing here is yours to run until a person adds what each names or answers the question.`;
}
