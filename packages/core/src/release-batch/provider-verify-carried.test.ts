// HOP 0.4.0 on dev (run 21460fb0): ISS-54 edited the shared access block inside workflow 193's
// draft, and 193 is ISS-110's referral graph — unbuilt, not in the roster, never published. The
// release was refused "ISS-54 landed workflow `193` ... and Autoflow publishes no version of
// workflow `193`", and the only ways out were publishing another issue's unfinished graph or
// deleting the entry by hand. A mark may say the artifact is carried by ISS-110: this release then
// reports it carried, and ISS-110's own release inherits and verifies it. The tracker rows and
// Autoflow's GraphQL door are planted; everything between them is the shipped read.

import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CriterionWithVerdict } from '../issues/index.js';
import { isRefusal } from '../lib/refusal.js';
import type { ReleaseChannel } from './plan.js';

interface Row {
  id: string;
  projectId: string;
  seq: number;
  status: string;
  mergedAt: Date | null;
  landing: string | null;
  artifacts: Array<{ surface: string; ref: string; change: string; carriedBy?: string }> | null;
}

const state = vi.hoisted(() => ({
  rows: [] as Row[],
  roster: [] as string[],
  published: {} as Record<string, string | null>,
  criteria: new Map<string, CriterionWithVerdict[]>(),
  queries: [] as string[],
}));

vi.mock('../db/client.js', async () => {
  const schema = await import('../db/schema.js');
  const workflows = await import('../db/schema-workflows.js');
  const dialect = new PgDialect();
  const read = (table: unknown, cols: Record<string, unknown> | undefined, cond: unknown) => {
    if (table === schema.projects) return [{ issuePrefix: null }];
    if (table !== schema.issues) return [];
    const q = cond ? dialect.sqlToQuery(cond as never) : { sql: '', params: [] as unknown[] };
    const has = (v: unknown) => q.params.includes(v);
    if (q.sql.includes('jsonb_path_exists')) {
      return state.rows.filter((r) => r.artifacts?.some((a) => a.carriedBy));
    }
    if (cols && 'status' in cols && 'projectId' in cols) {
      return state.rows.filter((r) => has(r.id) || (has(r.projectId) && has(r.seq)));
    }
    if (q.sql.includes('release_batch_run_id')) {
      return state.rows.filter((r) => state.roster.includes(r.id));
    }
    return state.rows.filter((r) => has(r.id));
  };
  const chain = (rows: () => unknown[]) => {
    const p = Promise.resolve().then(rows);
    return Object.assign(p, { limit: async () => rows() });
  };
  return {
    db: {
      select: (cols?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (cond: unknown) => chain(() => read(table, cols, cond)),
          innerJoin: () => ({
            where: () => chain(() => (table === workflows.projectWorkflowDesigns ? [] : [])),
          }),
        }),
      }),
    },
  };
});
vi.mock('../issues/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../issues/index.js')>()),
  transitionIssueStatus: vi.fn(),
  activeIssuePrefix: async () => 'ISS',
  listCriteriaOf: async (_db: unknown, ids: readonly string[]) =>
    new Map<string, CriterionWithVerdict[]>(ids.map((id) => [id, state.criteria.get(id) ?? []])),
}));
vi.mock('../integrations/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../integrations/registry.js')>()),
  getIntegration: (provider: string) =>
    provider === 'autoflow'
      ? {
          presentation: { label: 'Autoflow' },
          storefrontPublished: async (args: unknown) =>
            (await import('../integrations/autoflow/published.js')).autoflowStorefrontPublished(
              args as never,
            ),
        }
      : undefined,
}));
vi.mock('../integrations/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../integrations/store.js')>()),
  findBindingWithConnectionById: async () => ({
    connection: { id: 'conn-hop', config: {} },
    binding: { id: 'binding-production', provider: 'autoflow', config: {} },
  }),
  effectiveConfig: () => ({ shop: 'hop', storeId: '11', storeSlug: 'hop' }),
  decryptConnectionSecrets: () => ({}),
}));
vi.mock('../integrations/autoflow/live-read.js', () => ({
  autoflowLiveRead: async (_args: unknown, _config: unknown, query: string) => {
    state.queries.push(query);
    if (query.includes('ForgeAutoflowVersions')) {
      const keys = [...query.matchAll(/(v\d+): backendWorkflowVersions/g)].map((m) => m[1]);
      return { ok: true, data: Object.fromEntries(keys.map((k) => [k, []])) };
    }
    return {
      ok: true,
      data: {
        backendWorkflows: Object.entries(state.published).map(([id, at]) => ({
          id,
          code: id === '193' ? 'hop_referral' : `wf_${id}`,
          version: at ? 2 : 0,
          published_at: at,
          published: at ? { nodes: [{ id: `served-${id}` }], edges: [] } : null,
        })),
      },
    };
  },
}));
vi.mock('../pipeline/index.js', () => ({
  cancelConcludedRun: vi.fn(),
  closeRunIfOneShot: vi.fn(),
  stampReleaseShipped: vi.fn(),
  writeRunMetadata: vi.fn(),
}));
vi.mock('./abort-stamp.js', () => ({
  abortedError: vi.fn(),
  batchAborted: () => false,
  closedBeforeAbort: vi.fn(),
  settleAbortStamp: vi.fn(),
  stampAbort: vi.fn(),
}));
vi.mock('./claim-conflicts.js', () => ({ refuseLostReleaseClaim: vi.fn() }));
vi.mock('./releasing-recovery.js', () => ({ recoverStrandedReleasing: vi.fn() }));

