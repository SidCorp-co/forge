import { gateSays, type ResolvedGate } from '@forge/contracts/gate-profiles';
import { RELEASE_ROSTER_LIMIT } from '@forge/contracts/releases';
import {
  type IssueCriteriaReport,
  issueDisplayIds,
  UNWEIGHED,
  unearnedCriteriaReports,
  type Weighing,
} from '../issues/index.js';
import { gateOf } from '../project-config/index.js';
import { attempt, blocker, evaluate } from './blocker-kit.js';
import {
  type HeldIssueRef,
  heldBackWarningSentence,
  type ReleaseBlocker,
  type ReleaseWarning,
  uncorroboratedWarningSentence,
} from './blocker-sentences.js';
import { criteriaBasisOf, landingCriteriaReports } from './criteria-basis.js';
import { productionDeploysOnLand } from './production-trigger.js';
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
  weighing: Weighing | string = UNWEIGHED,
): Promise<void> {
  // The roster limit bounds the per-issue comment reads below; above it
  // `RELEASE_ROSTER_OVERSIZE` is already the reason standing.
  if (waiting.length === 0 || waiting.length > RELEASE_ROSTER_LIMIT) return;
  // gate `release_criteria` (REQ-76): off owes nothing, advise warns where enforce holds (BC-7)
  const gate = await evaluate(
    'criteria-gate',
    async () => await gateOf(projectId, 'release_criteria'),
    out,
  );
  if (!gate || gate.mode === 'off') return;
  const auto = await evaluate(
    'auto-release',
    async () => await productionDeploysOnLand(projectId),
    out,
  );
  if (auto !== true) return;
  // Where a promotion stands between the landing and production, what production serves cannot
  // hold the change before its release: criteria are weighed at each issue's landing (sidcorp-mail).
  const basis = await evaluate('criteria-basis', async () => await criteriaBasisOf(projectId), out);
  if (!basis) return;
  if (basis.kind === 'unread') {
    const detail = `where this project's criteria are earned could not be read: ${basis.why}`;
    out.push(blocker('RELEASE_CHECK_UNEVALUATED', { check: 'criteria', detail }));
    return;
  }
  if (basis.kind === 'landing') {
    const reports = await evaluate(
      'criteria',
      async () => await landingCriteriaReports(projectId, waiting),
      out,
    );
    if (reports) await heldOrWarned(waiting, reports, out, warnings, null, gate);
    return;
  }
  // This enumerator reaches no network, so the ONE reading for the roster is the caller's.
  if (!serving) {
    out.push(blocker('RELEASE_CHECK_UNEVALUATED', { check: 'criteria', detail: NO_READING }));
    return;
  }
  // The caller's weighing read failed, and saying so beats weighing by equality as if it had not.
  if (typeof weighing === 'string') {
    const detail = `the weighing beside the serving reading could not be read: ${weighing}`;
    out.push(blocker('RELEASE_CHECK_UNEVALUATED', { check: 'criteria', detail }));
    return;
  }
  const reports = await evaluate(
    'criteria',
    async () => await unearnedCriteriaReports(waiting, serving, weighing),
    out,
  );
  if (!reports) return;
  await uncorroboratedWarning(reports, serving, warnings);
  await heldOrWarned(waiting, reports, out, warnings, serving, gate);
}

/**
 * Every waiting issue owing a criterion blocks; some of them warns. `serving` is the reading they were
 * weighed against, or null where they were weighed at their landing.
 */
async function heldOrWarned(
  waiting: readonly string[],
  reports: ReadonlyArray<{ issueId: string; unearned: ReadonlyArray<{ criterion: number }> }>,
  out: ReleaseBlocker[],
  warnings: ReleaseWarning[],
  serving: ServingReading | null,
  gate: ResolvedGate,
): Promise<void> {
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
  if (gate.mode === 'advise') {
    warnings.push({
      code: 'RELEASE_CRITERIA_HELD_BACK',
      message: `${heldBackWarningSentence(held, serving)} It is shipped anyway: ${gateSays(gate)}`,
      details: { held, advised: true, gate: gate.id, profile: gate.profile },
    });
    return;
  }
  if (owing.length === waiting.length) {
    // One project-level reason, not one per row, where no run could clear any of them (ISS-1346).
    if (serving?.kind === 'undeclared') {
      const { missing, route } = serving;
      out.push(blocker('RELEASE_RUNTIME_UNROUTED', { missing, route, held }, 'roster'));
      return;
    }
    out.push(blocker('RELEASE_CRITERIA_UNEARNED', { held }, 'roster'));
    return;
  }
  const route =
    serving?.kind === 'undeclared' ? { missing: serving.missing, route: serving.route } : {};
  warnings.push({
    code: 'RELEASE_CRITERIA_HELD_BACK',
    message: heldBackWarningSentence(held, serving),
    details: { held, ...route },
  });
}
