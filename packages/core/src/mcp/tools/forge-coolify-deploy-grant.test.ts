/**
 * ISS-1071 — the agent boundary for Coolify: which verbs the grant gates, and which it does not.
 *
 * Coolify is core-mediated. Core holds the API token and performs the deploy, so the SAME binding
 * backs both an agent asking for a deploy and the release pipeline running one for a human. The
 * grant answers only the first question, which is why it is checked here, in the agent's tool, and
 * NOT inside `activeCoolifyIntegrations` — that resolver is shared with `integrations/coolify/
 * routes.ts`, the REST surface a human's own Deploy button goes through, and a gate there would let
 * an ungranted binding block a release nobody asked an agent about.
 *
 * A file of its own rather than a describe in `forge-coolify-deploy.test.ts` because `vi.mock` is
 * per-module and cannot move to a `.fixture.ts`: the two files share a shape, not a harness.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePrincipal } from '../fake-principal.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const resultQueue: unknown[] = [];
// Every predicate handed to `.where()`, kept so a test can assert on the query the subject BUILDS
// and not only on the rows this stub chose to hand back. Without this the stub answers the queued
// row whatever it is asked, and a gate added inside the shared resolver reads as a pass.
const whereArgs: unknown[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal chainable drizzle stub
function makeThenable(): any {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const p: any = {
    from: () => p,
    innerJoin: () => p,
    leftJoin: () => p,
    where: (...args: unknown[]) => {
      whereArgs.push(...args);
      return p;
    },
    orderBy: () => p,
    limit: () => p,
    then: (resolve: (v: unknown) => void) => resolve(resultQueue.shift() ?? []),
  };
  return p;
}
vi.mock('../../db/client.js', () => ({ db: { select: vi.fn(() => makeThenable()) } }));

const tryDispatchSpy = vi.fn();
const dispatchDirectSpy = vi.fn();
vi.mock('../../pipeline/release-coolify.js', () => ({
  tryDispatchCoolifyRelease: (a: unknown) => tryDispatchSpy(a),
  resolveLatestIssueRunId: vi.fn(),
  dispatchCoolifyDeployDirect: (a: unknown) => dispatchDirectSpy(a),
  isIssueAtReleaseStage: vi.fn(),
}));

const { forgeCoolifyDeployTool } = await import('./forge-coolify-deploy.js');
const { activeCoolifyIntegrations } = await import('../../integrations/coolify/commands.js');
const { registerAllIntegrations } = await import('../../integrations/register-all.js');
registerAllIntegrations();

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const INT_ID = 'a1111111-1111-4111-8111-111111111111';
const OTHER_INT = 'a2222222-2222-4222-8222-222222222222';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

const fakePrincipal = makeFakePrincipal(DEVICE_ID, OWNER_ID);
const ctx = () => ({ principal: fakePrincipal, projectSlug: null });

function pair(agentAccess: string, id: string = INT_ID) {
  const base = { id, provider: 'coolify', active: true };
  return {
    binding: {
      ...base,
      role: 'deploy',
      stages: ['preview'],
      projectId: PROJECT_ID,
      config: {},
      agentAccess,
    },
    connection: { ...base, config: {}, lastHealthStatus: null, breakerOpenedAt: null },
  };
}

/** Membership, then the project's deploy bindings — the two reads the gate makes. */
function queue(agentAccess: string) {
  resultQueue.push([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
  resultQueue.push([pair(agentAccess)]);
}

beforeEach(() => {
  vi.clearAllMocks();
  resultQueue.length = 0;
});

describe('forge_coolify_deploy — the agent-access gate', () => {
  it('refuses a deploy against an ungranted binding, naming the switch', async () => {
    queue('none');
    await expect(
      forgeCoolifyDeployTool(ctx()).handler({ action: 'deploy', projectId: PROJECT_ID }),
    ).rejects.toThrow(/agent access is `none`/);
    // Refused BEFORE anything was dispatched — the point of a gate is that nothing happened.
    expect(dispatchDirectSpy).not.toHaveBeenCalled();
    expect(tryDispatchSpy).not.toHaveBeenCalled();
  });

  it('names the binding, so an operator knows which row to open', async () => {
    queue('none');
    const err = await forgeCoolifyDeployTool(ctx())
      .handler({ action: 'deploy', projectId: PROJECT_ID })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain(INT_ID);
  });

  it('gates cancel and rollback by the same switch a deploy is gated by', async () => {
    for (const action of ['cancel', 'rollback'] as const) {
      resultQueue.length = 0;
      queue('none');
      await expect(
        forgeCoolifyDeployTool(ctx()).handler({ action, projectId: PROJECT_ID }),
      ).rejects.toThrow(/agent access is `none`/);
    }
  });

  it('leaves `list` readable, so an agent can see WHY it was refused', async () => {
    // A gate an agent cannot see the other side of reads to it as a broken integration. `list`
    // reports rather than acts, so it stays open and the binding shows up ungranted.
    queue('none');
    const result = (await forgeCoolifyDeployTool(ctx()).handler({
      action: 'list',
      projectId: PROJECT_ID,
    })) as { integrations: unknown[] };
    expect(result.integrations).toHaveLength(1);
  });

  it('refuses an un-targeted action while ANY binding is ungranted, and says how to target one', async () => {
    // F1, found by review. `status` and `logs` without an integrationId read the project's WHOLE
    // Coolify set, so a gate that passed when SOME binding was granted handed the agent the
    // deliveries of one that was not — a per-binding switch degraded to a per-project one.
    resultQueue.push([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
    resultQueue.push([pair('all'), pair('none', OTHER_INT)]);
    const err = await forgeCoolifyDeployTool(ctx())
      .handler({ action: 'status', projectId: PROJECT_ID })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain(OTHER_INT);
    expect((err as Error).message).toContain('integrationId');
  });

  it('lets a granted binding deploy, so the gate is the grant and nothing else', async () => {
    queue('all');
    queue('all'); // again: the deploy branch re-reads membership and the bindings after the gate
    dispatchDirectSpy.mockResolvedValueOnce({
      dispatched: true,
      pendingHumanConfirm: false,
      integrationIds: [INT_ID],
    });
    await forgeCoolifyDeployTool(ctx()).handler({ action: 'deploy', projectId: PROJECT_ID });
    expect(dispatchDirectSpy).toHaveBeenCalledTimes(1);
  });
});

// Criteria 29 and 30 — the human's Deploy button and core's own release dispatch must still reach a
// binding an agent may not use. Both go through `activeCoolifyIntegrations`, and until now the only
// thing saying so was the ABSENCE of a gate in it, which is what a later refactor deletes by
// accident: moving the check "down into the resolver where it belongs" is the obvious tidy-up, and
// it would make an ungranted binding block a release nobody asked an agent about.
// cm:guard this resolver is shared with `integrations/coolify/routes.ts` (REST) and
// `pipeline/release-coolify.ts`. It must NOT filter on `agentAccess`; the grant is checked in
// `forge-coolify-deploy.ts`, which is the only door an agent comes through.
/**
 * Walks a drizzle SQL expression for a reference to one physical column. Used to assert on the
 * query the subject builds rather than on the rows the stub returns.
 */
function mentionsColumn(node: unknown, column: string): boolean {
  if (node === null || typeof node !== 'object') return false;
  const n = node as { name?: unknown; queryChunks?: unknown };
  if (typeof n.name === 'string' && n.name === column) return true;
  return Array.isArray(n.queryChunks) && n.queryChunks.some((c) => mentionsColumn(c, column));
}

describe('activeCoolifyIntegrations — the shared resolver is not the gate', () => {
  it('returns an ungranted binding, so a person and the release pipeline still deploy it', async () => {
    resultQueue.push([pair('none')]);
    const rows = await activeCoolifyIntegrations(PROJECT_ID);
    expect(rows.map((r) => r.id)).toEqual([INT_ID]);
    expect(rows[0]?.pair.binding.agentAccess).toBe('none');
  });

  // The case above cannot fail on its own: the stub returns the queued row whatever the query
  // asks for, so moving the grant INTO the resolver as an `agent_access = 'all'` predicate would
  // leave it green while a human's Deploy button silently lost that binding. This one reads the
  // predicate the subject actually built. The `role` assertion is the control: it proves the
  // walker finds a column that IS filtered on, so the `agent_access` expectation is a measurement
  // and not a walker that returns false for everything.
  it('builds no agent_access predicate, so a gate moved in here goes red', async () => {
    whereArgs.length = 0;
    resultQueue.push([pair('none')]);
    await activeCoolifyIntegrations(PROJECT_ID);

    expect(whereArgs.length).toBeGreaterThan(0);
    expect(whereArgs.some((a) => mentionsColumn(a, 'role'))).toBe(true);
    expect(whereArgs.some((a) => mentionsColumn(a, 'agent_access'))).toBe(false);
  });
});
