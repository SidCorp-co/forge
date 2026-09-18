/**
 * ISS-978 F1/F2 — the claim's arithmetic and the claim's clock.
 *
 * `owedRounds` reads every round before the loop posts any of them, so the
 * `attempts` on an `OwedRound` is a value from before this claim; and the drain
 * is sequential over an HTTP call, so a timestamp taken at the top of the pass
 * is minutes old by the last round. Both were carried into the write.
 *
 * Neither is visible from one drain in one process, which is why the plant in
 * every case here is a SECOND derivation — exactly what a second core instance
 * holds, and what the `cm:guard` on `claimRound` says the claim exists to
 * survive. A test that ran one drain would pass against both the defect and
 * the fix.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const posts: Array<{ rid: string; tmid: string | undefined; text: string }> = [];
let nextMessageId: string | null = 'msg-1';
let postThrows: Error | null = null;
// cm:guard read DURING the post, which is the only moment that can tell a round marked complete before it succeeded from one marked after: every state after the call returns is identical either way, and a process that dies here is what the rule is about (ISS-978 criterion 6).
let atPostTime: (() => Promise<void>) | null = null;

vi.mock('../../src/integrations/rocketchat/outbound.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/integrations/rocketchat/outbound.js')>();
  return {
    ...actual,
    sendFixedReply: vi.fn(
      async (transport: { rid: string; tmid?: string }, text: string, proof: unknown) => {
        // cm:guard the mock re-asserts the proof contract the real door enforces, so a caller that stopped screening its text fails here instead of passing because the door was replaced.
        // cm:guard and it asserts the ISS-978 F5 half too: a proof is a claim about ONE string, so the
        // mock compares it against the text it is being handed. Until F5 this read `proof.ok`, which
        // any literal satisfied and which said nothing about which text had been screened — so a lane
        // that screened the option labels and posted the rendered round passed this mock cleanly.
        if (proof !== actual.FIXED_REPLY_CONSTANT && (proof as { text?: string })?.text !== text) {
          throw new Error('text reached the outbound door under a proof that does not name it');
        }
        if (atPostTime) await atPostTime();
        if (postThrows) throw postThrows;
        posts.push({ rid: transport.rid, tmid: transport.tmid, text });
        return { messageId: nextMessageId };
      },
    ),
  };
});

let harness: TestDatabase;
let delivery: typeof import('../../src/integrations/rocketchat/question-delivery.js');
let write: typeof import('../../src/questions/write.js');
let store: typeof import('../../src/integrations/store.js');
let db: typeof import('../../src/db/client.js').db;
let rcSchema: typeof import('../../src/db/schema-rocketchat.js');

let projectId: string;
let ownerId: string;
let issueId: string;
let seq = 0;

const SAFE = {
  id: '22222222-2222-4222-8222-222222222222',
  label: 'Take the safe path',
  authority: 'writer' as const,
  bindsTo: 'session' as const,
  executedBy: 'agent' as const,
};
const RISKY = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'Drop the column',
  authority: 'admin' as const,
  bindsTo: 'project' as const,
  executedBy: 'human' as const,
};
const OPTIONS = [SAFE, RISKY];

/** The one owed round, or a failure naming what was found instead. */
// cm:guard reads the round through a check rather than a non-null assertion: `a!` under `biome check --write` becomes `a?`, which turns "this test is about the owed round" into a silent pass over an empty list.
function onlyOwed(rounds: Awaited<ReturnType<typeof delivery.owedRounds>>) {
  const round = rounds[0];
  if (!round) throw new Error(`expected exactly one owed round, found ${rounds.length}`);
  return round;
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  delivery = await import('../../src/integrations/rocketchat/question-delivery.js');
  write = await import('../../src/questions/write.js');
  store = await import('../../src/integrations/store.js');
  rcSchema = await import('../../src/db/schema-rocketchat.js');
  ({ db } = await import('../../src/db/client.js'));
});

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  posts.length = 0;
  nextMessageId = 'msg-1';
  postThrows = null;
  atPostTime = null;
  const user = await createTestUser(harness.db, { email: `owner-${randomUUID()}@example.com` });
  ownerId = user.id;
  const project = await createTestProject(harness.db, ownerId);
  projectId = project.id;
  issueId = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, ${900 + seq}, 'A parked issue', 'in_progress', ${ownerId})
  `);
});

async function bindRoom(rid = 'room-1'): Promise<string> {
  const connection = await store.createConnection({
    ownerType: 'user',
    ownerId,
    provider: 'rocketchat',
    config: { serverUrl: 'https://chat.example.com' },
    secrets: { authToken: 'tok', userId: 'bot' },
  });
  await store.createBinding({
    connectionId: connection.id,
    projectId,
    provider: 'rocketchat',
    role: 'service',
    config: { rids: [rid] },
  });
  return connection.id;
}

async function ask(over: { blockerKind?: 'human' | 'machine' } = {}) {
  return write.askQuestion({
    id: randomUUID(),
    projectId,
    issueId,
    prompt: 'The migration drops a column. Which way?',
    blockerKind: over.blockerKind ?? 'human',
    answer: { shape: 'choice', options: OPTIONS, recommendedOptionId: SAFE.id },
  });
}

const deliveries = async (questionId: string) =>
  db
    .select()
    .from(rcSchema.rocketchatQuestionDeliveries)
    .where(eq(rcSchema.rocketchatQuestionDeliveries.questionId, questionId));

describe('a claim that overlaps another one', () => {
  // A drain re-derives before it claims, so the two `OwedRound` values below are what two instances
  // hold at the same moment — both carrying `attempts: 0`, both about to write a count.
  it('counts an attempt the other derivation could not see, rather than overwriting it', async () => {
    await bindRoom();
    postThrows = new Error('rocket.chat is down');
    const q = await ask();

    const derivedByA = onlyOwed(await delivery.owedRounds());
    const derivedByB = { ...derivedByA };

    const t0 = Date.now();
    await delivery.deliverOwedRound(derivedByA, new Date(t0));
    // B's claim lands after A's backoff has passed, so `setWhere` admits it — carrying the count it
    // read BEFORE A wrote one.
    await delivery.deliverOwedRound(derivedByB, new Date(t0 + 2 * 60_000));

    // cm:guard TWO, not one: `attempts = owed.attempts + 1` under `set:` writes 1 both times, so A's
    // attempt is erased by B's copy of the number A started from (ISS-978 F2).
    expect((await deliveries(q.id))[0]?.attempts).toBe(2);
  });

  // cm:guard the count and the BACKOFF are separate assertions, because the count can be right while
  // the schedule it feeds is wrong: `60000 * ${attempts}` where `attempts` expands to
  // `coalesce(attempts, 0) + 1` parses as `(60000 * coalesce(...)) + 1`, which gives a second attempt
  // 60,001ms of backoff instead of 120,000. The count reads 2 either way, so the test above passes
  // over it (whole-set review, F1).
  it('backs a reclaimed round off by its own attempt number, not by one millisecond more', async () => {
    await bindRoom();
    postThrows = new Error('rocket.chat is down');
    const q = await ask();

    const derived = onlyOwed(await delivery.owedRounds());
    const t0 = Date.now();
    await delivery.deliverOwedRound({ ...derived }, new Date(t0));

    const reclaimedAt = t0 + 2 * 60_000;
    await delivery.deliverOwedRound({ ...derived }, new Date(reclaimedAt));

    const [row] = await deliveries(q.id);
    expect(row?.attempts).toBe(2);
    // Attempt two, so two backoffs: the retry is 120s after the claim that wrote it.
    expect(new Date(row?.nextAttemptAt ?? 0).getTime() - reclaimedAt).toBe(2 * 60_000);
  });

  // The consequence, and the reason F2 is not merely untidy: the exhaustion branch ISS-978 added is
  // the one thing that tells anybody a question will not be asked, and it is read off this count.
  it('still reaches the attempts cap, so an exhausted round is settled rather than left claimed', async () => {
    await bindRoom();
    postThrows = new Error('rocket.chat is down');
    const q = await ask();

    // Derived ONCE and re-used, which is a drain that keeps losing the race to a peer: under a count
    // taken from the derivation the row never climbs, never hits MAX_ATTEMPTS, and stays `claimed`
    // for ever with nobody told.
    const stale = onlyOwed(await delivery.owedRounds());
    let clock = Date.now();
    for (let i = 0; i < 8; i++) {
      await delivery.deliverOwedRound({ ...stale }, new Date(clock));
      clock += 60 * 60_000;
    }

    const [row] = await deliveries(q.id);
    expect(row?.attempts).toBe(8);
    expect(row?.status).toBe('undeliverable');
  });

  // cm:guard two rounds and a clock that MOVES between them, because one round cannot tell a
  // per-round timestamp from a per-pass one: a pass that reads the clock once writes the same retry
  // time onto every round it touched, however long the posts in between took (ISS-978 F1).
  it('measures each round’s retry from when that round was claimed', async () => {
    await bindRoom();
    postThrows = new Error('rocket.chat is down');
    await ask();
    await ask();

    const STEP = 10 * 60_000;
    let clock = Date.now();
    const result = await delivery.drainQuestionDeliveries(() => {
      clock += STEP;
      return new Date(clock);
    });
    expect(result.owed).toBe(2);

    const rows = await db
      .select()
      .from(rcSchema.rocketchatQuestionDeliveries)
      .where(eq(rcSchema.rocketchatQuestionDeliveries.round, 1));
    expect(rows).toHaveLength(2);
    const [x, y] = rows.map((r) => new Date(r.nextAttemptAt ?? 0).getTime());
    // A single `now` for the pass makes these identical; one read per round makes them exactly the
    // clock's own step apart.
    expect(Math.abs((x ?? 0) - (y ?? 0))).toBe(STEP);
  });
});
