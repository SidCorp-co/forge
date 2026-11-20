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
        do: 'call support.secret_link { thread, why, kind, …, shape? } naming the slot, why you need it and its shape (presign: true where the value sits in a file), and give its link and command in your reply; you are told by fingerprint when it is filled',
        watch:
          'never name a settings screen or write an address yourself, and never ask for the value in chat',
      },
      {
        when: 'a person sends a key, a password or a token in chat, or offers one for you or the master to use',
        do: 'Forge kept it in the project’s vault before recording the message; say once, in the same reply, what the note names: the entry’s name, its project, who can use it and the page where it is revoked or replaced',
        watch:
          'ask nobody to delete the message or to rotate, change or revoke the key: they chose to send it, and the message is theirs; never repeat what it held',
      },
    ],
    practice: [
      'Name the slot by kind: variable { environment, key } (null environment: every one), testing { profile, actor | service }, integration { provider }; project where it is another project’s.',
      'Say why in plain words and the shape: value, file, mailbox, signin or { fields }; the person fills labelled boxes, never JSON, and reads why above them.',
      'A variable the project lacks is asked as a new one; a testing slot or connection it lacks is the master’s to declare (support.ask_master). Once told it was filled, say so and go on.',
    ],
    example: {
      thread: '86aGqsokzYezYNdvF',
      kind: 'variable',
      environment: 'production',
      key: 'GOOGLE_CLIENT_SECRET',
      why: 'Driver sign-in with Google needs it before the release',
      example: 'GOCSPX-…',
      presign: true,
    },
    // ISS-1348: 19/11, epod: a screen named in prose, then a corrected link, then the owner pasted a
    // production secret in chat; ISS-1328: 18/11, Catalog-AdminHub: four refusals of the owner's grant
    redFlag:
      'Directions in prose to a settings screen: on 19/11 the bot named the wrong screen for epod’s production secret, and the owner pasted it in chat.',
    family: 'room.message',
    audience: ['bot'],
    scenarios: [
      'a credential handed over in chat: kept, named once, nothing asked of its sender',
      'a production variable asked for: the link to that field and a one-time write command',
    ],
  },
} satisfies Readonly<Partial<Record<SupportAction, CapabilityCardBody>>>;
