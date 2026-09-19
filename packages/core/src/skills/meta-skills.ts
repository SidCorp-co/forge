export const META_SKILL_NAMES: ReadonlyArray<string> = [
  'forge-onboard',
  'forge-reconcile',
  'forge-verify-skill',
];

export function isMetaSkillName(name: string): boolean {
  return META_SKILL_NAMES.includes(name);
}

export class MetaSkillReservedError extends Error {
  readonly code = 'META_SKILL_RESERVED';
  constructor(name: string) {
    super(
      `META_SKILL_RESERVED: '${name}' is a Forge meta skill delivered via the plugin channel and cannot be shadowed by a per-project skill`,
    );
    this.name = 'MetaSkillReservedError';
  }
}
