import { ApiError } from '@/lib/api/client';

export function extractFieldErrors<T extends string>(
  err: unknown,
  knownKeys: readonly T[],
): Partial<Record<T, string>> {
  if (!(err instanceof ApiError) || err.status !== 400) return {};
  const details = err.details as { fieldErrors?: Record<string, string[] | undefined> } | undefined;
  const map = details?.fieldErrors;
  if (!map) return {};
  const out: Partial<Record<T, string>> = {};
  for (const key of knownKeys) {
    const first = map[key]?.[0];
    if (first) out[key] = first;
  }
  return out;
}
