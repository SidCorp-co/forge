// What a knowledge entry rests on, where it applies and when it stops being true (ISS-1064). A write
// of a reference, guide, workflow or rule, and every org entry, carries `source`, `scope` and
// `recheckWhen`, or is refused `KNOWLEDGE_PROVENANCE_MISSING` naming each field it left out and the
// shape that is valid. A lesson keeps its own provenance in the lessons module (`lesson-entries.ts`),
// which writes past this door. Rows written before the fields existed hold null in all three: they
// stay readable and the anchor audit lists them as owing them (`.forge/conformance.json`,
// `knowledge-entries-without-provenance`).

import {
  KNOWLEDGE_PROVENANCE_FIELD_SHAPES,
  KNOWLEDGE_PROVENANCE_FIELDS,
  KNOWLEDGE_PROVENANCE_KINDS,
  KNOWLEDGE_PROVENANCE_SHAPE,
  type KnowledgeProvenance,
  type KnowledgeProvenanceField,
  type KnowledgeRefusalCode,
} from '@forge/contracts/knowledge';
import { RefusalError } from '../lib/refusal.js';

const CODE: KnowledgeRefusalCode = 'KNOWLEDGE_PROVENANCE_MISSING';
const FALLBACK: KnowledgeRefusalCode = 'KNOWLEDGE_REFUSED';

/** Whether an entry of `kind` owes the three fields. */
export const owesProvenance = (kind: string): boolean =>
  (KNOWLEDGE_PROVENANCE_KINDS as readonly string[]).includes(kind);

/** What a write sent for the three fields: absent, null or a string, each read the same way. */
export type ProvenanceInput = Partial<Record<KnowledgeProvenanceField, string | null | undefined>>;

const held = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** The three fields as stored: trimmed, and null where nothing was sent. */
export const provenanceOf = (input: ProvenanceInput): KnowledgeProvenance => ({
  source: held(input.source),
  scope: held(input.scope),
  recheckWhen: held(input.recheckWhen),
});

/**
 * The refusal of a write owing the three fields that left one or more out (absent, null or blank),
 * one refusal per field at its own path naming that field's shape, the sentence naming every one
 * and the whole shape; null
 * where nothing is owed or all three are there. `what` names the entry in the sentence.
 */
export function provenanceRefusal(what: string, input: ProvenanceInput): RefusalError | null {
  const stored = provenanceOf(input);
  const missing = KNOWLEDGE_PROVENANCE_FIELDS.filter((f) => stored[f] === null);
  if (missing.length === 0) return null;
  const named = missing.map((f) => `\`${f}\``).join(', ');
  const detail = `${what} names no ${named}: an entry says what it rests on, where it applies and the change that means it needs re-checking. Valid: ${KNOWLEDGE_PROVENANCE_SHAPE}.`;
  return new RefusalError(
    missing.map((f) => ({
      code: CODE,
      path: `/${f}`,
      detail: `${what} names no \`${f}\`. Valid: ${KNOWLEDGE_PROVENANCE_FIELD_SHAPES[f]}`,
    })),
    FALLBACK,
    detail,
  );
}

/** The refusal of a project entry's write, or null where its kind owes nothing or it carries all three. */
export function entryProvenanceRefusal(
  input: { slug: string; kind: string } & ProvenanceInput,
): RefusalError | null {
  if (!owesProvenance(input.kind)) return null;
  return provenanceRefusal(`\`${input.slug}\` is a ${input.kind} and`, input);
}
