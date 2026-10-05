import type { IssueAttachmentRefusalCode } from '@forge/contracts/issues';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueAttachments } from '../db/schema.js';
import {
  allowedSetForTarget,
  mimeRefusalMessage,
  NAME_MAX_BYTES,
  nameExceedsByteBudget,
  resolveAttachmentMime,
  safeName,
} from '../lib/attachment-mime.js';
import { lockAttachmentName, type NameCheckExecutor } from '../lib/attachment-name-lock.js';
import type { ExistingAttachmentRef } from '../lib/attachment-refs.js';
import { env } from '../lib/env.js';
import { isRefusal, type RefusalError, refuser } from '../lib/refusal.js';
import { safeRecordActivity } from './activity.js';
import { getStorage } from './ports.js';

export { safeName };

const refuse = refuser<IssueAttachmentRefusalCode>('ATTACHMENT_REFUSED');

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
  executor: NameCheckExecutor = db,
): Promise<ExistingAttachmentRef | null> {
  const [row] = await executor
    .select({ id: issueAttachments.id, name: issueAttachments.name })
    .from(issueAttachments)
    .where(and(eq(issueAttachments.issueId, issueId), eq(issueAttachments.name, name)))
    .orderBy(asc(issueAttachments.createdAt))
    .limit(1);
  if (!row) return null;
  return { id: row.id, name: row.name, url: `/api/attachments/${row.id}/download` };
}

export function nameTakenError(existing: ExistingAttachmentRef, scope: string): RefusalError {
  return refuse(
    'ATTACHMENT_NAME_TAKEN',
    `an attachment named "${existing.name}" is already on this ${scope} (id ${existing.id}, ${existing.url}) — cite it, delete it, or upload under a different name`,
    '/name',
  );
}

interface PersistIssueAttachmentInput {
  issueId: string;
  name: string;
  mime: string;
  bytes: Buffer;
  uploaderId: string;
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
function validateIssueAttachment(input: { name: string; mime: string; bytes: Buffer }): string {
  if (!input.name) throw refuse('INVALID_NAME', 'name is empty after sanitisation', '/name');
  if (nameExceedsByteBudget(input.name))
    throw refuse(
      'INVALID_NAME',
      `name is longer than ${NAME_MAX_BYTES} bytes of UTF-8 — rename the file and upload it again`,
      '/name',
    );
  if (input.bytes.byteLength <= 0) throw refuse('EMPTY_FILE', 'empty file');
  if (input.bytes.byteLength > env.UPLOADS_MAX_BYTES)
    throw refuse('FILE_TOO_LARGE', `file too large: at most ${env.UPLOADS_MAX_BYTES} bytes`);

  const resolved = resolveAttachmentMime({
    target: 'issue',
    name: input.name,
    declaredMime: input.mime,
    bytes: input.bytes,
  });
  if (!resolved.ok) {
    throw refuse(
      'MIME_NOT_ALLOWED',
      `${mimeRefusalMessage(resolved)}; allowed: ${allowedSetForTarget('issue').extensions.join(', ')}, or any extension whose bytes are text`,
      '/mime',
    );
  }
  return resolved.mime;
}

/**
 * Validate + store a single issue attachment. Shared by the REST multipart
 * route (POST /issues/:id/attachments) and the REST inline create path
 * (POST /projects/:id/issues with attachments[]). Behaviour must stay
 * byte-identical across both so the UIs render rows uniformly.
 */
export async function persistIssueAttachment(
  input: PersistIssueAttachmentInput,
): Promise<PersistedIssueAttachment> {
  const { issueId, bytes, uploaderId } = input;
  const name = safeName(input.name || 'file');
  const mime = validateIssueAttachment({ name, mime: input.mime, bytes });

  const inserted = await db.transaction(async (tx) => {
    await lockAttachmentName(tx, 'issue', issueId, name);

    const taken = await findIssueAttachmentByName(issueId, name, tx);
    if (taken) throw nameTakenError(taken, 'issue');

    const key = `issues/${issueId}/${Date.now()}-${name}`;
    const { path: storedPath } = await getStorage().put(key, bytes, mime);

    const [row] = await tx
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
    return row;
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
  code: string;
  message: string;
}

function toErrorEntry(index: number, name: string, err: unknown): AttachmentErrorEntry {
  return isRefusal(err)
    ? {
        index,
        name,
        code: err.refusals[0]?.code ?? err.fallbackCode,
        message: err.refusals[0]?.detail ?? err.message,
      }
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
 * Refuses INVALID_BASE64, PAYLOAD_TOO_LARGE, a name or type the attachment rules refuse, and a
 * name the batch carries twice — so a create refuses whole before its issue is written.
 */
export function decodeAndValidateAttachments(
  items: readonly Base64AttachmentInput[],
): DecodedAttachment[] {
  if (items.length === 0) return [];
  const decoded: DecodedAttachment[] = [];
  for (const [i, a] of items.entries()) {
    const buf = decodeBase64Strict(a.dataBase64);
    if (!buf) {
      throw refuse(
        'INVALID_BASE64',
        `attachments[${i}].dataBase64 is not valid base64`,
        `/attachments/${i}/dataBase64`,
      );
    }
    decoded.push({ name: a.name, mime: a.mime, bytes: buf });
  }
  const seen = new Set<string>();
  for (const [i, d] of decoded.entries()) {
    const name = safeName(d.name || 'file');
    validateIssueAttachment({ name, mime: d.mime, bytes: d.bytes });
    if (seen.has(name)) {
      throw refuse(
        'ATTACHMENT_NAME_TAKEN',
        `this batch carries "${name}" more than once — an attachment name is one document`,
        `/attachments/${i}/name`,
      );
    }
    seen.add(name);
  }
  const limit = env.UPLOADS_MAX_BYTES;
  const sizes = decoded.map((d) => d.bytes.byteLength);
  const total = sizes.reduce((s, n) => s + n, 0);
  if (total > limit || sizes.some((n) => n > limit)) {
    throw refuse(
      'PAYLOAD_TOO_LARGE',
      `total=${total} per=[${sizes.map((n, i) => `${i}:${n}`).join(',')}] limit=${limit}`,
      '/attachments',
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
    } catch {}
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
    const name = safeName(d.name || 'file');
    try {
      const taken = await findIssueAttachmentByName(issueId, name);
      if (taken) throw nameTakenError(taken, 'issue');
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

/** Removes one attachment's row; its stored file is the caller's to delete first. */
export async function deleteIssueAttachment(attachmentId: string): Promise<void> {
  await db.delete(issueAttachments).where(eq(issueAttachments.id, attachmentId));
}
