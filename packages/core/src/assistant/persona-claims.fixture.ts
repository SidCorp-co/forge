/**
 * ISS-1007 / ISS-1034 / ISS-1057 — the persona claim ledger.
 *
 * Every instruction the pre-change `rocketChatPersona` carried has a row naming exactly one owning
 * fragment, and the rows added since name theirs. It lives beside the tests rather than inside one
 * because two files assert over it — `persona-accounting.test.ts` reads it against the fragments a
 * door renders, and `prompt/layer-accounting.test.ts` against the layer texts themselves — and a
 * test file may not export.
 */

export type Owner =
  | 'guide'
  | 'sharedOpening'
  | 'rocketchatOnly'
  | 'webOnly'
  | 'webAgentOnly'
  | 'personaStyle';

export interface Claim {
  /** What the claim is, for a reader of a failure message. */
  id: string;
  owner: Owner;
  /**
   * EVERY material clause of the instruction, verbatim, first one distinctive enough to find in no
   * other fragment. One short marker proves only that a heading survived: measured on this file's
   * own first draft, `ISSUE QUALITY CONTRACT` stayed true with the whole body requirement deleted.
   */
  clauses: readonly [string, ...string[]];
  /**
   * `moved` — carried by the pre-change `rocketChatPersona` and now in another fragment.
   * `kept` — in the fragment it was already in.
   * `hoisted` — was `webConversationPersona`'s own wording and is now the guide's one copy.
   * `new` — written by ISS-1007 and carried by nothing before it.
   */
  origin: 'moved' | 'kept' | 'hoisted' | 'new';
}

