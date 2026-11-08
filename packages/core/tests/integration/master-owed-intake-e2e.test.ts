/**
 * ISS-772, requirement lifecycle r20 start → draft: a draft requirement the intake assistant could
 * not draft, with no retry owed, is owed to the project master on every sweep, named with its code.
 *
 * @direct-test-of packages/core/src/masters/owed.ts
 * @direct-test-of packages/core/src/masters/owed-drafts.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

type Who = 'owner' | 'box';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let runnerId = '';

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const deviceId = await createTestDevice(ownerId);
  runnerId = await bindTestRunner(projectId, deviceId);
  say = requester(app, {
    owner: await signUserToken(ownerId),
    box: (
      await mintPat({
        permissions: ['*'],
        userId: ownerId,
        name: 'box',
        deviceId,
        projectIds: [projectId],
      })
    ).plaintext,
  }) as typeof say;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const at = (path: string) => `/api/projects/${projectId}${path}`;

const verdictFacts = {
  restarting: null,
  terminal: true,
  standing: 'proceed',
  pane: 'absent',
  capability: null,
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
  nudge: { last: null, since: 'unreported' },
};

const askVerdict = (who: Who = 'box') =>
  say(who, 'POST', '/api/devices/me/master-session/verdict', {
    projectId,
    runnerId,
    facts: verdictFacts,
  });

/** What core told the box the master is owed besides issues, as the pass is told it. */
const owedLine = async (): Promise<string> => ok(await askVerdict()).work.owedLine;

/** The intake assistant's one draft of `key`, as it ended: a failure with or without a retry owed, or a draft. */
async function intakeEnded(
  key: string,
  end: { code: string; retryOwed: boolean } | 'drafted',
): Promise<void> {
  const [req] = (await db.execute(sql`
    SELECT id FROM requirements WHERE project_id = ${projectId} AND req_seq = ${Number(key.slice(4))}
  `)) as unknown as Array<{ id: string }>;
  await db.execute(sql`DELETE FROM intake_drafts WHERE requirement_id = ${req?.id}`);
  await db.execute(
    end === 'drafted'
      ? sql`INSERT INTO intake_drafts (project_id, requirement_id, outcome, read, body)
            VALUES (${projectId}, ${req?.id}, 'drafted', '{}'::jsonb, '{"links":[]}'::jsonb)`
      : sql`INSERT INTO intake_drafts (project_id, requirement_id, outcome, code, detail, read, attempts, retry_owed)
            VALUES (${projectId}, ${req?.id}, 'failed', ${end.code}, 'planted', '{}'::jsonb, 1, ${end.retryOwed})`,
  );
}

// ISS-772, requirement lifecycle r20 start → draft: "where it cannot run, core owes the requirement
// to the master on every sweep". A failed draft no retry is owed for was owed to nobody.
describe('a draft requirement the intake assistant could not draft is owed to the project master', () => {
  it('is named on the pass with its code once no retry is owed, until it is drafted or proposed', async () => {
    const made = ok(
      await say('owner', 'POST', at('/requirements'), {
        title: 'Drafted by nobody',
        reason: 'the board asked for it',
        criteria: [{ body: 'Every pass names what it could not draft.' }],
      }),
      201,
    );
    const key = made.key as string;
    await settleOutbox();

    await intakeEnded(key, { code: 'INTAKE_MODEL_FAILED', retryOwed: true });
    expect(await owedLine(), "a retry still owed is the outbox's, not the master's").not.toContain(
      key,
    );

    await intakeEnded(key, { code: 'INTAKE_MODEL_UNCONFIGURED', retryOwed: false });
    expect(await owedLine()).toContain(`(${key} INTAKE_MODEL_UNCONFIGURED)`);
    // owed on every sweep, not once
    expect(await owedLine()).toContain(`(${key} INTAKE_MODEL_UNCONFIGURED)`);

    // a withheld item is its master's from its first failure: no retry is ever owed for it
    await intakeEnded(key, { code: 'INTAKE_WITHHELD', retryOwed: false });
    expect(await owedLine()).toContain(`(${key} INTAKE_WITHHELD)`);

    await intakeEnded(key, 'drafted');
    expect(await owedLine(), 'a later draft that succeeds takes it off').not.toContain(key);

    await intakeEnded(key, { code: 'INTAKE_WITHHELD', retryOwed: false });
    ok(await say('owner', 'POST', at(`/requirements/${key}/revisions/1/propose`), {}));
    expect(await owedLine(), 'a revision a person proposed fills it').not.toContain(
      `${key} INTAKE_WITHHELD`,
    );
  });
});
