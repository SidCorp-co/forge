export const skillSources = ['builtin', 'user'] as const;
export type SkillSource = (typeof skillSources)[number];

export const skillTargets = ['dev', 'cloud', 'all'] as const;
export type SkillTarget = (typeof skillTargets)[number];
