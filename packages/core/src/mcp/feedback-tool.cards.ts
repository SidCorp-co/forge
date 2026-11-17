// project_feedback's capability cards (ISS-1251), apart from the tool only for its length. Written
// from how product clients and channel agents used the door: the single target of FB-598 and
// ISS-559, the submit a guide misnamed create (ISS-861), the approved screenshots of FB-474, and the
// channel agent's reads of ISS-1091 and ISS-1093; progress and similar from the door's own
// description and the duplicates a triage files (FB-520 was filed beside ISS-1005).

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { ACTIONS } from './feedback-tool.js';

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
    redFlag: 'Filing another item for what list with q already holds.',
    family: 'project-feedback',
    audience: ['person', 'bot'],
    scenarios: ['a person asking what users reported on a requirement'],
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
    redFlag:
      'Telling a requester an item’s phase from a list row, where its own read follows the work it was routed to.',
    family: 'project-feedback',
    audience: ['person', 'bot'],
    scenarios: ['a requester asking what became of FB-n, answered from its own read'],
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
    redFlag:
      'Asking several questions in one call, or asking the reporter what the item already says.',
    family: 'project-feedback',
    audience: ['person'],
    scenarios: ['a feedback item clarified with several questions in one call'],
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
    redFlag: 'Saying redacted: true on an image where something personal shows.',
    family: 'project-feedback',
    audience: ['person'],
    scenarios: ['approved design images attached so the item’s builder reads them: ISS-879'],
  },
  progress: {
    purpose:
      'Reads how the work an item was routed to goes: runs, whom it waits on and an estimate.',
    situations: [
      {
        when: 'a requester asks when what they reported will be fixed',
        do: 'read progress and tell them `progress.says`',
      },
    ],
    practice: ['eta is an estimate with its basis, or the reason no date can be given.'],
    example: { projectId: '<project uuid>', feedback: 'FB-12' },
    redFlag: 'Promising a requester a date the block does not hold.',
    family: 'project-feedback',
    audience: ['person', 'bot'],
    scenarios: ['a requester asking when their report will be fixed'],
  },
  similar: {
    purpose: 'Finds the feedback items nearest one item, to spot a duplicate before it is triaged.',
    situations: [
      {
        when: 'you triage an item and it may report what another already does',
        do: 'call similar on it and route it with the item it duplicates',
      },
    ],
    practice: [
      'not_embedded, provider_not_configured, failed or withheld_by_policy does not mean none is similar.',
    ],
    example: { projectId: '<project uuid>', feedback: 'FB-12' },
    // FB-520 was filed as a duplicate of ISS-1005, the similar read never taken
    redFlag:
      'Triaging an item into new work without reading similar, or reading a withheld answer as none similar.',
    family: 'project-feedback',
    audience: ['person'],
    scenarios: ['FB-520 filed as a duplicate of ISS-1005, the similar read never taken'],
  },
} satisfies Partial<Record<(typeof ACTIONS)[number], CapabilityCardBody>>;
