import { createUpdatePacketInputSchema, UPDATE_PACKET_INTENT_CLASSES } from '@forge/contracts';
import { describe, expect, it, vi } from 'vitest';
import { updatePacketIntentClasses, updatePackets } from '../db/schema.js';

describe('update-packet contract parity', () => {
  it('intent classes match between db/schema.ts and @forge/contracts', () => {
    expect([...UPDATE_PACKET_INTENT_CLASSES]).toEqual([...updatePacketIntentClasses]);
  });
});

describe('createUpdatePacketInputSchema', () => {
  it('rejects a missing story', () => {
    const result = createUpdatePacketInputSchema.safeParse({
      change: 'diff',
      intentClass: 'procedure',
      appliesTo: 'forge-release',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty/whitespace-only story', () => {
    const result = createUpdatePacketInputSchema.safeParse({
      change: 'diff',
      story: '   ',
      intentClass: 'procedure',
      appliesTo: 'forge-release',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid packet', () => {
    const result = createUpdatePacketInputSchema.safeParse({
      change: 'diff',
      story: 'Drop the production merge from forge-release: it broke prod for 10 days.',
      intentClass: 'invariant',
      appliesTo: 'forge-release',
    });
    expect(result.success).toBe(true);
  });
});

describe('createUpdatePacket', () => {
  it('rejects missing/empty story before ever opening a transaction', async () => {
    const { createUpdatePacket } = await import('./update-packets.js');
    const transaction = vi.fn();
    const db = { transaction } as never;

    await expect(
      createUpdatePacket(
        db,
        {
          change: 'diff',
          story: '',
          intentClass: 'procedure',
          appliesTo: 'forge-release',
        } as never,
        { actor: 'human:owner', trigger: 'manual' },
      ),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('inserts the packet and emits packet.published with the packet id, in one transaction', async () => {
    const insertedRow = {
      id: 'packet-1',
      change: 'diff',
      story: 'why this changed',
      intentClass: 'invariant',
      appliesTo: 'forge-release',
      provenance: {},
      createdAt: new Date('2026-08-08T00:00:00Z'),
    };
    const returning = vi.fn(async () => [insertedRow]);
    const packetValues = vi.fn(() => ({ returning }));
    const activityValues = vi.fn(async () => {});
    const insert = vi.fn((table: unknown) =>
      table === updatePackets ? { values: packetValues } : { values: activityValues },
    );
    const tx = { insert };
    const db = { transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)) } as never;

    const { createUpdatePacket } = await import('./update-packets.js');
    const result = await createUpdatePacket(
      db,
      {
        change: 'diff',
        story: 'why this changed',
        intentClass: 'invariant',
        appliesTo: 'forge-release',
      },
      { actor: 'human:owner', trigger: 'manual' },
    );

    expect(result).toEqual(insertedRow);
    expect(packetValues).toHaveBeenCalledWith(
      expect.objectContaining({
        change: 'diff',
        story: 'why this changed',
        intentClass: 'invariant',
        appliesTo: 'forge-release',
      }),
    );
    expect(activityValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'packet.published',
        actor: 'human:owner',
        trigger: 'manual',
        packetId: 'packet-1',
        outcome: 'ok',
      }),
    );
  });
});
