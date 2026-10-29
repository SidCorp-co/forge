// ISS-757: a credential header is a secret only where a credential-shaped value follows its name or
// its scheme word. adminhub-api's comment naming where a JWT travels ("the Authorization: Bearer
// header, read at src/auth/guard.ts:42") was refused MESSAGE_REFUSED no-redacted-secret, because the
// header rule redacted the rest of the line whatever followed. A value still redacts the whole rest
// of its line, as a header's value may run on in parts (a cookie's pairs).

import { describe, expect, it } from 'vitest';
import { containsSecret, FILTERED, scrubLogText, secretSpans } from './index.js';

/** Every header name the scrubber reads, as a writer would spell it. */
const HEADERS = [
  'Authorization',
  'Cookie',
  'X-Device-Token',
  'X-Api-Key',
  'X-CSRF-Token',
  'X-Auth-Token',
  'Private-Token',
  'X-Gitlab-Token',
];

const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const OPAQUE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

describe('a credential header named in prose', () => {
  it.each(
    HEADERS.flatMap((h) => [
      `The JWT goes in the ${h}: Bearer header, read at src/auth/guard.ts:42.`,
      `${h}: Bearer`,
      `The ${h}: header is read at src/auth/guard.ts:42.`,
      `${h}= unset in this environment`,
    ]),
  )('is not a secret: %s', (text) => {
    expect(scrubLogText(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
    expect(secretSpans(text)).toEqual([]);
  });

  it.each([
    'The Cookie: is set by the browser on sign-in, see src/auth/session.ts:9.',
    'Cookie: theme is the only one we read',
    'authorization: basic auth is off here',
    'Authorization: header, then the body',
  ])('is not a secret: %s', (text) => {
    expect(scrubLogText(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
  });
});

describe('a credential header carrying a value', () => {
  it.each(
    HEADERS.flatMap((h) => [
      [`Send ${h}: Bearer ${JWT}`, `Send ${h}: ${FILTERED}`],
      [`Send ${h}: ${JWT}`, `Send ${h}: ${FILTERED}`],
      [`Send ${h}: ${OPAQUE}`, `Send ${h}: ${FILTERED}`],
      [`Send ${h}: Bearer ${OPAQUE} to the API.`, `Send ${h}: ${FILTERED}`],
      [`Send ${h}: Bearer eyJ…abc123`, `Send ${h}: ${FILTERED}`],
    ]),
  )('is redacted to the end of its line: %s', (text, scrubbed) => {
    expect(scrubLogText(text)).toBe(scrubbed);
    expect(containsSecret(text)).toBe(true);
    const [span] = secretSpans(text);
    expect(text.slice(span?.start, span?.end)).not.toContain(':');
  });

  it.each([
    ['Cookie: theme=dark; sid=s%3AabcDEF0123456789', `Cookie: ${FILTERED}`],
    ['Cookie: sid=abcdef123456', `Cookie: ${FILTERED}`],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', `Authorization: ${FILTERED}`],
    ['authorization=token abc123def456', `authorization=${FILTERED}`],
  ])('is redacted to the end of its line: %s', (text, scrubbed) => {
    expect(scrubLogText(text)).toBe(scrubbed);
    expect(containsSecret(text)).toBe(true);
  });

  it('is read after a header named in prose on the same line', () => {
    const text = 'The Authorization: header and X-Api-Key: abcDEF123456xyz on one line';
    expect(scrubLogText(text)).toBe(`The Authorization: header and X-Api-Key: ${FILTERED}`);
    const [span, ...rest] = secretSpans(text);
    expect(rest).toEqual([]);
    expect(text.slice(span?.start, span?.end)).toBe('abcDEF123456xyz on one line');
  });

  it('changes nothing scrubbed a second time', () => {
    const once = scrubLogText(`Send Authorization: Bearer ${JWT}`);
    expect(scrubLogText(once)).toBe(once);
  });
});
