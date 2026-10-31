import { guideCall } from '../guides/index.js';
import type { AgentConfirmOwed } from './ports.js';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The door an item's reporter confirms it through: the Forge door for an item about Forge, else its own project's. */
const confirmDoor = (c: AgentConfirmOwed) =>
  c.home
    ? `forge-runner api forge/feedback/${c.key}/verify -X POST`
    : `forge-runner api projects/${c.itemProjectId}/feedback/${c.key}/verify -X POST`;

/** REQ-66 BC-8: an agent reporter has no bell, so the master that acts for it is asked to confirm. */
export function confirmsLine(confirms: readonly AgentConfirmOwed[]): string {
  if (confirms.length === 0) return '';
  const items = confirms.map((c) => `${c.key} from ${c.reporter}, \`${confirmDoor(c)}\``);
  return ` ${confirms.length} shipped feedback item${plural(confirms.length, ' an agent of this project reported owes its', 's agents of this project reported owe their')} confirm (${items.join('; ')}): each one's fix shipped and the item waits on the agent that reported it. Check on the running build what each reported, then confirm it as that account with what you ran and saw (\`-d '{"evidence":"<what you ran and saw>"}'\` on the Forge door, \`{"note":…}\` on a project's), or reopen it the same way with \`/reopen\` (\`reason\` on a project's door) where it is not fixed; \`${guideCall('feedback-triage')}\` (verify and reopen) is how.`;
}
