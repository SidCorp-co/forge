import { SHARE_TOKEN_PATTERN, sharePath } from '@forge/contracts/shares';
import { scrubLogRecord, scrubLogText, scrubSentryEvent } from '@forge/observability';
import { describe, expect, it } from 'vitest';
import { hashShareToken, isShareTokenShaped, mintShareToken } from './token.js';

describe('a share token', () => {
  it('is 256 random bits behind its prefix, stored only as a SHA-256', () => {
    const a = mintShareToken();
    const b = mintShareToken();
    expect(a.token).toMatch(SHARE_TOKEN_PATTERN);
    expect(Buffer.from(a.token.slice('forge_share_'.length), 'base64url')).toHaveLength(32);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(hashShareToken(a.token));
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toContain(a.token.slice(12, 24));
  });

  it('does not match a tampered or cut-off token', () => {
    const { token, hash } = mintShareToken();
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    const tampered = `${token.slice(0, -1)}${last}`;
    expect(isShareTokenShaped(tampered)).toBe(true);
    expect(hashShareToken(tampered)).not.toBe(hash);
    expect(isShareTokenShaped(token.slice(0, -1))).toBe(false);
    expect(isShareTokenShaped(`forge_pat_${token.slice(12)}`)).toBe(false);
  });

  it('never reaches a log line, a log record or an error report', () => {
    const { token } = mintShareToken();
    const url = `https://forge.example${sharePath(token)}`;
    expect(scrubLogText(`opened ${url} from a chat`)).not.toContain(token.slice(12));
    expect(
      JSON.stringify(scrubLogRecord({ path: sharePath(token), body: { token } })),
    ).not.toContain(token.slice(12));
    const event = scrubSentryEvent({ request: { url }, message: `GET ${url}` });
    expect(JSON.stringify(event)).not.toContain(token.slice(12));
  });
});
