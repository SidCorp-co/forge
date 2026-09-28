export const skillActivityEventTypes = [
  'packet.published',
  'policy.landed',
  'reconcile.started',
  'reconcile.decided',
  'reconcile.failed',
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
  'reconcile.acknowledged',
] as const;
export type SkillActivityEventType = (typeof skillActivityEventTypes)[number];

export const skillActivityTriggers = [
  'push',
  'poll',
  'cli',
  'provision',
  'deploy',
  'manual',
] as const;
export type SkillActivityTrigger = (typeof skillActivityTriggers)[number];
