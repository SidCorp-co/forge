// The file a judgement on the running build cites, found on the issue by the name, id or download
// URL the evidence names it by: the screen clip of an observable criterion (REQ-40 BC-4), the
// capture of a server-side check (REQ-36 BC-21).

import type { CriterionClass } from '@forge/contracts/issue-design';
import { citedAttachmentId, RELEASE_CLIP_MIMES } from '@forge/contracts/release-page';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issueAttachments } from '../../db/schema-issues.js';
import type { VerdictRefusal } from './verdict-input.js';

/** The judgements that owe the file they rest on: every one but a skip, which judged nothing. */
const CITING_VERDICTS: ReadonlySet<string> = new Set(['pass', 'short', 'fail']);

interface EvidenceDraft {
  criterion: number;
  verdict: string;
  evidence: readonly string[];
  withoutClip?: string | null | undefined;
}

/**
 * Whether `evidence` names a file attached to the issue, by its name, its id or its download URL
 * (the three the attachment door answers with: adminhub-fe ISS-53 cited the id, then the URL, and
 * was refused each time), of one of `mimes` where it is given.
 */
async function citesAttachment(
  tx: Tx,
  issueId: string,
  evidence: readonly string[],
  mimes: readonly string[] | null,
): Promise<boolean> {
  const cited = evidence.map((e) => e.trim()).filter(Boolean);
  if (cited.length === 0) return false;
  const ids = [...new Set(cited.flatMap((c) => citedAttachmentId(c) ?? []))];
  const found = await tx
    .select({ name: issueAttachments.name })
    .from(issueAttachments)
    .where(
      and(
        eq(issueAttachments.issueId, issueId),
        ids.length > 0
          ? or(inArray(issueAttachments.name, cited), inArray(issueAttachments.id, ids))
          : inArray(issueAttachments.name, cited),
        mimes ? inArray(issueAttachments.mime, [...mimes]) : undefined,
      ),
    )
    .limit(1);
  return found.length > 0;
}

/**
 * REQ-40 BC-4: a judgement of a criterion the design classes observable cites a screen clip of the
 * run that shows it (a WebM or MP4 attached to the issue, named in `evidence`), so a release page has
 * something to show; one judged without a clip says why in `withoutClip`. A verdict's `reason` is
 * what it found, which every judge writes, so it never stands in for that why.
 *
 * REQ-36 BC-21: a judgement of a server-side check, which no screen shows, owes no clip; it cites
 * the capture of what was run inside the running server (any file attached to the issue, named in
 * `evidence`), and nothing stands in for it, `withoutClip` included.
 */
export async function clipFault(
  tx: Tx,
  issueId: string,
  draft: EvidenceDraft,
  criterionClass: CriterionClass | null,
): Promise<VerdictRefusal | null> {
  if (!CITING_VERDICTS.has(draft.verdict)) return null;
  if (criterionClass === 'server_side') {
    if (await citesAttachment(tx, issueId, draft.evidence, null)) return null;
    return {
      code: 'VERDICT_CAPTURE_REQUIRED',
      criterion: draft.criterion,
      detail: `criterion ${draft.criterion} is a server-side check in the issue's design, and a \`${draft.verdict}\` on it cites the capture of what was run inside the running server (its output, the build it ran against): attach it to this issue (\`POST /api/issues/:id/attachments\`, field \`file\`) and cite it in \`evidence\` by its name, its id or its download URL (\`/api/attachments/:id/download\`). It owes no screen clip, so \`withoutClip\` does not stand in for it, nor does \`reason\``,
    };
  }
  if (criterionClass !== 'observable') return null;
  if (draft.withoutClip?.trim()) return null;
  if (await citesAttachment(tx, issueId, draft.evidence, RELEASE_CLIP_MIMES)) return null;
  return {
    code: 'VERDICT_CLIP_REQUIRED',
    criterion: draft.criterion,
    detail: `criterion ${draft.criterion} is observable on the running build, and a \`${draft.verdict}\` on it cites a screen clip of the run that shows it: record one (the project's knowledge names its recorder), attach the WebM or MP4 to this issue (\`POST /api/issues/:id/attachments\`, field \`file\`) and cite it in \`evidence\` by its name, its id or its download URL (\`/api/attachments/:id/download\`); or say why it was judged without one in \`withoutClip\` (a \`without-clip\` line in a record). \`reason\` says what was found and never stands in for it. A check seen only inside the running server is classed \`server_side\` in the design (PUT /api/issues/:id/design) and cites its capture instead`,
  };
}
