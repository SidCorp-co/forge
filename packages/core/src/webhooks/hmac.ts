import { createHmac, timingSafeEqual } from 'node:crypto';

/** An adapter throws this for a delivery that fails its binding's signature; the route answers 401 on the type, never on a message. */
export class SignatureVerificationError extends Error {
  override name = 'SignatureVerificationError';
}

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
