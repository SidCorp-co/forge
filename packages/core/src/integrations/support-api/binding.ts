import {
  type SupportApiConnectionConfig,
  type SupportTool,
  supportApiBindingConfigSchema,
  supportApiConnectionConfigSchema,
  supportApiSecretsSchema,
} from '@forge/contracts/support';
import { buildContextFromBinding, listActiveBindingsForProjectProvider } from '../index.js';

/** A project's granted support API, as the support door calls it. */
export interface SupportApi {
  bindingId: string;
  config: SupportApiConnectionConfig;
  tools: readonly SupportTool[];
  /** The credential: header name → value. Handed only to `callGranted`. */
  headers: Record<string, string>;
}

/**
 * The project's live support API, or null where it grants none. A stored row that no longer parses
 * is a fault in what was written, thrown with what is wrong, never served around.
 */
export async function activeSupportApi(projectId: string): Promise<SupportApi | null> {
  const [pair] = await listActiveBindingsForProjectProvider(projectId, 'support-api');
  if (!pair) return null;
  const ctx = buildContextFromBinding<Record<string, unknown>, Record<string, unknown>>(pair);
  const config = supportApiConnectionConfigSchema.safeParse({
    baseUrl: ctx.config.baseUrl,
    ...(ctx.config.hosts ? { hosts: ctx.config.hosts } : {}),
  });
  const tools = supportApiBindingConfigSchema.safeParse({ tools: ctx.config.tools });
  const secrets = supportApiSecretsSchema.safeParse(ctx.secrets);
  const faults = [
    ...(config.success ? [] : config.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)),
    ...(tools.success
      ? []
      : tools.error.issues.map((i) => `tools.${i.path.join('.')}: ${i.message}`)),
    ...(secrets.success ? [] : ['secrets.headers: missing or malformed']),
  ];
  if (!config.success || !tools.success || !secrets.success) {
    throw new Error(
      `support-api: binding ${pair.binding.id} holds a configuration the support door cannot call (${faults.join('; ')})`,
    );
  }
  return {
    bindingId: pair.binding.id,
    config: config.data,
    tools: tools.data.tools,
    headers: secrets.data.headers,
  };
}
