import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answerInGroupModes, type PresenceConfig } from '../db/schema-agent-selves.js';

/** Inclusive bounds, named in every refusal. */
const PRESENCE_BOUNDS = {
  dormantMs: [60_000, 30 * 24 * 60 * 60 * 1000],
  backoffAfter: [1, 20],
  loopBounceMs: [10_000, 60 * 60 * 1000],
  loopLimit: [1, 20],
  heartbeatIntervalMs: [5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000],
} as const;

/** A presence number inside its inclusive bounds; a room's presence reads the same bounds. */
export const boundedPresence = (key: keyof typeof PRESENCE_BOUNDS) => {
  const [lo, hi] = PRESENCE_BOUNDS[key];
  return z
    .number()
    .int()
    .min(lo, { error: `presence.${key} must be between ${lo} and ${hi}` })
    .max(hi, { error: `presence.${key} must be between ${lo} and ${hi}` });
};

const PRESENCE_KEYS = [
  'dormantMs',
  'backoffAfter',
  'loopBounceMs',
  'loopLimit',
  'answerInGroup',
  'heartbeat',
] as const;
const HEARTBEAT_KEYS = ['enabled', 'intervalMs'] as const;

const presenceConfigSchema = z
  .object({
    dormantMs: boundedPresence('dormantMs').optional(),
    backoffAfter: boundedPresence('backoffAfter').optional(),
    loopBounceMs: boundedPresence('loopBounceMs').optional(),
    loopLimit: boundedPresence('loopLimit').optional(),
    answerInGroup: z.enum(answerInGroupModes).optional(),
    heartbeat: z
      .object({
        enabled: z.boolean().optional(),
        intervalMs: boundedPresence('heartbeatIntervalMs').optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** A presence document that does not fit its shape: request shape, so a 400 naming each key. */
export function presenceInvalid(issues: string[]): HTTPException {
  return new HTTPException(400, {
    message: issues.join('; '),
    cause: { code: 'PRESENCE_INVALID', details: { issues } },
  });
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
  throw presenceInvalid(issues);
}
