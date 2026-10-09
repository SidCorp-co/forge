/**
 * The fast lane (REQ-39 BC-7, BC-8; docs/proposals/live-preview.md, "Fast lane"), over HTTP against
 * a throwaway Postgres: a merge check on the fast lane runs the typecheck and the touched tests only,
 * and stands only for the change a person approved in its preview — its patch id the approved one,
 * every file it touches fast. `GET /api/issues/:id/lane` says which lane an issue's change takes and
 * why. A web-only deploy (`targets`) ships only the web target, and only when every commit between
 * what that target serves and the head its environment deploys from is fast; a kernel commit in that
 * range refuses it naming the commit, the file and the rule. Coolify is a local HTTP server; the
 * repository host is a fake answering the range.
 *
 * It reaches its subject over HTTP, so it names what it guards:
 * @direct-test-of packages/core/src/fast-lane/
 * @direct-test-of packages/core/src/issues/merge-check.ts
 * @direct-test-of packages/core/src/issues/merge-check-rules.ts
 * @direct-test-of packages/core/src/issues/merge-routes.ts
 * @direct-test-of packages/core/src/integration-door/coolify-routes.ts
 * @direct-test-of packages/core/src/integration-door/coolify-tool.ts
 * @direct-test-of packages/core/src/integrations/deploy/coolify/adapter.ts
 * @direct-test-of packages/core/src/release-batch/coolify-commands.ts
 * @direct-test-of packages/core/src/release-batch/release-coolify.ts
 * @direct-test-of packages/contracts/src/merge-check.ts
 * @direct-test-of packages/contracts/src/fast-lane.ts
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FAST_LANE_MERGE_CHECKS } from '@forge/contracts/fast-lane';
import { REQUIRED_MERGE_CHECKS, type RequiredMergeCheck } from '@forge/contracts/merge-check';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovedPreview } from '../../src/fast-lane/index.js';
import type { OutboundDispatchJob } from '../../src/integrations/queue.js';
import { api, patToken, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { passingCheck } from '../helpers/merge-check-report.js';
import {
  registerAllIntegrations,
  seedDeployBinding,
  seedProjectDocument,
} from '../helpers/release-world.js';

/** The repository host as the guard reads it: a branch head, ranges and each commit's files. */
const repo = vi.hoisted(() => ({
  head: '',
  ranges: new Map<string, string[]>(),
  files: new Map<string, string[]>(),
  incomplete: false,
}));

vi.mock('../../src/integrations/source-host/index.js', async (original) => ({
  ...(await original<typeof import('../../src/integrations/source-host/index.js')>()),
  resolveSourceHost: async () => ({
    branchHead: async () => repo.head,
    readRange: async (base: string, head: string) => ({
      ok: true,
      complete: !repo.incomplete,
      commits: (repo.ranges.get(`${base}..${head}`) ?? []).map((sha) => ({
        sha,
        message: sha,
        parents: [],
      })),
    }),
    commitFiles: async (sha: string) => {
      const files = repo.files.get(sha);
      return files ? { files, changes: [] } : { why: `${sha} is not a commit this host knows` };
    },
  }),
}));

const sha = (n: number) => n.toString(16).padStart(40, '0');
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PATCH = 'c'.repeat(40);
const WEB_FILE = 'packages/web-v2/src/features/issues/approve-button.tsx';
const KERNEL_FILE = 'packages/core/src/issues/merge-check.ts';
const FAST_LANE = {
  paths: ['packages/web-v2/src/**', 'packages/web-v2/public/**'],
  kernel: ['packages/core/**', 'packages/contracts/**', 'packages/runner/**'],
  deployTargets: ['web'],
};
const WEB = { id: 't-web', label: 'web', resourceUuid: 'web-uuid' };
const CORE = { id: 't-core', label: 'core', resourceUuid: 'core-uuid' };

/** Coolify: each application's deployments, and every deploy it was asked for, by application. */
const deployments = new Map<string, Doc[]>();
const deployed: string[] = [];
let coolify: Server | null = null;
let coolifyUrl = '';

