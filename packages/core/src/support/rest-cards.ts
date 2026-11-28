// The capability cards of the support doors a project's master or run calls over REST (ISS-1251),
// beside their routes (`routes.ts`, `master-ask-routes.ts`, `channel-routes.ts`, `run-reads.ts`),
// keyed by the door as the published contract lists it and built into the door catalog by
// `mcp/rest-cards.ts`. A room
// session's own acts are forge_support's (`act-cards.ts`), so their REST twins carry no card here.
// Written from the dispatch guide's account of telling a room what came of it, and from the calls
// these doors took on forge between 2026-10-17 and 2026-11-16.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const SUPPORT_REST_CARDS = {
  'POST /api/projects/:id/support/master-posts': {
    purpose: 'Posts a result in a chat room as the room’s bot, in the master’s own words.',
    situations: [
      {
        when: 'a room only the team reads should hear a result or a release line',
        do: 'post it in the thread, naming rid and thread from the rooms read',
        watch:
          'a room its users read gets no words or files of yours, in any thread: it is refused SUPPORT_MASTER_POST_USERS_ROOM; hand its bot the facts (`POST …/master-tells`)',
      },
      {
        when: 'you name no thread',
        do: 'it lands in your project’s own thread of an operations room, or the report thread of any other room the team reads; a users’ room refuses it. The answer’s `thread` and `landedIn` say where it went',
        watch:
          'no master post goes at a room’s top level, where reports bury the room’s own talk (ISS-1224)',
      },
      {
        when: 'a release you watched go live is to be told in the project’s thread',
        do: 'post its page’s `card`: your own words in the owner’s language, `attachments: card.attachments`, `report: "release <version>"`',
        watch: 'the cover and shots are the judges’ marks; pick no file of your own',
      },
      {
        when: 'a release check or other report goes in a thread',
        do: 'name it with `report`: it updates only your own earlier post of that report',
        watch: 'without `report` the post replaces the agent’s latest answer there',
      },
      {
        when: 'a team room’s thread was already told the item’s result',
        do: 'post only what it did not say, naming the message it follows up (`followsUp`), so it stands beside it',
      },
      {
        when: 'your post landed in the wrong thread',
        do: '`DELETE /api/projects/:id/support/master-posts/:messageId` by the messageId it answered, within its edit window, then post it where it belongs',
      },
    ],
    practice: [
      'Read the thread first (`GET …/master-posts/threads/:thread`): post only on its own matter, and nothing the room agent or another master already said.',
      'A matter for the whole room goes in its report thread: name the room’s `reportThread` from the rooms read as `thread`, never an asker’s thread.',
      'Attach the file to the issue first, then name its id in `attachments`.',
    ],
    example: {
      text: 'The reorder fix is live in 1.31.1: a reorder right after checkout now shows this order.',
      rid: 'GENERAL',
      thread: 'q7XkP2mN9aB4cD8e',
    },
    // FB-832 (adminhub-api's master, 2026-11-23): a post naming no thread landed beside an ask, the
    // card saying neither where it would go nor how to take it back (ISS-1433)
    // forge, 2026-10-17..11-16: 13 of 29 posts refused, among them top-level posts in a users' room
    // (SUPPORT_POST_NEEDS_THREAD) and a second telling of one result (SUPPORT_MASTER_POST_ALREADY_TOLD)
    redFlag:
      'Posting at a users’ room’s top level, or telling a thread a result it was already told.',
    family: 'rooms',
    audience: ['master'],
    scenarios: [
      'the ePOD release posts told in the asker’s thread once checked live',
      'a post naming no thread landed in the project’s thread beside a room agent’s ask (FB-832)',
    ],
  },
  'POST /api/projects/:id/support/technical-needs': {
    purpose:
      'Raises a need the master holds (a grant, an approval, a finding, an ask) in its project’s technical channel.',
    situations: [
      {
        when: 'a task the owner gave you needs a grant or an approval you do not hold',
        do: 'raise it here in your own words to the channel’s reader, react to the asker’s message with support.react, and tell its thread once, when the answer is in',
        watch:
          'a room post saying you lack it is refused SUPPORT_PERMISSION_TALK; support.technical is a room session’s door, refused to you',
      },
    ],
    practice: [
      'Write to the reader in the channel’s language, in the second person.',
      'A held raise names the person’s message: raise again with `answers` set to it.',
    ],
    example: {
      need: 'permission',
      text: 'Please grant me read access to the production logs for the outage you asked me to look into.',
    },
    // FB-813 (sid-desk master, 2026-11-22T03:11Z): support.technical refused it
    // SUPPORT_NOT_THE_ROOM_SESSION and master-posts refused SUPPORT_PERMISSION_TALK pointing back there
    redFlag:
      'Telling a room thread you lack a grant, or calling support.technical, which no master’s credential passes.',
    family: 'rooms',
    audience: ['master'],
    scenarios: ['a master needing a grant sent between two doors that refuse it (FB-813)'],
  },
  'PATCH /api/projects/:id/support/master-posts/:messageId': {
    purpose: 'Replaces the words of a post you made in a room, within its edit window.',
    situations: [
      {
        when: 'a post you made minutes ago says something wrong',
        do: 'send its corrected text under the messageId the post answered',
      },
    ],
    practice: ['Past the edit window (SUPPORT_POST_EDIT_WINDOW_PASSED) post a correction instead.'],
    example: { text: 'The reorder fix is live in 1.31.2, not 1.31.1.' },
    // forge: its one call was refused; the door refuses another account's post (SUPPORT_POST_NOT_YOURS)
    redFlag:
      'Editing a post past its window or one that is not yours, where a correction post is the act.',
    family: 'rooms',
    audience: ['master'],
    scenarios: ['a room post corrected that was not the master’s: SUPPORT_POST_NOT_YOURS'],
  },
  'DELETE /api/projects/:id/support/master-posts/:messageId': {
    purpose: 'Removes a post you made in a room, with its images, within its edit window.',
    situations: [
      {
        when: 'you posted in the wrong room or thread minutes ago',
        do: 'delete it by the messageId the post answered, then post it where it belongs',
      },
    ],
    practice: ['It is recorded on the room with who and when.'],
    example: {},
    // forge: its one call named a message the room held no master post as (SUPPORT_POST_UNKNOWN)
    redFlag: 'Deleting by a chat message id that is not one of your posts’ ids.',
    family: 'rooms',
    audience: ['master'],
    scenarios: ['a room post deleted by a chat id no master post held: SUPPORT_POST_UNKNOWN'],
  },
  'POST /api/projects/:id/support/master-asks/:askId/answer': {
    purpose: 'Answers a room agent’s ask while a person waits in its thread.',
    situations: [
      {
        when: 'your pass names a room agent’s ask (ask_master) waiting on you',
        do: 'answer it before any other work, from what you know or can read now: what you checked, what you did not, the problem and a solution as far as you can name them',
        watch:
          'the agent holds a case (problem, solution, round) and asks again until both are named; never write the person’s sentence',
      },
    ],
    practice: [
      'The answer goes back into the agent’s session, which tells the person in its own voice: never post beside it.',
      'Your answer is facts and a proposal for the agent. Where the case is not yet solved, say what is open; a script for the agent to say, or a question for it to put to the person, is the agent’s to write.',
    ],
    example: { answer: 'ISS-640 carries the fix; it ships in tonight’s release.' },
    // the door refuses an ask already answered (SUPPORT_MASTER_ASK_ANSWERED); the dispatch guide
    // teaches it because masters had posted in the thread beside the agent
    redFlag:
      'Posting your answer in the room yourself beside the agent that asked, or writing it as a script for the person (“say exactly this and ask her…”): on 28/11 the agent posted such facts nearly verbatim, and answered a different question than the one asked.',
    family: 'rooms',
    audience: ['master'],
    scenarios: ['a room agent’s ask answered first while a person waits in its thread'],
  },
  'POST /api/projects/:id/support/master-tells': {
    purpose:
      'Hands a room’s bot plain facts for a thread; the bot tells the room in its own words and language.',
    situations: [
      {
        when: 'a result, a check or a release should reach people in a room its product’s users read',
        do: 'name the asker’s thread and write the facts for the bot: what changed, where it runs, what to check again',
        watch:
          'never write the sentence the room should read; the bot restates it with no keys or shas',
      },
      {
        when: 'the thread is refused SUPPORT_THREAD_UNKNOWN: the chat server holds no such thread in that room',
        do: 'hand nothing and post nothing: check the thread id and rid; a thread no member wrote in takes the facts and the agent opens its turn there',
        watch:
          'there is no route that puts your words in a users’ room instead, and none that carries a file to it: give the bot the steps in words',
      },
    ],
    practice: [
      'Read the thread first (`GET …/master-posts/threads/:thread`): hand over only what the bot did not already tell.',
      'master-posts stays for a room only the team reads and for the daily review.',
    ],
    example: {
      thread: 'q7XkP2mN9aB4cD8e',
      facts:
        'The print fix is live for every site since this morning; the asker should print again.',
    },
    // FB-866 (SidPeak, 2026-11-25): a master's own English report with shas, issue keys and tool
    // words reached a users' thread as the bot's post, and the master had no way to hand the bot facts
    redFlag:
      'Posting your own report into a room its users read, or writing the facts as a message for the room.',
    family: 'rooms',
    audience: ['master'],
    scenarios: ['a master hands the room’s bot facts, never the words for a users’ room: FB-866'],
  },
  'PUT /api/projects/:id/support/rooms/:roomId/report-thread': {
    purpose: 'Names the thread a room’s reports go to, for a person’s own report thread.',
    situations: [
      {
        when: 'a person asks that reports about their work go to a thread of their own',
        do: 'name that thread’s first message id for the room',
      },
    ],
    practice: ['The room is named by its Forge room id from the rooms read, never its chat rid.'],
    example: { thread: 'q7XkP2mN9aB4cD8e' },
    // forge: its one call named a room this project holds no room as
    redFlag: 'Naming the room by its chat rid, which the door answers as not found.',
    family: 'rooms',
    audience: ['master'],
    scenarios: ['a report thread named by a room this project does not hold'],
  },
  'PUT /api/projects/:id/support/channels/:rid/members/:username': {
    purpose: 'Confirms a channel member’s roles, so the room agent knows who decides what.',
    situations: [
      {
        when: 'a person confirms who in a channel is product, technical or maintenance',
        do: 'write the member’s roles, and askFor where they are the one to ask about a matter',
      },
    ],
    practice: ['A room agent records a member through its own act (support.member), not here.'],
    example: { roles: ['product'], askFor: 'what the storefront offers' },
    // forge: the steward's one call was refused; a member the room's own record holds is
    // confirmed by its source (SUPPORT_MEMBER_SOURCE)
    redFlag: 'An agent confirming roles a person did not state, through the channel page’s door.',
    family: 'rooms',
    audience: ['person'],
    scenarios: ['the steward confirming a member the room’s record held: SUPPORT_MEMBER_SOURCE'],
  },
  'PUT /api/projects/:id/support/channels/:rid/switch': {
    purpose: 'Plans a group’s switch from the bot outside Forge to the project’s channel agent.',
    situations: [
      {
        when: 'a person moves a group from its outside bot to the channel agent',
        do: 'plan the outside bot’s account, the duties the agent must pass and what it waits on',
      },
    ],
    practice: ['It takes project admin: a person plans, passes each duty and applies it.'],
    example: {
      outsideBot: { userId: 'orbit-babo' },
      duties: [{ key: 'reorder', text: 'Answers a reorder question with the order’s code.' }],
    },
    // forge: the steward's one call was forbidden; the switch is a person's act (REQ-77 BC-16)
    redFlag:
      'An agent planning or applying a group’s switch itself: forbidden, it is a person’s act.',
    family: 'rooms',
    audience: ['person'],
    scenarios: ['the steward planning a group’s switch, forbidden'],
  },
  'POST /api/projects/:id/support/channels/:rid/switch/apply': {
    purpose: 'Applies a planned switch once every duty passed, moving the group to the agent.',
    situations: [
      {
        when: 'a person passed every duty of a planned switch',
        do: 'apply it; the outside bot leaves the group and the agent answers it',
      },
    ],
    practice: [
      'A switch waiting on another group’s switch or the owner’s word is refused until it holds.',
    ],
    example: {},
    // forge: the steward's one call was forbidden
    redFlag: 'An agent applying a switch a person has not passed: forbidden, it is a person’s act.',
    family: 'rooms',
    audience: ['person'],
    scenarios: ['the steward applying a group’s switch, forbidden: REQ-77 BC-16'],
  },
  'POST /api/projects/:id/support/channels/:rid/switch/outside-stopped': {
    purpose: 'Records that the outside process answering as the binding’s own account is stopped.',
    situations: [
      {
        when: 'an outside bot shares the channel agent’s chat account and its process was stopped',
        do: 'record it with a note of how it was stopped, so the switch can move the group',
      },
    ],
    practice: ['Only where the outside bot is the binding’s own account: nobody is removed then.'],
    example: { note: 'Stopped the orbit-babo container on the ops box at 09:10.' },
    // forge: the steward's one call was forbidden; it is an operator's record
    redFlag: 'Recording the process stopped before anyone stopped it.',
    family: 'rooms',
    audience: ['person'],
    scenarios: ['the steward recording an outside bot stopped, forbidden'],
  },
  // run-reads.ts (ISS-707): a run read production through whatever credential its box held
  'POST /api/projects/:id/ops-reads/:name': {
    purpose:
      'Runs a production read the project declares, for the run you are, and keeps it on your issue.',
    situations: [
      {
        when: 'the issue you work needs production logs or data to find or prove its cause',
        do: 'run a read the project declares by its name, with your run’s id as run and its parameters as args',
      },
    ],
    practice: [
      'What it printed comes back scrubbed, and the read is kept on your issue as ops.read.',
      'A run that is not live in this project, or a read it does not declare, is refused by name.',
    ],
    example: { run: '3f2b9c1e-7a4d-4e8b-9c2f-1a6d5e4b3c2a', args: { code: 'RIV-68493' } },
    redFlag:
      'Reading production through a credential on your box instead of a read the project declares.',
    family: 'issue-work',
    audience: ['run'],
    scenarios: ['a run reading production through its box’s credential: ISS-707'],
  },
} satisfies Record<string, CapabilityCardBody>;
