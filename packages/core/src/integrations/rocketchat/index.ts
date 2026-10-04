export { activeRocketChatBinding, rocketChatBindingOfProject } from './binding.js';
export { registerCommentMirror } from './comment-mirror.js';
export {
  rocketChatManager,
  startRocketChatManager,
  stopRocketChatManager,
} from './connection-manager.js';
export { fetchBotRooms, fetchUserProfile } from './rest-client.js';
export type { RocketChatConfig, RocketChatSecrets } from './types.js';
