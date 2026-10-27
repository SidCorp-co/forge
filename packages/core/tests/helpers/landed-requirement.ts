/**
 * An agreed requirement on the landing world (`landed-world.ts`), its issues traced to its business
 * criteria, and its standing read back through the requirement route, for the coverage tests of a
 * project whose landing is its delivery.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { api } from './api.js';
import { makeAgreeReady } from './factories.js';
import { ok, world } from './landed-world.js';

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(world.token, method, `/api/projects/${world.projectId}${path}`, body);

/** A requirement agreed at revision 1 over `bodies`, as BC-1, BC-2 and so on; its key. */
export async function agreedRequirement(
  bodies: readonly string[] = ['One command builds the local test databases'],
): Promise<string> {
  const created = await ok(
    onProject('POST', '/requirements', {
      title: 'Local test databases',
      reason: 'planted',
      criteria: bodies.map((body) => ({ body })),
    }),
  );
  const key = String(created.key);
  await makeAgreeReady(world.projectId, Number(key.slice(4)), world.ownerId);
  await ok(onProject('POST', `/requirements/${key}/revisions/1/propose`, {}));
  await ok(onProject('POST', `/requirements/${key}/revisions/1/accept`, {}));
  await ok(
    onProject('POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    }),
  );
  return key;
}

/** Links ISS-`seq` to `req` and traces each of its criteria `n` to the business criterion named. */
export async function traced(
  req: string,
  issueId: string,
  seq: number,
  traces: Readonly<Record<number, string>> = { 1: 'BC-1' },
): Promise<void> {
  await ok(onProject('POST', `/requirements/${req}/issues`, { issue: `ISS-${seq}` }));
  for (const [n, code] of Object.entries(traces)) {
    await db.execute(sql`
      UPDATE issue_criteria SET requirement_criterion_id = (
        SELECT rc.id FROM requirement_criteria rc JOIN requirements r ON r.id = rc.requirement_id
         WHERE r.project_id = ${world.projectId} AND r.req_seq = ${Number(req.slice(4))}
           AND rc.code = ${code} AND rc.retired_revision IS NULL
         LIMIT 1)
       WHERE issue_id = ${issueId} AND n = ${Number(n)}
    `);
  }
}

/** A steward's reopen of the issue, recorded now: every verdict before it predates the reopen. */
export async function reopenedNow(issueId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type,
                                    actor_agency, source, created_at)
    VALUES (${randomUUID()}, 'issue', ${issueId}, 'awaiting_release', 'reopen', 'system', 'agent',
            'fixture', clock_timestamp() + interval '1 second')
  `);
}

export type Bc = {
  code: string;
  verdict: string;
  why: string | null;
  issues: Array<{ notCounted: string | null; identity: string | null }>;
};

export type RequirementRead = {
  standing: {
    coverage: Bc[];
    delivery: { criteriaCoverage: Record<string, number> };
  };
  issues: Array<{
    displayId: string;
    shippedIn: unknown;
    landedIn: { branch: string; commit: string; at: string } | null;
  }>;
};

export const requirementRead = async (req: string) =>
  (await ok(onProject('GET', `/requirements/${req}`))) as unknown as RequirementRead;

export async function bcOf(req: string, code = 'BC-1'): Promise<Bc> {
  return (await requirementRead(req)).standing.coverage.find((c) => c.code === code) as Bc;
}

export const checklistsOf = async (req: string) =>
  (await ok(onProject('GET', `/requirements/${req}/checklist`))) as unknown as {
    checklists: Array<{ id: string; now: unknown }>;
  };
