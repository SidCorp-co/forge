export interface ProgressFacts {
  shipped: number;
  closedUnshipped: number;
  inFlight: number;
  remaining: number;
  total: number;
}

/** What the tracker says about one issue a message names. */
export interface IssueRow {
  readonly seq: number;
  readonly merged: boolean;
  readonly status: string;
}

export interface MessageFacts {
  /** The project's active issue prefix, for naming a citation back to its author. */
  readonly prefix: string | null;
  /** Every prefix the project holds, so a citation under a retired one is still read. */
  readonly prefixes: readonly string[];
  readonly knownIssueIds: ReadonlySet<string>;
  readonly knownIssueSeqs: ReadonlySet<number>;
  /** Keyed by issue sequence, for the rules that read what the tracker holds. */
  readonly issueRows: ReadonlyMap<number, IssueRow>;
  readonly toolCalls: readonly {
    name: string;
    arguments: string;
    /** Every issue-shaped reference the whole result named (ISS-1057). */
    resultIssueRefs?: readonly string[];
    /** MCP's own flag on the result; an errored call verifies nothing. */
    isError?: boolean;
  }[];
  readonly progress: ProgressFacts | null;
  readonly issueLookupFailed: boolean;
}

export const NO_FACTS: MessageFacts = {
  prefix: null,
  prefixes: [],
  knownIssueIds: new Set(),
  knownIssueSeqs: new Set(),
  issueRows: new Map(),
  toolCalls: [],
  progress: null,
  issueLookupFailed: false,
};

export function facts(over: Partial<MessageFacts>): MessageFacts {
  return { ...NO_FACTS, ...over };
}
