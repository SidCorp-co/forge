/**
 * ISS-1247 — what `forge_sentry` offers, and what it deliberately does not.
 *
 * The shape assertions are the ones a behavioural test cannot make: that the door has exactly two
 * actions and that neither of them can be talked into a write. Sentry's adapter can resolve an
 * issue; exposing that is a separate decision with a separate argument, and the check that keeps it
 * separate has to fail the moment a third action appears.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x/y',
    DEVICE_TOKEN_PEPPER: 'pepper',
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const { forgeSentryTool } = await import('./forge-sentry.js');
const { REGISTERED_TOOLS } = await import('../registered-tools.js');
const { registerAllIntegrations } = await import('../../integrations/register-all.js');
const { getIntegration } = await import('../../integrations/registry.js');

registerAllIntegrations();

const tool = forgeSentryTool({ principal: { userId: 'u1' } } as never);

const sourceOf = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('the door forge_sentry opens', () => {
  it('is declared on the surface the server registers', () => {
    expect(REGISTERED_TOOLS).toContain('forge_sentry');
  });

  it('is the tool Sentry now offers an agent', () => {
    const path = getIntegration('sentry')?.capabilities.agentPath;
    expect(path?.kind === 'none' ? [] : [...(path?.tools ?? [])]).toContain('forge_sentry');
  });

  it('offers exactly two actions, both reads', () => {
    const schema = tool.inputSchema as {
      properties: { action: { enum: string[] } };
    };
    expect(schema.properties.action.enum).toEqual(['list', 'get']);
  });

  it('names no write anywhere on its own path', () => {
    for (const path of ['./forge-sentry.ts', '../../integrations/sentry/agent-read.ts']) {
      expect(sourceOf(path), `${path} names a Sentry write`).not.toContain('setSentryIssueStatus');
      expect(sourceOf(path), `${path} names a Sentry write`).not.toContain(
        'SENTRY_ISSUE_SET_STATUS',
      );
    }
  });

  it('refuses a `get` that names no issue, in the envelope every refusal uses', async () => {
    const answer = (await tool.handler({ action: 'get' })) as {
      ok: boolean;
      refusal: { reason: string; message: string };
    };
    expect(answer.ok).toBe(false);
    expect(answer.refusal.reason).toBe('bad_argument');
    expect(answer.refusal.message).toContain('issueId');
    expect(answer).not.toHaveProperty('issue');
  });

  it('breaks loudly on an argument the schema does not hold', async () => {
    await expect(tool.handler({ action: 'list', sentryToken: 'sntryu_x' })).rejects.toThrow();
  });
});
