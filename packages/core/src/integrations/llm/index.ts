export { bootstrapChatProviders, defaultChatProviderId } from './bootstrap.js';
export {
  EMBEDDING_UNAVAILABLE,
  EmbeddingUnavailableError,
  embed,
  embedBatch,
  embeddingsConfigured,
  embedQuery,
  embedWithModel,
} from './embeddings.js';
export {
  callFastModel,
  callFastModelObject,
  type FastModelMiss,
  fastModelConfigured,
  fastModelName,
} from './fast-model.js';
export { type ChatTurnKind, resolveForProject } from './registry.js';
export type {
  ChatContentPart,
  ChatMessage,
  ChatProvider,
  ChatResponseFormat,
  ChatStreamEvent,
  ChatStreamUsage,
  ChatTool,
} from './types.js';
