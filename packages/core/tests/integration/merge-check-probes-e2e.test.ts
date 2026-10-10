/**
 * A merge runs the change's kept probes (REQ-36 BC-1, BC-9; ISS-472 round 4). Core holds a merge
 * check's report to the probes the issue keeps when it is recorded: a kept probe the report did not
 * run, or an observable criterion keeping none, is refused MERGE_PROBE_MISSING; one that ran red is
 * refused MERGE_PROBE_RED; a code property owes none. A passing record names the probes it ran and no
 * longer says probes are "not yet at merge".
 *
 * It reaches its subject over HTTP, so it names what it guards:
 * @direct-test-of packages/core/src/issues/merge-check.ts
 * @direct-test-of packages/core/src/issues/merge-check-rules.ts
 * @direct-test-of packages/contracts/src/merge-check.ts
 */

import { randomUUID } from 'node:crypto';
import { REQUIRED_MERGE_CHECKS } from '@forge/contracts/merge-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { THIS_REPOSITORY } from '../../src/lib/this-repository.js';
import { userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestModule,
  createTestUser,
} from '../helpers/factories.js';
import { passingCheck, passingReport } from '../helpers/merge-check-report.js';
import { callerFor, ok, projectBuiltFrom, refusalCodes } from '../helpers/pattern-world.js';

const tokens = { admin: '', author: '', viewer: '' };
const call = callerFor(tokens);
let adminId = '';
let forge = '';
let seq = 0;

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

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

