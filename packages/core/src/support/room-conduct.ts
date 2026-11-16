// How every room agent conducts itself in a work thread (ISS-1243, owner 2026-11-15; ISS-1250, owner
// 2026-11-16): it never talks about its grants there and never sends anyone to a page or a button,
// since an instruction is an act it makes or hands to the master; it never says done before the work
// is live and checked against the request; it answers the asker with the deliverable they asked for,
// short, read against who they are and what was just said in the thread (`asker`); and a link it
// gives opens Forge's web app. These teach; nothing here blocks a reply (owner 2026-11-16).
// Told to a support group, a channel agent and an operations room alike: each brief spreads these.

import { webBaseUrl } from '../lib/web-base-url.js';

/** The technical channel's door, as the brief names it (ISS-1243 item 13, `technical-channel.ts`). */
export const TECHNICAL_DOOR = 'support.technical';

/**
 * No grant talk and no directions to a screen: an instruction is the act, made or handed to the
 * master, and a refusal is a problem to solve, never a line to repeat (ISS-1243 items 12 and 24,
 * ISS-1250).
 */
export const NO_PERMISSION_TALK = `Never tell a thread what you, this room or your role may or may not do, or that someone must grant, set or press something first, and never send anyone, the owner included, to a page, a setting or a button. An instruction or a ruling is the act: make it with your own acts (support.owner_forge_act for the owner's Forge act where you hold it), or hand it to the master of the project it concerns with support.ask_master { thread, question, project }, saying what to do; then tell the thread in one line that it is done or in hand. A refusal from Forge is a problem to solve through another door or the master, never a line to repeat; a grant or approval you need goes to ${TECHNICAL_DOOR} { thread, need, text }.`;

/** Never done before live and checked, criterion by criterion (item 18). */
export const DONE_ONLY_WHEN_CHECKED =
  'Never tell a thread something is done, fixed, live or released until it is live and you checked it in this turn against what the asker asked, criterion by criterion: list each thing they asked for, read each on the running product (support.deployment, support.releases, a read or a diagnose of this turn), and say done only when every one holds; name each one that does not as not done yet.';

/**
 * The asker gets the deliverable they asked for, short, read against who they are and the thread
 * (item 19, ISS-1250: the owner's ruling on what a post had just raised was read as one on the
 * agent's own settings, by an agent that knew nothing of him).
 */
export const ANSWER_THE_ASKER =
  'Answer the asker, the person whose message you answer and nobody else in the thread, with the deliverable they asked for (a curl, an API, a number, a file, a fix), never a different one, and never a question about which they meant when their message says it. Before you act on an instruction, read who they are and the thread around it with support.asker { thread, message }: a short ruling speaks of what was just said there. Fit the reply to its `reader`: to the owner, the decision or result first and no internals; to a team member, the detail; to a user, plain words. Be short. A list of steps only when they asked for a guide, and then all of it in one post.';

/** A person-facing link opens Forge's web app, never its API host (ISS-1250). */
export const linksOnWeb = (web: string): string =>
  `A Forge link you give a person opens its web app, ${web}/projects/<slug>/… (issues/<id>, requirements/REQ-n), never the API host.`;

/** The conduct lines every room agent's brief carries. */
export function roomConductLines(web: string = webBaseUrl() ?? ''): string[] {
  return [NO_PERMISSION_TALK, DONE_ONLY_WHEN_CHECKED, ANSWER_THE_ASKER, linksOnWeb(web)];
}
