/**
 * What a rule is judged against, gathered once per screen and only where a rule
 * in the cell asks for it.
 */

/** The deterministic completion snapshot a stated figure is screened against. */
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
  readonly toolCalls: readonly { name: string; arguments: string }[];
  readonly progress: ProgressFacts | null;
  /**
   * Set where the issue lookup itself failed. The existence rules stand down
   * rather than refusing everything on an infra blip.
   */
  readonly issueLookupFailed: boolean;
  // cm:guard the option-line pattern arrives as DATA and is never imported: the rule that reads it would otherwise have to reach into the adapter that renders the option list, and a contract that names an adapter is not a contract. Same reason the prefixes are passed rather than queried here.
  readonly optionLinePattern: RegExp | null;
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
  optionLinePattern: null,
};

export function facts(over: Partial<MessageFacts>): MessageFacts {
  return { ...NO_FACTS, ...over };
}
