/**
 * The guards of workflow `suggestion-lifecycle` rev 2, as pure functions over what the service read:
 * which payload a kind takes and on which target, whether the base is still the head, the open
 * queue's cap, who may not accept, and what a decided row refuses. Every refusal is named; the
 * service answers it with nothing written, except a stale base on accept, which marks the row stale.
 */

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { createHash } from 'node:crypto';
import {
  SUGGESTION_MAX_OPEN_PER_TARGET,
  SUGGESTION_PAYLOADS,
  type SuggestionKind,
  type SuggestionRefusal,
  type SuggestionStatus,
  type SuggestionTargetType,
} from '@forge/contracts/suggestions';
import { type PermissionFacts, permissionRefusal } from '../permissions/index.js';

export type { SuggestionRefusal, SuggestionRefusalCode } from '@forge/contracts/suggestions';

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
  if (openOnTarget < SUGGESTION_MAX_OPEN_PER_TARGET) return null;
  return {
    code: 'SUGGESTION_QUEUE_FULL',
    path: '/target',
    detail: `${openOnTarget} suggestions already wait on this target (at most ${SUGGESTION_MAX_OPEN_PER_TARGET}); one is decided before another is proposed.`,
  };
}

// workflow requirement-to-delivery step `breakdown`: proposing or revising one takes suggestions.write
export const breakdownProposerRefusal = (facts: PermissionFacts): SuggestionRefusal | null =>
  permissionRefusal(facts, 'suggestions.write', 'proposing a breakdown');

// one open breakdown suggestion per requirement revision (step `breakdown` idempotency)
export function breakdownOpenRefusal(
  openId: string | null,
  revision: number | null,
): SuggestionRefusal | null {
  if (!openId) return null;
  return {
    code: 'SUGGESTION_BREAKDOWN_OPEN',
    path: '/target',
    detail: `breakdown suggestion ${openId} is still open on revision ${revision ?? '?'}; a revision holds one open breakdown. A holder of suggestions.approve accepts or rejects it first.`,
  };
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
    detail: `${userId} did not produce this suggestion; its producer withdraws it, a holder of suggestions.approve rejects it with a reason.`,
  };
}

export function unchangedRevisionRefusal(
  before: string,
  after: string,
  id: string,
): SuggestionRefusal | null {
  if (before !== after) return null;
  return {
    code: 'SUGGESTION_REVISION_UNCHANGED',
    path: '/payload',
    detail: `the payload proposes exactly what suggestion ${id} proposes; accept it as it stands, or change the payload.`,
  };
}

type Breakdown = ReturnType<(typeof SUGGESTION_PAYLOADS)['breakdown']['schema']['parse']>;

/** A design the requirement's latest baseline pins, which a breakdown issue may build. */
export interface PinnedDesign {
  workflowId: string;
  flow: string;
}

// cm:guard each breakdown issue builds a design its baseline pins: `builds` names a pinned flow or
// null for none; left out, the one pinned design is taken, none links nothing, and several are
// SUGGESTION_BUILD_UNNAMED; a flow the baseline does not pin is SUGGESTION_BUILD_UNPINNED (ISS-117)
export function breakdownBuilds(
  p: Breakdown,
  pins: readonly PinnedDesign[],
): { builds: (PinnedDesign | null)[]; refusals: SuggestionRefusal[] } {
  const refusals: SuggestionRefusal[] = [];
  const pinned = pins.map((d) => d.flow).join(', ') || 'none';
  const builds = p.issues.map((issue, i): PinnedDesign | null => {
    const path = `/payload/issues/${i}/builds`;
    if (issue.builds === null) return null;
    if (issue.builds === undefined) {
      if (pins.length <= 1) return pins[0] ?? null;
      refusals.push({
        code: 'SUGGESTION_BUILD_UNNAMED',
        path,
        detail: `the baseline pins several designs (${pinned}); name the one this issue builds in builds, or builds: null when it builds none.`,
      });
      return null;
    }
    const found = pins.find((d) => d.flow === issue.builds);
    if (found) return found;
    refusals.push({
      code: 'SUGGESTION_BUILD_UNPINNED',
      path,
      detail: `${issue.builds} is not a design the requirement's latest baseline pins (${pinned}); an issue builds a pinned design, or builds: null.`,
    });
    return null;
  });
  return { builds, refusals };
}

