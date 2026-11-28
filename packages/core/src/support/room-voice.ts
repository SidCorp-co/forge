// What a room's agent may be handed to say (ISS-1483). The person knows one voice, the agent's: a
// sentence a read hands the agent to relay never names the project's master, a team or a hand-off,
// because the agent repeats what it is handed (dev.857 and dev.858 each found one more such sentence).
// So a wait that is delivery work is worded at its source as what is waiting and for how long, and a
// person is named only where one owes the act. An instruction about an act the agent makes
// (`support.ask_master`) is not a sentence to say and stays where it is taught.
//
// Wording about who acts reaches a room two ways: literals in the code (the derived scan in
// `room-voice-scan.fixture.ts`) and said-keys the standing, release and forecast reads render
// and they FAIL CLOSED: a key reaches a room only through `ROOM_SAID` (the room's own wording) or
// `ROOM_PLAIN` (a reviewed key whose page text is said as it is), and a key on neither reads as one
// fixed sentence with no actor, device, pane or dialog in it, so the next unnamed key cannot leak (dev.861,
// five rounds running). `roomSay`, `roomWho` and `roomWaits` are the only way a room read renders them.

import { SAID_ENTRIES, type Said, type SaidKey, type SaidValue } from '@forge/contracts/said';
import { ROOM_PLAIN } from './room-plain-keys.js';

/** What a sentence the agent relays must never hold: an internal role acting, or a hand-off, a restart or "their side". */
export const NAMES_THE_HAND =
  /\bmasters?\b|\bteams?\b|\bhand-?(?:ed|s)?[ -]?(?:off|on|over)\b|\brestart|\b(?:independent judge|a judge|the judge|judges)\b|\bstewards?\b|\borchestrator|\breviewer|\bbuilders?\b|\bQA\b|\b(?:project|AdminHub|their|our|other) side\b|\b(?:to|by|the|from) ops\b(?! tools?)|\bengineering\b|\bdevelopers?\b|\b(?:passed|handed|forwarded|given) (?:it |this |that |them )?(?:on |over )?to (?:the |another |other )?(?:project|other|another|different)\b|(?<![\p{L}\p{N}_])(?:bên (?:AdminHub|kỹ thuật|phát triển|dev|vận hành|kia)|đội (?:ngũ )?(?:kỹ thuật|phát triển|vận hành|dev)|trợ lý nội bộ|kỹ thuật viên|lập trình viên|phía (?:kỹ thuật|dự án|bên kia)|chuyển (?:cho|sang) (?:đội|bên))(?![\p{L}\p{N}_])/iu; // i18n-allow: the Vietnamese words for a hand, withheld from a room

/** An actor's name on a page that is an internal hand (a master, the judge, the steward, a release run or gate), never said to a room. */
export const isInternalHand = (who: string): boolean =>
  NAMES_THE_HAND.test(who) || /\brelease (?:gate|run)\b/i.test(who);

/** The delivery work's own name on a page (`standing.who.master`, `standing.who.projectMaster`): never said to a room. */
export const isDeliveryWork = isInternalHand;

/** Stands in the owner's place where the act is delivery work: nobody a person has to ask. */
export const NO_PERSON = 'nobody needs to be asked';

/** The rule, as it is taught to the agent: the one place it is worded, so a card, a note and a guide say it alike (ISS-1483). */
export const NEVER_NAME_THE_HAND = 'never name a master, a team or a hand-off';

/** The phrases a relayed string may hold: the act an agent makes, and the rule it is taught. */
export const TAUGHT_NOT_SAID: readonly string[] = [NEVER_NAME_THE_HAND, 'support.ask_master'];

/** What a key no room wording covers reads as: no actor, no device, no pane, no dialog, no text anyone wrote. */
export const NEUTRAL_WAIT = 'it is waiting on something outside this thread';

/** What a parked issue reads as where its park text is an agent's own words, or its wait has no person's question. */
export const NEUTRAL_PARK = 'it is paused and will resume when the condition it waits on is met';
const NEUTRAL_PREDICATE = 'is waiting on something outside this thread';

/** Words of the machinery that no room sentence holds either: a bare judge, a run, Forge as the actor, a pane, a device, a dialog. */
export const INTERNAL_WORDS =
  /\bjudge\b|\bruns?\b|\bForge\b|\bagents?\b|\bpane\b|\bdevices?\b|\brunners?\b|\bbox(?:es)?\b|\bdialogs?\b|\blease\b|\bjobs?\b|\bdispatch|\bslots?\b|\bsweep|\bsilent\b/i;

/**
 * The room's own wording of each said-key whose page text names an internal role, a run or free
 * text as what acts: it says what is waiting or happening, never whose hand does it. An act reads
 * after "waits to"; a rule or a reason reads as a clause. The page keeps its own text.
 */
