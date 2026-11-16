// project_feedback's capability cards (ISS-1251), apart from the tool only for its length. Written
// from how product clients and channel agents used the door: the single target of FB-598 and
// ISS-559, the submit a guide misnamed create (ISS-861), the approved screenshots of FB-474, and the
// channel agent's reads of ISS-1091 and ISS-1093. progress and similar carry no card: nothing records
// a use of them (the no-use list of ISS-1251 names what each could become).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { ACTIONS } from './feedback-tool.js';

const CHANGED = { on: '2026-11-16', by: 'ISS-1251' } as const;

/** When a person's client or a room's agent reaches for a project's feedback door. */
export const CARDS = {
  list: {
    purpose: 'Lists a project’s feedback items with their phase, whom each waits on and progress.',
    situations: [
      {
        when: 'a person asks what users reported, or what became of the reports on a requirement',
        do: 'list with phase, q or requirement as they asked, and tell each item’s `progress.says`',
      },
      {
        when: 'someone asks whether what they report was already filed',
        do: 'list with q on its words and name the item that matches before filing another',
      },
    ],
    practice: [
      'Repeat `progress.says`, never a date the block does not hold.',
      'Feedback about Forge itself is the feedback door’s (feedback.list), not this one.',
    ],
    example: { projectId: '<project uuid>', phase: ['new', 'reopened'] },
    audience: ['person', 'bot'],
    changed: CHANGED,
  },
  get: {
    purpose:
      'Reads one feedback item whole: its body, route, decisions, open clarification and progress.',
    situations: [
      {
        when: 'a requester asks what became of what they reported, or you are told it shipped',
        do: 'get it by its key and tell them its phase, what its route says and `progress.says`',
      },
      {
        when: 'a list or a page shows an item in a phase that its work contradicts',
        do: 'get it and answer from its own read, which follows the work it was routed to',
      },
    ],
    practice: [
      'Name it by its key, FB-12; a project holding no such key answers NOT_FOUND.',
      'Its attachments are listed here; uploads.fetch reads one.',
    ],
    example: { projectId: '<project uuid>', feedback: 'FB-12' },
    audience: ['person', 'bot'],
    changed: CHANGED,
  },
  submit: {
    purpose: 'Files what a person reports or wishes about the project’s product, at phase new.',
    situations: [
      {
        when: 'a person reports something broken or wrong in the product, or relays what a user reported',
        do: 'submit it as a bug in their words, its target the requirement it touches, found with requirements.similar',
      },
      {
        when: 'the report touches no requirement, issue, release, design or endpoint',
        do: 'name the screen it was met on in words as its target, and leave whereSeen out',
      },
      {
        when: 'what they report is about Forge itself, not their project’s product',
        do: 'send it to the feedback door (feedback.submit) instead',
        // ISS-538: a client met two feedback doors and a refusal pointing at the wrong one
        watch:
          'filed here, a Forge defect lands on the project’s own board, where Forge’s team does not triage it',
      },
    ],
    practice: [
      'The target is one { kind, ref }: a requirement REQ-n is best, else an issue, a release, a workflow or a screen.',
      'Triage is not done here: the project’s master routes the item to its work.',
    ],
    example: {
      projectId: '<project uuid>',
      kind: 'bug',
      title: 'Reorder leaves the cart empty',
      body: 'Tapping Reorder on a past order shows an empty cart.',
      target: { kind: 'screen', ref: 'order history page' },
    },
    // FB-598 and ISS-559: clients filled several target fields, or named the target as a loose field,
    // and were refused FEEDBACK_TARGET_NOT_ONE; ISS-861: a guide sent clients to project_feedback.create
    redFlag:
      'Naming the target as its own field (screen: …, requirement: …) or naming two, or calling create: the action is submit, with one target { kind, ref }.',
    audience: ['person'],
    changed: CHANGED,
  },
  clarify: {
    purpose:
      'Asks an item’s reporter one question, with the answer you recommend for them to send by one click.',
    situations: [
      {
        when: 'an item does not say enough to tell what is wrong or wanted, and only its reporter knows',
        do: 'clarify with the question, what would settle it in needed, and the answer you think likely in recommended',
      },
    ],
    practice: [
      'Ask each question its own call; the answer never edits the item.',
      'Only an item at new or reopened takes one: past triage it is FEEDBACK_CLARIFICATION_CLOSED.',
    ],
    example: {
      projectId: '<project uuid>',
      feedback: 'FB-12',
      prompt: 'Which browser showed the empty cart?',
      needed: 'the browser and its version',
      recommended: 'Chrome on Android',
    },
    audience: ['person'],
    changed: CHANGED,
  },
  attach: {
    purpose:
      'Attaches a file to an existing feedback item, such as a screenshot or an approved mockup.',
    situations: [
      {
        when: 'an item is to be built against designs a person approved, and the images are not on it',
        do: 'attach each image to the item with label approved_design, then get it to read them back',
      },
      {
        when: 'a person sends a screenshot or recording that shows what an item reports',
        do: 'attach it to that item, so its triage and its builder read it',
      },
    ],
    practice: [
      'The bytes go base64 in contentBase64; the type and size limits are an issue attachment’s.',
      'Say redacted: true only where nothing personal shows in it: on a redact project a model reads no other.',
    ],
    example: {
      projectId: '<project uuid>',
      feedback: 'FB-12',
      name: 'order-history-approved.png',
      mime: 'image/png',
      contentBase64: 'iVBORw0KGgo=',
      label: 'approved_design',
    },
    audience: ['person'],
    changed: CHANGED,
  },
} satisfies Partial<Record<(typeof ACTIONS)[number], CapabilityCardBody>>;
