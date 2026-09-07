/**
 * The resolution rule itself, at the level the integration suite cannot reach
 * cheaply: one call per byte pattern, including the encodings and control
 * characters that decide whether a real-world `.log` or `.csv` lands.
 */

import { describe, expect, it } from 'vitest';
import type { AttachmentTarget } from './attachment-mime.js';
import { allowedSetForTarget, resolveAttachmentMime } from './attachment-mime.js';

const utf8 = (s: string) => Buffer.from(s, 'utf8');
const ESC = String.fromCharCode(0x1b);
const ANSI_LOG = utf8(`${ESC}[32mPASS${ESC}[0m tests/foo.test.ts\n`);
const CP1252_CSV = Buffer.from([
  0x6e, 0x61, 0x6d, 0x65, 0x2c, 0x63, 0x6f, 0x73, 0x74, 0x0a, 0x41, 0x2c, 0x93, 0x39, 0x94, 0x0a,
]);
const UTF16_TXT = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ASCII_PDF = utf8('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n');

function resolve(
  name: string,
  declaredMime: string,
  bytes: Buffer,
  target: AttachmentTarget = 'issue',
) {
  return resolveAttachmentMime({ target, name, declaredMime, bytes });
}

describe('resolveAttachmentMime — the bytes rescue, they do not demote', () => {
  it('keeps an all-ASCII PDF as application/pdf', () => {
    expect(resolve('spec.pdf', 'application/pdf', ASCII_PDF)).toEqual({
      ok: true,
      mime: 'application/pdf',
    });
  });

  it('keeps a declared image/png as image/png, whatever the extension claims', () => {
    expect(resolve('shot.txt', 'image/png', PNG)).toEqual({ ok: true, mime: 'image/png' });
  });

  it('admits an ANSI-coloured build log — ESC is ordinary text in a .log', () => {
    expect(resolve('gate.log', '', ANSI_LOG)).toEqual({ ok: true, mime: 'text/plain' });
  });

  it('admits a Windows-1252 CSV, which is text that fails a UTF-8 decode', () => {
    expect(resolve('export.csv', 'text/csv', CP1252_CSV)).toEqual({ ok: true, mime: 'text/csv' });
  });

  it('admits a BOM-marked UTF-16 .txt, whose every other byte is NUL', () => {
    expect(resolve('notes.txt', 'text/plain', UTF16_TXT)).toEqual({ ok: true, mime: 'text/plain' });
  });

  it('still refuses UTF-16 with no BOM, which is indistinguishable from a blob', () => {
    expect(resolve('notes.txt', 'text/plain', UTF16_TXT.subarray(2))).toEqual({
      ok: false,
      reason: 'not-text',
      mime: 'text/plain',
    });
  });

  it('narrows an unknown extension by the text table when the bytes are text', () => {
    expect(resolve('notes.md', '', utf8('# hi\n'))).toEqual({ ok: true, mime: 'text/markdown' });
  });
});

describe('resolveAttachmentMime — what it still refuses', () => {
  it('refuses binary bytes declared as a text type, naming the bytes', () => {
    expect(resolve('core.log', 'text/plain', PNG)).toEqual({
      ok: false,
      reason: 'not-text',
      mime: 'text/plain',
    });
  });

  it('refuses binary bytes under an extension nothing maps', () => {
    expect(resolve('evil.exe', 'application/x-msdownload', PNG)).toEqual({
      ok: false,
      reason: 'not-allowed',
      mime: 'application/x-msdownload',
    });
  });

  it('refuses a type the target does not allow rather than retyping it to text', () => {
    expect(resolve('export.csv', 'text/csv', utf8('a,b\n'), 'session')).toEqual({
      ok: false,
      reason: 'not-allowed',
      mime: 'text/csv',
    });
  });

  it('refuses a video on a comment, where the issue target would take it', () => {
    expect(resolve('clip.mp4', 'video/mp4', PNG, 'comment')).toEqual({
      ok: false,
      reason: 'not-allowed',
      mime: 'video/mp4',
    });
  });
});

describe('allowedSetForTarget', () => {
  it('says any extension is fine for text, because the extension list cannot say it', () => {
    const allowed = allowedSetForTarget('issue');
    expect(allowed.extensions).not.toContain('.log');
    expect(allowed.anyExtensionIfText).toBe(true);
  });

  it('lists only extensions whose type the target allows', () => {
    expect(allowedSetForTarget('session').extensions).not.toContain('.mp4');
    expect(allowedSetForTarget('issue').extensions).toContain('.mp4');
  });
});
