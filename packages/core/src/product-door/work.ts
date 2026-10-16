// Whether an agent is working on an issue now, read as the issue page reads it: the agent sessions
// attached to it (`issues/agent-sessions-hydrator.ts`).

import { hydrateAgentSessionsForIssues, issueDisplayIds } from '../issues/index.js';
import type { AgentState } from './progress.js';

export async function agentStatesOf(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, AgentState>> {
  const buckets = await hydrateAgentSessionsForIssues(projectId, issueIds);
  return new Map([...buckets].map(([id, b]) => [id, b.agentStatus]));
}

/** The keys of the issues among `issueIds` an agent is working on now. */
export async function runningKeysOf(
  projectId: string,
  issueIds: readonly string[],
): Promise<string[]> {
  const states = await agentStatesOf(projectId, issueIds);
  const running = [...states].filter(([, s]) => s === 'running').map(([id]) => id);
  const keys = await issueDisplayIds(running);
  return running.map((id) => keys.get(id) ?? id).sort();
}
