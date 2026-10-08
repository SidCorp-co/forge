// What `reports` needs from modules it may not import, handed in by the process entry at boot: the
// query registry is a read model (a domain imports none, ADR 0008), and the room a block is posted
// into belongs to the conversations context. Read only inside a call, so this module never loads
// either one.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { ReportQueryDescriptor, ReportRun } from '@forge/contracts/report-queries';
import type { ContentBlock } from '../lib/agent-stream-parser.js';
import type { ProjectAccess } from '../lib/authz.js';
import { portSlot } from '../lib/port-slot.js';

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
  /** One stored message: the room it sits in and its blocks column, or null where no message has the id. */
  messageOf(messageId: string): Promise<{ conversationId: string; blocks: unknown } | null>;
  /** Appends one service-written answer to the room, as the project's handle, and tells its readers. */
  postAnswer(args: {
    conversationId: string;
    projectId: string;
    askerUserId: string;
    content: string;
    blocks: readonly ContentBlock[];
  }): Promise<{ messageId: string }>;
}

const slot = portSlot<ReportsPorts>('reports', 'provideReportsPorts');
export const provideReportsPorts = slot.provide;
export const reportsPorts = slot.get;
