/**
 * ISS-1078 — what the row a delivered reply becomes actually holds.
 *
 * The web conversation path stored text and nothing else until this change, so
 * a room re-opened after a turn that ran six tools drew one paragraph. What is
 * asserted here is the half that could go wrong in the other direction: the
 * amnesty that lets unjudged prose onto the socket must not reach this row, and
 * `content` was guarded for that while `blocks` — the field being filled for the
 * first time — was not.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const appendMessage = vi.fn(async (..._a: unknown[]) => ({ id: 'row-1' }));
vi.mock('./store.js', () => ({
  appendMessage: (...a: unknown[]) => appendMessage(...(a as [never])),
  findConversation: vi.fn(async () => null),
}));
vi.mock('./participants.js', () => ({
  handleForProject: vi.fn(async () => 'agent-1'),
}));

const { recordDeliveredReply } = await import('./transcript.js');

const reply = (over: Record<string, unknown> = {}) => ({
  conversationId: 'conv-1',
  projectId: 'proj-1',
  text: 'there are two open issues.',
  receipt: { messageId: 'transport-id-9' },
  ...over,
});

beforeEach(() => {
  appendMessage.mockClear();
});

describe('a delivered reply', () => {
  // cm:guard criterion 11 at the write: the row takes the id the socket's frames carried, so a
  // client keyed by `id` reduces the growing frames and this row to ONE assistant turn. Minting a
  // second here is what gave one answer two identities on beta (ISS-1029 review F1).
  it('is written under the entry id the turn streamed with', async () => {
    await recordDeliveredReply(reply({ entryId: 'entry-7' }));
    expect(appendMessage.mock.calls[0]?.[0]).toMatchObject({ id: 'entry-7' });
  });

  // cm:guard the RECEIPT id stays the transport's own and is not promoted to the row's identity:
  // the two answer different questions, and nothing in the client's reduction reads the receipt.
  it('keeps the transport’s receipt id out of the row’s identity', async () => {
    await recordDeliveredReply(reply({ entryId: 'entry-7', deliveryKey: 'win-1' }));
    const written = appendMessage.mock.calls[0]?.[0] as {
      id: string;
      deliveryProof: { messageId: string };
    };
    expect(written.id).toBe('entry-7');
    expect(written.deliveryProof.messageId).toBe('transport-id-9');
  });

  // cm:guard criterion 10's write half: a turn that ran tools keeps the ordered record of what it
  // ran, which is the only reason re-opening the room can draw its cards.
  it('stores the ordered blocks the turn produced', async () => {
    const blocks = [
      { type: 'tool' as const, toolCall: { id: 't1', name: 'forge_issues', input: {} } },
      { type: 'text' as const, text: 'there are two open issues.' },
    ];
    await recordDeliveredReply(reply({ entryId: 'entry-7', blocks }));
    expect(appendMessage.mock.calls[0]?.[0]).toMatchObject({ blocks });
  });

  // cm:guard criterion 9, and the boundary the whole streaming amnesty rests on. The producer hands
  // over only the blocks it says are storable; what this asserts is that this door passes them
  // through unchanged rather than reaching for the entry itself — so a refused draft cannot arrive
  // by `blocks` any more than it can by `content`.
  it('writes what it was handed and never a draft beside it', async () => {
    await recordDeliveredReply(
      reply({
        text: 'there are two open issues.',
        entryId: 'entry-7',
        blocks: [
          { type: 'tool' as const, toolCall: { id: 't1', name: 'forge_issues', input: {} } },
        ],
      }),
    );
    const written = appendMessage.mock.calls[0]?.[0] as { content: string; blocks: unknown[] };
    expect(written.content).toBe('there are two open issues.');
    expect(written.blocks.some((b) => (b as { type: string }).type === 'text')).toBe(false);
  });

  // cm:guard a caller that kept no entry — every adapter but the Forge UI's — writes exactly the row
  // it wrote before, with no `id` and no `blocks` key, so the column keeps minting its own and the
  // legacy text-only reading stands (ISS-1029's null-blocks row).
  it('leaves the row untouched for a caller that kept no entry', async () => {
    await recordDeliveredReply(reply());
    const written = appendMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty('id');
    expect(written).not.toHaveProperty('blocks');
  });

  // cm:guard failures here are LOGGED and never thrown: the venue has the message by the time this
  // runs, and turning a delivered answer into an error is a lie in the other direction.
  it('does not turn a failed write into a failed delivery', async () => {
    appendMessage.mockRejectedValueOnce(new Error('the row would not commit'));
    await expect(recordDeliveredReply(reply({ entryId: 'entry-7' }))).resolves.toBeUndefined();
  });
});
