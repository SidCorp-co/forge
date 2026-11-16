// The capability cards of the feedback doors a project's master calls over REST to triage, move and
// settle what its users report (ISS-1251), beside their routes (`routes.ts`), keyed by the door as the
// published contract lists it and built into the door catalog by `mcp/rest-cards.ts`. Filing, asking
// the reporter and attaching are forge_project_feedback's, so their REST twins carry no second card.
// Written from the feedback-triage guide, the owner's rulings that a master triages and confirms
// without parking on a person, and the triages, confirms and waits on forge's issues.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const FEEDBACK_REST_CARDS = {
  'POST /api/projects/:id/feedback/:fb/triage': {
    purpose:
      'Triages a feedback item in one act: the checklist’s answers and the route that carries it.',
    situations: [
      {
        when: 'a new or reopened item of your project waits on triage',
        do: 'reproduce it, read its similar items and open issues, then triage with criterion, severity, reproduced and the route',
        watch: 'a bare yes or no as reproduced is refused FEEDBACK_REPRODUCTION_EMPTY',
      },
      {
        when: 'an open issue already does the work the item asks for',
        do: 'route it to issue naming that issue, never a new draft beside it',
      },
      {
        when: 'the item asks what the product already does, or repeats another item',
        do: 'route answer with the text the reporter reads, or duplicate with duplicateOf',
      },
      {
        when: 'triage is refused PERMISSION_FORBIDDEN because a person routes on this project',
        do: 'propose it as a feedback_triage suggestion with the same answers',
      },
    ],
    practice: [
      'One item, as few issues as do the whole job, often one.',
      'An answer to a reopened item names the reopen it answers in inReplyTo.',
      'A decline is triage with route decline and a note the reporter reads.',
    ],
    example: {
      route: 'issue',
      answers: {
        criterion: 'REQ-12 BC-3',
        severity: 'high',
        reproduced:
          'Reordered a past order with one sold-out line on 0.4.0-dev.690: the whole reorder failed.',
      },
      createIssue: {
        title: 'Reorder fails whole when one line is sold out',
        priority: 'high',
      },
    },
    // FB-520 was filed as a duplicate of ISS-1005 without reading similar items first; ISS-1132: under
    // yolo new feedback sat in the owner's queue, never routed by the master
    redFlag:
      'Filing a new issue without reading the item’s similar items and open issues, or leaving triage to the owner.',
    family: 'project-feedback',
    audience: ['master'],
  },
  'POST /api/projects/:id/feedback/:fb/retarget': {
    purpose:
      'Moves a feedback item to the requirement, issue, design or endpoint it is really about.',
    situations: [
      {
        when: 'an item filed against a screen turns out to be about a requirement that now records its rule',
        do: 'retarget it to that requirement with the reason; the screen stays as where it was seen',
      },
    ],
    practice: ['Exactly one target, with your reason; it works at any phase.'],
    example: { requirement: 'REQ-12', reason: 'REQ-12 BC-3 now records the reorder rule.' },
    // ISS-264: items about a screen could not move to the requirement that later recorded their rule
    // forge, 2026-10-17..11-16: 1 of 11 retargets refused; ISS-264's items had been refiled instead
    redFlag: 'Filing a second item about the requirement instead of moving this one to it.',
    family: 'project-feedback',
    audience: ['master'],
  },
  'POST /api/projects/:id/feedback/:fb/verify': {
    purpose: 'Confirms a resolved feedback item is fixed for its reporter, saying what was seen.',
    situations: [
      {
        when: 'your pass names a shipped item an agent of your project reported',
        do: 'check the fix on the running build, then verify with a note of what you ran and saw',
        watch: 'an item about Forge itself is verified at POST /api/forge/feedback/:key/verify',
      },
      {
        when: 'a resolved item waits on a holder of feedback.approve after its verify window',
        do: 'verify it on what the running build shows, or reopen it saying what is still wrong',
      },
    ],
    practice: [
      'Only after it reads resolved; a carrier whose criterion last failed verifies nothing.',
    ],
    example: {
      note: 'On 0.4.0-dev.690 a reorder with a sold-out line fills the cart with the rest.',
    },
    // ISS-311: verified items said nothing of what was done and seen on which version
    redFlag:
      'Verifying from the record alone, without running the fix on the build that serves it.',
    family: 'project-feedback',
    audience: ['master'],
  },
  'POST /api/projects/:id/feedback/:fb/reopen': {
    purpose: 'Sends a resolved item back to triage, saying what its fix does not answer.',
    situations: [
      {
        when: 'the shipped fix does not do what the item asked on the running build',
        do: 'reopen it with what you ran and what still goes wrong',
      },
    ],
    practice: ['The next triage answer names this reopen in inReplyTo.'],
    example: {
      reason:
        'On 0.4.0-dev.690 a reorder with a sold-out line still fails when that line is the first.',
    },
    // the door refuses a reopen that says nothing (FEEDBACK_REOPEN_REASON_REQUIRED)
    redFlag: 'Reopening with “still broken” and nothing of what you ran or saw on the running build.',
    family: 'project-feedback',
    audience: ['master'],
  },
  'POST /api/projects/:id/feedback/:fb/confirm-wait': {
    purpose:
      'Records that a shipped item’s confirm waits on a later event, so the pass stops naming it until then.',
    situations: [
      {
        when: 'a fix an agent reported can only be tested by an event still to come (a nightly job, a room’s next message)',
        do: 'set the wait with the date or on room_message, and the reason',
        watch:
          'an item about Forge takes the same body at POST /api/forge/feedback/:key/confirm-wait',
      },
    ],
    practice: [
      'until is within 30 days; a verify or reopen clears it, and a reopened carrier ends it at once.',
    ],
    example: {
      until: '2026-11-20T02:00:00+07:00',
      reason: 'The fix is in the nightly stock sync; its first run after the release tests it.',
    },
    // ISS-902 (FB-480): with no wait on the record, the confirm nudge repeated on every master pass
    redFlag:
      'Verifying before the event that tests the fix happened, or letting the confirm nudge repeat every pass.',
    family: 'project-feedback',
    audience: ['master', 'run'],
  },
  'POST /api/projects/:id/feedback/:fb/snooze': {
    purpose: 'Parks a new or reopened item out of New until a date, saying why.',
    situations: [
      {
        when: 'an item cannot be triaged until something known happens (a release, a reporter back from leave)',
        do: 'snooze it until that date with the reason; it is New again by itself after',
      },
    ],
    practice: ['Within a year; triaging it lifts the snooze.'],
    example: {
      until: '2026-11-25T09:00:00+07:00',
      reason: 'The reporter re-tests after the 1.31 release on 2026-11-24.',
    },
    // forge: 1 of 2 snoozes refused; a date past or a year out is refused (FEEDBACK_SNOOZE_PAST,
    // FEEDBACK_SNOOZE_TOO_FAR)
    redFlag: 'Snoozing an item to dodge its triage, with no event the date waits on.',
    family: 'project-feedback',
    audience: ['master'],
  },
  'POST /api/projects/:id/feedback/:fb/messages': {
    purpose:
      'Sends the item’s reporters a message in your own words, or keeps an internal note on it.',
    situations: [
      {
        when: 'a reporter should hear what changed for them or what they need to do',
        do: 'preview at …/messages/preview, then send the same body to reporter or all_reporters',
      },
      {
        when: 'members should read a note about the item that no reporter sees',
        do: 'send it with audience internal',
      },
    ],
    practice: [
      'Plain words in the reporter’s language: what changed for them, never ids, codes or shas.',
    ],
    example: {
      audience: 'reporter',
      text: 'Reorder now adds every item still in stock to your cart and tells you which one sold out.',
    },
    // bots-answer-users-by-name and agent-is-the-voice: core composes no notice for the agent
    redFlag: 'Writing an issue key, an error code or a table name to a reporter.',
    family: 'project-feedback',
    audience: ['master'],
  },
  'POST /api/projects/:id/feedback/:fb/verify-ask': {
    purpose:
      'Puts a resolved item back on its reporter’s bell, asking them to verify or reopen it.',
    situations: [
      {
        when: 'a person reported an item, its fix shipped, and they have not answered',
        do: 'ask them again once; it stays on their bell until they verify or reopen',
      },
    ],
    practice: ['You never ask yourself: a reporter verifies their own item instead.'],
    example: {},
    // forge: 10 asks, 9 of them the steward's; the door refuses asking yourself (FEEDBACK_VERIFY_ASK_SELF)
    redFlag: 'Asking the same reporter again each pass: one ask stays on their bell until they answer.',
    family: 'project-feedback',
    audience: ['master'],
  },
  'POST /api/projects/:id/feedback/:fb/tell-shipped': {
    purpose: 'Tells an item’s reporter its fix shipped, where its standing still waits on that relay.',
    situations: [
      {
        when: 'a release shipped an item’s fix and the item’s standing still waits on telling its reporter',
        do: 'tell its reporter with {}; the item asks them to confirm by itself',
      },
    ],
    practice: ['Most items ask their reporter on their own when the release ships: tell only those waiting.'],
    example: {},
    // forge, 2026-10-17..11-16: 7 of the steward's 8 tells were refused, the item not waiting on it
    redFlag: 'Telling every routed item’s reporter after a release, where most ask on their own.',
    family: 'project-feedback',
    audience: ['run'],
  },
  'POST /api/projects/:id/feedback/report': {
    purpose: 'Files the top bar’s one-sentence report and screenshot from the page a person is on.',
    situations: [
      {
        when: 'a person reports from a Forge page with one sentence and a screenshot',
        do: 'send what they said and the page; Forge reads its kind and joins a repeat to its item',
      },
    ],
    practice: ['An agent files feedback with project_feedback.submit and one target, not here.'],
    example: { said: 'Reorder shows the wrong order', whereSeen: '/orders/482' },
    // forge, 2026-10-17..11-16: 5 of 7 reports refused, most from agents that filed through the
    // page's door with no kind on a project no model reads (FEEDBACK_KIND_NEEDED)
    redFlag: 'An agent filing through the page’s report door instead of submit with its target.',
    family: 'project-feedback',
    audience: ['person'],
  },
  'POST /api/projects/:id/feedback/:fb/messages/preview': {
    purpose: 'Shows how a message to an item’s reporters reads before it is sent.',
    situations: [
      {
        when: 'you wrote a message to a reporter and want to see it as they will',
        do: 'preview the same body you will send to …/messages',
      },
    ],
    practice: ['A relay records what was already told and has no preview: send it as it is.'],
    example: { audience: 'reporter', text: 'Reorder now tells you which line sold out.' },
    // forge: all 3 previews refused, each a relay (relayed: true has no preview) or an empty text
    redFlag: 'Previewing a relay (relayed: true), which sends no notice and has nothing to preview.',
    family: 'project-feedback',
    audience: ['master'],
  },
} satisfies Record<string, CapabilityCardBody>;
