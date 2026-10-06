/**
 * ISS-1215 — on an automatic-release project a waiting row either leaves `awaiting_release`
 * without a person, or carries the reason it may not as a standing `release_holds` record
 * (`release-batch/hold.ts`, its one writer). Against real Postgres: what is asserted is what the
 * table holds after a sweep tick.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { resolveReleaseDeclaration } from '../../src/release-batch/gate.js';
import {
  clearReleaseHolds,
  NO_ACTOR_HOLD,
  refusalHold,
  writeReleaseHolds,
} from '../../src/release-batch/hold.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import {
  createTestProject,
  createTestUser,
  rows,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import {
  AT_RELEASE,
  fakeCoolify,
  PROBE_URL,
  releaseWorld,
  seedProductionDeployTrigger,
  verdictComment,
} from '../helpers/release-world.js';

const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };

let projectId: string;
let ownerId: string;
let deploys = 0;
const coolify = fakeCoolify();
const fx = releaseWorld(() => ({ projectId, ownerId }));
const { holdOf, holdHistory, insertIssue, stored } = fx;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
  coolify.applications.clear();
  await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] });
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
  serve(SERVING);
  await fx.seedReleaseRunner();
});

/** Production's probe and the latest deployment Coolify records both answer `commit`. */
function serve(commit: string): void {
  fx.serve(commit);
  deploys += 1;
  coolify.deployed(
    APP.resourceUuid,
    `dep-${deploys}`,
    commit,
    new Date(Date.UTC(2026, 8, 29, 0, deploys)).toISOString(),
  );
}

function verdictBlock(criterion: number, verdict: string, at = `runtime: ${SERVING}`): string {
  return [
    `criterion: ${criterion}`,
    `verdict: ${verdict}`,
    at,
    'evidence: judge-evidence.txt',
    'why: exercised directly',
    'judge: judge-1',
    'judge-from: inherited',
  ].join('\n');
}

/** A waiting row whose criterion 1 carries `verdict` and whose criterion 2 passed. */
async function heldRow(verdict = 'skipped'): Promise<string> {
  const id = await insertIssue('awaiting_release', undefined, true, ['a', 'b']);
  const landing = JSON.stringify({ landing: { head: 'dce6f354c', deployment: SERVING } });
  await db.execute(sql`UPDATE issues SET session_context = ${landing}::jsonb WHERE id = ${id}`);
  await fx.postVerdict(id, verdictComment([verdictBlock(1, verdict), verdictBlock(2, 'pass')]));
  return id;
}

const sweep = () => sweepAutomaticReleases();

