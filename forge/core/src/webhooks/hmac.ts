import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify an HMAC-SHA256 signature against a raw request body.
 *
 * Accepts headers in GitHub's canonical shape (`sha256=<hex>`) as well as
 * bare hex. Uses `timingSafeEqual` with a length-guard so length mismatches
 * don't throw before the comparison happens.
 */
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