const production: ReleaseChannel = {
  environment: 'production',
  bindingId: 'binding-production',
  provider: 'autoflow',
  label: 'production',
  instructions: null,
  verify: null,
  verifySource: 'none',
  providerRecord: true,
  rollback: null,
  releaseRunnerLabel: null,
};
vi.mock('./channel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./channel.js')>()),
  resolveReleaseChannels: async () => [production],
}));

const { verifyBeforeClose } = await import('./finish.js');
const { verifyByProviderRecord } = await import('./provider-verify.js');

const HOP = 'hop';
const run = {
  projectId: HOP,
  metadata: { source: 'release-batch' },
  status: 'running' as const,
  releaseVersion: '0.4.0',
};
const ISS54_MARKED = new Date('2026-10-07T18:43:05.039Z');
const RUN_PUBLISHED = '2026-10-07T20:58:00Z';

const ID_110 = '00000000-0000-4000-8000-000000000110';
const ACCESS_193 = 'autoflow hop draft workflow 193 @999dcf6d: access block';

function iss54(carriedBy?: string): Row {
  return {
    id: 'id-54',
    projectId: HOP,
    seq: 54,
    status: 'awaiting_release',
    mergedAt: ISS54_MARKED,
    landing: 'Outside git, on the hop Autoflow DRAFT site (store 11)',
    artifacts: [
      {
        surface: 'logic',
        ref: 'autoflow hop draft workflow 96 @d00d9028: stamp block',
        change: 'changed',
      },
      {
        surface: 'logic',
        ref: ACCESS_193,
        change: 'changed',
        ...(carriedBy ? { carriedBy } : {}),
      },
    ],
  };
}

function iss110(status: string, projectId = HOP): Row {
  return {
    id: ID_110,
    projectId,
    seq: 110,
    status,
    mergedAt: status === 'in_progress' ? null : new Date('2026-10-07T20:00:00Z'),
    landing: status === 'in_progress' ? null : 'hop Autoflow DRAFT: referral graph',
    artifacts:
      status === 'in_progress'
        ? null
        : [{ surface: 'logic', ref: 'workflow 193 hop_referral @abcdef01', change: 'added' }],
  };
}

async function refusalOf(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return err.refusals[0] as unknown as { code: string; detail: string; mismatches?: unknown[] };
  }
}

function draftVerdict(workflowId: string, draftVersion: string): CriterionWithVerdict {
  return {
    id: `c-${workflowId}`,
    n: 1,
    statement: 'access block holds',
    position: 1,
    requirementCriterionId: null,
    latest: {
      id: `v-${workflowId}`,
      verdict: 'pass',
      reason: null,
      identityKind: 'storefront_draft',
      commitSha: null,
      runtimeRef: null,
      designWorkflowId: null,
      designFlow: null,
      designRevision: null,
      contractRef: null,
      contractVersion: null,
      storefrontWorkflowId: workflowId,
      storefrontDraftVersion: draftVersion,
      storefrontEnvironment: 'preview',
      corroboration: 'corroborated',
      corroborationNote: null,
      evidence: [],
      authorAgency: 'agent',
      backfilled: false,
      createdAt: '2026-10-07T18:41:36.201Z',
    },
  };
}

