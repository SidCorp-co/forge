/**
 * F72: a release-gate reason whose remedy is an act on the issues it names waits on the project's
 * master, by name, and the master is told it once per appearance through the owed work its box asks
 * for on every sweep — never "Release gate" with nobody woken. F73: each issue it names is a link.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { api, patToken, userToken } from '../helpers/api.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
let runnerId: string;
const tokens: Record<'owner' | 'agent' | 'box', string> = { owner: '', agent: '', box: '' };

const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  tokens.owner = await userToken(ownerId);
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'member');
  tokens.agent = await patToken(agentId, [projectId], 'master');
  runnerId = await fx.seedReleaseRunner();
  const [runner] = [
    ...(await db.execute(sql`SELECT device_id FROM runners WHERE id = ${runnerId}`)),
  ] as { device_id: string }[];
  tokens.box = (
    await mintPat({
      userId: ownerId,
      name: 'box',
      deviceId: (runner as { device_id: string }).device_id,
      projectIds: [projectId],
    })
  ).plaintext;
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({ projectId, ownerId, bindingId, probes: 'none' });
});

const call = async (
  who: keyof typeof tokens,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
) => {
  const r = await api(tokens[who], method, path, body);
  expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body as Doc;
};

const draft = async (who: keyof typeof tokens = 'owner') =>
  (await call(who, 'GET', `/api/projects/${projectId}/releases/0.1.0`)).release as Doc;

/** `ISS-n` for the row: the world numbers rows across the whole file, not per test. */
async function keyOf(id: string): Promise<string> {
  const [row] = [...(await db.execute(sql`SELECT iss_seq FROM issues WHERE id = ${id}`))] as {
    iss_seq: number;
  }[];
  return `ISS-${(row as { iss_seq: number }).iss_seq}`;
}

/** What the box reports on a sweep: no pane yet, or the pane it placed and nudged on `digest`. */
function facts(nudged: string | null): Doc {
  return {
    restarting: null,
    terminal: true,
    standing: 'proceed',
    pane: nudged ? 'alive' : 'absent',
    capability: nudged ? 'current' : null,
    serversReadable: true,
    work: { poolWaits: false, jobPanes: 0 },
    conversation: { id: null, transcript: 'absent', elsewhere: 'none' },
    placement: null,
    holding: { kind: 'nothing' },
    turn: { kind: 'ended' },
    idle: {
      noWorkForSeconds: 0,
      pane: null,
      children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
    },
    limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
    nudge: nudged
      ? { last: { digest: nudged, agoSeconds: 30 }, since: 'ran' }
      : { last: null, since: 'unreported' },
  };
}

const sweep = (nudged: string | null) =>
  call('box', 'POST', '/api/devices/me/master-session/verdict', {
    projectId,
    runnerId,
    facts: facts(nudged),
  });

/** Two sweeps as the box runs them: the second reports the nudge the first was answered with. */
async function twoSweeps(): Promise<{ nudges: number; first: Doc; second: Doc }> {
  const first = await sweep(null);
  const second = await sweep(first.verdict.nudge ? first.work.digest : null);
  const nudges = [first, second].filter((s) => s.verdict.nudge === true).length;
  return { nudges, first, second };
}

describe('a draft release held by a missing release note', () => {
  it('waits on the master by name, with the act and the issue, not on the release gate', async () => {
    const key = await keyOf(await fx.insertIssue('awaiting_release', null));
    const release = await draft();
    expect(release).toMatchObject({
      attentionGroup: 'waiting',
      waitingOn: { kind: 'agent', who: 'Master', act: `write the release note on ${key}` },
    });
    expect(release.gates[0]).toMatchObject({
      code: 'RELEASE_RECORD_MISSING',
      issues: [key],
      owner: { kind: 'agent', who: 'Master', act: `write the release note on ${key}` },
    });
    const list = await call('owner', 'GET', `/api/projects/${projectId}/releases`);
    expect(list.counts).toMatchObject({ stuck: 0, waiting: 1 });
    const issue = await call('owner', 'GET', `/api/projects/${projectId}/issues/standing/${key}`);
    expect(JSON.stringify(issue)).toContain('write the release note');
    expect(JSON.stringify(issue)).not.toContain('Approve release on Releases');
  });

  it('tells the master once across two sweeps, naming the issue and the write that clears it', async () => {
    const id = await fx.insertIssue('awaiting_release', null);
    const { nudges, first, second } = await twoSweeps();
    expect(first.work.owed).toBe(1);
    expect(first.work.owedLine).toContain(`with no release note (${await keyOf(id)} ${id})`);
    expect(first.work.owedLine).toContain('RELEASE_RECORD_MISSING');
    expect(second.work.digest).toBe(first.work.digest);
    expect(nudges).toBe(1);
  });

  it('clears from the owed work and the draft once the master writes the note', async () => {
    const id = await fx.insertIssue('awaiting_release', null);
    const before = await sweep(null);
    await call('agent', 'PATCH', `/api/issues/${id}`, {
      releaseNotes: { section: 'Added', userFacing: 'A reminder reaches the nurse' },
    });
    const after = await sweep(before.work.digest);
    expect(after.work.owed).toBe(0);
    expect(after.work.owedLine).not.toContain('release note');
    expect(after.verdict.nudge).toBe(false);
    expect(await draft()).toMatchObject({
      attentionGroup: 'needs_you',
      waitingOn: { kind: 'you', act: 'cut 0.1.0' },
    });
  });
});

describe('an issue at the gate that carries its note', () => {
  it('is owed nothing, and wakes nobody across two sweeps', async () => {
    const id = await fx.insertIssue('awaiting_release', {
      section: 'Added',
      userFacing: 'A new thing',
    });
    const { nudges, first } = await twoSweeps();
    expect(first.work.owed).toBe(0);
    expect(first.work.owedLine).not.toContain(id);
    expect(nudges).toBe(0);
  });
});

describe('a gate reason no issue act clears', () => {
  it('reads as an admin act, not a master one, where the runner pool is empty', async () => {
    await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A new thing' });
    await db.execute(sql`DELETE FROM runners WHERE project_id = ${projectId}`);
    const release = await draft();
    expect(release.gates.find((g: Doc) => g.code === 'RELEASE_POOL_EMPTY')?.owner).toMatchObject({
      kind: 'person',
      who: 'A project admin',
    });
    expect(release).toMatchObject({ attentionGroup: 'needs_you', waitingOn: { kind: 'you' } });
  });
});
