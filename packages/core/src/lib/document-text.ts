/**
 * The text of a document a person attached, as the assistant reads it: decoded or extracted from its
 * bytes, then put through the observability scrubber, so no reader of this module ever holds a
 * document's secret. PDF text comes from PDF.js (`unpdf`'s serverless build) and a Word file's from
 * `mammoth`: neither is ours to write.
 */

import { CONVERSATION_DOCUMENT_MIMES } from '@forge/contracts/attachments';
import { scrubLogText } from '@forge/observability';

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type DocumentText =
  | {
      ok: true;
      /** The whole text, scrubbed. */
      text: string;
      /** Whether the scrubber redacted anything in it. */
      redacted: boolean;
    }
  | { ok: false; reason: string };

export function isDocumentMime(mime: string): boolean {
  return CONVERSATION_DOCUMENT_MIMES.includes(mime);
}

/**
 * Text bytes as the text they hold: a UTF-16 byte-order mark is honoured, UTF-8 is tried strictly,
 * and anything else is Windows-1252 — a CSV out of Excel is text that fails a UTF-8 decode.
 */
export function decodeTextBytes(bytes: Buffer): string {
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

async function pdfText(bytes: Buffer): Promise<DocumentText | string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    const { text } = await extractText(pdf, { mergePages: false });
    return text.join('\n\n');
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return {
      ok: false,
      reason:
        name === 'PasswordException'
          ? 'the PDF is password-protected, so its text cannot be read — attach a copy without the password'
          : 'the bytes are not a PDF its reader could open — export it again, or attach it as text',
    };
  }
}

async function docxText(bytes: Buffer): Promise<DocumentText | string> {
  const mammoth = (await import('mammoth')).default;
  try {
    return (await mammoth.extractRawText({ buffer: bytes })).value;
  } catch {
    return {
      ok: false,
      reason:
        'the bytes are not a Word (.docx) document its reader could open — save it again as .docx, or attach it as PDF or text',
    };
  }
}

/**
 * The scrubbed text of one document, or why there is none. A document with no text in it — a
 * scanned PDF is pictures of pages — is refused here rather than read as empty: an assistant told
 * "the file is blank" answers about a file it was never shown.
 */
export async function readDocumentText(bytes: Buffer, mime: string): Promise<DocumentText> {
  if (!isDocumentMime(mime)) {
    return { ok: false, reason: `${mime} is not a document type the assistant reads as text` };
  }
  const raw =
    mime === PDF
      ? await pdfText(bytes)
      : mime === DOCX
        ? await docxText(bytes)
        : decodeTextBytes(bytes);
  if (typeof raw !== 'string') return raw;
  if (raw.trim().length === 0) {
    return {
      ok: false,
      reason:
        mime === PDF
          ? 'the PDF holds no text, only pictures of its pages — attach the pages as images, or export the PDF with its text'
          : 'the file holds no text',
    };
  }
  const text = scrubLogText(raw);
  return { ok: true, text, redacted: text !== raw };
}
