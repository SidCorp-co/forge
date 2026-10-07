// HOP release 0.3.0 on dev (run 41d111dd, 2026-10-07): the run published 23 workflows, routes 338
// and 339 and page 25 on Autoflow store 11, theme 815 was already served, and finish was refused
// RELEASE_NOT_VERIFIED for the 7 of 26 issues "whose verdicts name no storefront draft" — a design
// approval with no verdicts (ISS-119), four issues judged on commits whose marks name the pages,
// routes, workflows, themes and setting they shipped (ISS-122..125), and two design stamps
// (ISS-126, ISS-128). The roster is the tracker's own record of them
// (`provider-verify-hop-0.3.0.fixture.json`); what production serves is planted at Autoflow's
// GraphQL door, so the whole read — tracker rows, the adapter's queries, the judgement — is the
// shipped one.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CriterionWithVerdict } from '../issues/index.js';
import { isRefusal } from '../lib/refusal.js';
import type { ReleaseChannel } from './plan.js';
import fixture from './provider-verify-hop-0.3.0.fixture.json' with { type: 'json' };

interface FixtureIssue {
  key: string;
  mergedAt: string | null;
  landing: string | null;
  artifacts: Array<{ surface: string; ref: string; change: string }> | null;
  verdicts: Array<{
    kind: string;
    at: string;
    commit?: string;
    workflowId?: string;
    draft?: string;
  }>;
  unjudged: number;
}

const state = vi.hoisted(() => ({
  issues: [] as Array<Record<string, unknown>>,
  criteria: new Map<string, CriterionWithVerdict[]>(),
  approvals: [] as Array<{ flow: string; revision: number; decidedAt: Date }>,
  answers: {} as Record<string, unknown>,
  queries: [] as string[],
  stamped: [] as unknown[],
}));