let token = '';
let strangerToken = '';
let ownerId = '';
let declared = '';
let undeclared = '';
let bindingId = '';
let seq = 0;
const approvals = new Map<string, ApprovedPreview>();

beforeAll(async () => {
  testEnv();
  coolify = createServer((req, res) => {
    const url = new URL(String(req.url), 'http://coolify');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && url.pathname === '/api/v1/deploy') {
      const uuid = url.searchParams.get('uuid') ?? '';
      deployed.push(uuid);
      res.end(
        JSON.stringify({ deployments: [{ deployment_uuid: `dep-${uuid}`, message: 'queued' }] }),
      );
      return;
    }
    const listed = /^\/api\/v1\/deployments\/applications\/(.+)$/.exec(url.pathname);
    if (listed) {
      const rows = deployments.get(decodeURIComponent(listed[1] ?? '')) ?? [];
      res.end(JSON.stringify({ count: rows.length, deployments: rows }));
      return;
    }
    res.statusCode = 404;
    res.end('{"message":"not found"}');
  });
  await new Promise<void>((done) => coolify?.listen(0, '127.0.0.1', done));
  coolifyUrl = `http://127.0.0.1:${(coolify.address() as AddressInfo).port}`;

  await import('../../src/index.js');
  registerAllIntegrations();
  await startQueue();
  const { boss } = await import('../../src/queue/boss.js');
  const { INTEGRATIONS_QUEUE_NAME } = await import('../../src/queue/names.js');
  await boss.createQueue(INTEGRATIONS_QUEUE_NAME);

  const owner = await createTestUser({ verified: true });
  ownerId = owner.id;
  token = await userToken(owner.id);
  strangerToken = await userToken((await createTestUser({ verified: true })).id);
  for (const fast of [true, false]) {
    const { id } = await createTestProject(owner.id);
    await addProjectMember(id, owner.id, 'admin');
    const binding = await seedDeployBinding(id, owner.id, {
      baseUrl: coolifyUrl,
      targets: [WEB, CORE],
    });
    await seedProjectDocument(id, owner.id, {
      defaultBranch: 'dev',
      environments: {
        dev: {
          tier: 'dev',
          deploysFrom: 'dev',
          deployment: { binding, trigger: 'on-request' },
        },
      },
      extra: {
        validation: { gate: { type: 'github-check', name: 'ci-passed' }, mergeCheck: 'required' },
        ...(fast ? { fastLane: FAST_LANE } : {}),
      },
    });
    if (fast) {
      declared = id;
      bindingId = binding;
    } else undeclared = id;
  }
}, 120_000);

afterAll(async () => {
  await closeWorld();
  await new Promise<void>((done) => (coolify ? coolify.close(() => done()) : done()));
});

async function issueIn(projectId: string): Promise<string> {
  seq += 1;
  return (
    await createTestIssue(projectId, ownerId, seq, { status: 'in_progress', createdAt: new Date() })
  ).id;
}

const call = async (method: 'GET' | 'POST', path: string, body?: unknown, as = token) => {
  const res = await api(as, method, path, body);
  return { status: res.status, body: res.body as Doc };
};

const codes = (res: { body: Doc }): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.code);
const detail = (res: { body: Doc }): string => res.body.error?.refusals?.[0]?.detail ?? '';

const fastReport = (over: Doc = {}) => ({
  base: { branch: 'dev', sha: BASE },
  head: HEAD,
  mode: 'pre-merge',
  touched: [{ path: WEB_FILE, change: 'changed' }],
  checks: FAST_LANE_MERGE_CHECKS.map((n: RequiredMergeCheck) => passingCheck(n)),
  lane: 'fast',
  patchId: PATCH,
  ...over,
});

const approve = (issueId: string, over: Partial<ApprovedPreview> = {}) =>
  approvals.set(issueId, {
    previewId: '00000000-0000-4000-8000-000000000001',
    patchId: PATCH,
    files: [WEB_FILE],
    approvedBy: ownerId,
    approvedAt: '2026-10-09T10:00:00.000Z',
    ...over,
  });

const check = (issue: string, body: unknown) =>
  call('POST', `/api/issues/${issue}/merge-check`, body);
