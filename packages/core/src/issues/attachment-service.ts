import { and, asc, eq, inArray } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { issueAttachments } from '../db/schema.js';
import {
  allowedSetForTarget,
  mimeRefusalMessage,
  resolveAttachmentMime,
  safeName,
} from '../lib/attachment-mime.js';
import type { ExistingAttachmentRef } from '../lib/attachment-refs.js';
import { safeRecordActivity } from '../pipeline/activity.js';
import { getStorage } from '../storage/index.js';
import type { ActorAgency } from './actor-agency.js';

export { safeName };

export type AttachmentErrorCode =
  | 'MIME_NOT_ALLOWED'
  | 'FILE_TOO_LARGE'
  | 'EMPTY_FILE'
  | 'INVALID_NAME'
  | 'INVALID_BASE64'
  | 'PAYLOAD_TOO_LARGE'
  | 'ATTACHMENT_NAME_TAKEN';

export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;
  // cm:guard every route that maps this class must forward `details` — an ATTACHMENT_NAME_TAKEN whose body drops it names a collision without naming what it collided with, and a MIME_NOT_ALLOWED whose body drops it names a type without naming the set (ISS-957, ISS-963)
  // cm:guard this rides to the client as `body.details`, so it must stay free of storage paths, uploader ids and anything else the refusal does not need
  readonly details: unknown;
  constructor(code: AttachmentErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'AttachmentError';
  }
}

/**
 * The oldest attachment on this issue stored under exactly `name`, or null.
 *
 * Oldest, not newest, because an issue that already carries duplicates from
 * before this rule existed has several, and the first one is the document its
 * records were citing when they were written.
 */
export async function findIssueAttachmentByName(
  issueId: string,
  name: string,
): Promise<ExistingAttachmentRef | null> {
  const [row] = await db
    .select({ id: issueAttachments.id, name: issueAttachments.name })
    .from(issueAttachments)
    .where(and(eq(issueAttachments.issueId, issueId), eq(issueAttachments.name, name)))
    .orderBy(asc(issueAttachments.createdAt))
    .limit(1);
  if (!row) return null;
  return { id: row.id, name: row.name, url: `/api/attachments/${row.id}/download` };
}

export function nameTakenError(existing: ExistingAttachmentRef, scope: string): AttachmentError {
  return new AttachmentError(
    'ATTACHMENT_NAME_TAKEN',
    `an attachment named "${existing.name}" is already on this ${scope} (id ${existing.id}) — cite it, delete it, or upload under a different name`,
    { existing },
  );
}

export interface PersistIssueAttachmentInput {
  issueId: string;
  name: string;
  mime: string;
  bytes: Buffer;
  uploaderId: string;
  // cm:guard required, not defaulted — `uploaderId` is the row's owner and stays the owner whoever uploaded, so it cannot answer the agency question, and a default here would record every agent upload as the person who holds the token.
  uploaderAgency: ActorAgency;
}

export interface PersistedIssueAttachment {
  id: string;
  issueId: string;
  uploaderId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: Date;
  url: string;
}

/**
 * Everything an attachment is refused for, decided without touching storage or
 * the DB — so a batch can ask about every member before any of them lands.
 * Returns the type the row will be stored under, which is read from the BYTES
 * and only then narrowed by the name (ISS-957).
 */
export function validateIssueAttachment(input: {
  name: string;
  mime: string;
  bytes: Buffer;
}): string {
  if (!input.name) throw new AttachmentError('INVALID_NAME', 'name is empty after sanitisation');
  if (input.bytes.byteLength <= 0) throw new AttachmentError('EMPTY_FILE', 'empty file');
  if (input.bytes.byteLength > env.UPLOADS_MAX_BYTES)
    throw new AttachmentError('FILE_TOO_LARGE', 'file too large');

  const resolved = resolveAttachmentMime({
    target: 'issue',
    name: input.name,
    declaredMime: input.mime,
    bytes: input.bytes,
  });
  if (!resolved.ok) {
    throw new AttachmentError('MIME_NOT_ALLOWED', mimeRefusalMessage(resolved), {
      reason: resolved.reason,
      allowed: allowedSetForTarget('issue'),
    });
  }
  return resolved.mime;
}

