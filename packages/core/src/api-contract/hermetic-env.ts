const HERMETIC_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://contract:contract@127.0.0.1:1/contract',
  JWT_SECRET: 'api-contract-generator-placeholder-secret',
  DEVICE_TOKEN_PEPPER: 'api-contract-generator-placeholder-pepper',
};
const KEPT_ENV = new Set(['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS']);

// cm:why a reader of the route table reads the default build's: a feature flag or a variable in
// the caller's shell would mount a different route set, so the environment is replaced rather
// than inherited.
export function enterHermeticEnv(): void {
  for (const key of Object.keys(process.env)) if (!KEPT_ENV.has(key)) delete process.env[key];
  Object.assign(process.env, HERMETIC_ENV);
}
