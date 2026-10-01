/**
 * ISS-1327 — what counts as evidence that an issue's work landed, per project shape, against a
 * real Postgres over migration 0315.
 *
 * Every door is driven at its own runtime: the REST mark and detail routes, the `forge_issues` tool
 * over a loopback MCP client, the kernel's transition writer, the entry criterion and the
 * release-record blocker. What each of them decides is `landing-evidence.ts`'s answer, and the
 * point of running them all is that none of them decides it a second time.
 *
 * The field this was measured on: a storefront project (`source.type` `storefront`) whose
 * checkout is a control folder of one commit, where three issues were refused
 * `CLOSE_REQUIRES_SHIPPED` because the only mark there was a git one.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { seedProduction } from '../helpers/production.js';
import {
  CONTROL_FOLDER_COMMIT,
  close,
  harness,
  LANDING,
  refusalOf,
  rest,
  seedIssue,
  stored,
  tool,
  useLandingHarness,
  world,
} from './landing-harness.js';

useLandingHarness();

describe('a project whose work lands outside git (source.type storefront)', () => {
  it('closes an issue marked through forge_issues with data.landing', async () => {
    const w = await world('storefront');
    const id = await seedIssue(w);
    const marked = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: id, target: 'prod', landing: LANDING },
    });
    expect(marked.isError, marked.text).toBe(false);
    expect(marked.json().mark).toBe('landed');

    await close(w, id);
    expect(await stored(id)).toMatchObject({ status: 'closed', merged_landing: LANDING });
  });

  it('answers forge_issues get with mergeMark landed and the landing itself', async () => {
    const w = await world('storefront');
    const id = await seedIssue(w, { landing: LANDING });
    const got = (await tool(w.pat, { action: 'get', documentId: id })).json();
    expect(got.mergeMark).toBe('landed');
    expect(got.mergedLanding).toBe(LANDING);
  });

  it('closes an issue marked at the REST door with landing, whose detail names the shape', async () => {
    const w = await world('storefront');
    const id = await seedIssue(w);
    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-38',
      landing: LANDING,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mark).toBe('landed');

    const detail = await (await rest('GET', `/api/issues/${id}`, w.token)).json();
    expect(detail).toMatchObject({
      landingShape: 'outside_git',
      mergeMark: 'landed',
      mergedLanding: LANDING,
    });

    await close(w, id);
    expect((await stored(id)).status).toBe('closed');
  });

  it('refuses the close of a mark naming no landing, naming data.landing and never a commit', async () => {
    const w = await world('storefront');
    const id = await seedIssue(w, { mergedAt: true });
    const refusal = await refusalOf(() => close(w, id));
    expect(refusal.code).toBe('CLOSE_REQUIRES_SHIPPED');
    expect(refusal.message).toContain('`mark_merged` carrying `data.landing`');
    expect(refusal.message).toContain('`unmark` it first');
    // Outside git the mark is short of a landing, never of a commit Forge did not watch land.
    expect(refusal.message).toContain('names no landing');
    expect(refusal.message).not.toMatch(
      /merged pull request|merged_commit_sha|CLAIM Forge did not observe/,
    );
    expect((await stored(id)).status).toBe('awaiting_release');

    // The remedy the refusal names, taken whole, is what closes it.
    expect((await rest('DELETE', `/api/issues/${id}/merge`, w.token, {})).status).toBe(200);
    const marked = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-49',
      landing: LANDING,
    });
    expect((await marked.json()).mark).toBe('landed');
    await close(w, id);
    expect((await stored(id)).status).toBe('closed');
  });

  it('refuses the close of an issue with no mark at all, naming the same route', async () => {
    const w = await world('storefront');
    const id = await seedIssue(w);
    const refusal = await refusalOf(() => close(w, id));
    expect(refusal.code).toBe('CLOSE_REQUIRES_SHIPPED');
    expect(refusal.message).toContain('`data.landing`');
    expect((await stored(id)).status).toBe('awaiting_release');
  });

  it('refuses a mark naming no landing at both doors, and writes no merged_at', async () => {
    const w = await world('storefront');
    const id = await seedIssue(w);

    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-38',
      commit: CONTROL_FOLDER_COMMIT,
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('LANDING_REQUIRED');

    const viaTool = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: id, target: 'prod' },
    });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.text).toContain('LANDING_REQUIRED');

    expect((await stored(id)).merged_at).toBeNull();
  });

  it('lists an issue whose mark names no landing under RELEASE_WORK_UNMERGED at the record door', async () => {
    const w = await world('storefront');
    // A production environment with a deploy binding is a release gate; with no probe the
    // release is recorded unverified (ISS-1321), so the only reason left is the roster's own.
    await seedProduction(harness.db, {
      projectId: w.projectId,
      ownerId: w.userId,
      probes: 'none',
      sourceType: 'storefront',
    });
    const bare = await seedIssue(w, { mergedAt: true });
    const landed = await seedIssue(w, { landing: LANDING });
    const report = await harness.mods.collectReleaseBlockers(w.projectId, {
      issueIds: [bare, landed],
      door: 'record',
    });
    const shown = await harness.db.execute<{ id: string; ref: string }>(sql`
      SELECT i.id, COALESCE(p.issue_prefix, 'ISS') || '-' || i.iss_seq AS ref
      FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.id IN (${bare}, ${landed})
    `);
    const refOf = (id: string) => shown.find((r) => r.id === id)?.ref;
    const unmerged = report.blockers.find((b) => b.code === 'RELEASE_WORK_UNMERGED');
    // The refusal names the row it refuses by the id a screen shows, and only that row (ISS-1346).
    expect(unmerged?.details, JSON.stringify(report.blockers)).toEqual({
      issueIds: [bare],
      shape: 'outside_git',
      displayIds: [refOf(bare)],
    });
    expect(unmerged?.message).toContain(`\`${refOf(bare)}\``);
    expect(unmerged?.message).not.toContain(`\`${refOf(landed)}\``);
    expect(unmerged?.message).toContain('`landing`');
    expect(unmerged?.message).not.toMatch(/branch/);
  });

  it('clears the landing with unmark, so the next mark records the landing it is sent', async () => {
    const w = await world('storefront');
    const id = await seedIssue(w);
    await rest('POST', `/api/issues/${id}/merge`, w.token, { target: 'ISS-38', landing: LANDING });
    expect((await rest('DELETE', `/api/issues/${id}/merge`, w.token, {})).status).toBe(200);
    expect(await stored(id)).toMatchObject({ merged_at: null, merged_landing: null });

    const corrected = 'cms://entries/lookbook-autumn';
    await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-38',
      landing: corrected,
    });
    expect((await stored(id)).merged_landing).toBe(corrected);
  });
});

describe('a project that lands in git (source.type git) closes exactly as before', () => {
  it('closes on an asserted mark', async () => {
    const w = await world('git');
    const id = await seedIssue(w, { mergedAt: true });
    await close(w, id);
    expect((await stored(id)).status).toBe('closed');
  });

  it('closes on an observed mark', async () => {
    const w = await world('git');
    const id = await seedIssue(w, { sha: CONTROL_FOLDER_COMMIT });
    await close(w, id);
    expect((await stored(id)).status).toBe('closed');
  });

  it("refuses a close with no mark in today's words, naming mark_merged and no landing", async () => {
    const w = await world('git');
    const id = await seedIssue(w);
    const refusal = await refusalOf(() => close(w, id));
    expect(refusal.code).toBe('CLOSE_REQUIRES_SHIPPED');
    expect(refusal.message).toContain('this issue carries no `merged_at`');
    expect(refusal.message).toContain('`mark_merged` naming where it landed, then close');
    expect(refusal.message).not.toContain('landing');
  });

  it('refuses a landing at both doors by name, and writes no merged_at', async () => {
    const w = await world('git');
    const id = await seedIssue(w);
    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'main',
      landing: LANDING,
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('LANDING_NOT_THIS_SHAPE');

    const viaTool = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: id, target: 'base', landing: LANDING },
    });
    expect(viaTool.text).toContain('LANDING_NOT_THIS_SHAPE');
    expect((await stored(id)).merged_at).toBeNull();
  });

  it('serves landingShape git on the detail answer', async () => {
    const w = await world('git');
    const id = await seedIssue(w);
    const detail = await (await rest('GET', `/api/issues/${id}`, w.token)).json();
    expect(detail.landingShape).toBe('git');
  });
});

describe('the landing field is refused malformed, at both doors and in the column', () => {
  it.each([
    ['blank', '   '],
    ['past 2000 characters', 'x'.repeat(2001)],
  ])('refuses a %s landing naming the field', async (_what, landing) => {
    const w = await world('storefront');
    const id = await seedIssue(w);
    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-38',
      landing,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('landing');

    const viaTool = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: id, target: 'prod', landing },
    });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.text).toContain('landing');
    expect((await stored(id)).merged_at).toBeNull();
  });

  it.each([
    ['a tab', '\t'],
    ['a newline', '\n'],
  ])('refuses a landing of only %s in the table itself', async (_what, landing) => {
    const w = await world('storefront');
    const id = await seedIssue(w);
    const refusal = await refusalOf(() =>
      harness.db.execute(
        sql`UPDATE issues SET merged_at = now(), merged_landing = ${landing} WHERE id = ${id}`,
      ),
    );
    const chain = [refusal.message, String((refusal as { cause?: unknown }).cause ?? '')].join(
      '\n',
    );
    expect(chain).toContain('issues_merged_landing_chk');
  });

  it('refuses a landing with no merged_at in the table itself, whatever wrote it', async () => {
    const w = await world('storefront');
    const id = await seedIssue(w);
    const refusal = await refusalOf(() =>
      harness.db.execute(sql`UPDATE issues SET merged_landing = ${LANDING} WHERE id = ${id}`),
    );
    const chain = [refusal.message, String((refusal as { cause?: unknown }).cause ?? '')].join(
      '\n',
    );
    expect(chain).toContain('issues_merged_landing_chk');
  });
});

describe('a project that declares no project document has no landing shape', () => {
  it('answers landingShape null on the issue detail rather than defaulting it to git', async () => {
    const w = await world(null);
    const id = await seedIssue(w);
    const detail = await (await rest('GET', `/api/issues/${id}`, w.token)).json();
    expect(detail.landingShape).toBeNull();
  });

  it('refuses a mark by name at both doors, and writes nothing', async () => {
    const w = await world(null);
    const id = await seedIssue(w);
    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, { target: 'main' });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('PROJECT_DOCUMENT_NOT_FOUND');
    expect(JSON.stringify(body)).toContain('PUT /api/projects/:id/config');
    const marked = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: id, target: 'base' },
    });
    expect(marked.isError).toBe(true);
    expect(marked.text).toContain('PROJECT_DOCUMENT_NOT_FOUND');
    expect((await stored(id)).merged_at).toBeNull();
  });

  it('closes on a merge Forge observed, which every shape accepts', async () => {
    const w = await world(null);
    const id = await seedIssue(w, { sha: CONTROL_FOLDER_COMMIT });
    await close(w, id);
    expect((await stored(id)).status).toBe('closed');
  });

  it('refuses the close of a bare claim, naming the source.type it cannot be judged without', async () => {
    const w = await world(null);
    const id = await seedIssue(w, { mergedAt: true });
    const refused = await refusalOf(() => close(w, id));
    expect(refused.code).toBe('CLOSE_REQUIRES_SHIPPED');
    expect(refused.message).toContain('declares no project document');
    expect((await stored(id)).status).toBe('awaiting_release');
  });
});
