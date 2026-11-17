import { guideCall } from '../guides/index.js';
import { agrees } from '../lib/plural.js';
import { mastersPorts } from './ports.js';

const method = `\`${guideCall('feedback-triage')}\``;
const masterGuide = `\`${guideCall('forge-master')}\``;

/** A feedback item owed a triage, and what the master's own credential may do about its proposal. */
export interface TriageOwed {
  key: string;
  /** The feedback_triage suggestion proposed on it, where one is. */
  proposed?: string | null;
  /** Accept that suggestion, or route the item itself (ISS-1273); absent where none is proposed. */
  act?: 'accept' | 'route';
}

/**
 * The feedback items a master owes a triage (`feedback/owed-triage.ts:owedTriages`), each carrying a
 * proposed triage kept only where the master's own credential can act on it (ISS-1273, as the release
 * naming is read since FB-164): it accepts where an account it acts as holds what the accept door
 * checks, routes the item itself where it holds only what routing takes, and is not named at all
 * where it holds neither, the item waiting on whoever can.
 */
export async function triagesTheMasterTakes(projectId: string): Promise<TriageOwed[]> {
  const ports = mastersPorts();
  const owed = await ports.triagesOwed(projectId);
  if (!owed.some((t) => t.proposed)) return owed;
  const act = await ports.proposedTriageAct(projectId);
  return owed.flatMap((t) => {
    if (!t.proposed) return [t];
    return act ? [{ ...t, act }] : [];
  });
}

/**
 * What the wake says of the items a master owes a triage: a fresh one it routes or proposes a route
 * for, and one carrying a proposed triage, which it accepts or rejects where its credential can
 * (ISS-1132), or routes itself where it can only route (ISS-1273).
 */
export function triagesLine(triages: readonly TriageOwed[]): string {
  const fresh = triages.filter((t) => !t.proposed).map((t) => t.key);
  const named = (act: TriageOwed['act']) =>
    triages
      .filter((t) => t.proposed && (t.act ?? 'accept') === act)
      .map((t) => `${t.key} suggestion ${t.proposed}`);
  const decides = named('accept');
  const routes = named('route');
  let line = '';
  if (fresh.length > 0) {
    line += ` ${fresh.length} feedback item${agrees(fresh.length, ' owes', 's owe')} a triage (${fresh.join(', ')}): read each (\`forge-runner api projects/<projectId>/feedback/<key>\`, and \`/similar\` for its nearest), then route it (\`forge-runner api projects/<projectId>/feedback/<key>/triage -X POST\`) or propose a \`feedback_triage\` suggestion (\`forge-runner api projects/<projectId>/suggestions -X POST\`); ${method} is how, and ${masterGuide}, its *Feedback owed a triage*, is when a master routes and when it proposes.`;
  }
  if (decides.length > 0) {
    line += ` ${decides.length} feedback item${agrees(decides.length, ' carries', 's carry')} a proposed triage that is yours to decide (${decides.join('; ')}): read the item and the suggestion, then accept it (\`forge-runner api projects/<projectId>/suggestions/<id>/accept -X POST\`) or reject it saying why (\`forge-runner api projects/<projectId>/suggestions/<id>/reject -X POST\`) and route the item yourself; ${method} is how.`;
  }
  if (routes.length > 0) {
    line += ` ${routes.length} feedback item${agrees(routes.length, ' carries', 's carry')} a proposed triage your credential cannot accept (it holds no suggestions.approve) (${routes.join('; ')}): read the item and the suggestion, then route the item yourself (\`forge-runner api projects/<projectId>/feedback/<key>/triage -X POST\`), taking the suggestion's route where it fits, which retires the proposal; ${method} is how.`;
  }
  return line;
}
