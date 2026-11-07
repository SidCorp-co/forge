// REQ-89 BC-1, BC-4 (ISS-1121): before a memory is saved, its writer answers how it helps later work,
// what it is (a verified fact, a hypothesis, or a convention), where it applies and the change that
// means re-checking it; a temporary entry also names what ends it. The answers ride on
// `metadata.curation`. A write leaving one out is accepted, as the owner ruled (teach, never block,
// 2026-11-05): it is stored with the default named in its warning (`hypothesis`, `unscoped`), so an
// inference is never stored as a fact, and it is listed as owing that answer (`needsCheck`
// `uncurated`) until a rewrite gives it.

import {
  CURATED_ENTRY_TYPE_DEFAULT,
  CURATED_ENTRY_TYPES,
  type CuratedEntryType,
  type CurationWarning,
} from '@forge/contracts/knowledge';
import {
  MEMORY_AUTHORED_SOURCES,
  MEMORY_CURATION_FIELD_SHAPES,
  MEMORY_CURATION_FIELDS,
  MEMORY_UNSCOPED,
  type MemoryCuration,
  type MemoryCurationField,
} from '@forge/contracts/memory';
import { z } from 'zod';

/** The answers as a write sends them, each optional: a write leaving one out is warned, never refused. */
export const memoryCurationInputSchema = z.object({
  value: z.string().trim().min(1).max(500).optional(),
  type: z.enum(CURATED_ENTRY_TYPES).optional(),
  scope: z.string().trim().min(1).max(500).optional(),
  recheckWhen: z.string().trim().min(1).max(1000).optional(),
  endsWhen: z.string().trim().min(1).max(500).optional(),
});

export type MemoryCurationInput = z.infer<typeof memoryCurationInputSchema>;

/** Whether a source holds curated memory: what people and agents wrote, not a mirror of a record. */
export const isCuratedSource = (source: string): boolean =>
  (MEMORY_AUTHORED_SOURCES as readonly string[]).includes(source);

/** The answers as stored, with what was left out and the warning naming each. */
export function curationOf(input: MemoryCurationInput): {
  curation: MemoryCuration;
  warnings: CurationWarning[];
} {
  const owed = MEMORY_CURATION_FIELDS.filter((f) => input[f] === undefined);
  const warnings = owed.map(
    (f): CurationWarning => ({
      code: 'CURATION_OWED',
      path: `/${f}`,
      detail: `${owedSentence(f)} Send it on the next write of this entry: ${MEMORY_CURATION_FIELD_SHAPES[f]}.`,
    }),
  );
  return {
    curation: {
      type: input.type ?? CURATED_ENTRY_TYPE_DEFAULT,
      scope: input.scope ?? MEMORY_UNSCOPED,
      recheckWhen: input.recheckWhen ?? null,
      value: input.value ?? null,
      endsWhen: input.endsWhen ?? null,
      owed,
    },
    warnings,
  };
}

function owedSentence(field: MemoryCurationField): string {
  if (field === 'type')
    return `No \`type\` was sent, so it is stored as \`${CURATED_ENTRY_TYPE_DEFAULT}\`: an inference is never stored as a fact.`;
  if (field === 'scope') return `No \`scope\` was sent, so it is stored as \`${MEMORY_UNSCOPED}\`.`;
  if (field === 'recheckWhen')
    return 'No `recheckWhen` was sent, so no landing or rule change flags it for a re-check.';
  return 'No `value` was sent: say how this helps later work, or keep it as history (a comment on the issue) rather than memory.';
}

const TYPES = new Set<string>(CURATED_ENTRY_TYPES);
const FIELDS = new Set<string>(MEMORY_CURATION_FIELDS);

/**
 * A row's answers as a reader reads them. A curated source written before the answers were asked
 * for owes all four; a mirror is no curated memory and owes none.
 */
export function storedCuration(source: string, metadata: unknown): MemoryCuration {
  const c = ((metadata ?? {}) as Record<string, unknown>).curation as
    | Record<string, unknown>
    | undefined;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const type =
    typeof c?.type === 'string' && TYPES.has(c.type) ? (c.type as CuratedEntryType) : null;
  const owed = Array.isArray(c?.owed)
    ? (c.owed.filter((f) => typeof f === 'string' && FIELDS.has(f)) as MemoryCurationField[])
    : isCuratedSource(source)
      ? [...MEMORY_CURATION_FIELDS]
      : [];
  return {
    type: type ?? CURATED_ENTRY_TYPE_DEFAULT,
    scope: text(c?.scope) ?? MEMORY_UNSCOPED,
    recheckWhen: text(c?.recheckWhen),
    value: text(c?.value),
    endsWhen: text(c?.endsWhen),
    owed,
  };
}
