import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import { prepareBody } from '../body/prepare.js';
import { storedText } from '../lib/data-egress.js';

// personal-data-flow#ds-issues: on a redact or no_egress project an issue's free text is scrubbed on write
const SCRUBBED_ISSUE_FIELDS = [
  'title',
  'description',
  'plan',
  'acceptanceCriteria',
  'releaseNotes',
];

export function scrubIssueText<T extends Record<string, unknown>>(
  level: SensitiveDataLevel,
  fields: T,
): T {
  if (level === 'off') return fields;
  const out: Record<string, unknown> = { ...fields };
  for (const key of SCRUBBED_ISSUE_FIELDS) {
    const value = out[key];
    if (typeof value === 'string') out[key] = storedText(level, value).text;
  }
  return out as T;
}

export const SHARED_ISSUE_PATCH_FIELDS = [
  'title',
  'description',
  'priority',
  'category',
  'complexity',
  'plan',
  'acceptanceCriteria',
  'releaseNotes',
  'sessionContext',
  'detectorKey',
] as const;

interface CollectedIssueFieldUpdates {
  updates: Record<string, unknown>;
  /** What the body sanitizer removed, for the transport to hand back. */
  warnings: string[];
}

export function collectIssueFieldUpdates(
  patch: Record<string, unknown>,
  fields: readonly string[],
  onChange?: (field: string, next: unknown) => void,
): CollectedIssueFieldUpdates {
  const updates: Record<string, unknown> = {};
  for (const field of fields) {
    const next = patch[field];
    if (next === undefined) continue;
    updates[field] = next;
    if (field !== 'description') onChange?.(field, next);
  }
  if (updates.description === undefined) return { updates, warnings: [] };

  const raw = updates.description;
  const empty = typeof raw !== 'string' || raw.trim().length === 0;
  const prepared = empty
    ? null
    : prepareBody({ raw: raw as string, format: readFormat(patch.descriptionFormat) });
  updates.description = prepared ? prepared.body : raw;
  updates.descriptionFormat = prepared?.format ?? 'markdown';
  onChange?.('description', updates.description);
  onChange?.('descriptionFormat', updates.descriptionFormat);
  return { updates, warnings: prepared?.warnings ?? [] };
}

function readFormat(value: unknown): 'markdown' | 'html' | undefined {
  return value === 'markdown' || value === 'html' ? value : undefined;
}
