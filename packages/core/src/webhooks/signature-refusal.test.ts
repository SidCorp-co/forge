/**
 * ISS-1252 — the adapters say a failed signature check by type, which is what the inbound route
 * answers 401 on. A message that merely contains the word is not one.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { githubAdapter } = await import('../integrations/github/adapter.js');
const { handleSentryWebhook } = await import('../integrations/sentry/webhook.js');
const { SignatureVerificationError } = await import('./hmac.js');

const SECRET = 'whsec-signature-refusal-test';
const rawBody = JSON.stringify({ zen: 'keep it logically awesome' });
const badSignature = `sha256=${'0'.repeat(64)}`;
// biome-ignore lint/suspicious/noExplicitAny: only the fields these refusals read are given
const ctx = { integrationSecret: SECRET } as any;

describe('an adapter handed a delivery that does not verify', () => {
  it('github throws a SignatureVerificationError', async () => {
    const refusal = githubAdapter.handleInbound?.(ctx, {
      headers: { 'x-github-event': 'ping', 'x-hub-signature-256': badSignature },
      rawBody,
      payload: {},
    });
    await expect(refusal).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it('sentry throws a SignatureVerificationError', async () => {
    const refusal = handleSentryWebhook(ctx, {
      headers: { 'sentry-hook-signature': badSignature },
      rawBody,
      payload: {},
    });
    await expect(refusal).rejects.toBeInstanceOf(SignatureVerificationError);
  });
});
