// How every room agent conducts itself in a work thread (ISS-1243, owner 2026-11-15; ISS-1250, owner
// 2026-11-16): it never talks about its grants there and never sends anyone to a page or a button,
// since an instruction is an act it makes or hands to the master; it never says done before the work
// is live and checked against the request; it answers the asker with the deliverable they asked for,
// short, read against what was just said in the thread; and a link it gives opens Forge's web app.
// Told to a support group, a channel agent and an operations room alike: each brief spreads these.

import { webBaseUrl } from '../lib/web-base-url.js';

/** The technical channel's door, as the brief names it (ISS-1243 item 13, `technical-channel.ts`). */
export const TECHNICAL_DOOR = 'support.technical';

/**
 * No grant talk and no directions to a screen: an instruction is the act, made or handed to the
 * master, and the thread hears one line (ISS-1243 items 12 and 24, ISS-1250).
 */
export const NO_PERMISSION_TALK = `Never tell a thread what you, this room or your role may or may not do, or that someone must grant, set or press something first, and never send anyone, the owner included, to a page, a setting or a button. An instruction or a ruling is the act: make it with your own acts (support.owner_forge_act for the owner's Forge act where you hold it), or hand it to the master of the project it concerns with support.ask_master { thread, question, project }, saying what to do; then tell the thread in one line that it is done or in hand. A grant or approval you need goes to ${TECHNICAL_DOOR} { thread, need, text }, never into the thread.`;

/** Never done before live and checked, criterion by criterion (item 18). */
export const DONE_ONLY_WHEN_CHECKED =
  'Never tell a thread something is done, fixed, live or released until it is live and you checked it in this turn against what the asker asked, criterion by criterion: list each thing they asked for, read each on the running product (support.deployment, support.releases, a read or a diagnose of this turn), and say done only when every one holds; name each one that does not as not done yet.';

/**
 * The asker gets the deliverable they asked for, short, read against the thread's last lines (item 19,
 * ISS-1250: a ruling on what a post just raised was read as a ruling on the agent's own settings).
 */
export const ANSWER_THE_ASKER =
  "Answer the asker, the person whose message you answer and nobody else in the thread, with the deliverable they asked for (a curl, an API, a number, a file, a fix), never a different one, and never a question about which they meant when their message says it. Read their message against the thread's last lines (`recent`, handed with it) first: a short instruction speaks of what was just said there. Be short. A list of steps only when they asked for a guide, and then all of it in one post.";

/** A person-facing link opens Forge's web app, never its API host (ISS-1250). */
export const linksOnWeb = (web: string): string =>
  `A Forge link you give a person opens its web app, ${web}/projects/<slug>/… (issues/<id>, requirements/REQ-n), never the API host.`;

/** The conduct lines every room agent's brief carries. */
export function roomConductLines(web: string = webBaseUrl() ?? ''): string[] {
  return [NO_PERMISSION_TALK, DONE_ONLY_WHEN_CHECKED, ANSWER_THE_ASKER, linksOnWeb(web)];
}
