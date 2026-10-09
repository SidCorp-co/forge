// The pictures of a requirement as the read model answers them (REQ-35): every one written, the
// revision's own among them, newest last; a revision shows the one its `picture_id` names.

import type {
  PictureContent,
  PictureKind,
  RequirementPictureView,
} from '@forge/contracts/requirement-pictures';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirementPictures } from '../db/schema-requirements.js';
import type { Person } from '../lib/people.js';

export type PictureRow = typeof requirementPictures.$inferSelect;

/** Every picture written for `requirementId`, oldest first. */
export function pictureRowsOf(requirementId: string): Promise<PictureRow[]> {
  return db
    .select()
    .from(requirementPictures)
    .where(eq(requirementPictures.requirementId, requirementId))
    .orderBy(asc(requirementPictures.writtenAt), asc(requirementPictures.id));
}

export function pictureView(
  p: PictureRow,
  people: ReadonlyMap<string, Person>,
): RequirementPictureView {
  return {
    id: p.id,
    kind: p.kind as PictureKind,
    content: p.content as PictureContent,
    alt: p.alt,
    roughSketch: true,
    drawnFor: p.drawnFor,
    writtenBy: p.writtenBy,
    writtenByName: people.get(p.writtenBy)?.name ?? null,
    writtenAgency: p.writtenAgency,
    writtenAt: p.writtenAt.toISOString(),
  };
}
