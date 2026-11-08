import { guideCall } from '../guides/index.js';
import { agrees } from '../lib/plural.js';

const method = `\`${guideCall('feedback-triage')}\``;

/**
 * The feedback items a master owes a triage (`feedback/owed-triage.ts:owedTriages`): a fresh one it
 * routes or proposes a route for, and one carrying a proposed triage where the project's policy
 * gives triage to the master (ISS-1132), its own work item, never a person's, which it accepts or
 * rejects.
 */
export function triagesLine(triages: readonly { key: string; proposed?: string | null }[]): string {
  const fresh = triages.filter((t) => !t.proposed).map((t) => t.key);
  const named = triages.filter((t) => t.proposed).map((t) => `${t.key} suggestion ${t.proposed}`);
  let line = '';
  if (fresh.length > 0) {
    line += ` ${fresh.length} feedback item${agrees(fresh.length, ' owes', 's owe')} a triage (${fresh.join(', ')}): read each (\`forge-runner api projects/<projectId>/feedback/<key>\`, and \`/similar\` for its nearest), then route it (\`forge-runner api projects/<projectId>/feedback/<key>/triage -X POST\`) or propose a \`feedback_triage\` suggestion (\`forge-runner api projects/<projectId>/suggestions -X POST\`); ${method} is how, and the forge-master skill's feedback section is when a master routes and when it proposes.`;
  }
  if (named.length > 0) {
    line += ` ${named.length} feedback item${agrees(named.length, ' carries', 's carry')} a proposed triage that is yours to decide (${named.join('; ')}): read the item and the suggestion, then accept it (\`forge-runner api projects/<projectId>/suggestions/<id>/accept -X POST\`) or reject it saying why (\`forge-runner api projects/<projectId>/suggestions/<id>/reject -X POST\`) and route the item yourself; ${method} is how.`;
  }
  return line;
}
