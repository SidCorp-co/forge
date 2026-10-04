const PLACEHOLDERS: Record<string, string> = {
  DATABASE_URL: 'postgres://measurement:measurement@127.0.0.1:5432/measurement',
  JWT_SECRET: 'measurement-only-secret-at-least-32-characters',
  DEVICE_TOKEN_PEPPER: 'measurement-only-pepper-at-least-32-characters',
};

const filled = Object.keys(PLACEHOLDERS).filter((key) => !process.env[key]);
for (const key of filled) process.env[key] = PLACEHOLDERS[key];
if (filled.length > 0) {
  console.log(
    `# ${filled.join(', ')} unset — filled with inert placeholders so the catalog can be built. Nothing below reads a database through them; the census reads FORGE_CENSUS_DATABASE_URL and nothing else.`,
  );
}

const { provideChatTools } = await import('../src/assistant/index.js');
const { CHAT_READ_MODEL_TOOLS } = await import('../src/mcp/index.js');
provideChatTools(CHAT_READ_MODEL_TOOLS);
const { main } = await import('../src/assistant/tool-catalog-cost.js');
await main();

export {};
