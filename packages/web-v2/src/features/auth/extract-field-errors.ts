import { ApiError } from '@/lib/api/client';
import { namedRefusals } from '@/lib/api/refusals';

export function extractFieldErrors<T extends string>(
  err: unknown,
  knownKeys: readonly T[],
): Partial<Record<T, string>> {
  if (!(err instanceof ApiError) || err.status !== 400) return {};
  const out: Partial<Record<T, string>> = {};
  for (const r of namedRefusals(err)) {
    const key = knownKeys.find((k) => r.path === `/${k}` || r.path.startsWith(`/${k}/`));
    if (key && out[key] === undefined) out[key] = r.detail;
  }
  return out;
}
