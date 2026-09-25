import {
  ATTACHMENT_NAME_MAX_BYTES,
  attachmentNameExceedsBudget,
  CONVERSATION_MIMES,
  SESSION_MIMES,
  safeAttachmentName,
} from '@forge/contracts';

export type AttachmentTarget = 'issue' | 'comment' | 'session' | 'conversation';

const ISSUE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'text/html',
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
] as const;

const COMMENT_MIMES = ISSUE_MIMES.filter((m) => !m.startsWith('video/'));

const ALLOWED_BY_TARGET: Record<AttachmentTarget, ReadonlySet<string>> = {
  issue: new Set(ISSUE_MIMES),
  comment: new Set(COMMENT_MIMES),
  session: new Set(SESSION_MIMES),
  conversation: new Set(CONVERSATION_MIMES),
};

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const TEXT_FORMATS = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'image/svg+xml',
]);

function extensionOf(name: string): string {
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
}

export function mimeFromName(name: string): string {
  return EXT_MIME[extensionOf(name)] ?? 'text/plain';
}

/** Strip path separators and anything that is not part of a name; keep the extension. */
export const safeName = safeAttachmentName;
export const NAME_MAX_BYTES = ATTACHMENT_NAME_MAX_BYTES;
export const nameExceedsByteBudget = attachmentNameExceedsBudget;

const TEXT_CONTROLS = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x1b]);
function isBinaryControl(codePoint: number): boolean {
  if (TEXT_CONTROLS.has(codePoint)) return false;
  return codePoint < 0x20 || codePoint === 0x7f;
}

const BINARY_BYTE = new Uint8Array(256);
for (let byte = 0; byte < 256; byte++) BINARY_BYTE[byte] = isBinaryControl(byte) ? 1 : 0;

/**
 * The text a UTF-16 byte-order mark promises, or null when there is no BOM or
 * the bytes do not actually decode under it.
 */
function utf16Text(bytes: Buffer): string | null {
  if (bytes.byteLength < 2) return null;
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : null;
  if (!encoding) return null;
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(2));
  } catch {
    return null;
  }
}

/**
 * Whether the bytes are binary — the one predicate the resolution consults.
 *
 * It does NOT require a UTF-8 decode: a Windows-1252 CSV out of Excel is text
 * that fails one, and refusing it would remove uploads that worked before
 * ISS-957 for a reason no part of ISS-957 asked for. What it refuses is a
 * control byte no text carries, wherever in the file it sits.
 */
export function looksBinary(bytes: Buffer): boolean {
  if (bytes.byteLength === 0) return true;
  const decoded = utf16Text(bytes);
  if (decoded !== null) {
    for (const ch of decoded) {
      const code = ch.codePointAt(0);
      if (code !== undefined && isBinaryControl(code)) return true;
    }
    return false;
  }
  for (let i = 0; i < bytes.length; i++) {
    if (BINARY_BYTE[bytes[i] as number] === 1) return true;
  }
  return false;
}

/** The allowed set in the shape a refusal body carries, so a client prints it instead of copying it. */
export function allowedSetForTarget(target: AttachmentTarget): {
  mimes: string[];
  extensions: string[];
  anyExtensionIfText: boolean;
} {
  const mimes = [...ALLOWED_BY_TARGET[target]];
  const allowed = new Set(mimes);
  return {
    mimes,
    extensions: Object.entries(EXT_MIME)
      .filter(([, mime]) => allowed.has(mime))
      .map(([ext]) => `.${ext}`),
    anyExtensionIfText: true,
  };
}

const UNDECLARED = 'application/octet-stream';

export type MimeResolution =
  | { ok: true; mime: string }
  | { ok: false; reason: 'not-allowed' | 'not-text'; mime: string };

export interface ResolveAttachmentMimeInput {
  target: AttachmentTarget;
  name: string;
  declaredMime: string;
  bytes: Buffer;
}

/**
 * Decide an attachment's stored type from its bytes and its name. Two
 * questions, in order: does the target allow the candidate type, and did the
 * client CLAIM that type or did this module guess it from the name?
 *
 * A claim is binding — an allowed type is believed, a refused one is refused by
 * name rather than quietly stored as something else. A guess is not, because
 * the client never said it, so text bytes under an unmapped extension land as
 * `text/plain` — but only where the target takes text at all, which is what
 * stops them walking into a target whose allow-list is pictures only. Either
 * way a text type must carry text, so `.log` is no way to store a blob.
 */
export function resolveAttachmentMime(input: ResolveAttachmentMimeInput): MimeResolution {
  const allowed = ALLOWED_BY_TARGET[input.target];
  const declared = input.declaredMime === UNDECLARED ? '' : input.declaredMime;
  const candidate = declared || mimeFromName(input.name);

  if (allowed.has(candidate)) {
    if (!TEXT_FORMATS.has(candidate)) return { ok: true, mime: candidate };
    return looksBinary(input.bytes)
      ? { ok: false, reason: 'not-text', mime: candidate }
      : { ok: true, mime: candidate };
  }

  if (declared || looksBinary(input.bytes) || !allowed.has('text/plain')) {
    return { ok: false, reason: 'not-allowed', mime: candidate };
  }
  return { ok: true, mime: 'text/plain' };
}

/** The message a `MIME_NOT_ALLOWED` refusal carries, which names the reason the type was rejected. */
export function mimeRefusalMessage(resolution: MimeResolution & { ok: false }): string {
  return resolution.reason === 'not-text'
    ? `mime not allowed: ${resolution.mime} — the bytes are binary, and this type carries text`
    : `mime not allowed: ${resolution.mime}`;
}
