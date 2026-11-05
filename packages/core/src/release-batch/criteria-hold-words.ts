/**
 * The words of a criteria hold (ISS-1215): why the automatic release is not taking an issue whose
 * acceptance criteria are not earned, weighed at what is served (`criteriaHold`) or at the landing
 * (`landingCriteriaHold`, ISS-957), and what clears it. `hold.ts` is the table's one writer.
 */

import type { ReleaseHoldOwer } from '@forge/contracts/releases';
import type { IssueCriteriaReport, LandingHeld, RuntimeReading } from '../issues/index.js';
import { sameIdentity } from '../messaging/verdict-identity.js';
import {
  type LandingCriteriaReport,
  landingWhere,
  servedNamed,
  servingWhere,
} from './criteria-basis.js';
import type { ReleaseHold } from './hold.js';
import { type ServingReading, servingClause } from './serving-reading.js';
import type { ShippedRelease } from './shipped-releases.js';

function criteriaNamed(numbers: readonly number[]): string {
  if (numbers.length === 1) return `criterion ${numbers[0]}`;
  return `each of criteria ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
}

/** One clause per distinct reason, carrying every criterion it holds, in first-criterion order. */
function reasonsByWhy(report: {
  unearned: ReadonlyArray<{ criterion: number; why: string }>;
}): string {
  const byWhy = new Map<string, number[]>();
  for (const c of report.unearned) byWhy.set(c.why, [...(byWhy.get(c.why) ?? []), c.criterion]);
  return [...byWhy].map(([why, numbers]) => `${criteriaNamed(numbers)}: ${why}`).join('; ');
}

/** What one declared runtime was read as running, for the judge clause (ISS-1368). */
function runtimeClause(runtime: RuntimeReading): string {
  const { serving } = runtime;
  const read =
    serving.kind === 'serving'
      ? servingClause(serving)
      : serving.kind === 'unreadable'
        ? `nothing could be read, read at ${serving.readAt}: ${serving.why}`
        : `nothing reports it: ${serving.missing}`;
  return `the \`${runtime.name}\` runtime, under ${runtime.paths.map((p) => `\`${p}\``).join(', ')}: ${read}`;
}

/** Where a verdict has to be judged to count — the one place the reading is said (ISS-1346). */
function judgeClause(
  serving: ServingReading,
  runtimes: readonly RuntimeReading[],
  weighedOn: string | null,
): string {
  const deployment = deploymentClause(serving, runtimes, weighedOn);
  if (serving.kind === 'serving' || runtimes.length === 0) return deployment;
  // The allowance above is the deployment's: a declared runtime with nothing read still holds.
  return (
    `${deployment}. A criterion held in a declared runtime earns only at a build it is running — ` +
    runtimes.map(runtimeClause).join('; ')
  );
}

function deploymentClause(
  serving: ServingReading,
  runtimes: readonly RuntimeReading[],
  weighedOn: string | null,
): string {
  // an unreleased issue's runtime verdicts are weighed where it is judged (`delivery.judgedOn`)
  const project =
    weighedOn === null
      ? 'this project'
      : `\`${weighedOn}\`, the environment this project judges a change on until it is released,`;
  if (serving.kind === 'serving' && runtimes.length > 0) {
    return (
      'record a verdict on each criterion named, judged at a commit the runtime it is held in is ' +
      `running — the deployment: ${servingClause(serving)}; ${runtimes.map(runtimeClause).join('; ')}`
    );
  }
  if (serving.kind === 'serving') {
    return (
      `record a verdict on each criterion named, judged at a commit ${project} is serving — ` +
      servingClause(serving)
    );
  }
  if (serving.kind === 'unreadable') {
    const asked = serving.hosts.length === 0 ? '' : ` (read from ${serving.hosts.join(', ')})`;
    return (
      `nothing could be read from what ${weighedOn === null ? 'this project' : `\`${weighedOn}\``} answers through${asked}, read at ` +
      `${serving.readAt}: ${serving.why}. Record a verdict on each criterion named — a verdict ` +
      'nothing could check still earns the criterion, and this sentence is why it reads as weaker'
    );
  }
  return (
    `nothing here can read what ${project} is serving: ${serving.missing}. To give it a way, ` +
    `${serving.route}, then record a verdict on each criterion named`
  );
}

/**
 * Who clears a criteria hold (REQ-79 r6 BC-17): the project's master outside strict, which records the
 * verdicts or moves the issue on; a person on a strict project, where nothing dispatched claims a row
 * at `awaiting_release` and every act that moves it from here is somebody's by hand.
 */
export type CriteriaHoldOwer = ReleaseHoldOwer;

const clearer = (owes: CriteriaHoldOwer) =>
  owes === 'human' ? 'A person clears this' : "The project's master clears this";

/**
 * What a served-basis hold reads from Forge's records beside the report (ISS-997): the releases it
 * recorded shipping, to say what a served commit is, and the release drafted from what waits at the
 * gate, which carries an issue production does not hold yet.
 */
export interface ServedRecords {
  readonly releases: readonly ShippedRelease[];
  readonly draft: string | null;
}

const NO_RECORDS: ServedRecords = { releases: [], draft: null };

/** The release that carries an issue production does not hold yet, by name, never a commit. */
function carrierOf(draft: string | null): string {
  return draft === null
    ? 'the next release cut with it'
    : `release ${draft}, drafted from what waits at the gate`;
}

// a start naming its roster is never weighed for criteria (`blockers.ts:gatedBlockers`)
const RIDES =
  'The automatic release carries only an issue whose every criterion is earned, so it leaves this one ' +
  'at the gate; a release started naming it in its roster (`POST /api/projects/:id/release-batches` ' +
  'with `issueIds`) is not weighed for criteria and can carry it';

/** The reading narrowed to the served commits that hold the landing: the only ones a verdict counts at. */
function holding(serving: ServingReading, at: readonly string[]): ServingReading {
  if (serving.kind !== 'serving') return serving;
  const served = serving.served.filter((s) =>
    at.some((a) => sameIdentity(a, s.commit, { abbreviating: true })),
  );
  return served.length === 0 ? serving : { ...serving, served };
}

/**
 * Where a verdict counts, by what the reading holds of the landing (ISS-997): at a served commit only
 * where it holds the landing; where none does, after the release that carries it, named and no commit;
 * where nobody could say, why, by name, and how to check it, never a guess.
 */
function landingJudgeClause(
  report: IssueCriteriaReport,
  held: LandingHeld | undefined,
  draft: string | null,
): string {
  const { serving, runtimes, weighedOn } = report;
  if (!held || serving.kind !== 'serving') return judgeClause(serving, runtimes, weighedOn);
  if (held.kind === 'holds') return judgeClause(holding(serving, held.at), runtimes, weighedOn);
  const where = weighedOn === null ? 'production' : `\`${weighedOn}\``;
  const carrier = carrierOf(draft);
  if (held.kind === 'lacks') {
    return (
      `${where} serves no commit that holds this issue's landing yet (read from ${held.by}), so no ` +
      `verdict judged at what it serves now can be about this change: its criteria are owed after ` +
      `the release that carries it, ${carrier}, judged at what production serves once that release ` +
      `ships. ${RIDES}`
    );
  }
  const { landing } = held;
  const project = weighedOn === null ? 'this project' : `\`${weighedOn}\``;
  const check =
    landing === null
      ? ''
      : `; check it with git, \`git merge-base --is-ancestor ${landing} <served>\` for each commit it serves`;
  return (
    `whether what ${where} serves holds this issue's landing could not be read: ${held.why}, so no ` +
    `commit is named here to judge at. What ${project} is serving — ${servingClause(serving)} — ` +
    `counts only where it holds the landing${check}. Where it holds, record a verdict on each criterion ` +
    `named judged at that commit; where it does not, its criteria are owed after the release that ` +
    `carries it, ${carrier}. ${RIDES}`
  );
}