beforeEach(() => {
  state.criteria = new Map();
  state.queries = [];
  state.published = { '96': RUN_PUBLISHED, '193': null };
});

describe('HOP 0.4.0: an artifact carried by another issue', () => {
  it('reports ISS-54 workflow 193 carried by ISS-110 and verifies the release, publishing nothing of 193', async () => {
    state.rows = [iss54('ISS-110'), iss110('in_progress')];
    state.roster = ['id-54'];
    const onVerified = vi.fn();
    await verifyBeforeClose('21460fb0', run, { onVerified });
    expect(onVerified).toHaveBeenCalledWith('provider');
    const outcome = await verifyByProviderRecord({
      projectId: HOP,
      issueIds: ['id-54'],
      channel: production,
    });
    expect(outcome.ok && outcome.readings).toContainEqual(
      `ISS-54: ${ACCESS_193} — carried by ISS-110 (\`in_progress\`), whose own release ships it and verifies it there; not checked in this one`,
    );
  });

  it('reports carriage for a workflow the issue also judged a draft of, and for a release carrying all it touched', async () => {
    state.rows = [
      {
        ...iss54('ISS-110'),
        artifacts: [{ surface: 'logic', ref: ACCESS_193, change: 'changed', carriedBy: 'ISS-110' }],
      },
      iss110('in_progress'),
    ];
    state.roster = ['id-54'];
    state.criteria = new Map([['id-54', [draftVerdict('193', '999dcf6d'.padEnd(64, '0'))]]]);
    const outcome = await verifyByProviderRecord({
      projectId: HOP,
      issueIds: ['id-54'],
      channel: production,
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.ok && outcome.readings.join('\n')).toContain('carried by ISS-110');
    expect(state.queries.some((q) => q.includes('ForgeAutoflowPublished'))).toBe(false);
  });

  it('refuses a carrier claimed by the same release, by name', async () => {
    state.rows = [iss54('ISS-110'), iss110('awaiting_release')];
    state.roster = ['id-54', ID_110];
    state.published['193'] = RUN_PUBLISHED;
    const refusal = await refusalOf(verifyBeforeClose('21460fb0', run, {}));
    expect(refusal?.code).toBe('RELEASE_NOT_VERIFIED');
    expect(refusal?.detail).toContain(
      `ISS-54 marked \`${ACCESS_193}\` carried by ISS-110, and ISS-110 is claimed by this same release`,
    );
  });

  it('refuses a carrier that closed, by name', async () => {
    state.rows = [iss54('ISS-110'), iss110('closed')];
    state.roster = ['id-54'];
    const refusal = await refusalOf(verifyBeforeClose('21460fb0', run, {}));
    expect(refusal?.detail).toContain(
      `ISS-54 marked \`${ACCESS_193}\` carried by ISS-110, and ISS-110 is \`closed\`, so no release of it will ship this artifact`,
    );
  });

  it('refuses a carrier of another project, by name', async () => {
    state.rows = [iss54('EPOD-110'), iss110('in_progress', 'epod')];
    state.roster = ['id-54'];
    const refusal = await refusalOf(verifyBeforeClose('21460fb0', run, {}));
    expect(refusal?.detail).toContain(
      `ISS-54 marked \`${ACCESS_193}\` carried by EPOD-110, and \`EPOD-110\` is not a key of this project`,
    );
    state.rows = [iss54(ID_110), iss110('in_progress', 'epod')];
    const byId = await refusalOf(verifyBeforeClose('21460fb0', run, {}));
    expect(byId?.detail).toContain(`\`${ID_110}\` is an issue of another project`);
  });

  it("makes the carrier's own release verify what it inherited", async () => {
    state.rows = [iss54('ISS-110'), iss110('awaiting_release')];
    state.roster = [ID_110];
    const unpublished = await refusalOf(verifyBeforeClose('21460fb0', run, {}));
    expect(unpublished?.detail).toContain(
      'ISS-110 landed workflow `193` (`hop_referral`) at draft `999dcf6d`, and Autoflow publishes no version of workflow `193`',
    );
    state.published['193'] = RUN_PUBLISHED;
    const outcome = await verifyByProviderRecord({
      projectId: HOP,
      issueIds: [ID_110],
      channel: production,
    });
    expect(outcome.ok && outcome.readings.join('\n')).toContain(
      `ISS-110: ${ACCESS_193} (carried from ISS-54) — Autoflow serves`,
    );
  });
});
