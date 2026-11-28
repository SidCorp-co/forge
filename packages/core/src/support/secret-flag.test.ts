// ISS-1372: the note a room's session is handed on a secret. Once a value is kept nothing more is
// asked of its sender (owner, 2026-11-20), so the slot's door goes only where nothing was kept and
// the thread still owes the slot (ISS-1348 c4). Every value here is an obvious fake.
import { describe, expect, it } from 'vitest';
import type { KeptEntry } from '../project-config/index.js';
import { secretNote } from './secret-flag.js';
import type { NotKept } from './secret-keep.js';

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

const note = (kept: KeptEntry[], door: string | null, missed: NotKept[] = []) =>
  secretNote({
    messageId: 'm-1',
    who: '@alice',
    held: { kept, missed },
    project: PROJECT,
    again: false,
    door,
  });

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

  // ISS-1483 judge dev.857: "<slug>'s master and its runs" in the note had the reply name the master
  it('hands the agent no sentence naming a master, a team or a hand-off to say', () => {
    const usable = { ...ENTRY, state: 'usable' as const };
    for (const said of [note([usable], DOOR), note([ENTRY], DOOR)]) {
      expect(said).toContain('never name a master, a team or a hand-off');
      const told = said.replace('never name a master, a team or a hand-off', '');
      expect(told).not.toMatch(/master and its runs|master reads|team|hand-?off/i);
    }
  });

  it('gives the slot the thread still owes where nothing was kept, and asks no deletion', () => {
    const said = note([], DOOR);
    expect(said).toContain('could not keep it');
    expect(said).toContain(DOOR);
    expect(said).not.toMatch(/You may ask .* to delete|delete that message from/);
    expect(note([], null)).toContain('support.secret_link');
  });

  // cleanup 10c8cdf9 (debt cabd6afd): the note said "no vault key is set" whenever
  // nothing was kept, though a value can be too long, unread or failed with the vault key set
  it.each([
    ['too_long', 'it is longer than the 16384 characters a secret holds'],
    ['unreadable', 'it could not be read back exactly from the message'],
    ['failed', 'keeping it failed'],
    ['no_vault', 'this core has no vault key'],
  ] as const)('says why a value was not kept: %s', (why, said) => {
    const text = note([], null, [{ index: 0, label: 'password', why }]);
    expect(text).toContain(`"password" (filtered value 1): ${said}`);
    if (why !== 'no_vault') expect(text).not.toMatch(/vault key/);
  });

  it('names each value not kept beside the ones kept, by its words, never its value', () => {
    const text = note([ENTRY], null, [{ index: 1, label: 'staging password', why: 'too_long' }]);
    expect(text).toContain('"Stripe key" (key) kept in');
    expect(text).toContain('Not kept, so the record reads [Filtered] there and no vault holds it');
    expect(text).toContain('"staging password" (filtered value 2): it is longer than');
    expect(text).toContain('and what was not kept and why');
    expect(note([ENTRY], null)).not.toMatch(/Not kept|what was not kept/);
  });
});
