// The forge_feedback door's reading and follow-up actions' capability cards (ISS-1251): list, get,
// progress, verify, reopen and reply. `tool.ts:CARDS` spreads them beside submit's and door's.
// Written from how reporters and masters used the door: the confirm nudges of ISS-880, ISS-882 and
// ISS-886, the reopen bounce of ISS-749 and the evidence rule of REQ-66 BC-8.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const FEEDBACK_CARDS: Readonly<Record<string, CapabilityCardBody>> = {
  list: {
    purpose: 'Lists the feedback about Forge you reported, each with its phase and progress.',
    situations: [
      {
        when: 'you reported Forge defects or wants earlier and want to know what became of them',
        do: 'list them and read each one’s phase and `progress.says`',
      },
    ],
    practice: ['Repeat `progress.says`, never a date it does not hold.'],
    example: {},
    audience: ['person', 'master', 'run'],
  },
  get: {
    purpose: 'Reads one item you reported: what its triage told you and, once shipped, its proof.',
    situations: [
      {
        when: 'you are told an item you reported was answered, declined or shipped',
        do: 'get it and read `told` and `shipEvidence` before you act on it',
      },
      {
        when: 'you are a master asked to confirm an item one of your project’s agents reported',
        do: 'get it by its key: an agent reporter’s master reads its items',
        watch: 'an item another account reported answers not found, so it is not yours to confirm',
      },
    ],
    practice: ['Name the item by its key, FB-n.'],
    example: { feedback: 'FB-473' },
    audience: ['person', 'master', 'run'],
  },
  progress: {
    purpose: 'Reads only whether work on an item you reported runs, and when it is likely done.',
    situations: [
      {
        when: 'someone asks whether a Forge fix you asked for is being worked on or when it lands',
        do: 'read its progress and tell them `progress.says`',
      },
    ],
    practice: ['Say the forecast as the range it is, or plainly why there is none.'],
    example: { feedback: 'FB-473' },
    audience: ['person', 'master', 'run'],
  },
  verify: {
    purpose: 'Confirms that a shipped fix to an item you reported holds on the running build.',
    situations: [
      {
        when: 'an item you reported shipped (phase resolved) and its progress waits on you',
        do: 'run what failed against the shipped build, then verify with what you ran and saw',
      },
      {
        when: 'your pass names shipped Forge feedback one of your project’s agents reported',
        do: 'check it on the running build and verify it as that agent’s master, with evidence',
      },
    ],
    practice: [
      'Evidence is what you ran against the shipped build and what you saw; an agent is refused without it.',
    ],
    example: {
      feedback: 'FB-473',
      evidence:
        'Ran forge-runner api forge/feedback/FB-473 on 0.4.0-dev.360: the answer text is shown.',
    },
    // REQ-66 BC-8: an agent's verify without evidence is refused FEEDBACK_EVIDENCE_REQUIRED
    redFlag:
      'Verifying from the release notes or the merge, without running it on the shipped build.',
    audience: ['person', 'master', 'run'],
  },
  reopen: {
    purpose: 'Reopens a shipped item you reported whose fix does not hold on the running build.',
    situations: [
      {
        when: 'you ran an item you reported on the shipped build and the problem is still there',
        do: 'reopen it with what you ran and what you saw, so its next answer addresses that',
      },
    ],
    practice: ['Say what still fails and how you ran it; a reopen goes back to triage.'],
    example: {
      feedback: 'FB-473',
      evidence:
        'On 0.4.0-dev.360 the verify door still answers FORGE_FEEDBACK_NOT_FOUND for FB-473.',
    },
    // ISS-749: reopens answered without anything addressing them bounced between reporter and master
    redFlag: 'Filing a new item for a fix that did not hold, so the old one reads resolved.',
    audience: ['person', 'master', 'run'],
  },
  reply: {
    purpose: 'Answers back once to the answer standing on an item you reported.',
    situations: [
      {
        when: 'an answer to an item you reported leaves part of it open',
        do: 'reply once, saying what it leaves open and what you ran and saw',
      },
    ],
    practice: [
      'One reply per answer: put everything it leaves open in it; the item returns to triage.',
    ],
    example: {
      feedback: 'FB-358',
      evidence: 'The answer covers list, but get still drops the answer text for a reopened item.',
    },
    // ISS-749: a second reply to one answer is FEEDBACK_REPLY_SPENT
    redFlag: 'Replying in pieces: the second reply to one answer is refused.',
    audience: ['person', 'master', 'run'],
  },
};
