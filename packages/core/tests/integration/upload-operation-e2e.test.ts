/**
 * A presigned upload whose answer is lost is stored once: the caller mints one operation id per
 * file, a second mint of it returns the first ticket, and a replay of the PUT that consumed it is
 * answered with what that PUT stored. Through the ticket service, against Postgres.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { refusalCodeOf } from '../../src/lib/refusal.js';
import {
  claimUploadTicket,
  createUploadTicket,
  recordUploadResult,
  releaseUploadTicket,
  replayOfUsedTicket,
  UPLOAD_REPLAY_WINDOW_MS,
} from '../../src/uploads/ticket-service.js';
import { createTestUser } from '../helpers/factories.js';

const mint = (uploaderId: string, targetId: string, operationId: string, name = 'a.png') =>
  createUploadTicket({
    targetType: 'conversation',
    targetId,
    uploaderId,
    uploaderDeviceId: null,
    name,
    mime: 'image/png',
    operationId,
  });

describe('an upload ticket is minted once per operation', () => {
  it('returns the first ticket for a second mint of the same operation', async () => {
    const user = await createTestUser();
    const room = randomUUID();
    const first = await mint(user.id, room, 'op-12345678');
    const again = await mint(user.id, room, 'op-12345678');
    expect(again.id).toBe(first.id);
    expect(first.replay).toBe(false);
    expect(again.replay).toBe(true);
    const other = await mint(user.id, room, 'op-87654321');
    expect(other.id).not.toBe(first.id);
  });

  it('does not share an operation id between rooms or between people', async () => {
    const [a, b] = [await createTestUser(), await createTestUser()];
    const first = await mint(a.id, randomUUID(), 'op-shared-id');
    expect((await mint(a.id, randomUUID(), 'op-shared-id')).id).not.toBe(first.id);
    expect((await mint(b.id, randomUUID(), 'op-shared-id')).id).not.toBe(first.id);
  });

  it('refuses a different file under an operation id already used, by name', async () => {
    const user = await createTestUser();
    const room = randomUUID();
    await mint(user.id, room, 'op-12345678', 'a.png');
    const refused = await mint(user.id, room, 'op-12345678', 'b.png').catch((e) => e);
    expect(refusalCodeOf(refused)).toBe('UPLOAD_OPERATION_REUSED');
  });

  it('answers a replay of the PUT with what the first PUT stored', async () => {
    const user = await createTestUser();
    const ticket = await mint(user.id, randomUUID(), 'op-12345678');
    expect(await claimUploadTicket(ticket.id)).not.toBeNull();
    expect(await claimUploadTicket(ticket.id)).toBeNull();

    const inFlight = await replayOfUsedTicket(ticket.id).catch((e) => e);
    expect(refusalCodeOf(inFlight)).toBe('UPLOAD_IN_PROGRESS');

    await recordUploadResult(ticket.id, { id: 'att-1', size: 7 });
    expect(await replayOfUsedTicket(ticket.id)).toEqual({ result: { id: 'att-1', size: 7 } });
  });

  it('refuses a replay whose first PUT never recorded an answer, past the ticket life', async () => {
    const user = await createTestUser();
    const ticket = await mint(user.id, randomUUID(), 'op-12345678');
    await claimUploadTicket(ticket.id);
    await db.execute(
      sql`UPDATE upload_tickets SET consumed_at = now() - interval '20 minutes' WHERE id = ${ticket.id}`,
    );
    const refused = await replayOfUsedTicket(ticket.id).catch((e) => e);
    expect(refusalCodeOf(refused)).toBe('UPLOAD_OUTCOME_UNKNOWN');
  });

  it('stops answering a replay once the replay window has passed', async () => {
    const user = await createTestUser();
    const ticket = await mint(user.id, randomUUID(), 'op-12345678');
    await claimUploadTicket(ticket.id);
    await recordUploadResult(ticket.id, { id: 'att-1' });
    await db.execute(
      sql`UPDATE upload_tickets SET consumed_at = now() - make_interval(secs => ${(UPLOAD_REPLAY_WINDOW_MS + 60_000) / 1000}) WHERE id = ${ticket.id}`,
    );
    expect(await replayOfUsedTicket(ticket.id)).toBeNull();
  });

  it('does not replay a ticket released after a failed persist', async () => {
    const user = await createTestUser();
    const ticket = await mint(user.id, randomUUID(), 'op-12345678');
    await claimUploadTicket(ticket.id);
    await releaseUploadTicket(ticket.id);
    expect(await replayOfUsedTicket(ticket.id)).toBeNull();
    expect(await claimUploadTicket(ticket.id)).not.toBeNull();
  });

  it('re-opens an unused ticket that expired, so a late retry is not handed a dead capability', async () => {
    const user = await createTestUser();
    const room = randomUUID();
    const ticket = await mint(user.id, room, 'op-12345678');
    await db.execute(
      sql`UPDATE upload_tickets SET expires_at = now() - interval '1 minute' WHERE id = ${ticket.id}`,
    );
    const again = await mint(user.id, room, 'op-12345678');
    expect(again.id).toBe(ticket.id);
    expect(await claimUploadTicket(ticket.id)).not.toBeNull();
  });
});
