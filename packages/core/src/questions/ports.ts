// What a question needs from the contexts below work: the channel gate it may decide, the door a
// person answered through, the conversation turn that asked it, and the masters to wake. The
// composition root provides them at boot.

import type { PersonVia } from '@forge/contracts/ecosystem';
import type { Context } from 'hono';
import type { Tx } from '../db/client.js';
import type { ConversationAdapter } from '../db/schema-conversations.js';
import type { AuthVars } from '../middleware/auth.js';

/** The conversation turn a session ran for, as its own record names it. */
interface ConversationTurnMeta {
  venue: { adapter: ConversationAdapter; externalId: string };
  conversationId: string;
  windowId: string;
  askedByLabel: string | null;
}

interface QuestionPorts {
  decideChannelGate: (
    tx: Tx,
    args: {
      documentId: string;
      projectId: string;
      optionId: string;
      note: string | undefined;
      by: string;
      via: PersonVia;
    },
  ) => Promise<() => Promise<void>>;
  /** The door the request came through: the CLI's token, or the web. */
  doorOfRequest: (c: Context<{ Variables: AuthVars }>) => Promise<PersonVia>;
  /** Null when the session ran no conversation turn; `{ meta: null }` when its record of one is unreadable. */
  conversationTurnOf: (metadata: unknown) => { meta: ConversationTurnMeta | null } | null;
  wakeMastersForAnswer: (args: {
    projectId: string;
    questionId: string;
  }) => Promise<{ boxes: number; delivered: number }>;
}

let provided: QuestionPorts | null = null;

export function provideQuestionPorts(given: QuestionPorts): void {
  provided = given;
}

function questionPorts(): QuestionPorts {
  if (!provided) {
    throw new Error(
      'questions: no ports were provided; the process entry calls provideQuestionPorts before it serves',
    );
  }
  return provided;
}

export const decideChannelGate: QuestionPorts['decideChannelGate'] = (tx, args) =>
  questionPorts().decideChannelGate(tx, args);
export const doorOfRequest: QuestionPorts['doorOfRequest'] = (c) =>
  questionPorts().doorOfRequest(c);
export const conversationTurnOf: QuestionPorts['conversationTurnOf'] = (metadata) =>
  questionPorts().conversationTurnOf(metadata);
export const wakeMastersForAnswer: QuestionPorts['wakeMastersForAnswer'] = (args) =>
  questionPorts().wakeMastersForAnswer(args);
