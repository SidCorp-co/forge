/**
 * Whether the tracker still holds what a verdict cites. Whether the object store still has that
 * attachment's BYTES is a different question, answered by the download route's 410
 * `ATTACHMENT_FILE_MISSING`; a citation pointing outside the tracker is reported as not followed.
 */

import { citationForm } from '../messaging/evidence-citation.js';

export type CitationStanding = 'held' | 'dangling' | 'unreachable' | 'elsewhere';

export interface CitationReport {
  readonly cited: string;
  readonly standing: CitationStanding;
}

export function citationStanding(cited: string, held: ReadonlySet<string>): CitationStanding {
  const form = citationForm(cited);
  if (form === 'machine-path') return 'unreachable';
  if (form !== 'attachment') return 'elsewhere';
  return held.has(cited.trim()) ? 'held' : 'dangling';
}

export function unresolvedCitations(
  cited: readonly string[],
  held: ReadonlySet<string>,
): CitationReport[] {
  const out: CitationReport[] = [];
  for (const one of cited) {
    const standing = citationStanding(one, held);
    if (standing === 'dangling' || standing === 'unreachable') out.push({ cited: one, standing });
  }
  return out;
}

function why(report: CitationReport): string {
  return report.standing === 'unreachable'
    ? `\`${report.cited}\` is a path on the machine that wrote it, which the tracker never held`
    : `\`${report.cited}\` names no attachment this issue holds`;
}

export function citationSentence(reports: readonly CitationReport[]): string {
  return `its evidence does not resolve: ${reports.map(why).join(', and ')}`;
}
