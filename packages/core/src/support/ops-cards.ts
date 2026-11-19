// The capability cards of the room acts a grant opens and of the operations room's acts (ISS-1251):
// the changes a confirmer agrees to (`ability-acts.ts`: move_issue, build, deploy, command), the
// owner's acts in his own room, the channel record's writes, and the operations reads and writes
// (`ops-acts.ts`). Beside `room-cards.ts`; `act-cards.ts` declares them on forge_support. Few have a
// recorded use (operations, 2026-10-17..11-16: tools 1, projects 1, requirements 3), so each red flag
// is the misuse its own refusal or the room brief's rule was written against.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { SupportAction } from './act-cards.js';

const THREAD = 'w2NZNL75fXT83G3WB';
const MESSAGE = 'pX4cQe9TnB2wLs7Rk';

export const OPS_ACT_CARDS = {
  tools: {
    purpose: 'Lists the checks (diagnose) and changes (fix) this room grants you, by name.',
    situations: [
      {
        when: 'something is reported broken and you are about to diagnose or propose a fix',
        do: 'read support.tools {} and pick the check or fix by the name it lists',
      },
    ],
    practice: ['A deploy target or a host is named as tools lists it.'],
    example: {},
    redFlag: 'Telling a person you cannot check something before reading what this room grants.',
    family: 'room.facts',
    audience: ['bot'],
    scenarios: [
      'a fix the room grants left to the owner: “I cannot install it on the live system”',
    ],
  },
  channel: {
    purpose:
      'Reads the channel record: each group’s members, roles, rules, routes and common issues.',
    situations: [
      {
        when: 'you need who a member is, which rule binds a group, or where a need is routed',
        do: 'read support.channel {} and follow what the group’s own record holds',
      },
    ],
    practice: [
      'The record is the one place these live: keep none of your own in a file, memory or note.',
      'A key, password or token a person sends anyway is a secret: never repeat it and never keep it, in the record or anywhere; give them the slot’s support.secret_link.',
    ],
    example: {},
    redFlag:
      'Following what another group’s record holds, or a note of your own, over this group’s record.',
    family: 'room.record',
    audience: ['bot'],
    scenarios: ['a member the channel does not list mentioned for a route: @phatpt'],
  },
  common_issue: {
    purpose:
      'Keeps a question asked in two or more threads with its one answer, a defect’s with its Feedback key.',
    situations: [
      {
        when: 'the same question was asked in two or more threads and has one answer',
        do: 'support.common_issue naming every thread it was asked in, the question, the answer and FB-n where it is a defect',
      },
    ],
    practice: ['A question in one thread is not common: it names at least two.'],
    example: {
      threads: [THREAD, 'k3RtYp8LmWq2ZxN5c'],
      question: 'Why does the export lose the size column?',
      answer: 'A known defect the team is fixing; the CSV export still holds it.',
      feedback: 'FB-12',
    },
    redFlag: 'Answering the same question afresh in each thread instead of keeping it once.',
    family: 'room.record',
    audience: ['bot'],
    scenarios: ['one answer on MangoTee lines posted afresh in two threads nine seconds apart'],
  },
  announce: {
    purpose: 'Posts the one top-level message, news affecting everyone, at most once an hour.',
    situations: [
      {
        when: 'news affects everyone in the group: an outage, or a release they all use',
        do: 'support.announce { text } once, in plain words, mentioning nobody',
        watch:
          'a second within the hour is refused SUPPORT_ANNOUNCE_LIMIT: post in the thread it belongs to',
      },
    ],
    practice: ['News for one person or one thread goes in that thread.'],
    example: {
      text: 'Orders placed between 09:00 and 09:40 are being synced again; nothing needs doing.',
    },
    redFlag: 'Announcing what one thread asked about, or mentioning a person in an announcement.',
    family: 'room.answer',
    audience: ['bot'],
    scenarios: ['an announcement mentioning two people and asking them to type OK'],
  },
  move_issue: {
    purpose:
      'Moves an issue of this room’s project as the member whose message asked, under their own permissions.',
    situations: [
      {
        when: 'a member asks you to park, reopen or drop an issue, and the room grants deliver',
        do: 'support.move_issue naming their message, the issue, the status and their reason',
      },
    ],
    practice: [
      'It runs as the writer of the message you name; a member without the permission is refused by name.',
    ],
    example: {
      thread: THREAD,
      message: MESSAGE,
      issue: 'ISS-167',
      to: 'on_hold',
      reason: 'Waiting on the supplier’s new sheet.',
    },
    redFlag: 'Naming someone else’s message to move an issue the asker may not move.',
    family: 'room.work',
    audience: ['bot'],
    scenarios: ['a move refused SUPPORT_ABILITY_NOT_GRANTED, its grant explained'],
  },
  build: {
    purpose:
      'Proposes pushing the room’s working copy as a build on a branch of its own, reviewed into the development branch.',
    situations: [
      {
        when: 'a change made in the room’s working copy is to reach the team, and the room grants build',
        do: 'support.build with a branch of its own, a title and a summary, then cite the confirmer’s go with support.agree',
      },
    ],
    practice: ['Nothing is pushed until a confirmer the room allows agrees.'],
    example: {
      thread: THREAD,
      branch: 'chat/export-size-column',
      title: 'Export keeps the size column',
      summary: 'The CSV export writes the size column again.',
    },
    // build.ts: a build from chat never changes what production deploys (SUPPORT_BUILD_REFUSED)
    redFlag:
      'Building onto a branch production deploys from: a build from chat pushes a branch of its own.',
    family: 'room.consent',
    audience: ['bot'],
    scenarios: ['a build from chat pushed on a branch of its own after a confirmer’s go'],
  },
  deploy: {
    purpose:
      'Proposes a deploy of a target this room’s grant names; it runs once a confirmer agrees.',
    situations: [
      {
        when: 'a person who may confirm asks for a deploy of a granted target',
        do: 'support.deploy { thread, target }, cite their go with support.agree, then read support.deployment',
      },
    ],
    practice: [
      'Name the target as tools lists it; say it is live only once support.deployment reads it.',
    ],
    example: { thread: THREAD, target: '6f1c2a0e-5b7d-4c1e-9a3f-2d8e4b6c7a10' },
    redFlag: 'Saying a deploy is done when it was proposed, before support.deployment reads it.',
    family: 'room.consent',
    audience: ['bot'],
    scenarios: ['a deploy said live only once the deployment reads it'],
  },
  command: {
    purpose:
      'Runs a command on a host this room’s grant names: a read runs at once, a change once a confirmer agrees.',
    situations: [
      {
        when: 'a problem needs a look on a granted host that no check or read covers',
        do: 'support.command { thread, host, command }; a change waits for a confirmer’s go cited with support.agree',
      },
    ],
    practice: ['What it prints comes back scrubbed of every secret the room holds.'],
    example: { thread: THREAD, host: 'adminhub-prod', command: 'df -h /var/lib/docker' },
    redFlag: 'Running a command where a check or a read the room grants answers the same.',
    family: 'room.diagnose',
    audience: ['bot'],
    scenarios: ['a command refused for a grant the room does not hold'],
  },
  owner_consent: {
    purpose:
      'Records, in the owner’s own room, that he agreed to this room acting as him in a product, or took it back.',
    situations: [
      {
        when: 'the owner says in his own room that you may act as him in a product, or no longer',
        do: 'support.owner_consent citing his message, decision give or withdraw, and the product as tools lists it',
      },
    ],
    practice: ['Read his meaning in his own words, in any language.'],
    example: { thread: THREAD, message: MESSAGE, decision: 'give', product: 'adminhub' },
    // agent-is-the-voice: a plain agreement is consent, never a code handshake
    redFlag: 'Asking the owner to type a set word to consent: his plain words are his agreement.',
    family: 'room.owner',
    audience: ['bot'],
    scenarios: ['the owner asked to type a set word before an act runs as him'],
  },
  owner_act: {
    purpose:
      'Makes an owner act in his product, as him, while his consent stands, from his own room.',
    situations: [
      {
        when: 'the owner asks in his own room for an act tools lists as kind owner',
        do: 'support.owner_act naming his message, the tool and its args, and tell him the product’s answer',
        watch: 'SUPPORT_OWNER_SIGN_IN_AGAIN: give him the link support.owner_sign_in hands you',
      },
    ],
    practice: ['Forge makes the call with his credential, which you never see.'],
    example: {
      thread: THREAD,
      message: MESSAGE,
      tool: 'site_publish',
      args: { site: 'mowmentbrand-pxl' },
    },
    redFlag: 'Making an owner act from any room but his own, or one he did not ask for in it.',
    family: 'room.owner',
    audience: ['bot'],
    scenarios: ['the owner told to fill the MangoTee lines himself'],
  },
  owner_sign_in: {
    purpose: 'Starts the owner’s sign-in to a product, handing you the link to give him.',
    situations: [
      {
        when: 'an owner act answered that his credential ended, or he has none kept',
        do: 'support.owner_sign_in { thread, product } and give him the link in your own words',
      },
    ],
    practice: [
      'His confirmation in the product records his consent, so owner_act works from then on.',
    ],
    example: { thread: THREAD, product: 'adminhub' },
    redFlag: 'Asking the owner for a password or token instead of giving him the sign-in link.',
    family: 'room.owner',
    audience: ['bot'],
    scenarios: ['the owner asked for another token for forge-ops'],
  },
  projects: {
    purpose:
      'Lists the projects in this operations room’s scope, each with its slug and issue prefix.',
    situations: [
      {
        when: 'a member names work in a project you have not read yet',
        do: 'read support.projects {} and name the project by its slug in the next read',
      },
    ],
    practice: ['A project outside the scope is refused: hand it on with support.ask_master.'],
    example: {},
    redFlag: 'Explaining a project outside the room’s scope instead of handing it on.',
    family: 'room.facts',
    audience: ['bot'],
    scenarios: ['asking which project instead of reading the room’s projects'],
  },
  requirements: {
    purpose:
      'Reads a project’s requirements in this room’s scope, with state and whom each waits on.',
    situations: [
      {
        when: 'a member asks what a project is meant to do, or which requirement waits on whom',
        do: 'read support.requirements { project } and answer from each requirement’s state and progress',
      },
    ],
    practice: ['Name a requirement by its key and title as the member reads it.'],
    example: { project: 'epod' },
    redFlag: 'Drafting a requirement for a wish a listed requirement already covers.',
    family: 'room.facts',
    audience: ['bot'],
    scenarios: [
      'the Google-connect requirement named by its key and title',
      'a person-facing link on the API host',
    ],
  },
  move: {
    purpose: 'Moves an issue of a project in this room’s scope as the member whose message asked.',
    situations: [
      {
        when: 'a member asks you to move an issue, and your role is granted deliver',
        do: 'support.move naming their message, the issue, its project, the status and their reason',
      },
    ],
    practice: ['Never say it moved until the act answered that it did.'],
    example: {
      thread: THREAD,
      message: MESSAGE,
      issue: 'ISS-167',
      to: 'reopen',
      reason: 'The export still drops the size column.',
      project: 'epod',
    },
    redFlag:
      'Naming a message someone else wrote: the act runs as the asker, never as another writer in the thread.',
    family: 'room.work',
    audience: ['bot'],
    scenarios: ['an issue moved for a member only once the act answers it moved'],
  },
  draft_requirement: {
    purpose:
      'Drafts a requirement in a scoped project as the member who asked; a person then decides it.',
    situations: [
      {
        when: 'a member asks for new behaviour no requirement covers, and your role is granted draft',
        do: 'read support.requirements first, then support.draft_requirement naming their message, the project, a title and a summary',
      },
    ],
    practice: ['A draft decides nothing: the requirement is agreed by the people who agree it.'],
    example: {
      thread: THREAD,
      message: MESSAGE,
      project: 'epod',
      title: 'Reorder a past order',
      summary: 'A store manager reorders a past order in one tap.',
    },
    redFlag:
      'Telling the member the requirement is agreed or planned: it is a draft until a person decides it.',
    family: 'room.work',
    audience: ['bot'],
    scenarios: ['a requirement drafted and told as waiting on the owner, not agreed'],
  },
  draft_feedback: {
    purpose:
      'Drafts a feedback item in a scoped project as the member who asked, on a requirement, an issue or a screen.',
    situations: [
      {
        when: 'a member reports a defect, a wish or a request, and your role is granted draft',
        do: 'support.draft_feedback naming their message, the project, its kind, a title, a summary and the requirement, issue or screen it is about',
      },
    ],
    practice: ['Name one target: the requirement, the issue or the screen it concerns.'],
    example: {
      thread: THREAD,
      message: MESSAGE,
      project: 'epod',
      kind: 'defect',
      title: 'Export loses the size column',
      summary: 'The order export has no size column since this morning.',
      screen: 'the order export page',
    },
    redFlag:
      'Drafting a second item for what the member’s thread already filed: read support.feedback first.',
    family: 'room.work',
    audience: ['bot'],
    scenarios: ['the owner’s two ePOD wishes drafted by a role not granted draft (FB-699)'],
  },
  research: {
    purpose:
      'Reads one public web page for a member’s question, when your role is granted research.',
    situations: [
      {
        when: 'a member’s question needs one public page read, such as a provider’s documentation',
        do: 'support.research { thread, url } and answer from what it read, naming the page',
      },
    ],
    practice: ['A page that is not public, or not a web page, is refused OPS_RESEARCH_REFUSED.'],
    example: { thread: THREAD, url: 'https://shopify.dev/docs/api/admin-rest' },
    redFlag: 'Researching the open web while the project names reference sources for that area.',
    family: 'room.work',
    audience: ['bot'],
    scenarios: ['supplier API docs asked for, the public pages never read'],
  },
} satisfies Partial<Record<SupportAction, CapabilityCardBody>>;