describe('a held row says why, and keeps one record per reason', () => {
  it('writes the hold once, and a second tick with the same reason writes nothing', async () => {
    const id = await heldRow();

    const first = await sweep();
    const written = await holdOf(id);
    expect(first.holdsWritten).toBe(1);
    expect(written?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(written?.owes).toBe('human');
    expect(written?.reason).toContain('criterion 1');
    expect(written?.reason).not.toContain('criterion 2');
    expect(written?.reason).toContain('this project is serving');
    expect(written?.reason).toContain(`\`${SERVING}\``);
    expect(written?.reason).toMatch(/read at \d{4}-\d\d-\d\dT/);

    const second = await sweep();
    expect(second.holdsWritten).toBe(0);
    expect(await holdHistory(id)).toHaveLength(1);
    expect(await holdOf(id)).toEqual(written);
  });

  it('replaces the hold when the reason changes, keeping the earlier one as cleared history', async () => {
    const id = await heldRow();
    await sweep();

    await fx.postVerdict(id, verdictComment([verdictBlock(1, 'pass'), verdictBlock(2, 'fail')]));
    await sweep();

    const hold = await holdOf(id);
    expect(hold?.reason).toContain('criterion 2');
    expect(hold?.reason).not.toContain('criterion 1:');
    const history = await holdHistory(id);
    expect(history).toHaveLength(2);
    expect(history[0]).toContain('criterion 1');
  });
});

/** ISS-1286 — the same row, cut or held by nothing but what the host answers. */
describe('what the host answers decides a runtime verdict, not what the issue stored', () => {
  const MOVED_ON = '0d98a6be6d9680b967d3f16542eadd25d02602cb';

  it('cuts a row whose passes name the commit the host is serving', async () => {
    const id = await heldRow('pass');

    const result = await sweep();

    expect(result.issuesCut).toBe(1);
    expect(await holdOf(id)).toBeNull();
  });

  it('holds the same row once the host answers a commit no verdict was judged at', async () => {
    const id = await heldRow('pass');
    serve(MOVED_ON);

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    const hold = await holdOf(id);
    expect(hold?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(hold?.reason).toContain('each of criteria 1 and 2');
    expect(hold?.reason).toContain(SERVING);
    expect(hold?.reason).toContain(MOVED_ON);
    expect(hold?.reason).toContain(PROBE_URL);
  });
});

/** ISS-1346 criterion 25: what is served is said once on the hold, however the criteria spell it. */
describe('a criteria hold names each served commit once', () => {
  const JUDGED_A = '72b94aff846279e6bfb4f6d347586ee67a3cd5f1';
  const JUDGED_B = '83c9199320ccf88d12402a0cd77c3d3ebc53baa7';
  const times = (text: string, what: string) => text.split(what).length - 1;

  async function rowJudgedAt(first: string, second: string): Promise<string> {
    const id = await insertIssue('awaiting_release', undefined, true, ['a', 'b']);
    await db.execute(sql`
      UPDATE issues SET session_context = ${JSON.stringify({ landing: { head: 'dce6f354c' } })}::jsonb
       WHERE id = ${id}
    `);
    await fx.postVerdict(
      id,
      verdictComment([
        verdictBlock(1, 'pass', `commit: ${first}`),
        verdictBlock(2, 'pass', `commit: ${second}`),
      ]),
    );
    return id;
  }

  it('names the served commit once where two criteria were judged at two commits it is not serving', async () => {
    const id = await rowJudgedAt(JUDGED_A, JUDGED_B);

    await sweep();

    const reason = String((await holdOf(id))?.reason);
    expect(reason).toContain(
      `criterion 1: judged at ${JUDGED_A}, which is not a commit this project is serving`,
    );
    expect(reason).toContain(
      `criterion 2: judged at ${JUDGED_B}, which is not a commit this project is serving`,
    );
    expect(times(reason, SERVING)).toBe(1);
  });

  it('refuses a verdict naming an abbreviated commit by name, and records nothing for it', async () => {
    await expect(rowJudgedAt(JUDGED_A, JUDGED_A.slice(0, 8))).rejects.toThrow(
      `criterion 2 names commit \`${JUDGED_A.slice(0, 8)}\`, and a verdict names the whole 40-character sha`,
    );
    const [recorded] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM criterion_verdicts v
        JOIN issue_criteria c ON c.id = v.criterion_id
       WHERE c.issue_id IN (SELECT id FROM issues WHERE project_id = ${projectId})
    `);
    expect(recorded?.n).toBe(0);
  });
});

describe('every exit before the cut is written on the row', () => {
  it('holds RELEASE_TARGET_UNDECLARED, in the gate refusal’s own words, on every waiting row', async () => {
    const ids = [await heldRow('pass'), await heldRow('pass')];
    await db.execute(
      sql`UPDATE integration_bindings SET active = false WHERE project_id = ${projectId}`,
    );
    const declaration = await resolveReleaseDeclaration(projectId);
    if (declaration?.kind !== 'undeclared-target') throw new Error('the binding is still a target');

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    for (const id of ids) {
      const hold = await holdOf(id);
      expect(hold?.code).toBe('RELEASE_TARGET_UNDECLARED');
      expect(hold?.reason).toContain(declaration.reason);
      expect((await stored(id)).claim).toBeNull();
    }
  });

  it('writes the refusal code and its words when the release cut is refused', async () => {
    const id = await heldRow('pass');
    await db.execute(sql`DELETE FROM runners WHERE project_id = ${projectId}`);

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    const hold = await holdOf(id);
    expect(hold?.code).toBe('RELEASE_POOL_EMPTY');
    expect(hold?.reason).toContain('The automatic release was refused:');
    expect(hold?.reason).toContain('no runner registered');
    expect((await stored(id)).status).toBe('awaiting_release');
  });
});

describe('a hold does not outlive the wait it describes', () => {
  it('clears a hold when the row is cut into a release', async () => {
    const id = await heldRow();
    await sweep();
    expect(await holdOf(id)).not.toBeNull();

    await fx.postVerdict(id, verdictComment([verdictBlock(1, 'pass'), verdictBlock(2, 'pass')]));
    const result = await sweep();

    expect(result.issuesCut).toBe(1);
    expect(await stored(id)).toMatchObject(AT_RELEASE);
    expect(await holdOf(id)).toBeNull();
  });

  it('clears a hold on a row a person moved off the gate, on the next tick', async () => {
    const id = await heldRow();
    await sweep();
    expect(await holdOf(id)).not.toBeNull();
    await seedIssueStatus(id, 'closed');

    await sweep();

    expect(await holdOf(id)).toBeNull();
  });

  it('writes no hold on a project that is not automatic, and clears the one a row carried', async () => {
    const id = await heldRow();
    await sweep();
    expect(await holdOf(id)).not.toBeNull();
    await db.execute(sql`DELETE FROM project_config_documents WHERE project_id = ${projectId}`);
    const other = await heldRow();

    const result = await sweep();

    expect(result.holdsWritten).toBe(0);
    expect(await holdOf(id)).toBeNull();
    expect(await holdOf(other)).toBeNull();
  });
});

describe('the writer keeps one standing hold per row', () => {
  const offline = ['`sid-xeon-1` reported itself offline.'];
  const write = (issueIds: string[], reasons = offline) =>
    writeReleaseHolds({
      projectId,
      issueIds,
      holdFor: () => refusalHold('NO_RUNNER_ONLINE', reasons),
      now: new Date(),
    });

  it('writes once when two writers race from the same prior hold', async () => {
    const id = await heldRow();
    const both = () =>
      writeReleaseHolds({
        projectId,
        issueIds: [id],
        holdFor: () => NO_ACTOR_HOLD,
        now: new Date(),
      });

    const [a, b] = await Promise.all([both(), both()]);

    expect(a.written + b.written).toBe(1);
    expect(await holdHistory(id)).toHaveLength(1);
    expect((await holdOf(id))?.code).toBe('RELEASE_NO_ACTOR');
  });

  it('writes nothing on a row that left the gate before the write', async () => {
    const id = await heldRow();
    await seedIssueStatus(id, 'closed');

    const tally = await write([id]);

    expect(tally).toMatchObject({ written: 0, skipped: 1 });
    expect(await holdHistory(id)).toHaveLength(0);
  });

  it('drops a heartbeat age from the words, so a held runner is not a new reason every tick', async () => {
    const id = await heldRow();
    await write([id], ['`sid-xeon-1` is offline. It last reported 41s ago.']);
    const tally = await write([id], ['`sid-xeon-1` is offline. It last reported 97s ago.']);

    expect(tally.unchanged).toBe(1);
    expect(await holdHistory(id)).toHaveLength(1);
    expect((await holdOf(id))?.reason).not.toMatch(/\d+s ago/);
  });

  it('holds a row afresh after its hold was cleared', async () => {
    const id = await heldRow();
    await write([id]);
    await clearReleaseHolds([id]);
    expect(await holdOf(id)).toBeNull();

    await write([id]);

    expect(await holdHistory(id)).toHaveLength(2);
    expect((await holdOf(id))?.code).toBe('NO_RUNNER_ONLINE');
  });
});
