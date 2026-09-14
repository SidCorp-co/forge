/**
 * Where every instruction the Rocket.Chat persona used to carry lives now.
 *
 * ISS-1007's rule is that no bullet is dropped in the move and that the guide is
 * the ONLY copy of any sentence it carries. Neither is provable by reading what
 * remains in one persona: a claim can vanish, or be copied into a second
 * fragment, and a test that only looked at Rocket.Chat would pass through both.
 *
 * So the ledger below names every claim and its one owning FRAGMENT, and three
 * assertions bite on it — present in its owner, absent from every other
 * fragment, and every rendered persona line claimed by some entry. Ownership is
 * of the fragment and not of the rendered persona, which is what lets the shared
 * opening appear in two personas without being a duplicate.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// cm:guard nothing is mocked in this file, and that is the point: every fragment below is the real exported text, so a ledger entry is checked against what a door actually renders rather than against a fixture (ISS-1007).
const { ASSISTANT_METHOD_GUIDE } = await import('../guides/assistant-method-guide.js');
const { assistantOpening, webDoorLines, webConversationPersona } = await import(
  './door-persona.js'
);
const { rocketChatChannelLines, rocketChatPersona } = await import(
  '../integrations/rocketchat/persona.js'
);

const HERE = dirname(fileURLToPath(import.meta.url));
// cm:guard the personaStyle fragment is read off the shipped MIGRATION rather than from a constant a test could drift from: that file is the only thing that puts the sentence in front of a live project, so a ledger entry claiming `personaStyle` owns it has to be checked against the statement that actually writes it (ISS-1007).
const MIGRATION_SQL = readFileSync(
  join(HERE, '../../drizzle/migrations/0246_persona_style_backfill.sql'),
  'utf8',
);

type Owner = 'guide' | 'sharedOpening' | 'rocketchatOnly' | 'webOnly' | 'personaStyle';

interface Claim {
  /** What the claim is, for a reader of a failure message. */
  id: string;
  owner: Owner;
  /** A verbatim slice of the owning fragment, distinctive enough to find nowhere else. */
  text: string;
  /**
   * `moved` — carried by the pre-change `rocketChatPersona` and now in another fragment.
   * `kept` — in the fragment it was already in.
   * `hoisted` — was `webConversationPersona`'s own wording and is now the guide's one copy.
   * `new` — written by ISS-1007 and carried by nothing before it.
   */
  origin: 'moved' | 'kept' | 'hoisted' | 'new';
}

