import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEDGER, type Owner } from './persona-claims.fixture.js';

const { ASSISTANT_METHOD_GUIDE } = await import('../guides/assistant-method-guide.js');
const {
  assistantOpening,
  webAgentConversationPersona,
  webAgentDoorLines,
  webDoorLines,
  webConversationPersona,
} = await import('./door-persona.js');
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
  rocketchatOnly: rocketChatChannelLines('bob', { botName: 'Bao', cut: 'deadline' }).join('\n'),
  webOnly: webDoorLines('alpha', 'Alice').join('\n'),
  webAgentOnly: webAgentDoorLines('Alice').join('\n'),
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
      cut: 'deadline',
    }),
    fragments: ['sharedOpening', 'rocketchatOnly'],
  },
  {
    door: 'web',
    text: webConversationPersona('Alpha', 'alpha', 'Alice'),
    fragments: ['sharedOpening', 'webOnly'],
  },
  {
    door: 'web-agent',
    text: webAgentConversationPersona('Alpha', 'alpha', 'Alice'),
    fragments: ['sharedOpening', 'webAgentOnly'],
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
    // 33 through ISS-1057; ISS-1064 added the tracker's word for a waiting issue (`waiting-issue-is-needs-info`)
    // 34 through ISS-1064; ISS-1039 added Agent mode's own five, which contradict the web door's
    // sentence by sentence and therefore cannot share its rows
    // 39 through ISS-1039; ISS-1086 added the room's mid-conversation line (`mid-conversation-turn`)
    // 40 through ISS-1086; ISS-1087 added the quote-neighbour tool's line (`rocketchat-quote-context`)
    expect(LEDGER).toHaveLength(41);
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
