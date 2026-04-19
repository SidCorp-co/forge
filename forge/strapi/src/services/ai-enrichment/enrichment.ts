import type { Core } from '@strapi/strapi';
import { broadcast } from '../websocket';
import { createProvider, runAgent, getToolDefinitions, forgeTools } from '../agent';
import { resolveLiteLLM } from '../litellm';

export async function enrichIssue(strapi: Core.Strapi, issueDocumentId: string) {
  const issue = await strapi.documents('api::issue.issue').findOne({
    documentId: issueDocumentId,
    populate: ['project'],
  });

  if (!issue || !issue.project) {
    strapi.log.warn(`Cannot enrich issue ${issueDocumentId}: no project`);
    return;
  }

  const project = issue.project as any;

  const litellm = resolveLiteLLM();
  if (!litellm) {
    strapi.log.warn(`Cannot enrich issue ${issueDocumentId}: no LiteLLM config (set LITELLM_API_URL and LITELLM_API_KEY)`);
    return;
  }

  const { apiUrl, apiKey, model } = litellm;

  // Build knowledge context for system prompt
  let knowledgeSnippet = '';
  if (project.knowledgeIndex) {
    const raw = typeof project.knowledgeIndex === 'string'
      ? project.knowledgeIndex
      : JSON.stringify(project.knowledgeIndex);
    knowledgeSnippet = raw.length > 2000 ? raw.slice(0, 2000) + '…' : raw;
  }

  const systemPrompt = [
    `You are an issue enrichment agent for project "${project.name || project.slug}".`,
    `Analyze the issue below and perform TWO actions using your tools:`,
    ``,
    `1. Use forge_issues "update" to set these fields on the issue:`,
    `   - aiSummary: concise summary of the issue`,
    `   - aiSuggestedSolution: suggested approach to resolve`,
    `   - aiAcceptanceCriteria: array of acceptance criteria strings`,
    `   - aiConfidence: number 0-1 indicating your confidence`,
    `   - category: one of bug, feature, improvement, question, documentation`,
    `   - priority: one of critical, high, medium, low, none`,
    ``,
    `2. Use forge_comments "create" to post a comment on the issue summarizing your analysis.`,
    `   Set author to "AI Assistant" and isAI to true.`,
    ``,
    `The issue documentId is "${issueDocumentId}".`,
    ``,
    `Do NOT ask questions. Analyze and act immediately.`,
    knowledgeSnippet ? `\n## Knowledge Base\n${knowledgeSnippet}` : '',
  ].filter(Boolean).join('\n');

  const userMessage = `Enrich issue ${issueDocumentId}: ${issue.title}\n\n${issue.description || '(no description)'}`;

  // Filter tools to only forge_issues and forge_comments
  const enrichmentTools = forgeTools.filter((t) => t.name === 'forge_issues' || t.name === 'forge_comments');
  const enrichmentToolDefs = getToolDefinitions().filter((t) => t.name === 'forge_issues' || t.name === 'forge_comments');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const provider = await createProvider(apiKey, apiUrl);

    const result = await runAgent({
      provider,
      model,
      messages: [{ role: 'user', content: userMessage }],
      tools: enrichmentTools,
      toolDefinitions: enrichmentToolDefs,
      systemPrompt,
      toolContext: {
        strapi,
        projectDocumentId: project.documentId,
        signal: controller.signal,
        userKey: 'system:enrichment',
      },
      signal: controller.signal,
      maxIterations: 3,
    });

    if (result.toolCalls.length === 0 || result.error) {
      const reason = result.error || 'agent returned no tool calls';
      strapi.log.warn(`Enrichment for issue ${issueDocumentId} ineffective: ${reason}`);
      broadcast('issue:enrichment_failed', { documentId: issueDocumentId, error: reason });
      return;
    }

    broadcast('issue:updated', { documentId: issueDocumentId });
    strapi.log.info(`Issue ${issueDocumentId} enriched via agent (${result.iterations} iterations, ${result.toolCalls.length} tool calls)`);
  } catch (error) {
    strapi.log.error(`AI enrichment failed for issue ${issueDocumentId}: ${error}`);
    broadcast('issue:enrichment_failed', { documentId: issueDocumentId, error: String(error) });
  } finally {
    clearTimeout(timeout);
  }
}
