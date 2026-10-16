// An MCP client's refresh token mints access tokens for a month, and a code redeems for one: both
// are redacted by their prefix wherever they turn up, a callback URL or a form body included.

import { describe, expect, it } from 'vitest';
import { containsSecret, scrubLogText } from './index.js';

const refresh = `forge_mcp_rt_${'Ab9_-'.repeat(8)}xyz`;
const code = `forge_mcp_code_${'Zq0-_'.repeat(8)}abc`;

describe('an MCP OAuth secret', () => {
  it.each([
    ['a refresh token in a form body', `grant_type=refresh_token&r=${refresh}&client_id=x`],
    ['a code in a callback URL', `GET /callback?code=${code}&state=s`],
    ['a refresh token cut off', `token ${refresh.slice(0, 22)}`],
  ])('is redacted as %s', (_where, text) => {
    expect(scrubLogText(text)).not.toContain('forge_mcp_');
    expect(containsSecret(text)).toBe(true);
  });

  it('leaves the bare prefix named in prose alone', () => {
    const text = 'a refresh token starts forge_mcp_rt_ and is stored hashed';
    expect(scrubLogText(text)).toBe(text);
  });
});
