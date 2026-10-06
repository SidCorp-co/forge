import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  formEcosystem,
  ok,
  openWorld,
  type Reply,
  sender,
  writeInterfaces,
} from '../helpers/ecosystem-world.js';

let w: EcosystemWorld;
let say: ReturnType<typeof sender>;

beforeAll(async () => {
  w = await openWorld();
  await formEcosystem(w);
  await writeInterfaces(w);
  say = sender(w);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const at = (path: string) => `/api/projects/${w.project.plugin}${path}`;
const refusedAt = (r: Reply): string[] => {
  expect(r.status, JSON.stringify(r.json)).toBe(422);
  return (r.json.error?.refusals ?? []).map((x: Doc) => `${x.code} ${x.path}`);
};

const ids: Record<string, string> = {};
let req = '';

function breakdown(waits: Doc[] | undefined): Doc {
  return {
    kind: 'breakdown',
    requirement: req,
    baseRevision: 1,
    payload: {
      issues: [
        {
          title: 'Send policyVersion on every run-session open',
          criteria: [{ body: 'every open names the policy version', tracesTo: 'BC-1' }],
          complexity: 's',
          ...(waits ? { contractWaits: waits } : {}),
        },
      ],
    },
  };
}

describe('an agreed requirement to break down', () => {
  it('is written and agreed by the plugin admin', async () => {
    const made = ok(
      await say('plugin', 'POST', at('/requirements'), {
        title: 'Run sessions name the dispatch policy',
        reason: 'forge-api 2026-12-01 requires it',
        criteria: [{ body: 'Every run-session open names the policy version that took the work.' }],
      }),
      201,
    );
    req = made.key;
    expect(req).toMatch(/^REQ-\d+$/);
    ok(await say('plugin', 'POST', at(`/requirements/${req}/revisions/1/propose`), {}));
    ok(
      await say('plugin', 'POST', at(`/requirements/${req}/revisions/1/accept`), {
        reason: 'the text the plugin builds',
      }),
    );
    const agreed = ok(
      await say('plugin', 'POST', at(`/requirements/${req}/agree`), {
        revision: 1,
        reason: 'what the plugin owes the platform',
      }),
    );
    expect(JSON.stringify(agreed)).toContain('agreed');
  });
});

describe('a breakdown item carries its contract waits', () => {
  const plants: [string, Doc, string][] = [
    [
      'a version outside the provider scheme',
      { contract: 'forge/forge-api', minVersion: '12.1' },
      'CONTRACT_WAIT_VERSION_NOT_IN_SCHEME /payload/issues/0/contractWaits/0/minVersion',
    ],
    [
      'a contract the interface does not name',
      { contract: 'forge/runner-api', minVersion: '2026-12-01' },
      'CONTRACT_WAIT_CONTRACT_UNKNOWN /payload/issues/0/contractWaits/0/contract',
    ],
  ];

  it.each(plants)('refuses %s at propose, at the wait path', async (_n, wait, want) => {
    expect(refusedAt(await say('plugin', 'POST', at('/suggestions'), breakdown([wait])))).toEqual([
      want,
    ]);
  });

  it('refuses two waits of one item on the same contract', async () => {
    const res = await say(
      'plugin',
      'POST',
      at('/suggestions'),
      breakdown([
        { contract: 'forge/forge-api', minVersion: '2026-12-01' },
        { contract: 'forge/forge-api', minVersion: '2026-12-15' },
      ]),
    );
    expect(refusedAt(res)).toEqual([
      'CONTRACT_WAIT_DUPLICATE /payload/issues/0/contractWaits/1/contract',
    ]);
  });

  it('files the issue at draft holding its wait, named in the accept effect', async () => {
    const proposed = ok(
      await say(
        'plugin',
        'POST',
        at('/suggestions'),
        breakdown([{ contract: 'forge/forge-api', minVersion: '2026-12-01' }]),
      ),
      201,
    );
    ids.suggestion = proposed.suggestion.id;
    const accepted = ok(
      await say('plugin', 'POST', at(`/suggestions/${ids.suggestion}/accept`), {
        reason: 'the plan the plugin works',
      }),
    );
    const effect = accepted.effect;
    const [filed] = effect.issues;
    expect(filed.contractWaits).toEqual([
      {
        waitId: expect.any(String),
        contract: 'forge/forge-api',
        minVersion: '2026-12-01',
        dueAt: null,
        settledVersion: null,
      },
    ]);
    ids.issue = filed.issueId;
    const waits = ok(
      await say('plugin', 'GET', `/api/issues/${ids.issue}/contract-waits?live=false`),
    );
    expect(waits.dispatchable).toBe(false);
    expect(waits.waits).toEqual([
      expect.objectContaining({
        id: filed.contractWaits[0].waitId,
        minVersion: '2026-12-01',
        settled: false,
        reason: expect.stringContaining(`breakdown of ${req}`),
      }),
    ]);
    const issue = ok(await say('plugin', 'GET', `/api/issues/${ids.issue}`));
    expect(issue.status).toBe('draft');
    ok(
      await say('plugin', 'PATCH', `/api/issues/${ids.issue}`, {
        plan: 'Send policyVersion from the open call, read from the policy the box loaded.',
      }),
    );
    const planned = ok(await say('plugin', 'GET', at(`/requirements/${req}`)));
    expect(planned.issues[0]).toMatchObject({ plannedRevision: 1, changedSincePlan: false });
    expect(planned.standing.tasks.filter((t: Doc) => t.kind === 're-plan')).toEqual([]);
  });
});

describe('an accepted revision_diff lands its revision proposed', () => {
  it('writes revision 2 as proposed, owing only its accept', async () => {
    const proposed = ok(
      await say('plugin', 'POST', at('/suggestions'), {
        kind: 'revision_diff',
        requirement: req,
        baseRevision: 1,
        payload: {
          reason: 'the platform moved the field into the body',
          criteria: [
            {
              code: 'BC-1',
              body: 'Every run-session open names the policy version in its body.',
            },
          ],
        },
      }),
      201,
    );
    const sid = proposed.suggestion.id;
    const accepted = ok(
      await say('plugin', 'POST', at(`/suggestions/${sid}/accept`), {
        reason: 'agreed with forge',
      }),
    );
    const effect = accepted.effect;
    expect(effect).toMatchObject({ requirement: req, revision: 2, state: 'proposed' });
    const read = ok(await say('plugin', 'GET', at(`/requirements/${req}`)));
    expect(read.latestRevision).toEqual({ revision: 2, state: 'proposed' });
    expect(read.revisions[0]).toMatchObject({
      revision: 2,
      state: 'proposed',
      fromSuggestionId: sid,
      proposedAt: expect.stringMatching(/^\d{4}-/),
    });
    expect(read.standing.waitingOn).toMatchObject({ act: 'accept r2' });
    // proposed already: the propose verb has nothing left to do, and the accept is the act owed
    expect(
      (await say('plugin', 'POST', at(`/requirements/${req}/revisions/2/propose`), {})).status,
    ).toBe(422);
    ok(
      await say('plugin', 'POST', at(`/requirements/${req}/revisions/2/accept`), {
        reason: 'the platform moved it',
      }),
    );
  });
});

describe('a revision the plan predates opens one re-plan task per flagged issue', () => {
  it('flags the planned issue whose traced BC r2 reworded, and opens its re-plan task for the master', async () => {
    const read = ok(await say('plugin', 'GET', at(`/requirements/${req}`)));
    expect(read.currentRevision).toBe(2);
    expect(read.issues).toEqual([
      expect.objectContaining({ issueId: ids.issue, plannedRevision: 1, changedSincePlan: true }),
    ]);
    expect(read.standing.tasks).toContainEqual(
      expect.objectContaining({
        kind: 're-plan',
        owner: 'Project master',
        revision: 2,
        issueId: ids.issue,
        dueAt: null,
      }),
    );
    expect(read.standing.waitingOn).toMatchObject({ who: 'Master', act: 're-plan ISS-1' });
  });
});
