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

/** One result a tool returned this turn, by the name the turn called it. */
export interface ToolResultEntry {
  readonly name: string;
  readonly text: string;
  /** The call was refused or threw: what it answered grounds nothing. */
  readonly isError?: boolean | undefined;
}

/**
 * What `figures-rule.ts` holds a figure to: the turn's report runs, the results of the reads it
 * declares as grounding (`FIGURE_GROUNDING_RESULTS`), and what the person asked.
 */
export interface FigureFacts {
  /** Every value the person's question holds; a figure equal to one is theirs, said back. */
  readonly asked: ReadonlySet<number>;
  /** How many of the turn's report runs were found and read. */
  readonly runs: number;
  /** The values the runs' frames hold, rounded: index `d` holds them at `d` decimals. */
  readonly held: readonly ReadonlySet<number>[];
  /** The values the turn's grounding reads returned, rounded the same way; empty where it made none. */
  readonly read: readonly ReadonlySet<number>[];
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
  /**
   * Every value the person's question holds, where the caller gave it: a figure equal to one is
   * theirs, said back, and no rule reads it as the reply's own claim.
   */
  readonly asked: ReadonlySet<number>;
  /** Null where the turn could run no report, so a figure has nothing to be held to. */
  readonly figures: FigureFacts | null;
  /**
   * The blocks held with this reply, as JSON, where the caller holds them: they are what would be
   * shown with it, so a block's text is read from them. Null reads it from the turn's calls.
   */
  readonly heldBlocks: readonly string[] | null;
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
  asked: new Set(),
  figures: null,
  heldBlocks: null,
};

export function facts(over: Partial<MessageFacts>): MessageFacts {
  return { ...NO_FACTS, ...over };
}