vi.mock('../db/client.js', async () => {
  const schema = await import('../db/schema.js');
  const designs = await import('../db/schema-workflows.js');
  const where = (rows: () => unknown[]) => ({ where: async () => rows() });
  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === schema.issues) return where(() => state.issues);
          if (table === designs.projectWorkflowDesigns) {
            return { innerJoin: () => where(() => state.approvals) };
          }
          return where(() => []);
        },
      }),
    },
  };
});
vi.mock('../issues/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../issues/index.js')>()),
  transitionIssueStatus: vi.fn(),
  activeIssuePrefix: async () => 'ISS',
  listCriteriaOf: async () => state.criteria,
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
    const name = /query (\w+)/.exec(query)?.[1] ?? '';
    if (name === 'ForgeAutoflowVersions') {
      const keys = [...query.matchAll(/(v\d+): backendWorkflowVersions/g)].map((m) => m[1]);
      return { ok: true, data: Object.fromEntries(keys.map((k) => [k, []])) };
    }
    const data = state.answers[name];
    return data ? { ok: true, data } : { ok: false, reason: `no answer planted for ${name}` };
  },
}));
vi.mock('../pipeline/index.js', () => ({
  cancelConcludedRun: vi.fn(),
  closeRunIfOneShot: vi.fn(),
  stampReleaseShipped: vi.fn(),
  writeRunMetadata: vi.fn(async (_runId: string, patch: unknown) => {
    state.stamped.push(patch);
  }),
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

const run = {
  projectId: 'hop',
  metadata: { source: 'release-batch' },
  status: 'running' as const,
  releaseVersion: '0.3.0',
};

/** The run published the 23 workflows at 19:52; hop_staff (166) was last published by ISS-126. */
const RUN_PUBLISHED = '2026-10-07T19:52:00Z';
const STAFF_V3 = '2026-10-07T16:00:00Z';
/** Theme 815 went live when ISS-128 published it, before the run. */
const THEME_815_LIVE = '2026-10-07T18:40:00Z';

const WORKFLOWS = [
  '96',
  '100',
  '102',
  '105',
  '106',
  '107',
  '111',
  '117',
  '131',
  '151',
  '153',
  '155',
  '158',
  '160',
  '161',
  '166',
  '167',
  '170',
  '171',
  '172',
  '178',
  '187',
  '190',
  '193',
  '220',
  '240',
];
const ROUTES = [
  '199',
  '205',
  '212',
  '213',
  '214',
  '215',
  '216',
  '217',
  '218',
  '219',
  '220',
  '221',
  '222',
  '265',
  '268',
  '269',
  '284',
  '285',
  '320',
  '321',
  '322',
  '338',
  '339',
];
const PAGES = ['12', '13', '14', '15', '16', '17', '19', '20', '23', '24', '25'];
const SERVED_SHELL_JS = 'c0ffee'.padEnd(64, '0');

function themeFilesNamed(issues: readonly FixtureIssue[]): string[] {
  const paths = new Set<string>(['templates/index.json']);
  for (const i of issues) {
    for (const a of i.artifacts ?? []) {
      for (const m of a.ref.matchAll(/\b((?:assets|sections|templates)\/[\w.\-/]*[\w-])/g)) {
        paths.add(m[1] as string);
      }
    }
  }
  return [...paths];
}

function plant(issues: readonly FixtureIssue[]) {
  state.issues = issues.map((i) => ({
    id: i.key,
    seq: Number(i.key.slice(4)),
    mergedAt: i.mergedAt ? new Date(i.mergedAt) : null,
    landing: i.landing,
    artifacts: i.artifacts,
  }));
  let n = 0;
  state.criteria = new Map(
    issues.map((i): [string, CriterionWithVerdict[]] => [
      i.key,
      [
        ...i.verdicts.map((v) => {
          n += 1;
          return criterion(n, v);
        }),
        ...Array.from({ length: i.unjudged }, () => {
          n += 1;
          return { ...criterion(n, null), latest: null };
        }),
      ],
    ]),
  );
  state.approvals = Object.entries(fixture.approvals).map(([ref, at]) => {
    const [flow, revision] = ref.split('@rev');
    return { flow: flow as string, revision: Number(revision), decidedAt: new Date(at) };
  });
  state.answers = {
    ForgeAutoflowPublished: {
      backendWorkflows: WORKFLOWS.map((id) => ({
        id,
        code: `wf_${id}`,
        version: 2,
        published_at: id === '166' ? STAFF_V3 : RUN_PUBLISHED,
        published: { nodes: [{ id: `served-${id}`, type: 'trigger' }], edges: [] },
      })),
    },
    ForgeAutoflowRoutes: {
      backendRoutes: ROUTES.map((id) => ({
        id,
        method: 'GET',
        path: `/hop/route-${id}`,
        workflow_code: 'wf',
        is_published: true,
      })),
    },
    ForgeAutoflowPages: {
      storePages: PAGES.map((id) => ({
        id,
        handle: `page-${id}`,
        is_published: true,
        published_at: id === '25' ? RUN_PUBLISHED : '2026-10-07T09:30:00Z',
        has_unpublished_changes: false,
      })),
    },
    ForgeAutoflowTheme: {
      publicResolvedTheme: {
        theme: { id: '815', published_files_version_id: '430' },
        files: themeFilesNamed(issues).map((path) => ({
          path,
          checksum: path === 'assets/hop-staff-shell.js' ? SERVED_SHELL_JS : 'ab'.repeat(32),
        })),
      },
    },
    ForgeAutoflowThemeSnapshot: { themeVersion: { id: '430', created_at: THEME_815_LIVE } },
    ForgeAutoflowSettings: { store: { id: '11', settings: { commerce_enabled: false } } },
  };
}

function criterion(n: number, v: FixtureIssue['verdicts'][number] | null): CriterionWithVerdict {
  return {
    id: `c-${n}`,
    n,
    statement: 'from the 0.3.0 roster',
    position: n,
    requirementCriterionId: null,
    latest: {
      id: `v-${n}`,
      verdict: 'pass',
      reason: null,
      identityKind: (v?.kind ?? null) as never,
      commitSha: v?.commit ?? null,
      runtimeRef: null,
      designWorkflowId: null,
      designFlow: null,
      designRevision: null,
      contractRef: null,
      contractVersion: null,
      storefrontWorkflowId: v?.workflowId ?? null,
      storefrontDraftVersion: v?.draft ?? null,
      storefrontEnvironment: v?.workflowId ? 'preview' : null,
      corroboration: v?.workflowId ? 'corroborated' : null,
      corroborationNote: null,
      evidence: [],
      authorAgency: 'agent',
      backfilled: false,
      createdAt: v?.at ?? '2026-10-07T00:00:00Z',
    },
  };
}

const roster = fixture.issues as FixtureIssue[];
const keys = roster.map((i) => i.key);

beforeEach(() => {
  state.queries = [];
  state.stamped = [];
  plant(roster);
});

describe('HOP 0.3.0: every landing kind the storefront attests', () => {
  it('verifies all 26 issues against what Autoflow serves, and closes', async () => {
    expect(keys).toHaveLength(26);
    const onVerified = vi.fn();
    await verifyBeforeClose('41d111dd', run, { onVerified });
    expect(onVerified).toHaveBeenCalledWith('provider');
    expect(state.stamped).toEqual([{ merge: { verification: 'provider' }, touch: false }]);

    const outcome = await verifyByProviderRecord({
      projectId: 'hop',
      issueIds: keys,
      channel: production,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const said = (key: string) => outcome.readings.filter((l) => l.startsWith(`${key}:`));
    for (const key of keys) expect(said(key), key).not.toEqual([]);
    expect(said('ISS-119').join(' ')).toContain('approval of design hop-complaint-ux@rev2');
    expect(said('ISS-126').join(' ')).toContain('hop-staff-shell-ux@rev7');
    expect(said('ISS-128').join(' ')).toContain(
      'its verdicts judged commit 0414b9a981a8, and its mark names nothing that commit shipped',
    );
    expect(said('ISS-122').join(' ')).toContain('page `17`');
    expect(said('ISS-122').join(' ')).toContain('route `221`');
    expect(said('ISS-125').join(' ')).toContain('serves theme `815`');
    expect(said('ISS-125').join(' ')).toContain('holds setting `commerce_enabled` = `false`');
    expect(said('ISS-76').join(' ')).toContain('serves theme `815` itself');
    expect(outcome.identity).toContain('theme 815');
  });

  it('refuses a planted theme hash mismatch, naming the issue, the theme and both identities', async () => {
    const planted = roster.map((i) =>
      i.key !== 'ISS-76'
        ? i
        : {
            ...i,
            artifacts: (i.artifacts ?? []).map((a) =>
              a.ref === 'draft theme 815 assets/hop-staff-shell.js (one selector)'
                ? {
                    ...a,
                    ref: 'draft theme 815 assets/hop-staff-shell.js sha256 1111aaaa (one selector)',
                  }
                : a,
            ),
          },
    );
    plant(planted);
    const onVerified = vi.fn();
    type Row = { code: string; detail: string; mismatches?: unknown[] };
    let refusal: Row | null = null;
    try {
      await verifyBeforeClose('41d111dd', run, { onVerified });
    } catch (err) {
      if (!isRefusal(err)) throw err;
      refusal = err.refusals[0] as unknown as Row;
    }
    expect(refusal?.code).toBe('RELEASE_NOT_VERIFIED');
    expect(refusal?.detail).toContain(
      `ISS-76 landed theme 815 assets/hop-staff-shell.js @1111aaaa, and Autoflow serves theme \`815\` with \`assets/hop-staff-shell.js\` at sha-256 \`${SERVED_SHELL_JS}\``,
    );
    expect(refusal?.mismatches).toEqual([
      expect.objectContaining({
        issue: 'ISS-76',
        kind: 'theme',
        landed: 'theme 815 assets/hop-staff-shell.js @1111aaaa',
        served: `theme 815 assets/hop-staff-shell.js @${SERVED_SHELL_JS}`,
      }),
    ]);
    expect(onVerified).not.toHaveBeenCalled();
    expect(state.stamped).toEqual([]);
  });
});