// cm:guard this is the accounting the issue demands and it is FROZEN: every instruction the pre-change `rocketChatPersona` carried has a row, each naming exactly one owner. Deleting a row to make a failing test pass is deleting the record that the claim landed anywhere at all, which is the shape of the drop this ledger exists to catch (ISS-1007).
const LEDGER: readonly Claim[] = [
  {
    id: 'identity',
    owner: 'sharedOpening',
    text: 'You are the working assistant for project',
    origin: 'moved',
  },
  {
    id: 'guide-pointer',
    owner: 'sharedOpening',
    text: 'Your method is a guide, not a memo',
    origin: 'new',
  },
  { id: 'issue-web-link', owner: 'sharedOpening', text: 'include its web link', origin: 'moved' },

  {
    id: 'own-the-request',
    owner: 'guide',
    text: 'You OWN the requests addressed to you',
    origin: 'moved',
  },
  {
    id: 'lead-with-found',
    owner: 'guide',
    text: 'LEAD your reply with what you FOUND',
    origin: 'moved',
  },
  {
    id: 'status-gets-figures',
    owner: 'guide',
    text: 'status is answered with the figures',
    origin: 'hoisted',
  },
  {
    id: 'reporter-owes-nothing',
    owner: 'guide',
    text: 'reporter owes you nothing',
    origin: 'moved',
  },
  { id: 'issue-quality-contract', owner: 'guide', text: 'ISSUE QUALITY CONTRACT', origin: 'moved' },
  { id: 'urls-carry-ids', owner: 'guide', text: 'URLs in the context carry ids', origin: 'moved' },
  {
    id: 'investigate-first',
    owner: 'guide',
    text: 'INVESTIGATE before answering',
    origin: 'moved',
  },
  {
    id: 'introspect-external-schema',
    owner: 'guide',
    text: 'before claiming it cannot help',
    origin: 'moved',
  },
  { id: 'act-not-delegate', owner: 'guide', text: 'ACT, do not delegate', origin: 'moved' },
  {
    id: 'never-bounce-back',
    owner: 'guide',
    text: 'Never reply with only "ask X to do Y"',
    origin: 'moved',
  },
  {
    id: 'never-announce',
    owner: 'guide',
    text: 'Never announce what you are about to do',
    origin: 'moved',
  },
  { id: 'broad-request-overview', owner: 'guide', text: 'For a broad request', origin: 'moved' },
  {
    id: 'answer-concisely',
    owner: 'guide',
    text: 'Answer concisely, in the language the person wrote in',
    origin: 'moved',
  },

  { id: 'bot-name', owner: 'rocketchatOnly', text: 'Your name in this channel is', origin: 'kept' },
  {
    id: 'pronoun-mapping',
    owner: 'rocketchatOnly',
    text: 'use that username when filtering',
    origin: 'kept',
  },
  {
    id: 'rocketchat-history',
    owner: 'rocketchatOnly',
    text: 'call rocketchat_history before concluding',
    origin: 'kept',
  },
  {
    id: 'one-reply-only',
    owner: 'rocketchatOnly',
    text: 'the ONLY message the user receives',
    origin: 'kept',
  },
  {
    id: 'plain-text',
    owner: 'rocketchatOnly',
    text: 'Plain chat text, no markdown headers',
    origin: 'kept',
  },

  {
    id: 'reply-in-vietnamese',
    owner: 'personaStyle',
    text: 'Reply in Vietnamese',
    origin: 'moved',
  },

  { id: 'web-asked-by', owner: 'webOnly', text: '- You are answering ', origin: 'kept' },
  {
    id: 'web-no-checkout',
    owner: 'webOnly',
    text: 'no checkout of the repository and no shell',
    origin: 'kept',
  },
  {
    id: 'web-agents-screen',
    owner: 'webOnly',
    text: 'that needs a session on a paired box',
    origin: 'kept',
  },
  {
    id: 'web-multi-turn',
    owner: 'webOnly',
    text: 'Markdown renders here, and the person can reply',
    origin: 'new',
  },
];

const OPENING = {
  projectName: 'Alpha',
  projectSlug: 'alpha',
  webBaseUrl: 'https://forge.example.co',
};

const FRAGMENTS: Record<Owner, string> = {
  guide: ASSISTANT_METHOD_GUIDE.body,
  sharedOpening: assistantOpening({ ...OPENING, venue: 'somewhere' }).join('\n'),
  rocketchatOnly: rocketChatChannelLines('bob', { botName: 'Bao' }).join('\n'),
  webOnly: webDoorLines('alpha', 'Alice').join('\n'),
  personaStyle: MIGRATION_SQL,
};

/** Both doors, with every optional branch rendered, which is the widest text either can produce. */
const RENDERED: Array<{ door: string; text: string; fragments: Owner[] }> = [
  {
    door: 'rocketchat',
    text: rocketChatPersona('Alpha', 'bob', {
      projectSlug: 'alpha',
      webBaseUrl: 'https://forge.example.co',
      botName: 'Bao',
    }),
    fragments: ['sharedOpening', 'rocketchatOnly'],
  },
  {
    door: 'web',
    text: webConversationPersona('Alpha', 'alpha', 'Alice'),
    fragments: ['sharedOpening', 'webOnly'],
  },
];

