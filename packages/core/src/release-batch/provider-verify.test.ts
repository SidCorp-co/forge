// HOP's first release (0.1.0) was published on Autoflow and refused at finish: the gate wanted a
// deployment record naming a commit, and a storefront keeps neither. A storefront release is proved
// by what the provider publishes against each issue's landed draft, and refused naming the issue,
// the workflow and both identities where it does not carry one.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  StorefrontPublishedReading,
  StorefrontServed,
  StorefrontServedAsk,
} from '../integrations/index.js';
import type { CriterionWithVerdict } from '../issues/index.js';
import { isRefusal } from '../lib/refusal.js';
import type { ReleaseChannel } from './plan.js';
import type { RosterIssue } from './provider-landings.js';

const reads = vi.hoisted(() => ({
  channels: [] as ReleaseChannel[],
  roster: [] as RosterIssue[],
  approvals: new Map<string, string>(),
  published: new Map<string, StorefrontPublishedReading>(),
  served: {} as Partial<Omit<StorefrontServed, 'workflows'>>,
  asked: [] as Array<{ provider: string; binding: string; ask: StorefrontServedAsk }>,
  stamped: [] as unknown[],
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: async () => reads.roster.map((r) => ({ id: r.key })) }),
    }),
  },
}));
vi.mock('../pipeline/index.js', () => ({
  cancelConcludedRun: vi.fn(),
  closeRunIfOneShot: vi.fn(),
  stampReleaseShipped: vi.fn(),
  writeRunMetadata: vi.fn(async (_runId: string, patch: unknown) => {
    reads.stamped.push(patch);
  }),
}));
vi.mock('./provider-roster.js', () => ({
  readProviderRoster: async () => reads.roster,
  readDesignApprovals: async () => reads.approvals,
}));
vi.mock('../integrations/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../integrations/index.js')>()),
  getIntegration: (provider: string) =>
    provider === 'autoflow'
      ? { presentation: { label: 'Autoflow' }, storefrontPublished: async () => new Map() }
      : undefined,
  readStorefrontPublished: async (args: {
    provider: string;
    binding: string;
    ask: StorefrontServedAsk;
  }) => {
    reads.asked.push(args);
    return {
      workflows: reads.published,
      routes: reads.served.routes ?? new Map(),
      pages: reads.served.pages ?? new Map(),
      theme: reads.served.theme ?? null,
      settings: reads.served.settings ?? new Map(),
    };
  },
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
vi.mock('./channel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./channel.js')>()),
  resolveReleaseChannels: async () => reads.channels,
}));

const { closeVerification } = await import('./channel.js');
const { verifyBeforeClose } = await import('./finish.js');

const storefront: ReleaseChannel = {
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

const run = {
  projectId: 'hop',
  metadata: { source: 'release-batch' },
  status: 'running' as const,
  releaseVersion: '0.1.0',
};

const sha = (c: string) => c.repeat(64);
const JUDGED = '2026-10-07T03:30:19.000Z';
const BEFORE = '2026-10-06T12:00:00Z';
const AFTER = '2026-10-07T15:37:55Z';

let n = 0;
function verdict(
  kind: 'storefront_draft' | 'design' | 'runtime',
  draft?: { workflowId: string; draftVersion: string; at?: string },
): CriterionWithVerdict {
  n += 1;
  return {
    id: `c-${n}`,
    n,
    statement: 'planted',
    position: n,
    requirementCriterionId: null,
    latest: {
      id: `v-${n}`,
      verdict: 'pass',
      reason: null,
      identityKind: kind,
      commitSha: null,
      runtimeRef: kind === 'runtime' ? 'https://hop.example.test' : null,
      designWorkflowId: null,
      designFlow: null,
      designRevision: null,
      contractRef: null,
      contractVersion: null,
      storefrontWorkflowId: draft?.workflowId ?? null,
      storefrontDraftVersion: draft?.draftVersion ?? null,
      storefrontEnvironment: draft ? 'preview' : null,
      corroboration: draft ? 'corroborated' : null,
      corroborationNote: null,
      evidence: [],
      authorAgency: 'agent',
      backfilled: false,
      createdAt: draft?.at ?? JUDGED,
    },
  };
}

const published = (
  code: string,
  graph: string,
  at: { publishedAt?: string; firstLiveAt?: string } = {},
): StorefrontPublishedReading => ({
  kind: 'published',
  workflowCode: code,
  version: 1,
  publishedAt: at.publishedAt ?? AFTER,
  graphVersion: graph,
  firstLiveAt: at.firstLiveAt ?? at.publishedAt ?? AFTER,
});

function roster(issues: Record<number, CriterionWithVerdict[]>) {
  reads.roster = Object.entries(issues).map(([seq, criteria]) => ({
    key: `ISS-${seq}`,
    criteria,
    mergedAt: null,
    landing: null,
    artifacts: null,
    builds: false,
  }));
}

function designMark(key: string, ref: string) {
  const issue = reads.roster.find((r) => r.key === key);
  if (!issue) throw new Error(`${key} is not on the planted roster`);
  issue.mergedAt = JUDGED;
  issue.landing = `workflow design \`${ref.split('@')[0]}\` revision ${ref.split('@rev')[1]}, approved`;
  issue.artifacts = [{ surface: 'design', ref, change: 'changed' }];
}

async function refusalOf(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return err.refusals[0] as { code: string; detail: string; mismatches?: unknown[] };
  }
}