const lane = (issue: string, as = token) => call('GET', `/api/issues/${issue}/lane`, undefined, as);

// the booted core reads approvals from the previews module (src/index.ts); a core with no reader at
// all is the `unread` rule, held in src/fast-lane/rules.test.ts
describe('on the previews reader the core boots with', () => {
  it('refuses a fast report on an issue with no approved preview, naming the approval it lacks', async () => {
    const issue = await issueIn(declared);
    const res = await check(issue, fastReport());
    expect([res.status, codes(res)]).toEqual([409, ['FAST_LANE_NOT_APPROVED']]);
    expect(detail(res)).toContain('has no approved live preview');
  });
});

describe('a merge check on the fast lane (BC-7)', () => {
  beforeAll(async () => {
    const { provideFastLanePorts } = await import('../../src/fast-lane/index.js');
    provideFastLanePorts({ approvedPreviewOf: async (id) => approvals.get(id) ?? null });
  });

  it('records the approved web change with the fast checks alone, and the mark then lands it', async () => {
    const issue = await issueIn(declared);
    approve(issue);
    const res = await check(issue, fastReport());
    expect([res.status, res.body.allowed]).toEqual([201, true]);
    const fields = (res.body.record?.fields ?? []) as Doc[];
    const field = (key: string) => fields.find((f) => f.key === key)?.value;
    expect([field('lane'), field('patch-id')]).toEqual(['fast', PATCH]);
    const mark = await call('POST', `/api/issues/${issue}/merge`, {
      target: 'dev',
      commit: HEAD,
      note: 'landed on the fast lane',
      changedPaths: { commit: HEAD, changes: [{ path: WEB_FILE, change: 'changed' }] },
    });
    expect(mark.status).toBe(200);
  });

  it('refuses one whose patch moved after approval, naming both patches', async () => {
    const issue = await issueIn(declared);
    approve(issue, { patchId: 'd'.repeat(40) });
    const res = await check(issue, fastReport());
    expect([res.status, codes(res)]).toEqual([409, ['FAST_LANE_CHANGED_SINCE_APPROVAL']]);
    expect(detail(res)).toContain('d'.repeat(40));
  });

  it('refuses an approved change that touches the kernel (BC-8), naming the file and the rule', async () => {
    const issue = await issueIn(declared);
    approve(issue, { files: [WEB_FILE, KERNEL_FILE] });
    const res = await check(
      issue,
      fastReport({
        touched: [
          { path: WEB_FILE, change: 'changed' },
          { path: KERNEL_FILE, change: 'changed' },
        ],
      }),
    );
    expect([res.status, codes(res)]).toEqual([422, ['FAST_LANE_NOT_ELIGIBLE']]);
    expect(detail(res)).toContain(`${KERNEL_FILE} (kernel: \`packages/core/**\`)`);
  });

  it('refuses a migration whatever the project declares', async () => {
    const issue = await issueIn(declared);
    const migration = 'packages/web-v2/src/drizzle/0001.sql';
    approve(issue, { files: [migration] });
    const res = await check(issue, fastReport({ touched: [{ path: migration, change: 'added' }] }));
    expect([res.status, codes(res)]).toEqual([422, ['FAST_LANE_NOT_ELIGIBLE']]);
    expect(detail(res)).toContain('(migrations: `**/drizzle/**`)');
  });

  it('refuses an issue nobody approved, and a project that declares no fast lane', async () => {
    const unapproved = await issueIn(declared);
    expect(codes(await check(unapproved, fastReport()))).toEqual(['FAST_LANE_NOT_APPROVED']);
    const elsewhere = await issueIn(undeclared);
    approve(elsewhere);
    expect(codes(await check(elsewhere, fastReport()))).toEqual(['FAST_LANE_UNDECLARED']);
  });

  it('refuses a fast report without its patch id, and a full report holding only the fast checks', async () => {
    const issue = await issueIn(declared);
    approve(issue);
    const { patchId: _dropped, ...noPatch } = fastReport();
    const shape = await check(issue, noPatch);
    expect(shape.status).toBe(400);
    expect(JSON.stringify(shape.body)).toContain('patchId');
    const { lane: _lane, patchId: _p, ...full } = fastReport();
    const res = await check(issue, full);
    expect([res.status, codes(res)]).toEqual([422, ['MERGE_CHECK_INCOMPLETE']]);
    expect(detail(res)).toContain('`integration-tests`, `verify`');
  });

  it('still takes a full report with every check, as before the fast lane', async () => {
    const issue = await issueIn(declared);
    const {
      lane: _lane,
      patchId: _p,
      ...full
    } = fastReport({
      checks: REQUIRED_MERGE_CHECKS.map((n) => passingCheck(n)),
      touched: [{ path: KERNEL_FILE, change: 'changed' }],
    });
    expect((await check(issue, full)).status).toBe(201);
  });
});