/**
 * Validate + store a single issue attachment. Shared by the REST multipart
 * route (POST /issues/:id/attachments), the REST inline create path
 * (POST /projects/:id/issues with attachments[]), and the MCP forge_issues
 * create action. Behaviour must stay byte-identical across surfaces so the
 * UIs render rows uniformly regardless of upload origin.
 */
export async function persistIssueAttachment(
  input: PersistIssueAttachmentInput,
): Promise<PersistedIssueAttachment> {
  const { issueId, bytes, uploaderId } = input;
  const name = safeName(input.name || 'file');
  const mime = validateIssueAttachment({ name, mime: input.mime, bytes });

  // cm:guard decide the collision on the SANITISED name, never `input.name` — that is what the row stores and what a record cites, and `a b.md`/`a_b.md` both sanitise to `a_b.md`, so checking the input would admit the pairs that actually collide and refuse the pairs that do not (ISS-963)
  const taken = await findIssueAttachmentByName(issueId, name);
  if (taken) throw nameTakenError(taken, 'issue');

  const key = `issues/${issueId}/${Date.now()}-${name}`;
  const { path: storedPath } = await getStorage().put(key, bytes, mime);

  const [inserted] = await db
    .insert(issueAttachments)
    .values({ issueId, uploaderId, name, path: storedPath, mime, size: bytes.byteLength })
    .returning({
      id: issueAttachments.id,
      issueId: issueAttachments.issueId,
      uploaderId: issueAttachments.uploaderId,
      name: issueAttachments.name,
      mime: issueAttachments.mime,
      size: issueAttachments.size,
      createdAt: issueAttachments.createdAt,
    });
  if (!inserted) throw new Error('issue_attachments: insert returned no row');

  void safeRecordActivity({
    issueId,
    actor: { type: 'user', id: uploaderId, agency: input.uploaderAgency },
    action: 'issue.attachment.uploaded',
    payload: {
      attachmentId: inserted.id,
      name: inserted.name,
      mime: inserted.mime,
      size: inserted.size,
    },
  });

  return { ...inserted, url: `/api/attachments/${inserted.id}/download` };
}

// cm:guard validate the charset BEFORE decoding, never after: `Buffer.from(s, 'base64')` drops invalid characters silently rather than throwing, so a malformed payload decodes to a short buffer and the only remaining symptom is a truncated blob already written to storage.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function decodeBase64Strict(input: string): Buffer | null {
  const trimmed = input.trim().replace(/\s+/g, '');
  if (trimmed.length === 0 || trimmed.length % 4 !== 0) return null;
  if (!BASE64_RE.test(trimmed)) return null;
  return Buffer.from(trimmed, 'base64');
}

export interface Base64AttachmentInput {
  name: string;
  mime: string;
  dataBase64: string;
}

export interface AttachmentErrorEntry {
  index: number;
  name: string;
  code: AttachmentErrorCode | 'INTERNAL';
  message: string;
  details?: unknown;
}

function toErrorEntry(index: number, name: string, err: unknown): AttachmentErrorEntry {
  return err instanceof AttachmentError
    ? { index, name, code: err.code, message: err.message, details: err.details }
    : {
        index,
        name,
        code: 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
      };
}

export interface DecodedAttachment {
  name: string;
  mime: string;
  bytes: Buffer;
}

/**
 * Decode base64 inputs and apply total/per-file size caps. Pure (no DB), so
 * callers can run it BEFORE opening a transaction — fail-fast on bad base64
 * or oversized payloads keeps the parent row (issue/comment) from being
 * committed when the attachments are unusable.
 *
 * Throws AttachmentError with code INVALID_BASE64 or PAYLOAD_TOO_LARGE.
 */
export function decodeAndValidateAttachments(
  items: readonly Base64AttachmentInput[],
): DecodedAttachment[] {
  if (items.length === 0) return [];
  const decoded: DecodedAttachment[] = [];
  for (const [i, a] of items.entries()) {
    const buf = decodeBase64Strict(a.dataBase64);
    if (!buf) {
      throw new AttachmentError(
        'INVALID_BASE64',
        `attachments[${i}].dataBase64 is not valid base64`,
      );
    }
    decoded.push({ name: a.name, mime: a.mime, bytes: buf });
  }
  const limit = env.UPLOADS_MAX_BYTES;
  const sizes = decoded.map((d) => d.bytes.byteLength);
  const total = sizes.reduce((s, n) => s + n, 0);
  if (total > limit || sizes.some((n) => n > limit)) {
    throw new AttachmentError(
      'PAYLOAD_TOO_LARGE',
      `total=${total} per=[${sizes.map((n, i) => `${i}:${n}`).join(',')}] limit=${limit}`,
    );
  }
  return decoded;
}

