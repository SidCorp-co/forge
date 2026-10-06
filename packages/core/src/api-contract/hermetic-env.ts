const HERMETIC_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://contract:contract@127.0.0.1:1/contract',
  JWT_SECRET: 'api-contract-generator-placeholder-secret',
  DEVICE_TOKEN_PEPPER: 'api-contract-generator-placeholder-pepper',
};
const KEPT_ENV = new Set(['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS']);

// a caller's shell could mount a different route set, so the default build's env replaces it
export function enterHermeticEnv(): void {
  for (const key of Object.keys(process.env)) if (!KEPT_ENV.has(key)) delete process.env[key];
  Object.assign(process.env, HERMETIC_ENV);
}