beforeEach(() => {
  reads.channels = [storefront];
  reads.published = new Map();
  reads.approvals = new Map();
  reads.served = {};
  reads.asked = [];
  reads.stamped = [];
  n = 0;
});

describe('a release on a storefront is proved by what the provider publishes', () => {
  it('reads the provider, never a commit, where the binding publishes the storefront', () => {
    expect(closeVerification([storefront])).toEqual({ kind: 'provider', channel: storefront });
    expect(closeVerification([{ ...storefront, providerRecord: false }])).toEqual({
      kind: 'deployment',
    });
  });

  it('closes when every landing is the published graph or one first live after it was judged', async () => {
    roster({
      52: [verdict('storefront_draft', { workflowId: '155', draftVersion: sha('a') })],
      59: [verdict('storefront_draft', { workflowId: '102', draftVersion: sha('b') })],
      63: [verdict('design')],
    });
    designMark('ISS-63', 'hop-staff-shell-ux@rev7');
    reads.approvals = new Map([['hop-staff-shell-ux@rev7', JUDGED]]);
    reads.published = new Map([
      ['155', published('hop_attention_sweep', sha('a'))],
      ['102', published('hop_derived_state', sha('c'))],
    ]);
    const onVerified = vi.fn();
    await verifyBeforeClose('run-hop', run, { onVerified });
    expect(reads.asked).toEqual([
      {
        provider: 'autoflow',
        binding: 'binding-production',
        ask: {
          workflowIds: ['155', '102'],
          routeIds: [],
          pageIds: [],
          theme: false,
          settingKeys: [],
        },
      },
    ]);
    expect(onVerified).toHaveBeenCalledWith('provider');
    expect(reads.stamped).toEqual([{ merge: { verification: 'provider' }, touch: false }]);
  });

  it('refuses a landing whose workflow went live before it was judged, naming issue, workflow and both identities', async () => {
    roster({ 71: [verdict('storefront_draft', { workflowId: '166', draftVersion: sha('d') })] });
    reads.published = new Map([['166', published('hop_staff', sha('e'), { publishedAt: BEFORE })]]);
    const onVerified = vi.fn();
    const refusal = await refusalOf(verifyBeforeClose('run-hop', run, { onVerified }));
    expect(refusal?.code).toBe('RELEASE_NOT_VERIFIED');
    expect(refusal?.detail).toContain('ISS-71 landed workflow `166` (`hop_staff`)');
    expect(refusal?.detail).toContain(sha('d'));
    expect(refusal?.detail).toContain(sha('e'));
    expect(refusal?.mismatches).toEqual([
      expect.objectContaining({
        issue: 'ISS-71',
        workflow: '166',
        landed: sha('d'),
        served: sha('e'),
      }),
    ]);
    expect(onVerified).not.toHaveBeenCalled();
    expect(reads.stamped).toEqual([]);
  });

  it('refuses a landing on a workflow the provider never published', async () => {
    roster({ 89: [verdict('storefront_draft', { workflowId: '167', draftVersion: sha('f') })] });
    reads.published = new Map([['167', { kind: 'unpublished', workflowCode: 'hop_campaign' }]]);
    const refusal = await refusalOf(verifyBeforeClose('run-hop', run, {}));
    expect(refusal?.detail).toContain('Autoflow publishes no version of workflow `167`');
  });

  it('refuses a revert to a graph first live before the landing, though it was republished after', async () => {
    roster({ 6: [verdict('storefront_draft', { workflowId: '102', draftVersion: sha('b') })] });
    reads.published = new Map([
      [
        '102',
        published('hop_derived_state', sha('0'), { publishedAt: AFTER, firstLiveAt: BEFORE }),
      ],
    ]);
    const refusal = await refusalOf(verifyBeforeClose('run-hop', run, {}));
    expect(refusal?.detail).toContain('as a revert to a graph first live then');
  });

  it('refuses where the provider answered nothing, carrying its reason', async () => {
    roster({ 6: [verdict('storefront_draft', { workflowId: '102', draftVersion: sha('b') })] });
    reads.published = new Map([
      ['102', { kind: 'unreadable', detail: 'unauthorized: token expired' }],
    ]);
    const refusal = await refusalOf(verifyBeforeClose('run-hop', run, {}));
    expect(refusal?.detail).toContain('unauthorized: token expired');
  });

  it('refuses an issue that names nothing the provider can attest, and a release with nothing to check', async () => {
    roster({ 7: [verdict('runtime')] });
    expect((await refusalOf(verifyBeforeClose('run-hop', run, {})))?.detail).toContain(
      'ISS-7 names nothing Autoflow can attest: its verdicts name no storefront draft (runtime), and it carries no merged mark',
    );
    roster({ 63: [verdict('design')] });
    designMark('ISS-63', 'hop-staff-shell-ux@rev7');
    reads.approvals = new Map([['hop-staff-shell-ux@rev7', JUDGED]]);
    expect((await refusalOf(verifyBeforeClose('run-hop', run, {})))?.detail).toContain(
      'no issue of this release landed anything Autoflow serves',
    );
    roster({});
    expect((await refusalOf(verifyBeforeClose('run-hop', run, {})))?.detail).toContain(
      'this release claims no issue',
    );
  });
});

