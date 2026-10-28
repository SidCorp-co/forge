/**
 * A check seen only inside the running server is judged by QA from its attached capture, with no
 * screen clip and no replayed probe (REQ-36 BC-21). adminhub-api ISS-54 c5, 2026-10-28: a route
 * check run inside the stg pod (tree fingerprint, in-process route list, kernel 404s) had no class
 * that fitted. As `observable` it owed a WebM clip and a kept probe no deploy's replay can run inside
 * a pod, so it was reclassed `code_property` and recorded as the review's, which it is not.
 *
 * `server_side` is that class: QA's, citing a capture attached to the issue, refused by name where it
 * cites none or sends a probe, while an `observable` criterion on the same issue still owes its clip
 * and its probe (REQ-40 BC-4, REQ-36 BC-6).
 *
 * @direct-test-of packages/core/src/issues/criteria/clip-citation.ts
 * @direct-test-of packages/core/src/issues/criteria/probe-rules.ts
 * @direct-test-of packages/core/src/issues/criteria/probes.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-record.ts
 * @direct-test-of packages/core/src/db/schema-issue-designs.ts
 * @direct-test-of packages/contracts/src/issue-design.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { THIS_REPOSITORY } from '../../src/lib/this-repository.js';
import { userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestModule,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import {
  callerFor,
  ok,
  projectBuiltFrom,
  type Res,
  refusalCodes as refused,
} from '../helpers/pattern-world.js';

const tokens = { admin: '', author: '', viewer: '' };
const call = callerFor(tokens);
let adminId = '';
let forge = '';
let seq = 0;

const SHA = 'd'.repeat(40);
const CAPTURE = 'stg-raw-a23929d2-2026-10-28.txt';

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const admin = await createTestUser({ verified: true });
  const author = await createTestUser({ kind: 'agent' });
  const viewer = await createTestUser({ verified: true });
  adminId = admin.id;
  forge = await projectBuiltFrom(admin.id, THIS_REPOSITORY);
  await createTestModule(forge, 'issues');
  await addProjectMember(forge, admin.id, 'admin');
  await addProjectMember(forge, author.id, 'member');
  await addProjectMember(forge, viewer.id, 'viewer');
  tokens.admin = await userToken(admin.id);
  tokens.author = await userToken(author.id);
  tokens.viewer = await userToken(viewer.id);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** An in-progress issue whose criterion 1 is observable and criterion 2 a server-side check. */
async function issueWithServerCheck(): Promise<string> {
  seq += 1;
  const { id } = await createTestIssue(forge, adminId, seq, {
    status: 'open',
    createdAt: new Date(),
  });
  ok(
    await call('admin', 'PATCH', `/api/issues/${id}`, {
      plan: 'Remove the two unauthenticated routes.',
      acceptanceCriteria:
        '1. The log page answers 404 to a visitor.\n2. Inside the stg pod, route:list holds neither route and an in-process call to each answers 404.',
    }),
  );
  ok(
    await call('author', 'PUT', `/api/issues/${id}/design`, {
      criteria: [
        { criterion: 1, class: 'observable', pattern: 'api-route', proof: 'open it, see 404' },
        {
          criterion: 2,
          class: 'server_side',
          pattern: 'api-route',
          proof:
            'capture from inside the pod: tree fingerprint, router read in-process, kernel 404s',
        },
      ],
      modules: ['issues'],
      contracts: [],
    }),
  );
  return id;
}

async function attach(issue: string, name: string, type: string, text: string): Promise<string> {
  const { app } = await import('../../src/index.js');
  const fd = new FormData();
  fd.append('file', new File([new TextEncoder().encode(text)], name, { type }));
  const res = await app.fetch(
    new Request(`http://forge.test/api/issues/${issue}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.author}` },
      body: fd,
    }),
  );
  expect(res.status, await res.clone().text()).toBe(201);
  const body = (await res.json()) as Doc;
  return String(body.id ?? body.attachment?.id);
}

const verdict = (issue: string, body: Doc, as: 'author' | 'admin' = 'author') =>
  call(as, 'POST', `/api/issues/${issue}/verdicts`, {
    reason: 'route:list in the pod holds neither route; both calls answered 404, 50 bytes',
    identity: { kind: 'commit', sha: SHA },
    ...body,
  });

