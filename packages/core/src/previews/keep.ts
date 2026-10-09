// Keeping an idea preview (REQ-41 BC-16; docs/proposals/chat-first.md "Keep"): the sketch branch's
// head, the patch id the box reports and the page's one rrweb snapshot become the requirement's
// picture of kind `preview`, and the assistant offers criteria drafted from what was asked. No
// screenshot is taken anywhere: the page's still is rrweb's own snapshot, scrubbed as a recording's
// batches are, and drawn by rrweb's replayer paused on it.

import {
  type KeepPreviewRequest,
  type KeepPreviewResponse,
  type KeptPreviewContent,
  PREVIEW_SNAPSHOT_LIMITS,
} from '@forge/contracts/preview';
import {
  accessFor,
  type PreviewActor,
  refuse,
  refuseRoomPreview,
  rowOf,
  throwRefusal,
} from './access.js';
import { askSnapshot } from './approve.js';
import { keptPreviewWriter } from './keep-port.js';
import { scrubEvents } from './recordings.js';
import { stateRefusal } from './rules.js';
import { itemOf } from './subject-reads.js';
import { askedOf } from './subjects.js';

/**
 * Keep an idea preview as its requirement's picture (needs `project.write`, as every picture write does).
 * The preview is live, so its box answers the snapshot: it commits the sketch's edits, pins the
 * commit, and reports the head and the patch id.
 */
export async function keepIdea(
  previewId: string,
  request: KeepPreviewRequest,
  actor: PreviewActor,
): Promise<KeepPreviewResponse> {
  const row = await rowOf(previewId);
  await accessFor(row.projectId, actor, 'project.write', 'keep the idea as a picture');
  refuseRoomPreview(row, 'settle');
  if (row.subjectKind !== 'idea' || row.subject?.kind !== 'idea') {
    throw refuse(
      'PREVIEW_KEEP_NOT_IDEA',
      `preview ${row.id} serves ${row.subjectKind === 'issue' ? "an issue's run, which is approved" : 'a past build, which is reproduced'}: only an idea preview is kept as a requirement's picture`,
    );
  }
  throwRefusal(stateRefusal(row.id, row.state, ['live'], 'be kept'));
  const bytes = Buffer.byteLength(JSON.stringify(request.snapshot));
  if (bytes > PREVIEW_SNAPSHOT_LIMITS.bytes) {
    throw refuse(
      'PREVIEW_KEEP_SNAPSHOT_INVALID',
      `the page snapshot is ${bytes} bytes, over the ${PREVIEW_SNAPSHOT_LIMITS.bytes} a kept preview holds: keep a smaller page`,
      '/snapshot',
    );
  }
  const item = await itemOf(row.projectId, row.subject.about.key);
  if (!item) {
    throw refuse(
      'PREVIEW_ITEM_UNKNOWN',
      `${row.subject.about.key} is no longer an item of this project`,
    );
  }
  const taken = await askSnapshot(row, true);
  if (!taken.head) {
    throw refuse(
      'PREVIEW_SNAPSHOT_UNAVAILABLE',
      `the box holding preview ${row.id} reported no branch head for the keep: it runs a forge-runner that does not commit a sketch (forge-runner update); nothing was kept`,
    );
  }
  const asked = await askedOf(row);
  const content: KeptPreviewContent = {
    previewId: row.id,
    branch: row.subject.branch,
    head: taken.head,
    base: taken.base,
    patchId: taken.patchId,
    files: taken.files,
    asked: asked.length > 0 ? asked : [item.title],
    snapshot: scrubEvents(request.snapshot) as KeptPreviewContent['snapshot'],
  };
  return keptPreviewWriter().write({
    projectId: row.projectId,
    actor,
    about:
      item.kind === 'requirement'
        ? { kind: 'requirement', key: item.key }
        : { kind: 'feedback', key: item.key, title: item.title },
    alt: request.alt,
    content,
  });
}
