export const skillActivityEventTypes = [
  'policy.landed',
  'skill.body.changed',
  'manifest.changed',
  'job.ran.with',
  'skill.pinned',
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
