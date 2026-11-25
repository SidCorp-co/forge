// How every room agent conducts itself in a work thread (ISS-1243, owner 2026-11-15; ISS-1250 and
// ISS-1251, owner 2026-11-16), as the brief's map: one line per situation, rendered from the card of
// the act it reaches for (`act-cards.ts:mapLine`), so the card is the one text teaching the act. Who
// is asking and the thread around their message are read before acting (asker), the record keeps
// who they are (member), an instruction is an act made or handed to a master (ask_master), a need
// goes to the technical channel (technical), done is said only once live and checked (releases),
// each reply is audited after it is posted (audit), and the detail is the room agent's guide
// (guide). These teach; none blocks a reply. Told to a support group, a channel agent and an
// operations room alike.

import { webBaseUrl } from '../lib/web-base-url.js';
import { mapLine, type SupportAction } from './act-cards.js';

/** The technical channel's door, as a refusal names it (ISS-1243 item 13, `technical-channel.ts`). */
export const TECHNICAL_DOOR = 'support.technical';

/** The acts every room agent's map carries, in the order its lines are read. */
export const ROOM_MAP_ACTS = [
  'asker',
  'member',
  'ask_master',
  'technical',
  'releases',
  'references',
  'audit',
  'guide',
] as const satisfies readonly SupportAction[];

/**
 * The acts the map carries where the owner speaks to the agent: an operations room and a channel
 * agent's groups, never a support group of the product's users. His Forge act is among them
 * (ISS-1299): an operations room told none promised the owner an act it had no door for.
 */
export const OWNER_MAP_ACTS = [
  'reference_add',
  'term',
  'owner_forge_act',
] as const satisfies readonly SupportAction[];

/** A person-facing link opens Forge's web app, never its API host (ISS-1250): no act, so no card. */
export const linksOnWeb = (web: string): string =>
  `- When you give a Forge link: it opens the web app, ${web}/projects/<slug>/… (issues/<id>, requirements/REQ-n), never the API host.`;

/**
 * Telling someone how to do something is answered with the screen they see (ISS-1328 c5, FB-742), and
 * what a screen shows is said from a look at it (ISS-1356): the guide's Answering holds how, and the
 * map names the situation once, so the agent reaches for it.
 */
export const SHOW_HOW =
  '- When you tell someone how to do something or what a feature looks like: look first (support.look), say only what you saw, in words; never promise a file or guide.';

/** The conduct lines every room agent's brief carries: its acts' map lines, and where a link points. */
export function roomConductLines(web: string = webBaseUrl() ?? ''): string[] {
  return [...ROOM_MAP_ACTS.map(mapLine), SHOW_HOW, linksOnWeb(web)];
}
