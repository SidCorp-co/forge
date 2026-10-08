/**
 * What a screen reads from the modules that own the tables, provided at boot.
 *
 * messaging owns no table and sits below every owner it reads, so it names the reads it needs here
 * and the process entry fills them; a screen that ran before they were provided fails by name.
 */

import type { ReportFrame } from '@forge/contracts/report-queries';
import type { Tx } from '../db/client.js';

/** An issue a message cites, as the work kernel holds it. */
export interface CitedIssueRow {
  readonly id: string;
  readonly issSeq: number;
  readonly status: string;
  readonly mergedAt: Date | null;
}

/** A workflow a design identity resolved to, and every revision of it that exists. */
export interface FoundDesign {
  readonly id: string;
  readonly flow: string;
  readonly projectId: string;
  /** The current revision first, then each stored design revision, ascending, no repeats. */
  readonly revisions: readonly number[];
}

/** What a design identity resolved to: the workflow, or the flows the project does hold. */
export type DesignLookupResult =
  | { readonly kind: 'found'; readonly design: FoundDesign }
  | { readonly kind: 'missing'; readonly flows: readonly string[] };

/** What the issue's project holds for a named contract: its slug, and the versions it recorded. */
export interface ContractHolding {
  readonly projectSlug: string;
  /** Newest first, at most the listed count beyond the one named. */
  readonly versions: readonly string[];
  readonly named: boolean;
}

export interface MessageReads {
  activeIssuePrefix(projectId: string, tx: Tx): Promise<string | null>;
  heldIssuePrefixes(projectId: string, tx: Tx): Promise<readonly string[]>;
  /** The project's issues among these ids and sequences. */
  citedIssues(
    projectId: string,
    cited: { readonly ids: readonly string[]; readonly seqs: readonly number[] },
    tx: Tx,
  ): Promise<readonly CitedIssueRow[]>;
  /** A workflow by id anywhere, or by flow within the project. */
  workflowDesign(projectId: string, workflow: string, tx: Tx): Promise<DesignLookupResult>;
  contractHolding(
    projectId: string,
    named: { readonly project: string; readonly contract: string; readonly version: string },
    tx: Tx,
  ): Promise<ContractHolding>;
  /** Whether a human reading this project's records reads code. */
  readsTechnical(projectId: string, tx: Tx): Promise<boolean>;
  /** The frames of this project's kept report runs among these ids; an id naming none is passed over. */
  reportRunFrames(
    projectId: string,
    runIds: readonly string[],
    tx: Tx,
  ): Promise<readonly ReportFrame[]>;
}

let provided: MessageReads | null = null;

export function provideMessageReads(reads: MessageReads): void {
  provided = reads;
}

export function messageReads(): MessageReads {
  if (!provided) {
    throw new Error(
      'message screen: no reads were provided, so a message cannot be checked against what the project holds; the process entry calls provideMessageReads before it serves',
    );
  }
  return provided;
}
