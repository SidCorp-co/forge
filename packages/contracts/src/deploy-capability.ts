export const DEPLOY_CAPABLE_PROVIDERS = ['coolify', 'epodsystem', 'agent', 'autoflow'] as const;

export function providerCanDeploy(provider: string): boolean {
  return (DEPLOY_CAPABLE_PROVIDERS as readonly string[]).includes(provider);
}
