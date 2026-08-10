/**
 * ISS-741 — meta skills: Forge-owned skills delivered via the device-scope
 * plugin channel (marketplace `SidCorp-co/forge-pipeline-skills`, SHA-pinned,
 * ISS-739), applied to EVERY project on a device with no per-project
 * override. This is a distinct concept from `MANAGED_META_SKILLS` in
 * `./effective.ts` (the live MCP-prompt reference channel, no longer called
 * "meta" per project policy `skill-taxonomy-meta-vs-per-project`).
 *
 * A name here is reserved: a user cannot create/adopt/rename a per-project
 * skill to shadow it. Adding a name is the entire change.
 */
// cm:guard forge-reconcile / forge-verify-skill are Forge-OWNED GOVERNING agents: reserving them here is what stops a project owning an editable fork of the agent that polices its own updates (owner decision 2026-08-10)
// cm:why reserving the name is the enforcement — createProjectSkill, the rename path and stage registration all funnel through isMetaSkillName, so one entry closes adopt, create and shadow at once; the prompt-inlining in reconcile-service only stops Forge READING a fork, not a project creating one
export const META_SKILL_NAMES: ReadonlyArray<string> = [
  'forge-onboard',
  'forge-reconcile',
  'forge-verify-skill',
];

export function isMetaSkillName(name: string): boolean {
  return META_SKILL_NAMES.includes(name);
}

/**
 * Thrown when a user tries to create, adopt, or rename a project skill to a
 * reserved meta-skill name. The SYSTEM provisioning bridge (the `install_only`
 * bootstrap fan-out + domain-template apply) bypasses this via
 * `allowReservedMetaName: true` on `createProjectSkill`.
 */
export class MetaSkillReservedError extends Error {
  readonly code = 'META_SKILL_RESERVED';
  constructor(name: string) {
    super(
      `META_SKILL_RESERVED: '${name}' is a Forge meta skill delivered via the plugin channel and cannot be shadowed by a per-project skill`,
    );
    this.name = 'MetaSkillReservedError';
  }
}
