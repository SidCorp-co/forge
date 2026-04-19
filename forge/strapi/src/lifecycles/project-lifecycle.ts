import { randomBytes } from 'node:crypto';

const DEFINITION_UID = 'api::agent-definition.agent-definition' as any;
const AGENT_UID = 'api::agent.agent' as any;
const PROJECT_UID = 'api::project.project' as any;

function generateApiKey(): string {
  return `fk_${randomBytes(24).toString('hex')}`;
}

export function subscribeProjectLifecycles(strapi: any) {
  strapi.db.lifecycles.subscribe({
    models: [PROJECT_UID],

    async beforeCreate(event: any) {
      // Auto-generate API key if not provided
      if (!event.params.data.apiKey) {
        event.params.data.apiKey = generateApiKey();
      }
    },

    async afterCreate(event: any) {
      const { result } = event;
      // Read all definitions from DB and create an agent for each
      const definitions = await strapi.documents(DEFINITION_UID).findMany({ limit: 100 });
      for (const def of definitions) {
        await strapi.documents(AGENT_UID).create({
          data: { name: def.name, type: def.type, enabled: false, project: result.documentId, definition: def.documentId },
        });
      }
    },
  });
}

/** Backfill: ensure every project has agents for all definitions + API key. */
export async function backfillProjectAgents(strapi: any) {
  const definitions = await strapi.documents(DEFINITION_UID).findMany({ limit: 100 });

  const projects = await strapi.documents(PROJECT_UID).findMany({});
  for (const project of projects) {
    // Backfill API key for existing projects
    if (!project.apiKey) {
      await strapi.documents(PROJECT_UID).update({
        documentId: project.documentId,
        data: { apiKey: generateApiKey() },
      });
      strapi.log.info(`Generated API key for project "${project.name}"`);
    }

    if (definitions.length === 0) continue;

    const existing = await strapi.documents(AGENT_UID).findMany({
      filters: { project: { documentId: project.documentId } },
      populate: { definition: true },
    });
    const existingTypes = new Set(existing.map((a: any) => a.type));

    // Also link existing agents that have no definition
    for (const agent of existing) {
      if (!(agent as any).definition) {
        const matchingDef = definitions.find((d: any) => d.type === (agent as any).type);
        if (matchingDef) {
          await strapi.documents(AGENT_UID).update({
            documentId: agent.documentId,
            data: { definition: matchingDef.documentId },
          });
        }
      }
    }

    for (const def of definitions) {
      if (!existingTypes.has(def.type)) {
        await strapi.documents(AGENT_UID).create({
          data: { name: def.name, type: def.type, enabled: false, project: project.documentId, definition: def.documentId },
        });
        strapi.log.info(`Created default "${def.name}" agent for project "${project.name}"`);
      }
    }
  }
}
