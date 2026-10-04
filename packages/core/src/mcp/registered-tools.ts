/**
 * The MCP tool surface this server is DECLARED to register.
 *
 * `integrations/github/agent-declaration.test.ts` reads it to refuse an integration that offers an
 * agent a tool the server does not serve: such a declaration advertises, in every prompt, a call
 * that answers `not_found`, which an agent reads as a credential fault and retries.
 */

export const REGISTERED_TOOLS = [
  'forge_agent_report',
  'forge_channel',
  'forge_coolify_deploy',
  'forge_ecosystem',
  'forge_google_sheets',
  'forge_sentry',
  'forge_source',
  'forge_storefront_target',
  'forge_uploads',
];