const stored = async (issue: string) =>
  (
    await rows<{ probes: number; verdicts: number }>(sql`
      SELECT (SELECT count(*)::int FROM criterion_probes WHERE issue_id = ${issue}) AS probes,
             (SELECT count(*)::int FROM criterion_verdicts WHERE issue_id = ${issue}) AS verdicts`)
  )[0];

const pathsOf = (res: Res): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.path as string);

/** The fields of the newest verdict record on the issue, by key. */
async function lastVerdictFields(issue: string): Promise<Record<string, string[]>> {
  const body = ok(await call('viewer', 'GET', `/api/issues/${issue}/events`));
  const list: Doc[] = Array.isArray(body) ? body : (body.events ?? body.items ?? []);
  const last = list
    .filter((e) => e.kind === 'verdict')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .at(-1);
  const out: Record<string, string[]> = {};
  for (const f of (last?.fields ?? []) as Doc[]) {
    out[f.key] = [...(out[f.key] ?? []), String(f.value)];
  }
  return out;
}

describe('a design classes a check seen only inside the running server (REQ-36 BC-21)', () => {
  it('keeps the class and routes it to QA in the design and the criteria read', async () => {
    const issue = await issueWithServerCheck();
    const design = ok(await call('viewer', 'GET', `/api/issues/${issue}/design`));
    const line = (design.design ?? design).criteria.find((c: Doc) => c.criterion === 2);
    expect([line.class, line.judge]).toEqual(['server_side', 'qa']);
    const criteria = ok(await call('viewer', 'GET', `/api/issues/${issue}/criteria`)).criteria;
    const two = criteria.find((c: Doc) => c.n === 2);
    expect([two.class, two.judge]).toEqual(['server_side', 'qa']);
  });

  it('refuses a class no catalog names, by name', async () => {
    const issue = await issueWithServerCheck();
    const res = await call('author', 'PUT', `/api/issues/${issue}/design`, {
      criteria: [
        { criterion: 1, class: 'observable', pattern: 'api-route', proof: 'open it' },
        { criterion: 2, class: 'pod_side', pattern: 'api-route', proof: 'capture' },
      ],
      modules: ['issues'],
      contracts: [],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('/criteria/1/class');
    expect(JSON.stringify(res.body)).toContain('server_side');
  });
});

describe('a judgement of a server-side check cites its capture, with no clip and no probe', () => {
  it('takes a pass citing a text capture attached to the issue, keeping no probe, and its record says why none is owed', async () => {
    const issue = await issueWithServerCheck();
    await attach(
      issue,
      CAPTURE,
      'text/plain',
      'sha256 20e95071 2163 files\nroutes 931, 0 match\n404 50\n',
    );
    const res = await verdict(issue, { criterion: 2, verdict: 'pass', evidence: [CAPTURE] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await stored(issue)).toEqual({ probes: 0, verdicts: 1 });
    const fields = await lastVerdictFields(issue);
    expect(fields.judge).toEqual(['qa']);
    expect(fields.probe).toEqual(['not owed: a server-side check is judged from its capture']);
    expect(fields.evidence).toEqual([CAPTURE]);
    expect(fields['without-clip']).toBeUndefined();
  });

  it('takes the capture cited by its id or its download URL', async () => {
    const issue = await issueWithServerCheck();
    const id = await attach(issue, 'pod-capture.log', 'text/plain', 'route:list exit 0\n');
    for (const cite of [id, `/api/attachments/${id}/download`]) {
      const res = await verdict(issue, { criterion: 2, verdict: 'short', evidence: [cite] });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
  });

  it('refuses a pass, a short and a fail citing no capture, a file not attached, or a why in place of one', async () => {
    const issue = await issueWithServerCheck();
    const other = await issueWithServerCheck();
    await attach(other, 'elsewhere.txt', 'text/plain', 'not this issue\n');
    const tries: Doc[] = [
      { evidence: [] },
      { evidence: ['never-uploaded.txt'] },
      { evidence: ['elsewhere.txt'] },
      { evidence: [], withoutClip: 'a pod check: nothing on screen' },
    ];
    for (const word of ['pass', 'short', 'fail']) {
      for (const t of tries) {
        const res = await verdict(issue, { criterion: 2, verdict: word, ...t });
        expect([res.status, refused(res)], JSON.stringify(t)).toEqual([
          422,
          ['VERDICT_CAPTURE_REQUIRED'],
        ]);
        expect(pathsOf(res)).toEqual(['/evidence']);
        expect(res.body.error.refusals[0].detail).toContain(
          `a \`${word}\` on it cites the capture`,
        );
      }
    }
    expect(await stored(issue)).toEqual({ probes: 0, verdicts: 0 });
  });

  it('takes a skip, which judged nothing, with no capture', async () => {
    const issue = await issueWithServerCheck();
    const res = await verdict(issue, {
      criterion: 2,
      verdict: 'skipped',
      reason: 'the stg pod was not reachable from this box',
      identity: null,
      evidence: [],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('refuses a probe sent with it: no replay reaches inside the running server', async () => {
    const issue = await issueWithServerCheck();
    await attach(issue, CAPTURE, 'text/plain', 'routes 931, 0 match\n');
    for (const probe of [
      {
        kind: 'command',
        command: { argv: ['php', 'artisan', 'route:list'] },
        expect: { exitCode: 0 },
      },
      {
        kind: 'request',
        request: { method: 'GET', path: '/restart-queue', as: 'anonymous' },
        expect: { status: 404 },
      },
    ]) {
      const res = await verdict(issue, {
        criterion: 2,
        verdict: 'pass',
        evidence: [CAPTURE],
        probe,
      });
      expect([res.status, refused(res)]).toEqual([422, ['VERDICT_PROBE_SERVER_SIDE']]);
      expect(pathsOf(res)).toEqual(['/probe']);
    }
    expect(await stored(issue)).toEqual({ probes: 0, verdicts: 0 });
  });

  it('is QA’s: recorded as the review’s it is refused, as an observable criterion is', async () => {
    const issue = await issueWithServerCheck();
    await attach(issue, CAPTURE, 'text/plain', 'routes 931, 0 match\n');
    const res = await verdict(issue, {
      criterion: 2,
      verdict: 'pass',
      evidence: [CAPTURE],
      judge: 'review',
    });
    expect([res.status, refused(res)]).toEqual([422, ['VERDICT_JUDGED_BY_QA']]);
  });

  it('passes the comment fence with an evidence line naming the capture, and is refused there without one', async () => {
    const issue = await issueWithServerCheck();
    await attach(issue, CAPTURE, 'text/plain', 'routes 931, 0 match\n');
    const block = (evidence: string) =>
      call('author', 'POST', `/api/issues/${issue}/comments`, {
        intent: 'note',
        body: [
          '```forge-record: verdict · contract 1',
          'criterion: 2',
          'verdict: pass',
          `commit: ${SHA}`,
          `evidence: ${evidence}`,
          'why: route:list in the pod holds neither route',
          '```',
        ].join('\n'),
      });
    const bare = await block('not-attached.txt');
    expect(bare.status).toBe(422);
    expect(String(bare.body.detail)).toContain('VERDICT_CAPTURE_REQUIRED');
    const cited = await block(CAPTURE);
    expect(cited.status, JSON.stringify(cited.body)).toBe(201);
    expect(await stored(issue)).toEqual({ probes: 0, verdicts: 1 });
  });
});

describe('an observable criterion beside it still owes its clip and its probe (REQ-40 BC-4, REQ-36 BC-6)', () => {
  it('refuses the same text capture as a clip, and a why without a probe', async () => {
    const issue = await issueWithServerCheck();
    await attach(issue, CAPTURE, 'text/plain', 'routes 931, 0 match\n');
    const noClip = await verdict(issue, { criterion: 1, verdict: 'pass', evidence: [CAPTURE] });
    expect(refused(noClip)).toEqual(['VERDICT_CLIP_REQUIRED']);
    expect(noClip.body.error.refusals[0].detail).toContain('classed `server_side`');
    const noProbe = await verdict(issue, {
      criterion: 1,
      verdict: 'pass',
      evidence: [CAPTURE],
      withoutClip: 'a 404 page has nothing worth recording',
    });
    expect(refused(noProbe)).toEqual(['VERDICT_PROBE_REQUIRED']);
    expect(await stored(issue)).toEqual({ probes: 0, verdicts: 0 });
  });
});
