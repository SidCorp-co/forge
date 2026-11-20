// ISS-1372: the note a room's session is handed on a secret. Once a value is kept nothing more is
// asked of its sender (owner, 2026-11-20), so the slot's door goes only where nothing was kept and
// the thread still owes the slot (ISS-1348 c4). Every value here is an obvious fake.
import { describe, expect, it } from 'vitest';
import type { KeptEntry } from '../project-config/index.js';
import { secretNote } from './secret-flag.js';

const PROJECT = { id: '00000000-0000-4000-8000-000000000001', slug: 'order-desk' };
const DOOR =
  'This thread asked for variable STRIPE_KEY at environment staging: in that same reply, give the person its link https://forge.example.test/projects/order-desk/settings?tab=secrets&ask=a1';

const ENTRY: KeptEntry = {
  name: 'stripe-key-a1b2c3',
  label: 'Stripe key',
  kind: 'key',
  from: { chatKey: 'u-alice', label: 'alice', userId: null, admin: false },
  room: 'room-1',
  thread: 't-1',
  message: 'm-1',
  at: '2026-11-20T02:44:00.000Z',
  expiresAt: '2026-11-21T02:44:00.000Z',
  actsAs: '@alice',
  ref: 'secret://kept/stripe-key-a1b2c3',
  state: 'pending',
  fingerprint: null,
  decidedBy: null,
  decidedAt: null,
};

const note = (kept: KeptEntry[], door: string | null) =>
  secretNote({ messageId: 'm-1', who: '@alice', kept, project: PROJECT, again: false, door });

describe('the note on a secret a member sent', () => {
  it('names what was kept and asks nothing more, not even the slot the thread asked for', () => {
    const said = note([ENTRY], DOOR);
    expect(said).toContain(
      '"Stripe key" (key) kept in order-desk\'s vault as secret://kept/stripe-key-a1b2c3',
    );
    expect(said).toContain('Tell the room once, in this same reply');
    expect(said).toContain('Ask nobody to delete the message');
    expect(said).not.toContain('asked for variable STRIPE_KEY');
    expect(said).not.toMatch(/curl|secret_link|write command/);
  });

  it('gives the slot the thread still owes where nothing was kept, and asks no deletion', () => {
    const said = note([], DOOR);
    expect(said).toContain('could not keep it');
    expect(said).toContain(DOOR);
    expect(said).not.toMatch(/You may ask .* to delete|delete that message from/);
    expect(note([], null)).toContain('support.secret_link');
  });
});
