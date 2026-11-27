// The scenarios of the room doors a master, a run or a room agent calls (`support/rest-cards.ts`,
// `support/work-cards.ts`, `support/audit-tool.ts`), each from the use forge recorded (GET
// /api/projects/forge/metrics/doors over the 90 days to 2026-11-17) or the record its card's comment
// names: what the agent was handed, what it did and what the card teaches it to do instead.

import type { CardScenario } from '../lessons/index.js';

const USE = 'forge door use, 2026-08-19..11-17';

export const SUPPORT_SCENARIOS: readonly CardScenario[] = [
  {
    name: 'a master needing a grant sent between two doors that refuse it (FB-813)',
    card: 'POST /api/projects/:id/support/technical-needs',
    source:
      'FB-813, the sid-desk master 2026-11-22T03:11Z: support.technical refused SUPPORT_NOT_THE_ROOM_SESSION, master-posts refused SUPPORT_PERMISSION_TALK',
    situation: 'An owner-ordered production investigation needs a grant the master does not hold',
    bad: 'the master called support.technical, then posted in the room that it lacked the permission',
    good: 'raise it here in your own words to the channel’s reader, react to the asker’s message with support.react, and tell its thread once, when the answer is in',
    teaches: [/raise it here/i, /refused to you/i],
  },
  {
    name: 'a post naming no thread landed in the project’s thread beside a room agent’s ask (FB-832)',
    card: 'POST /api/projects/:id/support/master-posts',
    source:
      'FB-832, adminhub-api’s master 2026-11-23: posted with rid and no thread, which landed in its project’s thread H5Yt beside an ask',
    situation: 'A master posts a matter for the whole operations room, naming the room alone',
    bad: 'it named no thread and could not tell where the post would land, nor how to take it back',
    good: 'know where a post naming no thread lands, name the report thread for a whole-room matter, and delete a misplaced post within its window',
    teaches: [
      /operations room/i,
      /report thread of any other room the team reads/i,
      /users’ room refuses it/i,
      /at a room’s top level, where/i,
      /`reportThread`/,
      /DELETE \/api\/projects\/:id\/support\/master-posts\/:messageId/,
      /edit window/i,
    ],
  },
  {
    name: 'a room post deleted by a chat id no master post held: SUPPORT_POST_UNKNOWN',
    card: 'DELETE /api/projects/:id/support/master-posts/:messageId',
    source: `${USE}: its one call refused SUPPORT_POST_UNKNOWN`,
    situation: 'A master posted in the wrong thread minutes ago',
    bad: 'the delete named a chat message id that was none of its posts’ ids',
    good: 'delete it by the messageId the post answered, then post it where it belongs',
    teaches: [/delete it by the messageId the post answered/i],
  },
  {
    name: 'a room post corrected that was not the master’s: SUPPORT_POST_NOT_YOURS',
    card: 'PATCH /api/projects/:id/support/master-posts/:messageId',
    source: `${USE}: its one call refused`,
    situation: 'A post a master made minutes ago says something wrong',
    good: 'send its corrected text under the messageId its own post answered',
    teaches: [/send its corrected text under the messageId/i],
  },
  {
    name: 'the steward applying a group’s switch, forbidden: REQ-77 BC-16',
    card: 'POST /api/projects/:id/support/channels/:rid/switch/apply',
    source: `REQ-77 BC-16; ${USE}: the steward’s one call forbidden`,
    situation: 'A group’s planned switch from its outside bot is ready',
    bad: 'the steward applied it itself',
    good: 'leave it to a person, who applies it once every duty passed',
    teaches: [/forbidden, it is a person’s act/i],
  },
  {
    name: 'the steward recording an outside bot stopped, forbidden',
    card: 'POST /api/projects/:id/support/channels/:rid/switch/outside-stopped',
    source: `${USE}: the steward’s one call forbidden, an operator’s record`,
    situation: 'An outside bot shares the channel agent’s chat account',
    bad: 'the steward recorded its process stopped',
    good: 'the operator records it, with a note of how it was stopped',
    teaches: [/with a note of how it was stopped/i],
  },
  {
    name: 'the steward confirming a member the room’s record held: SUPPORT_MEMBER_SOURCE',
    card: 'PUT /api/projects/:id/support/channels/:rid/members/:username',
    source: `${USE}: the steward’s one call refused SUPPORT_MEMBER_SOURCE`,
    situation: 'A channel’s member roles are to be confirmed',
    bad: 'the steward wrote roles nobody had stated through the channel page’s door',
    good: 'write a member’s roles only as a person confirms them',
    teaches: [/An agent confirming roles a person did not state/i],
  },
  {
    name: 'the steward planning a group’s switch, forbidden',
    card: 'PUT /api/projects/:id/support/channels/:rid/switch',
    source: `REQ-77 BC-16; ${USE}: the steward’s one call forbidden`,
    situation: 'A group is to move from its outside bot to the channel agent',
    bad: 'the steward planned the switch itself',
    good: 'a person plans the outside bot’s account, the duties and what it waits on',
    teaches: [/An agent planning or applying a group’s switch itself/i],
  },
  {
    name: 'a report thread named by a room this project does not hold',
    card: 'PUT /api/projects/:id/support/rooms/:roomId/report-thread',
    source: `${USE}: its one call answered not found`,
    situation: 'A person asks that reports on their work go to a thread of their own',
    bad: 'the room was named by its chat rid',
    good: 'name that thread’s first message id for the room by its Forge id',
    teaches: [/name that thread’s first message id/i, /chat rid/i],
  },
  {
    name: 'masters and runs closing work with no audit, their misses read nowhere',
    card: 'audit.self',
    source: 'ISS-1251 judge, 2026-11-16 at 4efa1e10: misses came only from room agents',
    situation: 'An issue a run built is closed and its report written',
    bad: 'the run moved on with no audit, so nothing counted what it missed',
    good: 'audit it once with audit.self, naming each failed line and missed act',
    teaches: [/audit it once with audit\.self/i],
  },
  {
    name: 'a run reading production through its box’s credential: ISS-707',
    card: 'POST /api/projects/:id/ops-reads/:name',
    source: 'ISS-707: a run read production through whatever credential its box held',
    situation: 'An issue needs production logs to find its cause',
    bad: 'the run read production with a credential placed on its box by hand',
    good: 'run a read the project declares by its name, with the run’s id and its parameters',
    teaches: [/run a read the project declares by its name/i],
  },
  {
    name: 'OrbitInternal duties naming a box file or production host: ISS-775',
    card: 'support.project',
    source: 'ISS-775: four OrbitInternal duties named a box file, key or production host',
    situation: 'Someone asks what the product runs where',
    bad: 'the answer read a box file and a production host',
    good: 'read support.project and answer from it, or say you cannot tell',
    teaches: [/support\.project/, /say you cannot tell/i],
  },
  {
    name: 'a decider asked to say ok before her own request was filed: ISS-1229',
    card: 'support.propose_fix',
    source: 'ISS-1229, ISS-1243 item 17: AdminHub-Support asked 11 times in 03/11-15/11',
    situation: 'The feature decider asks for a fix the room grants',
    bad: 'she was asked to reply ok before what her own request asked was filed',
    good: 'propose the fix naming her as asker and cite her own words with support.agree',
    teaches: [/support\.propose_fix/, /support\.agree/],
  },
  {
    name: 'a credential handed over in chat: kept, named once, nothing asked of its sender',
    card: 'support.secret_link',
    source:
      'ISS-1372, Forge-Communicate AdminHub thread of 20/11: the owner’s production token was dropped as [Filtered], then he was asked to delete his message; ISS-1328, 18/11: a delete-and-rotate ask after he declined',
    situation:
      'The owner sends a production token in the thread for the master to set a supplier up with',
    bad: 'the token was dropped, the bot said it was not kept and asked him to delete the message he chose to send',
    good: 'say once what was kept, under which name, for which project, who can use it and where it is revoked; ask no deletion and no rotation',
    teaches: [/kept it in the project’s vault/i, /ask nobody to delete the message/i],
  },
  {
    name: 'a production variable asked for: the link to that field and a one-time write command',
    card: 'support.secret_link',
    source:
      'ISS-1348, epod thread 86aGqsokzYezYNdvF of 19/11: a settings screen named in prose and corrected, then a production OAuth secret pasted in chat',
    situation: 'The master needs a production OAuth client secret the owner holds',
    bad: 'the bot named a settings screen in prose, linked the wrong one, and the owner pasted the secret in chat',
    good: 'call support.secret_link naming the variable and its environment with presign, and give its link and command',
    teaches: [/support\.secret_link/, /never name a settings screen/i, /presign/],
  },
];
