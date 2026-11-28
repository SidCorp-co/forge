// Every sentence a read or a note hands a room's agent to relay, rendered over a fixture, so one guard
// (`room-said.test.ts`) fails when any of them names the master, a team or a hand-off (ISS-1483: round 1
// fixed the kept-key note, the judge found the release hold, then the slot link; one guard now holds the
// class). A NEW such string joins the guard by adding one entry here: its source file and a renderer
// returning the strings it says; a hold that needs the database is read by
// `tests/integration/support-release-holds-e2e.test.ts`, which holds every string of that read to the same rule.
import type { KeptEntry } from '../project-config/index.js';
import { UNSEEN } from './ops-release-holds.js';
import { secretNote } from './secret-flag.js';
import { slotSays } from './secret-link.js';

/** The instruction phrases a relayed string may hold: an act the agent makes, or the rule it is taught. */
export const TAUGHT_NOT_SAID: readonly string[] = [
  'never name a master, a team or a hand-off',
  'support.ask_master',
];

const KEPT: KeptEntry = {
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

const PROJECT = { id: '00000000-0000-4000-8000-000000000001', slug: 'order-desk' };

const note = (kept: KeptEntry[], missed: { label: string; index: number; why: 'failed' }[] = []) =>
  secretNote({
    messageId: 'm-1',
    who: '@alice',
    held: { kept, missed },
    project: PROJECT,
    again: false,
    door: null,
  });

/** Each entry: where the string is worded, and a render of every branch of it. */
export const ROOM_SAID: readonly { name: string; file: string; render: () => string[] }[] = [
  {
    name: 'the note on a kept secret',
    file: 'support/secret-flag.ts',
    render: () => [
      note([{ ...KEPT, state: 'usable' }]),
      note([KEPT]),
      note([KEPT], [{ label: 'x', index: 0, why: 'failed' }]),
      note([]),
    ],
  },
  {
    name: 'what a slot link says',
    file: 'support/secret-link.ts',
    render: () =>
      [true, false].flatMap((write) =>
        [true, false].flatMap((held) => [
          slotSays(write, held, undefined),
          slotSays(write, held, 'only a run with an issue merged on `main` reads it'),
        ]),
      ),
  },
  {
    name: 'what is unseen beside a release hold',
    file: 'support/ops-release-holds.ts',
    render: () => [UNSEEN],
  },
];
