/**
 * ISS-1327 — a landing sent over a mark that stands, and the target a mark owes, against a real
 * Postgres at the REST and `forge_issues` doors.
 *
 * The judge's walk at 513e06e: a typo marked, the corrected landing marked again, answered `200
 * already_merged` with the typo kept while web and MCP both reported success. The first mark stands,
 * so the correction is refused by name with nothing written, and `unmark` then mark is the route.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  harness,
  LANDING,
  rest,
  seedIssue,
  snapshot,
  stored,
  tool,
  useLandingHarness,
  world,
} from './landing-harness.js';

useLandingHarness();

describe('a landing sent over a mark that stands is refused by name, never dropped behind a 200', () => {
  const TYPO = 'https://mowmentbrand.com/prodcts/linen-tee';

  it('refuses the corrected landing at the REST door, naming what stands, and changes nothing', async () => {
    const w = await world('website');
    const id = await seedIssue(w);
    expect(
      (await rest('POST', `/api/issues/${id}/merge`, w.token, { target: 'ISS-38', landing: TYPO }))
        .status,
    ).toBe(200);
    const before = await snapshot(id);

    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-38',
      landing: LANDING,
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('MARK_ALREADY_STANDS');
    expect(body.message).toContain(`names ${TYPO} as where the work landed`);
    expect(body.message).toContain('`unmark`');
    expect(body.details).toMatchObject({ heldLanding: TYPO, sentLanding: LANDING });
    expect(await snapshot(id)).toEqual(before);
  });

  it('refuses the corrected landing over forge_issues too, and changes nothing', async () => {
    const w = await world('website');
    const id = await seedIssue(w, { landing: TYPO });
    const before = await snapshot(id);
    const viaTool = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: id, target: 'prod', landing: LANDING },
    });
    expect(viaTool.isError, viaTool.text).toBe(true);
    expect(viaTool.text).toContain('MARK_ALREADY_STANDS');
    expect(viaTool.text).toContain(TYPO);
    expect(await snapshot(id)).toEqual(before);
  });

  it('refuses a landing sent over a mark naming none, naming unmark first', async () => {
    const w = await world('website');
    const id = await seedIssue(w, { mergedAt: true });
    const before = await snapshot(id);
    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-38',
      landing: LANDING,
    });
    expect(res.status).toBe(422);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('MARK_ALREADY_STANDS');
    expect(text).toContain('names no landing');
    expect(await snapshot(id)).toEqual(before);
    expect(before?.merged_landing).toBeNull();
  });

  it('answers the exact landing re-sent as already_merged, with one comment saying nothing was stamped', async () => {
    const w = await world('website');
    const id = await seedIssue(w, { landing: LANDING });
    const before = await snapshot(id);
    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-38',
      landing: LANDING,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).action).toBe('already_merged');
    const after = await snapshot(id);
    expect({ ...after, comments: before?.comments }).toEqual(before);
    expect(after?.comments).toBe((before?.comments ?? 0) + 1);
    const [last] = await harness.db.execute<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${id} ORDER BY created_at DESC LIMIT 1`,
    );
    expect(last?.body).toContain('NOT stamped by this call');
  });

  it('records the correction once the standing mark is unmarked, which is the route it names', async () => {
    const w = await world('website');
    const id = await seedIssue(w, { landing: TYPO });
    expect((await rest('DELETE', `/api/issues/${id}/merge`, w.token, {})).status).toBe(200);
    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-38',
      landing: LANDING,
    });
    expect((await res.json()).mark).toBe('landed');
    expect((await stored(id)).merged_landing).toBe(LANDING);
  });
});

describe('target is owed where the project moves branches, and only there', () => {
  it('accepts a website mark with a landing and no target, at both doors', async () => {
    const w = await world('website');
    const viaRest = await seedIssue(w);
    const res = await rest('POST', `/api/issues/${viaRest}/merge`, w.token, { landing: LANDING });
    expect(res.status).toBe(200);
    expect((await res.json()).mark).toBe('landed');

    const viaTool = await seedIssue(w);
    const marked = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: viaTool, landing: LANDING },
    });
    expect(marked.isError, marked.text).toBe(false);
    expect(marked.json().mark).toBe('landed');
  });

  it('refuses a standard mark with no target at both doors in the words it always used', async () => {
    const w = await world('standard');
    const id = await seedIssue(w);
    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {});
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('target is required');

    const viaTool = await tool(w.pat, { action: 'mark_merged', data: { issueId: id } });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.text).toContain('data.target is required for mark_merged');
    expect((await stored(id)).merged_at).toBeNull();
  });
});
