export { bootstrapChatProviders } from './bootstrap.js';
export {
  type CompletionAnswer,
  type CompletionMiss,
  chatModelName,
  completeOnce,
  openChat,
} from './chat.js';
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
export type {
  ChatContentPart,
  ChatMessage,
  ChatProvider,
  ChatStreamEvent,
  ChatStreamUsage,
  ChatTool,
} from './types.js';
