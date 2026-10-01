/** The words of a criteria hold (ISS-1215); `release-hold.ts` writes them onto the row. */

import type { IssueCriteriaReport } from '../issues/criteria-verdicts.js';
import type { OwedRuntimes } from '../issues/runtime-standing.js';
import { type ServingReading, servingClause } from '../release-batch/serving-reading.js';
import type { RuntimeReading } from '../release-batch/weighing.js';
import type { ReleaseHold } from './release-hold.js';

function criteriaNamed(numbers: readonly number[]): string {
  if (numbers.length === 1) return `criterion ${numbers[0]}`;
  return `each of criteria ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
}

/** One clause per distinct reason, carrying every criterion it holds, in first-criterion order. */
function reasonsByWhy(report: IssueCriteriaReport): string {
  const byWhy = new Map<string, number[]>();
  for (const c of report.unearned) byWhy.set(c.why, [...(byWhy.get(c.why) ?? []), c.criterion]);
  return [...byWhy].map(([why, numbers]) => `${criteriaNamed(numbers)}: ${why}`).join('; ');
}

/** What one declared runtime was read as running, for the judge clause (ISS-1368). A runtime
 *  nothing reports carries the route that opens it, since that route releases the row unaided. */
function runtimeClause(runtime: RuntimeReading): string {
  const { serving } = runtime;
  const read =
    serving.kind === 'serving'
      ? servingClause(serving)
      : serving.kind === 'unreadable'
        ? `nothing could be read, read at ${serving.readAt}: ${serving.why}`
        : `nothing reports it: ${serving.missing} — ${serving.route} on a build that carries this change, and the next sweep weighs it again with no new verdict`;
  return `the \`${runtime.name}\` runtime, under ${runtime.paths.map((p) => `\`${p}\``).join(', ')}: ${read}`;
}

function declaredClause(runtimes: readonly RuntimeReading[]): string {
  const where =
    runtimes.length === 1
      ? `the \`${runtimes[0]?.name}\` runtime is`
      : "each runtime this issue's change runs in is";
  return `record a verdict on each criterion named, judged at a build ${where} running — ${runtimes.map(runtimeClause).join('; ')}`;
}

/**
 * Where a verdict has to be judged to count — the one place the reading is said (ISS-1346) — for
 * the runtimes this issue owes and no other (ISS-1368): naming a runtime the change does not run in
 * sends a person to look at it for nothing.
 */
function judgeClause(serving: ServingReading, owed: OwedRuntimes): string {
  const runtimes = owed.declared;
  if (runtimes.length === 0) return deploymentClause(serving);
  if (!owed.deployment) return declaredClause(runtimes);
  if (serving.kind === 'serving') {
    return (
      "record a verdict on each criterion named, judged at a commit each runtime this issue's " +
      `change runs in is running — the deployment: ${servingClause(serving)}; ` +
      runtimes.map(runtimeClause).join('; ')
    );
  }
  // The allowance below is the deployment's: a declared runtime with nothing read still holds.
  return (
    `${deploymentClause(serving)}. A criterion held in a declared runtime earns only at a build it ` +
    `is running — ${runtimes.map(runtimeClause).join('; ')}`
  );
}

function deploymentClause(serving: ServingReading): string {
  if (serving.kind === 'serving') {
    return (
      'record a verdict on each criterion named, judged at a commit this project is serving — ' +
      servingClause(serving)
    );
  }
  if (serving.kind === 'unreadable') {
    const asked = serving.hosts.length === 0 ? '' : ` (read from ${serving.hosts.join(', ')})`;
    return (
      `nothing could be read from what this project answers through${asked}, read at ` +
      `${serving.readAt}: ${serving.why}. Record a verdict on each criterion named — a verdict ` +
      'nothing could check still earns the criterion, and this sentence is why it reads as weaker'
    );
  }
  return (
    `nothing here can read what this project is serving: ${serving.missing}. To give it a way, ` +
    `${serving.route}, then record a verdict on each criterion named`
  );
}

function waitingForVerdicts(owed: OwedRuntimes): string {
  if (owed.declared.length === 0) {
    return 'a verdict on each criterion named at the running deployment, or the issue closed by hand';
  }
  const at = owed.deployment ? 'at the running deployment and ' : '';
  return (
    `a verdict on each criterion named ${at}at what the declared runtime it is held in runs, one of ` +
    "this project's runners reporting a build that carries the change, or the issue closed by hand"
  );
}

/**
 * Owed by a person: nothing dispatched claims a row at `awaiting_release`, and the release that
 * would is the one holding it, so every act that moves the row from here is somebody's by hand.
 */
export function criteriaHold(report: IssueCriteriaReport): ReleaseHold {
  const reasons = reasonsByWhy(report);
  const judge = judgeClause(report.serving, report.owed);
  return {
    code: 'RELEASE_CRITERIA_UNEARNED',
    reason:
      `The automatic release carries only an issue whose every acceptance criterion is earned, and ` +
      `this one is not — ${reasons}. A person clears this: ${judge}; or, having seen ` +
      'the change running in production, close the issue by hand; or move it out of ' +
      '`awaiting_release` if it is not to ship.',
    owes: 'human',
    waitingFor: waitingForVerdicts(report.owed),
  };
}
