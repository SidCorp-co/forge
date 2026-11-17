import { agrees } from '../lib/plural.js';
import { decisionDoors } from './decision-doors.js';
import type { StewardAsk } from './ports.js';

/** What an ask says, with each item a decision on answers it (ISS-739: the stuck item, or the blocker it asks about). */
const askWithItems = (a: StewardAsk) =>
  `${a.ask} [a decision on ${a.answeredOn.map((i) => i.key).join(' or ')} answers it]`;

/** REQ-48 BC-5: the durable half of a steward wake, so a wake the box missed is read on its next sweep. */
export function stewardAsksLine(asks: readonly StewardAsk[]): string {
  if (asks.length === 0) return '';
  const kinds = decisionDoors(asks.flatMap((a) => a.answeredOn));
  return ` The project's steward asks you to act on ${asks.length} item${agrees(asks.length, '', 's')} (${asks.map(askWithItems).join('; ')}): read each item's standing (\`forge-runner api projects/<projectId>/standings\`) and take the act it waits on, or record why it waits as a decision on an item that answers it, at its own door: ${kinds.join('; ')} (other text there is a condition, held until the standing moves); the ask stands until the item's standing moves or such a decision answers it, one with a date until that date.`;
}
