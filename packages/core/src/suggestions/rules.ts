/**
 * The guards of workflow `suggestion-lifecycle` rev 2, as pure functions over what the service read:
 * which payload a kind takes and on which target, whether the base is still the head, the open
 * queue's cap, who may decide, and what a decided row refuses. Every refusal is named; the service
 * answers it with nothing written, except a stale base, which marks the row stale as it refuses.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProjectMemberRole } from '../db/schema.js';
import type { SuggestionKind, SuggestionStatus } from '../db/schema-suggestions.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { projectRoleAtLeast } from '../lib/authz.js';
import { criterionSchema, specSchema } from '../requirements/schemas.js';

export type SuggestionRefusalCode =
  | 'SUGGESTION_PAYLOAD_INVALID'
  | 'SUGGESTION_TARGET_INVALID'
  | 'SUGGESTION_BASE_STALE'
  | 'SUGGESTION_DUPLICATE'
  | 'SUGGESTION_QUEUE_FULL'
  | 'SUGGESTION_ACCEPT_FORBIDDEN'
  | 'SUGGESTION_REJECT_REASON_REQUIRED'
  | 'SUGGESTION_DECIDED'
  | 'SUGGESTION_WITHDRAW_FORBIDDEN';

export interface SuggestionRefusal {
  code: SuggestionRefusalCode;
  path: string;
  detail: string;
}

/** At most this many proposed suggestions wait on one target (SUGGESTION_QUEUE_FULL). */
export const MAX_OPEN_PER_TARGET = 5;
/** A suggestion nobody decided within this many days is marked stale by the retention sweep. */
export const STALE_AFTER_DAYS = 30;
/** A rejected, stale or withdrawn suggestion keeps its payload this many days after the decision. */
export const PURGE_PAYLOAD_AFTER_DAYS = 90;

export type SuggestionTargetType = 'requirement' | 'issue';

const revisionWrite = {
  reason: z.string().trim().min(1).max(4_000),
  spec: specSchema.optional(),
  tldr: z.string().max(4_000).nullable().optional(),
  changeSummary: z.string().max(4_000).nullable().optional(),
  criteria: z.array(criterionSchema).max(200),
};

/** Each kind's payload and the targets it may name. A payload that does not parse is refused. */
export const SUGGESTION_PAYLOADS = {
  requirement_draft: {
    targets: ['issue'],
    schema: z.strictObject({ title: z.string().trim().min(1).max(500), ...revisionWrite }),
  },
  revision_diff: {
    targets: ['requirement'],
    schema: z.strictObject(revisionWrite),
  },
  readiness: {
    targets: ['requirement'],
    schema: z.strictObject({
      checks: z
        .array(
          z.strictObject({
            check: z.string().trim().min(1).max(200),
            passed: z.boolean(),
            detail: z.string().max(2_000).optional(),
          }),
        )
        .min(1)
        .max(20),
    }),
  },
  breakdown: {
    targets: ['requirement'],
    schema: z.strictObject({
      issues: z
        .array(
          z.strictObject({
            title: z.string().trim().min(1).max(500),
            description: z.string().max(20_000).optional(),
            criteria: z
              .array(
                z.strictObject({
                  body: z.string().trim().min(1).max(4_000),
                  tracesTo: z
                    .string()
                    .regex(/^BC-[1-9][0-9]*$/)
                    .optional(),
                }),
              )
              .max(100)
              .optional(),
            blockedBy: z.array(z.number().int().min(0)).max(50).optional(),
          }),
        )
        .min(1)
        .max(30),
      uncovered: z
        .array(z.strictObject({ code: z.string().regex(/^BC-[1-9][0-9]*$/), reason: z.string() }))
        .max(100)
        .optional(),
    }),
  },
  triage: {
    targets: ['issue'],
    schema: z.strictObject({
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      category: z.string().max(100).optional(),
      route: z.string().max(200).optional(),
      note: z.string().trim().min(1).max(4_000),
    }),
  },
  duplicate: {
    targets: ['requirement', 'issue'],
    schema: z.strictObject({
      duplicateOf: z.string().trim().min(1).max(200),
      similarity: z.number().min(0).max(1).optional(),
      note: z.string().max(4_000).optional(),
    }),
  },
} as const satisfies Record<
  SuggestionKind,
  { targets: readonly SuggestionTargetType[]; schema: z.ZodType }
>;

/** The kinds whose base is a requirement revision: an accept compares it with the head. */
export const REVISION_BASED: readonly SuggestionKind[] = [
  'revision_diff',
  'readiness',
  'breakdown',
];

