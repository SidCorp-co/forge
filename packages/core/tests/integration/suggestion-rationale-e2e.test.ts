/**
 * ISS-568 / FB-139 (REQ-8 BC-1): a re-proposal had nowhere to answer the rejection it follows. The
 * create body was strict with no rationale and no supersedes, so the answer went into a breakdown
 * slice's description, which the accept copies into the issue it files. A suggestion now carries
 * both on itself: stored, served on the write and the list, checked against the project, and never
 * copied into what an accept files.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  ok,
  openWorld,
  type Reply,
  sender,
} from '../helpers/ecosystem-world.js';
import { makeAgreeReady } from '../helpers/factories.js';

let w: EcosystemWorld;
let say: ReturnType<typeof sender>;
let req = '';
const ids: Record<string, string> = {};

const at = (path: string) => `/api/projects/${w.project.plugin}${path}`;
const refusals = (r: Reply): string[] =>
  ((r.json?.error?.refusals ?? []) as Doc[]).map((x) => `${x.code} ${x.path}`);

const SLICE_DESCRIPTION = 'The board lists each issue it reads, newest first.';
const RATIONALE =
  'Answers the rejection of the earlier breakdown: the print slice is folded into the list slice.';

function breakdown(title: string, extra: Doc = {}): Doc {
  return {
    kind: 'breakdown',
    requirement: req,
    baseRevision: 1,
    payload: {
      issues: [
        {
          title,
          description: SLICE_DESCRIPTION,
          criteria: [{ body: 'The board shows the issue it reads.', tracesTo: 'BC-1' }],
          complexity: 's',
        },
      ],
    },
    ...extra,
  };
}

beforeAll(async () => {
  w = await openWorld();
  say = sender(w);
  req = ok(
    await say('plugin', 'POST', at('/requirements'), {
      title: 'The board reads each issue',
      reason: 'the screen shows one issue',
      criteria: [{ body: 'The board shows the issue it reads.' }],
    }),
    201,
  ).key;
  await makeAgreeReady(w.project.plugin, Number(req.slice(4)), w.user.plugin);
  ok(await say('plugin', 'POST', at(`/requirements/${req}/revisions/1/propose`), {}));
  ok(await say('plugin', 'POST', at(`/requirements/${req}/revisions/1/accept`), { reason: 'ok' }));
  ok(await say('plugin', 'POST', at(`/requirements/${req}/agree`), { revision: 1, reason: 'ok' }));
  const first = ok(await say('plugin', 'POST', at('/suggestions'), breakdown('Board v1')), 201);
  ids.rejected = first.suggestion.id;
  ok(
    await say('plugin', 'POST', at(`/suggestions/${ids.rejected}/reject`), {
      reason: 'the print slice is not its own issue',
    }),
  );
}, 180_000);

afterAll(async () => {
  await closeWorld();
});

describe('criterion 1: a suggestion is created with an optional rationale and supersedes', () => {
  it('happy: both are stored and served on the write and on the list', async () => {
    const made = ok(
      await say(
        'plugin',
        'POST',
        at('/suggestions'),
        breakdown('Board v2', { rationale: `  ${RATIONALE}  `, supersedes: ids.rejected }),
      ),
      201,
    );
    ids.answer = made.suggestion.id;
    expect(made.suggestion.rationale).toBe(RATIONALE);
    expect(made.suggestion.supersedes).toBe(ids.rejected);
    const listed = ok(await say('plugin', 'GET', at(`/suggestions?requirement=${req}`)));
    const row = listed.suggestions.find((s: Doc) => s.id === ids.answer);
    expect(row?.rationale).toBe(RATIONALE);
    expect(row?.supersedes).toBe(ids.rejected);
    const summary = ok(
      await say('plugin', 'GET', at(`/suggestions?requirement=${req}&view=summary`)),
    );
    const brief = summary.suggestions.find((s: Doc) => s.id === ids.answer);
    expect(brief?.supersedes).toBe(ids.rejected);
    expect(brief).not.toHaveProperty('rationale');
  });

  it('negative: supersedes naming no suggestion is refused by name at /supersedes', async () => {
    const r = await say(
      'plugin',
      'POST',
      at('/suggestions'),
      breakdown('Board v3', { supersedes: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(r.status, JSON.stringify(r.json)).toBe(422);
    expect(refusals(r)).toEqual(['SUGGESTION_SUPERSEDES_UNKNOWN /supersedes']);
  });

  it("negative: supersedes naming another project's suggestion is refused the same way", async () => {
    const theirs = ok(
      await say('store', 'POST', `/api/projects/${w.project.store}/issues`, {
        title: 'Checkout drops the coupon',
      }),
      201,
    );
    const root = ok(
      await say('store', 'POST', `/api/projects/${w.project.store}/issues`, {
        title: 'Coupon lost at checkout',
      }),
      201,
    );
    const other = ok(
      await say('store', 'POST', `/api/projects/${w.project.store}/suggestions`, {
        kind: 'duplicate',
        issue: theirs.displayId,
        baseRevision: null,
        payload: { duplicateOf: root.displayId },
      }),
      201,
    );
    const r = await say(
      'plugin',
      'POST',
      at('/suggestions'),
      breakdown('Board v4', { supersedes: other.suggestion.id }),
    );
    expect(r.status, JSON.stringify(r.json)).toBe(422);
    expect(refusals(r)).toEqual(['SUGGESTION_SUPERSEDES_UNKNOWN /supersedes']);
    expect(JSON.stringify(r.json)).not.toContain(w.project.store);
  });

  it('negative: a rationale over its budget, a blank one and a supersedes that is no uuid are refused at their paths', async () => {
    const long = await say(
      'plugin',
      'POST',
      at('/suggestions'),
      breakdown('Board v5', { rationale: 'x'.repeat(4_001) }),
    );
    expect(long.status, JSON.stringify(long.json)).toBe(400);
    expect(refusals(long).map((x) => x.split(' ')[1])).toEqual(['/rationale']);
    const blank = await say(
      'plugin',
      'POST',
      at('/suggestions'),
      breakdown('Board v5', { rationale: '   ' }),
    );
    expect(blank.status, JSON.stringify(blank.json)).toBe(400);
    expect(refusals(blank).map((x) => x.split(' ')[1])).toEqual(['/rationale']);
    const notId = await say(
      'plugin',
      'POST',
      at('/suggestions'),
      breakdown('Board v5', { supersedes: 'ISS-1' }),
    );
    expect(notId.status, JSON.stringify(notId.json)).toBe(400);
    expect(refusals(notId).map((x) => x.split(' ')[1])).toEqual(['/supersedes']);
  });

  it('boundary: a rationale at exactly its budget is taken, and a suggestion with neither reads both null', async () => {
    const theirs = ok(
      await say('plugin', 'POST', at('/issues'), { title: 'Board misses a card' }),
      201,
    );
    const root = ok(
      await say('plugin', 'POST', at('/issues'), { title: 'A card is missing' }),
      201,
    );
    const plain = ok(
      await say('plugin', 'POST', at('/suggestions'), {
        kind: 'duplicate',
        issue: theirs.displayId,
        baseRevision: null,
        payload: { duplicateOf: root.displayId },
      }),
      201,
    );
    expect(plain.suggestion.rationale).toBeNull();
    expect(plain.suggestion.supersedes).toBeNull();
    const edge = ok(
      await say('plugin', 'POST', at('/suggestions'), {
        kind: 'triage',
        issue: theirs.displayId,
        baseRevision: null,
        payload: { note: 'route it to the board work' },
        rationale: 'y'.repeat(4_000),
      }),
      201,
    );
    expect(edge.suggestion.rationale).toHaveLength(4_000);
  });
});

describe('criterion 2: an accept files issues without the rationale or supersedes', () => {
  it('the filed issue reads the slice description alone', async () => {
    const accepted = ok(
      await say('plugin', 'POST', at(`/suggestions/${ids.answer}/accept`), { reason: 'ok' }),
    );
    const [filed] = accepted.effect.issues as Doc[];
    expect(filed).toBeDefined();
    const issue = ok(await say('plugin', 'GET', `/api/issues/${filed?.issueId}`));
    expect(issue.description).toBe(SLICE_DESCRIPTION);
    expect(issue.description).not.toContain('rejection');
    expect(JSON.stringify(issue)).not.toContain(RATIONALE);
    expect(JSON.stringify(issue)).not.toContain(ids.rejected);
    expect(accepted.suggestion.rationale).toBe(RATIONALE);
  });
});
