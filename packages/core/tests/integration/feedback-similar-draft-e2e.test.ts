/**
 * A draft not yet filed is compared with the filed items through the same vectors an item's own
 * Similar reads: the draft's head embedded through the policy gate, nothing written. The provider is
 * a word-bag stand-in, so the nearest item is the one sharing the draft's words.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

const DIM = 1536;

/** Each word hashed into one of DIM buckets, the whole normalized: shared words, near vectors. */
function wordBag(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 7;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % DIM;
    v[h] = (v[h] ?? 0) + 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

vi.mock('../../src/integrations/llm/embeddings.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embeddingsConfigured: () => true,
  embedWithModel: async (_scope: unknown, text: string) => ({
    vector: wordBag(text),
    model: 'word-bag',
  }),
}));

let say: (method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;

async function file(title: string): Promise<string> {
  const made = ok(
    await say('POST', at('/feedback'), { kind: 'bug', title, screen: 'The board' }),
    201,
  );
  return made.feedback.key as string;
}

/** The item's vector is written after its filing commits: read until it is. */
async function embedded(fb: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const [row] = await rows<{ status: string }>(
      sql`SELECT e.status FROM item_embeddings e JOIN feedback f ON f.id = e.feedback_id
        WHERE f.project_id = ${projectId} AND f.fb_seq = ${Number(fb.slice(3))}`,
    );
    if (row?.status === 'embedded') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${fb} was never embedded`);
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const owner = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  const r = requester(app, { owner: await signUserToken(owner) });
  say = (method, path, body) => r('owner', method, path, body);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('likely duplicates of a draft', () => {
  let cards = '';
  let colours = '';

  beforeAll(async () => {
    cards = await file('Saving the board loses every card');
    colours = await file('Dark mode colours are unreadable');
    await embedded(cards);
    await embedded(colours);
  });

  it('names the filed item sharing the draft’s words first, with its phase', async () => {
    const r = ok(
      await say('POST', at('/feedback/similar'), {
        title: 'Saving the board loses cards',
        body: 'every card is gone',
      }),
    );
    expect(r.status).toBe('ok');
    expect(r.model).toBe('word-bag');
    const [first, second] = r.hits as Doc[];
    expect(first).toMatchObject({
      key: cards,
      title: 'Saving the board loses every card',
      phase: 'new',
    });
    expect(first?.similarity).toBeGreaterThan(second?.similarity ?? -1);
  });

  it('writes nothing for the draft: the filed items stay the only vectors', async () => {
    const [n] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM item_embeddings WHERE project_id = ${projectId}`,
    );
    expect(n?.n).toBe(2);
  });
});

describe('where a likely duplicate routes (ISS-1402)', () => {
  let root = '';
  let dup = '';
  let carrier = '';
  let lone = '';

  beforeAll(async () => {
    root = await file('Exporting the ledger drops the header row');
    const triaged = ok(
      await say('POST', at(`/feedback/${root}/triage`), {
        route: 'issue',
        note: 'header bug',
        answers: TRIAGE_ANSWERS,
      }),
    );
    carrier = ((triaged.effect as Doc).carriers as string[])[0] ?? '';
    dup = await file('Exporting the ledger loses the header row');
    ok(
      await say('POST', at(`/feedback/${dup}/triage`), {
        route: 'duplicate',
        duplicateOf: root,
        answers: TRIAGE_ANSWERS,
      }),
    );
    lone = await file('Exporting the ledger header is missing');
    await embedded(root);
    await embedded(dup);
    await embedded(lone);
  });

  it("names a duplicate hit's root and the root's carrier, so a triage routes there first time", async () => {
    expect(carrier).toMatch(/^ISS-\d+$/);
    const r = ok(await say('GET', at(`/feedback/${lone}/similar`)));
    const hits = new Map((r.hits as Doc[]).map((h) => [h.key as string, h]));
    expect(hits.get(dup)).toMatchObject({ duplicateOf: root, carriers: [carrier] });
    expect(hits.get(root)).toMatchObject({ duplicateOf: null, carriers: [carrier] });
    // an item nothing routed reads as before, saying no issue carries it
    const others = [...hits.values()].filter((h) => h.key !== root && h.key !== dup);
    expect(others.length).toBeGreaterThan(0);
    for (const hit of others) expect(hit).toMatchObject({ duplicateOf: null, carriers: [] });
    // the root it names is one a duplicate route takes: no FEEDBACK_DUPLICATE_CHAIN
    ok(
      await say('POST', at(`/feedback/${lone}/triage`), {
        route: 'duplicate',
        duplicateOf: hits.get(dup)?.duplicateOf,
        answers: TRIAGE_ANSWERS,
      }),
    );
  });
});
