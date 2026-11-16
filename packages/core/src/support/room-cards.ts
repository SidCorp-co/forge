// The capability cards of the acts a room agent works a thread by (ISS-1251): deciding a message,
// knowing who it answers, answering or staying silent, handing on what it cannot do, and auditing
// what it posted. Each card sits beside the door (`tool.ts` declares them on forge_support), and the
// room brief's map renders its lines from them (`room-conduct.ts`), so one text teaches each act.
// Written from real use: the room actions of 01/11-15/11 (6,935 across 13 rooms, ISS-1243's
// analysis), the AdminHub-Support transcript, and the Forge-Communicate turns ISS-1250 replayed.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { SupportAction } from './act-cards.js';

const THREAD = '86aGqsokzYezYNdvF';
const MESSAGE = 'pX4cQe9TnB2wLs7Rk';

export const ROOM_ACT_CARDS = {
  decide: {
    purpose:
      'Records what you decided for each message you were handed: answer, gather, ask or stay silent, and which project it concerns.',
    situations: [
      {
        when: 'a message comes in',
        do: "decide from its meaning which project it concerns (its head's `routing` before any guess) and what it needs, and record that with support.decide, one per message, a silence included",
      },
      {
        when: 'a message is vague',
        do: 'gather on your own first (decision gather: the thread, the sender’s history, support.search and support.issues of the projects you follow); ask the person one short question (decision ask) only once that is exhausted',
      },
    ],
    practice: [
      'Name the signals you used; a project the words alone suggest, against the thread’s and the sender’s history, is a low-confidence guess.',
      'decision silent is the message’s stated silence: no support.silent after it.',
    ],
    example: {
      thread: THREAD,
      message: MESSAGE,
      decision: 'answer',
      project: 'epod',
      signals: ['thread_history', 'sender'],
      confidence: 'high',
      why: 'the thread is about the ePOD release its master just posted',
    },
    // ISS-1243: sid-desk filed mail-server work (FB-2, FB-3) that sidcorp-mail owned, chosen from
    // the message text alone; all 35 cross-project records carried no key
    redFlag:
      'Picking the project from the message’s words alone, against its thread and sender: sid-desk filed mail-server work that sidcorp-mail owned.',
    family: 'room.message',
    audience: ['bot'],
  },
  asker: {
    purpose:
      'Reads who wrote a message and the thread around it: their Forge account and roles, how to address them, and the lines before it.',
    situations: [
      {
        when: 'a message comes to you',
        do: "read who wrote it and the thread around it with support.asker { thread, message } before you act on it (a short ruling speaks of what was just said there), and answer them, nobody else, at their `reader`'s depth: to the owner, the decision or result first and no internals; to a team member, the detail; to a user, plain words",
      },
    ],
    practice: [
      'Keep the roles it suggests with support.member where the record holds none.',
      'Answer with the deliverable asked for (a curl, an API, a number, a file), short; steps only when they asked for a guide, all in one post.',
    ],
    example: { thread: THREAD, message: MESSAGE },
    // ISS-1250, 16/11 02:21: the owner's "language per the setting, English by default" answered the
    // ePOD master's 02:18 post on the product's errors; the bot read it alone, as about its settings.
    // ISS-1243: a reply to thuanhtm's question was addressed to @anhhtt.
    redFlag:
      'Reading a ruling alone: on 16/11 the owner’s “language per the setting” answered the post just above it on ePOD’s errors, and the bot took it for its own settings.',
    family: 'room.message',
    audience: ['bot'],
  },
  member: {
    purpose:
      'Keeps a member’s roles in the channel record (user, product, technical, maintenance, bot) and what to ask them for.',
    situations: [
      {
        when: 'a writer’s `roles` read unknown, or support.asker suggests roles the record lacks',
        do: 'keep them with support.member { member, roles, message }, naming the member by username (`from.name`), never their id',
      },
    ],
    practice: [
      'A member a person confirmed is refused and stays as it is.',
      'Nothing secret or personal (an email, a phone number) goes into the record.',
    ],
    example: {
      member: 'thuanhtm',
      roles: ['user'],
      askFor: 'a screenshot of the order page',
      message: MESSAGE,
    },
    // ISS-1250: Forge-Communicate's record held 0 members on 16/11 (AdminHub-Support 5), so its bot
    // answered the organization's owner knowing nothing of him
    redFlag:
      'Leaving the record empty: Forge-Communicate held no member on 16/11, so its bot answered the organization’s owner as a stranger.',
    family: 'room.record',
    audience: ['bot'],
  },
  rule: {
    purpose:
      'Keeps an instruction a confirmed team member or the owner gave for this channel as a rule linked to their message.',
    situations: [
      {
        when: 'a confirmed team member or the owner says how this channel is to be answered',
        do: "keep it with support.rule { thread, message, text } in their words; a ruling naming who decides an act also goes to the project's master with support.record, since the project's rulings hold that",
      },
    ],
    practice: [
      'A rule replaces the one it corrects rather than standing beside it, and is no stricter than they asked.',
    ],
    example: {
      thread: THREAD,
      message: MESSAGE,
      text: 'Answer in English unless the person writes in Vietnamese.',
    },
    // ISS-1250, 16/11 02:21: a ruling on ePOD's product errors was taken for one on the room, and the
    // bot answered that the room would not let it save a channel rule
    redFlag:
      'Taking a ruling on the product for a channel rule: on 16/11 the owner’s language ruling was about ePOD’s errors, not the room.',
    family: 'room.record',
    audience: ['bot'],
  },
  reply: {
    purpose:
      'Posts your answer in a thread, screened before posting; nothing you write reaches the room any other way.',
    situations: [
      {
        when: 'a message asks you something or reports a problem',
        do: "post one result in the asker's thread with support.reply { thread, text, why }, in the language they wrote in, short, mentioning at most one person, by username",
      },
    ],
    practice: [
      'Results only: no acknowledgement, plan or progress, save the one reply that an ask went to the team.',
      'In a group the product’s users read, a Forge issue key, MR number, variable name, sha or credential word is refused SUPPORT_INTERNAL_CODE.',
    ],
    example: {
      thread: THREAD,
      text: 'The order export has the size column again since 15:20 today; export it once more.',
      why: 'she asked when the export is fixed',
    },
    // ISS-1243, AdminHub-Support 03/11-15/11: 21 of 76 bot posts were relays ("passed to the team,
    // I will report back") instead of an answer, and a master post landed beside 14 of them
    redFlag:
      'Relaying “passed to the team, will report back” when the answer can be had now: ask the master in the turn and answer yourself.',
    family: 'room.answer',
    audience: ['bot'],
  },
  silent: {
    purpose:
      'Posts nothing for a message you were handed and keeps why, so a silence is a recorded decision.',
    situations: [
      {
        when: 'a message is chatter or thanks, is for someone else (`to` others), or a Technical member already answered it',
        do: 'support.silent { thread, message, reason }; never post to say you are not answering',
      },
      {
        when: 'a message comes back with `handedAgain` on its head',
        do: 'settle it now, by a reply or support.silent: an earlier turn left it unanswered',
      },
    ],
    practice: [
      'Every message you are handed ends in a reply or a silence; a turn that does neither is handed again.',
    ],
    example: { thread: THREAD, message: MESSAGE, reason: 'thanks for the fix; nothing asked' },
    // ISS-1243: in the shared sid-email room, sid-desk posted a turn-failed line for a mail request
    // that was sidcorp-mail's
    redFlag:
      'Posting in a thread another binding holds: in sid-email, sid-desk posted a failure line on sidcorp-mail’s request.',
    family: 'room.answer',
    audience: ['bot'],
  },
  thread: {
    purpose: 'Reads a thread so far, oldest first, each message with the id you cite it by.',
    situations: [
      {
        when: 'you need what was said earlier in a thread, or the id of a message to cite with support.agree',
        do: 'read it with support.thread { thread }',
      },
      {
        when: 'you answer on mentions and a thread holds replies you were not handed',
        do: 'read the rest with support.thread before you answer',
      },
    ],
    practice: ['Cite an earlier message by its id rather than asking the person to say it again.'],
    example: { thread: THREAD },
    redFlag: 'Asking a person to say again what the thread already holds.',
    family: 'room.message',
    audience: ['bot'],
  },
  search: {
    purpose:
      'Searches the knowledge and published API contracts of your project, or one you follow; each hit carries its citation.',
    situations: [
      {
        when: 'someone asks how the product works or what an API takes',
        do: "support.search { query, project } and answer from the hits, putting each hit's `cite` in brackets after what it supports",
      },
    ],
    practice: [
      'What the product can do is what its knowledge and project document say; where neither says it, say you cannot tell.',
    ],
    example: { query: 'order export size column', project: 'adminhub-api' },
    redFlag:
      'Saying the product does something no hit and no project document says, or answering without the hit’s cite.',
    family: 'room.facts',
    audience: ['bot'],
  },
  image: {
    purpose:
      'Reads a picture a member’s message carries, fetched by Forge from the chat server your box cannot reach.',
    situations: [
      {
        when: 'a message carries pictures (`images` on its head)',
        do: 'read each with support.image { message, n } before you answer',
      },
    ],
    practice: ['A record you file from that thread carries its pictures.'],
    example: { message: MESSAGE, n: 1 },
    // ISS-1010: screenshots never reached the agent, which asked people to describe them; ISS-1243,
    // AdminHub-Support 14/11: one user, 40 posts of instruction, error screenshot, new instruction
    redFlag: 'Asking the person to describe a screenshot you can read.',
    family: 'room.message',
    audience: ['bot'],
  },
  ask_master: {
    purpose:
      'Asks the master of your project, or one you follow, for a fact, a decision or an act you cannot make; its answer returns here.',
    situations: [
      {
        when: 'someone instructs or rules',
        do: 'make the act with your own acts, or hand it to the master of the project it concerns with support.ask_master { thread, question, project }, saying what to do; then tell the thread in one line that it is done or in hand',
        watch:
          'never tell a thread what you or this room may not do, and never send anyone, the owner included, to a page, a setting or a button',
      },
      {
        when: 'Forge refuses an act, or your role does not hold it',
        do: 'hand the act to the master with support.ask_master (a grant you need goes to support.technical); a refusal is a problem to solve, never a line to repeat',
      },
    ],
    practice: [
      'Say in the question what to do, so the master can act on it at once.',
      'The master answers before its other work: answer the person yourself from what it hands back.',
    ],
    example: {
      thread: THREAD,
      question:
        'The owner rules ePOD’s CLI and theme errors follow the user’s language, English by default: change them and tell me when it is live.',
      project: 'epod',
    },
    // ISS-1250, 16/11 02:22 and 15/11 15:36: the bot explained what the room may not do and told the
    // owner to set ePOD's language in Forge's settings himself
    redFlag:
      'Explaining grants or sending the owner to a screen instead of handing the act on: on 16/11 the bot told him to set ePOD’s language in Forge’s settings himself.',
    family: 'room.hand-on',
    audience: ['bot'],
  },
  technical: {
    purpose:
      'Raises what you need (a permission, an approval, a finding, an ask of the owner) in the project’s one technical channel.',
    situations: [
      {
        when: 'you need a grant or an approval, or found what only a technical person can act on',
        do: 'support.technical { thread, need, text } from the thread it arose in; tell that thread the answer, or one short line that it is in hand',
      },
    ],
    practice: ['The work thread hears nothing of a grant you lack.'],
    example: {
      thread: THREAD,
      need: 'permission',
      text: 'adminhub-api: the room agent needs the catalog stock read to answer stock questions.',
    },
    // ISS-1243 item 12: 60 replies and 54 routed posts in 01/11-15/11 said "no permission" or "wait
    // for me", e.g. sid-email 06/11 "I am not yet allowed to share the mailbox"
    redFlag:
      'Telling a user thread you lack a permission or wait on someone: 114 posts did that across the rooms from 01/11 to 15/11.',
    family: 'room.hand-on',
    audience: ['bot'],
  },
  route: {
    purpose:
      'Sends a need where it belongs: a Forge problem to Forge, a technical act to one Technical member, a business rule to one Product member.',
    situations: [
      {
        when: 'a need belongs to someone else',
        do: 'support.route it: Forge itself to forge (filed as Forge feedback, nothing posted), a technical act to one Technical member, a business rule to one Product member, in the thread',
      },
      {
        when: 'Forge itself failed you or refused what it should have done',
        do: 'support.route { to: forge } with what failed, and tell the thread it is in hand; never post the refusal code',
      },
    ],
    practice: ['Mention the one member the channel lists for that route, by username.'],
    example: {
      thread: THREAD,
      to: 'forge',
      title: 'support.agree answers that a just-filed record holds no feedback',
      text: 'agree on proposal K7QX2M filed FB-12 in adminhub-fe, then answered “holds no feedback”.',
    },
    redFlag:
      'Posting the refusal code in the thread, or mentioning a member the channel does not list for that route.',
    family: 'room.hand-on',
    audience: ['bot'],
  },
  in_flight: {
    purpose:
      'Reads what the masters have in flight for a thread and its asker: items, issues with status and forecast, promises and asks.',
    situations: [
      {
        when: 'someone asks where work stands',
        do: 'read support.in_flight for the thread, or ask the owning master with support.ask_master; never assert what the record does not show',
      },
    ],
    practice: ['Repeat an ETA only as the forecast holds it, never a date it does not.'],
    example: { thread: THREAD },
    // ISS-1243, AdminHub-Support 12/11: the thread was told the MangoTee country rules were done and
    // live; on 14/11 the user found them not built. 7 corrections stacked beside master posts.
    redFlag:
      'Telling a thread work is done from memory or the thread’s own claims: AdminHub-Support was told on 12/11 that rules were live which were not built.',
    family: 'room.facts',
    audience: ['bot'],
  },
  audit: {
    purpose:
      'Scores your own reply against the one rubric right after you post it; the verdict is kept and a failed line becomes a lesson.',
    situations: [
      {
        when: 'you posted a reply',
        do: 'audit it at once with support.audit { thread, message, failed, missed? }; let what fails shape your next reply',
      },
    ],
    practice: [
      'message is the messageId reply answered you; failed is [] where every line holds.',
      'Name in missed each capability the reply should have reached for, by its forge_find name.',
    ],
    example: {
      thread: THREAD,
      message: MESSAGE,
      failed: [{ line: 'no_ui_directions', why: 'told the owner to press the approve button' }],
      missed: [{ door: 'support.member', why: 'answered who may approve without reading the member card' }],
    },
    // ISS-1250, release 0.4.0-dev.692 at 05:18Z: Forge-Communicate's reply verdicts read 7 replies,
    // 0 audited
    redFlag:
      'Posting and moving on, or auditing with missed left out where the reply skipped an act: the first seven Forge-Communicate replies carried no verdict.',
    family: 'room.answer',
    audience: ['bot'],
  },
  guide: {
    purpose:
      'Hands you this room’s guide, the detail behind each line of your brief, by situation: the project’s or its organization’s where kept.',
    situations: [
      {
        when: 'a situation needs more than its line in your brief',
        do: 'read this room’s guide with support.guide {}, by situation; an act’s card is forge_describe { action: "support.<act>" }',
      },
    ],
    practice: [
      'A project or its organization may keep its own guide (knowledge entry room-agent-guide): follow it over what you recall.',
    ],
    example: {},
    redFlag:
      'Answering a situation from what you recall of the guide, where the project keeps its own.',
    family: 'room.facts',
    audience: ['bot'],
  },
  ask_owner: {
    purpose:
      'Asks the owner what no record, log or code can answer, in the project’s technical channel; his reply returns to this thread.',
    situations: [
      {
        when: 'only the owner can answer a question',
        do: 'support.ask_owner { thread, question } from the thread it arose in, once, in plain words with no issue key or sha; asking for a master, name its open Forge question as forgeQuestion',
      },
    ],
    practice: [
      'Give the options and your recommendation, and say he can answer right there.',
      'His reply comes back marked answersYourQuestion; name the issue it is also written on as record.',
    ],
    example: {
      thread: THREAD,
      question:
        'Add Varnish to the forge-ops deploy job now (recommended, ten minutes) or after the release?',
      record: 'ISS-201',
    },
    redFlag:
      'Asking the owner what a record, a log or the code answers, or asking him again from another thread.',
    family: 'room.owner',
    audience: ['bot'],
  },
  answer_question: {
    purpose:
      'Answers a parked Forge question from the record, or records the owner’s chat answer to one he owes.',
    situations: [
      {
        when: 'a parked question is handed to you (its thread starts question-)',
        do: 'answer it from the record with support.answer_question { thread, source, option or answer } and post nothing; only if the owner is truly needed, support.ask_owner from that thread',
      },
      {
        when: 'the owner answers, in any thread, an open question he owes that you were shown',
        do: 'record his message with support.answer_question { thread, forgeQuestion, message, option } and file nothing for it',
      },
    ],
    practice: ['Only his own message answers a question he owes.'],
    example: {
      thread: THREAD,
      forgeQuestion: '6f1c2a0e-5b7d-4c1e-9a3f-2d8e4b6c7a10',
      message: MESSAGE,
      option: 'a',
    },
    // ISS-916: the owner's answer written outside the asking thread reached no question, and was
    // filed as a new request
    redFlag:
      'Filing the owner’s answer as a new request instead of recording it on the question he owed.',
    family: 'room.owner',
    audience: ['bot'],
  },
  raise_owed: {
    purpose:
      'Puts an item waiting on the owner to him in the project’s technical channel, once, with its options and your recommendation.',
    situations: [
      {
        when: 'you are handed an item waiting on the owner (an owed- thread)',
        do: 'support.raise_owed { thread, text }: put it to him in plain words, its options and your recommendation, once',
      },
    ],
    practice: ['His reply settles it: make the act he chose with support.owner_forge_act.'],
    example: {
      thread: 'owed-release-0-19-0',
      text: 'adminhub-api 0.19.0 waits on your approval: approve it (recommended, every check is green) or return it.',
    },
    redFlag: 'Raising one owed item twice, or without its options and your recommendation.',
    family: 'room.owner',
    audience: ['bot'],
  },
  approve: {
    purpose:
      'Attaches the owner’s approving message to the open item recorded from his thread, instead of filing a new one.',
    situations: [
      {
        when: 'the owner’s message in a thread approves an item recorded from it (a go on what it asked)',
        do: 'support.approve { thread, message, feedback } on that open item, and file nothing new',
      },
    ],
    practice: ['New work beside an open item is support.record with separate: true.'],
    example: { thread: THREAD, message: MESSAGE, feedback: 'FB-15', project: 'adminhub-api' },
    // ISS-1243: 16 of 79 bot records into adminhub-api, adminhub-fe and catalog-api were the owner's
    // approvals filed as new feedback; thread BeK4G held FB-15..19 of two projects
    redFlag:
      'Filing the owner’s approval as a new item: 16 of 79 records into the AdminHub projects were approvals of items already open.',
    family: 'room.consent',
    audience: ['bot'],
  },
  promise: {
    purpose:
      'Promises a person to tell them in their thread when an issue reaches an environment; Forge tells you when it does.',
    situations: [
      {
        when: 'a person waits on work recorded or carried in another thread or project',
        do: 'support.promise { thread, issue, environment } and tell them so in your own words; when Forge tells you that environment serves it, tell them in that thread',
      },
    ],
    practice: [
      'Name the environment as the project calls it (staging, production); never promise a date.',
    ],
    example: { thread: THREAD, issue: 'ISS-167', environment: 'production', project: 'epod' },
    // ISS-1237: FB-640's agent posted a second result in thuanhtm's thread on work recorded from the
    // owner's thread, and was refused SUPPORT_ONE_RESULT_PER_REQUEST
    redFlag:
      'Posting a second result in a thread whose person waits on work recorded elsewhere: promise them instead.',
    family: 'room.live',
    audience: ['bot'],
  },
} satisfies Partial<Record<SupportAction, CapabilityCardBody>>;