export const ROOM_SAID: Partial<Record<SaidKey, string>> = {
  'issues.blocker.landedMany': 'Blocked by {keys}, which have landed and are waiting to be judged.',
  'issues.blocker.landedOne': 'Blocked by {keys}, which has landed and is waiting to be judged.',
  'issues.blocker.whoLandedMany': 'Each criterion of {keys} has to be judged and passed.',
  'issues.blocker.whoLandedOne': 'Each criterion of {keys} has to be judged and passed.',
  'issues.blocker.whoNamesWhere': 'Once it is named where the unmet scope goes, it resumes.',
  'issues.blocker.whoPaused': 'It resumes when the work is wanted again.',
  'issues.blocker.whoRefused': 'It moves on once what the refusal names is cleared.',
  'issues.blocker.whoResumes': 'It resumes on its own.',
  'issues.blocker.whoWaitOver': 'It resumes once that wait is over.',
  'issues.rule.admitted': 'admitted and not withheld: it will be worked on',
  'issues.rule.blockedLanded': 'blocked by {key}, landed but not yet judged and passed',
  'issues.rule.draft': 'a draft is not work until it is taken on',
  'issues.rule.landed':
    'landed at `{status}`: it is waiting to be judged, then moves to `awaiting_release`',
  'issues.rule.landedMaster': 'landed at `{status}`: it moves on to `awaiting_release`',
  'issues.rule.needsInfo': 'parked at needs_info: asked in Needs you; the answer resumes it',
  'issues.rule.noNote': 'no release note yet: it is written next',
  'issues.rule.markOwed': 'a merged change is not yet recorded on the issue',
  'issues.rule.parked': NEUTRAL_PARK,
  'issues.rule.parkedAsked': 'it is paused until a question about it is answered',
  'issues.rule.parkedBehind': 'it is paused behind {key} and resumes when that moves on',
  'issues.rule.personPaused': 'a person paused it; it resumes when they say',
  'issues.rule.releaseRunning': 'a release in progress holds it',
  'issues.rule.reopen': 'sent back with a reason; it is taken up again',
  'issues.rule.withheld': 'held back: nothing is started on it until that is cleared',
  'issues.standing.act.markMerged': 'record the merged change on the issue',
  'issues.standing.act.moveOnRefused': 'move it on once what stopped it is cleared',
  'issues.standing.act.landedWaitsJudge': 'landed, waits to be judged',
  'issues.standing.act.resumeOnce': 'resume once the condition it waits on is met',
  'issues.standing.who.patternReviewer': 'A person reviewing the pattern',
  'standing.act.answerSteward': 'answer the question that was asked',
  'standing.act.judgeAfterRelease': 'have them judged once the release ships',
  'standing.act.judgeCriteria': 'have the criteria still owed judged',
  'standing.act.judgeOn': 'have {criteria} judged on {issues}',
  'standing.act.judgeOnRelease': 'have {criteria} judged at the requirement on release {version}',
  'standing.act.judgeReleaseOn': 'have {v} judged on {environment}',
  'standing.act.judgeShipped': 'have {criteria} judged on the running build',
  'feedback.rule.masterOwes':
    '{phase}: it waits to be triaged; feedback.approve holders may triage first',
  'feedback.rule.masterCuts': 'planned: {issue} {waits} for a release, due by {date}',
  'feedback.rule.carrierParked': '{key} carries it and is parked; it moves on when that does',
  'releases.rule.masterCuts': 'merged issues are waiting to be cut into a release',
  'releases.rule.noRequest': 'approval required, none asked yet',
  'releases.rule.returned': 'an admin returned it; it is answered before approval is asked again',
  'releases.rule.returnedWhy':
    'an admin returned it: {why}; it is answered before approval is asked again',
  'releases.rule.inProgress': 'the release is going out to production',
  'forecast.reason.masterSilent': 'nothing has moved since {at}, so nothing is started',
  'forecast.reason.masterSilentFromStart': 'nothing has moved since it started',
  'forecast.act.restartMaster': 'get it moving again',
  'forecast.reason.masterDialog': 'nothing has moved for a while',
  'forecast.reason.passRefused': 'the last attempt to take it up did not go through',
  'forecast.act.releaseToMaster': 'have it picked up',
  'forecast.reason.masterCuts': 'the release is cut routinely, so no date',
  'forecast.reason.masterCutsPersonApproves':
    'it is cut, then an approver{holders} approves it, so no date',
  'forecast.reason.masterRecords': 'no production environment declared: the landing is recorded',
  'standing.stuck.noMaster': 'It waits on delivery work, and nothing is serving this project.',
  'standing.stuck.masterSilent': 'It waits on delivery work, and nothing has moved for a while.',
};

/**
 * The keys whose page text a room reads as it is: each reviewed once (`room-voice-scan.test.ts` holds
 * every one to the room's rule) and listed by name, so a key added tomorrow is not here and reads
 * as `NEUTRAL_WAIT` until someone words it. Generated from the groups a room read renders
 * (waits, acts, rules and reasons) minus every key whose text names a role, a run, a device or an
 * actor, or carries words a person or a run wrote.
 */
export { ROOM_PLAIN };

