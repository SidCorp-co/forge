// The scenarios of the channel actions a master and a chat assistant work another project's documents
// through, and of the ecosystem reads a builder run is worked with (`ecosystem/channel-tool.cards.ts`,
// `ecosystem/tool.cards.ts`). Forge recorded no call of these in the 90 days to 2026-11-17 (GET
// /api/projects/forge/metrics/doors): masters worked the same documents over the REST twins from a
// checkout. So each is the situation the record that built the act names, the ePOD/Catalog round
// behind ISS-246 and ISS-742 and ISS-790's catalog-fe builder run (FB-372), and the good use its
// card teaches; with no recorded misuse, none carries a bad use, and the refusal each act was built
// around is named in its source.

import type { CardScenario } from '../lessons/index.js';

const NONE = 'forge door use, 2026-08-19..11-17: no call';
const ROUND = 'the ePOD/Catalog contract round (ISS-246, ISS-742)';
const CATALOG = 'ISS-790 (FB-372, catalog-fe builder run 966a1da8)';
/** adminhub-api ISS-243 (FB-76), its master's comment at 09:45Z on 2026-11-17, quoted in ISS-1279. */
export const SIBLING = 'adminhub-api ISS-243, 2026-11-17 09:45Z (ISS-1279)';
export const SIBLING_BAD =
  'could not send it: the adminhub-api token is refused PAT_PROJECT_OUTSIDE_FENCE on adminhub-fe; a person’s act: the adminhub-fe master or the owner carries this note into adminhub-fe';

