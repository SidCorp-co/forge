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

  it('narrows by extension when the client declared nothing: a .md of text is text/markdown', () => {
    expect(resolve('notes.md', '', utf8('# hi\n'))).toEqual({ ok: true, mime: 'text/markdown' });
  });

  it('reads application/octet-stream as no declaration — the multipart routes write it themselves', () => {
    // cm:guard this is what a browser sends for a `.log` it cannot type — the multipart routes write the placeholder themselves, so a change that starts believing it re-refuses the headline case (ISS-957)
    expect(resolve('gate.log', 'application/octet-stream', ANSI_LOG)).toEqual({
      ok: true,
      mime: 'text/plain',
    });
    // cm:why the placeholder buys the bytes nothing — the name still guesses `text/plain`, so a binary `.log` is refused `not-text`, naming the bytes rather than the placeholder
    expect(resolve('core.log', 'application/octet-stream', PNG)).toEqual({
      ok: false,
      reason: 'not-text',
      mime: 'text/plain',
    });
  });

  it('lands text under a guessed type the target refuses, because a guess is not a claim', () => {
    expect(resolve('export.csv', '', utf8('a,b\n'), 'session')).toEqual({
      ok: true,
      mime: 'text/plain',
    });
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

describe('looksBinary — what a two-byte prefix must not buy', () => {
  const bom = (lead: number[], rest: Buffer) => Buffer.concat([Buffer.from(lead), rest]);
  // cm:guard this fixture must stay long enough to contain a lone surrogate — an 8-byte stub decodes to four ordinary code points and IS text, so shortening it turns these three assertions green against the very hole they exist to catch (ISS-957)
  const BLOB = Buffer.concat([
    PNG,
    Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 256)),
  ]);

  it('refuses a PNG behind a UTF-16LE BOM — the BOM picks a decoder, it does not waive the check', () => {
    expect(resolve('notes.txt', 'text/plain', bom([0xff, 0xfe], BLOB))).toEqual({
      ok: false,
      reason: 'not-text',
      mime: 'text/plain',
    });
  });

  it('refuses a PNG behind a UTF-16BE BOM', () => {
    expect(resolve('notes.txt', 'text/plain', bom([0xfe, 0xff], BLOB))).toEqual({
      ok: false,
      reason: 'not-text',
      mime: 'text/plain',
    });
  });

  it('refuses a BOM-prefixed blob declared text/html, the type a BOM bypass would most reward', () => {
    expect(resolve('page.html', 'text/html', bom([0xff, 0xfe], BLOB))).toEqual({
      ok: false,
      reason: 'not-text',
      mime: 'text/html',
    });
  });

  it('admits a BOM-marked UTF-16 file that really is text, which is what the BOM path is for', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello there', 'utf16le')]);
    expect(resolve('notes.txt', 'text/plain', utf16)).toEqual({ ok: true, mime: 'text/plain' });
  });

  it('states the residual: a tiny blob whose UTF-16 reading IS valid text is admitted as text', () => {
    // cm:why priced rather than hidden — 8 bytes with no lone surrogate decode to four ordinary code points and are text by the only definition this predicate has; a fatal UTF-16 decode rejected 200 of 200 random 4 KB blobs, so the residual is bounded to inputs too short to carry a surrogate, which is too short to be a file worth smuggling
    expect(resolve('notes.txt', 'text/plain', bom([0xff, 0xfe], PNG))).toEqual({
      ok: true,
      mime: 'text/plain',
    });
  });

  it('refuses a blob that starts after the first 8 KB — the scan is the whole file', () => {
    const late = Buffer.concat([Buffer.from('A'.repeat(8192)), PNG, Buffer.alloc(4096)]);
    expect(resolve('dump.txt', 'text/plain', late)).toEqual({
      ok: false,
      reason: 'not-text',
      mime: 'text/plain',
    });
  });

  it('refuses DEL, which one predicate must judge the same way wherever it is reached', () => {
    expect(resolve('dump.log', 'text/plain', Buffer.from([0x41, 0x7f, 0x41]))).toEqual({
      ok: false,
      reason: 'not-text',
      mime: 'text/plain',
    });
    expect(resolve('dump.xyz', 'application/x-foo', Buffer.from([0x41, 0x7f, 0x41]))).toEqual({
      ok: false,
      reason: 'not-allowed',
      mime: 'application/x-foo',
    });
  });
});

describe('text/html is reachable only by an explicit declaration', () => {
  const markup = utf8('<html><body>hi</body></html>');

  it.each(['page.html', 'page.htm', 'page.xhtml', 'logo.svg'])(
    'stores %s as text/plain when the client declared nothing',
    (name) => {
      expect(resolve(name, '', markup)).toEqual({ ok: true, mime: 'text/plain' });
    },
  );

  it('still honours text/html when the client actually claims it', () => {
    expect(resolve('page.html', 'text/html', markup)).toEqual({ ok: true, mime: 'text/html' });
  });
});

describe('allowedSetForTarget', () => {
  it('backs anyExtensionIfText with the behaviour, not just the flag', () => {
    const allowed = allowedSetForTarget('issue');
    expect(allowed.extensions).not.toContain('.log');
    expect(allowed.anyExtensionIfText).toBe(true);
    // cm:why the flag is only worth printing if it is true of the resolver, so this asserts the behaviour under it rather than the literal
    expect(resolve('gate.log', '', utf8('ok\n'))).toEqual({ ok: true, mime: 'text/plain' });
    expect(resolve('trace.wibble', '', utf8('ok\n'))).toEqual({ ok: true, mime: 'text/plain' });
  });

  it('lists no extension whose type the target refuses', () => {
    for (const target of ['issue', 'comment', 'session'] as const) {
      const { mimes, extensions } = allowedSetForTarget(target);
      for (const ext of extensions) {
        expect(resolve(`f${ext}`, '', utf8('ok\n'), target).ok).toBe(true);
      }
      expect(extensions.length).toBeGreaterThan(0);
      expect(mimes).toContain('text/plain');
    }
  });

  it('lists only extensions whose type the target allows', () => {
    expect(allowedSetForTarget('session').extensions).not.toContain('.mp4');
    expect(allowedSetForTarget('issue').extensions).toContain('.mp4');
  });
});
