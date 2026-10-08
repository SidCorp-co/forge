/**
 * A window closed on a partial reply keeps its record open for the rest of the turn: the one write
 * that lands is the rest's decision with the blocks it dropped, onto the window it closed under
 * (lane A8b's residual: those blocks were only logged). Read against the real table, since the
 * guard is the UPDATE's own condition.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

const { db } = await import('../../src/db/client.js');
const { conversationWindows } = await import('../../src/db/schema-conversations.js');
const { closeWindow, settleContinuedWindow } = await import('../../src/conversations/index.js');
const { api, userToken } = await import('../helpers/api.js');
const { createTestProject, createTestUser } = await import('../helpers/factories.js');

let token = '';
let projectId = '';

beforeAll(async () => {
  const owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
});

const DROPPED = [{ kind: 'table', runId: 'r-1', why: 'the turn sent none of its own words' }];

/** A claimed window in a room of its own, closed under `detail` as a routed turn closes it. */
async function closedWindow(detail: Record<string, unknown>) {
  const res = await api(token, 'POST', '/api/conversations', {
    projectId,
    title: 'continued',
    people: [],
  });
  expect(res.status).toBe(201);
  const conversationId = (res.body as { id: string }).id;
  const claim = { claimedAt: new Date(), claimedBy: 'core-1' };
  const [row] = await db
    .insert(conversationWindows)
    .values({
      conversationId,
      projectId,
      adapter: 'web',
      openedAt: new Date(),
      extendedAt: new Date(),
      firstSeq: 1,
      lastSeq: 1,
      ...claim,
    })
    .returning({ id: conversationWindows.id });
  const windowId = row?.id ?? '';
  expect(await closeWindow({ windowId, decision: 'answered', detail, claim })).not.toBeNull();
  return { windowId, claim };
}

async function detailOf(windowId: string) {
  const [row] = await db
    .select({ detail: conversationWindows.decisionDetail })
    .from(conversationWindows)
    .where(eq(conversationWindows.id, windowId));
  return row?.detail as Record<string, unknown>;
}

describe("a continued turn's rest, written onto its closed window", () => {
  it('lands once, naming the dropped blocks, and the window stops reading continuing', async () => {
    const { windowId, claim } = await closedWindow({ messageId: 'm-1', continuing: true });
    const continued = { decision: 'answered', messageId: 'm-2', droppedBlocks: DROPPED };
    expect(await settleContinuedWindow({ windowId, claim, continued })).toBe(true);
    expect(await detailOf(windowId)).toMatchObject({
      messageId: 'm-1',
      continuing: false,
      continued,
    });
    expect(
      await settleContinuedWindow({ windowId, claim, continued: { decision: 'stopped' } }),
      'a second write is refused',
    ).toBe(false);
    expect((await detailOf(windowId)).continued).toEqual(continued);
  });

  it('writes nothing onto a window that did not close as continuing', async () => {
    const { windowId, claim } = await closedWindow({ messageId: 'm-1' });
    expect(
      await settleContinuedWindow({ windowId, claim, continued: { decision: 'answered' } }),
    ).toBe(false);
    expect((await detailOf(windowId)).continued).toBeUndefined();
  });

  it('writes nothing under a claim that is not the one the window closed under', async () => {
    const { windowId } = await closedWindow({ messageId: 'm-1', continuing: true });
    const other = { claimedAt: new Date(Date.now() - 1000), claimedBy: 'core-2' };
    expect(
      await settleContinuedWindow({ windowId, claim: other, continued: { decision: 'answered' } }),
    ).toBe(false);
    expect((await detailOf(windowId)).continuing).toBe(true);
  });
});
