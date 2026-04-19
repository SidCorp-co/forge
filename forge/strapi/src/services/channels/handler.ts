import type { NormalizedMessage } from './message';
import { resolveAppConfig, filterToolsForApp } from '../app-config';
import { getForgeTools } from '../agent/tools';
import { buildChatPrompt } from '../../api/chat/services/chat-prompt-builder';
import { createProvider } from '../agent/provider';
import { runAgent } from '../agent/runner';
import { extractMemories, extractToolPatterns } from '../agent/memory';
import { resolveLiteLLM } from '../litellm';

export async function handleChannelMessage(
  strapi: any,
  msg: NormalizedMessage,
  appId: string,
  sendReply: (text: string) => Promise<void>,
): Promise<void> {
  const config = await resolveAppConfig(strapi, appId);
  if (!config) {
    await sendReply('App not configured.');
    return;
  }

  const project = config.project;
  if (!project?.documentId) {
    await sendReply('No project linked to this app.');
    return;
  }

  const userKey = `channel:${msg.channel}:${msg.from}`;
  // Extract base channel type for source enum (e.g. 'rocketchat:forge' → 'rocketchat')
  const source = msg.channel.split(':')[0] as 'rocketchat' | 'telegram' | 'web' | 'widget';

  // Load or create session
  const sessionDocs = strapi.documents('api::chat-session.chat-session');
  const sessions = await sessionDocs.findMany({
    filters: {
      project: { documentId: { $eq: project.documentId } },
      userKey: { $eq: userKey },
    },
    sort: { updatedAt: 'desc' },
    limit: 1,
  });

  let session: any;
  if (sessions.length > 0) {
    session = sessions[0];
  } else {
    session = await sessionDocs.create({
      data: {
        userKey,
        source,
        messages: [],
        metadata: {},
        project: { documentId: project.documentId },
      },
    });
  }

  // Build prompt
  const litellm = resolveLiteLLM();
  if (!litellm) {
    await sendReply('LiteLLM not configured. Set LITELLM_API_URL and LITELLM_API_KEY.');
    return;
  }

  const model = process.env.LITELLM_CHAT_MODEL || litellm.model;
  const { allMessages, systemPrompt } = await buildChatPrompt(
    strapi, project, session, msg.text, model, userKey,
  );

  // Get tools filtered by app role (includes HRM tools if config has hrmBaseUrl)
  const tools = filterToolsForApp(getForgeTools(config), config, undefined);
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));

  const provider = await createProvider(litellm.apiKey, litellm.apiUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  const toolContext = {
    strapi,
    projectDocumentId: project.documentId,
    signal: controller.signal,
    userKey,
    hrmBaseUrl: config.hrmBaseUrl || undefined,
    strapiJwt: undefined as string | undefined, // TODO: per-user JWT from pairing
    auditEnabled: config.auditEnabled || false,
    appId,
  };

  try {
    const result = await runAgent({
      provider,
      model,
      messages: allMessages,
      tools,
      toolDefinitions: toolDefs,
      systemPrompt,
      toolContext,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Persist session
    const updatedMessages = result.messages;
    await sessionDocs.update({
      documentId: session.documentId,
      data: {
        messages: updatedMessages,
        metadata: {
          ...session.metadata,
          totalToolCalls: (session.metadata?.totalToolCalls || 0) + result.toolCalls.length,
        },
      },
    });

    // Send reply
    if (result.text) {
      await sendReply(result.text);
    }

    // Extract memories (fire-and-forget)
    extractMemories(provider, model, updatedMessages, strapi, project.documentId, userKey)
      .catch(err => strapi.log.warn(`[channel] memory extraction: ${err}`));

    extractToolPatterns(result.toolCalls, strapi, project.documentId)
      .catch(err => strapi.log.warn(`[channel] tool pattern extraction: ${err}`));
  } catch (err: any) {
    clearTimeout(timeout);
    strapi.log.error(`[channel] handler error: ${err.message}`);
    await sendReply('Sorry, something went wrong. Please try again.');
  }
}
