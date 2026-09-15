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

// cm:guard every comparison runs over whitespace-FLATTENED text, because a guide body wraps at 100 columns and a persona line does not: matched raw, a clause straddling a wrap would be absent from the very fragment that carries it, and the honest fix for that failure is to shorten the clause until it proves nothing (ISS-1007).
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

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
  /**
   * EVERY material clause of the instruction, verbatim, first one distinctive enough to find in no
   * other fragment. One short marker proves only that a heading survived: measured on this file's
   * own first draft, `ISSUE QUALITY CONTRACT` stayed true with the whole body requirement deleted.
   */
  clauses: readonly [string, ...string[]];
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
    clauses: ['You are the working assistant for project'],
    origin: 'moved',
  },
  // cm:guard this row was ISS-1007's `guide-pointer` — the sentence telling the model to FETCH the method — and ISS-1034 replaced it in place rather than deleting it: the method now renders inline (asserted below by body, not by slug), and the one sentence the opening still owns is the seam between method and channel. The count stays thirty because a row left and a row arrived (ISS-1034).
  {
    id: 'method-then-channel',
    owner: 'sharedOpening',
    clauses: ['The lines below add only what is true of this channel'],
    origin: 'new',
  },
  {
    id: 'issue-web-link',
    owner: 'sharedOpening',
    clauses: ['include its web link', '/issues/<documentId>', '`forge new` echoes the documentId'],
    origin: 'moved',
  },

  {
    id: 'own-the-request',
    owner: 'guide',
    clauses: [
      'You OWN the requests addressed to you',
      'investigate and act with your tools',
      'never hand the task back to the humans',
    ],
    origin: 'moved',
  },
  {
    id: 'lead-with-found',
    owner: 'guide',
    clauses: [
      'LEAD your reply with what you FOUND',
      "the entity's status, the key facts, and any contradiction with what the channel expects",
      'THEN the action you took',
      '"I created an issue" alone does not answer a check request',
    ],
    origin: 'moved',
  },
  {
    id: 'status-gets-figures',
    owner: 'guide',
    clauses: [
      'status is answered with the figures, not with a description of how you would find them',
    ],
    origin: 'hoisted',
  },
  {
    id: 'reporter-owes-nothing',
    owner: 'guide',
    clauses: [
      'reporter owes you nothing',
      'evidence the project side can gather itself',
      'write it into the draft issue as acceptance criteria for a developer',
      'repro steps, account, time window',
      'Never bounce the burden of proof back to the reporter',
    ],
    origin: 'moved',
  },
  {
    id: 'issue-quality-contract',
    owner: 'guide',
    clauses: [
      'ISSUE QUALITY CONTRACT',
      'an issue must stand alone',
      'Title = kind + affected feature',
      'what happens, where, expected vs actual',
      'Write the body as markdown with',
      'refuses a filing that is missing one, NAMING the heading',
    ],
    origin: 'moved',
  },
  // cm:guard the four rows below are ISS-1009's and `new`: the tracker moved from two wrapper tools to the `forge` CLI while this ledger was being written, and its method rides the same guide so both doors read it — a Rocket.Chat-only copy would leave the web door filing by hand (ISS-1009).
  {
    id: 'tracker-is-forge',
    owner: 'guide',
    clauses: [
      'THE TRACKER IS THE `forge` TOOL',
      '`forge -h`, then `forge <verb> -h`',
      'NEVER guess a flag or a verb',
    ],
    origin: 'new',
  },
  {
    id: 'file-with-forge-new',
    owner: 'guide',
    clauses: [
      'FILE WITH `forge new`, NOT BY HAND',
      'folds this onto a near neighbour',
      'offer `--new`',
      '--relates ISS-<near>',
    ],
    origin: 'new',
  },
  {
    id: 'ask-only-reporter-knows',
    owner: 'guide',
    clauses: [
      'ASK ONLY FOR WHAT ONLY THE REPORTER KNOWS',
      'write it yourself',
      'Always write `## Where`',
    ],
    origin: 'new',
  },
  {
    id: 'never-claim-unread-write',
    owner: 'guide',
    clauses: [
      'NEVER SAY A WRITE LANDED THAT YOU DID NOT READ BACK',
      'do not describe the state you intended',
    ],
    origin: 'new',
  },
  {
    id: 'urls-carry-ids',
    owner: 'guide',
    clauses: [
      'URLs in the context carry ids',
      'extract the id from the URL and query the external system',
      'BY ID before trying any keyword search',
    ],
    origin: 'moved',
  },
  {
    id: 'investigate-first',
    owner: 'guide',
    clauses: [
      'INVESTIGATE before answering',
      'SHORT keyword fragments (2-4 words)',
      'retry with different fragments if empty',
      'Cross-check forge_memory.search and forge_knowledge',
      'read issue comments when a discussion references one',
    ],
    origin: 'moved',
  },
  {
    id: 'introspect-external-schema',
    owner: 'guide',
    clauses: [
      'before claiming it cannot help',
      'the external schema tool',
      'to learn the available queries and filters',
      'NEVER claim "the tools cannot do this" or ask the user for an ID',
      'Schemas often expose',
      'they need NO user id',
    ],
    origin: 'moved',
  },
  {
    id: 'act-not-delegate',
    owner: 'guide',
    clauses: [
      'ACT, do not delegate',
      'it always enters as',
      'Only mention a person when the action truly requires',
      'state exactly what remains and why',
    ],
    origin: 'moved',
  },
  {
    id: 'never-bounce-back',
    owner: 'guide',
    clauses: [
      'Never reply with only "ask X to do Y"',
      'if a tool call could find the answer or capture the work as a draft issue',
    ],
    origin: 'moved',
  },
  {
    id: 'never-announce',
    owner: 'guide',
    clauses: [
      'Never announce what you are about to do',
      'CALL the tool now instead',
      'reply only when you have the result, or a concrete failure to report',
    ],
    origin: 'moved',
  },
  {
    id: 'broad-request-overview',
    owner: 'guide',
    clauses: [
      'For a broad request',
      'do not just ask what to check',
      'produce a brief status overview from the tools',
      'then offer to drill into specifics',
    ],
    origin: 'moved',
  },
  {
    id: 'answer-concisely',
    owner: 'guide',
    clauses: [
      'Answer concisely, in the language the person wrote in',
      'a reply that restates the question back is longer and worth less',
    ],
    origin: 'moved',
  },

  {
    id: 'bot-name',
    owner: 'rocketchatOnly',
    clauses: ['Your name in this channel is', 'Refer to yourself as', 'or "the system"'],
    origin: 'kept',
  },
  {
    id: 'pronoun-mapping',
    owner: 'rocketchatOnly',
    clauses: [
      'use that username when filtering',
      'The message you are answering was sent by user @',
    ],
    origin: 'kept',
  },
  {
    id: 'rocketchat-history',
    owner: 'rocketchatOnly',
    clauses: [
      'call rocketchat_history before concluding',
      'Read the conversation context first',
      'if it references older discussion',
    ],
    origin: 'kept',
  },
  {
    id: 'one-reply-only',
    owner: 'rocketchatOnly',
    clauses: [
      'the ONLY message the user receives',
      'there is no follow-up turn',
      'do not promise a later one',
    ],
    origin: 'kept',
  },
  {
    id: 'plain-text',
    owner: 'rocketchatOnly',
    clauses: ['Plain chat text, no markdown headers'],
    origin: 'kept',
  },

  {
    id: 'reply-in-vietnamese',
    owner: 'personaStyle',
    clauses: ['Reply in Vietnamese', 'switch language only if the user clearly writes another one'],
    origin: 'moved',
  },

  {
    id: 'web-asked-by',
    owner: 'webOnly',
    clauses: ['- You are answering '],
    origin: 'kept',
  },
  {
    id: 'web-no-checkout',
    owner: 'webOnly',
    clauses: [
      'no checkout of the repository and no shell',
      'say so plainly when you are asked about a file',
    ],
    origin: 'kept',
  },
  {
    id: 'web-agents-screen',
    owner: 'webOnly',
    clauses: [
      'that needs a session on a paired box',
      'You CANNOT edit a file, run a command or drive a pipeline',
      '/agents. Say so, and name that screen',
    ],
    origin: 'kept',
  },
  {
    id: 'web-multi-turn',
    owner: 'webOnly',
    clauses: [
      'Markdown renders here, and the person can reply',
      'a follow-up question is available to you when one is genuinely needed',
    ],
    origin: 'new',
  },
];