function servedWaitingFor(held: LandingHeld | undefined, owes: CriteriaHoldOwer): string {
  const byHand = owes === 'human' ? ', or the issue closed by hand' : '';
  if (held?.kind === 'lacks') {
    return `the release that carries it to ship, then a verdict on each criterion named${byHand}`;
  }
  if (held?.kind === 'unread') {
    return `a verdict on each criterion named at a served commit shown to hold its landing, or the release that carries it${byHand}`;
  }
  return `a verdict on each criterion named at the running deployment${byHand}`;
}

export function criteriaHold(
  report: IssueCriteriaReport,
  owes: CriteriaHoldOwer,
  records: ServedRecords = NO_RECORDS,
): ReleaseHold {
  const reasons = reasonsByWhy(report);
  // a project weighed on its release record is weighed at each landing (`landingCriteriaHold`, ISS-957)
  const held = report.landingHeld;
  const judge = landingJudgeClause(report, held, records.draft);
  // only a person closes by hand; the master clears it by the verdicts or by moving the issue on
  const byHand =
    owes === 'human'
      ? 'or, having seen the change running in production, close the issue by hand; '
      : '';
  const where = servingWhere(report.weighedOn, servedNamed(report.serving, records.releases));
  return {
    code: 'RELEASE_CRITERIA_UNEARNED',
    reason:
      `The automatic release carries only an issue whose every acceptance criterion is earned, and ` +
      `this one is not — ${reasons}. I${where.slice(1)}. ${clearer(owes)}: ${judge}; ${byHand}or move it out of ` +
      '`awaiting_release` if it is not to ship.',
    owes,
    waitingFor: servedWaitingFor(held, owes),
    criteria: report.unearned.map((c) => c.criterion),
  };
}

