// What a questionnaire needs from the conversations context it is posted into: the room's
// messages, its project handle, its reply window and its readers. The composition root provides
// them at boot.

import type { db } from '../db/client.js';
import type { ContentBlock } from '../lib/agent-stream-parser.js';
import type { BatchRow } from './read.js';

/** A transaction, never the pool: the questionnaire writes and its room message commit together. */
export type TxOnly = Parameters<Parameters<(typeof db)['transaction']>[0]>[0];

interface QuestionnaireMessage {
  role: 'assistant' | 'user';
  authorUserId: string;
  authorLabel?: string;
  content: string;
  blocks: readonly ContentBlock[];
}

interface QuestionnairePorts {
  appendMessagesIn: (
    tx: TxOnly,
    args: { conversationId: string; messages: readonly QuestionnaireMessage[] },
  ) => Promise<Array<{ id: string; seq: number }>>;
  handleForProject: (
    conversationId: string,
    projectId: string,
    tx: TxOnly,
  ) => Promise<string | null>;
  openOrExtendWindow: (
    args: { conversationId: string; projectId: string; adapter: 'web'; seq: number },
    tx: TxOnly,
  ) => Promise<unknown>;
  /** Tells every reader of the room that it changed; the web refetches the thread on it. */
  announceConversationChange: (
    conversationId: string,
    data: { conversationId: string; messageId: string | null; role: string; content: string },
  ) => Promise<number>;
  /** The thread owner's write inside the submit transaction (an onboarding round touches its onboarding). */
  onSubmittedIn: (tx: TxOnly, batch: BatchRow) => Promise<void>;
  /** The thread owner's step after a submit commits (an onboarding round enqueues its revise job). */
  afterSubmit: (batch: BatchRow, submittedBy: string) => Promise<void>;
}

let provided: QuestionnairePorts | null = null;

export function provideQuestionnairePorts(given: QuestionnairePorts): void {
  provided = given;
}

function questionnairePorts(): QuestionnairePorts {
  if (!provided) {
    throw new Error(
      'questionnaires: no ports were provided; the process entry calls provideQuestionnairePorts before it serves',
    );
  }
  return provided;
}

export const appendMessagesIn: QuestionnairePorts['appendMessagesIn'] = (tx, args) =>
  questionnairePorts().appendMessagesIn(tx, args);
export const handleForProject: QuestionnairePorts['handleForProject'] = (
  conversationId,
  projectId,
  tx,
) => questionnairePorts().handleForProject(conversationId, projectId, tx);
export const openOrExtendWindow: QuestionnairePorts['openOrExtendWindow'] = (args, tx) =>
  questionnairePorts().openOrExtendWindow(args, tx);
export const announceConversationChange: QuestionnairePorts['announceConversationChange'] = (
  conversationId,
  data,
) => questionnairePorts().announceConversationChange(conversationId, data);
export const onSubmittedIn: QuestionnairePorts['onSubmittedIn'] = (tx, batch) =>
  questionnairePorts().onSubmittedIn(tx, batch);
export const afterSubmit: QuestionnairePorts['afterSubmit'] = (batch, submittedBy) =>
  questionnairePorts().afterSubmit(batch, submittedBy);
