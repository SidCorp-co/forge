import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import type { DeviceVars } from '../middleware/require-device.js';
import { createMcpServer } from './server.js';

export async function mcpHandler(c: Context<{ Variables: DeviceVars }>): Promise<Response> {
  const device = c.get('device');
  const server = createMcpServer(device);
  // Stateless mode: omit sessionIdGenerator so no session tracking occurs.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  server.onerror = (err) => {
    console.error('[@forge/core mcp] server error:', err);
  };
  transport.onerror = (err) => {
    console.error('[@forge/core mcp] transport error:', err);
  };

  await server.connect(transport);

  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    void transport.close();
    void server.close();
  }
}
