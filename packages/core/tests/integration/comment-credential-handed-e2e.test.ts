/**
 * ISS-1389 round 5 — the comment guard reads what an agent is handed, and a move keeps no more of
 * its reason than its comment does.
 *
 * An agent reads a comment through `markUntrusted`, which takes out invisible characters, comment
 * delimiters and frame tokens. A stored credential split by any of them is whole for the agent, so
 * it is refused at every door a caller writes through. A move's reason is withheld once, and the
 * activity feed and the transition log keep what the posted comment keeps. Real Postgres, because
 * what is claimed is what is stored, read back.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  charactersTakenOut,
  codePoint,
  SEQUENCES_TAKEN_OUT,
} from '../../src/prompt/handed-read.fixture.js';
import { readAsHanded } from '../../src/prompt/sanitize.js';
import {
  aComment,
  anIssue,
  createDoors,
  editDoors,
  PASSWORD,
  SHORT,
  storeCredentials,
  storedBody,
  USERNAME,
} from '../helpers/comment-credential-fixture.js';
import { type Caller, callRest, type Role, seedRoles } from '../helpers/door-parity.js';
import {
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';
import { bodiesOn } from '../helpers/run-evidence-fixture.js';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownerId: string;
let callers: Record<Role, Caller>;
let drainOutboxOnce: typeof import('../../src/pipeline/outbox-worker.js').drainOutboxOnce;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
  drainOutboxOnce = (await import('../../src/pipeline/outbox-worker.js')).drainOutboxOnce;
  const { hooks } = await import('../../src/pipeline/hooks.js');
  (await import('../../src/pipeline/subscribers.js')).registerActivitySubscribers(hooks);
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const seeded = await seedRoles(harness.db);
  projectId = seeded.projectId;
  ownerId = seeded.ownerId;
  callers = seeded.callers;
});

const issue = (): Promise<string> => anIssue(harness.db, projectId, ownerId);
const bodies = (issueId: string): Promise<string[]> => bodiesOn(harness.db, issueId);
const creates = createDoors(() => server.baseUrl);
const edits = editDoors(() => server.baseUrl);

/** The long username with `between` after its fifth character, which an agent is handed whole. */
const splitBy = (between: string): string =>
  `log in as ${USERNAME.slice(0, 5)}${between}${USERNAME.slice(5)} today`;

const TAKEN_OUT = charactersTakenOut();

describe('a value split by a character an agent is not handed', () => {
  it('splits a value an agent is handed whole, for every character planted below', () => {
    for (const one of TAKEN_OUT) expect(readAsHanded(splitBy(one)).text).toContain(USERNAME);
  });

  describe.each(Object.entries(creates))('written through %s', (_name, create) => {
    it('is refused for every character the agent read takes out, and stores nothing', async () => {
      await storeCredentials(harness.db, projectId);
      const here = await issue();
      const admitted: string[] = [];
      for (const one of TAKEN_OUT) {
        const { refused } = await create(callers.member, here, splitBy(one));
        if (!refused?.includes('stored-test-credential')) admitted.push(codePoint(one));
        else expect(refused).toContain('line 1, column 11');
      }
      expect(admitted, 'each of these reached the thread whole for an agent').toEqual([]);
      expect(await bodies(here)).toEqual([]);
    }, 180_000);

    it.each(SEQUENCES_TAKEN_OUT)('is refused with %s inside the value', async (_how, between) => {
      await storeCredentials(harness.db, projectId);
      const here = await issue();
      const { refused } = await create(callers.member, here, splitBy(between));
      expect(refused).toContain('stored-test-credential');
      expect(await bodies(here)).toEqual([]);
    });

    it('stores a body with such a character and no credential byte for byte', async () => {
      await storeCredentials(harness.db, projectId);
      const here = await issue();
      const plain = `the ${SHORT}\u200B account and a soft\u00ADhyphen`;
      expect(await create(callers.member, here, plain)).not.toHaveProperty('refused');
      expect(await bodies(here)).toEqual([plain]);
    });
  });

  describe.each(Object.entries(edits))('edited through %s', (_name, edit) => {
    it('is refused for every character the agent read takes out, and the old words stay', async () => {
      await storeCredentials(harness.db, projectId);
      const id = await aComment(
        harness.db,
        await issue(),
        callers.member.userId,
        'the first words',
      );
      const admitted: string[] = [];
      for (const one of TAKEN_OUT) {
        const { refused } = await edit(callers.member, id, splitBy(one));
        if (!refused?.includes('stored-test-credential')) admitted.push(codePoint(one));
      }
      expect(admitted, 'each of these reached the thread whole for an agent').toEqual([]);
      expect(await storedBody(harness.db, id)).toBe('the first words');
    }, 180_000);
  });
});

describe('a move whose reason carries a stored credential', () => {
  async function activityReasons(issueId: string): Promise<string[]> {
    await drainOutboxOnce();
    const res = await callRest(
      server.baseUrl,
      callers.admin.jwt,
      'GET',
      `/api/issues/${issueId}/activity`,
    );
    const items = (res.body as { items: Array<{ action: string; payload: { reason?: string } }> })
      .items;
    return items
      .filter((row) => row.action === 'issue.statusChanged')
      .map((row) => row.payload.reason ?? '');
  }

  it('keeps in the activity what the comment holds, never the value', async () => {
    await storeCredentials(harness.db, projectId);
    const here = await issue();
    const reason = `the ${USERNAME} account is locked and ${PASSWORD} fails, also ${SHORT} works`;

    const moved = await callRest(
      server.baseUrl,
      callers.admin.jwt,
      'POST',
      `/api/issues/${here}/transition`,
      { toStatus: 'needs_info', reason },
    );
    expect(moved.status, JSON.stringify(moved)).toBe(200);

    const [comment] = await bodies(here);
    const said = comment?.split('\n').slice(2).join('\n');
    expect(said).toMatch(/^the \[withheld: .+\] account is locked and \[withheld: .+\] fails/);
    const reasons = await activityReasons(here);
    expect(reasons).toEqual([said]);
    const kernel = (await harness.db.execute(
      sql`SELECT reason FROM kernel_transitions WHERE entity_id = ${here}`,
    )) as unknown as Array<{ reason: string | null }>;
    expect(kernel.map((row) => row.reason)).toEqual([said]);
    const everything = JSON.stringify({ reasons, kernel, comment });
    expect(everything).not.toContain(USERNAME);
    expect(everything).not.toContain(PASSWORD);
  });

  it('keeps a reason with no stored credential as written', async () => {
    await storeCredentials(harness.db, projectId);
    const here = await issue();
    const reason = `which ${SHORT} build is meant?`;
    await callRest(server.baseUrl, callers.admin.jwt, 'POST', `/api/issues/${here}/transition`, {
      toStatus: 'needs_info',
      reason,
    });
    expect(await activityReasons(here)).toEqual([reason]);
  });
});
