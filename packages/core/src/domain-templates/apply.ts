import { and, eq, sql } from 'drizzle-orm';
import { insertAgent, updateAgent } from '../agents/index.js';
import { upsertAppConfig } from '../app-config/index.js';
import { db } from '../db/client.js';
import { agents, domainTemplates, projects } from '../db/schema.js';
import { notFound } from '../middleware/route-errors.js';
import { logger } from '../observability/logger.js';
import { registerSkillForProject, resolveOrAdoptProjectSkill } from '../skills/index.js';
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

export async function applyTemplate(input: ApplyTemplateInput): Promise<ApplyTemplateResult> {
  const { projectId, templateKey, actorUserId } = input;

  const [template] = await db
    .select()
    .from(domainTemplates)
    .where(eq(domainTemplates.key, templateKey))
    .limit(1);
  if (!template) throw notFound(`domain template not found: ${templateKey}`);

  // Re-parse the stored manifest. Builtin manifests pass at seed time, but a
  // manually-edited row could be malformed — fail loudly rather than silently
  // applying a half-shaped agent.
  const parsed = domainTemplateManifestSchema.safeParse(template.manifest);
  if (!parsed.success) {
    throw new Error(`domain template manifest invalid: ${templateKey}`, { cause: parsed.error });
  }
  const manifest: DomainTemplateManifest = parsed.data;

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
      txAgentId = await updateAgent(tx, existingAgent.id, updateValues);
    } else {
      txAgentId = await insertAgent(tx, {
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
      });
    }

    // app_config is UNIQUE on project_id, so a plain upsert is race-safe even
    // outside the lock. We keep it inside the transaction so the apply is
    // atomic: either both rows reflect the new template or neither.
    const defaults = manifest.appConfigDefaults ?? {};
    const appConfigValues: Record<string, unknown> = {};
    if (defaults.chatProviderId !== undefined)
      appConfigValues.chatProviderId = defaults.chatProviderId;
    if (defaults.chatModel !== undefined) appConfigValues.chatModel = defaults.chatModel;
    if (defaults.retrievalTopK !== undefined)
      appConfigValues.retrievalTopK = defaults.retrievalTopK;
    if (defaults.retrievalMinScore !== undefined)
      appConfigValues.retrievalMinScore = defaults.retrievalMinScore;
    if (defaults.enabledChannels !== undefined)
      appConfigValues.enabledChannels = defaults.enabledChannels;
    if (defaults.systemPromptOverride !== undefined)
      appConfigValues.systemPromptOverride = defaults.systemPromptOverride;

    const appConfigId = await upsertAppConfig(tx, projectId, appConfigValues);

    return { agentId: txAgentId, appConfigId };
  });
  const { agentId, appConfigId } = result;

  // 3. Register skills by name. Skills are unique on (projectId, stage) — the
  //    `registerSkillForProject` helper handles the swap (delete other stages
  //    for the same skill, upsert the new binding). Skills not yet seeded are
  //    skipped (warn-logged) so apply does not fail mid-way.
  const registeredSkillNames: string[] = [];
  const skippedSkillNames: string[] = [];
  for (const reg of manifest.skillRegistrations ?? []) {
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