/**
 * A row weighed at its landing (`criteria-basis.ts`): where a promotion stands between the branch
 * work lands on and the one production deploys from, or production is deployed only by a release and
 * nothing the project judges on serves the change first (ISS-957, ISS-964), what production serves
 * cannot hold the change before its release, so a verdict counts at the landing commit, or on the
 * testing environment `delivery.judgedOn` names. Never a release that predates the change.
 */
export function landingCriteriaHold(
  report: LandingCriteriaReport,
  basis: Parameters<typeof landingWhere>[0],
  owes: CriteriaHoldOwer,
): ReleaseHold {
  const at = report.landing
    ? `judged at its landing commit \`${report.landing.slice(0, 12)}\` on \`${basis.landsOn}\``
    : `judged at the commit it landed at on \`${basis.landsOn}\`, once its merge names one`;
  // a live-only criterion is never earned at a commit: its own reason names the act (ISS-967)
  const landed = report.unearned.filter((c) => !c.liveOnly).map((c) => c.criterion);
  const running = report.unearned.filter((c) => c.liveOnly).map((c) => c.criterion);
  const acts = [
    ...(landed.length === 0
      ? []
      : [
          `record a verdict on ${running.length === 0 ? 'each criterion named' : criteriaNamed(landed)}, ${at} ` +
            '(or, where `delivery.judgedOn` names a testing environment, one judged there at that commit)',
        ]),
    ...(running.length === 0 ? [] : [liveOnlyAct(running)]),
  ];
  const live = report.afterRelease.map((c) => c.criterion);
  const after = live.length > 0 ? ` Not held: ${criteriaNamed(live)}, judged after release.` : '';
  return {
    code: 'RELEASE_CRITERIA_UNEARNED',
    reason:
      'The automatic release carries only an issue whose every acceptance criterion is earned, and ' +
      `this one is not — ${reasonsByWhy(report)}. T${landingWhere(basis).slice(1)}, so a criterion is earned ` +
      `where the change has landed, not where production is. ${clearer(owes)}: ${acts.join('; ')}; ` +
      `or move the issue out of \`awaiting_release\` if it is not to ship.${after}`,
    owes,
    waitingFor:
      landed.length === 0
        ? 'a verdict on each criterion named, where its reason says'
        : 'a verdict on each criterion named at its landing commit',
    criteria: report.unearned.map((c) => c.criterion),
  };
}

/** The act for criteria only the running product shows, which no verdict at a commit earns (ISS-967). */
function liveOnlyAct(numbers: readonly number[]): string {
  const one = numbers.length === 1;
  return `${criteriaNamed(numbers)}: only the running product shows ${one ? 'it' : 'them'}, so no verdict at a commit earns ${one ? 'it' : 'them'}; do what ${one ? 'its' : 'their'} reason above names`;
}
