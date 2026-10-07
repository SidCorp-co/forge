/**
 * ISS-278 / FB-90: a breakdown suggestion's details showed only its issue titles, so a person
 * accepted slices without seeing what each covers. The suggestion list now serves, per slice of a
 * proposed breakdown, what its accept would file: description, criteria by BC code, the pinned
 * design and the revision the baseline pins it at, and its blocks edges, resolved by the rules the
 * accept applies, with the accept's refusal where it would refuse.
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  ok,
  openWorld,
  sender,
} from '../helpers/ecosystem-world.js';
import { seedIssueStatus } from '../helpers/factories.js';

let w: EcosystemWorld;
let say: ReturnType<typeof sender>;
let req = '';
const ids: Record<string, string> = {};

const at = (path: string) => `/api/projects/${w.project.plugin}${path}`;

function design(): Doc {
  const d = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  d.project = w.project.plugin;
  d.flow = 'issue-board';
  return d;
}

const waiting = async (): Promise<Doc> => {
  const listed = ok(
    await say('plugin', 'GET', at(`/suggestions?requirement=${req}&status=proposed`)),
  );
  const found = listed.suggestions.find((s: Doc) => s.id === ids.suggestion);
  expect(found, JSON.stringify(listed)).toBeDefined();
  return found;
};

beforeAll(async () => {
  w = await openWorld();
  say = sender(w);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a breakdown waiting on a person', () => {
  it('is proposed against an agreed requirement pinning an approved design', async () => {
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
    req = ok(
      await say('plugin', 'POST', at('/requirements'), {
        title: 'The board reads each issue',
        reason: 'the screen shows one issue',
        criteria: [
          { body: 'The board shows the issue it reads.' },
          { body: 'The board prints the issue.' },
        ],
      }),
      201,
    ).key;
    ok(
      await say('plugin', 'POST', at(`/requirements/${req}/workflows`), {
        workflowId: ids.workflow,
      }),
    );
    ok(await say('plugin', 'POST', at(`/requirements/${req}/revisions/1/propose`), {}));
    ok(
      await say('plugin', 'POST', at(`/requirements/${req}/revisions/1/accept`), { reason: 'ok' }),
    );
    ok(
      await say('plugin', 'POST', at(`/requirements/${req}/agree`), { revision: 1, reason: 'ok' }),
    );

    const earlier = ok(
      await say('plugin', 'POST', at('/issues'), {
        title: 'Board shell exists',
        status: 'draft',
        priority: 'medium',
        category: 'feature',
      }),
      201,
    );
    ids.earlier = earlier.id;
    ids.earlierKey = earlier.displayId;

    const proposed = ok(
      await say('plugin', 'POST', at('/suggestions'), {
        kind: 'breakdown',
        requirement: req,
        baseRevision: 1,
        payload: {
          issues: [
            {
              title: 'Board reads the issue',
              description: 'Reads one issue by id; no editor.',
              criteria: [{ body: 'the board shows it', tracesTo: 'BC-1' }],
              complexity: 's',
              blockedBy: [ids.earlierKey],
            },
            {
              title: 'Board caches the issue',
              criteria: [{ body: 'a reload is instant', tracesTo: 'BC-1' }],
              complexity: 'm',
              builds: null,
              blockedBy: [0],
            },
          ],
          uncovered: [{ code: 'BC-2', reason: 'printing waits on the print service' }],
        },
      }),
      201,
    );
    ids.suggestion = proposed.suggestion.id;
  });

  it('serves each slice as its accept would file it, at the head it was read at', async () => {
    const s = await waiting();
    expect(s.breakdown).toEqual({
      revision: 1,
      unreadable: null,
      uncovered: [{ code: 'BC-2', reason: 'printing waits on the print service' }],
      slices: [
        {
          title: 'Board reads the issue',
          description: 'Reads one issue by id; no editor.',
          complexity: 's',
          criteria: [{ code: 'BC-1', body: 'the board shows it' }],
          builds: { flow: 'issue-board', designRevision: 1 },
          buildsRefusal: null,
          blockedBy: [{ issue: ids.earlierKey, title: 'Board shell exists', status: 'draft' }],
        },
        {
          title: 'Board caches the issue',
          description: null,
          complexity: 'm',
          criteria: [{ code: 'BC-1', body: 'a reload is instant' }],
          builds: null,
          buildsRefusal: null,
          blockedBy: [{ slice: 0, title: 'Board reads the issue' }],
        },
      ],
    });
  });

  it('shows the refusal its accept would give where a named blocker has since been dropped', async () => {
    await seedIssueStatus(ids.earlier as string, 'dropped');
    const s = await waiting();
    expect(s.breakdown.slices[0].blockedBy).toEqual([
      {
        ref: ids.earlierKey,
        code: 'SUGGESTION_BLOCKER_TERMINAL',
        refusal: expect.stringContaining('is dropped'),
      },
    ]);
  });

  it('shows the refusal its accept would give where a slice names a design the baseline does not pin', async () => {
    await db.execute(
      sql`UPDATE suggestions SET payload = jsonb_set(payload, '{issues,1,builds}', '"print-flow"') WHERE id = ${ids.suggestion}`,
    );
    const [first, second] = (await waiting()).breakdown.slices;
    expect(first.builds).toEqual({ flow: 'issue-board', designRevision: 1 });
    expect(second.builds).toBeNull();
    expect(second.buildsRefusal).toMatch(
      /print-flow is not a design the requirement's latest baseline pins \(issue-board\)/,
    );
  });

  it('lists a stored payload that no longer parses as unreadable, with the reason, and still lists', async () => {
    await db.execute(
      sql`UPDATE suggestions SET payload = '{"issues":[{"title":"no criteria","complexity":"s"}]}'::jsonb WHERE id = ${ids.suggestion}`,
    );
    const s = await waiting();
    expect(s.breakdown.slices).toEqual([]);
    expect(s.breakdown.unreadable).toMatch(/criteria/);
  });
});

// ISS-281, from ISS-278's judge: the read hand-copied Accept's numeric-blocker checks and the copy
// disagreed (its own SUGGESTION_BLOCKER_UNKNOWN words for a self-block or an out-of-range index, two
// plain edges for a cycle). propose.ts refuses all three, so each is planted in the stored payload.
describe('a numeric blocker in a proposed breakdown reads exactly as Accept refuses it', () => {
  const slices = (a: (number | string)[], b: (number | string)[]) => ({
    issues: [
      {
        title: 'Board reads the issue',
        criteria: [{ body: 'shows it', tracesTo: 'BC-1' }],
        complexity: 's',
        builds: null,
        blockedBy: a,
      },
      {
        title: 'Board caches the issue',
        criteria: [{ body: 'reload', tracesTo: 'BC-1' }],
        complexity: 'm',
        builds: null,
        blockedBy: b,
      },
    ],
  });
  const plant = (payload: unknown) =>
    db.execute(
      sql`UPDATE suggestions SET payload = ${JSON.stringify(payload)}::jsonb WHERE id = ${ids.suggestion}`,
    );
  const acceptRefusalAt = async (path: string) => {
    const r = await say('plugin', 'POST', at(`/suggestions/${ids.suggestion}/accept`), {});
    expect(r.status, JSON.stringify(r.json)).toBe(422);
    const found = (r.json.error?.refusals ?? []).find((x: Doc) => x.path === path);
    expect(found, JSON.stringify(r.json)).toBeDefined();
    return found as Doc;
  };

  it('a slice naming itself shows the refusal Accept gives, in its words', async () => {
    await plant(slices([], [1]));
    const shown = (await waiting()).breakdown.slices[1].blockedBy;
    const refused = await acceptRefusalAt('/payload/issues/1/blockedBy/0');
    expect(refused.code).toBe('SUGGESTION_PAYLOAD_INVALID');
    expect(shown).toEqual([{ ref: '1', code: refused.code, refusal: refused.detail }]);
    expect(shown[0].refusal).toMatch(/this issue itself/);
  });

  it('an index outside the breakdown shows the refusal Accept gives, in its words', async () => {
    await plant(slices([5], []));
    const shown = (await waiting()).breakdown.slices[0].blockedBy;
    const refused = await acceptRefusalAt('/payload/issues/0/blockedBy/0');
    expect(shown).toEqual([
      { ref: '5', code: 'SUGGESTION_PAYLOAD_INVALID', refusal: refused.detail },
    ]);
    expect(shown[0].refusal).toMatch(/outside the 2 proposed issues/);
  });

  it("a cycle among the slices shows Accept's cycle refusal on the edge that closes it, not two plain edges", async () => {
    await plant(slices([1], [0]));
    const [first, second] = (await waiting()).breakdown.slices;
    const refused = await acceptRefusalAt('/payload/issues/1/blockedBy/0');
    expect(refused.detail).toMatch(/form a cycle/);
    expect(first.blockedBy).toEqual([{ slice: 1, title: 'Board caches the issue' }]);
    expect(second.blockedBy).toEqual([
      { ref: '0', code: 'SUGGESTION_PAYLOAD_INVALID', refusal: refused.detail },
    ]);
  });
});