// cm:guard kind is one of the 6 and the payload parses for it (SUGGESTION_PAYLOAD_INVALID), on a target
// the kind takes (SUGGESTION_TARGET_INVALID)
export function payloadRefusal(
  kind: SuggestionKind,
  target: SuggestionTargetType,
  payload: unknown,
): SuggestionRefusal | null {
  const spec = SUGGESTION_PAYLOADS[kind];
  if (!(spec.targets as readonly string[]).includes(target)) {
    return {
      code: 'SUGGESTION_TARGET_INVALID',
      path: '/target',
      detail: `a ${kind} suggestion targets ${spec.targets.join(' or ')}, not ${target}.`,
    };
  }
  const parsed = spec.schema.safeParse(payload);
  if (parsed.success) return null;
  const first = parsed.error.issues[0];
  return {
    code: 'SUGGESTION_PAYLOAD_INVALID',
    path: `/payload${first?.path.length ? `/${first.path.join('/')}` : ''}`,
    detail: `the ${kind} payload does not parse: ${first?.message ?? 'invalid'}.`,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** What two suggestions saying the same thing share, whatever order their keys came in. */
export function fingerprintOf(kind: SuggestionKind, payload: unknown): string {
  return createHash('sha256')
    .update(`${kind}\u0000${JSON.stringify(canonical(payload))}`)
    .digest('hex')
    .slice(0, 32);
}

// cm:guard the base a suggestion names is the target's head when it is written and when it is
// accepted (compare-and-set); otherwise SUGGESTION_BASE_STALE naming both revisions
export function baseStaleRefusal(
  base: number | null,
  head: number | null,
): SuggestionRefusal | null {
  if (base === head) return null;
  const name = (n: number | null) => (n === null ? 'no revision' : `revision ${n}`);
  return {
    code: 'SUGGESTION_BASE_STALE',
    path: '/baseRevision',
    detail: `the suggestion is based on ${name(base)}, but the target's head is ${name(head)}; it is stale. Read the head and propose against it.`,
  };
}

export function duplicateRefusal(twinId: string | null): SuggestionRefusal | null {
  if (!twinId) return null;
  return {
    code: 'SUGGESTION_DUPLICATE',
    path: '/payload',
    detail: `suggestion ${twinId} already proposes the same change on this target and is still open.`,
  };
}

// cm:guard at most 5 proposed suggestions wait on one target; a 6th is SUGGESTION_QUEUE_FULL
export function queueFullRefusal(openOnTarget: number): SuggestionRefusal | null {
  if (openOnTarget < MAX_OPEN_PER_TARGET) return null;
  return {
    code: 'SUGGESTION_QUEUE_FULL',
    path: '/target',
    detail: `${openOnTarget} suggestions already wait on this target (at most ${MAX_OPEN_PER_TARGET}); a person decides one before another is proposed.`,
  };
}

export interface DeciderFacts {
  userId: string;
  agency: ActorAgency;
  role: ProjectMemberRole | null;
  producerId: string | null;
}

// cm:guard only a person of the project decides a suggestion, and never the one who produced it: an
// agent, the assistant or the producer is SUGGESTION_ACCEPT_FORBIDDEN
export function deciderRefusal(
  facts: DeciderFacts,
  act: 'accept' | 'reject',
): SuggestionRefusal | null {
  if (facts.agency !== 'human') {
    return {
      code: 'SUGGESTION_ACCEPT_FORBIDDEN',
      path: '',
      detail: `${facts.userId} acts as an agent; to ${act} a suggestion is a person's act. An agent or the assistant proposes and leaves the decision to them.`,
    };
  }
  if (!projectRoleAtLeast(facts.role, 'member')) {
    return {
      code: 'SUGGESTION_ACCEPT_FORBIDDEN',
      path: '',
      detail: `${facts.userId} holds ${facts.role ?? 'no role'} on this project; a member or above decides a suggestion.`,
    };
  }
  if (act === 'accept' && facts.producerId === facts.userId) {
    return {
      code: 'SUGGESTION_ACCEPT_FORBIDDEN',
      path: '',
      detail: `${facts.userId} produced this suggestion; somebody else accepts it.`,
    };
  }
  return null;
}

// cm:guard a rejection carries its reason, which feeds the next suggestion on that target
export function rejectReasonRefusal(reason: string | null | undefined): SuggestionRefusal | null {
  if (reason?.trim()) return null;
  return {
    code: 'SUGGESTION_REJECT_REASON_REQUIRED',
    path: '/reason',
    detail: 'a rejected suggestion says why, so the assistant does not propose it again.',
  };
}

// cm:guard a decided suggestion stays decided: accept, reject or withdraw after it is SUGGESTION_DECIDED
export function decidedRefusal(status: SuggestionStatus): SuggestionRefusal | null {
  if (status === 'proposed') return null;
  return {
    code: 'SUGGESTION_DECIDED',
    path: '/status',
    detail: `the suggestion is ${status}; only a proposed suggestion is accepted, rejected or withdrawn.`,
  };
}

export function withdrawRefusal(
  userId: string,
  producerId: string | null,
): SuggestionRefusal | null {
  if (producerId !== null && producerId === userId) return null;
  return {
    code: 'SUGGESTION_WITHDRAW_FORBIDDEN',
    path: '',
    detail: `${userId} did not produce this suggestion; its producer withdraws it, anybody else rejects it with a reason.`,
  };
}
