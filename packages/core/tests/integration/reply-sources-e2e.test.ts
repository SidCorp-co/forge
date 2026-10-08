import { beforeAll, describe, expect, it } from 'vitest';
import { agentReadsOf } from '../../src/messaging/agent-reads.js';
import type { DoorId } from '../../src/messaging/contract.js';
import { screenReplyAtDoor } from '../../src/messaging/reply-screen.js';
import { api } from '../helpers/api.js';
import { type World, world } from '../helpers/forecast-world.js';

// A figure read from the project status names that read, in Assistant and in Agent mode (REQ-30
// BC-1, BC-2): the status a real project answers over its route grounds the figure, the reply that
// names no read is held by figures-name-source, and the one that names the status is shown. In Agent
// mode the read is the session's `forge-runner api` call, mapped as the bridge maps it.

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The first whole number above 1 the body holds, a figure the status itself returned. */
function countIn(body: unknown): number | null {
  if (typeof body === 'number') return Number.isInteger(body) && body > 1 ? body : null;
  const values = Array.isArray(body) ? body : isRecord(body) ? Object.values(body) : [];
  for (const v of values) {
    const found = countIn(v);
    if (found !== null) return found;
  }
  return null;
}

describe('a figure from the project status names its read', () => {
  let w: World;
  let status: string;
  let n: number;

  beforeAll(async () => {
    w = await world();
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/status`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    status = JSON.stringify(res.body);
    const found = countIn(res.body);
    expect(found, 'the forecast world holds a count above 1 in its status').not.toBeNull();
    n = found ?? 0;
  }, 120_000);

  const assistant = (text: string) =>
    screenReplyAtDoor('web-chat-reply', {
      projectId: w.projectId,
      segments: [text],
      toolCalls: [{ name: 'forge_project_status', arguments: '{}' }],
      offeredTools: ['forge_project_status', 'forge_report'],
      progress: null,
      toolResults: [status],
      namedResults: [{ name: 'forge_project_status', text: status }],
      question: 'Where does the project stand?',
    });

  const agent = (text: string) => {
    const reads = agentReadsOf([
      {
        name: 'Bash',
        input: { command: `forge-runner api projects/${w.projectId}/status` },
        output: status,
      },
    ]);
    return screenReplyAtDoor('web-agent-completion', {
      projectId: w.projectId,
      segments: [text],
      toolCalls: reads.map((r) => ({ name: r.name, arguments: r.arguments })),
      offeredTools: reads.map((r) => r.name),
      progress: null,
      toolResults: [status],
      namedResults: reads,
      question: 'Where does the project stand?',
    });
  };

  const rules = async (v: ReturnType<typeof assistant>) => {
    const verdict = await v;
    return verdict.ok ? [] : verdict.refusals.map((r) => r.rule);
  };

  it.each([
    ['web-chat-reply', 'Assistant'],
    ['web-agent-completion', 'Agent'],
  ] as [DoorId, string][])('%s (%s mode)', async (door) => {
    const screen = door === 'web-chat-reply' ? assistant : agent;
    expect(await rules(screen(`There are ${n} issues in all.`))).toEqual(['figures-name-source']);
    expect(await rules(screen(`There are ${n} issues in all (project status).`))).toEqual([]);
    expect(await rules(screen('There are 987654 issues in all (project status).'))).toEqual([
      'figures-grounded',
    ]);
  });
});