describe('the persona claim ledger', () => {
  // cm:guard TWENTY is the number the issue names and the one this asserts: every instruction the pre-change `rocketChatPersona` carried is either `moved` to another fragment or `kept` in the Rocket.Chat one, and the count going down is a claim that left without arriving anywhere (ISS-1007).
  it('accounts for all twenty instructions the Rocket.Chat persona used to carry', () => {
    const fromRocketChat = LEDGER.filter(
      (c) => c.origin === 'moved' || (c.origin === 'kept' && c.owner === 'rocketchatOnly'),
    );
    expect(fromRocketChat).toHaveLength(20);
    expect(LEDGER.filter((c) => c.origin === 'kept' && c.owner === 'rocketchatOnly')).toHaveLength(
      5,
    );
    expect(LEDGER).toHaveLength(26);
  });

  it('gives each claim exactly one owner', () => {
    const byId = new Map<string, Owner>();
    for (const claim of LEDGER) {
      expect(byId.has(claim.id), claim.id).toBe(false);
      byId.set(claim.id, claim.owner);
    }
  });

  it('finds every claim present, verbatim, in the fragment that owns it', () => {
    for (const claim of LEDGER) {
      expect(FRAGMENTS[claim.owner], `${claim.id} -> ${claim.owner}`).toContain(claim.text);
    }
  });

  // cm:guard this is the assertion that makes "the guide is the only copy" a fact rather than a wish, and it is over FRAGMENTS rather than rendered personas on purpose: the shared opening renders into both doors legitimately, and comparing rendered text would either fail on that or be weakened until it caught nothing (ISS-1007).
  it('finds no claim in any fragment but its owner', () => {
    for (const claim of LEDGER) {
      for (const [owner, text] of Object.entries(FRAGMENTS) as Array<[Owner, string]>) {
        if (owner === claim.owner) continue;
        expect(text, `${claim.id} leaked into ${owner}`).not.toContain(claim.text);
      }
    }
  });

  // cm:guard an instruction line nobody accounted for fails here, which is the other half of the drop check: the ledger proves what left is somewhere, and this proves nothing arrived unrecorded (ISS-1007).
  it('accounts for every instruction line both doors render', () => {
    for (const { door, text, fragments } of RENDERED) {
      const claims = LEDGER.filter((c) => fragments.includes(c.owner));
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        expect(
          claims.some((c) => line.includes(c.text)),
          `${door} renders a line no ledger entry claims: ${line}`,
        ).toBe(true);
      }
    }
  });
});

describe('what each door says, read off the real text', () => {
  it('points the Rocket.Chat room at the guide by its slug', () => {
    expect(rocketChatPersona('Alpha', 'bob', { botName: 'Bao' })).toContain(
      ASSISTANT_METHOD_GUIDE.slug,
    );
  });

  it('points the Forge web app at the same slug', () => {
    expect(webConversationPersona('Alpha', 'alpha', 'Alice')).toContain(
      ASSISTANT_METHOD_GUIDE.slug,
    );
  });

  // cm:guard the Vietnamese instruction is asserted ABSENT from the rendered persona rather than merely moved in the ledger, because this is the sentence `confab.ts` reads the door's language off and the one the migration has to have carried: a persona that still hardcodes it means every project gets it whatever its style says (ISS-1007).
  it('no longer hardcodes a language into a Rocket.Chat reply', () => {
    const persona = rocketChatPersona('Alpha', 'bob', { botName: 'Bao' });
    expect(persona).not.toContain('Vietnamese');
  });

  it('keeps the one-reply rule in the room and out of the web app', () => {
    expect(rocketChatPersona('Alpha', 'bob')).toContain('the ONLY message the user receives');
    expect(webConversationPersona('Alpha', 'alpha', null)).not.toContain(
      'the ONLY message the user receives',
    );
  });

  it('renders no optional Rocket.Chat line when the bot has no name and nobody is named', () => {
    const persona = rocketChatPersona('Alpha');
    expect(persona).not.toContain('Your name in this channel is');
    expect(persona).not.toContain('use that username when filtering');
    expect(persona).toContain('call rocketchat_history before concluding');
  });

  it('omits the issue-link line when no web origin is available', () => {
    const lines = assistantOpening({ projectName: 'Alpha', venue: 'somewhere' });
    expect(lines.join('\n')).not.toContain('include its web link');
  });
});
