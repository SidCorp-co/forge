import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, appConfig, domainTemplates, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { registerSkillForProject, resolveOrAdoptProjectSkill } from '../skills/service.js';
import type { DomainTemplateManifest } from './manifest.js';
import { domainTemplateManifestSchema } from './manifest.js';

export interface ApplyTemplateInput {
  projectId: string;
  templateKey: string;
  actorUserId: string;
}

export interface ApplyTemplateResult {
  templateKey: string;
  agentId: string;
  appConfigId: string;
  registeredSkillNames: string[];
  skippedSkillNames: string[];
}

export class TemplateNotFoundError extends Error {
  constructor(public readonly templateKey: string) {
    super(`domain template not found: ${templateKey}`);
    this.name = 'TemplateNotFoundError';
  }
}

export class TemplateInvalidManifestError extends Error {
  constructor(
    public readonly templateKey: string,
    public override readonly cause: unknown,
  ) {
    super(`domain template manifest invalid: ${templateKey}`);
    this.name = 'TemplateInvalidManifestError';
  }
}

export async function applyTemplate(input: ApplyTemplateInput): Promise<ApplyTemplateResult> {
  const { projectId, templateKey, actorUserId } = input;

  const [template] = await db
    .select()
    .from(domainTemplates)
    .where(eq(domainTemplates.key, templateKey))
    .limit(1);
  if (!template) throw new TemplateNotFoundError(templateKey);

  // Re-parse the stored manifest. Builtin manifests pass at seed time, but a
  // manually-edited row could be malformed — fail loudly rather than silently
  // applying a half-shaped agent.
  const parsed = domainTemplateManifestSchema.safeParse(template.manifest);
  if (!parsed.success) throw new TemplateInvalidManifestError(templateKey, parsed.error);
  const manifest: DomainTemplateManifest = parsed.data;

  // 1+2. Upsert agent + app_config inside one transaction with a row lock on
  //      `projects.id`. The `agents` table only has an INDEX on (projectId,type)
  //      — no UNIQUE — so a naked SELECT-then-INSERT race could double-insert
  //      under concurrent apply calls (review finding). Locking the parent
  //      project row serialises apply for the same project at low cost.
  //      `enabled` is intentionally only written on insert so a manually
  //      disabled agent is not silently re-enabled by a later apply.
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM ${projects} WHERE id = ${projectId} FOR UPDATE`);

    const [existingAgent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.type, manifest.agentConfig.type)))
      .limit(1);

    let txAgentId: string;
    if (existingAgent) {
      const updateValues: Record<string, unknown> = {
        name: manifest.agentConfig.name,
        description: manifest.agentConfig.description ?? null,
        customInstructions: manifest.agentConfig.customInstructions ?? null,
        updatedAt: sql`now()`,
      };
      if (manifest.agentConfig.focusAreas !== undefined) {
        updateValues.focusAreas = manifest.agentConfig.focusAreas;
      }
      // Only honour `enabled` from the manifest if it is explicitly present —
      // re-applying a template should not overwrite an operator's manual
      // `disabled` toggle (review finding).
      if ('enabled' in manifest.agentConfig && manifest.agentConfig.enabled !== undefined) {
        updateValues.enabled = manifest.agentConfig.enabled;
      }
      const [updated] = await tx
        .update(agents)
        .set(updateValues)
        .where(eq(agents.id, existingAgent.id))
        .returning({ id: agents.id });
      if (!updated) throw new Error('domain-templates.apply: agent update returned no row');
      txAgentId = updated.id;
    } else {
      const [inserted] = await tx
        .insert(agents)
        .values({
          projectId,
          name: manifest.agentConfig.name,
          type: manifest.agentConfig.type,
          description: manifest.agentConfig.description ?? null,
          customInstructions: manifest.agentConfig.customInstructions ?? null,
          enabled: manifest.agentConfig.enabled ?? true,
          // `focusAreas` falls back to the schema default (forge agent defaults)
          // when omitted from the manifest — that is intentional, not a bug.
          ...(manifest.agentConfig.focusAreas !== undefined
            ? { focusAreas: manifest.agentConfig.focusAreas }
            : {}),
        })
        .returning({ id: agents.id });
      if (!inserted) throw new Error('domain-templates.apply: agent insert returned no row');
      txAgentId = inserted.id;
    }

    // app_config is UNIQUE on project_id, so a plain upsert is race-safe even
    // outside the lock. We keep it inside the transaction so the apply is
    // atomic: either both rows reflect the new template or neither.
    const defaults = manifest.appConfigDefaults ?? {};
    const appConfigValues: Record<string, unknown> = {};
    if (defaults.chatProviderId !== undefined)
      appConfigValues.chatProviderId = defaults.chatProviderId;
    if (defaults.chatModel !== undefined) appConfigValues.chatModel = defaults.chatModel;
    if (defaults.retrievalTopK !== undefined) appConfigValues.retrievalTopK = defaults.retrievalTopK;
    if (defaults.retrievalMinScore !== undefined)
      appConfigValues.retrievalMinScore = defaults.retrievalMinScore;
    if (defaults.enabledChannels !== undefined)
      appConfigValues.enabledChannels = defaults.enabledChannels;
    if (defaults.systemPromptOverride !== undefined)
      appConfigValues.systemPromptOverride = defaults.systemPromptOverride;

    const [appConfigRow] = await tx
      .insert(appConfig)
      .values({ projectId, ...appConfigValues })
      .onConflictDoUpdate({
        target: appConfig.projectId,
        set: { ...appConfigValues, updatedAt: sql`now()` },
      })
      .returning({ id: appConfig.id });
    if (!appConfigRow) throw new Error('domain-templates.apply: app_config upsert returned no row');

    return { agentId: txAgentId, appConfigId: appConfigRow.id };
  });
  const { agentId, appConfigId } = result;

  // 3. Register skills by name. Skills are unique on (projectId, stage) — the
  //    `registerSkillForProject` helper handles the swap (delete other stages
  //    for the same skill, upsert the new binding). Skills not yet seeded are
  //    skipped (warn-logged) so apply does not fail mid-way.
  const registeredSkillNames: string[] = [];
  const skippedSkillNames: string[] = [];
  for (const reg of manifest.skillRegistrations ?? []) {
    // Single path: materialise a project-owned skill (cloning the global
    // template if the project hasn't adopted one yet), then register THAT.
    // A global is never registered directly. See docs/skills-scope-playbook.md.
    const skillId = await resolveOrAdoptProjectSkill(projectId, reg.skillName);
    if (!skillId) {
      logger.warn(
        { templateKey, skillName: reg.skillName, stage: reg.stage },
        'domain-templates.apply: no project or global skill of that name, skipping registration',
      );
      skippedSkillNames.push(reg.skillName);
      continue;
    }
    await registerSkillForProject({
      projectId,
      skillId,
      stage: reg.stage,
      actorUserId,
    });
    registeredSkillNames.push(reg.skillName);
  }

  return {
    templateKey,
    agentId,
    appConfigId,
    registeredSkillNames,
    skippedSkillNames,
  };
}
