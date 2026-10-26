import type { SupportRoomConfig } from '@forge/contracts/support';

export interface RocketChatConfig extends Record<string, unknown> {
  serverUrl: string;
}

export interface RocketChatSecrets extends Record<string, unknown> {
  authToken: string;
  userId: string;
}

export interface RocketChatBindingConfig extends Record<string, unknown> {
  /** Rocket.Chat room ids (`rid`), one binding watching any number of rooms. */
  rids?: string[];
  /** Present, the one room is a support group answered by its session (REQ-75). */
  support?: SupportRoomConfig;
}
