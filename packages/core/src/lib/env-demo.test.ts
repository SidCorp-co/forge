import { describe, expect, it } from 'vitest';
import { deployedEnvIssues, type Env } from './env.js';

const env = (over: Partial<Env>) =>
  ({ NODE_ENV: 'production', PAT_PEPPER: 'a'.repeat(40), ...over }) as Env;

describe('FORGE_DEMO_MODE: the credential-free door only opens on a core that is not deployed', () => {
  it('refuses a production or staging boot with demo mode on, by name', () => {
    for (const NODE_ENV of ['production', 'staging'] as const) {
      const issues = deployedEnvIssues(env({ NODE_ENV, FORGE_DEMO_MODE: true }));
      expect(issues.join('\n')).toContain(`FORGE_DEMO_MODE: is 1 while NODE_ENV=${NODE_ENV}`);
    }
  });

  it('takes demo mode in development and test, and a deployed core without it', () => {
    expect(deployedEnvIssues(env({ NODE_ENV: 'development', FORGE_DEMO_MODE: true }))).toEqual([]);
    expect(deployedEnvIssues(env({ NODE_ENV: 'test', FORGE_DEMO_MODE: true }))).toEqual([]);
    expect(deployedEnvIssues(env({ FORGE_DEMO_MODE: false }))).toEqual([]);
  });
});
