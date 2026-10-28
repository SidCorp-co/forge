/**
 * An agreed requirement whose capability already shipped (ISS-588, REQ-74 BC-4 and BC-5): REQ-45 r3
 * BC-8 forbids an issue whose only work is verifying it, so a breakdown is never the master's to
 * propose there. Its business criteria are judged on the running build at the requirement itself
 * (POST …/requirements/:req/verdicts), each verdict read back on the criterion it judged in the
 * requirement's standing. Where they all pass it waits on its accept and owes no breakdown; where one
 * does not, the standing names that criterion as the cause and the agent whose act is next. With no
 * such verdict nothing says it shipped, so its breakdown stays owed. Through the app's own routes,
 * against real Postgres, with the live build planted (`tests/helpers/live-build.ts`).
 */
// @direct-test-of packages/core/src/requirements/standing-facts.ts
// @direct-test-of packages/core/src/requirements/standing-read.ts
// @direct-test-of packages/core/src/requirements/verdicts-read.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import { owedBreakdowns } from '../../src/requirements/owed-breakdowns.js';
import { api, userToken } from '../helpers/api.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

/** The commit production serves, holding SHIPPED and not ELSEWHERE. */
const LIVE = '9999999999999999999999999999999999999999';
const SHIPPED = '1111111111111111111111111111111111111111';
const ELSEWHERE = '2222222222222222222222222222222222222222';
const CLIP = 'https://forge-dev.example/clips/catalog.webm';

let projectId = '';
let ownerId = '';
let token = '';
let unplant: (() => void) | null = null;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (
    await createTestProject(ownerId, { policy: { ...DEFAULT_POLICY, qa: 'independent' } })
  ).id;
  token = await userToken(ownerId);
  // a runner is bound, so a wait on the master reads as the master's (FB-77)
  await bindTestRunner(projectId, await createTestDevice(ownerId));
  unplant = plantLiveBuild(LIVE, { [SHIPPED]: true, [ELSEWHERE]: false });
});

afterEach(() => {
  unplant?.();
  unplant = null;
});

type Answer = { status: number; body: Record<string, unknown> };
type Said = { key: string; vars?: Record<string, unknown> };
type Verdict = {
  verdict: string;
  evidence: string[];
  commit: string | null;
  inLiveBuild: boolean | null;
  notCounted: string | null;
  note: string | null;
};
type Bc = {
  code: string;
  verdict: string;
  verdicts: Verdict[];
  counts: { source: string; verdict: string } | null;
};
type Standing = {
  next: string | null;
  tasks: { kind: string }[];
  coverage: Bc[];
  waitingOn: { kind: string; says: { who: Said; act: Said; rule: Said } };
};

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

