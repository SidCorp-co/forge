import { guideCall } from '../guides/index.js';
import type { AgentConfirmOwed } from './ports.js';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The door the master settles an item through for its agent reporter (ISS-880): the Forge door for
 * an item about Forge, which admits the master of the project the item was reported from
 * (`feedback/reporter-master.ts`); its own project's door for an item that sits there, where the
 * master is a member. An item sitting in any other project is no door of the master's, so its line
 * names the reporter that owes it instead of a command that would be refused.
 */
const confirmDoor = (c: AgentConfirmOwed): string | null => {
  if (c.home) return `forge-runner api forge/feedback/${c.key}/verify -X POST`;
  if (c.itemProjectId === c.reportedFrom)
    return `forge-runner api projects/${c.itemProjectId}/feedback/${c.key}/verify -X POST`;
  return null;
};

/** ISS-902: an item whose wait ended is named again once it ends, saying how, so the master knows why it is back. */
const WAIT_ENDED = {
  met: ', its wait ended: the room message came',
  withdrawn: ', its wait ended: the fix was reopened',
  lapsed: ', its wait ended: its date passed',
} as const;

const listed = (c: AgentConfirmOwed): string => {
  const door = confirmDoor(c);
  const ended = c.waitEnded ? WAIT_ENDED[c.waitEnded] : '';
  return door
    ? `${c.key} from ${c.reporter}${ended}, \`${door}\``
    : `${c.key} from ${c.reporter}${ended}, which only ${c.reporter} settles: it sits in project ${c.itemProjectId}, no door of yours`;
};

/** REQ-66 BC-8: an agent reporter has no bell, so the master that acts for it is asked to confirm. */
export function confirmsLine(confirms: readonly AgentConfirmOwed[]): string {
  if (confirms.length === 0) return '';
  return ` ${confirms.length} shipped feedback item${plural(confirms.length, ' an agent of this project reported owes its', 's agents of this project reported owe their')} confirm (${confirms.map(listed).join('; ')}): each one's fix shipped and the item waits on the agent that reported it. Check on the running build what each reported, then confirm it for that agent with what you ran and saw (\`-d '{"evidence":"<what you ran and saw>"}'\` on the Forge door, \`{"note":…}\` on a project's), or reopen it the same way with \`/reopen\` (\`reason\` on a project's door) where it is not fixed. Where only a later event can test it, set a wait on it the same way with \`/confirm-wait\` (\`-d '{"until":"<ISO date>","on":"room_message","reason":"<why it waits>"}'\`, \`on\` optional): it leaves this line until the date passes or the event happens, and the item shows why it waits; \`${guideCall('feedback-triage')}\` (verify and reopen) is how.`;
}
