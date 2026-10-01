import { type IssueCriteriaReport, unearnedCriteriaReports } from '../issues/criteria-verdicts.js';
import { issueDisplayIds } from '../issues/display-ids.js';
import { productionDeploysOnLand } from '../pipeline/production-trigger.js';
import { attempt, blocker, evaluate } from './blocker-kit.js';
import {
  type HeldIssueRef,
  heldBackWarningSentence,
  RELEASE_ROSTER_LIMIT,
  type ReleaseBlocker,
  type ReleaseWarning,
  uncorroboratedWarningSentence,
} from './blocker-sentences.js';
import { type ServingReading, whyUncorroborated } from './serving-reading.js';

const NO_READING =
  'no reading of what this project is serving was passed in, and this enumerator reaches no ' +
  'network of its own, so nothing could be weighed against what a runtime verdict names. The ' +
  'caller takes the reading and passes it as `serving`.';

/** A criterion earned on a runtime nothing could re-read passes, and says so (ISS-1286). */
async function uncorroboratedWarning(
  reports: readonly IssueCriteriaReport[],
  serving: ServingReading,
  warnings: ReleaseWarning[],
): Promise<void> {
  const weak = reports.filter((r) => r.uncorroborated.length > 0);
  if (weak.length === 0) return;
  const shown = await attempt('issue-display-ids', async () =>
    issueDisplayIds(weak.map((r) => r.issueId)),
  );
  const held: HeldIssueRef[] = weak.map((r) => ({
    issueId: r.issueId,
    displayId: shown.value?.get(r.issueId) ?? r.issueId,
    criteria: [...r.uncorroborated],
  }));
  warnings.push({
    code: 'RELEASE_CRITERIA_UNCORROBORATED',
    message: uncorroboratedWarningSentence(held, whyUncorroborated(serving)),
    details: { held },
  });
}

/**
 * The reason the unattended sweep will not carry these issues, which reached
 * `logger.info` and no surface at all before ISS-1127. It mirrors
 * `sweepProject`: that function returns early only where NOTHING is left
 * eligible, so all-held blocks and partly-held warns. Roster-scoped.
 */
export async function criteriaHold(
  projectId: string,
  waiting: string[],
  out: ReleaseBlocker[],
  warnings: ReleaseWarning[],
  serving: ServingReading | undefined,
): Promise<void> {
  // The roster limit bounds the per-issue comment reads below; above it
  // `RELEASE_ROSTER_OVERSIZE` is already the reason standing.
  if (waiting.length === 0 || waiting.length > RELEASE_ROSTER_LIMIT) return;
  const auto = await evaluate(
    'auto-release',
    async () => await productionDeploysOnLand(projectId),
    out,
  );
  if (auto !== true) return;
  // This enumerator reaches no network, so the ONE reading for the roster is the caller's.
  if (!serving) {
    out.push(blocker('RELEASE_CHECK_UNEVALUATED', { check: 'criteria', detail: NO_READING }));
    return;
  }
  const reports = await evaluate(
    'criteria',
    async () => await unearnedCriteriaReports(waiting, serving),
    out,
  );
  if (!reports) return;
  await uncorroboratedWarning(reports, serving, warnings);
  const owing = reports.filter((r) => r.unearned.length > 0);
  if (owing.length === 0) return;
  // Beside the reason, never in front of it: a failed name read keeps the uuid.
  const shown = await attempt('issue-display-ids', async () =>
    issueDisplayIds(owing.map((r) => r.issueId)),
  );
  if (shown.failure) out.push(shown.failure);
  const held: HeldIssueRef[] = owing.map((r) => ({
    issueId: r.issueId,
    displayId: shown.value?.get(r.issueId) ?? r.issueId,
    criteria: r.unearned.map((c) => c.criterion),
  }));
  if (owing.length === waiting.length) {
    // One project-level reason, not one per row, where no run could clear any of them (ISS-1346).
    if (serving.kind === 'undeclared') {
      const { missing, route } = serving;
      out.push(blocker('RELEASE_RUNTIME_UNROUTED', { missing, route, held }, 'roster'));
      return;
    }
    out.push(blocker('RELEASE_CRITERIA_UNEARNED', { held }, 'roster'));
    return;
  }
  const route =
    serving.kind === 'undeclared' ? { missing: serving.missing, route: serving.route } : {};
  warnings.push({
    code: 'RELEASE_CRITERIA_HELD_BACK',
    message: heldBackWarningSentence(held, serving),
    details: { held, ...route },
  });
}
