import { agrees } from '../lib/plural.js';
import type { AgentAskOwed } from './ports.js';

/**
 * A room agent's asks waiting on this master (ISS-1243 items 14, 21): a person waits in each thread,
 * so they come first in the pass, and one past the bound is said as a breach.
 */
export function agentAsksLine(asks: readonly AgentAskOwed[] | undefined): string {
  if (!asks || asks.length === 0) return '';
  const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
  const named = asks.map(
    (a) =>
      `${a.id} from room ${a.rid} thread ${a.thread}, waiting ${minutes(a.waitedMs)} min${a.breached ? ', past the bound' : ''}: "${a.question}"`,
  );
  const breached = asks.filter((a) => a.breached).length;
  const breach =
    breached > 0
      ? ` ${breached} ${agrees(breached, 'has', 'have')} waited past the ${asks[0]?.boundMinutes ?? 0}-minute bound.`
      : '';
  return ` First, before any other work in this pass: a room agent waits on you, with a person waiting in its thread, for ${asks.length} ask${agrees(asks.length, '', 's')} (${named.join('; ')}).${breach} Answer each from what you know or can read now (\`forge-runner api projects/<projectId>/support/master-asks/<askId>/answer -X POST -d '{"answer":"…"}'\`): the answer goes back into that agent's session, which tells the person itself. Never post in the thread beside it.`;
}