/**
 * Undo a partly-landed batch: the blobs first, then the rows, best-effort. A
 * storage delete that fails leaves an orphan blob no row points at, which is
 * recoverable; leaving the ROW is not, because the issue then shows an
 * attachment from a batch that was refused.
 */
async function discardIssueAttachments(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: issueAttachments.id, path: issueAttachments.path })
    .from(issueAttachments)
    .where(inArray(issueAttachments.id, [...ids]));
  for (const row of rows) {
    try {
      await getStorage().delete(row.path);
    } catch {
      // cm:why swallowed on purpose, as in the comment twin: an orphan blob is recoverable by a sweep, whereas a row surviving a refused batch is the half-landed attachment this path promises cannot exist.
    }
  }
  await db.delete(issueAttachments).where(inArray(issueAttachments.id, [...ids]));
}

/**
 * Persist a pre-decoded batch, whole or not at all (ISS-957).
 *
 * Every member is judged before any of them lands, so the common failure — one
 * unacceptable file among several — leaves the issue exactly as it was rather
 * than half-populated under names the caller cannot re-send. A failure DURING
 * the persist loop (a name collision, a storage fault) is rolled back for the
 * same reason. Callers typically run decodeAndValidateAttachments() first,
 * outside any transaction.
 */
export async function persistDecodedIssueAttachments(
  issueId: string,
  decoded: readonly DecodedAttachment[],
  uploaderId: string,
  uploaderAgency: ActorAgency,
): Promise<{ persisted: PersistedIssueAttachment[]; errors: AttachmentErrorEntry[] }> {
  const errors: AttachmentErrorEntry[] = [];
  for (const [i, d] of decoded.entries()) {
    try {
      validateIssueAttachment({
        name: safeName(d.name || 'file'),
        mime: d.mime,
        bytes: d.bytes,
      });
    } catch (err) {
      errors.push(toErrorEntry(i, d.name, err));
    }
  }
  if (errors.length > 0) return { persisted: [], errors };

  const persisted: PersistedIssueAttachment[] = [];
  for (const [i, d] of decoded.entries()) {
    try {
      persisted.push(
        await persistIssueAttachment({
          issueId,
          name: d.name,
          mime: d.mime,
          bytes: d.bytes,
          uploaderId,
          uploaderAgency,
        }),
      );
    } catch (err) {
      await discardIssueAttachments(persisted.map((a) => a.id));
      return { persisted: [], errors: [toErrorEntry(i, d.name, err)] };
    }
  }
  return { persisted, errors };
}

/**
 * Convenience: validate + persist in one call. Use when the parent row is
 * already committed (e.g. MCP forge_issues create which inserts the issue
 * row before processing attachments).
 */
export async function persistIssueAttachmentsFromBase64(
  issueId: string,
  items: readonly Base64AttachmentInput[],
  uploaderId: string,
  uploaderAgency: ActorAgency,
): Promise<{ persisted: PersistedIssueAttachment[]; errors: AttachmentErrorEntry[] }> {
  const decoded = decodeAndValidateAttachments(items);
  return persistDecodedIssueAttachments(issueId, decoded, uploaderId, uploaderAgency);
}

/** Metadata view of an issue attachment (no bytes). Mirrors the comment
 * `CommentAttachmentLite` shape so MCP serializers render both uniformly. */
export interface IssueAttachmentLite {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  createdAt: Date;
}

/**
 * List an issue's attachments (metadata only) for read surfaces — the MCP
 * `forge_issues`/`forge_step_start` serializers. `url` is the same download
 * path the REST attachment routes expose so every surface points at one route.
 */
export async function listIssueAttachments(issueId: string): Promise<IssueAttachmentLite[]> {
  const rows = await db
    .select({
      id: issueAttachments.id,
      name: issueAttachments.name,
      mime: issueAttachments.mime,
      size: issueAttachments.size,
      createdAt: issueAttachments.createdAt,
    })
    .from(issueAttachments)
    .where(eq(issueAttachments.issueId, issueId))
    .orderBy(asc(issueAttachments.createdAt));
  return rows.map((r) => ({ ...r, url: `/api/attachments/${r.id}/download` }));
}
