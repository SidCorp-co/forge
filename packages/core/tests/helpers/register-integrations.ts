export async function registerIntegrationsForTest(): Promise<void> {
  const { registerAllIntegrations } = await import('../../src/integrations/register-all.js');
  registerAllIntegrations();
}
