import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  seedIssueStatus,
} from '../helpers/factories.js';

// ADR 0009, What core takes over: Recovery verdict. The box posts the pid, pane, transcript and
// checkout facts of a run its ledger holds open; core reads the run's issues itself and answers.

type Who = 'box' | 'otherBox';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';

async function issue(seq: number, status: string, ownerId: string): Promise<void> {
  const [row] = (await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, created_by_id)
    VALUES (${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${ownerId})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  if (status !== 'open') await seedIssueStatus(String(row?.id), status);
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
  const otherDevice = await createTestDevice(ownerId);
  await issue(1, 'dropped', ownerId);
  await issue(2, 'on_hold', ownerId);
  await issue(3, 'in_progress', ownerId);
  say = requester(app, {
    box: (await mintPat({ userId: ownerId, name: 'box', deviceId, projectIds: [projectId] }))
      .plaintext,
    otherBox: (
      await mintPat({ userId: ownerId, name: 'other', deviceId: otherDevice, projectIds: [] })
    ).plaintext,
  }) as typeof say;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

function facts(over: Doc = {}): Doc {
  return {
    issueKeys: ['ISS-1'],
    parkedOnHuman: false,
    master: 'alive',
    liveMasterInProject: false,
    thisBoot: true,
    bootEnded: false,
    bound: true,
    process: 'none',
    ledgerDead: false,
    host: 'not_read',
    hostEnded: null,
    ended: false,
    declaredAgoMs: 60_000,
    checkoutGone: null,
    hasSession: true,
    activity: null,
    sessionOverForMs: null,
    subagent: { kind: 'turn_ended', silentMs: 2 * 60 * 60_000 },
    transcript: { kind: 'none' },
    releaseDecided: false,
    releaseRefused: false,
    close: null,
    ...over,
  };
}

const verdict = (body: Doc, who: Who = 'box') =>
  say(who, 'POST', '/api/devices/me/run-sessions/verdict', body);

describe('POST /api/devices/me/run-sessions/verdict', () => {
  it("closes a kept subagent once every issue it holds is over, read off core's own issue rows", async () => {
    expect(ok(await verdict({ projectId, facts: facts() }))).toMatchObject({
      act: 'close',
      end: null,
    });
    expect(
      ok(await verdict({ projectId, facts: facts({ issueKeys: ['ISS-1', 'ISS-3'] }) })),
    ).toMatchObject({ act: 'keep', beat: true, sayKept: true });
  });

  it('ends a stale declaration whose issues rest at core and whose checkout is gone', async () => {
    const v = ok(
      await verdict({
        projectId,
        facts: facts({ bound: false, checkoutGone: true, issueKeys: ['ISS-1', 'ISS-2'] }),
      }),
    );
    expect(v.act).toBe('close');
    expect(v.end).toContain('stale declaration: ISS-1, ISS-2');
  });

  it('reads no issue for a box that does not reach the project, so nothing is concluded', async () => {
    const v = ok(await verdict({ projectId, facts: facts() }, 'otherBox'));
    expect(v).toMatchObject({ act: 'keep', sayKept: true });
  });

  it('answers settle once the box sends the marks its close loop read back', async () => {
    const v = ok(
      await verdict({
        projectId,
        facts: facts({
          process: 'gone',
          ledgerDead: true,
          close: {
            sessionTerminal: true,
            checkoutReturned: false,
            leasesReturned: 1,
            leasesTotal: 1,
          },
        }),
      }),
    );
    expect(v).toMatchObject({ act: 'settle', deathReport: false, standing: null });
    expect(v.release.reason).toContain("core's session row is terminal");
  });

  it('refuses a fact it does not know by name, rather than deciding without it', async () => {
    const res = await verdict({ projectId, facts: facts({ master: 'maybe' }) });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(JSON.stringify(res.json)).toContain('master');
    const extra = await verdict({ projectId, facts: facts({ verdict: 'keep' }) });
    expect(extra.status).toBe(400);
  });
});