export const LEDGER: readonly Claim[] = [
  {
    id: 'identity',
    owner: 'sharedOpening',
    clauses: ['You are the working assistant for project'],
    origin: 'moved',
  },
  {
    id: 'method-then-channel',
    owner: 'sharedOpening',
    clauses: ['The lines below add only what is true of this channel'],
    origin: 'new',
  },
  {
    id: 'issue-web-link',
    owner: 'sharedOpening',
    clauses: [
      'include its web link',
      '/issues/<documentId>',
      '`forge new` echoes the documentId',
      'for an existing issue `forge issue ISS-<n>` prints it',
      'the list does not',
    ],
    origin: 'moved',
  },
  {
    id: 'issue-link-wrong-shapes',
    owner: 'sharedOpening',
    clauses: [
      'The documentId is the only thing that goes in that last segment',
      'it is a UUID',
      'A link ending in an issue key, in a bare number, or written as a `#/` route',
      'copy the documentId a tool printed, character for character',
    ],
    origin: 'new',
  },
  {
    id: 'help-is-the-way-out',
    owner: 'guide',
    clauses: [
      '`-h` is for a verb whose form the tool',
      'does not carry',
      'it costs a round-trip you do not otherwise pay',
    ],
    origin: 'new',
  },
  {
    id: 'waiting-issue-is-needs-info',
    owner: 'guide',
    clauses: [
      'AN ISSUE WAITING ON MORE INFORMATION IS AT `needs_info`',
      'A `draft` is unfiled, not waiting',
    ],
    origin: 'new',
  },

  {
    id: 'method-preamble',
    owner: 'guide',
    clauses: [
      'You are answering for one project, with tools that read it and a few that write to it',
      'This is how a request gets worked, and it is the same at every door',
      'The channel you are speaking in adds only what is true of that channel',
    ],
    origin: 'kept',
  },
  {
    id: 'own-the-request',
    owner: 'guide',
    clauses: [
      'You OWN the requests addressed to you',
      'investigate and act with your tools',
      'never hand the task back to the humans',
    ],
    origin: 'moved',
  },
  {
    id: 'lead-with-found',
    owner: 'guide',
    clauses: [
      'LEAD your reply with what you FOUND',
      "the entity's status, the key facts, and any contradiction with what the channel expects",
      'THEN the action you took',
      '"I created an issue" alone does not answer a check request',
    ],
    origin: 'moved',
  },
  {
    id: 'status-gets-figures',
    owner: 'guide',
    clauses: [
      'status is answered with the figures, not with a description of how you would find them',
    ],
    origin: 'hoisted',
  },
  {
    id: 'reporter-owes-nothing',
    owner: 'guide',
    clauses: [
      'reporter owes you nothing',
      'evidence the project side can gather itself',
      'write it into the draft issue as acceptance criteria for a developer',
      'repro steps, account, time window',
      'Never bounce the burden of proof back to the reporter',
    ],
    origin: 'moved',
  },
  {
    id: 'issue-quality-contract',
    owner: 'guide',
    clauses: [
      'ISSUE QUALITY CONTRACT',
      'an issue must stand alone',
      'Title = kind + affected feature',
      'what happens, where, expected vs actual',
      'Write the body as markdown with',
      'refuses a filing that is missing one, NAMING the heading',
    ],
    origin: 'moved',
  },
  {
    id: 'tracker-is-forge',
    owner: 'guide',
    clauses: [
      'THE TRACKER IS THE `forge` TOOL',
      'the forms you need are already in its description',
      'NEVER guess a flag or a verb',
    ],
    origin: 'new',
  },
  {
    id: 'file-with-forge-new',
    owner: 'guide',
    clauses: [
      'FILE WITH `forge new`, NOT BY HAND',
      'folds this onto a near neighbour',
      'offer `--new`',
      '--relates ISS-<near>',
    ],
    origin: 'new',
  },
  {
    id: 'ask-only-reporter-knows',
    owner: 'guide',
    clauses: [
      'ASK ONLY FOR WHAT ONLY THE REPORTER KNOWS',
      'write it yourself',
      'Always write `## Where`',
    ],
    origin: 'new',
  },
  {
    id: 'never-claim-unread-write',
    owner: 'guide',
    clauses: [
      'NEVER SAY A WRITE LANDED THAT YOU DID NOT READ BACK',
      'do not describe the state you intended',
    ],
    origin: 'new',
  },
  {
    id: 'urls-carry-ids',
    owner: 'guide',
    clauses: [
      'URLs in the context carry ids',
      'extract the id from the URL and query the external system',
      'BY ID before trying any keyword search',
    ],
    origin: 'moved',
  },
  {
    id: 'investigate-first',
    owner: 'guide',
    clauses: [
      'INVESTIGATE before answering',
      'SHORT keyword fragments (2-4 words)',
      'retry with different fragments if empty',
      'Cross-check forge_memory.search and forge_knowledge',
      'read issue comments when a discussion references one',
    ],
    origin: 'moved',
  },
  {
    id: 'introspect-external-schema',
    owner: 'guide',
    clauses: [
      'before claiming it cannot help',
      'the external schema tool',
      'to learn the available queries and filters',
      'NEVER claim "the tools cannot do this" or ask the user for an ID',
      'Schemas often expose',
      'they need NO user id',
    ],
    origin: 'moved',
  },
  {
    id: 'act-not-delegate',
    owner: 'guide',
    clauses: [
      'ACT, do not delegate',
      'it always enters as',
      'Only mention a person when the action truly requires',
      'state exactly what remains and why',
    ],
    origin: 'moved',
  },
  {
    id: 'never-bounce-back',
    owner: 'guide',
    clauses: [
      'Never reply with only "ask X to do Y"',
      'if a tool call could find the answer or capture the work as a draft issue',
    ],
    origin: 'moved',
  },
  {
    id: 'never-announce',
    owner: 'guide',
    clauses: [
      'Never announce what you are about to do',
      'CALL the tool now instead',
      'reply only when you have the result, or a concrete failure to report',
    ],
    origin: 'moved',
  },
  {
    id: 'broad-request-overview',
    owner: 'guide',
    clauses: [
      'For a broad request',
      'do not just ask what to check',
      'produce a brief status overview from the tools',
      'then offer to drill into specifics',
    ],
    origin: 'moved',
  },
  {
    id: 'answer-concisely',
    owner: 'guide',
    clauses: [
      'Answer concisely, in the language the person wrote in',
      'a reply that restates the question back is longer and worth less',
    ],
    origin: 'moved',
  },

  {
    id: 'bot-name',
    owner: 'rocketchatOnly',
    clauses: ['Your name in this channel is', 'Refer to yourself as', 'or "the system"'],
    origin: 'kept',
  },
  {
    id: 'pronoun-mapping',
    owner: 'rocketchatOnly',
    clauses: [
      'use that username when filtering',
      'The message you are answering was sent by user @',
    ],
    origin: 'kept',
  },
  {
    id: 'rocketchat-history',
    owner: 'rocketchatOnly',
    clauses: [
      'call rocketchat_history before concluding',
      'Read the conversation context first',
      'if it references older discussion',
    ],
    origin: 'kept',
  },
  {
    id: 'rocketchat-quote-context',
    owner: 'rocketchatOnly',
    clauses: ['can be expanded with rocketchat_quote_context', 'at most two per turn'],
    origin: 'new',
  },
  {
    id: 'one-reply-only',
    owner: 'rocketchatOnly',
    clauses: [
      'the ONLY message the user receives',
      'there is no follow-up turn',
      'do not promise a later one',
    ],
    origin: 'kept',
  },
  {
    id: 'plain-text',
    owner: 'rocketchatOnly',
    clauses: ['Plain chat text, no markdown headers'],
    origin: 'kept',
  },
  {
    id: 'mid-conversation-turn',
    owner: 'rocketchatOnly',
    clauses: ['Mid-conversation turn:'],
    origin: 'new',
  },

  {
    id: 'reply-in-vietnamese',
    owner: 'personaStyle',
    clauses: ['Reply in Vietnamese', 'switch language only if the user clearly writes another one'],
    origin: 'moved',
  },

  {
    id: 'web-asked-by',
    owner: 'webOnly',
    clauses: ['- You are answering '],
    origin: 'kept',
  },
  {
    id: 'web-no-checkout',
    owner: 'webOnly',
    clauses: [
      'no checkout of the repository and no shell',
      'say so plainly when you are asked about a file',
    ],
    origin: 'kept',
  },
  {
    id: 'web-agents-screen',
    owner: 'webOnly',
    clauses: [
      'that needs a session on a paired box',
      'You CANNOT edit a file, run a command or drive a pipeline',
      'a fresh conversation opened in Agent mode',
      '/agents. Say so, and name the first of those',
    ],
    origin: 'kept',
  },
  {
    id: 'web-multi-turn',
    owner: 'webOnly',
    clauses: [
      'Markdown renders here, and the person can reply',
      'a follow-up question is available to you when one is genuinely needed',
    ],
    origin: 'new',
  },

  {
    id: 'web-agent-asked-by',
    owner: 'webAgentOnly',
    clauses: ['- You are talking with ', 'in a conversation they opened in Agent mode'],
    origin: 'new',
  },
  {
    id: 'web-agent-has-checkout',
    owner: 'webAgentOnly',
    clauses: [
      'running on a paired box with this project',
      'repository checked out and a shell available',
      'rather than answering from what you remember',
    ],
    origin: 'new',
  },
  {
    id: 'web-agent-unfenced',
    owner: 'webAgentOnly',
    clauses: [
      'you can edit a file, run a command and drive a pipeline',
      'Nothing you write here is fenced to a draft',
    ],
    origin: 'new',
  },
  {
    id: 'web-agent-multi-turn',
    owner: 'webAgentOnly',
    clauses: [
      'Markdown renders where this lands and the person can reply',
      'ask them a follow-up where the work genuinely needs one',
    ],
    origin: 'new',
  },
  {
    id: 'web-agent-verbatim',
    owner: 'webAgentOnly',
    clauses: [
      'What you write last is delivered to the conversation verbatim',
      'no fenced JSON, no commentary about what you are about to do',
    ],
    origin: 'new',
  },
];
