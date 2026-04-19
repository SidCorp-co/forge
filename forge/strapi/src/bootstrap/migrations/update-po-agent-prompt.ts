/**
 * One-time migration: update PO agent prompt to create draft issues.
 * Checks if the prompt already mentions "draft" — if so, skips.
 */
export async function updatePoAgentPrompt(strapi: any) {
  const DEFINITION_UID = 'api::agent-definition.agent-definition' as any;

  const definitions = await strapi.documents(DEFINITION_UID).findMany({
    filters: { type: { $eq: 'po-review' } },
    limit: 1,
  });

  if (!definitions.length) return;

  const def = definitions[0];
  if (def.promptTemplate?.includes('"draft"')) return; // already updated

  // Import the latest prompt from seeds
  const { PO_REVIEW_PROMPT } = await import('../seeds/agent-definitions');

  await strapi.documents(DEFINITION_UID).update({
    documentId: def.documentId,
    data: { promptTemplate: PO_REVIEW_PROMPT },
  });

  strapi.log.info('[migration] Updated PO agent prompt to create draft issues');
}
