/**
 * ISS-1384 — an issue of a git project declares, on itself, that its work lands outside git,
 * against a real Postgres over migration 0320.
 *
 * The field this was measured on: trai-heo ISS-196, thirteen environment variables set on a
 * staging deployment and a redeploy, with no source change. Its only route to `developed` was a
 * mark at the served commit, which says the change landed at a commit that holds none of it.
 *
 * Every door is driven at its own runtime — the REST detail, patch and mark routes, the
 * `forge_issues` tool over a loopback MCP client, the kernel's transition writer, the entry
 * criteria and the release-record blocker — because each of them reads the issue's shape, and the
 * point is that none of them reads the project's instead.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_FOLDER_COMMIT,
  close,
  harness,
  LANDING,
  refusalOf,
  rest,
  stored,
  tool,
  useLandingHarness,
  type World,
  world,
} from './landing-harness.js';

useLandingHarness();

const ENV_LANDING = 'coolify://staging/trai-heo-api — 13 environment variables, redeployed';

let seq = 1000;
async function issueAt(
  w: World,
  status: string,
  declared: 'git' | 'outside_git' | null = null,
  mark: { mergedAt?: boolean; landing?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id,
                        declared_landing_shape, merged_at, merged_landing)
    VALUES (${id}, ${w.projectId}, ${++seq}, 'landing declared', ${status}, ${w.userId},
            ${declared}, ${mark.mergedAt || mark.landing ? sql`now()` : null},
            ${mark.landing ?? null})
  `);
  return id;
}

async function declaredOf(id: string): Promise<string | null> {
  const rows = await harness.db.execute<{ declared_landing_shape: string | null }>(
    sql`SELECT declared_landing_shape FROM issues WHERE id = ${id}`,
  );
  return rows[0]?.declared_landing_shape ?? null;
}

async function asAgent(w: World): Promise<void> {
  await harness.db.execute(sql`UPDATE users SET kind = 'agent' WHERE id = ${w.userId}`);
}

function patch(id: string, token: string, body: unknown) {
  return rest('PATCH', `/api/issues/${id}`, token, body);
}

async function moveAsAgent(w: World, id: string, from: string, to: string) {
  return harness.mods.transitionIssueStatus(
    { id, projectId: w.projectId, status: from as 'in_progress', reopenCount: 0 },
    to as 'developed',
    { type: 'user', id: w.userId, agency: 'agent' },
  );
}

describe('the declaration is written and read on the issue itself', () => {
  it('answers an undeclared issue of a git project git, exactly as before', async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'in_progress');
    const detail = await (await rest('GET', `/api/issues/${id}`, w.token)).json();
    expect(detail).toMatchObject({ landingShape: 'git', declaredLandingShape: null });
    const got = (await tool(w.pat, { action: 'get', documentId: id })).json();
    expect(got).toMatchObject({ landingShape: 'git', declaredLandingShape: null });
  });

  it('takes landingShape at the REST patch and serves it back on both reads', async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'in_progress');
    const res = await patch(id, w.token, { landingShape: 'outside_git' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      landingShape: 'outside_git',
      declaredLandingShape: 'outside_git',
    });
    const detail = await (await rest('GET', `/api/issues/${id}`, w.token)).json();
    expect(detail.landingShape).toBe('outside_git');
    const got = (await tool(w.pat, { action: 'get', documentId: id })).json();
    expect(got.landingShape).toBe('outside_git');
  });

  it('takes data.landingShape at forge_issues update, and null hands it back to the project', async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'in_progress');
    const set = await tool(w.pat, {
      action: 'update',
      documentId: id,
      data: { landingShape: 'outside_git' },
    });
    expect(set.isError, set.text).toBe(false);
    expect(set.json()).toMatchObject({
      landingShape: 'outside_git',
      declaredLandingShape: 'outside_git',
    });
    const cleared = await tool(w.pat, {
      action: 'update',
      documentId: id,
      data: { landingShape: null },
    });
    expect(cleared.json()).toMatchObject({ landingShape: 'git', declaredLandingShape: null });
    expect(await declaredOf(id)).toBeNull();
  });

  it('leaves the sibling issues of the project on the project shape', async () => {
    const w = await world('standard');
    const declared = await issueAt(w, 'in_progress', 'outside_git');
    const sibling = await issueAt(w, 'in_progress');
    const res = await rest('POST', `/api/issues/${sibling}/merge`, w.token, {
      target: 'main',
      landing: LANDING,
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('LANDING_NOT_THIS_SHAPE');
    expect((await rest('GET', `/api/issues/${declared}`, w.token)).status).toBe(200);
  });

  it.each([
    ['a shape Forge does not know', 'svn'],
    ['the project kind instead of a shape', 'website'],
  ])('refuses %s at both doors by name, and writes nothing', async (_what, value) => {
    const w = await world('standard');
    const id = await issueAt(w, 'in_progress');
    const res = await patch(id, w.token, { landingShape: value });
    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('landingShape');
    expect(body).toContain('`git` or `outside_git`');

    const viaTool = await tool(w.pat, {
      action: 'update',
      documentId: id,
      data: { landingShape: value },
    });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.text).toContain('landingShape');
    expect(viaTool.text).toContain('`git` or `outside_git`');
    expect(await declaredOf(id)).toBeNull();
  });

  it('refuses a value outside the two shapes in the table itself, whatever wrote it', async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'in_progress');
    const refusal = await refusalOf(() =>
      harness.db.execute(sql`UPDATE issues SET declared_landing_shape = 'svn' WHERE id = ${id}`),
    );
    const chain = [refusal.message, String((refusal as { cause?: unknown }).cause ?? '')].join(
      '\n',
    );
    expect(chain).toContain('issues_declared_landing_shape_chk');
  });
});

describe('a mark already standing is never re-judged by a changed declaration', () => {
  it('refuses a change while a mark stands at both doors, naming unmark, and writes nothing', async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'awaiting_release', null, { mergedAt: true });
    const res = await patch(id, w.token, { landingShape: 'outside_git' });
    expect(res.status).toBe(409);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('LANDING_SHAPE_MARK_STANDS');
    expect(body).toContain('`unmark`');

    const viaTool = await tool(w.pat, {
      action: 'update',
      documentId: id,
      data: { landingShape: 'outside_git' },
    });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.text).toContain('LANDING_SHAPE_MARK_STANDS');
    expect(await declaredOf(id)).toBeNull();
  });

  it('takes the same value re-sent over a standing mark, which changes nothing', async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'awaiting_release', 'outside_git', { landing: ENV_LANDING });
    const res = await patch(id, w.token, { landingShape: 'outside_git' });
    expect(res.status).toBe(200);
    expect(await declaredOf(id)).toBe('outside_git');
  });

  it('takes the change once the mark is withdrawn, which is the route the refusal names', async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'awaiting_release', null, { mergedAt: true });
    expect((await rest('DELETE', `/api/issues/${id}/merge`, w.token, {})).status).toBe(200);
    const res = await patch(id, w.token, { landingShape: 'outside_git' });
    expect(res.status).toBe(200);
    expect(await declaredOf(id)).toBe('outside_git');
  });
});

describe('a mark is never written on a lane the issue no longer holds', () => {
  it('refuses a first mark judged on a lane the declaration moved off before it was written', async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'awaiting_release');
    // The mark writer's caller loaded the row while it declared nothing.
    const loaded = { id, projectId: w.projectId, mergedAt: null, declaredLandingShape: null };
    expect((await patch(id, w.token, { landingShape: 'outside_git' })).status).toBe(200);

    const { applyMergeMarker } = await import('../../src/issues/merge-marker.js');
    const refusal = await refusalOf(() =>
      applyMergeMarker({
        issue: loaded,
        op: 'mark',
        target: 'main',
        actor: {
          agency: 'human',
          commentAuthorId: w.userId,
          hookActor: { type: 'user', id: w.userId, agency: 'human' },
        },
      }),
    );
    expect(refusal.code).toBe('LANDING_SHAPE_MOVED');
    expect(refusal.message).toContain('moved from null to outside_git');
    expect((await stored(id)).merged_at).toBeNull();
  });
});

describe('an issue declared outside git, on a git project', () => {
  it('takes an agent mark carrying a landing with nothing else behind it, then developed and testing', async () => {
    const w = await world('standard');
    await asAgent(w);
    const id = await issueAt(w, 'in_progress', 'outside_git');
    const marked = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: id, landing: ENV_LANDING },
    });
    expect(marked.isError, marked.text).toBe(false);
    expect(marked.json().mark).toBe('landed');

    await moveAsAgent(w, id, 'in_progress', 'developed');
    await moveAsAgent(w, id, 'developed', 'testing');
    expect(await stored(id)).toMatchObject({ status: 'testing', merged_landing: ENV_LANDING });
  });

  it('refuses an agent at developed with no mark, naming the landing route and never data.commit', async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'in_progress', 'outside_git');
    const refusal = await refusalOf(() => moveAsAgent(w, id, 'in_progress', 'developed'));
    expect(refusal.code).toBe('NO_WORK_EVIDENCE');
    expect(refusal.message).toContain('`data.landing`');
    expect(refusal.message).toContain('declared on the issue');
    expect(refusal.message).not.toContain('data.commit');
    expect(refusal.message).not.toContain('kind `website`');
    expect((await stored(id)).status).toBe('in_progress');
  });

  it('refuses an agent mark carrying only a commit, naming the landing route', async () => {
    const w = await world('standard');
    await asAgent(w);
    const id = await issueAt(w, 'in_progress', 'outside_git');
    const viaTool = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: id, commit: CONTROL_FOLDER_COMMIT },
    });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.text).toContain('NO_WORK_EVIDENCE');
    expect(viaTool.text).toContain('`data.landing`');
    expect(viaTool.text).not.toContain('data.commit');
    expect((await stored(id)).merged_at).toBeNull();
  });

  it("refuses a person's mark naming no landing LANDING_REQUIRED, in this issue's words", async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'awaiting_release', 'outside_git');
    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'main',
      commit: CONTROL_FOLDER_COMMIT,
    });
    expect(res.status).toBe(422);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('LANDING_REQUIRED');
    expect(body).toContain('declared on the issue');
    expect(body).not.toContain('kind `website`');
    expect((await stored(id)).merged_at).toBeNull();
  });

  it('closes on a landed mark and refuses a close on a bare one, naming the landing route', async () => {
    const w = await world('standard');
    const bare = await issueAt(w, 'awaiting_release', 'outside_git', { mergedAt: true });
    const refusal = await refusalOf(() => close(w, bare));
    expect(refusal.code).toBe('CLOSE_REQUIRES_SHIPPED');
    expect(refusal.message).toContain('`mark_merged` carrying `data.landing`');
    expect(refusal.message).toContain('declared on the issue');
    expect(refusal.message).not.toContain('kind `website`');

    const landed = await issueAt(w, 'awaiting_release', 'outside_git', { landing: ENV_LANDING });
    await close(w, landed);
    expect((await stored(landed)).status).toBe('closed');
  });

  it('passes merged_mark and work_evidence on a landed mark, and fails merged_mark on a bare one', async () => {
    const w = await world('standard');
    const landed = await issueAt(w, 'in_progress', 'outside_git', { landing: ENV_LANDING });
    expect(
      await harness.mods.findUnmetEntryCriteria({
        issueId: landed,
        declared: ['merged_mark', 'work_evidence'],
      }),
    ).toBeNull();
    const bare = await issueAt(w, 'in_progress', 'outside_git', { mergedAt: true });
    const short = await harness.mods.findUnmetEntryCriteria({
      issueId: bare,
      declared: ['merged_mark'],
    });
    expect(short?.unmet.map((u) => u.key)).toEqual(['merged_mark']);
  });
});

describe('an issue declared in git, on a project whose work lands outside it', () => {
  it("refuses a landing LANDING_NOT_THIS_SHAPE in this issue's words", async () => {
    const w = await world('website');
    const id = await issueAt(w, 'awaiting_release', 'git');
    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'main',
      landing: LANDING,
    });
    expect(res.status).toBe(422);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('LANDING_NOT_THIS_SHAPE');
    expect(body).toContain('declared on the issue');
  });
});

describe('the release record judges each issue on its own shape', () => {
  it('names a git issue and a declared one under RELEASE_WORK_UNMERGED each in its own words', async () => {
    const w = await world('standard');
    await harness.db.execute(sql`
      UPDATE projects SET base_branch = 'main', release_chain = '[{"branch":"main"}]'::jsonb
      WHERE id = ${w.projectId}
    `);
    const connection = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connection}, 'user', ${w.userId}, 'coolify', true)
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
      VALUES (${connection}, ${w.projectId}, 'coolify', 'deploy', ARRAY['live'], true, '{}'::jsonb)
    `);
    const unmarked = await issueAt(w, 'awaiting_release');
    const declaredBare = await issueAt(w, 'awaiting_release', 'outside_git', { mergedAt: true });
    const declaredLanded = await issueAt(w, 'awaiting_release', 'outside_git', {
      landing: ENV_LANDING,
    });
    const report = await harness.mods.collectReleaseBlockers(w.projectId, {
      issueIds: [unmarked, declaredBare, declaredLanded],
      door: 'record',
    });
    const unmerged = report.blockers.filter((b) => b.code === 'RELEASE_WORK_UNMERGED');
    const byShape = Object.fromEntries(unmerged.map((b) => [b.details?.shape, b]));
    expect(Object.keys(byShape).sort(), JSON.stringify(unmerged)).toEqual(['git', 'outside_git']);
    expect(byShape.git?.details?.issueIds).toEqual([unmarked]);
    expect(byShape.outside_git?.details?.issueIds).toEqual([declaredBare]);
    expect(byShape.outside_git?.message).toContain('`landing`');
    expect(byShape.outside_git?.message).not.toContain("This project's work");
  });
});