const OPENING = {
  projectName: 'Alpha',
  projectSlug: 'alpha',
  webBaseUrl: 'https://forge.example.co',
};

const GUIDE_BODY = ASSISTANT_METHOD_GUIDE.body.trim();
/** The opening with the guide body it renders inline taken back out: what the opening itself owns. */
// cm:guard the shared-opening fragment is the opening MINUS the guide body, so that "no claim in any fragment but its owner" still bites: the opening renders the guide whole since ISS-1034, and comparing the raw opening would report every guide clause as leaked into it — or be weakened until it caught nothing (ISS-1034).
const withoutGuide = (text: string): string => text.replace(GUIDE_BODY, '');
const FRAGMENTS: Record<Owner, string> = {
  guide: ASSISTANT_METHOD_GUIDE.body,
  sharedOpening: withoutGuide(assistantOpening({ ...OPENING, venue: 'somewhere' }).join('\n')),
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
    expect(LEDGER).toHaveLength(30);
  });

  it('gives each claim exactly one owner', () => {
    const byId = new Map<string, Owner>();
    for (const claim of LEDGER) {
      expect(byId.has(claim.id), claim.id).toBe(false);
      byId.set(claim.id, claim.owner);
    }
  });

  it('finds every clause of every claim present, verbatim, in the fragment that owns it', () => {
    for (const claim of LEDGER) {
      for (const clause of claim.clauses) {
        expect(flat(FRAGMENTS[claim.owner]), `${claim.id} -> ${claim.owner}: ${clause}`).toContain(
          flat(clause),
        );
      }
    }
  });

  // cm:guard this is the assertion that makes "the guide is the only copy" a fact rather than a wish, and it is over FRAGMENTS rather than rendered personas on purpose: the shared opening renders into both doors legitimately, and comparing rendered text would either fail on that or be weakened until it caught nothing (ISS-1007).
  it('finds no claim in any fragment but its owner', () => {
    for (const claim of LEDGER) {
      for (const [owner, text] of Object.entries(FRAGMENTS) as Array<[Owner, string]>) {
        if (owner === claim.owner) continue;
        for (const clause of claim.clauses) {
          expect(flat(text), `${claim.id} leaked "${clause}" into ${owner}`).not.toContain(
            flat(clause),
          );
        }
      }
    }
  });

  // cm:guard an instruction line nobody accounted for fails here, which is the other half of the drop check: the ledger proves what left is somewhere, and this proves nothing arrived unrecorded (ISS-1007).
  it('accounts for every instruction line both doors render', () => {
    for (const { door, text, fragments } of RENDERED) {
      const claims = LEDGER.filter((c) => fragments.includes(c.owner));
      expect(text, `${door} renders the method body whole`).toContain(GUIDE_BODY);
      for (const line of withoutGuide(text).split('\n')) {
        if (line.trim() === '') continue;
        expect(
          claims.some((c) => c.clauses.some((clause) => flat(line).includes(flat(clause)))),
          `${door} renders a line no ledger entry claims: ${line}`,
        ).toBe(true);
      }
    }
  });
});

