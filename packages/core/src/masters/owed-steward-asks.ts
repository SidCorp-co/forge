import { agrees } from '../lib/plural.js';
import type { StewardAsk } from './ports.js';

/**
 * The door that records a decision on an item of each kind, as the nudge names it (ISS-654): an
 * issue's `decision` record, or the decision comment a feedback item or a requirement takes. The
 * issue door answers 404 for any other kind, so each ask names the door of its own item.
 */
const DECISION_DOOR: Record<StewardAsk['subject']['kind'], (keys: string) => string> = {
  issue: (keys) =>
    `on an issue (${keys}), \`forge-runner api issues/<id>/events -X POST\` with the body \`{"kind":"decision","contract":1,"fields":[{"key":"decision","value":"…"},{"key":"why","value":"…"}]}\`, plus a field \`until\` only as an ISO 8601 date such as 2026-11-01`,
  feedback: (keys) =>
    `on a feedback item (${keys}), \`forge-runner api projects/<projectId>/feedback/<key>/comments -X POST\` with \`intent: decision\` and \`decision: { decision, reason }\`, plus \`reversedWhen\` only as an ISO 8601 date such as 2026-11-01`,
  requirement: (keys) =>
    `on a requirement (${keys}), \`forge-runner api projects/<projectId>/requirements/<key>/comments -X POST\` with \`intent: decision\` and \`decision: { decision, reason }\`, plus \`reversedWhen\` only as an ISO 8601 date such as 2026-11-01`,
  workflow: (keys) =>
    `on a workflow (${keys}), \`forge-runner api projects/<projectId>/workflows/<flow>/comments -X POST\` with \`intent: decision\` and \`decision: { decision, reason }\`, plus \`reversedWhen\` only as an ISO 8601 date such as 2026-11-01`,
};

/** What an ask says, with each item a decision on answers it (ISS-739: the stuck item, or the blocker it asks about). */
const askWithItems = (a: StewardAsk) =>
  `${a.ask} [a decision on ${a.answeredOn.map((i) => i.key).join(' or ')} answers it]`;

/** REQ-48 BC-5: the durable half of a steward wake, so a wake the box missed is read on its next sweep. */
export function stewardAsksLine(asks: readonly StewardAsk[]): string {
  if (asks.length === 0) return '';
  const items = asks.flatMap((a) => a.answeredOn);
  const kinds = (['issue', 'feedback', 'requirement', 'workflow'] as const).flatMap((kind) => {
    const keys = [...new Set(items.filter((i) => i.kind === kind).map((i) => i.key))];
    return keys.length > 0 ? [DECISION_DOOR[kind](keys.join(', '))] : [];
  });
  return ` The project's steward asks you to act on ${asks.length} item${agrees(asks.length, '', 's')} (${asks.map(askWithItems).join('; ')}): read each item's standing (\`forge-runner api projects/<projectId>/standings\`) and take the act it waits on, or record why it waits as a decision on an item that answers it, at its own door: ${kinds.join('; ')} (other text there is a condition, held until the standing moves); the ask stands until the item's standing moves or such a decision answers it, one with a date until that date.`;
}
