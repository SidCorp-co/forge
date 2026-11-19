// The card of the one secret door a room agent gives a person (ISS-1328, ISS-1348), beside the door
// it describes (`secret-link.ts`). Written from the Catalog-AdminHub thread of 18/11 (PGPrints test
// credentials: the bot refused the owner's grant four times) and epod's thread of 19/11 (a production
// OAuth secret: the bot named a settings screen in prose, corrected itself, and the owner pasted the
// secret in chat because no door was offered).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { SupportAction } from './act-cards.js';

export const SECRET_ACT_CARDS = {
  secret_link: {
    purpose:
      'Gives a person the one Forge link to the field where a secret you need is entered, and a one-time write URL where asked; the value never passes through chat.',
    situations: [
      {
        when: 'you need a secret a person holds: a production or staging variable, a test account, an integration’s key',
        do: 'call support.secret_link { thread, kind, … } naming the slot (presign: true where the value sits in a file) and give its link and command in your reply; you are told by fingerprint when it is filled',
        watch: 'never name a settings screen or write an address yourself, and never ask for the value in chat',
      },
      {
        when: 'a person sends a key, a password or a token in chat, or offers one for you or the master to use',
        do: 'say once that it was not kept and why, and in the same reply give the slot’s link and command, as the note names them; never repeat, use or keep what they sent',
        watch:
          'a deletion its author or a Technical member declines is settled for the thread: never ask it again, and never ask anyone to rotate, change or revoke the key',
      },
    ],
    practice: [
      'Name the slot by kind: variable { environment, key } (null environment: every one), testing { profile, actor | service }, integration { provider }; project where it is another project’s.',
      'A slot the project lacks opens as a new variable; a testing slot or connection it lacks is the master’s to declare (support.ask_master).',
      'Once told it was filled, say it was received and go on: never ask for it twice.',
    ],
    example: {
      thread: '86aGqsokzYezYNdvF',
      kind: 'variable',
      environment: 'production',
      key: 'GOOGLE_CLIENT_SECRET',
      presign: true,
    },
    // ISS-1348: 19/11, epod: a screen named in prose, then a corrected link, then the owner pasted a
    // production secret in chat; ISS-1328: 18/11, Catalog-AdminHub: four refusals of the owner's grant
    redFlag:
      'Directions in prose to a settings screen: on 19/11 the bot named the wrong screen for epod’s production secret, and the owner pasted it in chat.',
    family: 'room.message',
    audience: ['bot'],
    scenarios: [
      'a test key sent, then a declined deletion: one mention and the link',
      'a production variable asked for: the link to that field and a one-time write command',
    ],
  },
} satisfies Readonly<Partial<Record<SupportAction, CapabilityCardBody>>>;
