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
  svg: 'image/svg+xml',
  html: 'text/html',
  htm: 'text/html',
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
const TEXT_CONTROLS = new Set([0x09, 0x0a, 0x0c, 0x0d]);
function isBinaryControl(codePoint: number): boolean {
  if (TEXT_CONTROLS.has(codePoint)) return false;
  return codePoint < 0x20 || codePoint === 0x7f;
}

/** Whether the bytes decode as UTF-8 and carry no control character. */
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

/** The allowed set in the shape a refusal body carries, so a client prints it instead of copying it. */
export function allowedSetForTarget(target: AttachmentTarget): {
  mimes: string[];
  extensions: string[];
} {
  const mimes = [...ALLOWED_BY_TARGET[target]];
  const allowed = new Set(mimes);
  return {
    mimes,
    extensions: Object.entries(EXT_MIME)
      .filter(([, mime]) => allowed.has(mime))
      .map(([ext]) => `.${ext}`),
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
 * Decide an attachment's stored type from its BYTES first and its name second.
 *
 * The declaration a caller sends (multipart `file.type`, a ticket's mime, a
 * base64 entry's mime) is a claim about a file the server now holds, so it is
 * checked rather than believed:
 *
 * - text bytes keep a declared type only when that type is itself a text
 *   format the target allows; otherwise the extension picks among text types
 *   and anything it does not name is `text/plain`. This is what makes a
 *   `.log`, a `.sql` or any unknown extension of plain text land.
 * - non-text bytes under a text-format type are refused `not-text`: the
 *   symmetric half, without which `.log` would simply be a new way to store a
 *   binary blob as `text/plain`.
 * - non-text bytes otherwise keep the declaration, which the allowed set then
 *   judges.
 */
export function resolveAttachmentMime(input: ResolveAttachmentMimeInput): MimeResolution {
  const allowed = ALLOWED_BY_TARGET[input.target];
  const candidate = input.declaredMime || mimeFromName(input.name);

  if (isUtf8Text(input.bytes)) {
    if (TEXT_FORMATS.has(candidate) && allowed.has(candidate)) return { ok: true, mime: candidate };
    const byExtension = TEXT_EXT_MIME[extensionOf(input.name)];
    const mime = byExtension && allowed.has(byExtension) ? byExtension : 'text/plain';
    return allowed.has(mime) ? { ok: true, mime } : { ok: false, reason: 'not-allowed', mime };
  }

  if (TEXT_FORMATS.has(candidate)) return { ok: false, reason: 'not-text', mime: candidate };
  return allowed.has(candidate)
    ? { ok: true, mime: candidate }
    : { ok: false, reason: 'not-allowed', mime: candidate };
}

/** The message a `MIME_NOT_ALLOWED` refusal carries, which names the reason the type was rejected. */
export function mimeRefusalMessage(resolution: MimeResolution & { ok: false }): string {
  return resolution.reason === 'not-text'
    ? `mime not allowed: ${resolution.mime} — the bytes are not UTF-8 text`
    : `mime not allowed: ${resolution.mime}`;
}