export const CHANNEL_SCENARIOS: readonly CardScenario[] = [
  {
    name: 'a pass nudged with channel documents owed, each worked before it ends',
    card: 'channel.unanswered',
    source: `${ROUND}; the inbox sweep's nudge; ${NONE}`,
    situation: 'A master’s pass was nudged with two channel documents owed and an empty backlog',
    good: 'read unanswered and work each number it lists before the pass ends',
    teaches: [/work each number it lists before the pass ends/i],
  },
  {
    name: 'a change notice’s thread read before replying, a hold or a later answer respected',
    card: 'channel.thread',
    source: `${ROUND}; THREAD_HELD and REPLY_TO_ENDED refusals; ${NONE}`,
    situation: 'A master is about to answer a change notice its inbox lists',
    good: 'read the thread first, and stop where a person holds it',
    teaches: [/read its thread first/i, /never release the hold/i],
  },
  {
    name: 'an RFI about a provider’s contract answered after reading its API page',
    card: 'channel.contracts',
    source: `${ROUND}; ${NONE}`,
    situation: 'An RFI asks whether this project can move to the provider’s next contract version',
    good: 'read contracts with project set to the provider, and say what this project decided',
    teaches: [/read contracts with project set to the provider/i],
  },
  {
    name: 'an RFI answered with reply, a new draft kept for a new document',
    card: 'channel.draft',
    source: `${ROUND}; ${NONE}`,
    situation: 'A master decided how to answer an RFI another project sent',
    good: 'answer with reply carrying inReplyTo; draft only a new notice, RFI or request',
    teaches: [/An answer to a document is reply, not draft/i],
  },
  {
    name: "an API issue's UI part sent to its sibling as a change request, never left to a person: ISS-1279",
    card: 'channel.draft',
    source: SIBLING,
    situation:
      'An API master shipped its half of an issue; the screen is the front end’s, and filing it there was refused PAT_PROJECT_OUTSIDE_FENCE',
    bad: SIBLING_BAD,
    good: 'send the front end a change request through the channel, as this project, and let its master decide it',
    teaches: [
      /send that project a change request through the channel/i,
      /handing the part to a person/i,
    ],
  },
  {
    name: 'a change notice answered with the type it owes, never refused REPLY_TYPE_NOT_ALLOWED',
    card: 'channel.reply',
    source: `${ROUND}; the reply type rule (REPLY_TYPE_NOT_ALLOWED, REPLY_TO_ENDED); ${NONE}`,
    situation: 'A master answers an owed change notice',
    good: 'reply with the type the parent owes, then submit; say what this project decided',
    teaches: [/a change notice an acknowledgement/i, /REPLY_TYPE_NOT_ALLOWED/],
  },
  {
    name: 'a document the gate returned edited whole and submitted again',
    card: 'channel.edit',
    source: `${ROUND}; the approve gate's return note; ${NONE}`,
    situation: 'An admin returned a submitted document at the gate with a note',
    good: 'read the note, edit with the whole content, and submit again',
    teaches: [/Send the whole content each time/i],
  },
  {
    name: 'a submitted reply said to wait at the gate until an admin approves',
    card: 'channel.submit',
    source: `${ROUND}; ${NONE}`,
    situation: 'A master submitted its reply on a channel whose gate holds that type',
    good: 'submit once confirmed, and say it waits at the gate until an admin approves',
    teaches: [/Waiting at the gate is not published/i],
  },
  {
    name: 'a document at the approve gate decided by an admin, never its author',
    card: 'channel.gate',
    source: `${ROUND}; GATE_RETURN_WITHOUT_NOTE; ${NONE}`,
    situation: 'A document a master wrote waits at the approve gate',
    good: 'an admin approves it, or returns it with a note saying what must change',
    teaches: [/An agent approving its own document at the gate/i, /GATE_RETURN_WITHOUT_NOTE/],
  },
  {
    name: 'a thread held only for a person taking the conversation over',
    card: 'channel.hold',
    source: `${ROUND}; HOLD_NOT_AUTHORISED; ${NONE}`,
    situation: 'A document stays on unanswered while its answer waits on another issue',
    good: 'hold only where a person takes the conversation over, with the reason',
    teaches: [/only a person taking it over holds it/i],
  },
  {
    name: 'a reply refused THREAD_HELD stopped until the person releases the hold',
    card: 'channel.release',
    source: `${ROUND}; THREAD_HELD; ${NONE}`,
    situation: 'A reply was refused THREAD_HELD on a thread the owner held',
    good: 'stop; release only when the person who held it hands it back',
    teaches: [/THREAD_HELD means stop/i],
  },
  {
    name: 'a sent change request followed in the outbox, never sent twice',
    card: 'channel.outbox',
    source: `${ROUND}; ${NONE}`,
    situation: 'A person asks whether the provider answered the change request sent last week',
    good: 'read the outbox and the thread of the one sent',
    teaches: [/read the outbox and the thread/i],
  },
  {
    name: 'a person’s question about the ecosystem answered from the register',
    card: 'channel.register',
    source: `${ROUND}; ${NONE}`,
    situation: 'A person asks what the projects of an ecosystem have said to each other',
    good: 'answer from the register; work what unanswered lists',
    teaches: [/the register is the whole record/i],
  },
  {
    name: 'a corrected notice superseding the one it replaces, with the reason',
    card: 'channel.supersede',
    source: `${ROUND}; SUPERSEDE_NOT_A_REPLACEMENT; ${NONE}`,
    situation: 'A master published a corrected change notice replacing last week’s',
    good: 'supersede the earlier one by the newer one with the reason',
    teaches: [/supersede the earlier one by the newer one with the reason/i],
  },
  {
    name: 'a notice that no longer stands withdrawn, a replaced one superseded',
    card: 'channel.withdraw',
    source: `${ROUND}; WITHDRAW_WITHOUT_REASON; ${NONE}`,
    situation: 'A notice this project sent no longer stands',
    good: 'withdraw with the reason only where nothing replaces it; otherwise supersede',
    teaches: [/nothing replaces it/i, /where supersede names the replacement/i],
  },
  {
    name: 'a nudged pass working the open builder run, never one beside it',
    card: 'ecosystem.builder_runs',
    source: `${CATALOG}; ${NONE}`,
    situation: 'A master’s pass was nudged after a push to the branch this project builds from',
    good: 'read builder_runs, then work the open one’s steps in order',
    teaches: [/work the open one, never open another beside it/i],
  },
  {
    name: 'a builder run opened by hand only where none is open',
    card: 'ecosystem.builder_run_create',
    source: `${CATALOG}; ${NONE}`,
    situation: 'The open builder run’s steps no longer fit the project’s source type',
    good: 'supersede the stale run; open one by hand only where no run is open',
    teaches: [/which builder_run_supersede does/i, /baseRevision null/],
  },
  {
    name: 'the bus read by the ecosystem’s uuid while working a builder run',
    card: 'ecosystem.bus',
    source: `${CATALOG}; ${NONE}`,
    situation: 'A master working a builder run needs how its links fare against the latest version',
    good: 'read the bus by the ecosystem’s uuid; stepsStale true means supersede',
    teaches: [/a projectId beside it is refused/i, /stepsStale true means supersede the run/i],
  },
  {
    name: 'context loaded for the paths a run will touch before editing a caller',
    card: 'ecosystem.context',
    source: `${CATALOG}; ${NONE}`,
    situation: 'A run is about to change a module that calls the provider’s order contract',
    good: 'load context with the paths you will touch and your session, before you edit',
    teaches: [/load context with the paths you will touch/i],
  },
  {
    name: 'the interface read before a contract is published, its revision sent back',
    card: 'ecosystem.interface',
    source: `${CATALOG}; ${NONE}`,
    situation: 'A master is about to publish a contract this project serves',
    good: 'read interface first; its revision is the baseRevision the write sends',
    teaches: [/its revision is the baseRevision interface_write sends/i],
  },
];
