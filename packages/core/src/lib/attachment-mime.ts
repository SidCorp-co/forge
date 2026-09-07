export type AttachmentTarget = 'issue' | 'comment' | 'session';

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

// cm:why ISS-499 — an agent-chat transcript is read back by a runner and shown for vision, so it takes images, PDF and the two text types and nothing a runner cannot open
const SESSION_MIMES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'text/html',
  'application/pdf',
  'text/plain',
  'text/markdown',
] as const;

const ALLOWED_BY_TARGET: Record<AttachmentTarget, ReadonlySet<string>> = {
  issue: new Set(ISSUE_MIMES),
  comment: new Set(COMMENT_MIMES),
  session: new Set(SESSION_MIMES),
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

// cm:guard every member of this set MUST be a type whose payload is UTF-8 text, because a candidate in here survives the byte sniff unchanged and a binary type surviving it would defeat the whole resolution. `image/svg+xml` qualifies (SVG is XML source); no other image, video or office type does.
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

/**
 * The type an extension asks for, with no bytes to check it against. Used at
 * ticket-mint time, where the file does not exist yet. An extension this table
 * does not know asks for `text/plain` rather than `application/octet-stream`:
 * the ticket is a capability, not a verdict, and {@link resolveAttachmentMime}
 * judges the bytes at the PUT.
 */
export function mimeFromName(name: string): string {
  return EXT_MIME[extensionOf(name)] ?? 'text/plain';
}

/** Strip path separators; keep the extension. Length-cap. */
// cm:guard this output is an IDENTITY, not just a safe filename — the attachment name rule compares it, so a character class that maps distinct names together refuses distinct documents: `[^A-Za-z0-9._-]` sent `报告.pdf` and `设计.pdf` both to `__.pdf`, and NFC/NFD spellings of one name to two (ISS-963)
export function safeName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\\/]+/g, '_')
    .replace(/[\p{C}\p{Z}]/gu, '_')
    .replace(/[^\p{L}\p{N}._-]/gu, '_');
  return cleaned.slice(0, 200) || 'file';
}

// cm:guard test code points, never a regex character class — biome's noControlCharactersInRegex refuses control escapes in a literal, and spelling them as `\\x00` in a `new RegExp` string only hides the same bytes from the reader
// cm:guard ESC and BACKSPACE belong here: an ANSI-coloured build log is the single most common `.log` and is ordinary text. Removing them re-refuses the exact file ISS-957 was filed to admit.
const TEXT_CONTROLS = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x1b]);
function isBinaryControl(codePoint: number): boolean {
  if (TEXT_CONTROLS.has(codePoint)) return false;
  return codePoint < 0x20 || codePoint === 0x7f;
}

// cm:guard this table must stay the byte-wise projection of isBinaryControl — it exists only because an indexed scan over 10 MB (UPLOADS_MAX_BYTES) costs ~20 ms where the same loop through the Set costs ~400 ms of blocked event loop, and two predicates that disagree is the bug this file already paid for once (ISS-957)
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
  // cm:guard a BOM selects the DECODER and the scan then runs over the decoded units — it must never return early, because two bytes anyone can prepend would otherwise admit any blob as text/plain and make this whole check a formality (ISS-957)
  // cm:guard `fatal: true` is the load-bearing half — it rejects the lone surrogates any real binary payload reaches within a few hundred bytes (measured: 200 of 200 random 4 KB blobs), so the residual is a blob too short to contain one, which by this predicate's only definition is text
  const decoded = utf16Text(bytes);
  if (decoded !== null) {
    for (const ch of decoded) {
      const code = ch.codePointAt(0);
      if (code !== undefined && isBinaryControl(code)) return true;
    }
    return false;
  }
  // cm:guard scan every byte, never a prefix — a window means the payload only has to start past it, and 8 KB of ASCII in front of an ELF header is not a hard file to make. The buffer is already whole in memory and capped by UPLOADS_MAX_BYTES, so there is nothing to stream around.
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
    // cm:guard `extensions` is the explicit map ONLY, so it cannot list `.log`, and a client that prints it alone tells its user the opposite of the rule — `anyExtensionIfText` is the rest of the sentence and must be printed with it (ISS-957)
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
 * Decide an attachment's stored type from its bytes and its name.
 *
 * Two questions, in order: does the target allow the candidate type, and did
 * the client CLAIM that type or did this module guess it from the name?
 *
 * A claim is binding. A type the target allows is believed — an uncompressed
 * PDF is all ASCII, and retyping it because it happens to decode would be a
 * silent substitution of the worst kind. A type the target refuses is refused
 * by name rather than quietly stored as something else.
 *
 * A guess is not binding, because the client never said it — and
 * `application/octet-stream` is a guess whoever it came from. When the guess is
 * a type this target does not take, text bytes still land as `text/plain`.
 * That is what makes `.log`, `.sql` and every unmapped extension attach, and
 * `mimeFromName` returning `text/plain` by default is the other half of it.
 *
 * Either way a text type must carry text, which is what stops `.log` becoming
 * a new way to store a blob.
 */
export function resolveAttachmentMime(input: ResolveAttachmentMimeInput): MimeResolution {
  const allowed = ALLOWED_BY_TARGET[input.target];
  // cm:guard `application/octet-stream` counts as NO declaration, not as a claim — the multipart routes write it themselves whenever the browser reports `""` (issues/attachment-routes.ts, comments/routes.ts), which is every `.log` a person drags in, so treating it as a claim refuses the headline case ISS-957 exists to admit
  const declared = input.declaredMime === UNDECLARED ? '' : input.declaredMime;
  const candidate = declared || mimeFromName(input.name);

  if (allowed.has(candidate)) {
    if (!TEXT_FORMATS.has(candidate)) return { ok: true, mime: candidate };
    return looksBinary(input.bytes)
      ? { ok: false, reason: 'not-text', mime: candidate }
      : { ok: true, mime: candidate };
  }

  if (declared || looksBinary(input.bytes)) {
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
