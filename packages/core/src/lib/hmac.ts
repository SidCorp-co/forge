import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyHmacSignature(
  secret: string,
  rawBody: string,
  headerValue: string | null | undefined,
): boolean {
  if (!headerValue) return false;
  const provided = headerValue.startsWith('sha256=') ? headerValue.slice(7) : headerValue;
  if (!/^[0-9a-f]+$/i.test(provided)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== provided.length) return false;

  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

export function signHmacSha256(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * A shared-token scheme's check — GitLab's `X-Gitlab-Token` carries the binding's secret itself
 * rather than a signature over the body. Compared over fixed-length digests, so neither the length
 * nor the content of the stored secret leaks through timing.
 */
export function verifySharedToken(secret: string, headerValue: string | null | undefined): boolean {
  if (!headerValue) return false;
  const a = createHmac('sha256', 'forge-shared-token').update(secret).digest();
  const b = createHmac('sha256', 'forge-shared-token').update(headerValue).digest();
  return timingSafeEqual(a, b);
}
