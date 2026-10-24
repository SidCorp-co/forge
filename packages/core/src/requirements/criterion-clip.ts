// What a business criterion's counting verdict cites to be seen (REQ-66 BC-8): the clip or picture the
// reporter of a shipped fix is shown beside the verdict when asked to confirm it.

import type { RequirementCoverage } from '@forge/contracts/requirements';

/** The clip or picture a criterion's counting verdict cites, where it cites one. */
export interface CriterionClip {
  name: string;
  mime: string;
  url: string;
}

const MEDIA = /\.(webm|mp4|mov|gif|png|jpe?g|webp)(\?|#|$)/i;

/**
 * What the verdict the coverage counts cites to be seen: the first file an issue's verdict keeps (its
 * clip or picture), or the first media link a verdict at the requirement names. Null where none counts.
 */
export function clipOf(c: RequirementCoverage): CriterionClip | null {
  const counts = c.counts;
  if (!counts) return null;
  if (counts.source === 'issue') {
    const file = c.issues.find(
      (i) => i.issueId === counts.issueId && i.criterion === counts.criterion,
    )?.files[0];
    return file
      ? { name: file.name, mime: file.mime, url: `/api/attachments/${file.attachmentId}/download` }
      : null;
  }
  const link = c.verdicts
    .find((v) => v.verdictId === counts.verdictId)
    ?.evidence.find((e) => /^https?:\/\//.test(e) && MEDIA.test(e));
  return link ? { name: link.split('/').pop() ?? link, mime: '', url: link } : null;
}
