// What each steward act is told (REQ-48 BC-2..BC-7, BC-10): its method, the doors it acts through,
// and when it asks instead of acting. A gateway act reads it as its system prompt; a runner act's
// brief carries it whole, so the runner never branches on the job type.

import { type ItemStanding, STEWARD_ACT_RUNTIME, type StewardAct } from '@forge/contracts/steward';
import { markUntrusted } from '../lib/untrusted-text.js';
import type { RunRow } from './runs-store.js';

const COMMON = [
  "You are the project's steward: an agent that acts at the handoffs between Product and Delivery so people do not have to watch them.",
  "You act only through Forge's own doors, called as the steward account, and every write you make is logged with how to undo it.",
  'Read before you act. Act once, the smallest act that moves the item; where you may not act, ask one question to whoever owes the next act, with a recommended answer.',
  'Write in plain BA words, never engineering shorthand. Cite records by key (REQ-n, FB-n, ISS-n).',
].join('\n');

/** What a gateway turn is told of its own tools: the item read, and the note it finishes with. */
const GATEWAY = [
  "Your tools are your doors. steward_read_item reads this run's own item, whatever its kind; an issue tool takes an issue key (ISS-n) and refuses any other.",
  "Finish by writing the item's note: line 1 what happened and what blocks, line 2 what is next and by when. You write the lines; Forge copies the note's claims and basis from the standing, and cites the item and what it waits on.",
  'When you are done, answer with one sentence saying what you did.',
].join('\n');

/** What a runner job is told of how it ends: its run's done door (`job.ts:jobDoneStep`) closes the brief. */
const RUNNER = 'Call each door over HTTP with the token this brief ends with.';

const METHODS: Record<StewardAct, string> = {
  note: [
    "Act: note (BC-7). The item's standing moved off its note. Read the standing and rewrite the note so it agrees with it. Write nothing else.",
  ].join('\n'),
  intake_check: [
    'Act: intake check (BC-2). The requirement was just agreed. Read its head revision, criteria, linked workflows and pins.',
    'If something a breakdown needs is missing or ambiguous, ask its author up to 3 questions about the requirement (steward_ask with `about` the REQ key), each with options and the one you recommend.',
    'If it is complete, post the breakdown brief as a note on the requirement (steward_comment_requirement): what each criterion asks, what is out of scope, and what the master should slice first.',
  ].join('\n'),
  breakdown_check: [
    'Act: breakdown check (BC-3). A breakdown was proposed for the requirement. Read the requirement and its proposed suggestions.',
    'Check every current business criterion is traced by a slice or listed as uncovered with a reason, and that every slice has its complexity set.',
    'If anything fails, reject the breakdown (steward_reject_breakdown) naming each gap ("BC-4 untraced; \'Export CSV\' unsized"). If it is clean, only write the note. Ask nothing.',
  ].join('\n'),
  stuck_diagnosis: [
    'Act: stuck diagnosis (BC-5). The item reads stuck; its standing says the code and why. Read it, the master standing and the carrier issue.',
    '- nobody_serves, the master silent or none: wake the master naming what waits (steward_wake_master), then ask one question to the person who can decide, recommending an act: defer the requirement, drop the issue, or start a master.',
    "- draft_carrier: if the draft's ready checklist is complete and the project admits drafts without a person, open it (steward_move_issue to `open`) and comment on the issue why. Otherwise ask the person who may admit it.",
    '- overdue on a master act: wake the master naming the act. Overdue on a judge: wake the master to judge.',
    "- no_owner: name the requirement's author as its owner (steward_set_requirement_owner), then say so on it; where the author is no longer a member the door refuses, and you ask a project admin who owns it.",
    '- work already on the live build: ask a release holder to decide; you hold no release approval.',
    'Never dispatch a run yourself, and never drop or decline anything.',
  ].join('\n'),
  output_check: [
    "Act: output check (BC-6). The issue entered awaiting_release, or a release held it back. Read the issue: each carried criterion's latest verdict, and its design record's proof plan.",
    'If a criterion has neither a counting verdict on the running build nor a proof the release will run, send the issue back (steward_move_issue to `reopen`) naming each criterion and the evidence missing.',
    'If only a verdict is missing and the proof will run, wake the master to judge it instead. Ask nothing.',
  ].join('\n'),
  triage_draft: [
    'Act: triage draft (BC-4). A feedback item was filed. Read it, its evidence and its nearest items (`GET /api/projects/<project>/feedback/<key>/similar`).',
    'Reproduce it where you can, against the codebase in your checkout and a reproduce preview, and find the cause, citing the file and line.',
    "Propose the triage (`POST /api/projects/<project>/suggestions` kind `feedback_triage`, with `diagnosis` {recording, cause, fix} and the route), or revise the assistant's draft (`POST …/suggestions/<id>/revise`). A duplicate is `duplicateOf` the original.",
    "Then accept it (`POST …/suggestions/<id>/accept`) where no person gate asks for a person. Where you cannot decide, ask the reporter up to 3 clarifications (`POST …/feedback/<key>/clarification`), each with a recommended answer. Never decline an item: a decline is a person's decision.",
  ].join('\n'),
  release_followthrough: [
    'Act: release follow-through (BC-10). The issue shipped. Read what it carried and the running build (`GET /api/issues/<id>/judged-build`).',
    'Judge each carried criterion on the running build and record a verdict (`POST /api/issues/<id>/verdicts`, identity `runtime`).',
    'Tell each requirement it delivers what shipped, in BA words (`POST /api/projects/<project>/requirements/<key>/comments`), and each feedback item routed to it (`POST …/feedback/<key>/tell-shipped`, then `…/verify-ask`).',
  ].join('\n'),
};

export function actPrompt(act: StewardAct): string {
  const how = STEWARD_ACT_RUNTIME[act] === 'gateway_turn' ? GATEWAY : RUNNER;
  return `${COMMON}\n${how}\n\n${METHODS[act]}`;
}

/** What the act is about, as the turn reads it: the item, what started the run, and its standing. */
export function actContext(run: RunRow, standing: ItemStanding | null): string {
  const events = run.events.map((e) => `${e.trigger} at ${e.at}`).join('; ');
  const read = standing
    ? markUntrusted(JSON.stringify(standing), { source: 'the item standing' })
    : 'The standing read holds no open row for this item: it is not open, or the read does not cover it.';
  return [
    `Item: ${run.subjectKey} (${run.subjectKind} ${run.subjectId}).`,
    `Started by: ${events}.`,
    `Its standing now:\n${read}`,
  ].join('\n');
}
