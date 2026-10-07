/**
 * ISS-1384 — every refusal on the landing route says a thing that is true of the state it refused,
 * and a write that changes nothing leaves the row as it was. Each case plants the state judge j1
 * met (comment 6917ce1b on the issue) against a real Postgres, and reads the door's own answer.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_FOLDER_COMMIT,
  close,
  harness,
  refusalOf,
  rest,
  tool,
  useLandingHarness,
  type World,
  world,
} from './landing-harness.js';

useLandingHarness();

const ENV_LANDING = 'coolify://staging/trai-heo-api — 13 environment variables, redeployed';
const RELEASE_CHAIN_PARAGRAPH = 'release chain has two or more entries';

let seq = 2000;
async function issueAt(
  w: World,
  status: string,
  declared: 'git' | 'outside_git' | null = null,
  mark: { mergedAt?: boolean; landing?: string } = {},
  id: string = randomUUID(),
): Promise<string> {
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id,
                        declared_landing_shape, merged_at, merged_landing, updated_at)
    VALUES (${id}, ${w.projectId}, ${++seq}, 'landing sentences', ${status}, ${w.userId},
            ${declared}, ${mark.mergedAt || mark.landing ? sql`now()` : null},
            ${mark.landing ?? null}, '2026-01-01T00:00:00Z')
  `);
  return id;
}

async function updatedAtOf(id: string): Promise<string> {
  const rows = await harness.db.execute<{ updated_at: string }>(
    sql`SELECT updated_at::text AS updated_at FROM issues WHERE id = ${id}`,
  );
  return rows[0]?.updated_at as string;
}

async function asAgent(w: World): Promise<void> {
  await harness.db.execute(sql`UPDATE users SET kind = 'agent' WHERE id = ${w.userId}`);
}

function toDevelopedAsAgent(w: World, id: string) {
  return harness.mods.transitionIssueStatus(
    { id, projectId: w.projectId, status: 'in_progress', reopenCount: 0 },
    'developed',
    { type: 'user', id: w.userId, agency: 'agent' },
  );
}

describe("a git issue's close refusal names a route this lane takes", () => {
  it('tells a change that lands no file to declare outside git, never to mark with where it landed', async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'awaiting_release');
    const refusal = await refusalOf(() => close(w, id));
    expect(refusal.code).toBe('CLOSE_REQUIRES_SHIPPED');
    expect(refusal.message).toContain('`landingShape: outside_git`');
    expect(refusal.message).toContain('`data.commit`');
    expect(refusal.message).not.toContain('naming where it landed');
  });
});

describe('a bare mark on an outside-git lane is given one sentence at every door', () => {
  it('has merged_mark say unmark first, as the close does, never mark it merged again', async () => {
    const w = await world('standard');
    const bare = await issueAt(w, 'in_progress', 'outside_git', { mergedAt: true });
    const short = await harness.mods.findUnmetEntryCriteria({
      issueId: bare,
      declared: ['merged_mark'],
    });
    const detail = short?.unmet[0]?.detail ?? '';
    expect(detail).toContain('`unmark` it first');
    expect(detail).toContain('`data.landing`');
    expect(detail).not.toContain('mark it merged before this status');
    expect(detail).not.toContain('then close');

    const closing = await issueAt(w, 'awaiting_release', 'outside_git', { mergedAt: true });
    const refusal = await refusalOf(() => close(w, closing));
    expect(refusal.message).toContain('`unmark` it first');
  });
});

describe("an outside-git lane's NO_WORK_EVIDENCE says what that lane and that door take", () => {
  it('at the move to developed, says nothing of base branches and release chains', async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'in_progress', 'outside_git');
    const refusal = await refusalOf(() => toDevelopedAsAgent(w, id));
    expect(refusal.code).toBe('NO_WORK_EVIDENCE');
    expect(refusal.message).toContain('`data.landing`');
    expect(refusal.message).not.toContain(RELEASE_CHAIN_PARAGRAPH);
  });

  it('at the mark, says the mark was not written and to send it again with a landing', async () => {
    const w = await world('standard');
    await asAgent(w);
    const id = await issueAt(w, 'in_progress', 'outside_git');
    const viaTool = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: id, commit: CONTROL_FOLDER_COMMIT },
    });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.text).toContain('NO_WORK_EVIDENCE');
    expect(viaTool.text).toContain('nothing was marked');
    expect(viaTool.text).toContain('`data.landing`');
    expect(viaTool.text).not.toContain('before advancing');
    expect(viaTool.text).not.toContain(RELEASE_CHAIN_PARAGRAPH);
  });

  it("keeps the git lane's base-branch paragraph, where a branch is that lane's evidence", async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'in_progress');
    const refusal = await refusalOf(() => toDevelopedAsAgent(w, id));
    expect(refusal.message).toContain(RELEASE_CHAIN_PARAGRAPH);
  });
});

describe('the declaration re-sent over a standing mark writes nothing', () => {
  it.each([
    ['the REST patch', 'rest'],
    ['forge_issues update', 'tool'],
  ])('leaves updated_at where it was through %s', async (_door, door) => {
    const w = await world('standard');
    const id = await issueAt(w, 'awaiting_release', 'outside_git', { landing: ENV_LANDING });
    const before = await updatedAtOf(id);
    if (door === 'rest') {
      const res = await rest('PATCH', `/api/issues/${id}`, w.token, {
        landingShape: 'outside_git',
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toMatchObject({ declaredLandingShape: 'outside_git' });
    } else {
      const res = await tool(w.pat, {
        action: 'update',
        documentId: id,
        data: { landingShape: 'outside_git' },
      });
      expect(res.isError, res.text).toBe(false);
      expect(res.json()).toMatchObject({ declaredLandingShape: 'outside_git' });
    }
    expect(await updatedAtOf(id)).toBe(before);
  });

  it('still moves updated_at where the declaration does change', async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'in_progress');
    const before = await updatedAtOf(id);
    const res = await rest('PATCH', `/api/issues/${id}`, w.token, { landingShape: 'outside_git' });
    expect(res.status).toBe(200);
    expect(await updatedAtOf(id)).not.toBe(before);
  });
});

describe('LANDING_SHAPE_MARK_STANDS names what decided the lane the mark was made under', () => {
  it("says the project's shape applied on an issue that declared nothing", async () => {
    const w = await world('standard');
    const id = await issueAt(w, 'awaiting_release', null, { mergedAt: true });
    const res = await rest('PATCH', `/api/issues/${id}`, w.token, { landingShape: 'outside_git' });
    expect(res.status).toBe(409);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('LANDING_SHAPE_MARK_STANDS');
    expect(body).toContain("its project's shape (`git`) applied");
    expect(body).not.toContain('declared null');
  });

  it("still refuses by that code where the issue declared its lane and the project's kind is unknown", async () => {
    const w = await world('standard');
    await harness.db.execute(sql`UPDATE projects SET kind = 'kiosk' WHERE id = ${w.projectId}`);
    const id = await issueAt(w, 'awaiting_release', 'outside_git', { landing: ENV_LANDING });
    const res = await rest('PATCH', `/api/issues/${id}`, w.token, { landingShape: 'git' });
    expect(res.status, await res.clone().text()).toBe(409);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('LANDING_SHAPE_MARK_STANDS');
    expect(body).toContain('declared `outside_git`');
  });
});

describe('RELEASE_WORK_UNMERGED follows the roster it was sent', () => {
  it('raises one blocker per lane in roster order, each naming its issues once whatever their case', async () => {
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
    // Keyed and inserted 1, 2, 3, and sent 2, 3, 1: neither the table's order nor its reverse is
    // the roster's, so a read that does not keep the roster's order cannot pass by chance. Each key
    // carries hex letters, and the roster spells them in three cases and names one twice: Postgres
    // matches a uuid in any case, so every spelling is the same issue and is checked once.
    const key = (n: number) => `abcdef0${n}-0000-4000-8000-00000000000${n}`;
    const mixedCase = (id: string) =>
      [...id].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join('');
    const gitFirst = await issueAt(w, 'awaiting_release', null, {}, key(1));
    const gitSecond = await issueAt(w, 'awaiting_release', null, {}, key(2));
    const declared = await issueAt(
      w,
      'awaiting_release',
      'outside_git',
      { mergedAt: true },
      key(3),
    );
    const report = await harness.mods.collectReleaseBlockers(w.projectId, {
      issueIds: [gitSecond.toUpperCase(), mixedCase(declared), gitFirst, gitSecond],
      door: 'record',
    });
    const unmerged = report.blockers.filter((b) => b.code === 'RELEASE_WORK_UNMERGED');
    expect(unmerged.map((b) => b.details?.shape)).toEqual(['git', 'outside_git']);
    expect(unmerged[0]?.details?.issueIds).toEqual([gitSecond, gitFirst]);
    expect(unmerged[1]?.details?.issueIds).toEqual([declared]);
  });
});
