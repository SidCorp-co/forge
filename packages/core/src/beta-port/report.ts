// What one beta port fire reports (ISS-923): each list capped, the rest counted, so a fire that met
// a thousand rows still reads in one screen and still says how many it did not show.

export interface BetaPortReport {
  /** `BETA-KEY → DEV-KEY` */
  ported: string[];
  /** `DEV-KEY: from → to` */
  mirrored: string[];
  /** What was refused, with its code. */
  refused: string[];
  /** Beta issues already ported, and how that was known. */
  skipped: string[];
  /** Beta project slugs with no project of that slug here. */
  noTwin: string[];
  /** Beta issues left for the next fire by this fire's bound. */
  waiting: number;
}

export const REPORT_LIST_CAP = 20;

export function emptyReport(): BetaPortReport {
  return { ported: [], mirrored: [], refused: [], skipped: [], noTwin: [], waiting: 0 };
}

function section(title: string, rows: readonly string[], cap: number): string[] {
  if (rows.length === 0) return [`${title}: none`];
  const shown = rows.slice(0, cap).map((r) => `  ${r}`);
  const rest = rows.length - shown.length;
  return [`${title} (${rows.length}):`, ...shown, ...(rest > 0 ? [`  … and ${rest} more`] : [])];
}

export function renderReport(report: BetaPortReport, cap = REPORT_LIST_CAP): string {
  return [
    ...section('ported', report.ported, cap),
    ...section('mirrored', report.mirrored, cap),
    ...section('refused', report.refused, cap),
    ...section('skipped as already ported', report.skipped, cap),
    ...section('beta projects with no dev twin', report.noTwin, cap),
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
    report.waiting > 0
  );
}
