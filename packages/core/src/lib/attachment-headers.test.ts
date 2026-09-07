/**
 * `Content-Disposition` is a ByteString, and attachment names stopped being
 * ASCII when the name became an identity (ISS-963) — so this pins the one
 * header that turns a stored file into an unreadable 500.
 */

import { describe, expect, it } from 'vitest';
import { contentDisposition } from './attachment-headers.js';

const isByteString = (value: string) => [...value].every((ch) => ch.charCodeAt(0) <= 0xff);

describe('contentDisposition', () => {
  it('emits a header a Node response can actually carry, for a name it cannot spell', () => {
    const header = contentDisposition('attachment', '报告.md');
    expect(isByteString(header)).toBe(true);
    expect(header).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A.md");
  });

  it('carries an ASCII fallback for clients that read only the plain parameter', () => {
    expect(contentDisposition('attachment', '报告.md')).toContain('filename="__.md"');
  });

  it('leaves an ASCII name alone in both parameters', () => {
    expect(contentDisposition('inline', 'notes.md')).toBe(
      'inline; filename="notes.md"; filename*=UTF-8\'\'notes.md',
    );
  });

  // cm:guard the quoted parameter must never carry a raw quote, backslash or newline — the name is uploaded content, and a header value that closes its own quoting is a response-splitting vector
  it('neutralises the characters that would break out of the quoted parameter', () => {
    const header = contentDisposition('attachment', 'a"b\\c\r\nX-Evil: 1.md');
    const quoted = /filename="(.*)"/.exec(header)?.[1];
    expect(quoted).toBe('a_b_c__X-Evil: 1.md');
    expect(isByteString(header)).toBe(true);
  });

  it('percent-encodes the characters RFC 5987 excludes from ext-value', () => {
    expect(contentDisposition('attachment', "a'b(c).md")).toContain(
      "filename*=UTF-8''a%27b%28c%29.md",
    );
  });
});
