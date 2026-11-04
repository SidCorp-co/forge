/**
 * The warnings the release's criteria hold gives beside its blockers (`criteria-hold.ts`): criteria
 * earned on a runtime nothing could re-read, issues held back or carried owing a criterion, and
 * live-only criteria judged after the release (ISS-957). `blocker-sentences.ts` owns every blocker's
 * sentence and the costs each reason adds.
 */

import { agrees, counted } from '../lib/plural.js';
import { type HeldIssueRef, heldIssuesSentence, withCosts } from './blocker-sentences.js';
import type { ServingReading } from './serving-reading.js';

export function uncorroboratedWarningSentence(held: HeldIssueRef[], why: string): string {
  const issues = counted(held.length, 'issue');
  const each = held
    .map(
      (h) =>
        `\`${h.displayId}\` on ${agrees(h.criteria.length, 'criterion', 'criteria')} ${h.criteria.join(', ')}`,
    )
    .join('; ');
  return withCosts(
    'RELEASE_CRITERIA_UNCORROBORATED',
    `${issues} ${agrees(held.length, 'carries', 'carry')} a criterion earned at a runtime nothing here could re-read: ${why} Those verdicts count — absence of a reading is not a failure — and they are weaker evidence than a reading would have made them. Whether each issue ships is decided by its own criteria, not by this. ${each}.`,
  );
}

/**
 * Live-only criteria the release carries unjudged (ISS-957): where production names no commit it
 * serves, only the running product shows them, so they are judged on the release once it ships.
 */
export function afterReleaseWarningSentence(held: HeldIssueRef[]): string {
  const each = held
    .map(
      (h) =>
        `\`${h.displayId}\` ${agrees(h.criteria.length, 'criterion', 'criteria')} ${h.criteria.join(', ')}`,
    )
    .join('; ');
  return withCosts(
    'RELEASE_CRITERIA_AFTER_RELEASE',
    `Judged after this release: only the running product shows these criteria, so they hold nothing now and are owed on this release once it ships, as a \`release\` verdict naming it; a fail there is a finding like any other. ${each}.`,
  );
}

/** Where nothing can read what the project serves, no judging run earns a criterion, so the remedy
 *  is the project's route and not a verdict (ISS-1346, judge r2 finding 1). */
export function heldBackWarningSentence(
  held: HeldIssueRef[],
  serving: ServingReading | null,
): string {
  const issues = counted(held.length, 'issue');
  const lead = `A release will still be cut, without ${issues} the sweep is holding back`;
  const why =
    serving?.kind === 'undeclared'
      ? `${lead}: each owes an acceptance criterion, and nothing here can read what this project is serving, so no judging run can earn one until the project can be read. What is missing: ${serving.missing}. The way to give it one: ${serving.route}.`
      : `${lead}: each still owes a judging run on an acceptance criterion, and stays at the gate until it is earned.`;
  return withCosts('RELEASE_CRITERIA_HELD_BACK', heldIssuesSentence(why, held));
}

/**
 * The warning gate `release_criteria` gives where it advises (REQ-76 BC-7): the sweep carries every
 * one of these issues, so the sentence says they ship owing their criteria, never that they are held.
 */
export function advisedCriteriaWarningSentence(
  held: HeldIssueRef[],
  serving: ServingReading | null,
  gateLine: string,
): string {
  const lead = `${counted(held.length, 'issue')} ${held.length === 1 ? 'ships' : 'ship'} in this release still owing an acceptance criterion's judging run, and the release names each`;
  const why =
    serving?.kind === 'undeclared'
      ? `${lead}; nothing here can read what this project is serving, so no judging run can earn one until it can. What is missing: ${serving.missing}. The way to give it one: ${serving.route}.`
      : `${lead}; a judging run still earns each after it ships.`;
  return `${heldIssuesSentence(why, held)} ${gateLine}`;
}
