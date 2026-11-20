// The capability cards of `forge_channel` (ISS-1251), beside the door in `channel-tool.ts`, which would
// otherwise cross its line budget. Few calls record an agent working a real channel document through
// these actions (forge, 2026-10-17..11-16: 13 inbox reads and 2 document reads, none refused): they
// rest on the situations and rules the ecosystem-inbox guide teaches a master (worked over the REST
// twins from a checkout), on the reads of the chat assistant that holds them in a person's chat, and
// on the refusals each write is built around (`channel-ends.ts`, `channel-holds.ts`,
// `channel-tool-gate.ts`), which name the wrong way to take each.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { ChannelAction } from '@forge/contracts/ecosystem';

/** When an agent reaches for a project's ecosystem channel. */
export const CARDS = {
  unanswered: {
    purpose:
      'Lists the channel documents this project owes a reply to: the inbox work its master takes.',
    situations: [
      {
        when: 'your pass was nudged with channel documents owed, even with an empty backlog',
        do: 'read unanswered and work each number it lists before the pass ends: it is exactly what the sweep counted',
        watch:
          'a pass that ends with the inbox untouched and no word on why is the same deviation as an idle pane',
      },
      {
        when: 'a person asks what another project is waiting on from this one',
        do: 'read unanswered and name each document, its sender and its due date',
      },
    ],
    practice: [
      'A held thread, a non-binding change notice and a reply already waiting at the approve gate owe nothing now, so none is listed.',
      'From a checkout the same read is GET /api/projects/:id/channel/unanswered.',
    ],
    example: { projectId: '<project uuid>' },
    redFlag: 'Ending a pass with the inbox it was nudged about untouched and no word on why.',
    family: 'channel',
    audience: ['master', 'bot'],
    scenarios: ['a pass nudged with channel documents owed, each worked before it ends'],
  },
  inbox: {
    purpose: 'Lists the channel documents published to this project, owed or not.',
    situations: [
      {
        when: 'the owed documents are worked and the pass has room',
        do: 'read inbox for what unanswered leaves out, such as a non-binding change notice about a contract you consume',
      },
      {
        when: 'a person asks what the other projects in the ecosystem have sent this one',
        do: 'read inbox and answer with each document’s number, type and subject',
      },
    ],
    practice: ['Work unanswered first: the inbox adds only what owes no reply yet.'],
    example: { projectId: '<project uuid>' },
    redFlag:
      'Answering a non-binding change notice that owes nothing, ahead of what unanswered lists.',
    family: 'channel',
    audience: ['master', 'bot'],
    scenarios: ['a nudged pass reading the inbox once the owed documents were worked'],
  },
  read: {
    purpose: 'Reads one channel document this project sends or receives, by its number or uuid.',
    situations: [
      {
        when: 'unanswered or the nudge names a document number',
        do: 'read it whole before you decide, then the conversation it opened with thread',
      },
      {
        when: 'a person names a channel document, such as a change notice',
        do: 'read it and answer from its body: what it asks of this project, and by when',
      },
    ],
    practice: [
      'Only a document this project sends or receives is readable; any other is refused as not a party.',
    ],
    example: { projectId: '<project uuid>', ref: 'FP-CN-3' },
    redFlag:
      'Replying from the nudge’s line alone without reading the document and its contract page.',
    family: 'channel',
    audience: ['master', 'bot'],
    scenarios: ['a channel document named by a person, read whole before answering'],
  },
  thread: {
    purpose: 'Reads a whole channel conversation, and any hold on it, from its opening number.',
    situations: [
      {
        when: 'you are about to reply to a channel document',
        do: 'read its thread first: a later document may already answer or supersede it, or a person may hold it',
        watch:
          'a held thread is a person’s: stop, and never release the hold to get your reply through',
      },
    ],
    practice: [
      'Name the number of the document that opened the conversation, not of a reply in it.',
    ],
    example: { projectId: '<project uuid>', thread: 'FP-CN-3' },
    redFlag:
      'Replying without reading the thread, so a held or already answered conversation is answered again.',
    family: 'channel',
    audience: ['master', 'bot'],
    scenarios: [
      'a change notice’s thread read before replying, a hold or a later answer respected',
    ],
  },
  contracts: {
    purpose:
      'Reads a project’s API page: the contracts it publishes and its edges, as its counterparty may see them.',
    situations: [
      {
        when: 'a channel document you must answer is about a provider’s contract',
        do: 'read contracts with project set to the provider before you decide, so the reply speaks to the version it names',
      },
      {
        when: 'a person asks what another project in the ecosystem offers this one',
        do: 'read contracts for that project and answer from its page',
      },
    ],
    practice: [
      'Leave project out to read this project’s own page.',
      'From a checkout the same read is GET /api/projects/<provider>/api-page.',
    ],
    example: { projectId: '<project uuid>', project: '<provider project uuid>' },
    redFlag:
      'Prescribing how the other side should build its contract, where the reply says what this project decided.',
    family: 'channel',
    audience: ['master', 'bot'],
    scenarios: ['an RFI about a provider’s contract answered after reading its API page'],
  },
  reply: {
    purpose: 'Drafts this project’s answer to a published document, addressed to its sender.',
    situations: [
      {
        when: 'you decided how to answer an owed change notice, RFI or change request',
        do: 'reply with inReplyTo its number and the type it owes (a change notice an acknowledgement, an RFI or change request a decision), then submit it',
        watch:
          'a wrong type is refused REPLY_TYPE_NOT_ALLOWED, and a reply to a withdrawn or superseded document REPLY_TO_ENDED: answer the one that stands',
      },
      {
        when: 'the answer needs work in this repository',
        do: 'file that work as an issue, and say in the reply what this project decided, never how the other side should build theirs',
      },
    ],
    practice: [
      'A draft reaches no one: only submit publishes it.',
      'The author is the token; a body naming an author, authoredBy or from is refused.',
    ],
    example: {
      projectId: '<project uuid>',
      inReplyTo: 'FP-CN-3',
      type: 'acknowledgement',
      subject: 'Adapting to the orders field change',
      body: '<the acknowledgement body the parent owes>',
    },
    redFlag:
      'Replying with the wrong type for what the parent owes, or to a withdrawn or superseded document.',
    family: 'channel',
    audience: ['master'],
    scenarios: [
      'a change notice answered with the type it owes, never refused REPLY_TYPE_NOT_ALLOWED',
    ],
  },
  edit: {
    purpose: 'Rewrites a draft, or a document the approve gate returned, before it is submitted.',
    situations: [
      {
        when: 'an admin returned your submitted document at the approve gate, and it is back on unanswered',
        do: 'read the note, edit the document as it asks, and submit it again',
      },
      {
        when: 'a draft you have not submitted is wrong',
        do: 'edit it and submit it',
      },
    ],
    practice: [
      'Send the whole content each time: type, to, subject and body, not only what changes.',
    ],
    example: {
      projectId: '<project uuid>',
      ref: 'FP-ACK-2',
      type: 'acknowledgement',
      to: ['<sender project uuid>'],
      subject: 'Adapting to the orders field change',
      body: '<the whole acknowledgement body, as the note asks>',
    },
    redFlag: 'Sending only the changed field: the edit takes the whole content.',
    family: 'channel',
    audience: ['master'],
    scenarios: ['a document the gate returned edited whole and submitted again'],
  },
  submit: {
    purpose:
      'Publishes a draft to the other side, or puts it to the approve gate where the channel gates its type.',
    situations: [
      {
        when: 'your reply is drafted',
        do: 'submit it: it leaves unanswered at once, published or waiting at the gate',
      },
    ],
    practice: [
      'Waiting at the gate is not published: the other side sees nothing until an admin approves.',
      'From a checkout: POST /api/projects/:id/channel/documents/<doc>/submit.',
    ],
    example: { projectId: '<project uuid>', ref: 'FP-ACK-2' },
    redFlag:
      'Submitting a draft the person has not confirmed, or reading the gate’s wait as published.',
    family: 'channel',
    audience: ['master'],
    scenarios: ['a submitted reply said to wait at the gate until an admin approves'],
  },
  register: {
    purpose:
      'Lists every document of an ecosystem’s channel this project may read, by status and type.',
    situations: [
      {
        when: 'a person asks what has been said between the projects of an ecosystem',
        do: 'read the register, filtered by status or type, and answer from it',
      },
    ],
    practice: ['Your own work is unanswered and inbox; the register is the whole record.'],
    example: { projectId: '<project uuid>', status: 'awaiting', limit: 20 },
    redFlag: 'Working the inbox from the register, where unanswered lists exactly what is owed.',
    family: 'channel',
    audience: ['master', 'bot'],
    scenarios: ['a person’s question about the ecosystem answered from the register'],
  },
  outbox: {
    purpose: 'Lists the documents this project sent, with where each stands.',
    situations: [
      {
        when: 'you need to know whether a document you sent was answered, withdrawn or is still waiting',
        do: 'read the outbox and the thread of the one you need',
      },
    ],
    practice: ['A document waiting at the approve gate is not published yet.'],
    example: { projectId: '<project uuid>' },
    redFlag:
      'Sending a second document because the first has no answer yet, instead of reading its thread.',
    family: 'channel',
    audience: ['master', 'bot'],
    scenarios: ['a sent change request followed in the outbox, never sent twice'],
  },
  draft: {
    purpose:
      'Drafts a new channel document: a change notice, an RFI or a change request to a project.',
    situations: [
      {
        when: 'this project changes a contract others consume, or needs something from another project',
        do: 'draft the document to that project with its type and subject, then submit it once confirmed',
      },
      {
        when: "an issue of this project owes a part another project builds (the API's screen on its front end), and a write there is refused PAT_PROJECT_OUTSIDE_FENCE",
        do: 'send that project a change request through the channel, as this project: the contract the two share, the need and its urgency, then submit; its master owes it a decision and files its own issue',
        watch:
          'handing the part to a person, or filing it on the other project, while a channel links the two',
      },
      {
        when: 'you know the project to write to only by its slug or name',
        do: 'read members, and put its slug in to: to takes each recipient by its slug or uuid, and the draft stores the uuid',
        watch:
          'a name outside members is refused CHANNEL_TO_NOT_MEMBER, which lists who you may address',
      },
    ],
    practice: [
      'An answer to a document is reply, not draft: it carries inReplyTo.',
      'The author is the token; a body naming an author is refused.',
      'A fence refusal on a counterparty names the change request to send; where none links you, it names who links you.',
    ],
    example: {
      projectId: '<project uuid>',
      type: 'change-notice',
      to: ['<consumer project slug>'],
      subject: 'The orders field is renamed in 2.0',
      body: '<what changes, when, and what the consumer must do>',
    },
    redFlag:
      'Drafting a new document to answer one, which leaves the parent owed: reply carries inReplyTo.',
    family: 'channel',
    audience: ['master'],
    scenarios: [
      'an RFI answered with reply, a new draft kept for a new document',
      "an API issue's UI part sent to its sibling as a change request, never left to a person: ISS-1279",
      'a first change request drafted to the member’s slug, never a guessed uuid: ISS-1360',
    ],
  },
  members: {
    purpose:
      'Lists the projects this project may address in each ecosystem it is active in, by id, slug and name.',
    situations: [
      {
        when: 'you are about to draft to a project you have never written to, and know it only by name',
        do: 'read members and put its slug in to; the draft stores its uuid',
      },
      {
        when: 'a draft was refused CHANNEL_TO_NOT_MEMBER',
        do: 'address one of the members the refusal lists, or say the project you meant is not shown to this one',
      },
    ],
    practice: [
      'It reads id, slug and name only: a member the ecosystem does not show this project is not listed.',
      'From a checkout the same read is GET /api/projects/:id/channel/members.',
    ],
    example: { projectId: '<project uuid>' },
    redFlag:
      'Putting a placeholder or a guessed uuid in to, or handing the request to a person, because no id was known.',
    family: 'channel',
    audience: ['master', 'bot'],
    scenarios: [
      'a first change request addressed by the member’s slug, read from members: ISS-1360',
    ],
  },
  hold: {
    purpose: 'Holds a conversation for a person, so nothing is owed on it until they release it.',
    situations: [
      {
        when: 'a person takes over a conversation with another project themselves',
        do: 'hold its thread with the reason; it leaves unanswered until they release it',
      },
    ],
    practice: ['A hold needs a reason; who may hold is the hold rule’s (HOLD_NOT_AUTHORISED).'],
    example: {
      projectId: '<project uuid>',
      thread: 'FP-CN-3',
      reason: 'The owner negotiates this change himself.',
    },
    redFlag:
      'Holding a thread to clear it from your inbox, where only a person taking it over holds it.',
    family: 'channel',
    audience: ['person'],
    scenarios: ['a thread held only for a person taking the conversation over'],
  },
  release: {
    purpose: 'Releases a held conversation, so it is owed again where its document owes a reply.',
    situations: [
      {
        when: 'the person who held a thread hands it back',
        do: 'release it; its document returns to unanswered',
      },
    ],
    practice: ['THREAD_HELD means stop: a hold is a person’s to release.'],
    example: { projectId: '<project uuid>', thread: 'FP-CN-3' },
    // the ecosystem-inbox guide: never release a hold to get your reply through
    redFlag: 'Releasing a person’s hold to get your reply through.',
    family: 'channel',
    audience: ['person'],
    scenarios: ['a reply refused THREAD_HELD stopped until the person releases the hold'],
  },
  withdraw: {
    purpose:
      'Withdraws a document this project published, with the reason, so nothing is owed on it.',
    situations: [
      {
        when: 'a document you sent no longer stands and nothing replaces it',
        do: 'withdraw it with the reason; a reply to it is refused after',
      },
    ],
    practice: ['A withdraw needs a reason (WITHDRAW_WITHOUT_REASON).'],
    example: {
      projectId: '<project uuid>',
      ref: 'FP-CN-3',
      reason: 'The rename was dropped from 2.0.',
    },
    redFlag: 'Withdrawing a document a newer one replaces, where supersede names the replacement.',
    family: 'channel',
    audience: ['master'],
    scenarios: ['a notice that no longer stands withdrawn, a replaced one superseded'],
  },
  supersede: {
    purpose: 'Replaces a document this project published with a newer one, naming it and why.',
    situations: [
      {
        when: 'you published a corrected document that replaces an earlier one',
        do: 'supersede the earlier one by the newer one with the reason',
      },
    ],
    practice: [
      'The newer one must be a replacement of the same kind (SUPERSEDE_NOT_A_REPLACEMENT).',
    ],
    example: {
      projectId: '<project uuid>',
      ref: 'FP-CN-3',
      by: 'FP-CN-4',
      reason: 'The field keeps its type.',
    },
    redFlag: 'Superseding with no reason, or by a document that is not its replacement.',
    family: 'channel',
    audience: ['master'],
    scenarios: ['a corrected notice superseding the one it replaces, with the reason'],
  },
  gate: {
    purpose: 'Approves or returns a document waiting at the approve gate, as an admin.',
    situations: [
      {
        when: 'a document of your project waits at the approve gate on you',
        do: 'approve it to publish it, or return it with a note saying what must change',
      },
    ],
    practice: [
      'A return needs a note (GATE_RETURN_WITHOUT_NOTE); the author edits and submits again.',
    ],
    example: {
      projectId: '<project uuid>',
      ref: 'FP-ACK-2',
      decision: 'return',
      note: 'Say when the consumer switches.',
    },
    redFlag: 'An agent approving its own document at the gate: an admin decides it.',
    family: 'channel',
    audience: ['person'],
    scenarios: ['a document at the approve gate decided by an admin, never its author'],
  },
} satisfies Partial<Record<ChannelAction, CapabilityCardBody>>;
