// The scenarios of the product doors a person's assistant works through (the bot thread, mockups,
// decisions, questions and answers), of the module map a master, a run and a person read, and of the
// reference sources a project learns from (`product-door/`, `mcp/requirements-tool.cards.ts`,
// `labels/cards.ts`, `@forge/contracts/references`). Forge recorded no call of these in the 90 days
// to 2026-11-17 (GET /api/projects/forge/metrics/doors). So each is the situation the record that
// built the door names, with the good use its card teaches; none carries a bad use no one recorded.

import type { CardScenario } from '../lessons/index.js';

const NONE = 'forge door use, 2026-08-19..11-17: no call';
const BOT = 'REQ-91 (a person’s assistant asks the Forge bot)';
const MAP = 'ISS-609 (the module map), ISS-1256 (its doors)';
const REFS = 'ISS-1252 (reference sources a project learns from)';

export const PERSON_SCENARIOS: readonly CardScenario[] = [
  {
    name: 'a bot turn still processing followed with read, never sent again',
    card: 'bot.read',
    source: `${BOT}; ${NONE}`,
    situation: 'A send to the bot answered processing: true and the person asks if it answered',
    good: 'read with the turn id and the cursor the send gave; reading starts no turn',
    teaches: [
      /read with the turn id and the cursor the send gave/i,
      /reading never starts a turn/i,
    ],
  },
  {
    name: 'a bot turn working on a changed ask cancelled, then the new ask sent',
    card: 'bot.cancel',
    source: `${BOT}; ${NONE}`,
    situation: 'A person changed their ask while the bot’s turn was still running on the old one',
    good: 'cancel the turn, send the corrected ask, and read what it already wrote',
    teaches: [/send the corrected ask as a new message/i, /read the thread for what it did/i],
  },
  {
    name: 'a mockup accepted once the person tried it and agreed',
    card: 'design.mockup_accept',
    source: `ISS-78 (mockups kept on the item they shape); ${NONE}`,
    situation: 'A person tried the proposed checkout mockup and says it is right',
    good: 'accept it with their reason; never one they have not tried',
    teaches: [/accept it with their reason/i, /Accepting a mockup the person has not tried/i],
  },
  {
    name: 'a requirement’s mockups listed before another is proposed',
    card: 'design.mockup_list',
    source: `the mockup doors (product-door/design-tool.mockup-cards.ts); ${NONE}`,
    situation: 'An assistant is about to propose a mockup on a requirement',
    good: 'list first: a returned one is answered by its next revision',
    teaches: [/a returned one is answered by its next revision/i],
  },
  {
    name: 'a person asking why something was decided answered from the record',
    card: 'project.decisions',
    source: `ISS-1183, REQ-78 BC-8 (the product role’s doors); ${NONE}`,
    situation: 'A person asks why the release cadence was changed and who decided it',
    good: 'read decisions over those days and quote the reason recorded',
    teaches: [/quote the reason recorded/i, /never decide it twice/i],
  },
  {
    name: 'a person’s question on an issue raised for the agent building it',
    card: 'questions.ask',
    source: `the questions door (product-door/questions-tool.ts); ${NONE}`,
    situation: 'A person following an issue wants to ask its builder whether it changes the export',
    good: 'ask on the issue in their words; a doubt about what is wanted goes to the requirement',
    teaches: [
      /ask on the issue in their words/i,
      /a doubt about what is wanted goes to the requirement/i,
    ],
  },
  {
    name: 'a requirement’s open question answered in the person’s words',
    card: 'requirements.answer',
    source: `the requirements door’s answer (mcp/requirements-tool.cards.ts); ${NONE}`,
    situation: 'The person answered a question get lists on their requirement',
    good: 'answer it with their option or words, naming the question and its round',
    teaches: [/naming the question and its round/i, /the answer is theirs/i],
  },
  {
    name: 'a module’s tree read before work starts in it',
    card: 'module.get',
    source: `${MAP}; ${NONE}`,
    situation: 'A run takes an issue placed in the Delivery module',
    good: 'read its tree first: its terms, rules and the doors already built',
    teaches: [/read its tree first with `module\.get <slug>`/i],
  },
  {
    name: 'the module map read in rows before placing a record',
    card: 'module.pillar',
    source: `${MAP}; ${NONE}`,
    situation: 'A master needs which modules exist before placing an unplaced requirement',
    good: 'read pillar, then module.get the module the work sits in',
    teaches: [/read pillar, then module\.get the module your work sits in/i],
  },
  {
    name: 'a wrong relation removed by its id and the right one written',
    card: 'module.unrelate',
    source: `${MAP}; ${NONE}`,
    situation: 'A relation in the tree ties a rule to a file that no longer exists',
    good: 'remove it by the id the tree shows, then write the right one',
    teaches: [/remove it by the id the tree shows, then write the right one/i],
  },
  {
    name: 'a project’s reference sources read before researching from zero',
    card: 'POST /api/projects/:id/reference-sources/:source/citations',
    source: `${REFS}; ${NONE}`,
    situation: 'A run meets a design question this repository has no settled answer for',
    good: 'read the reference sources by area first, then cite what it used',
    teaches: [/read the project's reference sources first/i, /cite what you used/i],
  },
  {
    name: 'a source the owner changed, updated with his areas and why',
    card: 'references.update',
    source: `${REFS}; ${NONE}`,
    situation: 'The owner says a followed repo now teaches worktrees too',
    good: 'update the source with its areas and why as they now stand, in his words',
    teaches: [/with its areas and why as they now stand/i],
  },
  {
    name: 'a flagged source removed only on the owner’s decision',
    card: 'references.remove',
    source: `${REFS}; ${NONE}`,
    situation: 'Signals flag a source archived upstream',
    good: 'put it to the owner; remove it with his reason once he decides',
    teaches: [/before a person decided keep, replace or remove/i],
  },
  {
    name: 'each flagged source put to the owner with its citations',
    card: 'references.signals',
    source: `${REFS}; ${NONE}`,
    situation: 'An audit asks which sources still earn their place',
    good: 'read signals and put each flagged source to the owner with its flag and citations',
    teaches: [/put each flagged source to him with its flag and its citations/i],
  },
  {
    name: 'a followed source’s release opened before it is cited',
    card: 'references.timeline',
    source: `${REFS}; ${NONE}`,
    situation: 'A run works an item a followed source’s new release may help',
    good: 'read the timeline, open the release, and cite it with take or reject',
    teaches: [/open the release, and cite it with take or reject/i],
  },
];
