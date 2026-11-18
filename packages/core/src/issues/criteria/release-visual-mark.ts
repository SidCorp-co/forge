// A judge's mark of which of its issue's attachments show that issue's line on the release page
// (ISS-1308): a desktop frame, a phone frame, the still a clip opens on and the clip's length, sent
// as `releaseVisual` with a pass. Core picks no file and reads no name: each is named by its id or
// its download URL, as the attachment door answered it. Kernel input: a mark that cannot be placed
// is refused by name, and nothing is written.
//
//   rule                                                          code
//   names a file of this issue                                    VERDICT_RELEASE_VISUAL_FOREIGN
//   rides a pass; names a desktop or a phone frame, by id or URL;
//   each a clip or picture a page shows; a still is a picture;
//   a still and seconds go with a clip                            VERDICT_RELEASE_VISUAL_SHAPE

import {
  citedAttachmentId,
  RELEASE_CLIP_MAX_BYTES,
  releaseMediaKindOf,
} from '@forge/contracts/release-page';
import { RELEASE_VISUAL_MARK_SHAPE } from '@forge/contracts/release-visual';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import type { criterionVerdicts } from '../../db/schema-issue-criteria.js';
import { issueAttachments } from '../../db/schema-issues.js';
import type { VerdictRefusal } from './verdict-input.js';
import { verdictRefused } from './verdict-refused.js';

/** A `releaseVisual` as sent: each frame names an attachment by its id or its download URL. */
export interface ReleaseVisualMark {
  readonly desktop?: string | undefined;
  readonly phone?: string | undefined;
  readonly still?: string | undefined;
  readonly seconds?: number | undefined;
}

type VisualColumns = Pick<
  Partial<typeof criterionVerdicts.$inferInsert>,
  'visualDesktopId' | 'visualPhoneId' | 'visualStillId' | 'visualSeconds'
>;

const PARTS = ['desktop', 'phone', 'still'] as const;
type Part = (typeof PARTS)[number];

function shape(criterion: number, path: string, why: string): VerdictRefusal {
  return {
    code: 'VERDICT_RELEASE_VISUAL_SHAPE',
    criterion,
    path,
    detail: `criterion ${criterion}'s \`releaseVisual\` ${why}. A mark is ${RELEASE_VISUAL_MARK_SHAPE}. Nothing was written.`,
  };
}

/** What is wrong with the mark before any file is read, and the id each part names where nothing is. */
function markFault(
  criterion: number,
  verdict: string,
  mark: ReleaseVisualMark,
): VerdictRefusal | Map<Part, string> {
  if (verdict !== 'pass') {
    return shape(
      criterion,
      '/releaseVisual',
      `rides a \`${verdict}\`, and a release page shows what a pass judged: mark it on the pass`,
    );
  }
  if (!mark.desktop && !mark.phone) {
    return shape(criterion, '/releaseVisual', 'names neither a `desktop` nor a `phone` frame');
  }
  const ids = new Map<Part, string>();
  for (const part of PARTS) {
    const sent = mark[part];
    if (sent === undefined) continue;
    const id = citedAttachmentId(sent);
    if (!id) {
      return shape(
        criterion,
        `/releaseVisual/${part}`,
        `names its ${part} \`${sent}\`, which is no attachment id or download URL; a file is never read by its name, which an issue can hold twice`,
      );
    }
    ids.set(part, id);
  }
  return ids;
}

interface MarkedFile {
  id: string;
  mime: string;
  size: number;
}

/** What is wrong with the files the mark names, read from the issue's own attachments. */
function filesFault(
  criterion: number,
  mark: ReleaseVisualMark,
  ids: ReadonlyMap<Part, string>,
  files: readonly MarkedFile[],
): VerdictRefusal | null {
  for (const [part, id] of ids) {
    const file = files.find((f) => f.id === id);
    if (!file) {
      return {
        code: 'VERDICT_RELEASE_VISUAL_FOREIGN',
        criterion,
        path: `/releaseVisual/${part}`,
        detail: `criterion ${criterion}'s \`releaseVisual\` names its ${part} \`${id}\`, which is no attachment of this issue: attach the file to this issue (\`POST /api/issues/:id/attachments\`, field \`file\`) and name the id it answers. Nothing was written.`,
      };
    }
    const kind = releaseMediaKindOf(file.mime);
    if (!kind || file.size <= 0 || file.size > RELEASE_CLIP_MAX_BYTES) {
      return shape(
        criterion,
        `/releaseVisual/${part}`,
        `names its ${part} \`${id}\`, a \`${file.mime}\` of ${file.size} bytes, which no release page shows`,
      );
    }
    if (part === 'still' && kind !== 'picture') {
      return shape(criterion, '/releaseVisual/still', `names a still \`${id}\` that is a clip`);
    }
  }
  const clip = (['desktop', 'phone'] as const).some((part) => {
    const file = files.find((f) => f.id === ids.get(part));
    return file ? releaseMediaKindOf(file.mime) === 'clip' : false;
  });
  if (!clip && (mark.still !== undefined || mark.seconds !== undefined)) {
    const named = mark.still !== undefined ? 'still' : 'seconds';
    return shape(
      criterion,
      `/releaseVisual/${named}`,
      `names \`${named}\`, which belongs to a clip, and neither its desktop nor its phone frame is one`,
    );
  }
  return null;
}

/**
 * The visual columns a pass marking `releaseVisual` writes, once every file it names is read as an
 * attachment of this issue that a release page shows. Refused by name otherwise; nothing marked,
 * nothing written.
 */
export async function releaseVisualColumns(
  tx: Tx,
  issueId: string,
  draft: {
    criterion: number;
    verdict: string;
    releaseVisual?: ReleaseVisualMark | null | undefined;
  },
): Promise<VisualColumns> {
  const mark = draft.releaseVisual;
  if (!mark) return {};
  const read = markFault(draft.criterion, draft.verdict, mark);
  if (!(read instanceof Map)) throw verdictRefused(read);
  const files = await tx
    .select({ id: issueAttachments.id, mime: issueAttachments.mime, size: issueAttachments.size })
    .from(issueAttachments)
    .where(
      and(eq(issueAttachments.issueId, issueId), inArray(issueAttachments.id, [...read.values()])),
    );
  const fault = filesFault(draft.criterion, mark, read, files);
  if (fault) throw verdictRefused(fault);
  return {
    visualDesktopId: read.get('desktop') ?? null,
    visualPhoneId: read.get('phone') ?? null,
    visualStillId: read.get('still') ?? null,
    visualSeconds: mark.seconds ?? null,
  };
}
