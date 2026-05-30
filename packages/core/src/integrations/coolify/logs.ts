// Pure log-shaping helpers for the Coolify `logs` action. Kept dependency-free
// (no db / client imports) so they can be unit-tested without env, and reused
// by the adapter's `fetchCoolifyDeploymentLogs`.

import type { CoolifyDeploymentLogLine } from './types.js';

export const LOG_MAX_LINES = 100;
export const LOG_MAX_BYTES = 16 * 1024;

/**
 * Normalise Coolify's `logs` field to plain text. The field is most commonly a
 * JSON-encoded array of `{ output, type, timestamp }` lines, but some versions
 * answer with a raw string. Parse defensively: never throw on an unexpected
 * shape — fall back to the raw string (or empty) so the caller still gets
 * whatever signal is present.
 */
export function flattenLogs(logs: string | CoolifyDeploymentLogLine[] | undefined): string {
  if (!logs) return '';
  if (Array.isArray(logs)) {
    return logs.map((l) => l?.output ?? '').join('\n');
  }
  if (typeof logs === 'string') {
    const trimmed = logs.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed
            .map((l) => (l && typeof l === 'object' ? (l.output ?? '') : String(l)))
            .join('\n');
        }
      } catch {
        // Not valid JSON after all — fall through to the raw string.
      }
    }
    return logs;
  }
  return '';
}

/**
 * Keep the LAST `maxLines` lines, then trim from the FRONT so the result is
 * ≤ `maxBytes`. Tailing (not heading) is deliberate: the failure that matters
 * is almost always at the end of a build/deploy log. `truncated` is set if
 * either bound dropped content.
 */
export function tailLog(
  text: string,
  maxLines = LOG_MAX_LINES,
  maxBytes = LOG_MAX_BYTES,
): { text: string; truncated: boolean } {
  let truncated = false;
  const lines = text.split('\n');
  let kept = lines;
  if (lines.length > maxLines) {
    kept = lines.slice(lines.length - maxLines);
    truncated = true;
  }
  let out = kept.join('\n');
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    // Trim from the front, byte-accurately, keeping the tail.
    const buf = Buffer.from(out, 'utf8');
    out = buf.subarray(buf.length - maxBytes).toString('utf8');
    truncated = true;
  }
  return { text: out, truncated };
}
