/**
 * ISS-1409 — one agent-marked issue whose project gives Forge no way to read its repository, read
 * back through every surface that reports a merge mark: the `forge_issues` `get` and `list` over a
 * loopback MCP client, and the REST detail and list routes. Each carries the mark as `asserted`
 * with the claimed commit; none reads it as a merge Forge observed. Real Postgres, the real list
 * service and the real projections, so a column a projection never selects reads null here.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { harness, rest, seedIssue, tool, useLandingHarness, world } from './landing-harness.js';

useLandingHarness();

const CLAIMED = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

async function agentMarkedIssue() {
  const w = await world('standard');
  await harness.db.execute(sql`UPDATE projects SET base_branch = 'main' WHERE id = ${w.projectId}`);
  const id = await seedIssue(w);
  await harness.db.execute(sql`UPDATE issues SET status = 'in_progress' WHERE id = ${id}`);
  // The agency of a token is its owner's kind: only an agent's commit mark is taken as a claim.
  await harness.db.execute(sql`UPDATE users SET kind = 'agent' WHERE id = ${w.userId}`);
  const marked = await tool(w.pat, {
    action: 'mark_merged',
    data: { issueId: id, target: 'base', commit: CLAIMED },
  });
  await harness.db.execute(sql`UPDATE users SET kind = 'human' WHERE id = ${w.userId}`);
  expect(marked.isError, marked.text).toBe(false);
  expect(marked.json().mark).toBe('asserted');
  return { w, id };
}

describe('the claim an agent mark leaves where no repository can be read', () => {
  it('is carried by forge_issues get, forge_issues list, the REST detail and the REST list', async () => {
    const { w, id } = await agentMarkedIssue();

    const got = (await tool(w.pat, { action: 'get', documentId: id })).json();
    const listed = (await tool(w.pat, { action: 'list', projectId: w.projectId, limit: 50 })).json()
      .issues as Array<Record<string, unknown>>;
    const detail = await (await rest('GET', `/api/issues/${id}`, w.token)).json();
    const page = await (await rest('GET', `/api/projects/${w.projectId}/issues`, w.token)).json();
    const restRow = (page.items as Array<Record<string, unknown>>).find((r) => r.id === id);

    const surfaces: Array<[string, Record<string, unknown> | undefined]> = [
      ['forge_issues get', got],
      ['forge_issues list', listed.find((r) => r.documentId === id)],
      ['REST detail', detail],
      ['REST list', restRow],
    ];
    for (const [name, row] of surfaces) {
      expect(row, `${name} returned no row for the issue`).toBeDefined();
      expect(row, name).toMatchObject({
        mergeMark: 'asserted',
        mergedCommitSha: null,
        mergedClaimedCommit: CLAIMED,
      });
    }
  });
});
