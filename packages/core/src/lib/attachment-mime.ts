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

// cm:guard narrower than EXT_MIME on purpose — `text/html` must stay reachable only by an explicit declaration. Adding `html` here would let any mislabelled text file become a document a browser wants to render.
const TEXT_EXT_MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
};

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
export function safeName(name: string): string {
  const cleaned = name.replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.slice(0, 200) || 'file';
}

// cm:guard test code points, never a regex character class — biome's noControlCharactersInRegex refuses control escapes in a literal, and spelling them as `\\x00` in a `new RegExp` string only hides the same bytes from the reader
// cm:guard ESC and BACKSPACE belong here: an ANSI-coloured build log is the single most common `.log` and is ordinary text. Removing them re-refuses the exact file ISS-957 was filed to admit.
const TEXT_CONTROLS = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x1b]);
function isBinaryControl(codePoint: number): boolean {
  if (TEXT_CONTROLS.has(codePoint)) return false;
  return codePoint < 0x20 || codePoint === 0x7f;
}

/**
 * Whether the bytes decode as UTF-8 and carry no binary control character.
 *
 * This is the PROMOTING predicate: it decides whether a file whose declared
 * type the tracker would otherwise refuse may be rescued as text.
 */
export function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.byteLength === 0) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code !== undefined && isBinaryControl(code)) return false;
  }
  return true;
}

function hasUtf16Bom(bytes: Buffer): boolean {
  if (bytes.byteLength < 2) return false;
  const [a, b] = [bytes[0], bytes[1]];
  return (a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff);
}

/**
 * Whether the bytes are binary, judged WITHOUT requiring valid UTF-8.
 *
 * This is the REFUSING predicate, and it is deliberately not the negation of
 * {@link isUtf8Text}: a Windows-1252 CSV and a BOM-marked UTF-16 `.txt` are
 * text that fails a UTF-8 decode, and refusing them would remove uploads that
 * worked before ISS-957 for a reason no part of ISS-957 asked for. A UTF-16
 * file with no BOM stays out of reach — it is bytes-identical to a binary blob
 * with a NUL every other byte, and guessing there would reopen the hole.
 */
export function looksBinary(bytes: Buffer): boolean {
  if (bytes.byteLength === 0) return true;
  // cm:guard the BOM must short-circuit BEFORE the NUL scan, not after it — every other byte of UTF-16 text is NUL, so the scan alone calls a Notepad-saved `.txt` binary and refuses a file that landed fine before ISS-957
  if (hasUtf16Bom(bytes)) return false;
  for (const byte of bytes.subarray(0, 8192)) {
    if (byte === 0) return true;
    if (byte < 0x20 && !TEXT_CONTROLS.has(byte)) return true;
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
 * The byte check RESCUES a file the name would have got refused; it does not
 * DEMOTE one the declaration already gets right. Three cases, in order:
 *
 * 1. The candidate is a non-text type the target allows — believed. An
 *    uncompressed PDF is all ASCII, and retyping it to `text/plain` because it
 *    happens to decode would be a silent substitution of the worst kind: the
 *    upload succeeds and the file is quietly the wrong thing.
 * 2. The candidate is a text format — accepted if the target allows it AND the
 *    bytes are not binary, refused `not-text` otherwise. This is what stops
 *    `.log` becoming a new way to store a blob as `text/plain`.
 * 3. Anything else — rescued to a text type when the bytes are UTF-8 text,
 *    which is what makes `.log`, `.sql` and any unknown extension land, and
 *    refused `not-allowed` when they are not.
 */
export function resolveAttachmentMime(input: ResolveAttachmentMimeInput): MimeResolution {
  const allowed = ALLOWED_BY_TARGET[input.target];
  const candidate = input.declaredMime || mimeFromName(input.name);

  if (!TEXT_FORMATS.has(candidate) && allowed.has(candidate)) {
    return { ok: true, mime: candidate };
  }

  if (TEXT_FORMATS.has(candidate)) {
    if (!allowed.has(candidate)) return { ok: false, reason: 'not-allowed', mime: candidate };
    return looksBinary(input.bytes)
      ? { ok: false, reason: 'not-text', mime: candidate }
      : { ok: true, mime: candidate };
  }

  if (isUtf8Text(input.bytes)) {
    const byExtension = TEXT_EXT_MIME[extensionOf(input.name)];
    const mime = byExtension && allowed.has(byExtension) ? byExtension : 'text/plain';
    if (allowed.has(mime)) return { ok: true, mime };
  }
  return { ok: false, reason: 'not-allowed', mime: candidate };
}

/** The message a `MIME_NOT_ALLOWED` refusal carries, which names the reason the type was rejected. */
export function mimeRefusalMessage(resolution: MimeResolution & { ok: false }): string {
  return resolution.reason === 'not-text'
    ? `mime not allowed: ${resolution.mime} — the bytes are binary, and this type carries text`
    : `mime not allowed: ${resolution.mime}`;
}
