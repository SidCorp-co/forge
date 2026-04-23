import pkg from '../../../package.json' with { type: 'json' };

const startedAt = Date.now();

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export const forgeVersionTool: McpTool = {
  name: 'forge_version',
  description: 'Returns @forge/core version and uptime in seconds.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => ({
    version: pkg.version,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }),
};
