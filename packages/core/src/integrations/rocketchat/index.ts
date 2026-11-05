export { rocketchatIntegration } from './adapter.js';
export {
  type AttachmentFetch,
  type AttachmentFetchFailure,
  fetchAttachment,
  fetchAttachmentBytes,
} from './attachment-fetch.js';
export {
  activeRocketChatBinding,
  isRocketChatConnection,
  type ProjectThread,
  projectThreadsOf,
  rocketChatBindingOfProject,
} from './binding.js';
export {
  type ActiveConnection,
  type ConnectionListening,
  connectionListening,
  rocketChatManager,
  startRocketChatManager,
  stopRocketChatManager,
} from './connection-manager.js';
export type { RocketChatDdpClient, RocketChatIncomingMessage } from './ddp-client.js';
export { directRoomFor } from './direct-room.js';
export { decideSkip } from './inbound-gate.js';
export { type LiveConnection, liveConnectionFor } from './live-connections.js';
export { fetchRoomMessagesSince } from './missed-messages.js';
export { namespaceFromServerUrl } from './namespace.js';
export {
  FIXED_REPLY_CONSTANT,
  type ReplySendProof,
  type ReplyTransport,
  sendFixedReply,
} from './outbound.js';
export { roomForProject } from './project-room.js';
export {
  type BotMembership,
  buildMessagePermalink,
  fetchBotMembership,
  fetchBotRooms,
  fetchMessage,
  fetchMessagesBeside,
  fetchRoomHistory,
  fetchThreadMessages,
  fetchUserProfile,
  type GroupKick,
  kickFromGroup,
  ROCKETCHAT_IMAGE_CAPS,
  type RocketChatButtonAttachment,
  type RocketChatImageRef,
  type RocketChatRestAuth,
  type RocketChatRestMessage,
  reactToMessage,
} from './rest-client.js';
export { resolveRoomPostAuth, roomStillBoundTo } from './room-auth.js';
export {
  type AgentProjectsGate,
  type AgentSwitchGate,
  provideAgentProjectsGate,
  provideAgentSwitchGate,
  provideRoomHandlers,
  provideSupportRoomHandler,
} from './room-handlers.js';
export { buildRoutes, type Route } from './room-routing.js';
export { type RoomShape, resolveRoomShape } from './room-shape.js';
export {
  dailyThread,
  keepDailyThread,
  questionThread,
  registerThread,
  releaseQuestionThread,
  utcDayOf,
} from './thread-registry.js';
export type { RocketChatBindingConfig, RocketChatConfig, RocketChatSecrets } from './types.js';
