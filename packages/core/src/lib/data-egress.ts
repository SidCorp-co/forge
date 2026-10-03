/**
 * The one egress guard (decision Q8, owner ruling 2026-10-03): what of a project's content may
 * leave for an embedding or LLM provider. The embedding writer, the BA door's tools and every
 * provider-bound read call it; none of them reads the project's level on its own.
 */

import {
  type DataEgressRefusalCode,
  SENSITIVE_DATA_DEFAULT,
  type SensitiveDataLevel,
} from '@forge/contracts/data-policy';
import { redactionCount, scrubPersonalData } from '@forge/observability';
import { readProjectDocument } from '../project-config/service.js';

export interface EgressRefusal {
  code: DataEgressRefusalCode;
  path: string;
  detail: string;
}

export type Egress =
  | { ok: true; text: string; redactions: number }
  | { ok: false; refusal: EgressRefusal };

/** The project's level; a project with no document, or a document that names none, is `off`. */
export async function dataPolicyOf(projectId: string): Promise<SensitiveDataLevel> {
  const doc = await readProjectDocument(projectId);
  return doc?.document.sensitiveData ?? SENSITIVE_DATA_DEFAULT;
}

/** Text as it may be stored: scrubbed on write at `redact` and at `no_egress`. */
export function storedText(level: SensitiveDataLevel, text: string) {
  if (level === 'off') return { text, redactions: 0, scrubbed: false };
  const scrub = scrubPersonalData(text);
  return { text: scrub.text, redactions: redactionCount(scrub.redactions), scrubbed: true };
}

/** Questionnaire answers as they may be stored: typed text scrubbed as `storedText`, choice ids kept. */
export function storedAnswers<A extends { text?: string | undefined }>(
  level: SensitiveDataLevel,
  answers: readonly A[],
): A[] {
  return answers.map((a) =>
    a.text === undefined ? a : { ...a, text: storedText(level, a.text).text },
  );
}

// cm:guard content leaves for a provider only as the project's level allows: as written at off,
// scrubbed at redact, never at no_egress, which is refused by name so the caller sends metadata only
export function egressOf(level: SensitiveDataLevel, text: string, what: string): Egress {
  if (level === 'no_egress') {
    return {
      ok: false,
      refusal: {
        code: 'CONTENT_EGRESS_FORBIDDEN',
        path: '',
        detail: `${what} belongs to a project whose sensitiveData is no_egress: its content never reaches an embedding or LLM provider, redacted or not. Only its metadata (key, kind, severity, status, links) may be read here.`,
      },
    };
  }
  if (level === 'redact') {
    const scrub = scrubPersonalData(text);
    return { ok: true, text: scrub.text, redactions: redactionCount(scrub.redactions) };
  }
  return { ok: true, text, redactions: 0 };
}

/** `egressOf` at the project's own level. */
export async function egressFor(projectId: string, text: string, what: string): Promise<Egress> {
  return egressOf(await dataPolicyOf(projectId), text, what);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

/** `onboarding_answers` is product information, not patient data (owner, 2026-10-04): scrubbed at no_egress. */
export type EgressDataClass = 'content' | 'onboarding_answers';

// cm:guard only questionnaire answers in an onboarding conversation qualify for the no_egress
// exemption, so a BA clarification batch, which can quote feedback, never does and is refused by name
function onboardingAnswersRefusal(value: unknown, what: string): EgressRefusal | null {
  const batches = Array.isArray(value) ? value : [value];
  const at = batches.findIndex((b) => {
    const batch = b as { onboardingId?: unknown; requirementId?: unknown } | null;
    return (
      typeof batch !== 'object' ||
      batch === null ||
      typeof batch.onboardingId !== 'string' ||
      batch.onboardingId === '' ||
      batch.requirementId !== null
    );
  });
  if (at === -1) return null;
  const id = (batches[at] as { id?: unknown } | null | undefined)?.id;
  return {
    code: 'CONTENT_EGRESS_FORBIDDEN',
    path: '',
    detail: `${what} was read as onboarding answers, but ${typeof id === 'string' ? `questionnaire ${id}` : 'an entry'} is not a batch of an onboarding conversation (it names no onboarding, or names a requirement). Only onboarding questionnaire answers are exempt from no_egress; a requirement clarification is content.`,
  };
}

/** `egressOf` over a structured answer: every string scrubbed at redact, ids and times kept whole. */
export function egressDeep<T>(
  level: SensitiveDataLevel,
  value: T,
  what: string,
  dataClass: EgressDataClass = 'content',
): { ok: true; value: T } | { ok: false; refusal: EgressRefusal } {
  if (dataClass === 'onboarding_answers') {
    const stray = onboardingAnswersRefusal(value, what);
    if (stray) return { ok: false, refusal: stray };
  }
  const exempt = dataClass === 'onboarding_answers' && level === 'no_egress';
  const gate = exempt ? { ok: true as const } : egressOf(level, '', what);
  if (!gate.ok) return gate;
  if (level === 'off') return { ok: true, value };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (UUID.test(v) || ISO_TIME.test(v)) return v;
      return scrubPersonalData(v).text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return { ok: true, value: walk(value) as T };
}
