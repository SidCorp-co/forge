/**
 * ISS-604 (P2b) — Rocket.Chat integration types.
 *
 * Archetype: "connection-only" — core neither dispatches webhooks nor injects
 * MCP. The connection stores the bot credential + server URL; a long-lived DDP
 * bot-user connection (P2c) consumes it out-of-band. A binding maps one RC room
 * (`config.rid`) to the Forge project (`binding.project_id`).
 */

export interface RocketChatConfig extends Record<string, unknown> {
  /** Rocket.Chat server base URL, e.g. https://chat.sidcorp.co */
  serverUrl: string;
}

export interface RocketChatSecrets extends Record<string, unknown> {
  /** Bot personal-access token (X-Auth-Token / DDP resume token). */
  authToken: string;
  /** Bot user id (X-User-Id). */
  userId: string;
}

/** Per-binding config: which RC room this project listens/replies on. */
export interface RocketChatBindingConfig extends Record<string, unknown> {
  /** Rocket.Chat room id (`rid`). */
  rid: string;
}
