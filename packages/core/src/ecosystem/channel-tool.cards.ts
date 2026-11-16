// The capability cards of `forge_channel` (ISS-1251), beside the door in `channel-tool.ts`, which would
// otherwise cross its line budget. No issue or feedback records an agent working a real channel
// document through these actions: they rest on the situations the ecosystem-inbox guide teaches a
// master (worked over the REST twins from a checkout), and the reads on the chat assistant that holds
// them in a person's chat, where a channel write is refused. register, outbox, draft, hold, release,
// withdraw, supersede and gate carry no card: nothing records or teaches a situation for them.

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
    audience: ['master', 'bot'],
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
    audience: ['master', 'bot'],
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
    audience: ['master', 'bot'],
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
    audience: ['master', 'bot'],
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
    audience: ['master', 'bot'],
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
    audience: ['master'],
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
    audience: ['master'],
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
    audience: ['master'],
  },
} satisfies Partial<Record<ChannelAction, CapabilityCardBody>>;
