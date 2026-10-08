// What `reports` needs from modules it may not import, handed in by the process entry at boot: the
// query registry is a read model (a domain imports none, ADR 0008), and the room a block is posted
// into belongs to the conversations context. Read only inside a call, so this module never loads
// either one.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { ReportQueryDescriptor, ReportRun } from '@forge/contracts/report-queries';
import type { ContentBlock } from '../lib/agent-stream-parser.js';
import type { ProjectAccess } from '../lib/authz.js';
import { portSlot } from '../lib/port-slot.js';
import type { StagedBlock } from '../lib/staged-block.js';

/**
 * What turn a REST caller's token answers: none (a person's token, or a session that answers no
 * room), an assistant chat turn's, a session that is gone, a session started for a room turn whose
 * room cannot be read from it, or an Agent-mode turn in a room, whose reply a block can wait on.
 */
export type RestTurn =
  | { kind: 'none' }
  | { kind: 'assistant-turn' }
  | { kind: 'session-gone'; sessionId: string }
  | { kind: 'turn-unreadable'; sessionId: string }
  | {
      kind: 'agent-turn';
      sessionId: string;
      conversationId: string;
      /** The reply was already taken for delivery. */
      settled: boolean;
      /** Hold a block on the turn; false where its reply was taken for delivery meanwhile. */
      stage(block: StagedBlock): Promise<boolean>;
    };

/** One stored message of a turn, as a share reads it. */
export interface ChatTurnMessage {
  id: string;
  content: string;
  blocks: unknown;
  deliveryProof: unknown;
  silenceReason: string | null;
}

/**
 * An assistant turn, read from any one of its messages: the room, what the person asked (their
 * messages just before it, oldest first, joined), and every assistant message between that question
 * and the next person's message, oldest first. `role` is the named message's own.
 */
export interface ChatTurn {
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  question: string | null;
  messages: ChatTurnMessage[];
}

/** Who runs a query or reads a run back: every read is made as this person. */
export interface ReportAsker {
  userId: string;
  agency: ActorAgency;
  access: ProjectAccess;
}

interface ReportsPorts {
  /** Runs a registered query as the asker (`report-queries/run.ts:runReportQuery`). */
  runQuery(args: {
    projectId: string;
    queryId: string;
    params: unknown;
    asker: ReportAsker;
    now?: Date;
  }): Promise<ReportRun>;
  /** A registered query's descriptor, refused by name where the id is not registered. */
  describeQuery(queryId: string): ReportQueryDescriptor;
  /** Every registered query's descriptor. */
  listQueries(): ReportQueryDescriptor[];
  /** The room `userId` may read: its door and the projects it is about. Refused by name otherwise. */
  roomOf(
    conversationId: string,
    userId: string,
  ): Promise<{ adapter: string; projectIds: string[] }>;
  /** The assistant turn one stored message belongs to, or null where no message has the id. */
  turnOf(messageId: string): Promise<ChatTurn | null>;
  /** Appends one service-written answer to the room, as the project's handle, and tells its readers. */
  postAnswer(args: {
    conversationId: string;
    projectId: string;
    askerUserId: string;
    content: string;
    blocks: readonly ContentBlock[];
  }): Promise<{ messageId: string }>;
  /** The room turn the token a REST call arrived on answers (`rest-stage.ts` judges it). */
  restTurnOf(tokenId: string | null): Promise<RestTurn>;
}

const slot = portSlot<ReportsPorts>('reports', 'provideReportsPorts');
export const provideReportsPorts = slot.provide;
export const reportsPorts = slot.get;
