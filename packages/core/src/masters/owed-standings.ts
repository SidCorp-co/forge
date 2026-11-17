import { agrees } from '../lib/plural.js';
import type { StandingActOwed } from './ports.js';

/**
 * ISS-1278: every open issue, requirement, feedback item and workflow whose standing waits on the
 * master is yours, named with its act; the standing read holds what each one is and its door.
 */
export function standingActsLine(acts: readonly StandingActOwed[]): string {
  if (acts.length === 0) return '';
  const named = acts.map((a) => `${a.subject.key}: ${a.act}`).join('; ');
  return ` ${acts.length} item${agrees(acts.length, '', 's')} ${agrees(acts.length, 'waits', 'wait')} on you by ${agrees(acts.length, 'its', 'their')} standing (${named}): read each standing (\`forge-runner api projects/<projectId>/standings\`, its \`waitingOn\` names the act and its rule) and take the act, or record why it waits as a decision on the item.`;
}

/** Each act's identity in the work digest: the item and the act, so a new act on it moves the digest. */
export const standingActsWork = (acts: readonly StandingActOwed[]): string[] =>
  acts.map((a) => `standing-act:${a.subject.kind}:${a.subject.id}|${a.key}`);
