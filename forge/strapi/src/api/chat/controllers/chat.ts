import { createProvider, runAgent, getToolDefinitions, getToolMap, extractMemories } from '../../../services/agent';
import type { StreamEvent } from '../../../services/agent';
import { sendToSession, waitForSubscriber, broadcast } from '../../../services/websocket';
import { estimateCost } from '../../../services/pricing';
import { resolveLiteLLM } from '../services/chat-provider-factory';
import { loadOrCreateSession, persistSession } from '../services/chat-session-manager';
import { buildChatPrompt } from '../services/chat-prompt-builder';
import { summarizeAndEmbed } from '../../../services/session-summary';
import { extractUserIdFromToken } from '../../../lib/token-utils';

export default {
  async send(ctx) {
    const strapi = globalThis.strapi;
    const { projectSlug, message, sessionId, hubToken, hubContext, pageContext, stream: streamParam } = ctx.request.body as {
      projectSlug?: string;
      message: string;
      sessionId?: string;
      hubToken?: string;
      hubContext?: Record<string, unknown>;
      pageContext?: Record<string, unknown>;
      stream?: boolean;
    };
    // stream=true (default for web/widget): return immediately, stream via WS
    // stream=false: await full result and return in HTTP response (API clients)
    const useStreaming = streamParam !== false;

    if (!message || typeof message !== 'string') {
      return ctx.badRequest('message (string) required');
    }

    strapi.log.info(`Chat request: projectSlug=${projectSlug} msg="${message.slice(0, 100)}" sessionId=${sessionId || 'new'}`);

    // Resolve project: API key auth (widget) OR projectSlug (web)
    let project: any;
    if (ctx.state.forgeProject) {
      project = ctx.state.forgeProject;
    } else if (projectSlug) {
      const projects = await strapi.documents('api::project.project').findMany({
        filters: { slug: { $eq: projectSlug } },
      });
      project = projects[0];
    }
    if (!project) return ctx.notFound('Project not found');

    // Provider setup
    const litellm = resolveLiteLLM();
    if (!litellm) {
      return ctx.badRequest('No LiteLLM configuration. Set LITELLM_API_URL and LITELLM_API_KEY env vars.');
    }
    const { apiUrl, apiKey, model } = litellm;

    // Determine source
    const source = ctx.state.forgeProject ? 'widget' : 'web';

    // Extract widget user ID from hubToken (JWT or Sanctum format)
    const widgetUserId = extractUserIdFromToken(hubToken);

    // Load or create session
    const session = await loadOrCreateSession(strapi, sessionId, message, project, ctx.state.user?.documentId, source, widgetUserId);

    // Derive userKey for memory
    const userKey = ctx.state.user?.id ? `user:${ctx.state.user.id}` : `session:${session.documentId}`;

    // Build prompt
    const { allMessages, systemPrompt, ragContext, queryIntent, condensedQuery } = await buildChatPrompt(strapi, project, session, message, model, userKey, hubContext, widgetUserId, pageContext);

    // Create provider
    const provider = await createProvider(apiKey, apiUrl);
    const { DEFAULT_AGENT_CONFIG } = await import('../../../services/agent/tools');
    const agentConfig = project.agentConfig || DEFAULT_AGENT_CONFIG;
    const toolDefs = getToolDefinitions(agentConfig);
    const toolMap = getToolMap(agentConfig);

    // Merge MCP tools if project has mcpServers configured
    const hasMcp = project.mcpServers && Object.keys(project.mcpServers).length > 0;
    if (hasMcp) {
      try {
        const { createMcpForgeTools } = await import('../../../services/agent/mcp-client');
        const mcpTools = await createMcpForgeTools(project.mcpServers, hubToken);
        for (const t of mcpTools) {
          toolDefs.push({ name: t.name, description: t.description, parameters: t.parameters });
          toolMap.set(t.name, t);
        }
      } catch (err) {
        strapi.log.warn(`MCP tools init failed: ${err}`);
      }

      // Fire-and-forget knowledge sync on first chat
      if (!project.mcpLastSyncAt) {
        import('../../../services/agent/mcp-sync').then(({ syncMcpKnowledge }) => {
          syncMcpKnowledge(strapi, project).catch(err => strapi.log.warn(`MCP sync error: ${err}`));
        }).catch(() => {});
      }
    }

    // Abort controller
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const chatStartMs = Date.now();
    const sessionDocId = session.documentId;

    // Broadcast session ID to all connected clients so frontend can subscribe before streaming
    broadcast('chat:session_ready', { sessionId: sessionDocId, requestId: ctx.request.body?.requestId });

    // Stream events via WebSocket
    const onEvent = (event: StreamEvent) => {
      if (event.type === 'text_delta') {
        sendToSession(sessionDocId, 'chat:text_delta', { text: event.text });
      } else if (event.type === 'tool_use_start') {
        sendToSession(sessionDocId, 'chat:tool_use', { id: event.id, name: event.name });
      } else if (event.type === 'tool_use_end' && event.name === 'TodoWrite') {
        sendToSession(sessionDocId, 'chat:todo_write', { id: event.id, input: event.input });
      } else if (event.type === 'message_end') {
        sendToSession(sessionDocId, 'chat:done', { usage: event.usage });
      }
    };

    // Shared post-processing after agent completes
    const postProcess = async (result: Awaited<ReturnType<typeof runAgent>>) => {
      const updatedMessages = result.messages;
      const metadata = {
        ...(session.metadata || {}),
        lastUsage: result.usage,
        lastIterations: result.iterations,
        totalToolCalls: (session.metadata?.totalToolCalls || 0) + result.toolCalls.length,
      };
      await persistSession(strapi, sessionDocId, updatedMessages, metadata);

      const durationMs = Date.now() - chatStartMs;
      const toolErrors = result.toolCalls.filter((tc) => tc.isError);
      const qualitySignals = {
        turnIndex: (session.messages?.length || 0),
        sessionTurnCount: updatedMessages.length,
        hadToolErrors: toolErrors.length > 0,
        toolErrorCount: toolErrors.length,
        ragHitCount: ragContext.length,
        ragWasEmpty: ragContext.length === 0 && !!queryIntent && !['CHAT', 'ACTION'].includes(queryIntent),
        responseLength: result.text?.length || 0,
        wasFollowUp: !!condensedQuery,
        latencyMs: durationMs,
        iterations: result.iterations || 1,
        iterationLogs: result.iterationLogs,
      };

      if (project.agentMemoryEnabled !== false) {
        extractMemories(provider, model, updatedMessages, strapi, project.documentId, userKey, qualitySignals, widgetUserId)
          .catch((err) => strapi.log.warn(`Memory extraction error: ${err}`));

        import('../../../services/agent/memory').then(({ extractToolPatterns }) => {
          extractToolPatterns(result.toolCalls, strapi, project.documentId)
            .catch((err) => strapi.log.warn(`Tool pattern extraction error: ${err}`));
        }).catch(() => {});
      }

      summarizeAndEmbed(strapi, sessionDocId, project.documentId, userKey)
        .catch((err) => strapi.log.warn(`Session summary error: ${err}`));

      strapi.documents('api::chat-log.chat-log').create({
        data: {
          sessionId: sessionDocId,
          projectSlug: projectSlug || project.slug,
          userKey,
          query: message,
          reply: result.text,
          model,
          ragContext: ragContext.length > 0 ? ragContext.map((r) => ({
            type: r.sourceType,
            id: r.sourceId,
            score: Math.round(r.score * 100) / 100,
            text: r.text.slice(0, 200),
          })) : null,
          toolCalls: result.toolCalls.map((tc) => ({
            name: tc.name,
            input: tc.input,
            result: tc.result.slice(0, 500),
            isError: tc.isError,
            durationMs: tc.durationMs,
          })),
          usage: result.usage,
          iterations: result.iterations,
          durationMs,
          queryIntent,
          condensedQuery,
          source,
          qualitySignals,
        } as any,
      }).catch((err) => strapi.log.warn(`Chat log write failed: ${err}`));

      if (result.usage) {
        const u = result.usage;
        strapi.documents('api::usage-record.usage-record').create({
          data: {
            source: 'api',
            model,
            inputTokens: u.inputTokens || 0,
            outputTokens: u.outputTokens || 0,
            cacheReadTokens: u.cacheReadTokens || 0,
            cacheCreationTokens: u.cacheWriteTokens || 0,
            estimatedCost: estimateCost(model, u.inputTokens || 0, u.outputTokens || 0),
            requestCount: result.iterations || 1,
            sessionId: sessionDocId,
            recordedAt: new Date().toISOString(),
            project: project.documentId,
          } as any,
        }).catch((err) => strapi.log.error(`Usage record error: ${err}`));
      }

      return result;
    };

    const agentParams = {
      provider,
      model,
      messages: allMessages,
      tools: [...toolMap.values()],
      toolDefinitions: toolDefs,
      systemPrompt,
      toolContext: {
        strapi,
        projectDocumentId: project.documentId,
        signal: controller.signal,
        userKey,
        agentConfig,
        hubToken,
        crossProjectAccess: !!project.crossProjectAccess,
      },
      signal: controller.signal,
      onEvent,
    };

    if (useStreaming) {
      // Streaming mode: return HTTP immediately, run agent in background, deliver via WS
      // Wait for WS subscriber before starting agent to avoid losing streamed events
      const startAgent = async () => {
        await waitForSubscriber(sessionDocId);
        return runAgent(agentParams);
      };
      const agentPromise = startAgent();

      agentPromise.then(async (result) => {
        try {
          await postProcess(result);
          const completePayload = {
            sessionId: sessionDocId,
            reply: result.text,
            usage: result.usage,
            iterations: result.iterations,
            toolCalls: result.toolCalls.map((tc) => ({
              name: tc.name, input: tc.input, durationMs: tc.durationMs, isError: tc.isError,
            })),
          };
          sendToSession(sessionDocId, 'chat:complete', completePayload);
        } catch (postErr) {
          strapi.log.error(`Chat post-processing error: ${postErr}`);
        } finally {
          clearTimeout(timeout);
        }
      }).catch((err) => {
        clearTimeout(timeout);
        strapi.log.error(`Agent error: ${err}`);
        sendToSession(sessionDocId, 'chat:error', { error: String(err) });
      });

      return {
        data: {
          sessionId: sessionDocId,
          streaming: true,
        },
      };
    }

    // Synchronous mode (stream=false): await full result and return in HTTP response
    try {
      const result = await runAgent(agentParams);
      await postProcess(result);

      return {
        data: {
          sessionId: sessionDocId,
          reply: result.text,
          usage: result.usage,
          iterations: result.iterations,
          toolCalls: result.toolCalls.map((tc) => ({
            name: tc.name,
            input: tc.input,
            durationMs: tc.durationMs,
            isError: tc.isError,
          })),
        },
      };
    } catch (err) {
      strapi.log.error(`Agent error: ${err}`);
      return ctx.internalServerError(`Agent error: ${err}`);
    } finally {
      clearTimeout(timeout);
    }
  },
};
