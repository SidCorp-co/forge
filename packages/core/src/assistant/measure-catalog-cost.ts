/**
 * ISS-983 — the entry point for `pnpm --filter @forge/core measure:catalog-cost`.
 *
 * It exists apart from `tool-catalog-cost.ts` because sizing the live catalog means importing
 * `tools/registry.ts`, which reaches `db/client.ts` and therefore the validated `config/env.ts`.
 * A measurement of a constant that refuses to start without a production DATABASE_URL is not
 * re-runnable, and re-runnability is the whole deliverable.
 */

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

const { main } = await import('./tool-catalog-cost.js');
await main();

export {};
