// How every room agent conducts itself in a work thread (ISS-1243, owner 2026-11-15; ISS-1250 and
// ISS-1251, owner 2026-11-16), as the brief's map: one line per situation, naming its door. Who is
// asking and the thread around their message are read before acting (`asker`); an instruction is an
// act made or handed to a master, never grant talk or directions to a screen; done is said only once
// live and checked; a Forge link opens the web app; each reply is audited after it is posted; and the
// detail behind each line is the room agent's guide (`support.guide`). These teach; none blocks a
// reply. Told to a support group, a channel agent and an operations room alike.

import { webBaseUrl } from '../lib/web-base-url.js';
import { AUDIT_BRIEF_LINE } from './reply-audit/teach.js';

/** The technical channel's door, as the brief names it (ISS-1243 item 13, `technical-channel.ts`). */
export const TECHNICAL_DOOR = 'support.technical';

/** Who is asking, the thread around their message, and the depth of the answer (item 19, ISS-1250). */
export const ANSWER_THE_ASKER =
  "When a message comes to you: read who wrote it and the thread around it with support.asker { thread, message } before you act on it (a short ruling speaks of what was just said there), keep their roles with support.member where the record holds none, and answer them, nobody else, with the deliverable they asked for, short, at their `reader`'s depth: to the owner, the decision or result first and no internals; to a team member, the detail; to a user, plain words.";

/** An instruction is the act; no grant talk, no screen directions; a refusal is a problem (items 12, 24). */
export const NO_PERMISSION_TALK = `When someone instructs or rules: make the act with your own acts, or hand it to the master of the project it concerns with support.ask_master { thread, question, project }, and tell the thread in one line that it is done or in hand. Never tell a thread what you or this room may not do, and never send anyone, the owner included, to a page, a setting or a button. A refusal from Forge is a problem to solve through another door or the master, never a line to repeat; a grant you need goes to ${TECHNICAL_DOOR} { thread, need, text }.`;

/** Never done before live and checked, criterion by criterion (item 18). */
export const DONE_ONLY_WHEN_CHECKED =
  'When you would say done, fixed, live or released: only once it is live and you checked each thing asked on the running product in this turn (support.deployment, support.releases, a read or a diagnose); name each one not done yet.';

/** A person-facing link opens Forge's web app, never its API host (ISS-1250). */
export const linksOnWeb = (web: string): string =>
  `When you give a Forge link: it opens the web app, ${web}/projects/<slug>/… (issues/<id>, requirements/REQ-n), never the API host.`;

/** Where the detail behind each line is (ISS-1251). */
export const READ_THE_GUIDE =
  "When a situation needs more than its line: read this room's guide with support.guide {}, by situation.";

/**
 * One line of a room brief's map (ISS-1251, prompt-is-a-map): the door it reaches for, the situation
 * that calls for it, and the line the brief carries. Kept as data so the brief's map can be rendered
 * from another source (ISS-1251's capability cards) without rewriting the brief.
 */
export interface MapLine {
  door: string;
  situation: string;
  line: string;
}

/** The map lines every room agent's brief carries, whatever its room's kind. */
export function roomMap(web: string = webBaseUrl() ?? ''): readonly MapLine[] {
  return [
    { door: 'support.asker', situation: 'a message comes to you', line: ANSWER_THE_ASKER },
    {
      door: 'support.ask_master',
      situation: 'someone instructs or rules',
      line: NO_PERMISSION_TALK,
    },
    {
      door: 'support.releases',
      situation: 'you would say done or live',
      line: DONE_ONLY_WHEN_CHECKED,
    },
    { door: 'web links', situation: 'you give a Forge link', line: linksOnWeb(web) },
    { door: 'support.audit', situation: 'you posted a reply', line: AUDIT_BRIEF_LINE },
    { door: 'support.guide', situation: 'a line is not enough', line: READ_THE_GUIDE },
  ];
}

/** The conduct lines every room agent's brief carries: its map's lines, in order. */
export function roomConductLines(web: string = webBaseUrl() ?? ''): string[] {
  return roomMap(web).map((m) => m.line);
}
