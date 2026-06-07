// Pure log-shaping helpers for the Coolify `logs` action. Kept dependency-free
// (no db / client imports) so they can be unit-tested without env, and reused
// by the adapter's `fetchCoolifyDeploymentLogs`.

import { FILTERED } from '@forge/observability';
import type { CoolifyDeploymentLogLine } from './types.js';

export const LOG_MAX_LINES = 100;
export const LOG_MAX_BYTES = 16 * 1024;

// ISS-412 — Coolify emits this banner immediately before dumping every
// runtime env var as a KEY=value line. We use it as the start delimiter of
// an env-dump block; the block ends at the first non-env-shaped line.
const ENV_DUMP_MARKER = /Creating \.env file with runtime variables/i;
const ENV_ASSIGNMENT_LINE = /^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*)\s*=\s*\S.*$/;

/**
 * Defense-in-depth before the generic {@link scrubLogText} runs. Inside the
 * `Creating .env file with runtime variables` block we redact EVERY
 * `KEY=value` value regardless of suffix — catches names like
 * `MY_PROVIDER_LOL=...` that the suffix-list rule would miss. Outside the
 * block, env-shape lines pass through untouched; the generic suffix rule in
 * `scrubLogText` still catches secret-shaped names anywhere in the log.
 *
 * No-op when the marker is absent.
 */
export function redactCoolifyEnvDump(text: string): string {
  if (!ENV_DUMP_MARKER.test(text)) return text;
  let inBlock = false;
  return text
    .split('\n')
    .map((line) => {
      if (ENV_DUMP_MARKER.test(line)) {
        inBlock = true;
        return line;
      }
      if (!inBlock) return line;
      const m = ENV_ASSIGNMENT_LINE.exec(line);
      if (!m) {
        // Block ends at the first non-env-shaped line (blank line,
        // build-step output, FQDN, etc.).
        inBlock = false;
        return line;
      }
      return `${m[1]}=${FILTERED}`;
    })
    .join('\n');
}

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
