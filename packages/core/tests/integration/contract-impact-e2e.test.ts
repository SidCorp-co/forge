import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  formEcosystem,
  ok,
  openWorld,
  seedContractVersion,
  sender,
  writeInterfaces,
} from '../helpers/ecosystem-world.js';
import { seedIssueStatus } from '../helpers/factories.js';

let w: EcosystemWorld;
let say: ReturnType<typeof sender>;
let req = '';
const ids: Record<string, string> = {};

/** The element the screen binds, and the operations the plugin's interface says it consumes. */
const BOUND = 'GET /api/issues/{id}';
const OPS = [BOUND, 'POST /api/issues/{id}/phase', 'POST /api/devices/me/run-sessions'];

const at = (path: string) => `/api/projects/${w.project.plugin}${path}`;

const elementsOf = (version: string, elements: string[]) =>
  db.execute(sql`
    UPDATE contract_versions SET elements = ${`{${elements.map((e) => `"${e}"`).join(',')}}`}::text[]
    WHERE provider_project_id = ${w.project.forge} AND contract_slug = 'forge-api' AND version = ${version}
  `);

function design(): Doc {
  const d = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  d.project = w.project.plugin;
  d.flow = 'issue-board';
  const step = d.steps.find((s: Doc) => s.id === 'call-task');
  step.node.binds = [{ provider: 'forge', slug: 'forge-api', element: BOUND }];
  return d;
}

beforeAll(async () => {
  w = await openWorld();
  await formEcosystem(w);
  await writeInterfaces(w);
  say = sender(w);
  await elementsOf('2026-09-20', OPS);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a requirement pins a design whose screen binds a provider element', () => {
  it('approves the design that binds the element', async () => {
    const made = ok(
      await say('plugin', 'POST', at('/workflows'), { baseRevision: null, document: design() }),
      201,
    );
    ids.workflow = made.document.id;
    ok(
      await say('plugin', 'POST', at(`/workflows/${ids.workflow}/design/propose`), { revision: 1 }),
    );
    ok(
      await say('plugin', 'POST', at(`/workflows/${ids.workflow}/design/decision`), {
        revision: 1,
        decision: 'approve',
      }),
    );
  });

  it('agrees a requirement pinning that design and the contract version', async () => {
    req = ok(
      await say('plugin', 'POST', at('/requirements'), {
        title: 'The board reads each issue',
        reason: 'the screen shows one issue',
        criteria: [{ body: 'The board shows the issue it reads.' }],
      }),
      201,
    ).key;
    ok(
      await say('plugin', 'POST', at(`/requirements/${req}/workflows`), {
        workflowId: ids.workflow,
      }),
    );
    ok(
      await say('plugin', 'POST', at(`/requirements/${req}/contracts`), {
        contract: 'forge/forge-api',
      }),
    );
    ok(await say('plugin', 'POST', at(`/requirements/${req}/revisions/1/propose`), {}));
    ok(
      await say('plugin', 'POST', at(`/requirements/${req}/revisions/1/accept`), { reason: 'ok' }),
    );
    ok(
      await say('plugin', 'POST', at(`/requirements/${req}/agree`), { revision: 1, reason: 'ok' }),
    );
    const read = ok(await say('plugin', 'GET', at(`/requirements/${req}`)));
    expect(read.bindings).toEqual([
      expect.objectContaining({
        workflowId: ids.workflow,
        step: 'call-task',
        contract: 'forge/forge-api',
        element: BOUND,
        pinnedVersion: '2026-09-20',
        brokenBy: null,
        buildingIssues: [],
      }),
    ]);
  });

  it('files a build of the design and two issues that only trace its BC', async () => {
    const proposed = ok(
      await say('plugin', 'POST', at('/suggestions'), {
        kind: 'breakdown',
        requirement: req,
        baseRevision: 1,
        payload: {
          issues: [
            {
              title: 'Board reads the issue',
              criteria: [{ body: 'the board shows it', tracesTo: 'BC-1' }],
              complexity: 's',
            },
            {
              title: 'Board caches the issue',
              criteria: [{ body: 'a reload is instant', tracesTo: 'BC-1' }],
              complexity: 's',
              builds: null,
            },
            {
              title: 'Board prints the issue',
              criteria: [{ body: 'a print shows it', tracesTo: 'BC-1' }],
              complexity: 's',
              builds: null,
            },
          ],
        },
      }),
      201,
    );
    const accepted = ok(
      await say('plugin', 'POST', at(`/suggestions/${proposed.suggestion.id}/accept`), {
        reason: 'plan',
      }),
    );
    const effect = accepted.effect;
    [ids.build, ids.traced, ids.dropped] = effect.issues.map((i: Doc) => i.issueId);
    expect(effect.issues.map((i: Doc) => i.builds)).toEqual(['issue-board', null, null]);
  });
});

describe('a breaking version names every issue building the flow it reaches', () => {
  it('names nothing while no approved version breaks the bound element', async () => {
    await seedContractVersion({
      providerId: w.project.forge,
      ref: 'forge/forge-api',
      version: '2026-10-25',
      previous: '2026-09-20',
      classification: 'breaking',
      approval: 'proposed',
    });
    await elementsOf(
      '2026-10-25',
      OPS.filter((o) => o !== BOUND),
    );
    const read = ok(await say('plugin', 'GET', at(`/requirements/${req}`)));
    expect(read.bindings[0]).toMatchObject({ brokenBy: null, buildingIssues: [] });
  });

  it('on approval, the binding is broken by it and lists the tracing issues, a dropped one left out', async () => {
    ok(
      await say(
        'platform',
        'POST',
        `/api/projects/${w.project.forge}/contracts/forge-api/versions/2026-10-25/decision`,
        { decision: 'approve' },
      ),
    );
    await seedIssueStatus(ids.dropped as string, 'dropped');
    const read = ok(await say('plugin', 'GET', at(`/requirements/${req}`)));
    expect(read.bindings[0]).toMatchObject({ brokenBy: '2026-10-25', pinnedVersion: '2026-09-20' });
    // the build of the design, and the issue only tracing the requirement's BC; the dropped one builds nothing
    expect(read.bindings[0].buildingIssues).toEqual([
      expect.objectContaining({ issueId: ids.build, displayId: 'ISS-1' }),
      expect.objectContaining({ issueId: ids.traced, displayId: 'ISS-2' }),
    ]);
  });
});
