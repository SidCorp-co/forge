import { refuse } from './refuse.js';

export const META_SKILL_NAMES: ReadonlyArray<string> = ['forge-onboard'];

export function isMetaSkillName(name: string): boolean {
  return META_SKILL_NAMES.includes(name);
}

export function metaSkillReserved(name: string) {
  return refuse(
    'META_SKILL_RESERVED',
    `'${name}' is a Forge meta skill delivered via the plugin channel and cannot be shadowed by a per-project skill`,
    '/name',
  );
}
