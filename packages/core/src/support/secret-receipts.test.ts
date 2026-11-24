import { describe, expect, it } from 'vitest';
import { ROOM_AGENT_GUIDE } from '../guides/room-agent-guide.js';
import { filledNote } from './secret-receipts.js';

const FP = '0123456789abcdef';
const ask = {
  kind: 'variable',
  slot: { key: 'GOOGLE_CLIENT_SECRET', environment: 'production' },
} as unknown as Parameters<typeof filledNote>[0];

describe('the secret-received notice (ISS-1454)', () => {
  it('never asks the agent to name the fingerprint, which the post filter refuses as a sha', () => {
    const note = filledNote(ask, FP, 'page');
    expect(note).toContain('variable GOOGLE_CLIENT_SECRET at environment production');
    expect(note).not.toMatch(/naming (that|the) fingerprint/i);
    expect(note).toMatch(/never post it/);
  });

  it('the room guide does not tell the agent to name a fingerprint', () => {
    expect(JSON.stringify(ROOM_AGENT_GUIDE)).not.toMatch(
      /by fingerprint|naming (that|the) fingerprint/i,
    );
  });
});