/**
 * The vars of a room-said key that carry a name or words and are said anyway, each with why: a person's
 * name, a criterion or an issue the act is about, an environment, an admin's reason for returning a release.
 */
export const ROOM_VARS: Readonly<Record<string, string>> = {
  'standing.who.named.name': "a person's name, the only way a room says whom a wait is on",
  'standing.who.namesMore.names': "people's names, joined",
  'standing.act.judgeOn.criteria': 'the criteria an act is about, as their keys',
  'standing.act.judgeOn.issues': 'the issues an act is about, as their keys',
  'standing.act.judgeOnRelease.criteria': 'the criteria an act is about, as their keys',
  'standing.act.judgeShipped.criteria': 'the criteria an act is about, as their keys',
  'standing.act.judgeReleaseOn.environment': "the release's environment, as the project names it",
  'releases.rule.returnedWhy.why':
    "the admin's own reason for returning the release, a person's words",
};

/** Kinds a room says as they are: counts, versions, keys, dates, codes and the like, never words someone wrote. */
const SAFE_KINDS: ReadonlySet<string> = new Set([
  'count',
  'version',
  'key',
  'date',
  'instant',
  'status',
  'statusLabel',
  'step',
  'code',
  'permission',
  'role',
  'agreement',
]);

const JOINERS: Readonly<Record<string, string>> = {
  saidList: '; ',
  saidSeries: ', ',
  saidDots: ' · ',
};

/** The var names whose value is a sha or an error code: no room says one (bots-answer-users-by-name). */
export const CODE_VARS: ReadonlySet<string> = new Set(['sha', 'code']);

const roomPlain = (key: string): boolean => (ROOM_PLAIN as ReadonlySet<string>).has(key);

/** Whether a room reads this key at all: it has the room's wording or is reviewed as it is. */
export const roomReads = (key: string): boolean => key in ROOM_SAID || roomPlain(key);

function valueText(key: string, name: string, kind: string, v: SaidValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(roomSay).join(JOINERS[kind] ?? '; ');
  if (typeof v === 'object') return roomSay(v as Said);
  if (CODE_VARS.has(name) && !(`${key}.${name}` in ROOM_VARS)) return '';
  if (SAFE_KINDS.has(kind) || `${key}.${name}` in ROOM_VARS) return String(v);
  return '';
}

/** The text a room reads for `s`, or null where no wording covers it. */
function roomText(s: Said): string | null {
  const own = ROOM_SAID[s.key];
  if (own === undefined && !roomPlain(s.key)) return null;
  const entry = SAID_ENTRIES[s.key];
  const template = own ?? entry?.en;
  if (template === undefined) return null;
  const kinds = entry?.vars ?? {};
  let out = '';
  let at = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    const name = m[1] as string;
    const end = (m.index ?? 0) + m[0].length;
    const text = valueText(s.key, name, kinds[name] ?? 'text', s.vars?.[name]);
    out += template.slice(at, m.index) + text;
    at = end;
    if (template[end] === '.' && /[.!?…]$/.test(text)) at = end + 1;
  }
  return out + template.slice(at);
}

/** A said-key as a room reads it: the room's own wording or the reviewed page text; any other key reads as `NEUTRAL_WAIT`. */
export function roomSay(s: Said): string {
  return roomText(s) ?? NEUTRAL_WAIT;
}

const NO_NAME_KEYS: ReadonlySet<string> = new Set(['standing.who.nobody', 'standing.who.you']);

/** The person a wait is on, as a room names them: a name only for a key reviewed to carry one, else null. */
export function roomPerson(s: Said): string | null {
  // "Nobody" and "You" name no one in a room: the read has no viewer, and nobody is not a person to wait on
  if (NO_NAME_KEYS.has(s.key)) return null;
  const text = roomText(s);
  return text === null || text === '' || isInternalHand(text) ? null : text;
}

/** An actor as a room reads it: a person's name or `NO_PERSON` where it is delivery work or no wording covers it. */
export function roomWho(s: Said): string {
  return roomPerson(s) ?? NO_PERSON;
}

/** An act with no one to owe it, as a clause: "wait out the limit" reads "is waiting out the limit". */
const waitingTo = (act: string): string =>
  /^wait (?:out|for) /.test(act) ? `is waiting ${act.slice(5)}` : `is waiting to ${act}`;

/**
 * A wait as one clause a room says after its subject: "waits on Lan to answer a question" where a
 * person owes the act, "is waiting to have 0.4.0 judged on test" where it is delivery work, and a
 * fixed clause where no wording covers the act. It never names no one, an internal role or a reason's
 * own words.
 */
export function roomWaits(who: Said, act: Said, reason: Said | null = null): string {
  const a = roomText(act);
  if (a === null || a === '') return NEUTRAL_PREDICATE;
  const person = roomPerson(who);
  const why = reason === null ? null : roomText(reason);
  return `${person === null ? waitingTo(a) : `waits on ${person} to ${a}`}${why ? ` (${why})` : ''}`;
}
