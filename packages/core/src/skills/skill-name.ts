export const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,127}$/;

export function isSlashCommandSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}
