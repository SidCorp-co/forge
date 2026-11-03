// What one beta port fire reports (ISS-923): each list capped, the rest counted, so a fire that met
// a thousand rows still reads in one screen and still says how many it did not show.

export interface BetaPortReport {
  /** The owner's ruling's time: no beta issue filed or reopened before it is ported. */
  cutoff: string;
  /** `twin: beta BETA-KEY → DEV-KEY` */
  ported: string[];
  /** `twin: DEV-KEY: from → to (beta BETA-KEY)` */
  mirrored: string[];
  /** What was refused, with its code. */
  refused: string[];
  /** Beta issues already ported, and how that was known. */
  skipped: string[];
  /** Beta project slugs with no project of that slug here. */
  noTwin: string[];
  /** Per beta project, how many issues filed before the ruling and not reopened since were left. */
  beforeRuling: string[];
  /** Beta issues left for the next fire by this fire's bound, all filed or reopened after the ruling. */
  waiting: number;
  /** `twin: DEV-KEY ← beta BETA-KEY`: a dev issue ported with only its first line, given beta's body. */
  backfilled: string[];
  /** The same, where beta's body is empty: recorded as backfilled with nothing written. */
  backfillEmpty: string[];
  /** The same, left for the next fire by the backfill's bound. */
  backfillOwed: string[];
}

export const REPORT_LIST_CAP = 20;

export function emptyReport(cutoff: Date): BetaPortReport {
  return {
    cutoff: cutoff.toISOString(),
    ported: [],
    mirrored: [],
    refused: [],
    skipped: [],
    noTwin: [],
    beforeRuling: [],
    waiting: 0,
    backfilled: [],
    backfillEmpty: [],
    backfillOwed: [],
  };
}

/** The backfill's sections, said only where it did or owes something: it ends once every pair is. */
function backfillSections(report: BetaPortReport, cap: number): string[] {
  return [
    ...(report.backfilled.length > 0 ? section('backfilled', report.backfilled, cap) : []),
    ...(report.backfillEmpty.length > 0
      ? section('backfilled with no beta body to write', report.backfillEmpty, cap)
      : []),
    ...(report.backfillOwed.length > 0
      ? section('bodies owed to the next fire', report.backfillOwed, cap)
      : []),
  ];
}

function section(title: string, rows: readonly string[], cap: number): string[] {
  if (rows.length === 0) return [`${title}: none`];
  const shown = rows.slice(0, cap).map((r) => `  ${r}`);
  const rest = rows.length - shown.length;
  return [`${title} (${rows.length}):`, ...shown, ...(rest > 0 ? [`  … and ${rest} more`] : [])];
}

export function renderReport(report: BetaPortReport, cap = REPORT_LIST_CAP): string {
  return [
    `cutoff: the owner's ruling beta-issues-are-worked-on-dev, ${report.cutoff}`,
    ...backfillSections(report, cap),
    ...section('ported', report.ported, cap),
    ...section('mirrored', report.mirrored, cap),
    ...section('refused', report.refused, cap),
    ...section('skipped as already ported', report.skipped, cap),
    ...section('beta projects with no dev twin', report.noTwin, cap),
    ...section('before the ruling', report.beforeRuling, cap),
    ...(report.waiting > 0 ? [`left for the next fire: ${report.waiting}`] : []),
  ].join('\n');
}

/** Whether the fire changed anything or has anything to say beyond "nothing to do". */
export function reportSaysSomething(report: BetaPortReport): boolean {
  return (
    report.ported.length > 0 ||
    report.mirrored.length > 0 ||
    report.refused.length > 0 ||
    report.noTwin.length > 0 ||
    report.waiting > 0 ||
    report.backfilled.length > 0 ||
    report.backfillEmpty.length > 0 ||
    report.backfillOwed.length > 0
  );
}
