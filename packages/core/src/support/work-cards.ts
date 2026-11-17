// The capability cards of the acts a room agent does the work by (ISS-1251): diagnosing, proposing
// and filing with a person's consent, reading the tracker and production, and making the owner's
// Forge acts as him. Beside `room-cards.ts`; `act-cards.ts` declares both on forge_support. Written
// from the room actions of 01/11-15/11 (208 records filed, 209 agreements cited, 230 diagnoses, 28
// check results) and the issues their misuses were filed as.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { SupportAction } from './act-cards.js';

const THREAD = 'w2NZNL75fXT83G3WB';
const MESSAGE = 'pX4cQe9TnB2wLs7Rk';

export const WORK_ACT_CARDS = {
  run: {
    purpose:
      'Runs a diagnose check this room grants and hands you what came back; the thread is shown nothing.',
    situations: [
      {
        when: 'something is reported broken',
        do: 'diagnose it with support.run on a check support.tools lists before you say what it is; a diagnose posts nothing',
      },
    ],
    practice: [
      'Say only what the check confirmed; name what you could not check as unchecked, never as a guess.',
      'Each check is recorded on its action, so your answer is the only post the asker sees.',
    ],
    example: { thread: THREAD, tool: 'runs_list', args: { status: 'failed' } },
    redFlag:
      'Saying what is wrong before a check confirmed it, or giving what you could not check as a guess.',
    family: 'room.diagnose',
    audience: ['bot'],
    scenarios: ['a cause stated before any check: “this is a defect for the technical team”'],
  },
  read: {
    purpose:
      'Runs a production read the room’s grant declares, by name and parameters, read-only; you get what it printed, scrubbed.',
    situations: [
      {
        when: 'a problem needs production logs or data to find its cause',
        do: 'run a read your brief lists with support.read { name, args, thread }, naming the thread it answers or the check it serves',
      },
    ],
    practice: [
      'Pick from the reads your brief lists: an undeclared read is refused SUPPORT_READ_UNDECLARED, an argument outside its pattern SUPPORT_READ_ARGS.',
    ],
    example: { name: 'orders_by_code', args: { code: 'RIV-68493' }, thread: THREAD },
    // ISS-1243 item 11: the adminhub bot said it could not read Catalog's logs or data (13/11 02:43),
    // though catalog-api is a project it follows
    redFlag:
      'Telling a thread you cannot read logs or data before trying the reads your brief lists.',
    family: 'room.diagnose',
    audience: ['bot'],
    scenarios: ['Catalog’s logs said unreadable though catalog-api is a followed project'],
  },
  propose_fix: {
    purpose:
      'Proposes a fix this room grants for the person who asked; it runs only once they agree in their own words.',
    situations: [
      {
        when: 'a fix the room grants would solve what someone reported',
        do: 'support.propose_fix { thread, tool, args, asker } naming them (`from.id`), ask them in your own words, and cite their answer with support.agree',
      },
    ],
    practice: ['Nothing runs and nothing is posted until agree cites their answer.'],
    example: {
      thread: THREAD,
      tool: 'order_resync',
      args: { order: 'RIV-68493' },
      asker: 'Yt8kWq3NcRe5HmP2v',
    },
    redFlag:
      'Telling the thread a fix is done, or on its way, before the asker’s own yes is cited with support.agree.',
    family: 'room.diagnose',
    audience: ['bot'],
    scenarios: ['a decider asked to say ok before her own request was filed: ISS-1229'],
  },
  record: {
    purpose:
      'Proposes filing work for the team as Feedback on the project that owns it; the asker’s own request is their agreement.',
    situations: [
      {
        when: 'work is for the team (a defect, a feature or a request)',
        do: "support.record on the project that owns it, citing the asker's own request with support.agree; post its result once you are told it, never before",
      },
      {
        when: 'you lack a tool, a read, a fact or an ability',
        do: 'record it as a request with support.record { kind: request, project } for the master of the project that owns it, and post one reply that it went to the team',
      },
    ],
    practice: [
      'Name the owning project as `project`: without it the item lands in your home project and its master never sees it.',
      'Never post progress and never promise a date; you are told once it is answered, shipped or declined.',
    ],
    example: {
      thread: THREAD,
      kind: 'defect',
      title: 'Order export drops the size column',
      summary: 'Exports since 14/11 carry no size column; seen on order RIV-68493.',
      project: 'adminhub-api',
    },
    // ISS-1229 and ISS-1243 item 17: AdminHub-Support asked the feature decider and the owner to say
    // "ok" before filing what their own request asked for, 11 times in 03/11-15/11
    redFlag:
      'Asking the asker to say ok before filing what their own request asked for: cite that request with support.agree at once.',
    family: 'room.consent',
    audience: ['bot'],
    scenarios: ['the feature decider asked to reply “ok” before her own request is filed'],
  },
  agree: {
    purpose:
      'Cites a person’s own message as their answer to a proposal, so Forge runs or files it and tells you what came of it.',
    situations: [
      {
        when: 'a change would run (support.propose_fix, a build, a deploy, a command) or a record waits on its asker',
        do: "propose it, and cite the person's plain yes, or the asker's own request, with support.agree { thread, proposal, message }; never claim it ran until agree says so",
      },
      {
        when: 'the person said no',
        do: 'support.agree with decision decline, citing their message, and tell them it will not run',
      },
    ],
    practice: [
      'Any words of their own agree; never ask anyone to type a set word.',
      'A refusal names why and the proposal stands: once that is put right, cite the same answer again.',
    ],
    example: { thread: THREAD, proposal: 'K7QX2M', message: MESSAGE },
    // ISS-1000 and ISS-1243 item 17: a named decider's own request was refused as agreement, so the
    // bot asked her to say ok again
    redFlag:
      'Asking the owner or a named decider to agree to what they asked for themselves: their own request is the agreement.',
    family: 'room.consent',
    audience: ['bot'],
    scenarios: ['a decider’s own request refused as agreement: SUPPORT_AGREEMENT_BEFORE_PROPOSAL'],
  },
  check_result: {
    purpose:
      'Answers a scheduled check you were handed with one finding, posted in the channel’s report thread, or with nothing.',
    situations: [
      {
        when: 'you are handed a scheduled check (its thread is the check)',
        do: 'support.check_result { check, finding }: one finding in your words, or null when nothing needs saying',
      },
    ],
    practice: ['One result per check; it never posts at the top level.'],
    example: {
      check: 'check:stock-sync:2026-11-16',
      finding: 'The 06:00 stock sync left 12 SKUs unmatched, all from the new supplier sheet.',
    },
    redFlag:
      'Posting a finding at the top level, or one result per detail: a check takes one finding, or null.',
    family: 'room.diagnose',
    audience: ['bot'],
    scenarios: ['a morning check with nothing to say answered null'],
  },
  releases: {
    purpose:
      'Reads a project’s releases: what each holds, where it is live, and what holds a draft and whose approval it waits on.',
    situations: [
      {
        when: 'you would say done, fixed, live or released',
        do: 'say it only once it is live and you checked each thing asked on the running product in this turn (support.releases, support.deployment, a read or a diagnose); name each one not done yet',
      },
      {
        when: 'someone asks why a release has not shipped',
        do: "answer from support.releases' `holds` for it: whose act it waits on and since when, and each issue not ready and why",
      },
    ],
    practice: [
      'Quote the version it returns; a claim of what is live with no read in the same turn is refused.',
    ],
    example: { project: 'adminhub-api' },
    // ISS-1123 and ISS-1189: a release said live, or said missing, from memory with no read in the
    // turn; ISS-1243: MangoTee rules told live on 12/11 were not built
    redFlag: 'Saying a release is or is not live with no release read in that turn.',
    family: 'room.live',
    audience: ['bot'],
    scenarios: ['a release said live with no release read: SUPPORT_LIVE_CLAIM_UNREAD'],
  },
  deployment: {
    purpose:
      'Reads a granted deploy target’s latest deployment: its status, when, and the revision it runs.',
    situations: [
      {
        when: 'a merge or a deploy should have reached a target your grant names',
        do: 'read support.deployment { target } and say what it reads, quoting the revision',
      },
    ],
    practice: ['Name the target as your grant lists it.'],
    example: { target: '6f1c2a0e-5b7d-4c1e-9a3f-2d8e4b6c7a10' },
    redFlag:
      'Saying a merge reached a target without quoting the revision its latest deployment reads.',
    family: 'room.live',
    audience: ['bot'],
    scenarios: ['a fix on the production branch, its deploy unread'],
  },
  project: {
    purpose:
      'Reads the project document of your project or one you follow: its source, environments and their deploy bindings.',
    situations: [
      {
        when: 'someone asks what the product runs where, or which environments it has',
        do: 'read support.project { project } and answer from it; where it does not say, say you cannot tell',
      },
      {
        when: 'the owner asks to change the project document',
        do: 'read it with support.project, make his change, and pass it whole with its revision to support.owner_forge_act',
      },
    ],
    practice: ['Never read a box file, a key or a host for what the document holds.'],
    example: { project: 'orbit' },
    // ISS-775: four OrbitInternal duties named a box file, key or production host instead of a door
    redFlag: 'Reading a box file or a production host for what the project document says.',
    family: 'room.facts',
    audience: ['bot'],
    scenarios: ['OrbitInternal duties naming a box file or production host: ISS-775'],
  },
  issues: {
    purpose:
      'Reads a project’s issues, with who owes what on a parked one; one issue by key carries its latest notes and handoffs.',
    situations: [
      {
        when: 'someone asks how a piece of work is going',
        do: "read support.issues { project, key } and answer from its notes and handoffs; a parked issue's `waiting` says who owes what",
      },
    ],
    practice: ['It reads the same from any of your groups, over every project you follow.'],
    example: { project: 'epod', key: 'ISS-167' },
    redFlag:
      'Answering how work goes from an issue’s status alone, where its notes, handoffs and `waiting` say who owes what.',
    family: 'room.facts',
    audience: ['bot'],
    scenarios: ['an issue’s state told from its notes and handoffs, the latest round named'],
  },
  feedback: {
    purpose:
      'Reads a project’s feedback, newest first, each item with where it stands, or one item by its key.',
    situations: [
      {
        when: 'someone asks where a feedback item, or a report they made, stands',
        do: 'read support.feedback { project, key } and tell them where it stands, in plain words',
      },
    ],
    practice: ['A project of your reach only; one outside it is refused OPS_OUT_OF_SCOPE.'],
    example: { project: 'epod', key: 'FB-40' },
    // ISS-1243, Forge-Communicate 15/11 15:35 and 18:40: asked for ePOD's feedback, the bot said the
    // room may not read it and named a settings change that does not exist
    redFlag:
      'Telling the owner the room cannot read feedback: on 15/11 the bot said so and named a settings change that does not exist.',
    family: 'room.facts',
    audience: ['bot'],
    scenarios: ['the room told it cannot read feedback, and that no master is on'],
  },
  link: {
    purpose:
      'Tells whether a member’s chat account is linked to a Forge account, and hands the page to give them where it is not.',
    situations: [
      {
        when: 'a member asks how to link their chat account to Forge, or what they ask you to do as them needs their account',
        do: 'support.link { thread, member } with their `from.id`, and give them the page it hands you, which they open signed in to Forge',
      },
    ],
    practice: ['You are told when they have linked: make the act then.'],
    example: { thread: THREAD, member: 'Yt8kWq3NcRe5HmP2v' },
    redFlag: 'Making the act as a member before you are told they linked.',
    family: 'room.record',
    audience: ['bot'],
    scenarios: ['the owner’s answer unrecorded: his chat account linked to no Forge account'],
  },
  release_decision: {
    purpose:
      'Records a person’s plain word on a named release, approve or return, as their own decision, citing their message.',
    situations: [
      {
        when: 'a person says go, or no with why, on a named release, in any words',
        do: 'record it at once with support.release_decision { thread, message, project, version, decision }, reading the version from their words and support.releases',
      },
    ],
    practice: [
      'Never answer with “approve it on the web”; an approval by a project admin also stands for the production deploy it plans.',
    ],
    example: {
      thread: THREAD,
      message: MESSAGE,
      project: 'adminhub-api',
      version: '0.19.0',
      decision: 'approve',
    },
    // ISS-1206: on 10/11 adminhub-api 0.19.0 asked the owner a third time after he approved it in
    // his room ("is it making more work for me, when I already approved?")
    redFlag:
      'Asking the owner again, or to click, after he said go: adminhub-api 0.19.0 asked him three times on 10/11.',
    family: 'room.live',
    audience: ['bot'],
    scenarios: ['adminhub-api 0.19.0 asked of the owner three times after he approved'],
  },
  owner_forge_act: {
    purpose:
      'Makes the Forge act the owner asks for in chat (accept, approve, cut, mark merged, change config) as him, citing his message.',
    situations: [
      {
        when: 'the owner asks you, in any words, for a Forge act, or settles one you put to him',
        do: 'make it at once with support.owner_forge_act { thread, message, project, act, item } as him; never answer with a page to open or a button to press',
      },
    ],
    practice: [
      'config.write and binding.write take the whole document: read it, make his change, pass it with the revision you read as baseRevision.',
    ],
    example: {
      thread: THREAD,
      message: MESSAGE,
      project: 'epod',
      act: 'requirement.accept',
      item: 'REQ-11',
    },
    // ISS-1250, 16/11 03:15: the bot told the owner to press "Add varnish to the forge-ops deploy
    // job" to close a question it could have closed as him
    redFlag:
      'Telling the owner to press a button to settle something he just decided: on 16/11 the bot sent him to click an answer it could record as him.',
    family: 'room.owner',
    audience: ['bot'],
    scenarios: ['a question the owner owes sent to him to click, after the work settled it'],
  },
} satisfies Partial<Record<SupportAction, CapabilityCardBody>>;
