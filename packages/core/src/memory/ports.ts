/** One dependency edge of an issue, as relation expansion reads it. */
export interface IssueRelationEdge {
  otherIssueId: string;
  kind: string;
  expired: boolean;
}

/**
 * The issue facts memory reads but does not own. Issues sit downstream of memory (Work after
 * Knowledge), so memory names what it needs and the composition root fills it at boot.
 */
export interface MemoryIssueReads {
  /** `ISS-nn` for each issue id. */
  displayIds(issueIds: string[]): Promise<Map<string, string>>;
  /** Every dependency edge of each issue, both directions, expired ones included. */
  relationEdges(issueIds: string[], projectId: string): Promise<Map<string, IssueRelationEdge[]>>;
}

let provided: MemoryIssueReads | null = null;

export function provideMemoryIssueReads(reads: MemoryIssueReads): void {
  provided = reads;
}

export function memoryIssueReads(): MemoryIssueReads {
  if (!provided) {
    throw new Error(
      'memory: no issue reads were provided, so relation expansion cannot read an issue; the process entry calls provideMemoryIssueReads before it serves',
    );
  }
  return provided;
}
