import type { ForgeToolContext } from './agent/tools';

interface LogToolCallOpts {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: string;
  isError: boolean;
  durationMs: number;
  toolContext: ForgeToolContext;
}

/**
 * Fire-and-forget audit log for tool calls.
 * Only logs when toolContext.auditEnabled is true.
 */
export function logToolCall(strapi: any, opts: LogToolCallOpts): void {
  if (!opts.toolContext.auditEnabled) return;

  setImmediate(() => {
    strapi.documents('api::audit-log.audit-log').create({
      data: {
        appId: opts.toolContext.appId || null,
        userKey: opts.toolContext.userKey || null,
        toolName: opts.toolName,
        toolInput: opts.toolInput,
        toolResult: (opts.toolResult || '').slice(0, 2048),
        isError: opts.isError,
        durationMs: opts.durationMs,
        projectDocumentId: opts.toolContext.projectDocumentId,
        recordedAt: new Date().toISOString(),
      },
    }).catch((err: any) => {
      strapi.log.warn(`[audit] log failed: ${err.message}`);
    });
  });
}