describe('GET /api/issues/:id/lane (BC-8)', () => {
  it('reads fast for an approved web change, and full with each cause named for a kernel one', async () => {
    const web = await issueIn(declared);
    approve(web);
    const fast = await lane(web);
    expect([fast.status, fast.body.lane, fast.body.refusal]).toEqual([200, 'fast', null]);
    const kernel = await issueIn(declared);
    approve(kernel, { files: [WEB_FILE, KERNEL_FILE] });
    const full = await lane(kernel);
    expect(full.body.lane).toBe('full');
    expect(full.body.decision.causes).toEqual([
      { file: KERNEL_FILE, area: 'kernel', glob: 'packages/core/**' },
    ]);
    expect(full.body.refusal.code).toBe('FAST_LANE_NOT_ELIGIBLE');
  });

  it('says why an unapproved or undeclared change is on the full lane', async () => {
    expect((await lane(await issueIn(declared))).body.refusal.code).toBe('FAST_LANE_NOT_APPROVED');
    expect((await lane(await issueIn(undeclared))).body.refusal.code).toBe('FAST_LANE_UNDECLARED');
  });

  it('is not shown to someone outside the project', async () => {
    const res = await lane(await issueIn(declared), strangerToken);
    expect([403, 404]).toContain(res.status);
    expect(res.body.lane).toBeUndefined();
  });
});

