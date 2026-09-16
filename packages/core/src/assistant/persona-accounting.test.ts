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

const { ASSISTANT_METHOD_GUIDE } = await import('../guides/assistant-method-guide.js');
const { assistantOpening, webDoorLines, webConversationPersona } = await import(
  './door-persona.js'
);
const { rocketChatChannelLines, rocketChatPersona } = await import(
  '../integrations/rocketchat/persona.js'
);

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

const HERE = dirname(fileURLToPath(import.meta.url));
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
  it('accounts for all twenty instructions the Rocket.Chat persona used to carry', () => {
    const fromRocketChat = LEDGER.filter(
      (c) => c.origin === 'moved' || (c.origin === 'kept' && c.owner === 'rocketchatOnly'),
    );
    expect(fromRocketChat).toHaveLength(20);
    expect(LEDGER.filter((c) => c.origin === 'kept' && c.owner === 'rocketchatOnly')).toHaveLength(
      5,
    );
    expect(LEDGER).toHaveLength(33);
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

  it('still tells a door with no origin to link an issue, root-relative', () => {
    const lines = assistantOpening({
      projectName: 'Alpha',
      venue: 'somewhere',
      projectSlug: 'alpha',
    });
    expect(lines.join('\n')).toContain('/projects/alpha/issues/<documentId>');
  });

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
