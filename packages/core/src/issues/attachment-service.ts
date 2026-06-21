import { asc, eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { issueAttachments } from '../db/schema.js';
import { safeRecordActivity } from '../pipeline/activity.js';
import { getStorage } from '../storage/index.js';

export const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export function safeName(name: string): string {
  const cleaned = name.replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.slice(0, 200) || 'file';
}

export type AttachmentErrorCode =
  | 'MIME_NOT_ALLOWED'
  | 'FILE_TOO_LARGE'
  | 'EMPTY_FILE'
  | 'INVALID_NAME'
  | 'INVALID_BASE64'
  | 'PAYLOAD_TOO_LARGE';

export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;
  constructor(code: AttachmentErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'AttachmentError';
  }
}

export interface PersistIssueAttachmentInput {
  issueId: string;
  name: string;
  mime: string;
  bytes: Buffer;
  uploaderId: string;
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
 * Validate + store a single issue attachment. Shared by the REST multipart
 * route (POST /issues/:id/attachments), the REST inline create path
 * (POST /projects/:id/issues with attachments[]), and the MCP forge_issues
 * create action. Behaviour must stay byte-identical across surfaces so the
 * UIs render rows uniformly regardless of upload origin.
 */
export async function persistIssueAttachment(
  input: PersistIssueAttachmentInput,
): Promise<PersistedIssueAttachment> {
  const { issueId, mime, bytes, uploaderId } = input;
  if (bytes.byteLength <= 0) throw new AttachmentError('EMPTY_FILE', 'empty file');
  if (bytes.byteLength > env.UPLOADS_MAX_BYTES)
    throw new AttachmentError('FILE_TOO_LARGE', 'file too large');
  if (!ALLOWED_MIMES.has(mime))
    throw new AttachmentError('MIME_NOT_ALLOWED', `mime not allowed: ${mime}`);
  const name = safeName(input.name || 'file');
  if (!name) throw new AttachmentError('INVALID_NAME', 'name is empty after sanitisation');

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
    actor: { type: 'user', id: uploaderId },
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

// Strict base64 charset check. Buffer.from('xx', 'base64') silently drops
// invalid characters, so we validate the input string first to surface a
// useful BAD_REQUEST instead of writing a truncated blob to disk.
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
 * Persist a pre-decoded batch. Per-attachment failures are collected
 * (partial success), mirroring forge_comments. Callers typically run
 * decodeAndValidateAttachments() first, outside any transaction.
 */
export async function persistDecodedIssueAttachments(
  issueId: string,
  decoded: readonly DecodedAttachment[],
  uploaderId: string,
): Promise<{ persisted: PersistedIssueAttachment[]; errors: AttachmentErrorEntry[] }> {
  const persisted: PersistedIssueAttachment[] = [];
  const errors: AttachmentErrorEntry[] = [];
  for (const [i, d] of decoded.entries()) {
    try {
      persisted.push(
        await persistIssueAttachment({
          issueId,
          name: d.name,
          mime: d.mime,
          bytes: d.bytes,
          uploaderId,
        }),
      );
    } catch (err) {
      if (err instanceof AttachmentError) {
        errors.push({ index: i, name: d.name, code: err.code, message: err.message });
      } else {
        errors.push({
          index: i,
          name: d.name,
          code: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        });
      }
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
): Promise<{ persisted: PersistedIssueAttachment[]; errors: AttachmentErrorEntry[] }> {
  const decoded = decodeAndValidateAttachments(items);
  return persistDecodedIssueAttachments(issueId, decoded, uploaderId);
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