/** An issue whose design classes criteria 1 and 3 observable and 2 a code property. */
async function designedIssue(): Promise<string> {
  seq += 1;
  const { id } = await createTestIssue(forge, adminId, seq, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  ok(
    await call('admin', 'PATCH', `/api/issues/${id}`, {
      plan: 'Build it to the catalogued pattern.',
      acceptanceCriteria:
        '1. The page shows it.\n2. The rule lives in one module.\n3. The list shows it.',
    }),
  );
  ok(
    await call('author', 'PUT', `/api/issues/${id}/design`, {
      criteria: [
        { criterion: 1, class: 'observable', pattern: 'api-route', proof: 'run the probe' },
        { criterion: 2, class: 'code_property', pattern: 'core-module', proof: 'review' },
        { criterion: 3, class: 'observable', pattern: 'api-route', proof: 'run the probe' },
      ],
      modules: ['issues'],
      contracts: [],
    }),
  );
  return id;
}

/** Keep a command probe on `criterion` with a pass, and answer its id. */
async function keep(issue: string, criterion: number): Promise<string> {
  const res = ok(
    await call('author', 'POST', `/api/issues/${issue}/verdicts`, {
      criterion,
      verdict: 'pass',
      reason: 'ran it',
      identity: { kind: 'commit', sha: HEAD },
      probe: {
        kind: 'command',
        command: { argv: ['node', 'scripts/probe.mjs', String(criterion)] },
        expect: { exitCode: 0, stdoutIncludes: ['held'] },
      },
    }),
    201,
  );
  return res.criterion.probe.id as string;
}

/** A full-lane report whose `probes` checks ran `ran`, each bound to its kept probe. */
function reportRunning(ran: { criterion: number; probe: string; result?: 'pass' | 'fail' | 'none' }[]) {
  const probeChecks = ran.map((r) => ({
    ...passingCheck('probes'),
    scope: `criterion ${r.criterion}`,
    result: r.result ?? 'pass',
    ...(r.result === 'fail' ? { note: 'it exited 1, expected 0' } : {}),
  }));
  const others = REQUIRED_MERGE_CHECKS.filter((n) => n !== 'probes').map((n) => passingCheck(n));
  return passingReport({
    base: { branch: 'dev', sha: BASE },
    head: HEAD,
    touched: [{ path: 'packages/core/src/issues/x.ts', change: 'changed' }],
    checks: [...others, ...(probeChecks.length ? probeChecks : [{ ...passingCheck('probes'), result: 'none' as const }])],
    probes: ran.map((r, i) => ({ criterion: r.criterion, probe: r.probe, check: probeChecks[i]!.id })),
  });
}

const record = (issue: string, body: unknown) =>
  call('author', 'POST', `/api/issues/${issue}/merge-check`, body);

const verifications = async (issue: string): Promise<Doc[]> =>
  (ok(await call('viewer', 'GET', `/api/issues/${issue}/events`)).items as Doc[]).filter(
    (e) => e.kind === 'verification',
  );

const detailOf = (res: { body: Doc }): string => JSON.stringify(res.body.error?.refusals ?? []);

describe("a merge check is held to the issue's kept probes", () => {
  it('refuses MERGE_PROBE_MISSING for an observable criterion keeping no probe, recording nothing', async () => {
    const issue = await designedIssue();
    const one = await keep(issue, 1);
    const res = await record(issue, reportRunning([{ criterion: 1, probe: one }]));
    expect([res.status, refusalCodes(res)]).toEqual([422, ['MERGE_PROBE_MISSING']]);
    expect(detailOf(res)).toContain('criterion 3 is observable and keeps no probe');
    expect(await verifications(issue)).toEqual([]);
  });

  it('refuses MERGE_PROBE_MISSING for a kept probe the report did not run, or could not', async () => {
    const issue = await designedIssue();
    const one = await keep(issue, 1);
    const three = await keep(issue, 3);
    const skipped = await record(issue, reportRunning([{ criterion: 1, probe: one }]));
    expect(refusalCodes(skipped)).toEqual(['MERGE_PROBE_MISSING']);
    expect(detailOf(skipped)).toContain(`criterion 3's kept probe ${three} was not run`);
    const unrun = await record(
      issue,
      reportRunning([
        { criterion: 1, probe: one },
        { criterion: 3, probe: three, result: 'none' },
      ]),
    );
    expect(refusalCodes(unrun)).toEqual(['MERGE_PROBE_MISSING']);
    expect(detailOf(unrun)).toContain("criterion 3's kept probe did not run");
    expect(await verifications(issue)).toEqual([]);
  });

  it('refuses MERGE_PROBE_RED for a kept probe that ran red, naming it', async () => {
    const issue = await designedIssue();
    const one = await keep(issue, 1);
    const three = await keep(issue, 3);
    const res = await record(
      issue,
      reportRunning([
        { criterion: 1, probe: one },
        { criterion: 3, probe: three, result: 'fail' },
      ]),
    );
    expect([res.status, refusalCodes(res)]).toEqual([422, ['MERGE_PROBE_RED']]);
    expect(detailOf(res)).toContain('`probes` (criterion 3)');
    expect(detailOf(res)).toContain('it exited 1, expected 0');
    expect(await verifications(issue)).toEqual([]);
  });

  it('records a report that ran every kept probe green, naming them', async () => {
    const issue = await designedIssue();
    const one = await keep(issue, 1);
    const three = await keep(issue, 3);
    ok(
      await record(
        issue,
        reportRunning([
          { criterion: 1, probe: one },
          { criterion: 3, probe: three },
        ]),
      ),
      201,
    );
    const [kept] = await verifications(issue);
    const field = (key: string) => (kept?.fields as Doc[]).find((f) => f.key === key)?.value;
    expect(field('probes')).toBe('2 kept probe(s) ran and held, for criteria 1, 3');
    expect(field('not-checked')).not.toContain('probe');
  });

  it('refuses a binding that names no probes check of the report, at its path', async () => {
    const issue = await designedIssue();
    const one = await keep(issue, 1);
    const body = reportRunning([{ criterion: 1, probe: one }]);
    const res = await record(issue, { ...body, probes: [{ criterion: 1, probe: one, check: randomUUID() }] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('is not a `probes` check of this report');
  });
});
