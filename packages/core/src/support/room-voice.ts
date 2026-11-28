// What a room's agent may be handed to say (ISS-1483). The person knows one voice, the agent's: a
// sentence a read hands the agent to relay never names the project's master, a team or a hand-off,
// because the agent repeats what it is handed (dev.857 and dev.858 each found one more such sentence).
// So a wait that is delivery work is worded at its source as what is waiting and for how long, and a
// person is named only where one owes the act. An instruction about an act the agent makes
// (`support.ask_master`) is not a sentence to say and stays where it is taught.
//
// Wording about who acts reaches a room two ways: literals in the code (the derived scan in
// `room-voice-scan.fixture.ts`) and said-keys the standing, release and forecast reads render
// (`ROOM_SAID` below holds the room's own wording of each key that names an internal role; the scan
// refuses a key that names one with no wording here). `roomSay` and `roomWho` are the only way a room read renders them.

import { type Said, type SaidKey, type SaidValue, sayEn } from '@forge/contracts/said';

/** What a sentence the agent relays must never hold: an internal role acting, or a hand-off, a restart or "their side". */
export const NAMES_THE_HAND =
  /\bmasters?\b|\bteams?\b|\bhand-?(?:ed|s)?[ -]?(?:off|on|over)\b|\brestart|\b(?:independent judge|a judge|the judge|judges)\b|\bstewards?\b|\borchestrator|\breviewer|\bbuilders?\b|\bQA\b|\b(?:project|AdminHub|their|our|other) side\b|\b(?:to|by|the|from) ops\b(?! tools?)|\bengineering\b|\bdevelopers?\b|\b(?:passed|handed|forwarded|given) (?:it |this |that |them )?(?:on |over )?to (?:the |another |other )?(?:project|other|another|different)\b/i;

/** An actor's name on a page that is an internal hand (a master, the judge, the steward, a release run or gate), never said to a room. */
export const isInternalHand = (who: string): boolean =>
  NAMES_THE_HAND.test(who) || /\brelease (?:gate|run)\b/i.test(who);

/** The delivery work's own name on a page (`standing.who.master`, `standing.who.projectMaster`): never said to a room. */
export const isDeliveryWork = isInternalHand;

/** Stands in the owner's place where the act is delivery work: no name, no person. */
export const NO_PERSON = 'no person';

/** The rule, as it is taught to the agent: the one place it is worded, so a card, a note and a guide say it alike (ISS-1483). */
export const NEVER_NAME_THE_HAND = 'never name a master, a team or a hand-off';

/** The phrases a relayed string may hold: the act an agent makes, and the rule it is taught. */
export const TAUGHT_NOT_SAID: readonly string[] = [NEVER_NAME_THE_HAND, 'support.ask_master'];

/**
 * The room's own wording of each said-key whose page text names an internal role as the actor: it says
 * what is waiting or happening, never whose hand does it. The page keeps its own text.
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
  'issues.rule.admitted': 'admitted and not withheld: a run is owed to it',
  'issues.rule.blockedLanded': 'blocked by {key}, landed but not yet judged and passed',
  'issues.rule.draft': 'a draft is not work until it is taken on',
  'issues.rule.landed': 'landed at `{status}`: it is judged next, then moves to `awaiting_release`',
  'issues.rule.landedMaster': 'landed at `{status}`: it moves on to `awaiting_release`',
  'issues.rule.needsInfo': 'parked at needs_info: asked in Needs you; the answer resumes it',
  'issues.rule.noNote': 'no release note yet: it is written next',
  'issues.rule.personPaused': 'a person paused it; it resumes when they say',
  'issues.rule.releaseRunning': 'a release in progress holds it',
  'issues.rule.reopen': 'sent back with a reason; it is taken up again',
  'issues.rule.withheld': '{code}: {detail} Nothing is started on it until then.',
  'issues.standing.act.landedWaitsJudge': 'landed, waits to be judged',
  'issues.standing.who.patternReviewer': 'A person reviewing the pattern',
  'standing.act.answerSteward': 'answer the question that was asked',
  'standing.act.judgeReleaseOn': 'have {v} judged on {environment}',
  'feedback.rule.masterOwes':
    '{phase}: it waits to be triaged; feedback.approve holders may triage first',
  'feedback.rule.masterCuts': 'planned: {issue} {waits} for a release, due by {date}',
  'feedback.rule.carrierParked': '{key} carries it and is parked; it moves on when that does',
  'releases.rule.masterCuts': 'merged issues wait at the release gate to be cut with {route}',
  'releases.rule.noRequest': 'approval required, none asked yet: it is asked with {route}',
  'releases.rule.returned': 'an admin returned it; it is answered before approval is asked again',
  'releases.rule.returnedWhy':
    'an admin returned it: {why}; it is answered before approval is asked again',
  'releases.rule.inProgress': 'the release is going out to production',
  'forecast.reason.masterSilent': 'nothing has moved since {at}, so nothing is dispatched',
  'forecast.reason.masterSilentFromStart': 'nothing has moved since it started',
  'forecast.act.restartMaster': 'get it moving again',
  'forecast.reason.masterDialog': 'it is stopped on a dialog ({rule})',
  'forecast.reason.passRefused': 'the last pass was refused ({reason}): {detail}',
  'forecast.act.releaseToMaster': 'release it to be worked',
  'forecast.reason.masterCuts': 'the release is cut routinely, so no date',
  'forecast.reason.masterCutsPersonApproves':
    'it is cut, then an approver{holders} approves it, so no date',
  'forecast.reason.masterRecords': 'no production environment declared: the landing is recorded',
  'standing.stuck.noMaster': 'It waits on delivery work, and nothing is serving this project.',
  'standing.stuck.masterSilent': 'It waits on delivery work, and nothing has moved for a while.',
};

const valueOf = (v: SaidValue | undefined): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(roomSay).join(', ');
  return roomSay(v as Said);
};

/** A said-key as a room reads it: the room's own wording where the page's names an internal role, else the page's. */
export function roomSay(s: Said): string {
  const own = ROOM_SAID[s.key];
  if (own === undefined) return sayEn(s);
  return own.replace(/\{(\w+)\}/g, (_m, name: string) => valueOf(s.vars?.[name]));
}

/** An actor as a room reads it: no name where it is an internal hand, else the page's. */
export function roomWho(s: Said): string {
  const who = sayEn(s);
  return isInternalHand(who) ? NO_PERSON : who;
}
