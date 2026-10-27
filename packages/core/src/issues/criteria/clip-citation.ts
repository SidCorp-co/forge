// The screen clip an observable criterion's judgement cites (REQ-40 BC-4), found on the issue by
// the name, id or download URL the evidence names it by.

import type { CriterionClass } from '@forge/contracts/issue-design';
import { citedAttachmentId, RELEASE_CLIP_MIMES } from '@forge/contracts/release-page';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issueAttachments } from '../../db/schema-issues.js';
import type { VerdictRefusal } from './verdict-input.js';

/** The judgements of an observable criterion that owe a clip: every one but a skip, which judged nothing. */
const CLIPPED_VERDICTS: ReadonlySet<string> = new Set(['pass', 'short', 'fail']);

/**
 * REQ-40 BC-4: a judgement of a criterion the design classes observable cites a screen clip of the
 * run that shows it (a WebM or MP4 attached to the issue, named in `evidence`), so a release page has
 * something to show; one judged without a clip says why in `withoutClip`. A verdict's `reason` is
 * what it found, which every judge writes, so it never stands in for that why.
 */
export async function clipFault(
  tx: Tx,
  issueId: string,
  draft: {
    criterion: number;
    verdict: string;
    evidence: readonly string[];
    withoutClip?: string | null | undefined;
  },
  criterionClass: CriterionClass | null,
): Promise<VerdictRefusal | null> {
  if (criterionClass !== 'observable' || !CLIPPED_VERDICTS.has(draft.verdict)) return null;
  if (draft.withoutClip?.trim()) return null;
  const cited = draft.evidence.map((e) => e.trim()).filter(Boolean);
  if (cited.length > 0) {
    // a clip is cited by its name, its id or its download URL: the three the attachment door answers
    // with (adminhub-fe ISS-53 cited the id, then the URL, and was refused each time)
    const ids = [...new Set(cited.flatMap((c) => citedAttachmentId(c) ?? []))];
    const clips = await tx
      .select({ name: issueAttachments.name })
      .from(issueAttachments)
      .where(
        and(
          eq(issueAttachments.issueId, issueId),
          ids.length > 0
            ? or(inArray(issueAttachments.name, cited), inArray(issueAttachments.id, ids))
            : inArray(issueAttachments.name, cited),
          inArray(issueAttachments.mime, [...RELEASE_CLIP_MIMES]),
        ),
      )
      .limit(1);
    if (clips.length > 0) return null;
  }
  return {
    code: 'VERDICT_CLIP_REQUIRED',
    criterion: draft.criterion,
    detail: `criterion ${draft.criterion} is observable on the running build, and a \`${draft.verdict}\` on it cites a screen clip of the run that shows it: record one (the project's knowledge names its recorder), attach the WebM or MP4 to this issue (\`POST /api/issues/:id/attachments\`, field \`file\`) and cite it in \`evidence\` by its name, its id or its download URL (\`/api/attachments/:id/download\`); or say why it was judged without one in \`withoutClip\` (a \`without-clip\` line in a record). \`reason\` says what was found and never stands in for it`,
  };
}
