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
    /** The call was refused or threw; a refused read grounds nothing. */
    isError?: boolean | undefined;
  }[];
  /** The tools the writer's turn was offered, by the names it calls them; empty where none is known. */
  readonly offeredTools: readonly string[];
  readonly progress: ProgressFacts | null;
  /**
   * The counts the writer's own reads returned this turn, as JSON numbers: a figure among them was
   * read, not made up, though no project-wide snapshot holds it (a release's 26 landed issues).
   */
  readonly readCounts: ReadonlySet<number>;
  /**
   * The dates (`YYYY-MM-DD`) the memories this turn's reads returned speak as of: a decision the
   * reply takes from memory is cited with one of them (MJ-5, `status-claims-rule.ts`).
   */
  readonly memoryDates: ReadonlySet<string>;
  readonly issueLookupFailed: boolean;
}

export const NO_FACTS: MessageFacts = {
  prefix: null,
  prefixes: [],
  knownIssueIds: new Set(),
  knownIssueSeqs: new Set(),
  issueRows: new Map(),
  toolCalls: [],
  offeredTools: [],
  progress: null,
  readCounts: new Set(),
  memoryDates: new Set(),
  issueLookupFailed: false,
};

export function facts(over: Partial<MessageFacts>): MessageFacts {
  return { ...NO_FACTS, ...over };
}
