import corpus from './legacy-corpus.json' with { type: 'json' };

export const LEGACY_TEXTS: readonly string[] = corpus.texts;

/** The `segments` shape the operator screen takes. */
export const LEGACY_SEGMENT_SETS: readonly (readonly string[])[] = corpus.segmentSets;

/** The progress snapshots the figure rule is judged against. */
export const LEGACY_PROGRESS: readonly (null | {
  shipped: number;
  closedUnshipped: number;
  inFlight: number;
  remaining: number;
  total: number;
})[] = [
  null,
  { shipped: 0, closedUnshipped: 0, inFlight: 0, remaining: 0, total: 0 },
  { shipped: 3, closedUnshipped: 1, inFlight: 2, remaining: 4, total: 10 },
  { shipped: 12, closedUnshipped: 0, inFlight: 0, remaining: 28, total: 40 },
];

/** The tool-call sets the creation-claim rules read. */
export const LEGACY_TOOL_CALLS: ReadonlyArray<ReadonlyArray<{ name: string; arguments: string }>> =
  [
    [],
    [{ name: 'forge_issues', arguments: '{"action":"create"}' }],
    [{ name: 'forge_issues', arguments: '{"action":"list"}' }],
    [{ name: 'forge_comments', arguments: '{"action":"create"}' }],
  ];

/** What the project is taken to hold, for the existence rules. */
export const LEGACY_KNOWN = {
  ids: new Set(['0f8f4a2b-1111-4222-8333-444455556666']),
  seqs: new Set([1]),
} as const;

export const LEGACY_PREFIXES: readonly string[] = ['ISS', 'FD'];
export const LEGACY_PREFIX = 'ISS';
