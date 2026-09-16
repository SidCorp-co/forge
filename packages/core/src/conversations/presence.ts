// A handle's presence — how eager it is to speak in a room it was not summoned
// into — as configuration with today's constants for defaults (ISS-1034).
//
// This is the ONE reader of `PresenceConfig`: the bounds a value must sit in,
// what an unset key means, and how a room with several handles folds their
// values into the one set of thresholds `decideProactivity` reads.

import { z } from 'zod';
import {
  type AnswerInGroupMode,
  answerInGroupModes,
  type PresenceConfig,
} from '../db/schema-agent-selves.js';

/**
 * Today's constants, and what an unset key folds as. `proactivity.ts` reads
 * these back so the two cannot drift; `presence.test.ts` asserts they equal
 * the values the guards were tuned at.
 */
export const PRESENCE_DEFAULTS = {
  dormantMs: 24 * 60 * 60 * 1000,
  backoffAfter: 3,
  loopBounceMs: 5 * 60 * 1000,
  loopLimit: 3,
  answerInGroup: 'window' as AnswerInGroupMode,
  heartbeatEnabled: false,
  heartbeatIntervalMs: 60 * 60 * 1000,
} as const;

/** Inclusive bounds, named in every refusal. */
export const PRESENCE_BOUNDS = {
  dormantMs: [60_000, 30 * 24 * 60 * 60 * 1000],
  backoffAfter: [1, 20],
  loopBounceMs: [10_000, 60 * 60 * 1000],
  loopLimit: [1, 20],
  heartbeatIntervalMs: [5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000],
} as const;

const bounded = (key: keyof typeof PRESENCE_BOUNDS) => {
  const [lo, hi] = PRESENCE_BOUNDS[key];
  return z
    .number()
    .int()
    .min(lo, { error: `presence.${key} must be between ${lo} and ${hi}` })
    .max(hi, { error: `presence.${key} must be between ${lo} and ${hi}` });
};

export const PRESENCE_KEYS = [
  'dormantMs',
  'backoffAfter',
  'loopBounceMs',
  'loopLimit',
  'answerInGroup',
  'heartbeat',
] as const;
const HEARTBEAT_KEYS = ['enabled', 'intervalMs'] as const;

export const presenceConfigSchema = z
  .object({
    dormantMs: bounded('dormantMs').optional(),
    backoffAfter: bounded('backoffAfter').optional(),
    loopBounceMs: bounded('loopBounceMs').optional(),
    loopLimit: bounded('loopLimit').optional(),
    answerInGroup: z.enum(answerInGroupModes).optional(),
    heartbeat: z
      .object({
        enabled: z.boolean().optional(),
        intervalMs: bounded('heartbeatIntervalMs').optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export class PresenceValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join('; '));
    this.name = 'PresenceValidationError';
    this.issues = issues;
  }
}

/** The shape, or a refusal that says which key or bound was wrong. */
export function validatePresence(input: unknown): PresenceConfig {
  const parsed = presenceConfigSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => {
    const path = i.path.length ? `presence.${i.path.join('.')}` : 'presence';
    if (i.code === 'unrecognized_keys') {
      const inner = i.path.length ? HEARTBEAT_KEYS : PRESENCE_KEYS;
      return `${path}: unknown key(s) ${i.keys.map((k) => `\`${k}\``).join(', ')}; it takes only: ${inner.join(', ')}`;
    }
    return `${path}: ${i.message}`;
  });
  throw new PresenceValidationError(issues);
}

/** What `decideProactivity` reads: every key resolved, none optional. */
export interface ResolvedPresence {
  dormantMs: number;
  backoffAfter: number;
  loopBounceMs: number;
  loopLimit: number;
  answerInGroup: AnswerInGroupMode;
}

/**
 * One set of thresholds for a room with several handles: each key folds by
 * its own operator, and a key nobody set folds as its default.
 */
export function foldPresence(selves: readonly PresenceConfig[]): ResolvedPresence {
  const pick = <K extends keyof ResolvedPresence>(
    key: K,
    op: (values: number[]) => number,
  ): number => {
    const fallback = PRESENCE_DEFAULTS[key] as number;
    const values = selves.map((s) => (s[key] as number | undefined) ?? fallback);
    return values.length ? op(values) : fallback;
  };
  const modes = selves.map((s) => s.answerInGroup);
  return {
    dormantMs: pick('dormantMs', (v) => Math.min(...v)),
    backoffAfter: pick('backoffAfter', (v) => Math.min(...v)),
    loopBounceMs: pick('loopBounceMs', (v) => Math.max(...v)),
    loopLimit: pick('loopLimit', (v) => Math.min(...v)),
    answerInGroup: modes.includes('mention') ? 'mention' : PRESENCE_DEFAULTS.answerInGroup,
  };
}

/** A handle's heartbeat, resolved — read per handle, never folded across a room. */
export function heartbeatOf(self: PresenceConfig): { enabled: boolean; intervalMs: number } {
  return {
    enabled: self.heartbeat?.enabled ?? PRESENCE_DEFAULTS.heartbeatEnabled,
    intervalMs: self.heartbeat?.intervalMs ?? PRESENCE_DEFAULTS.heartbeatIntervalMs,
  };
}

/**
 * Whether a message names a handle: `@handle` or the bare handle as a word.
 */
export function namesHandle(content: string, handle: string | null): boolean {
  if (!handle) return false;
  const escaped = handle.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])@?${escaped}(?![\\w-])`, 'i').test(content);
}

/** Whether any message in the window names any of the room's handles. */
export function windowNamesAHandle(
  messages: readonly { content: string }[],
  handles: readonly (string | null)[],
): boolean {
  return messages.some((m) => handles.some((h) => namesHandle(m.content, h)));
}
