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
import { LEDGER, type Owner } from './persona-claims.fixture.js';

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
  // cm:guard the TWENTY is the number ISS-1007 named and still the one asserted; the total is
  // thirty-two because ISS-1057 added two claims of its own, neither of them from Rocket.Chat, so
  // the two assertions move independently and a claim vanishing still fails the first (ISS-1057).
  it('accounts for all twenty instructions the Rocket.Chat persona used to carry', () => {
    const fromRocketChat = LEDGER.filter(
      (c) => c.origin === 'moved' || (c.origin === 'kept' && c.owner === 'rocketchatOnly'),
    );
    expect(fromRocketChat).toHaveLength(20);
    expect(LEDGER.filter((c) => c.origin === 'kept' && c.owner === 'rocketchatOnly')).toHaveLength(
      5,
    );
    // 33 through ISS-1057; ISS-1064 added the tracker's word for a waiting issue (`waiting-issue-is-needs-info`)
    expect(LEDGER).toHaveLength(34);
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

  // cm:guard the link line names the read that yields an existing issue's documentId and says the list yields none (ISS-1041, criterion 47): on beta a model given only the shape linked `/issues/351` off a title.
  it("tells the model where an existing issue's documentId comes from, and that the list has none (criterion 47)", () => {
    const text = assistantOpening({
      projectName: 'Alpha',
      venue: 'somewhere',
      projectSlug: 'alpha',
    }).join('\n');
    expect(text).toContain('for an existing issue `forge issue ISS-<n>` prints it');
    expect(text).toContain('the list does not');
  });
});