async function ok(r: Promise<Answer>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

const refusalsOf = (r: Answer) =>
  (r.body.error as { refusals?: { code: string; path: string; detail: string }[] } | undefined)
    ?.refusals ?? [];

async function requirement(agree = true): Promise<string> {
  const created = await ok(
    onProject('POST', '/requirements', {
      title: 'Catalog',
      reason: 'planted',
      criteria: [{ body: 'A site lists its catalog' }, { body: 'A search narrows the list' }],
    }),
  );
  const key = String(created.key);
  if (!agree) return key;
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  await ok(onProject('POST', `/requirements/${key}/revisions/1/propose`, {}));
  await ok(onProject('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'Accepted for this test.' }));
  await ok(
    onProject('POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    }),
  );
  return key;
}

const judge = (
  req: string,
  criterion: string,
  verdict: 'pass' | 'fail' | 'short' | 'skipped',
  more: Record<string, unknown> = {},
) =>
  onProject('POST', `/requirements/${req}/verdicts`, {
    criterion,
    verdict,
    reason: `${verdict} on the running build`,
    identity: { kind: 'commit', sha: SHIPPED },
    evidence: [CLIP],
    ...more,
  });

const standingOf = async (req: string) =>
  (await ok(onProject('GET', `/requirements/${req}`))).standing as Standing;

const bc = (s: Standing, code: string) => s.coverage.find((c) => c.code === code) as Bc;

const owedKeys = async () => (await owedBreakdowns(projectId)).map((b) => b.key);

describe('an agreed requirement with no issue', () => {
  it('owes its breakdown while no verdict says its capability shipped', async () => {
    const req = await requirement();
    const s = await standingOf(req);
    expect(s.tasks.map((t) => t.kind)).toEqual(['breakdown']);
    expect(s.waitingOn.says.who.key).toBe('standing.who.master');
    expect(s.waitingOn.says.act.key).toBe('standing.act.breakDownBy');
    expect(await owedKeys()).toEqual([req]);
  });

  it('met on every criterion by the shipped capability, owes no breakdown and waits on its accept', async () => {
    const req = await requirement();
    for (const code of ['BC-1', 'BC-2']) expect((await judge(req, code, 'pass')).status).toBe(201);

    const s = await standingOf(req);
    expect(s.tasks.map((t) => t.kind)).toEqual([]);
    expect(s.waitingOn.says.act.key).toBe('standing.act.acceptShipped');
    expect(s.waitingOn.says.rule.key).toBe('requirements.rule.shippedProven');
    expect(s.next).toBe('accepted');
    expect(await owedKeys()).toEqual([]);

    // the accept it waits on is taken, by its checklist, with no decision over it
    const accepted = await onProject('POST', `/requirements/${req}/accept`, { revision: 1 });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await standingOf(req)).waitingOn.says.rule.key).toBe('requirements.rule.ended');
  });
});

describe('a requirement-level verdict', () => {
  it('reads on the criterion it judged, in the standing and in its own list', async () => {
    const req = await requirement();
    const written = await judge(req, 'BC-2', 'pass');
    expect(written.status, JSON.stringify(written.body)).toBe(201);
    expect((written.body.coverage as Bc).code).toBe('BC-2');

    const s = await standingOf(req);
    const two = bc(s, 'BC-2');
    expect(two.verdict).toBe('passing');
    expect(two.counts?.source).toBe('requirement');
    expect(two.verdicts).toHaveLength(1);
    expect(two.verdicts[0]).toMatchObject({
      verdict: 'pass',
      evidence: [CLIP],
      commit: SHIPPED,
      inLiveBuild: true,
      notCounted: null,
      note: 'pass on the running build',
    });
    expect(bc(s, 'BC-1').verdicts).toEqual([]);

    const list = await ok(onProject('GET', `/requirements/${req}/verdicts`));
    expect(
      (list.verdicts as { criterion: string; verdict: string; commit: string }[]).map((v) => [
        v.criterion,
        v.verdict,
        v.commit,
      ]),
    ).toEqual([['BC-2', 'pass', SHIPPED]]);
  });

  it('is refused by name where its criterion, citation, commit or requirement is wrong', async () => {
    const req = await requirement();
    const unknown = await judge(req, 'BC-9', 'pass');
    expect(unknown.status).toBe(422);
    expect(refusalsOf(unknown).map((r) => [r.code, r.path])).toEqual([
      ['REQUIREMENT_VERDICT_CRITERION_UNKNOWN', '/criterion'],
    ]);
    expect(refusalsOf(unknown)[0]?.detail).toContain('BC-1, BC-2');

    const uncited = await judge(req, 'BC-1', 'pass', { evidence: [] });
    expect(uncited.status).toBe(422);
    expect(refusalsOf(uncited).map((r) => [r.code, r.path])).toEqual([
      ['REQUIREMENT_VERDICT_UNCITED', '/evidence'],
    ]);

    const abbreviated = await judge(req, 'BC-1', 'pass', {
      identity: { kind: 'commit', sha: '1111111' },
    });
    expect(abbreviated.status).toBe(422);
    expect(refusalsOf(abbreviated).map((r) => r.code)).toEqual(['VERDICT_COMMIT_NOT_FULL']);

    const unknownKey = await judge(req, 'BC-1', 'pass', { issue: 'ISS-1' });
    expect(unknownKey.status).toBe(400);

    const draft = await requirement(false);
    const early = await judge(draft, 'BC-1', 'pass');
    expect(early.status).toBe(422);
    expect(refusalsOf(early).map((r) => r.code)).toEqual(['REQUIREMENT_VERDICT_NOT_DELIVERING']);

    const nothing = await ok(onProject('GET', `/requirements/${req}/verdicts`));
    expect(nothing.verdicts).toEqual([]);
  });
});

describe('a shipped requirement that needs attention', () => {
  it('names the unjudged criterion and the judge whose act is next, and owes no breakdown', async () => {
    const req = await requirement();
    await ok(judge(req, 'BC-1', 'pass'));
    const s = await standingOf(req);
    expect(s.tasks.map((t) => t.kind)).toEqual([]);
    expect(s.waitingOn.kind).toBe('agent');
    expect(s.waitingOn.says.who.key).toBe('standing.who.independentJudge');
    expect(s.waitingOn.says.act).toEqual({
      key: 'standing.act.judgeShipped',
      vars: { codes: 'BC-2' },
    });
    expect(JSON.stringify(s.waitingOn.says.rule)).toContain('BC-2');
    expect(JSON.stringify(s.waitingOn.says.rule)).not.toContain('BC-1');
    expect(await owedKeys()).toEqual([]);
  });

  it('reads a verdict at a build the live one does not hold as not counted, naming why', async () => {
    const req = await requirement();
    await ok(judge(req, 'BC-1', 'pass'));
    await ok(judge(req, 'BC-2', 'pass', { identity: { kind: 'commit', sha: ELSEWHERE } }));
    const s = await standingOf(req);
    const two = bc(s, 'BC-2');
    expect(two.verdict).toBe('not_live');
    expect(two.verdicts[0]?.notCounted).toContain('does not hold');
    expect(s.waitingOn.says.who.key).toBe('standing.who.independentJudge');
    expect(s.waitingOn.says.act.vars).toEqual({ codes: 'BC-2' });
  });

  it('names the failing criterion and the master, who now owes a breakdown for it', async () => {
    const req = await requirement();
    await ok(judge(req, 'BC-1', 'pass'));
    await ok(judge(req, 'BC-2', 'fail'));
    const s = await standingOf(req);
    expect(bc(s, 'BC-2').verdict).toBe('failing');
    expect(s.waitingOn.says.who.key).toBe('standing.who.master');
    expect(s.waitingOn.says.act).toEqual({
      key: 'standing.act.breakDownFailing',
      vars: { codes: 'BC-2' },
    });
    expect(JSON.stringify(s.waitingOn.says.rule)).toContain('BC-2');
    expect(s.tasks.map((t) => t.kind)).toEqual(['breakdown']);
    expect(await owedKeys()).toEqual([req]);
  });
});