describe('what each door says, read off the real text', () => {
  // cm:guard the method is asserted PRESENT by body and the fetch instruction ABSENT, at both doors: ISS-1007 pointed each door at the guide by slug and every turn paid a `forge_guide get` round before it could answer; ISS-1034 renders the body in the opening instead, and a door that both carried the body and still said to fetch it would pay the round for nothing (ISS-1034 criteria 6, 7).
  it('carries the method body in the Rocket.Chat room and tells it to fetch nothing', () => {
    const persona = rocketChatPersona('Alpha', 'bob', { botName: 'Bao' });
    expect(persona).toContain(GUIDE_BODY);
    expect(persona).not.toContain('forge_guide get');
    expect(persona).not.toContain('BEFORE you answer');
  });

  it('carries the same body in the Forge web app and tells it to fetch nothing', () => {
    const persona = webConversationPersona('Alpha', 'alpha', 'Alice');
    expect(persona).toContain(GUIDE_BODY);
    expect(persona).not.toContain('forge_guide get');
    expect(persona).not.toContain('BEFORE you answer');
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

  it('omits the issue-link line when the door knows no project slug', () => {
    const lines = assistantOpening({ projectName: 'Alpha', venue: 'somewhere' });
    expect(lines.join('\n')).not.toContain('include its web link');
  });

  // cm:guard the SLUG alone gates the line and an absent origin yields a root-relative path, asserted here because the regression is invisible in the other direction: a condition reading `webBaseUrl && projectSlug` leaves both web doors, which pass no origin, silently never told to link an issue at all, and every other case in this file passes an origin (ISS-1007, codex F3).
  it('still tells a door with no origin to link an issue, root-relative', () => {
    const lines = assistantOpening({
      projectName: 'Alpha',
      venue: 'somewhere',
      projectSlug: 'alpha',
    });
    expect(lines.join('\n')).toContain('/projects/alpha/issues/<documentId>');
  });
});
