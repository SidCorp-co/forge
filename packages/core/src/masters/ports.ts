import type { ResolvedGate } from '@forge/contracts/gate-profiles';
import type { AnswerResume } from '@forge/contracts/questions';
import type { ReleaseNamer } from '@forge/contracts/release-naming';
import type { StandingSubjectKind } from '@forge/contracts/steward';
import { portSlot } from '../lib/port-slot.js';

/** The next merge an accepted change-request release waits on (`release-batch/merges-owed.ts`). */
export interface ReleaseMergeOwed {
  runId: string;
  version: string | null;
  next: { label: string; number: number; issueId: string; issueKey: string };
  merged: number;
  total: number;
}

/** A shipped feedback item an agent of this project reported, owing its confirm (`feedback/owed-verify.ts`). */
export interface AgentConfirmOwed {
  key: string;
  feedbackId: string;
  reporter: string;
  itemProjectId: string;
  home: boolean;
}

/** A request a person left waiting: a draft issue they filed, or a draft requirement proposed from a chat. */
export interface WaitingRequest {
  kind: 'issue' | 'requirement';
  key: string;
}

// What a master is owed from the modules above execution, handed in by the process entry at boot
// (ADR 0008: a domain imports only its own context or one before it). Read only inside a call.

/** An ask of the master the steward made, the item it is about, and every item a decision on answers it. */
export interface StewardAsk {
  actId: string;
  ask: string;
  subject: { kind: StandingSubjectKind; key: string };
  /** The item it is about, then the item whose run asked where that is another (ISS-739). */
  answeredOn: { kind: StandingSubjectKind; key: string }[];
}

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
  /** Shipped feedback items an agent of this project reported, owing that agent's confirm or reopen (REQ-66 BC-8). */
  confirmsOwed(projectId: string): Promise<AgentConfirmOwed[]>;
  /** Returned workflow designs no live issue carries, owed a revision. */
  designsOwed(projectId: string): Promise<{ workflowId: string; flow: string; revision: number }[]>;
  /** Issues waiting at the release gate with no release note, which the draft release refuses. */
  releaseNotesOwed(projectId: string): Promise<{ issueId: string; key: string }[]>;
  /**
   * Issues waiting to ship, at the gate or in a release not yet ended, whose note reads wrong to a
   * user (not in the content language, an engineer's reference, no short title, more than one
   * sentence); each names the release holding it, if any, and says what to fix.
   */
  releaseNotesWarned(
    projectId: string,
    language: string,
  ): Promise<{ issueId: string; key: string; release: string | null; problems: string[] }[]>;
  /** Releases cut and not yet out that carry no name and summary (REQ-40 BC-14), oldest first. */
  releasesUnnamed(projectId: string): Promise<{ version: string }[]>;
  /** Who names them: naming takes project.admin, so the master only where an account it acts as holds it (ISS-590). */
  releaseNamer(projectId: string): Promise<ReleaseNamer>;
  /**
   * Accepted change-request releases with a merge still to make, each naming the next request in its
   * declared order: such a release runs no job, so its merges are the master's (REQ-71 BC-4).
   */
  releaseMergesOwed(projectId: string): Promise<ReleaseMergeOwed[]>;
  /** Running releases the project requires approval for that have asked none (ISS-591). */
  releaseApprovalsOwed(projectId: string): Promise<{ runId: string; version: string | null }[]>;
  /** Questions on the project's issues answered after `after`, with what each answer did to its park. */
  answersSince(
    projectId: string,
    after: Date,
  ): Promise<{ issueKey: string; questionId: string; outcome: AnswerResume | null }[]>;
  /** The language the project writes the prose it stores in Forge in (a BCP-47 tag), `en` where its document declares none. */
  contentLanguageOf(projectId: string): Promise<string>;
  /**
   * What the project's steward asked its master to act on, standing until the item's standing moves
   * (REQ-48 BC-5), each with the item whose decision answers it (ISS-654).
   */
  stewardAsks(projectId: string): Promise<StewardAsk[]>;
  /**
   * `in_progress` issues the wedge pass left because their work landed and nothing has taken up
   * since, each owed its move to `awaiting_release` (ISS-564).
   */
  landedWorkOwed(projectId: string): Promise<
    {
      issueId: string;
      key: string;
      commit: string | null;
      mergedAt: string;
      /** `open` for an issue a merge filed under a profile with issue_before_code off (REQ-76 BC-8). */
      status: 'in_progress' | 'open';
    }[]
  >;
  /** Agreed requirements whose steward intake question nobody has answered yet, held out of the breakdowns owed (REQ-48 BC-2). */
  breakdownsHeldBySteward(projectId: string): Promise<string[]>;
  /** The project's gate `master_admitted_only` (REQ-76): off, a master is placed for a waiting request too. */
  masterGate(projectId: string): Promise<ResolvedGate>;
  /**
   * The chat or direct requests waiting on a person (REQ-76 BC-9): draft issues a person filed, and
   * draft requirements whose revision is proposed. Asked only where `masterGate` is off.
   */
  requestsWaiting(projectId: string): Promise<WaitingRequest[]>;
}

const slot = portSlot<MastersPorts>('masters', 'provideMastersPorts');
export const provideMastersPorts = slot.provide;
export const mastersPorts = slot.get;
