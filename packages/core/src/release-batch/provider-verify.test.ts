// HOP's first release (0.1.0) was published on Autoflow and refused at finish: the gate wanted a
// deployment record naming a commit, and a storefront keeps neither. A storefront release is proved
// by what the provider publishes against each issue's landed draft, and refused naming the issue,
// the workflow and both identities where it does not carry one.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorefrontPublishedReading } from '../integrations/index.js';
import type { CriterionWithVerdict } from '../issues/index.js';
import { isRefusal } from '../lib/refusal.js';
import type { ReleaseChannel } from './plan.js';

const reads = vi.hoisted(() => ({
  channels: [] as ReleaseChannel[],
  rows: [] as Array<{ id: string; seq: number }>,
  criteria: new Map<string, CriterionWithVerdict[]>(),
  published: new Map<string, StorefrontPublishedReading>(),
  asked: [] as Array<{ provider: string; binding: string; workflowIds: readonly string[] }>,
  stamped: [] as unknown[],
}));

vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => reads.rows }) }) },
}));
vi.mock('../pipeline/index.js', () => ({
  cancelConcludedRun: vi.fn(),
  closeRunIfOneShot: vi.fn(),
  stampReleaseShipped: vi.fn(),
  writeRunMetadata: vi.fn(async (_runId: string, patch: unknown) => {
    reads.stamped.push(patch);
  }),
}));
vi.mock('../issues/index.js', () => ({
  transitionIssueStatus: vi.fn(),
  activeIssuePrefix: async () => 'ISS',
  listCriteriaOf: async () => reads.criteria,
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
    workflowIds: readonly string[];
  }) => {
    reads.asked.push(args);
    return reads.published;
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
  reads.rows = Object.keys(issues).map((seq) => ({ id: `issue-${seq}`, seq: Number(seq) }));
  reads.criteria = new Map(Object.entries(issues).map(([seq, c]) => [`issue-${seq}`, c]));
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
    reads.published = new Map([
      ['155', published('hop_attention_sweep', sha('a'))],
      ['102', published('hop_derived_state', sha('c'))],
    ]);
    const onVerified = vi.fn();
    await verifyBeforeClose('run-hop', run, { onVerified });
    expect(reads.asked).toEqual([
      { provider: 'autoflow', binding: 'binding-production', workflowIds: ['155', '102'] },
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

  it('refuses an issue whose verdicts name no storefront draft, and a release with nothing to check', async () => {
    roster({ 7: [verdict('runtime')] });
    expect((await refusalOf(verifyBeforeClose('run-hop', run, {})))?.detail).toContain(
      "ISS-7's verdicts name no storefront draft (runtime)",
    );
    roster({ 63: [verdict('design')] });
    expect((await refusalOf(verifyBeforeClose('run-hop', run, {})))?.detail).toContain(
      'no issue of this release landed a storefront draft',
    );
    roster({});
    expect((await refusalOf(verifyBeforeClose('run-hop', run, {})))?.detail).toContain(
      'this release claims no issue',
    );
  });
});

describe('landingsOf', () => {
  it('keeps the newest draft an issue judged per workflow', async () => {
    const { landingsOf } = await import('./provider-verify.js');
    const found = landingsOf([
      {
        key: 'ISS-20',
        criteria: [
          verdict('storefront_draft', { workflowId: '102', draftVersion: sha('1'), at: BEFORE }),
          verdict('storefront_draft', { workflowId: '102', draftVersion: sha('2'), at: JUDGED }),
        ],
      },
    ]);
    expect(found.landings).toEqual([
      { issue: 'ISS-20', workflowId: '102', draftVersion: sha('2'), judgedAt: JUDGED },
    ]);
  });
});
