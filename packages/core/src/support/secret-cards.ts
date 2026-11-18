// The card of the act a room agent gives a person who wants a credential used (ISS-1328), beside the
// door it describes (`secret-link.ts`). Written from the Catalog-AdminHub thread of 18/11 (PGPrints
// test credentials): the bot refused the owner's grant four times, asked him to delete and rotate
// after he declined, and the owner did the setup himself.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { SupportAction } from './act-cards.js';

export const SECRET_ACT_CARDS = {
  secret_link: {
    purpose:
      'Gives a person the Forge link where they enter a credential for the project’s testing profile, so the master uses it without it passing through chat.',
    situations: [
      {
        when: 'a person sends a key, a password or a token in chat, or offers one for you or the master to use',
        do: 'say once that it was not kept and why, and in the same line give the link support.secret_link { thread, profile, actor | service } answers; never repeat, use or keep what they sent',
        watch:
          'a deletion its author or a Technical member declines is settled for the thread: never ask it again, and never ask anyone to rotate, change or revoke the key',
      },
    ],
    practice: [
      'Name the profile’s actor where the value signs in, its service where it is a key; a slot the profile lacks is the master’s to declare (support.ask_master).',
      'This link is the one page you send a person to: it opens for someone signed in to Forge who edits the project’s settings.',
    ],
    example: { thread: '86aGqsokzYezYNdvF', profile: 'stg', service: 'pgprints' },
    // ISS-1328: 18/11, Catalog-AdminHub: four refusals of the owner's grant, then a delete-and-rotate
    // ask after he said the test account needs no deletion
    redFlag:
      'Refusing a credential in a loop: on 18/11 the bot asked the owner four times to delete and rotate a test key he had said to use, and he set it up himself.',
    family: 'room.message',
    audience: ['bot'],
    scenarios: ['a test key sent, then a declined deletion: one mention and the link'],
  },
} satisfies Readonly<Partial<Record<SupportAction, CapabilityCardBody>>>;
