/**
 * Whether the tracker still holds what a verdict cites. Whether the object store still has that
 * attachment's BYTES is a different question, answered by the download route's 404
 * `ATTACHMENT_FILE_MISSING`; a citation pointing outside the tracker is reported as not followed.
 */

import { citedAttachmentId } from '@forge/contracts/release-page';
import { citationForm } from '../messaging/evidence-citation.js';

/** What the tracker holds for one issue (its comments' included): file names and attachment ids. */
export interface HeldAttachments {
  readonly names: ReadonlySet<string>;
  /** Lower case. */
  readonly ids: ReadonlySet<string>;
}

type CitationStanding = 'held' | 'dangling' | 'unreachable' | 'elsewhere';

export interface CitationReport {
  readonly cited: string;
  readonly standing: CitationStanding;
}

/**
 * A citation is read in the three spellings the guides teach for an attachment: its file name, its
 * id, or its `/api/attachments/:id/download` URL. An attachment-shaped id or URL this issue does not
 * hold is dangling; an object-id-shaped string (a commit identity) and any other URL keep their
 * meaning and are not followed.
 */
function citationStanding(cited: string, held: HeldAttachments): CitationStanding {
  const form = citationForm(cited);
  if (form === 'machine-path') return 'unreachable';
  const id = citedAttachmentId(cited);
  if (id) return held.ids.has(id) ? 'held' : 'dangling';
  if (form !== 'attachment') return 'elsewhere';
  return held.names.has(cited.trim()) ? 'held' : 'dangling';
}

export function unresolvedCitations(
  cited: readonly string[],
  held: HeldAttachments,
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
