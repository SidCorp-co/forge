import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { randomUUID } from 'node:crypto';
import { db } from '../../src/db/client.js';
import { createTestIssue, rows } from '../helpers/factories.js';
import { SupportWorld } from '../helpers/support-world.js';

// ISS-854 (owner, agenfold REQ-13): a release that reaches production tells each channel room that
// opted in (`announce.releases` on its support block), the agent's way: the release's user-facing
// notes are handed to the room's agent as a note, and the agent writes the post in its persona's
// language. Core composes no room text. Releases within an hour reach the agent as one note; a room
// that did not opt in is told nothing; a release with no user-facing note is told nowhere, and the
// record says why.

const w = new SupportWorld();
let seq = 100;

beforeAll(async () => {
  await w.start();
}, 120_000);

afterAll(() => w.stop());

const supportBlock = (releases: boolean) => ({
  product: 'Agenfold, the shop back office',
  persona:
    'Bạn là trợ lý của Agenfold. Luôn trả lời bằng tiếng Việt, thân thiện và ngắn gọn với người dùng.',
  grants: { abilities: ['read_checkout', 'file_items'] },
  announce: { releases },
});

/** An issue the release carries, with its release note as the issue holds it. */
async function shippedIssue(notes: Record<string, string> | null): Promise<string> {
  const { id } = await createTestIssue(w.projectId, w.ownerId, seq++, {
    status: 'closed',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  await db.execute(
    sql`UPDATE issues SET release_notes = ${notes ? JSON.stringify(notes) : null}::jsonb WHERE id = ${id}::uuid`,
  );
  return id;
}

/** What the outbox hands the support consumer when a release run's ship is stamped. */
async function shipped(version: string, issueIds: string[]) {
  const { noteReleaseShipped } = await import('../../src/support/index.js');
  await noteReleaseShipped({ projectId: w.projectId, runId: randomUUID(), version, issueIds });
}

const releaseActions = async () =>
  rows<{ tool: string; input: unknown; output: unknown }>(sql`
    SELECT tool, input, output FROM support_actions
     WHERE project_id = ${w.projectId}::uuid AND tool IN ('release_pending', 'release_told')
     ORDER BY created_at`);

describe('ISS-854: a release reaching production is handed to the opted-in room’s agent', () => {
  it('hands the agent one note of the user-facing changes, posts nothing itself, and batches an hour', async () => {
    await w.bind(supportBlock(true));
    await w.settleWarm();
    const notes: { thread: string; text: string }[] = [];
    w.box.model = async (turn) => {
      for (const m of turn.messages) if (m.from === 'forge') notes.push(m);
    };
    const linesBefore = (await w.chat.botLines()).length;

    // the first release goes at once
    await shipped('1.4.0', [
      await shippedIssue({
        section: 'Added',
        title: 'Export orders to CSV',
        userFacing: 'You can now export your orders to a CSV file from the Orders page.',
      }),
      await shippedIssue({ section: 'Skip', userFacing: '-' }),
    ]);
    await expect.poll(() => notes.length, { timeout: 10_000 }).toBe(1);
    expect(notes[0]?.text).toContain('1.4.0');
    expect(notes[0]?.text).toContain(
      'You can now export your orders to a CSV file from the Orders page.',
    );
    // what a Skip note says is never handed on as a change
    expect(notes[0]?.text).not.toContain('Skip');

    // releases inside the hour after it wait, and go together as one note
    await shipped('1.4.1', [
      await shippedIssue({
        section: 'Fixed',
        title: 'Prices round correctly',
        userFacing: 'Prices with cents now show their exact amount.',
      }),
    ]);
    await shipped('1.4.2', [
      await shippedIssue({
        section: 'Fixed',
        title: 'Search finds SKUs',
        userFacing: 'Searching by SKU finds the product again.',
      }),
    ]);
    const { deliverReleaseNotes } = await import('../../src/support/index.js');
    await deliverReleaseNotes();
    await new Promise((r) => setTimeout(r, 500));
    expect(notes).toHaveLength(1);
    // an hour on, both go in one note
    await db.execute(sql`UPDATE support_actions SET created_at = created_at - interval '61 minutes'
                          WHERE project_id = ${w.projectId}::uuid AND tool = 'release_told'`);
    await deliverReleaseNotes();
    await expect.poll(() => notes.length, { timeout: 10_000 }).toBe(2);
    expect(notes[1]?.text).toContain('2 releases reached production (1.4.1, 1.4.2)');
    expect(notes[1]?.text).toContain('Prices with cents now show their exact amount.');
    expect(notes[1]?.text).toContain('Searching by SKU finds the product again.');
    // the agent writes the post; core posted nothing in the room
    expect((await w.chat.botLines()).length).toBe(linesBefore);
  });

  it('records why, and tells nobody, for a release with no user-facing note', async () => {
    const before = (await releaseActions()).length;
    await shipped('1.5.0', [await shippedIssue({ section: 'Skip', userFacing: '-' })]);
    const after = (await releaseActions()).slice(before);
    expect(after).toEqual([
      {
        tool: 'release_pending',
        input: { version: '1.5.0', notes: [] },
        output: { told: false, why: 'the release carries no user-facing note' },
      },
    ]);
  });

  it('tells a room that did not opt in nothing', async () => {
    const off = await w.regrant(supportBlock(false));
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const before = (await releaseActions()).length;
    await shipped('1.6.0', [
      await shippedIssue({
        section: 'Added',
        title: 'Dark mode',
        userFacing: 'The back office now has a dark mode.',
      }),
    ]);
    expect((await releaseActions()).length).toBe(before);
  });
});