/** The first blockedBy entry that closes a cycle among the proposed issues, as [issue, entry]. */
function cycleAt(p: Breakdown): [number, number] | null {
  const state = new Map<number, 'open' | 'done'>();
  const visit = (i: number): [number, number] | null => {
    state.set(i, 'open');
    for (const [j, k] of (p.issues[i]?.blockedBy ?? []).entries()) {
      if (typeof k !== 'number' || k >= p.issues.length || k === i) continue;
      if (state.get(k) === 'open') return [i, j];
      const found = state.has(k) ? null : visit(k);
      if (found) return found;
    }
    state.set(i, 'done');
    return null;
  };
  for (let i = 0; i < p.issues.length; i++) {
    const found = state.has(i) ? null : visit(i);
    if (found) return found;
  }
  return null;
}

// cm:guard a breakdown's traces name BCs live at its base revision and its blockedBy edges name
// other proposed issues without a cycle, at propose and at accept (SUGGESTION_PAYLOAD_INVALID by path)
export function breakdownFaults(
  p: Breakdown,
  codes: ReadonlyMap<string, unknown>,
  revision: number,
): SuggestionRefusal[] {
  const out: SuggestionRefusal[] = [];
  const cycle = cycleAt(p);
  if (cycle) {
    out.push({
      code: 'SUGGESTION_PAYLOAD_INVALID',
      path: `/payload/issues/${cycle[0]}/blockedBy/${cycle[1]}`,
      detail:
        'the blockedBy edges among the proposed issues form a cycle, so none of them could ever start.',
    });
  }
  p.issues.forEach((issue, i) => {
    issue.criteria.forEach((c, j) => {
      if (!codes.has(c.tracesTo)) {
        out.push({
          code: 'SUGGESTION_PAYLOAD_INVALID',
          path: `/payload/issues/${i}/criteria/${j}/tracesTo`,
          detail: `${c.tracesTo} is not a business criterion of revision ${revision}; it holds ${[...codes.keys()].join(', ') || 'none'}.`,
        });
      }
    });
    (issue.blockedBy ?? []).forEach((k, j) => {
      if (typeof k === 'number' && (k >= p.issues.length || k === i)) {
        out.push({
          code: 'SUGGESTION_PAYLOAD_INVALID',
          path: `/payload/issues/${i}/blockedBy/${j}`,
          detail: `blockedBy names issue index ${k}, which is ${k === i ? 'this issue itself' : `outside the ${p.issues.length} proposed issues`}.`,
        });
      }
    });
  });
  return out;
}

/** An existing issue a breakdown names as a blocker, as it was read; null when nothing answers. */
export interface BlockerFound {
  key: string;
  projectId: string;
  status: string;
  archived: boolean;
}

// cm:guard a blocker named by key or uuid is a live issue of this project: one that does not
// resolve here is SUGGESTION_BLOCKER_UNKNOWN (another project's included), a closed, dropped or
// archived one SUGGESTION_BLOCKER_TERMINAL, since a blocks edge on it holds nothing back (ISS-89)
export function blockerRefusal(
  path: string,
  ref: string,
  projectId: string,
  found: BlockerFound | null,
  unreadable: string | null = null,
): SuggestionRefusal | null {
  if (!found || found.projectId !== projectId) {
    return {
      code: 'SUGGESTION_BLOCKER_UNKNOWN',
      path,
      detail: unreadable
        ? `blockedBy entry "${ref}" is neither an issue of this project nor an index: ${unreadable}`
        : found
          ? `blockedBy entry "${ref}" is an issue of another project; a blocks edge stays inside one project.`
          : `blockedBy entry "${ref}" names no issue of this project; a string names an existing issue by key (ISS-12) or uuid, a number another issue of this breakdown.`,
    };
  }
  if (found.archived || (ISSUE_TERMINAL_STATUSES as readonly string[]).includes(found.status)) {
    return {
      code: 'SUGGESTION_BLOCKER_TERMINAL',
      path,
      detail: `blockedBy entry ${found.key} is ${found.archived ? 'archived' : found.status}, so a blocks edge on it would hold nothing back; name a live issue, or leave it out.`,
    };
  }
  return null;
}
