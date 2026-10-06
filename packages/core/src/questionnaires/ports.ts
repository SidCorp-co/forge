// What a questionnaire needs from the conversations context it is posted into: the room's
// messages, its project handle, its reply window and its readers. The composition root provides
// them at boot.

import type { TxOnly } from '../db/client.js';
import type { ContentBlock } from '../lib/agent-stream-parser.js';
import { portSlot } from '../lib/port-slot.js';
import type { BatchRow } from './read.js';

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
  ) => Promise<void>;
  /** The thread owner's write inside the submit transaction (an onboarding round touches its onboarding). */
  onSubmittedIn: (tx: TxOnly, batch: BatchRow) => Promise<void>;
  /** The thread owner's step after a submit commits (an onboarding round enqueues its revise job). */
  afterSubmit: (batch: BatchRow, submittedBy: string) => Promise<void>;
}

const slot = portSlot<QuestionnairePorts>('questionnaires', 'provideQuestionnairePorts');
export const provideQuestionnairePorts = slot.provide;
const { port } = slot;

export const appendMessagesIn = port('appendMessagesIn');
export const handleForProject = port('handleForProject');
export const openOrExtendWindow = port('openOrExtendWindow');
export const announceConversationChange = port('announceConversationChange');
export const onSubmittedIn = port('onSubmittedIn');
export const afterSubmit = port('afterSubmit');
