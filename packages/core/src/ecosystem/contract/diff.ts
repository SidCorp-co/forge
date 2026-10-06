export const DIFF_TOOLS = [
  'oasdiff',
  'buf-breaking',
  'json-schema-diff',
  'graphql-inspector',
  'graphql-sdl-diff',
  'none',
] as const;
type DiffTool = (typeof DIFF_TOOLS)[number];

export const MEASURED_CLASSIFICATIONS = ['breaking', 'non-breaking', 'unknown', 'initial'] as const;
export type MeasuredClassification = (typeof MEASURED_CLASSIFICATIONS)[number];

export const CHANGE_KINDS = ['added', 'removed', 'changed', 'deprecated'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const CHANGE_LEVELS = ['breaking', 'warning', 'info'] as const;
export type ChangeLevel = (typeof CHANGE_LEVELS)[number];

export interface MeasuredChange {
  element: string;
  kind: ChangeKind;
  level: ChangeLevel;
  text: string;
  check?: string;
}

export interface MeasuredDiff {
  tool: DiffTool;
  toolVersion?: string;
  classification: MeasuredClassification;
  changes: MeasuredChange[];
}

export const MAX_CHANGES = 500;

// the checks a diff carries when no differ measured the change: none exists for the type, it failed, or there was nothing to compare; a declared semantic change is the uploader's word and is not among them
export const NOT_MEASURED_CHECK =
  /^(.+-not-measured|opaque|contract-type-changed|no-previous-artifact)$/;

export const notMeasured = (diff: Pick<MeasuredDiff, 'changes'>): MeasuredChange[] =>
  diff.changes.filter((c) => c.check !== undefined && NOT_MEASURED_CHECK.test(c.check));

const RANK: Record<ChangeLevel, number> = { breaking: 0, warning: 1, info: 2 };

export function classify(
  changes: readonly MeasuredChange[],
): 'breaking' | 'unknown' | 'non-breaking' {
  if (changes.some((c) => c.level === 'breaking')) return 'breaking';
  if (changes.some((c) => c.level === 'warning')) return 'unknown';
  return 'non-breaking';
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function change(c: MeasuredChange): MeasuredChange {
  return {
    ...c,
    element: clip(c.element, 200),
    text: clip(c.text.length > 0 ? c.text : c.kind, 1000),
    ...(c.check === undefined ? {} : { check: clip(c.check, 120) }),
  };
}

/** The check on the one change that stands for the ones the 500-change list could not hold. */
export const TRUNCATED_CHECK = 'changes-truncated';

// the schema holds 500 changes; the classification is taken over all of them first, and the cut keeps breaking before warning before info and says how many it dropped
export function measured(
  tool: DiffTool,
  toolVersion: string,
  all: readonly MeasuredChange[],
): MeasuredDiff {
  const classification = classify(all);
  const sorted = [...all].sort((a, b) => RANK[a.level] - RANK[b.level]);
  const changes =
    sorted.length <= MAX_CHANGES
      ? sorted
      : [
          ...sorted.slice(0, MAX_CHANGES - 1),
          change({
            element: 'document',
            kind: 'changed',
            level: sorted[MAX_CHANGES - 1]?.level ?? 'info',
            text: `${sorted.length - (MAX_CHANGES - 1)} further change(s) measured and not listed; the list holds ${MAX_CHANGES}.`,
            check: TRUNCATED_CHECK,
          }),
        ];
  return { tool, toolVersion, classification, changes: changes.map(change) };
}
