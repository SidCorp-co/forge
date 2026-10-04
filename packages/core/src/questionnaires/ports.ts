// What a questionnaire needs from the conversations context it is posted into: the room's
// messages, its project handle, its reply window and its readers. The composition root provides
// them at boot.

import type { db } from '../db/client.js';
import type { ContentBlock } from '../lib/agent-stream-parser.js';

/** A transaction, never the pool: the questionnaire writes and its room message commit together. */
export type TxOnly = Parameters<Parameters<(typeof db)['transaction']>[0]>[0];

export interface QuestionnaireMessage {
  role: 'assistant' | 'user';
  authorUserId: string;
  authorLabel?: string;
  content: string;
  blocks: readonly ContentBlock[];
}

export interface QuestionnairePorts {
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
