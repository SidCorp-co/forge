import type { SupportRoomConfig } from '@forge/contracts/support';
import type { ChatRole, OperationsRoomConfig } from '@forge/contracts/support-operations';

export interface RocketChatConfig extends Record<string, unknown> {
  serverUrl: string;
  /** The bot account's role, where it answers operations rooms (REQ-75 BC-22). */
  role?: ChatRole;
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
  /** Present, each room is an operations room answered under the connection's role (REQ-75 BC-20). */
  operations?: OperationsRoomConfig;
  /** Groups an agent outside Forge answers: Forge keeps each one's channel record only (REQ-75 r6). */
  outsideRids?: string[];
}
