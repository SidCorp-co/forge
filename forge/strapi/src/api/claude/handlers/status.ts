import type { Context } from 'koa';
import * as antigravity from '../../../services/antigravity';
import { parseAntigravityResponse } from '../../../services/antigravity';
import { sendToSession } from '../../../services/websocket';

const UID = 'api::agent-session.agent-session' as any;

export async function status(ctx: Context) {
  const strapi = globalThis.strapi;
  const { id } = ctx.params;

  if (!id) {
    ctx.status = 400;
    return { error: 'Session ID is required' };
  }

  const session: any = await strapi.documents(UID).findOne({ documentId: id });
  if (!session) {
    ctx.status = 404;
    return { error: 'Session not found' };
  }

  // Antigravity sessions: poll Antigravity for latest status if still running
  if (session.metadata?.runner === 'antigravity' && session.status === 'running') {
    const requestId = session.metadata?.antigravityRequestId;
    if (requestId) {
      try {
        const agStatus = await antigravity.chatStatus(requestId);

        if (agStatus.status === 'Completed') {
          const response = parseAntigravityResponse(agStatus.result?.response || '');
          const userMsg = session.messages?.[0];
          const messages = [
            ...(userMsg ? [userMsg] : []),
            { role: 'assistant', content: response, timestamp: Date.now() },
          ];

          // Broadcast via WebSocket so the web UI sees the response
          sendToSession(id, 'agent:message', {
            sessionId: id,
            type: 'text',
            content: response,
          });

          await strapi.documents(UID).update({
            documentId: id,
            data: { status: 'completed', messages } as any,
          });

          sendToSession(id, 'agent:complete', { sessionId: id });

          return {
            data: {
              sessionId: session.documentId,
              status: 'completed',
              runner: 'antigravity',
              messages: messages.map((m: any) => ({
                role: m.role,
                content: m.content,
                timestamp: m.timestamp,
              })),
            },
          };
        }

        if (agStatus.status === 'Failed') {
          sendToSession(id, 'agent:message', {
            sessionId: id,
            type: 'error',
            content: agStatus.error || 'Antigravity execution failed',
          });

          await strapi.documents(UID).update({
            documentId: id,
            data: { status: 'failed' } as any,
          });

          sendToSession(id, 'agent:complete', { sessionId: id });

          return {
            data: {
              sessionId: session.documentId,
              status: 'failed',
              runner: 'antigravity',
              error: agStatus.error || 'Antigravity execution failed',
              messages: (session.messages || []).map((m: any) => ({
                role: m.role,
                content: m.content,
                timestamp: m.timestamp,
              })),
            },
          };
        }

        // Still running — return current Antigravity status
        return {
          data: {
            sessionId: session.documentId,
            status: 'running',
            runner: 'antigravity',
            antigravityStatus: agStatus.status,
            messages: (session.messages || []).map((m: any) => ({
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
            })),
          },
        };
      } catch {
        // Antigravity unreachable — return session as-is
      }
    }
  }

  return {
    data: {
      sessionId: session.documentId,
      status: session.status,
      runner: session.metadata?.runner || 'desktop',
      claudeSessionId: session.claudeSessionId || null,
      messages: (session.messages || []).map((m: any) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
    },
  };
}
