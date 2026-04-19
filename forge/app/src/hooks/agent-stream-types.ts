export type { ChatMessageData, ToolCallData } from '@/components/chat/chat-message';

let uuidCounter = 0;
export function generateId(): string {
  uuidCounter += 1;
  return `${Date.now()}-${uuidCounter}-${Math.random().toString(36).slice(2, 9)}`;
}
