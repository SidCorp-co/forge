// Client-facing contract for `GET /api/skill-activity` (Update Pipeline §7,
// epic ISS-795 / ISS-797). Tuples are hardcoded here rather than imported
// from `@forge/core` (which has env side effects at import time), same as
// pipeline-registry.ts and skill-facts.ts. A parity test in
// `packages/core/src/skills/activity.test.ts` keeps them in sync with
// `db/schema.ts`.

import { z } from 'zod';

export const SKILL_ACTIVITY_EVENT_TYPES = [
  'packet.published',
  'policy.landed',
  'reconcile.started',
  'reconcile.decided',
  'skill.body.changed',
  'verify.failed',
  'reconcile.escalated',
  'manifest.changed',
  'device.skill.applied',
  'device.skill.pruned',
  'device.sync.failed',
  'device.skill.observed',
  'device.skill.shadowed',
  'job.ran.with',
  'skill.pinned',
  'charter.changed',
  'body.reverted',
] as const;
export type SkillActivityEventType = (typeof SKILL_ACTIVITY_EVENT_TYPES)[number];

export const SKILL_ACTIVITY_TRIGGERS = [
  'push',
  'poll',
  'cli',
  'provision',
  'deploy',
  'manual',
] as const;
export type SkillActivityTrigger = (typeof SKILL_ACTIVITY_TRIGGERS)[number];

export const SKILL_ACTIVITY_OUTCOMES = ['ok', 'failed', 'skipped'] as const;
export type SkillActivityOutcome = (typeof SKILL_ACTIVITY_OUTCOMES)[number];

export const skillActivityEventSchema = z.object({
  id: z.string(),
  occurredAt: z.union([z.string(), z.date()]),
  packetId: z.string().nullable(),
  projectId: z.string().nullable(),
  skillId: z.string().nullable(),
  deviceId: z.string().nullable(),
  eventType: z.enum(SKILL_ACTIVITY_EVENT_TYPES),
  actor: z.string(),
  trigger: z.enum(SKILL_ACTIVITY_TRIGGERS),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  deltaSummary: z.string().nullable(),
  reason: z.string().nullable(),
  outcome: z.enum(SKILL_ACTIVITY_OUTCOMES),
});
export type SkillActivityEvent = z.infer<typeof skillActivityEventSchema>;

export const skillActivityViewSchema = z.enum(['by-skill', 'by-device', 'by-packet']);

export const skillActivityResponseSchema = z.object({
  view: skillActivityViewSchema,
  projectId: z.string().nullable().optional(),
  skillId: z.string().nullable().optional(),
  deviceId: z.string().nullable().optional(),
  packetId: z.string().nullable().optional(),
  events: z.array(skillActivityEventSchema),
  summary: z.record(z.string(), z.number()).optional(),
});
export type SkillActivityResponse = z.infer<typeof skillActivityResponseSchema>;