describe('a web-only deploy (BC-7)', () => {
  const SERVED = sha(0x100);
  const [C1, C2, KERNEL_COMMIT] = [sha(0x101), sha(0x102), sha(0x1ee)];
  const deploy = (projectId: string, body: Doc) =>
    call('POST', `/api/projects/${projectId}/integrations/coolify/deploy`, body);
  const queued = async () =>
    rows<{ data: OutboundDispatchJob }>(sql`
      SELECT data FROM pgboss_v12.job WHERE name = 'forge.integrations' ORDER BY created_on`);

  beforeEach(async () => {
    await rows(sql`DELETE FROM pgboss_v12.job WHERE name = 'forge.integrations'`);
    deployed.length = 0;
    repo.head = sha(0x1ff);
    repo.incomplete = false;
    repo.ranges.clear();
    repo.files.clear();
    deployments.set(WEB.resourceUuid, [
      {
        deployment_uuid: 'old',
        status: 'finished',
        created_at: '2026-10-08T09:00:00Z',
        commit: sha(0x99),
      },
      {
        deployment_uuid: 'now',
        status: 'finished',
        created_at: '2026-10-09T09:00:00Z',
        commit: SERVED,
      },
      {
        deployment_uuid: 'bad',
        status: 'failed',
        created_at: '2026-10-09T09:30:00Z',
        commit: sha(0x98),
      },
    ]);
    repo.files.set(C1, [WEB_FILE]);
    repo.files.set(C2, ['packages/web-v2/public/logo.svg']);
    repo.files.set(KERNEL_COMMIT, [KERNEL_FILE]);
  });

  it('ships web alone when every commit since what web serves is fast', async () => {
    repo.ranges.set(`${SERVED}..${repo.head}`, [C1, C2]);
    const res = await deploy(declared, { targets: ['web'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dispatched: true,
      lane: 'fast',
      targets: [{ label: 'web', served: SERVED, head: repo.head, commits: 2 }],
    });
    const [job, ...more] = await queued();
    expect(more).toEqual([]);
    expect(job?.data.payload).toMatchObject({ targetLabels: ['web'] });

    const { runOutboundDispatch } = await import('../../src/integrations/queue.js');
    await runOutboundDispatch(job?.data as OutboundDispatchJob);
    expect(deployed).toEqual([WEB.resourceUuid]);
  });

  it('refuses when a kernel commit sits in the range, naming the commit, the file and the rule', async () => {
    repo.ranges.set(`${SERVED}..${repo.head}`, [C1, KERNEL_COMMIT]);
    const res = await deploy(declared, { targets: ['web'] });
    expect([res.status, codes(res)]).toEqual([422, ['FAST_LANE_NOT_ELIGIBLE']]);
    expect(detail(res)).toContain(
      `${KERNEL_COMMIT.slice(0, 12)}: ${KERNEL_FILE} (kernel: \`packages/core/**\`)`,
    );
    expect(await queued()).toEqual([]);
  });

  it('refuses a range it cannot read whole, and a target whose served commit is unknown', async () => {
    repo.ranges.set(`${SERVED}..${repo.head}`, [C1]);
    repo.incomplete = true;
    const partial = await deploy(declared, { targets: ['web'] });
    expect([partial.status, codes(partial)]).toEqual([503, ['FAST_LANE_UNVERIFIED']]);
    repo.incomplete = false;
    deployments.set(WEB.resourceUuid, [
      {
        deployment_uuid: 'x',
        status: 'failed',
        created_at: '2026-10-09T09:00:00Z',
        commit: SERVED,
      },
    ]);
    const unknown = await deploy(declared, { targets: ['web'] });
    expect([unknown.status, codes(unknown)]).toEqual([503, ['FAST_LANE_UNVERIFIED']]);
    expect(detail(unknown)).toContain('what it serves is unknown');
    expect(await queued()).toEqual([]);
  });

  it('refuses a target the declaration does not name, and a project that declares none', async () => {
    const core = await deploy(declared, { targets: ['core'] });
    expect([core.status, codes(core)]).toEqual([422, ['FAST_LANE_UNDECLARED']]);
    expect(detail(core)).toContain('"core" is not among `fastLane.deployTargets`');
    const none = await deploy(undeclared, { targets: ['web'] });
    expect(codes(none)).toEqual(['FAST_LANE_UNDECLARED']);
    expect(await queued()).toEqual([]);
  });

  it('the agent tool takes the same guard: refused over a kernel commit, web alone over fast ones', async () => {
    const pat = await patToken(ownerId, [declared]);
    const tool = async (args: Doc) => {
      const res = await api(
        pat,
        'POST',
        '/mcp',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'forge_coolify_deploy', arguments: args },
        },
        { accept: 'application/json, text/event-stream' },
      );
      return JSON.stringify(res.body);
    };
    repo.ranges.set(`${SERVED}..${repo.head}`, [KERNEL_COMMIT]);
    const refused = await tool({ action: 'deploy', projectId: declared, targets: ['web'] });
    expect(refused).toContain('FAST_LANE_NOT_ELIGIBLE');
    expect(refused).toContain(KERNEL_COMMIT.slice(0, 12));
    expect(await queued()).toEqual([]);
    repo.ranges.set(`${SERVED}..${repo.head}`, [C1]);
    const shipped = await tool({ action: 'deploy', projectId: declared, targets: ['web'] });
    expect(shipped).toContain('\\"lane\\":\\"fast\\"');
    const [job] = await queued();
    expect(job?.data.payload).toMatchObject({ targetLabels: ['web'] });
  });

  it('deploys every target without `targets`, as before', async () => {
    const res = await deploy(declared, { integrationId: bindingId });
    expect(res.body.dispatched).toBe(true);
    const [job] = await queued();
    expect(job?.data.payload).toBeUndefined();
    const { runOutboundDispatch } = await import('../../src/integrations/queue.js');
    await runOutboundDispatch(job?.data as OutboundDispatchJob);
    expect(deployed).toEqual([WEB.resourceUuid, CORE.resourceUuid]);
  });
});
