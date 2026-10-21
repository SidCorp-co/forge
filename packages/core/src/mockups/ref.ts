/**
 * A mockup named from another module (REQ-49 BC-4): feedback filed about it and a chat about it
 * resolve `MK-n` or a uuid inside one project to its identity, and read keys back by id.
 */

import type { MockupKind, MockupStatus } from '@forge/contracts/mockups';
import type { ActorAgency } from '@forge/contracts/permissions';
import { inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { mockups } from '../db/schema-mockups.js';
import { getStorage } from '../integrations/index.js';
import { mockupCommentsAs } from './comments.js';
import { mockupKey, mockupViews, rowIn } from './read.js';

export interface MockupRef {
  id: string;
  key: string;
  name: string;
  kind: MockupKind;
  status: MockupStatus;
}

/** The mockup `ref` names in `projectId`, or null where it names none there. */
export async function mockupRefIn(projectId: string, ref: string): Promise<MockupRef | null> {
  try {
    const row = await rowIn(db, projectId, ref);
    return {
      id: row.id,
      key: mockupKey(row.mockupSeq),
      name: row.name,
      kind: row.kind,
      status: row.status,
    };
  } catch (err) {
    if (err instanceof HTTPException && err.status === 404) return null;
    throw err;
  }
}

/** The key and name of each mockup id, for a read that shows what an item is about. */
export async function mockupKeysOf(
  ids: readonly string[],
): Promise<Map<string, { key: string; name: string }>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: mockups.id, seq: mockups.mockupSeq, name: mockups.name })
    .from(mockups)
    .where(inArray(mockups.id, [...ids]));
  return new Map(rows.map((r) => [r.id, { key: mockupKey(r.seq), name: r.name }]));
}

const CHAT_TEXT_CHARS = 24_000;

/**
 * A mockup as a chat about it reads it (REQ-49 BC-4): its metadata, and as content its name,
 * caption, its text where it has one (an HTML page, a wireframe board, an API example; an image's
 * bytes are not text), cut at a bound, and every comment on it and its earlier revisions with where
 * each points. The caller passes the content through the `mockup.content` egress surface.
 */
export async function mockupForChat(
  projectId: string,
  ref: string,
  viewer: { userId: string; agency: ActorAgency },
): Promise<{
  key: string;
  meta: Record<string, unknown>;
  content: Record<string, unknown>;
} | null> {
  const found = await mockupRefIn(projectId, ref);
  if (!found) return null;
  const row = await rowIn(db, projectId, found.id);
  const [[view], { comments }] = await Promise.all([
    mockupViews(projectId, [row], viewer),
    mockupCommentsAs(viewer, projectId, found.id),
  ]);
  if (!view) return null;
  const textual = row.kind !== 'image' && row.kind !== 'sketch';
  const raw = textual ? (await getStorage().get(row.storagePath)).toString('utf8') : null;
  return {
    key: view.key,
    meta: {
      mockupKind: view.kind,
      status: view.status,
      round: view.round,
      revises: view.revises,
      revisedBy: view.revisedBy,
      about: `${view.target.type} ${view.target.key}${view.target.revision ? ` r${view.target.revision}` : ''}`,
      openComments: view.comments.open,
    },
    content: {
      title: view.name,
      caption: view.caption,
      ...(raw === null
        ? {}
        : {
            text: raw.length > CHAT_TEXT_CHARS ? `${raw.slice(0, CHAT_TEXT_CHARS)}…` : raw,
            textCut: raw.length > CHAT_TEXT_CHARS,
          }),
      comments: comments.map((c) => ({
        on: c.on,
        body: c.body,
        pin: c.pin,
        settled: c.settled ? `${c.settled.as} by ${c.settled.by}` : null,
      })),
    },
  };
}
