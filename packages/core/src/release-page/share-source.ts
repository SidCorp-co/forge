// How a release page is shared (REQ-40 BC-11): the `release` subject source of the Share port. The
// subject is the version; the frozen document is the page's user view as the person sharing it reads
// it now, with nothing a link's reader may act on. Each clip or picture is handed out only when the
// share is opened, as a short-lived download ticket minted for that opening and that file alone, so
// a frozen page never holds a link that outlives it. The port's type is the shares module's; this
// module meets it by shape, since `shares` sits after `release` and is never imported from here.

import type { ActorAgency } from '@forge/contracts/permissions';
import {
  type ReleaseHighlights,
  type ReleasePageSnapshot,
  ReleasePageSnapshotSchema,
} from '@forge/contracts/release-page';
import {
  SHARE_SUBJECT_KINDS,
  type ShareFrozen,
  type ShareRefusalCode,
} from '@forge/contracts/shares';
import type { ProjectAccess } from '../lib/authz.js';
import { isRefusal, refuser } from '../lib/refusal.js';
import { holds } from '../permissions/index.js';
import { createDownloadTicket } from '../uploads/index.js';
import { readReleasePage } from './read.js';
import { refreshInBackground } from './refresh.js';

const refuseShare = refuser<ShareRefusalCode>('SHARE_REFUSED');

/** The highlights with every media link taken out, or each replaced by `link(attachmentId)`. */
async function relinked(
  highlights: ReleaseHighlights,
  link: (attachmentId: string) => Promise<string> | null,
): Promise<ReleaseHighlights> {
  if (highlights.state !== 'drafted') return highlights;
  const out = [];
  for (const h of highlights.highlights) {
    if (!h.media) {
      out.push(h);
      continue;
    }
    const { url: _url, ...media } = h.media;
    const url = await link(media.attachmentId);
    out.push({ ...h, media: url ? { ...media, url } : media });
  }
  return { ...highlights, highlights: out };
}

async function freeze(input: {
  projectId: string;
  subjectId: string;
  userId: string;
  agency: ActorAgency;
  access: ProjectAccess;
}): Promise<ReleasePageSnapshot> {
  let page: Awaited<ReturnType<typeof readReleasePage>>;
  try {
    page = await readReleasePage({
      projectId: input.projectId,
      version: input.subjectId,
      view: 'user',
      viewer: {
        userId: input.userId,
        agency: input.agency,
        isAdmin: holds(input.access, 'project.admin'),
        mayApprove: holds(input.access, 'releases.approve'),
        mayShare: false,
      },
      onOwed: refreshInBackground,
    });
  } catch (err) {
    if (isRefusal(err, 'RELEASE_PAGE_NOT_FOUND') || isRefusal(err, 'RELEASE_VERSION_SHAPE')) {
      throw refuseShare(
        'SHARE_SUBJECT_NOT_FOUND',
        `"${input.subjectId}" is not a release of this project; a release subject is the version of one release, as its page names it`,
        '/subjectId',
      );
    }
    throw err;
  }
  const frozen = {
    ...page,
    view: 'user' as const,
    technical: null,
    highlights: await relinked(page.highlights, () => null),
    can: { share: false, export: true, approve: false },
  };
  return ReleasePageSnapshotSchema.parse(frozen);
}

/** The frozen page as one opening hands it out: each clip or picture behind a ticket minted now, for this opener. */
async function opened(
  frozen: ShareFrozen,
  ctx: { projectId: string; openerId: string | null },
): Promise<ShareFrozen> {
  const page = ReleasePageSnapshotSchema.parse(frozen);
  return {
    ...page,
    highlights: await relinked(page.highlights, async (attachmentId) => {
      const ticket = await createDownloadTicket({
        targetType: 'issue',
        attachmentId,
        projectId: ctx.projectId,
        issuedToUserId: ctx.openerId,
        issuedToDeviceId: null,
      });
      return `/api/uploads/download/${ticket.id}`;
    }),
  };
}

export const releaseShareSource = {
  kind: SHARE_SUBJECT_KINDS[3],
  freeze,
  opened,
};
