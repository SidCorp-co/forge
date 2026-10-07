import type { AnswerResume } from '@forge/contracts/questions';
import { portSlot } from '../lib/port-slot.js';

// What a master is owed from the modules above execution, handed in by the process entry at boot
// (ADR 0008: a domain imports only its own context or one before it). Read only inside a call.

interface MastersPorts {
  /** What the project's ecosystem channel owes a reply to, and the builder runs open for it. */
  channelOwed(projectId: string): Promise<{
    documents: { id: string; number: string | null }[];
    builderRuns: { id: string; ecosystem: string }[];
  }>;
  /** Agreed requirements owed a breakdown, due or overdue. */
  breakdownsOwed(projectId: string): Promise<{ key: string; overdue: boolean }[]>;
  /** Agent-written requirement revisions a signer returned, owed a revise. */
  revisionsOwed(projectId: string): Promise<{ key: string; revision: number }[]>;
  /** Feedback items owed a triage. */
  triagesOwed(projectId: string): Promise<{ key: string }[]>;
  /** Returned workflow designs no live issue carries, owed a revision. */
  designsOwed(projectId: string): Promise<{ workflowId: string; flow: string; revision: number }[]>;
  /** Issues waiting at the release gate with no release note, which the draft release refuses. */
  releaseNotesOwed(projectId: string): Promise<{ issueId: string; key: string }[]>;
  /** Issues at the release gate whose note's user-facing line is not in the content language or carries an engineer's reference; each says what to fix. */
  releaseNotesWarned(
    projectId: string,
    language: string,
  ): Promise<{ issueId: string; key: string; problems: string[] }[]>;
  /** Questions on the project's issues answered after `after`, with what each answer did to its park. */
  answersSince(
    projectId: string,
    after: Date,
  ): Promise<{ issueKey: string; questionId: string; outcome: AnswerResume | null }[]>;
  /** The language the project writes the prose it stores in Forge in (a BCP-47 tag), `en` where its document declares none. */
  contentLanguageOf(projectId: string): Promise<string>;
}

const slot = portSlot<MastersPorts>('masters', 'provideMastersPorts');
export const provideMastersPorts = slot.provide;
export const mastersPorts = slot.get;