describe('every landing kind a mark names is read against what the provider serves', () => {
  const MARKED = '2026-10-07T13:23:32.025Z';
  function marked(seq: number, artifacts: Array<{ surface: string; ref: string }>, extra = {}) {
    reads.roster = [
      {
        key: `ISS-${seq}`,
        criteria: [verdict('runtime')],
        mergedAt: MARKED,
        landing: 'https://hop.example.test',
        artifacts: artifacts.map((a) => ({ ...a, change: 'changed' })) as RosterIssue['artifacts'],
        builds: false,
        ...extra,
      },
    ];
  }
  const theme = (id: string, publishedAt: string | null, files: Record<string, string> = {}) => ({
    kind: 'served' as const,
    themeId: id,
    publishedAt,
    files: new Map(Object.entries(files)),
  });

  it('carries a theme served since after the landing, and refuses one live since before it, naming both themes', async () => {
    marked(125, [{ surface: 'ui', ref: 'theme 800 templates/index.json' }]);
    reads.served = { theme: theme('815', AFTER, { 'templates/index.json': 'ab'.repeat(32) }) };
    await verifyBeforeClose('run-hop', run, {});
    reads.served = { theme: theme('815', BEFORE, { 'templates/index.json': 'ab'.repeat(32) }) };
    const refusal = await refusalOf(verifyBeforeClose('run-hop', run, {}));
    expect(refusal?.detail).toContain(
      `ISS-125 landed theme 800, and Autoflow serves theme \`815\`, published at ${BEFORE}, which is not after the landing was recorded at ${MARKED}, so it cannot carry theme \`800\``,
    );
    expect(refusal?.mismatches).toEqual([
      expect.objectContaining({
        issue: 'ISS-125',
        kind: 'theme',
        landed: 'theme 800',
        served: 'theme 815',
      }),
    ]);
  });

  it('refuses a served theme that no longer holds a file the landing added', async () => {
    marked(83, [
      { surface: 'ui', ref: 'draft theme 568 sections/hop-patient-360.liquid (sha256 b9bec199)' },
    ]);
    reads.served = { theme: theme('815', AFTER) };
    expect((await refusalOf(verifyBeforeClose('run-hop', run, {})))?.detail).toContain(
      'Autoflow serves theme `815` with no file `sections/hop-patient-360.liquid`',
    );
  });

  it('refuses an unpublished route, a missing page and a setting holding another value', async () => {
    marked(84, [
      { surface: 'api', ref: 'route 320 POST /hop/his/appointments/events (unpublished)' },
      { surface: 'ui', ref: 'page 17 /pages/reports (published)' },
      { surface: 'config', ref: 'setting commerce_enabled = false' },
    ]);
    reads.served = {
      routes: new Map([
        [
          '320',
          {
            kind: 'unpublished',
            method: 'POST',
            path: '/hop/his/appointments/events',
            workflowCode: 'hop_his_adapter',
          },
        ],
      ]),
      pages: new Map([
        [
          '17',
          { kind: 'missing', detail: 'Autoflow site `hop` holds no page with id `17` on store 11' },
        ],
      ]),
      settings: new Map([['commerce_enabled', { kind: 'value', value: 'true' }]]),
    };
    const refusal = await refusalOf(verifyBeforeClose('run-hop', run, {}));
    expect(refusal?.detail).toContain(
      'ISS-84 landed route `320`, and Autoflow holds route `320` (POST /hop/his/appointments/events) unpublished: it answers no live traffic',
    );
    expect(refusal?.detail).toContain(
      'ISS-84 landed page `17`, and Autoflow site `hop` holds no page with id `17`',
    );
    expect(refusal?.detail).toContain(
      'ISS-84 landed setting `commerce_enabled` = `false`, and Autoflow holds setting `commerce_enabled` = `true`, not the `false` landed',
    );
    expect(refusal?.mismatches).toHaveLength(3);
  });

  it('refuses a mark naming only what the provider keeps no state of, saying the grammar', async () => {
    marked(87, [{ surface: 'data', ref: 'table 87 hop_tasks: type option remind_appointment' }]);
    expect((await refusalOf(verifyBeforeClose('run-hop', run, {})))?.detail).toContain(
      'ISS-87 names nothing Autoflow can attest: its verdicts name no storefront draft (runtime), and its mark names only what Autoflow reports no state for (table 87 hop_tasks: type option remind_appointment). A storefront landing names what it changed as `workflow <id>',
    );
  });

  it('proves a design-only issue by its approval, and refuses one with no approval or that builds a workflow', async () => {
    roster({
      119: [],
      1: [verdict('storefront_draft', { workflowId: '155', draftVersion: sha('a') })],
    });
    reads.published = new Map([['155', published('hop_attention_sweep', sha('a'))]]);
    designMark('ISS-119', 'hop-complaint-ux@rev2');
    const refusal = await refusalOf(verifyBeforeClose('run-hop', run, {}));
    expect(refusal?.detail).toContain(
      'ISS-119 landed design `hop-complaint-ux@rev2`, and no approval of `hop-complaint-ux@rev2` is recorded in this project',
    );
    reads.approvals = new Map([['hop-complaint-ux@rev2', JUDGED]]);
    await verifyBeforeClose('run-hop', run, {});
    const issue = reads.roster.find((r) => r.key === 'ISS-119');
    if (issue) issue.builds = true;
    expect((await refusalOf(verifyBeforeClose('run-hop', run, {})))?.detail).toContain(
      'ISS-119 is linked as the build of a workflow, so the approval of design hop-complaint-ux@rev2 is evidence on it, never its landing',
    );
  });
});

describe('landingsOf', () => {
  it('keeps the newest draft an issue judged per workflow', async () => {
    const { landingsOf } = await import('./provider-landings.js');
    const found = landingsOf([
      {
        key: 'ISS-20',
        criteria: [
          verdict('storefront_draft', { workflowId: '102', draftVersion: sha('1'), at: BEFORE }),
          verdict('storefront_draft', { workflowId: '102', draftVersion: sha('2'), at: JUDGED }),
        ],
        mergedAt: null,
        landing: null,
        artifacts: null,
        builds: false,
      },
    ]);
    expect(found.workflows).toEqual([
      expect.objectContaining({
        issue: 'ISS-20',
        workflowId: '102',
        graph: sha('2'),
        landedAt: JUDGED,
        from: 'verdict',
      }),
    ]);
  });
});
